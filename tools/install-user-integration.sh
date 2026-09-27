#!/usr/bin/env bash
# =============================================================================
# 星环配置器 · 用户级桌面集成安装脚本
#
# 只写这两个位置，不碰任何系统文件、不需要 sudo：
#   ~/.local/share/applications/orbit-config.desktop
#   ~/.config/systemd/user/orbit-config.service
#
# 用法：
#   tools/install-user-integration.sh              # 安装 / 更新
#   tools/install-user-integration.sh --uninstall  # 卸载
#   tools/install-user-integration.sh --dry-run    # 只显示会做什么
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PACKAGING_DIR="$PROJECT_DIR/packaging"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DESKTOP_DIR="$DATA_HOME/applications"
SYSTEMD_DIR="$CONFIG_HOME/systemd/user"

DESKTOP_DEST="$DESKTOP_DIR/orbit-config.desktop"
SERVICE_DEST="$SYSTEMD_DIR/orbit-config.service"

PYTHON_BIN="$(command -v python3 || true)"
ACTION="install"
DRY_RUN=0

for arg in "$@"; do
    case "$arg" in
        --uninstall) ACTION="uninstall" ;;
        --dry-run)   DRY_RUN=1 ;;
        -h|--help)
            sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *)
            echo "未知参数: $arg" >&2
            exit 1 ;;
    esac
done

say() { printf '  %s\n' "$*"; }
run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        say "[dry-run] $*"
    else
        "$@"
    fi
}

echo "星环配置器 · 用户级集成（${ACTION}）"
say "项目目录 : $PROJECT_DIR"
[ -n "$PYTHON_BIN" ] && say "Python   : $PYTHON_BIN"
echo

if [ "$ACTION" = "uninstall" ]; then
    for target in "$DESKTOP_DEST" "$SERVICE_DEST"; do
        if [ -e "$target" ]; then
            run rm -f "$target"
            say "已删除 $target"
        else
            say "不存在，跳过 $target"
        fi
    done
    run rm -f "$DESKTOP_DEST.bak" "$SERVICE_DEST.bak"
    if command -v update-desktop-database >/dev/null 2>&1 && [ -d "$DESKTOP_DIR" ]; then
        run update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    fi
    if command -v systemctl >/dev/null 2>&1; then
        run systemctl --user daemon-reload 2>/dev/null || true
    fi
    echo
    say "完成。"
    exit 0
fi

if [ -z "$PYTHON_BIN" ]; then
    echo "找不到 python3，请先安装 Python 3.11+（需要 tomllib）。" >&2
    exit 1
fi

if [ ! -f "$PROJECT_DIR/orbit-config.py" ]; then
    echo "在 $PROJECT_DIR 里找不到 orbit-config.py，项目结构不完整？" >&2
    exit 1
fi

render() {
    # $1 = 模板路径, $2 = 目标路径
    sed -e "s|@PROJECT_DIR@|$PROJECT_DIR|g" \
        -e "s|@PYTHON@|$PYTHON_BIN|g" \
        "$1" > "$2"
}

run mkdir -p "$DESKTOP_DIR" "$SYSTEMD_DIR"
[ "$DRY_RUN" -eq 1 ] || say "已确认目录: $DESKTOP_DIR, $SYSTEMD_DIR"

# 已存在则先留一份 .bak
for pair in "$DESKTOP_DEST" "$SERVICE_DEST"; do
    [ -e "$pair" ] && run cp -f "$pair" "$pair.bak"
done

if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] 渲染 packaging/orbit-config.desktop -> $DESKTOP_DEST"
    say "[dry-run] 渲染 packaging/orbit-config.service -> $SERVICE_DEST"
else
    render "$PACKAGING_DIR/orbit-config.desktop" "$DESKTOP_DEST"
    render "$PACKAGING_DIR/orbit-config.service" "$SERVICE_DEST"
    chmod 644 "$DESKTOP_DEST" "$SERVICE_DEST"
    say "已写入 $DESKTOP_DEST"
    say "已写入 $SERVICE_DEST"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
    run update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi
if command -v systemctl >/dev/null 2>&1; then
    run systemctl --user daemon-reload 2>/dev/null || true
fi

echo
echo "接下来："
say "· 应用菜单里应该能看到「星环配置器」；也可以直接运行："
say "    systemctl --user start orbit-config"
say "    然后打开 http://127.0.0.1:8787/"
say "· 想开机自启：systemctl --user enable orbit-config"
say "· 想加快捷键：把 packaging/niri-keybind.snippet.kdl 粘到 ~/.config/niri/__custom__.kdl"
say "· 卸载：tools/install-user-integration.sh --uninstall"
