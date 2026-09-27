"""
复用 orbit 启动器自带的出厂默认菜单树与搜索引擎定义。

orbit/config.py 里已经维护了一份 DEFAULT_MENU_TREE / DEFAULT_SEARCH_ENGINES，
直接按文件路径动态加载它，避免在本工具里复制粘贴一份会过期的副本。
"""

import copy
import importlib.util
import os
import sys

from . import paths

_FALLBACK_SEARCH_META = {
    "default_engine": "bing",
    "placeholder": "Search or ask...",
}

_FALLBACK_ENGINES = [
    {"id": "bing", "name": "Bing", "icon": "\U000f0349",
     "url": "https://www.bing.com/search?q={query}"},
    {"id": "google", "name": "Google", "icon": "\U000f02ad",
     "url": "https://www.google.com/search?q={query}"},
]

_FALLBACK_ITEMS = [
    {"id": "kitty", "name": "Kitty", "desc": "Terminal", "icon": "\U000f07b7",
     "cmd": "kitty", "shortcut": "1", "color_key": "secondary"},
    {"id": "websites", "name": "Websites", "desc": "Folder · 3 Sites",
     "icon": "\U000f059f", "shortcut": "2", "color_key": "secondary",
     "children": [
         {"id": "github", "name": "GitHub", "desc": "Code Repository",
          "icon": "\U000f02a4", "url": "https://github.com",
          "shortcut": "1", "color_key": "secondary"},
     ]},
]

_cache = None


def _load_orbit_module():
    """动态加载 ~/.config/noctalia/tools/orbit/config.py。"""
    path = paths.ORBIT_CONFIG_MODULE
    if not os.path.isfile(path):
        return None
    try:
        spec = importlib.util.spec_from_file_location("_orbit_factory_defaults", path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        # 不写入 sys.modules，避免污染；exec 期间相对导入不需要。
        sys.modules.setdefault("_orbit_factory_defaults", module)
        spec.loader.exec_module(module)
        return module
    except Exception as exc:  # pragma: no cover - 防御性
        print(f"[orbit-config] 无法加载 {path}: {exc}", file=sys.stderr)
        return None


def factory_defaults() -> tuple:
    """返回 (items, search_engines, search_meta) 的出厂默认副本。"""
    global _cache
    if _cache is None:
        module = _load_orbit_module()
        if module is not None and hasattr(module, "DEFAULT_MENU_TREE"):
            items = copy.deepcopy(getattr(module, "DEFAULT_MENU_TREE") or [])
            engines = copy.deepcopy(getattr(module, "DEFAULT_SEARCH_ENGINES") or [])
            _cache = (items, engines, dict(_FALLBACK_SEARCH_META))
        else:
            _cache = (
                copy.deepcopy(_FALLBACK_ITEMS),
                copy.deepcopy(_FALLBACK_ENGINES),
                dict(_FALLBACK_SEARCH_META),
            )
    items, engines, meta = _cache
    return copy.deepcopy(items), copy.deepcopy(engines), dict(meta)


def factory_defaults_available() -> bool:
    """出厂默认是否来自真实 orbit 模块（而非内置兜底）。"""
    _load_orbit_module()
    return os.path.isfile(paths.ORBIT_CONFIG_MODULE)
