"""
Orbit Web Config — 路径解析。

集中定义 orbit 启动器配置文件的读取优先级、写回目标，
以及本工具自身的状态目录（预设 / 备份）。
"""

import os

HOME = os.path.expanduser("~")
XDG_CONFIG_HOME = os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config")
XDG_CACHE_HOME = os.environ.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache")

TOOLS_DIR = os.path.join(XDG_CONFIG_HOME, "noctalia", "tools")
NIRI_DIR = os.path.join(XDG_CONFIG_HOME, "niri")

# 必须与 orbit/config.py:CONFIG_PATHS 保持一致的优先级顺序（高 → 低）
CONFIG_PATHS = [
    os.path.join(TOOLS_DIR, "orbit-items__custom__.toml"),
    os.path.join(NIRI_DIR, "scratchpad-items__custom__.toml"),
    os.path.join(TOOLS_DIR, "orbit-items.toml"),
    os.path.join(NIRI_DIR, "scratchpad-items.toml"),
    os.path.join(NIRI_DIR, "scratchpad-items.json"),
]

# 写回目标：优先级最高、且带 dunder 协议（系统升级不会被覆盖）
WRITE_PATH = CONFIG_PATHS[0]

# 出厂默认值来源（复用 orbit 自带的 DEFAULT_MENU_TREE / DEFAULT_SEARCH_ENGINES）
ORBIT_CONFIG_MODULE = os.path.join(TOOLS_DIR, "orbit", "config.py")

# Material You 动态调色板（由 noctalia / theme-sync.sh 生成）
PALETTE_PATHS = [
    os.path.join(XDG_CACHE_HOME, "nyxuri", "palette.toml"),
    os.path.join(XDG_CACHE_HOME, "nyxniri", "palette.toml"),
]

# 本工具的状态目录
APP_HOME = os.environ.get("ORBIT_CONFIG_HOME") or os.path.join(
    XDG_CONFIG_HOME, "nyxuri", "orbit-config"
)
PRESET_DIR = os.path.join(APP_HOME, "presets")
BACKUP_DIR = os.path.join(APP_HOME, "backups")

# 备份保留数量
MAX_BACKUPS = 40


def ensure_state_dirs() -> None:
    """确保预设 / 备份目录存在。"""
    for d in (APP_HOME, PRESET_DIR, BACKUP_DIR):
        os.makedirs(d, exist_ok=True)


def default_serve_host() -> str:
    return os.environ.get("ORBIT_CONFIG_HOST", "127.0.0.1")


def default_serve_port() -> int:
    try:
        return int(os.environ.get("ORBIT_CONFIG_PORT", "8787"))
    except ValueError:
        return 8787
