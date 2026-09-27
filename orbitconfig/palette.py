"""
Material You 调色板读取。

orbit 用 color_key 去 palette 里取颜色（palette.py:load_material_palette），
调色板由 noctalia / theme-sync.sh 生成在 ~/.cache/nyxuri/palette.toml。
Web 编辑器读同一份文件，让预览和实际星环配色一致。
"""

import os
import re

from . import paths

_LINE_RE = re.compile(r"^([A-Za-z0-9_]+)\s*=\s*[\"']?(#[0-9A-Fa-f]{6})[\"']?\s*$")

# 与 orbit/palette.py 的兜底一致
FALLBACK = {
    "primary": "#6bb3ff",
    "secondary": "#61d9a6",
    "tertiary": "#ffbf59",
    "surface": "#1f2129",
    "surface_dim": "#0d0f17",
    "on_surface": "#f2f5fc",
    "on_surface_variant": "#adb8c7",
    "outline": "#ccd6e6",
    "error": "#ffb4ab",
}

# 供前端「颜色键」下拉使用的顺序
COLOR_KEYS = [
    "primary", "secondary", "tertiary", "error",
    "surface", "surface_dim", "on_surface", "on_surface_variant", "outline",
]


def _parse_palette(path: str) -> dict:
    colors = {}
    if not os.path.isfile(path):
        return colors
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                match = _LINE_RE.match(line.strip())
                if match:
                    colors[match.group(1)] = match.group(2)
    except OSError:
        return {}
    return colors


def load_palette() -> dict:
    """返回 {colors: {...}, source: 路径或 None, color_keys: [...]}"""
    source = None
    colors = {}
    for candidate in paths.PALETTE_PATHS:
        found = _parse_palette(candidate)
        if found:
            source = candidate
            colors = found
            break

    merged = dict(FALLBACK)
    merged.update(colors)

    color_keys = [k for k in COLOR_KEYS if k in merged]
    for key in sorted(merged):
        if key not in color_keys:
            color_keys.append(key)

    return {
        "colors": merged,
        "source": source,
        "color_keys": color_keys,
        "is_dynamic": source is not None,
    }
