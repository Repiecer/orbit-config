#!/usr/bin/env python3
"""
Orbit Web Config — 星环启动器配置的 Web 编辑器。

启动：
    python3 orbit-config.py                 # 监听 127.0.0.1:8787 并打开浏览器
    python3 orbit-config.py --no-browser    # 不自动打开浏览器
    python3 orbit-config.py --port 9000
    python3 orbit-config.py --token secret  # 额外要求访问令牌
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from orbitconfig import paths, server  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="orbit-config",
        description="用 Web 界面编辑 orbit 星环启动器的菜单项（websites 等）与搜索引擎",
    )
    parser.add_argument("--host", default=paths.default_serve_host(),
                        help="监听地址（默认 127.0.0.1，仅本机可访问）")
    parser.add_argument("--port", type=int, default=paths.default_serve_port(),
                        help="监听端口（默认 8787，0 表示自动选择空闲端口）")
    parser.add_argument("--token", default=os.environ.get("ORBIT_CONFIG_TOKEN"),
                        help="可选的访问令牌，URL 需带 ?token=...")
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    parser.add_argument("--verbose", action="store_true", help="打印每个 HTTP 请求")
    parser.add_argument("--print-config", action="store_true",
                        help="仅打印将要写入的 TOML 文档后退出（不写盘）")
    args = parser.parse_args()

    if args.print_config:
        from orbitconfig import store
        print(store.render_document(store.read_config()), end="")
        return 0

    return server.serve(
        host=args.host,
        port=args.port,
        token=args.token,
        open_browser=not args.no_browser,
        verbose=args.verbose,
    )


if __name__ == "__main__":
    sys.exit(main())
