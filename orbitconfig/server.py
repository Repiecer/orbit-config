"""
Orbit Web Config 的 HTTP 服务（纯标准库，零依赖）。

安全模型：只监听本机回环地址 + 校验 Host / Origin 头，
避免任意网页通过 DNS rebinding 或跨站表单改你的桌面配置。
"""

import json
import mimetypes
import os
import posixpath
import socket
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

from . import icons as icons_module
from . import palette as palette_module
from . import paths, store

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
MAX_BODY = 4 * 1024 * 1024

_ALLOWED_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"}
_ALLOWED_ASSET_EXT = {".html", ".css", ".js", ".json", ".svg", ".png", ".ico", ".woff2", ".webmanifest"}

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")


class OrbitConfigHandler(BaseHTTPRequestHandler):
    server_version = "OrbitConfig/1.0"
    protocol_version = "HTTP/1.1"

    # ── 基础设施 ────────────────────────────────────────────────────────────

    def log_message(self, fmt, *args):
        if getattr(self.server, "verbose", False):
            sys.stderr.write("[orbit-config] %s - %s\n" % (self.address_string(), fmt % args))

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0].strip().lower()
        if not host:
            return True
        if host in _ALLOWED_HOSTS:
            return True
        try:
            socket.inet_aton(host)
            return True
        except OSError:
            return False

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlparse(origin)
        return (parsed.hostname or "") in _ALLOWED_HOSTS

    def _token_ok(self, query) -> bool:
        expected = getattr(self.server, "token", None)
        if not expected:
            return True
        provided = self.headers.get("X-Orbit-Token") or (query.get("token", [""])[0])
        return provided == expected

    def _guard(self, path: str, query) -> bool:
        if not self._host_ok() or not self._origin_ok():
            self._json({"ok": False, "error": "拒绝访问：仅允许本机同源请求"}, 403)
            return False
        # 令牌只保护 /api/* 数据接口；静态资源（HTML/CSS/JS）不带令牌也能取，
        # 否则页面加载时浏览器无法给 <link>/<script> 带上 ?token=。
        if str(path).startswith("/api/") and not self._token_ok(query):
            self._json({"ok": False, "error": "缺少或错误的访问令牌 (X-Orbit-Token / ?token=)"}, 401)
            return False
        return True

    def _json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise store.ConfigError("请求体过大")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise store.ConfigError(f"请求体不是合法 JSON: {exc}")

    def _send_text(self, text: str, status: int = 200, content_type="text/plain; charset=utf-8",
                   extra_headers=None):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, body: bytes, content_type: str, download_name: str = None,
                    cache: str = "no-cache"):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        self.wfile.write(body)

    def _serve_backup(self, name: str) -> None:
        safe = os.path.basename(unquote(name)).strip()
        if not safe or safe in (".", ".."):
            self._send_text("Not found", 404)
            return
        full = os.path.join(paths.BACKUP_DIR, safe)
        if not os.path.isfile(full):
            self._send_text("Not found", 404)
            return
        ctype, _ = mimetypes.guess_type(full)
        with open(full, "rb") as handle:
            body = handle.read()
        self._send_bytes(body, ctype or "application/octet-stream", download_name=safe)

    def _serve_static(self, relative: str, download_name: str = None) -> None:
        relative = unquote(relative).lstrip("/")
        normalized = posixpath.normpath(relative)
        if normalized.startswith("..") or os.path.isabs(normalized):
            self._send_text("Not found", 404)
            return

        full = os.path.join(WEB_DIR, normalized)
        if not os.path.isfile(full):
            self._send_text("Not found", 404)
            return
        if os.path.splitext(full)[1].lower() not in _ALLOWED_ASSET_EXT:
            self._send_text("Not found", 404)
            return

        ctype, _ = mimetypes.guess_type(full)
        with open(full, "rb") as handle:
            body = handle.read()

        self._send_bytes(
            body,
            (ctype or "application/octet-stream") + (
                "; charset=utf-8" if (ctype or "").startswith(("text/", "application/javascript")) else ""
            ),
            download_name=download_name,
        )

    # ── 路由 ────────────────────────────────────────────────────────────────

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        if not self._guard(path, query):
            return
        try:
            self._route_get(path, query)
        except store.ConfigError as exc:
            self._json({"ok": False, "error": str(exc), "details": exc.errors}, 400)
        except Exception as exc:  # pragma: no cover
            self._json({"ok": False, "error": f"服务器内部错误: {exc}"}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        if not self._guard(path, query):
            return
        try:
            self._route_post(path, self._read_json())
        except store.ConfigError as exc:
            self._json({"ok": False, "error": str(exc), "details": exc.errors}, 400)
        except Exception as exc:  # pragma: no cover
            self._json({"ok": False, "error": f"服务器内部错误: {exc}"}, 500)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        if not self._guard(path, query):
            return
        try:
            self._route_delete(path)
        except store.ConfigError as exc:
            self._json({"ok": False, "error": str(exc), "details": exc.errors}, 400)
        except Exception as exc:  # pragma: no cover
            self._json({"ok": False, "error": f"服务器内部错误: {exc}"}, 500)

    def _route_get(self, path: str, query: dict):
        if path == "/":
            self._serve_static("index.html")
            return
        if path.startswith("/assets/"):
            self._serve_static(path[len("/assets/"):])
            return
        if path == "/favicon.ico":
            self._serve_static("favicon.svg")
            return

        if path == "/api/state":
            self._json({
                "ok": True,
                "config": store.read_config(),
                "palette": palette_module.load_palette(),
                "paths": {
                    "write_path": paths.WRITE_PATH,
                    "config_paths": paths.CONFIG_PATHS,
                    "preset_dir": paths.PRESET_DIR,
                    "backup_dir": paths.BACKUP_DIR,
                    "app_home": paths.APP_HOME,
                },
            })
            return

        if path == "/api/icons":
            self._json({"ok": True, **icons_module.load_icons()})
            return

        if path == "/api/palette":
            self._json({"ok": True, **palette_module.load_palette()})
            return

        if path == "/api/backups":
            self._json({"ok": True, "backups": store.list_backups(), "dir": paths.BACKUP_DIR})
            return

        if path.startswith("/api/backups/"):
            self._serve_backup(path[len("/api/backups/"):])
            return

        if path == "/api/presets":
            self._json({"ok": True, "presets": store.list_presets(), "dir": paths.PRESET_DIR})
            return

        if path.startswith("/api/presets/"):
            preset_id = unquote(path[len("/api/presets/"):])
            self._json({"ok": True, "preset": store.load_preset(preset_id)})
            return

        if path == "/api/export":
            payload = store.export_payload()
            stamp = payload["exported_at"].replace(":", "").replace("-", "").replace("T", "-")
            self._send_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                content_type="application/json; charset=utf-8",
                extra_headers={
                    "Content-Disposition": f'attachment; filename="orbit-config-{stamp}.json"'
                },
            )
            return

        self._send_text("Not found", 404)

    def _route_post(self, path: str, body: dict):
        palette_keys = palette_module.load_palette()["color_keys"]

        if path == "/api/validate":
            payload = store.normalize_payload(body.get("config") or body)
            result = store.validate(payload, palette_keys=palette_keys)
            self._json({
                "ok": True,
                "validation": result,
                "preview": store.render_document(payload),
            })
            return

        if path == "/api/config":
            payload = body.get("config") or body
            result = store.write_config(payload, reason="web-edit", palette_keys=palette_keys)
            self._json({
                "ok": True,
                "config": result["config"],
                "validation": result["validation"],
                "backup": result["backup"],
                "message": "已保存，" + os.path.basename(paths.WRITE_PATH) + " 已更新（orbit 下次打开即生效）",
            })
            return

        if path == "/api/backups":
            info = store.create_backup(body.get("reason") or "manual")
            self._json({
                "ok": True,
                "backup": info,
                "backups": store.list_backups(),
                "message": "已创建备份" if info else "当前还没有配置文件可备份",
            })
            return

        if path == "/api/backups/restore":
            current = store.restore_backup(body.get("name") or "")
            self._json({
                "ok": True,
                "config": current,
                "backups": store.list_backups(),
                "message": "已从备份恢复",
            })
            return

        if path == "/api/backups/delete":
            store.delete_backup(body.get("name") or "")
            self._json({"ok": True, "backups": store.list_backups(), "message": "备份已删除"})
            return

        if path == "/api/presets":
            preset = store.save_preset(
                body.get("name") or "",
                body.get("config") or {},
                overwrite=bool(body.get("overwrite", True)),
            )
            self._json({
                "ok": True,
                "preset": preset,
                "presets": store.list_presets(),
                "message": f"预设 “{preset['name']}” 已保存",
            })
            return

        if path == "/api/presets/apply":
            preset_id = body.get("id") or ""
            preset = store.load_preset(preset_id)
            payload = preset["config"]
            if body.get("save"):
                palette_keys = palette_module.load_palette()["color_keys"]
                result = store.write_config(payload, reason=f"preset-{preset_id}", palette_keys=palette_keys)
                self._json({
                    "ok": True,
                    "config": result["config"],
                    "backup": result["backup"],
                    "validation": result["validation"],
                    "message": f"已切换到预设 “{preset['name']}” 并写入配置",
                })
            else:
                self._json({
                    "ok": True,
                    "loaded": store.normalize_payload(payload),
                    "message": f"预设 “{preset['name']}” 已载入编辑器（尚未写入磁盘）",
                })
            return

        if path == "/api/presets/rename":
            preset = store.rename_preset(body.get("id") or "", body.get("name") or "")
            self._json({
                "ok": True,
                "preset": preset,
                "presets": store.list_presets(),
                "message": "预设已重命名",
            })
            return

        if path == "/api/presets/delete":
            store.delete_preset(body.get("id") or "")
            self._json({"ok": True, "presets": store.list_presets(), "message": "预设已删除"})
            return

        if path == "/api/import":
            text = body.get("text")
            if text is None and isinstance(body.get("config"), dict):
                payload = store.normalize_payload(body["config"])
            else:
                payload = store.parse_import(text or "")
            result = store.validate(payload, palette_keys=palette_keys)
            self._json({
                "ok": True,
                "loaded": payload,
                "validation": result,
                "message": "导入成功，已载入编辑器（尚未写入磁盘）",
            })
            return

        self._send_text("Not found", 404)

    def _route_delete(self, path: str):
        if path.startswith("/api/presets/"):
            store.delete_preset(unquote(path[len("/api/presets/"):]))
            self._json({"ok": True, "presets": store.list_presets(), "message": "预设已删除"})
            return
        if path.startswith("/api/backups/"):
            store.delete_backup(unquote(path[len("/api/backups/"):]))
            self._json({"ok": True, "backups": store.list_backups(), "message": "备份已删除"})
            return
        self._send_text("Not found", 404)


