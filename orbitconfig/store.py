"""
Orbit 配置的读取 / 校验 / 写回 / 备份 / 预设 / 导入导出。

设计要点：
- 读取严格复刻 orbit/config.py:load_menu_tree() 的优先级与兜底逻辑，
  保证 Web 里看到的就是 orbit 真正会加载的那一份。
- 写回永远落到 CONFIG_PATHS[0]（dunder custom 文件），写前自动备份、写时原子替换。
- 校验只做「会让 orbit 行为异常」的判断；风格问题一律降级为 warning。
"""

import copy
import datetime
import json
import os
import re
import shutil
import sys
import tempfile

from . import defaults, paths, toml_io

try:
    import tomllib
except ImportError:  # pragma: no cover
    try:
        import tomli as tomllib
    except ImportError:
        tomllib = None

EXPORT_FORMAT = "orbit-config/v1"

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_HEX_RE = re.compile(r"^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9\u4e00-\u9fff._-]+")


class ConfigError(Exception):
    """配置无法写回（通常是校验失败）。"""

    def __init__(self, message, errors=None):
        super().__init__(message)
        self.errors = errors or []


# ── 清洗 ─────────────────────────────────────────────────────────────────────

def sanitize_item(item: dict) -> dict:
    """去掉 orbit 运行时注入的字段，保证只有用户可编辑的键。"""
    if not isinstance(item, dict):
        return {}
    clean = {}
    for key, value in item.items():
        if key == "children":
            continue
        if toml_io.is_runtime_key(key) or str(key).startswith("_"):
            continue
        if value is None:
            continue
        clean[key] = value
    children = item.get("children")
    if isinstance(children, list):
        # 保留空数组：这样「新建但还没加子项的文件夹」在编辑期间不会被
        # 误判成命令项。TOML 落地时不会写出空的 children。
        clean["children"] = [sanitize_item(child) for child in children if isinstance(child, dict)]
    return clean


def sanitize_items(items) -> list:
    if not isinstance(items, list):
        return []
    return [sanitize_item(item) for item in items if isinstance(item, dict)]


def sanitize_engines(engines) -> list:
    if not isinstance(engines, list):
        return []
    result = []
    for engine in engines:
        if not isinstance(engine, dict):
            continue
        result.append({
            str(key): value
            for key, value in engine.items()
            if value is not None and not str(key).startswith("_")
        })
    return result


def sanitize_search(meta) -> dict:
    if not isinstance(meta, dict):
        meta = {}
    clean = {
        key: value
        for key, value in meta.items()
        if value is not None and key != "engines" and not str(key).startswith("_")
    }
    clean.setdefault("default_engine", "bing")
    clean.setdefault("placeholder", "Search or ask...")
    return clean


# ── 读取 ─────────────────────────────────────────────────────────────────────

def _parse_toml(path: str) -> dict:
    if tomllib is None:
        raise ConfigError("当前 Python 缺少 tomllib，无法读取 TOML 配置")
    with open(path, "rb") as handle:
        return tomllib.load(handle)


def _parse_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, list):
        return {"items": data}
    if isinstance(data, dict):
        return data
    return {}


def find_source() -> tuple:
    """按 orbit 的优先级找到第一个可用配置。返回 (path, payload_dict, index) 。"""
    for index, candidate in enumerate(paths.CONFIG_PATHS):
        if not os.path.isfile(candidate):
            continue
        try:
            if candidate.endswith(".toml"):
                data = _parse_toml(candidate)
            else:
                data = _parse_json(candidate)
        except Exception as exc:
            print(f"[orbit-config] 解析 {candidate} 失败: {exc}", file=sys.stderr)
            continue
        return candidate, data, index
    return None, {}, -1


