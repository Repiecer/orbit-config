"""
图标库：加载 tools/build_icons.py 从系统 Nerd Font 里提取的精选图标。

数据文件里每条记录是 {"n": 字体字形名, "c": 码点, "l": 人类可读标签}，
前端用它渲染可视化图标选择器。
"""

import json
import os

_DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nerd_icons.json")

_cache = None


def load_icons() -> dict:
    """返回 {source_font, categories: [{name, icons: [{n, c, l, char}]}]}。"""
    global _cache
    if _cache is not None:
        return _cache

    try:
        with open(_DATA_PATH, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except Exception:
        raw = {"source_font": None, "categories": []}

    categories = []
    total = 0
    for category in raw.get("categories", []):
        icons = []
        for entry in category.get("icons", []):
            try:
                code = int(entry["c"])
            except (KeyError, TypeError, ValueError):
                continue
            icons.append({
                "n": str(entry.get("n", "")),
                "c": code,
                "l": str(entry.get("l") or entry.get("n", "")),
                "char": chr(code),
            })
        total += len(icons)
        categories.append({"name": str(category.get("name", "其他")), "icons": icons})

    _cache = {
        "source_font": raw.get("source_font"),
        "total": total,
        "categories": categories,
    }
    return _cache