def build_server(host: str = None, port: int = None, token: str = None, verbose: bool = False):
    host = host or paths.default_serve_host()
    port = int(port if port is not None else paths.default_serve_port())

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    httpd = Server((host, port), OrbitConfigHandler)
    httpd.token = token
    httpd.verbose = verbose
    return httpd


def serve(host: str = None, port: int = None, token: str = None, open_browser: bool = False,
          verbose: bool = False) -> int:
    paths.ensure_state_dirs()
    httpd = build_server(host, port, token, verbose)
    actual_port = httpd.server_address[1]
    display_host = httpd.server_address[0]
    url = f"http://{'localhost' if display_host in ('127.0.0.1', '0.0.0.0') else display_host}:{actual_port}/"
    if token:
        url_with_token = f"{url}?token={token}"
    else:
        url_with_token = url

    print("Orbit Web Config 已启动")
    print(f"  地址      : {url_with_token}")
    print(f"  配置文件  : {paths.WRITE_PATH}")
    print(f"  预设目录  : {paths.PRESET_DIR}")
    print(f"  备份目录  : {paths.BACKUP_DIR}")
    print("  按 Ctrl+C 退出")
    sys.stdout.flush()

    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url_with_token)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在退出…")
    finally:
        httpd.server_close()
    return 0