def read_config() -> dict:
    """读取当前生效的 orbit 配置 + 出厂默认。"""
    source_path, data, source_index = find_source()

    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list) or not items:
        items, _fallback_engines, _meta = defaults.factory_defaults()
        items_from_defaults = True
    else:
        items_from_defaults = False

    engines = data.get("search_engines") if isinstance(data, dict) else None
    if not isinstance(engines, list) or not engines:
        search_meta_raw = data.get("search") if isinstance(data, dict) else None
        if isinstance(search_meta_raw, dict) and isinstance(search_meta_raw.get("engines"), list):
            engines = search_meta_raw["engines"]
            search_meta_raw = {k: v for k, v in search_meta_raw.items() if k != "engines"}
        else:
            _items, engines, _meta = defaults.factory_defaults()
            engines_from_defaults = True
            search_meta_raw = search_meta_raw if isinstance(search_meta_raw, dict) else {}
    else:
        engines_from_defaults = False
        search_meta_raw = data.get("search") if isinstance(data, dict) else None
        if not isinstance(search_meta_raw, dict):
            search_meta_raw = {}

    search = sanitize_search(search_meta_raw)
    default_items, default_engines, default_search = defaults.factory_defaults()

    return {
        "items": sanitize_items(items),
        "search_engines": sanitize_engines(engines),
        "search": search,
        "source": {
            "path": source_path,
            "exists": source_path is not None,
            "priority_index": source_index,
            "items_from_defaults": items_from_defaults,
            "engines_from_defaults": engines_from_defaults,
        },
        "write_path": paths.WRITE_PATH,
        "factory_defaults": {
            "items": default_items,
            "search_engines": default_engines,
            "search": default_search,
        },
    }


# ── 校验 ─────────────────────────────────────────────────────────────────────

def _check_item(item: dict, path: str, sibling_ids: set, errors: list, warnings: list,
                palette_keys=None) -> None:
    if not isinstance(item, dict):
        errors.append(f"{path}: 不是一个对象")
        return

    item_id = item.get("id")
    if not isinstance(item_id, str) or not item_id.strip():
        errors.append(f"{path}.id: 不能为空（orbit 用它做唯一标识）")
    else:
        item_id = item_id.strip()
        if item_id in sibling_ids:
            errors.append(f"{path}.id: 同一层级内 id “{item_id}” 重复")
        sibling_ids.add(item_id)
        if not _ID_RE.match(item_id):
            warnings.append(f"{path}.id: 建议只用字母/数字/._- （当前 “{item_id}”）")

    name = item.get("name")
    if not isinstance(name, str) or not name.strip():
        errors.append(f"{path}.name: 不能为空")

    children = item.get("children")
    folder_declared = isinstance(children, list)
    has_children = folder_declared and len(children) > 0
    url = item.get("url")
    cmd = item.get("cmd")
    has_url = isinstance(url, str) and bool(url.strip())
    has_cmd = isinstance(cmd, str) and bool(cmd.strip())

    if not has_children and not has_url and not has_cmd:
        if folder_declared:
            warnings.append(f"{path}: 文件夹里还没有子项，orbit 会忽略它")
        else:
            errors.append(f"{path}: 必须填网址（url）、命令（cmd）或子菜单（children）三者之一")

    if has_children and (has_url or has_cmd):
        warnings.append(f"{path}: 同时设置了子菜单和 url/cmd，orbit 会优先展开子菜单")

    if has_url:
        stripped = url.strip()
        if not stripped.startswith(("http://", "https://", "www.")):
            warnings.append(f"{path}.url: 建议以 http:// 或 https:// 开头（当前 “{stripped}”）")

    shortcut = item.get("shortcut")
    if shortcut is not None and shortcut != "":
        if not isinstance(shortcut, str):
            warnings.append(f"{path}.shortcut: 建议写成字符串")

    color_key = item.get("color_key")
    if isinstance(color_key, str) and color_key.startswith("#"):
        if not _HEX_RE.match(color_key):
            warnings.append(f"{path}.color_key: “{color_key}” 不是合法的 #RRGGBB")
    elif isinstance(color_key, str) and color_key and palette_keys and color_key not in palette_keys:
        warnings.append(f"{path}.color_key: 调色板里没有 “{color_key}”，orbit 会回退到默认色")

    if not item.get("icon"):
        warnings.append(f"{path}.icon: 未设置图标，orbit 会显示默认图标")

    if has_children:
        child_ids = set()
        for offset, child in enumerate(children):
            _check_item(child, f"{path}.children[{offset}]", child_ids, errors, warnings, palette_keys)


