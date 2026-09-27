"""
TOML 序列化。

系统自带的 tomllib 只能读不能写，而且 orbit 的配置结构非常简单
（`[search]` + `[[search_engines]]` + `[[items]]` + 递归的 `[[items.children]]`），
所以这里手写一个确定性的序列化器：输出格式稳定、可 diff、字段顺序固定。
"""

import re

# orbit 运行时往 item dict 里注入的字段，写回时必须剔除，
# 否则会把 Pango layout 对象、归一化颜色等写进用户配置。
RUNTIME_KEYS = {
    "color",
    "center_angle",
    "idle_w",
    "active_w",
    "title_w",
    "title_h",
    "desc_w",
    "desc_h",
    "icon_w",
    "icon_h",
    "badge_w",
    "badge_h",
    "icon_ink_rect",
}

_ITEM_KEY_ORDER = ["id", "name", "desc", "icon", "url", "cmd", "shortcut", "color_key"]
_ENGINE_KEY_ORDER = ["id", "name", "icon", "url"]

_ESCAPES = {
    "\\": "\\\\",
    '"': '\\"',
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\f": "\\f",
    "\r": "\\r",
}

_BARE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def is_runtime_key(key: str) -> bool:
    return key in RUNTIME_KEYS or key.startswith("layout_")


def dump_string(value: str) -> str:
    out = []
    for ch in str(value):
        if ch in _ESCAPES:
            out.append(_ESCAPES[ch])
        elif ord(ch) < 0x20 or ord(ch) == 0x7F:
            out.append(f"\\u{ord(ch):04X}")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def dump_key(key: str) -> str:
    key = str(key)
    if _BARE_KEY_RE.match(key):
        return key
    return dump_string(key)


def dump_value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(dump_value(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = [f"{dump_key(k)} = {dump_value(v)}" for k, v in value.items()]
        return "{" + ", ".join(parts) + "}"
    return dump_string(value)


def _ordered_keys(mapping: dict, preferred: list) -> list:
    keys = []
    for key in preferred:
        if key in mapping and mapping[key] not in (None, ""):
            keys.append(key)
    for key in mapping:
        if key in keys or is_runtime_key(key) or key == "children":
            continue
        if key.startswith("_") or mapping[key] is None:
            continue
        keys.append(key)
    return keys


def _dump_item(item: dict, table_path: str, indent: str = "") -> list:
    lines = [f"{indent}[[{table_path}]]"]
    for key in _ordered_keys(item, _ITEM_KEY_ORDER):
        lines.append(f"{indent}{dump_key(key)} = {dump_value(item[key])}")

    children = item.get("children")
    if isinstance(children, list):
        if children:
            for child in children:
                if not isinstance(child, dict):
                    continue
                lines.extend(_dump_item(child, f"{table_path}.children", indent))
        else:
            # 空文件夹：写 `children = []` 占位。TOML 的数组表语法无法表达
            # 「零个 [[items.children]]」，而空数组作为普通 key 是合法的，
            # 可以让「文件夹」这个类型在保存/重新加载后不丢。
            # orbit 只关心 len(children) > 0，所以对启动行为没有任何影响。
            lines.append(f"{indent}children = []")
    return lines


DEFAULT_HEADER = """\
# =============================================================================
# Nyxuri Orbit Launcher (星环启动器) · 自定义配置文件
# =============================================================================
# 本文件由 orbit-config Web 编辑器生成 / 维护。
# 文件名含 `__custom__`，遵循 Dunder 协议：系统升级与安装时会自动保留，
# 绝不被覆盖，因此可以放心在这里保存你自己的菜单项。
#
# 想手改也可以，字段说明：
#   id        唯一标识（同一层级内不可重复）
#   name      胶囊主标题
#   desc      胶囊副标题（留空则自动显示 "Folder · N Items" 或 "Web Link"）
#   icon      Nerd Font 图标字符（如 "󰈺"）
#   url       网址项，orbit 会用 xdg-open 打开
#   cmd       命令项，交给 niri-scratch-toggle.sh 启动
#   shortcut  快捷键徽标（显示用，例如 "1"）
#   color_key 颜色键：primary / secondary / tertiary / surface / ... 或 #RRGGBB
#   children  子菜单（数组，支持嵌套）
# =============================================================================
"""


def dump_document(items: list, search_meta: dict = None, search_engines: list = None,
                  header: str = None) -> str:
    """把菜单树 + 搜索引擎配置序列化成一份完整的 TOML 文档。"""
    lines = [(header if header is not None else DEFAULT_HEADER).rstrip("\n"), ""]

    meta = dict(search_meta or {})
    if meta:
        lines.append("# ── 全局搜索设置 ──────────────────────────────────────────────")
        lines.append("[search]")
        for key in ("default_engine", "placeholder"):
            if key in meta and meta[key] is not None:
                lines.append(f"{dump_key(key)} = {dump_value(meta[key])}")
        for key in meta:
            if key in ("default_engine", "placeholder", "engines"):
                continue
            if meta[key] is None:
                continue
            lines.append(f"{dump_key(key)} = {dump_value(meta[key])}")
        lines.append("")

    engines = search_engines or []
    if engines:
        lines.append("# ── 搜索引擎 / AI 轮盘（Tab 键循环切换） ──────────────────────")
        for engine in engines:
            if not isinstance(engine, dict):
                continue
            lines.append("[[search_engines]]")
            for key in _ordered_keys(engine, _ENGINE_KEY_ORDER):
                lines.append(f"{dump_key(key)} = {dump_value(engine[key])}")
            lines.append("")

    lines.append("# ── 星环菜单项 ────────────────────────────────────────────────")
    for item in items or []:
        if not isinstance(item, dict):
            continue
        lines.extend(_dump_item(item, "items", indent=""))
        lines.append("")

    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines) + "\n"


# ── 简化写入器（供无法使用 tomllib 的极端环境） ───────────────────────────────

def dumps(payload: dict) -> str:
    """payload: {items, search, search_engines, header}"""
    return dump_document(
        payload.get("items") or [],
        payload.get("search") or {},
        payload.get("search_engines") or [],
        payload.get("header"),
    )