def validate(payload: dict, palette_keys=None) -> dict:
    """校验 payload，返回 {errors, warnings, stats}。"""
    errors = []
    warnings = []

    items = payload.get("items")
    if not isinstance(items, list):
        errors.append("items: 必须是数组")
        items = []
    elif not items:
        warnings.append("items: 为空，orbit 会回退到内置默认菜单")

    top_ids = set()
    for index, item in enumerate(items):
        _check_item(item, f"items[{index}]", top_ids, errors, warnings, palette_keys)

    engines = payload.get("search_engines")
    if engines is None:
        engines = []
    if not isinstance(engines, list):
        errors.append("search_engines: 必须是数组")
        engines = []

    engine_ids = set()
    for index, engine in enumerate(engines):
        path = f"search_engines[{index}]"
        if not isinstance(engine, dict):
            errors.append(f"{path}: 不是一个对象")
            continue
        engine_id = engine.get("id")
        if not isinstance(engine_id, str) or not engine_id.strip():
            errors.append(f"{path}.id: 不能为空")
        else:
            engine_id = engine_id.strip()
            if engine_id in engine_ids:
                errors.append(f"{path}.id: 搜索引擎 id “{engine_id}” 重复")
            engine_ids.add(engine_id)
        if not isinstance(engine.get("name"), str) or not str(engine.get("name")).strip():
            errors.append(f"{path}.name: 不能为空")
        url = engine.get("url")
        if not isinstance(url, str) or not url.strip():
            errors.append(f"{path}.url: 不能为空")
        elif "{query}" not in url:
            warnings.append(f"{path}.url: 缺少 {{query}} 占位符，搜索关键词不会被代入")

    search = payload.get("search") or {}
    default_engine = search.get("default_engine")
    if default_engine and engine_ids and default_engine not in engine_ids:
        warnings.append(f"search.default_engine: “{default_engine}” 不在搜索引擎列表中，orbit 会回退到第 1 个")

    def count(node_list):
        total = 0
        for node in node_list:
            total += 1
            if isinstance(node, dict) and isinstance(node.get("children"), list):
                total += count(node["children"])
        return total

    return {
        "errors": errors,
        "warnings": warnings,
        "stats": {
            "top_level_items": len(items),
            "total_items": count(items),
            "engines": len(engines),
        },
    }


def normalize_payload(payload: dict) -> dict:
    """统一成 {items, search, search_engines}。"""
    if not isinstance(payload, dict):
        payload = {}
    return {
        "items": sanitize_items(payload.get("items") or []),
        "search": sanitize_search(payload.get("search")),
        "search_engines": sanitize_engines(payload.get("search_engines") or []),
    }


# ── 备份 ─────────────────────────────────────────────────────────────────────

def _timestamp() -> str:
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


def create_backup(reason: str = "manual", source_path: str = None) -> dict:
    """把当前配置文件复制到备份目录。返回备份信息，源文件不存在则返回 None。"""
    paths.ensure_state_dirs()
    target = source_path or paths.WRITE_PATH
    if not os.path.isfile(target):
        return None

    safe_reason = _SAFE_NAME_RE.sub("", str(reason))[:32] or "manual"
    base = os.path.basename(target)
    stem, ext = os.path.splitext(base)
    name = f"{stem}.{_timestamp()}.{safe_reason}{ext}"
    destination = os.path.join(paths.BACKUP_DIR, name)
    counter = 1
    while os.path.exists(destination):
        name = f"{stem}.{_timestamp()}.{safe_reason}-{counter}{ext}"
        destination = os.path.join(paths.BACKUP_DIR, name)
        counter += 1

    shutil.copy2(target, destination)
    prune_backups()
    return _backup_info(destination)


def _backup_info(path: str) -> dict:
    stat = os.stat(path)
    return {
        "name": os.path.basename(path),
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "time": datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
    }


def list_backups() -> list:
    paths.ensure_state_dirs()
    entries = []
    try:
        for name in os.listdir(paths.BACKUP_DIR):
            full = os.path.join(paths.BACKUP_DIR, name)
            if os.path.isfile(full) and not name.startswith("."):
                entries.append(_backup_info(full))
    except OSError:
        return []
    entries.sort(key=lambda item: item["mtime"], reverse=True)
    return entries


def prune_backups(limit: int = None) -> None:
    limit = limit or paths.MAX_BACKUPS
    entries = list_backups()
    for entry in entries[limit:]:
        try:
            os.remove(os.path.join(paths.BACKUP_DIR, entry["name"]))
        except OSError:
            pass


def _safe_join_name(name: str) -> str:
    base = os.path.basename(str(name)).strip()
    if not base or base in (".", ".."):
        raise ConfigError("非法的文件名")
    return base


def restore_backup(name: str) -> dict:
    source = os.path.join(paths.BACKUP_DIR, _safe_join_name(name))
    if not os.path.isfile(source):
        raise ConfigError("备份不存在")

    # 先确认备份本身能解析，避免把坏文件盖到线上配置
    if source.endswith(".toml"):
        _parse_toml(source)
    else:
        _parse_json(source)

    create_backup("before-restore")
    os.makedirs(os.path.dirname(paths.WRITE_PATH), exist_ok=True)
    shutil.copy2(source, paths.WRITE_PATH)
    return read_config()


def delete_backup(name: str) -> None:
    target = os.path.join(paths.BACKUP_DIR, _safe_join_name(name))
    if os.path.isfile(target):
        os.remove(target)


# ── 预设 ─────────────────────────────────────────────────────────────────────

BUILTIN_PRESET_ID = "__factory__"


def _preset_path(name: str) -> str:
    safe = _SAFE_NAME_RE.sub("_", str(name)).strip("._") or "preset"
    return os.path.join(paths.PRESET_DIR, f"{safe}.json")


def _preset_summary(path: str) -> dict:
    stat = os.stat(path)
    summary = {
        "id": os.path.splitext(os.path.basename(path))[0],
        "name": os.path.splitext(os.path.basename(path))[0],
        "file": os.path.basename(path),
        "builtin": False,
        "mtime": stat.st_mtime,
        "time": datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "top_level_items": 0,
        "total_items": 0,
        "engines": 0,
    }
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        summary["name"] = data.get("name") or summary["name"]
        payload = normalize_payload(data.get("config") or data)
        summary["top_level_items"] = len(payload["items"])
        summary["engines"] = len(payload["search_engines"])

        def count(nodes):
            total = 0
            for node in nodes:
                total += 1
                if isinstance(node.get("children"), list):
                    total += count(node["children"])
            return total

        summary["total_items"] = count(payload["items"])
    except Exception as exc:
        summary["error"] = str(exc)
    return summary


def list_presets() -> list:
    paths.ensure_state_dirs()
    presets = []
    for name in sorted(os.listdir(paths.PRESET_DIR)):
        full = os.path.join(paths.PRESET_DIR, name)
        if os.path.isfile(full) and name.endswith(".json") and not name.startswith("."):
            presets.append(_preset_summary(full))
    presets.sort(key=lambda item: item["mtime"], reverse=True)
    return presets


def save_preset(name: str, payload: dict, overwrite: bool = True) -> dict:
    paths.ensure_state_dirs()
    name = str(name or "").strip()
    if not name:
        raise ConfigError("预设名称不能为空")

    target = _preset_path(name)
    if os.path.exists(target) and not overwrite:
        raise ConfigError(f"预设 “{name}” 已存在")

    config = normalize_payload(payload)
    if not config["items"] and not config["search_engines"]:
        raise ConfigError("当前配置为空，拒绝覆盖预设（防止误清空）")

    document = {
        "format": "orbit-config-preset/v1",
        "name": name,
        "saved_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "config": config,
    }
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, indent=2)
    return _preset_summary(target)


def load_preset(preset_id: str) -> dict:
    """返回 {name, config}。preset_id 为 __factory__ 时返回出厂默认。"""
    if preset_id == BUILTIN_PRESET_ID:
        items, engines, search = defaults.factory_defaults()
        return {
            "id": BUILTIN_PRESET_ID,
            "name": "出厂默认（orbit 内置）",
            "builtin": True,
            "config": {"items": items, "search_engines": engines, "search": search},
        }

    target = os.path.join(paths.PRESET_DIR, _safe_join_name(f"{preset_id}.json"))
    if not os.path.isfile(target):
        raise ConfigError("预设不存在")
    with open(target, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    return {
        "id": preset_id,
        "name": data.get("name") or preset_id,
        "builtin": False,
        "config": normalize_payload(data.get("config") or data),
    }


def delete_preset(preset_id: str) -> None:
    if preset_id == BUILTIN_PRESET_ID:
        raise ConfigError("内置预设不能删除")
    target = os.path.join(paths.PRESET_DIR, _safe_join_name(f"{preset_id}.json"))
    if os.path.isfile(target):
        os.remove(target)


def rename_preset(preset_id: str, new_name: str) -> dict:
    if preset_id == BUILTIN_PRESET_ID:
        raise ConfigError("内置预设不能重命名")
    data = load_preset(preset_id)
    delete_preset(preset_id)
    return save_preset(new_name, data["config"])


# ── 导入 / 导出 ──────────────────────────────────────────────────────────────

def export_payload() -> dict:
    current = read_config()
    return {
        "format": EXPORT_FORMAT,
        "exported_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "source_path": current["source"]["path"],
        "items": current["items"],
        "search": current["search"],
        "search_engines": current["search_engines"],
    }


def parse_import(text: str) -> dict:
    """把用户粘贴/上传的内容解析成 payload。支持本工具 JSON 导出、orbit JSON、TOML。"""
    text = (text or "").strip()
    if not text:
        raise ConfigError("导入内容为空")

    data = None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        data = None

    if data is None:
        if tomllib is None:
            raise ConfigError("内容既不是 JSON，且当前 Python 无法解析 TOML")
        try:
            data = tomllib.loads(text)
        except Exception as exc:
            raise ConfigError(f"无法解析导入内容（既不是 JSON 也不是 TOML）: {exc}")

    if isinstance(data, list):
        data = {"items": data}
    if not isinstance(data, dict):
        raise ConfigError("导入内容的结构不被识别")

    payload = normalize_payload(data)
    if not payload["items"] and not payload["search_engines"]:
        raise ConfigError("导入内容里没有可用的 items 或 search_engines")

    if not payload["search_engines"]:
        _items, engines, _search = defaults.factory_defaults()
        payload["search_engines"] = engines
    if "search" not in data or not data.get("search"):
        _items, _engines, search = defaults.factory_defaults()
        payload["search"] = sanitize_search(search)

    return payload


# ── 写回 ─────────────────────────────────────────────────────────────────────

def render_document(payload: dict) -> str:
    payload = normalize_payload(payload)
    return toml_io.dump_document(
        payload["items"], payload["search"], payload["search_engines"]
    )


def write_config(payload: dict, reason: str = "web-edit", palette_keys=None) -> dict:
    """校验并原子写回配置。返回 {config, validation, backup}。"""
    payload = normalize_payload(payload)
    validation = validate(payload, palette_keys=palette_keys)
    if validation["errors"]:
        raise ConfigError("配置校验未通过，未写入任何文件", validation["errors"])

    document = toml_io.dump_document(
        payload["items"], payload["search"], payload["search_engines"]
    )

    target_dir = os.path.dirname(paths.WRITE_PATH)
    os.makedirs(target_dir, exist_ok=True)

    backup = None
    if os.path.isfile(paths.WRITE_PATH):
        backup = create_backup(reason)

    tmp_fd, tmp_path = tempfile.mkstemp(prefix=".orbit-items-", suffix=".toml", dir=target_dir)
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as handle:
            handle.write(document)
        os.chmod(tmp_path, 0o644)
        os.replace(tmp_path, paths.WRITE_PATH)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise

    # 写回后立刻读回来验证，确保 orbit 一定能解析
    try:
        _parse_toml(paths.WRITE_PATH)
    except Exception as exc:
        if backup:
            shutil.copy2(os.path.join(paths.BACKUP_DIR, backup["name"]), paths.WRITE_PATH)
        raise ConfigError(f"写回的文件无法被解析，已回滚: {exc}")

    current = read_config()
    return {"config": current, "validation": validation, "backup": backup}
