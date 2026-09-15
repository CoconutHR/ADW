#!/usr/bin/env python3
"""
server.py — AxData 买卖时机分析面板 · 本地同源服务器

同时做三件事：
  1. 静态托管本目录（index.html / css / js）
  2. 把 /health 与 /v1/* 反向代理到 AxData HTTP API（默认 http://127.0.0.1:8666）
  3. 对下行响应统一放开 CORS，并本地应答 OPTIONS 预检

浏览器规定协议/域名/端口任一不同即跨域。面板（8080）与 AxData（8666）端口不同，
而 AxData 自带 CORSMiddleware 且只放行白名单来源，预检会被直接拒
（响应体 Disallowed CORS origin，日志可见 OPTIONS /v1/... 400）。
本服务让面板与 API 同源，从根上规避 CORS，无需修改 AxData 任何代码。

放开 CORS 的两个原因：
  - AxData 的路由只注册了 POST，OPTIONS 会被判 405，浏览器预检必然失败，
    因此预检由本服务直接应答，不下发；
  - 面板若由其它静态服务器（含 IDE 预览）托管，仍能通过本代理访问 AxData。

对 AxData 的请求强制直连、绕过一切系统/环境代理：
macOS 上 Python 的 urllib 会读取系统代理（Clash/Surge 等的「系统代理」模式），
发往 127.0.0.1:8666 的请求可能被代理工具劫持导致连接失败（面板端表现为 502），
因此本服务使用无代理 opener 直连 AxData，无需关闭代理工具。

用法（在本文件所在目录执行）：
  python3 server.py

  可选环境变量：
  AXDATA_API=http://127.0.0.1:8666   # AxData 后端地址
  PANEL_HOST=127.0.0.1               # 面板监听地址（0.0.0.0 可局域网访问）
  PANEL_PORT=8080                    # 面板监听端口
  API_TIMEOUT=60                     # 代理请求超时（秒）

启动后：
  1. 浏览器打开 http://127.0.0.1:8080
  2. 进入「设置」页，将服务地址改为 http://127.0.0.1:8080，点「测试连接」

仅依赖 Python 3.7+ 标准库，无需安装任何第三方包。
"""

import json
import os
import socket
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if sys.version_info < (3, 7):
    sys.exit("需要 Python 3.7+（当前 %s）" % sys.version.split()[0])

ROOT = Path(__file__).resolve().parent
API_BASE = os.environ.get("AXDATA_API", "http://127.0.0.1:8666").rstrip("/")
PANEL_HOST = os.environ.get("PANEL_HOST", "127.0.0.1")
PANEL_PORT = int(os.environ.get("PANEL_PORT", "8080"))
API_TIMEOUT = float(os.environ.get("API_TIMEOUT", "60"))

# 需要反向代理到 AxData 的路径前缀
PROXY_PREFIXES = ("/health", "/v1/")
# 转发到 AxData 的请求头白名单（Host/Connection/长度由本服务自行处理）
FORWARD_HEADERS = ("Content-Type", "Accept", "Accept-Encoding", "Authorization", "User-Agent")

# 本服务对下行响应放开的 CORS 头。
# AxData 自身带 CORSMiddleware 且只放行白名单来源（其它来源返回 400 Disallowed CORS origin），
# 面板若从别的端口/域名打开（例如 IDE 预览、file:// 打开后填 8080），预检会被 AxData 直接拒掉。
# 这里由代理层统一放行，使面板无论从哪个来源访问都能走通同源代理。
CORS_HEADERS = (
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD"),
    ("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept"),
    ("Access-Control-Max-Age", "600"),
    ("Vary", "Origin"),
)

# 无代理 opener：绕过系统代理（macOS 系统配置）与 http_proxy 等环境变量，
# 保证代理进程对 AxData（通常为本机回环）始终直连。
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def preflight():
    """启动时探测 AxData /health 一次，便于在终端立即暴露后端不可达问题。"""
    url = API_BASE + "/health"
    try:
        with OPENER.open(url, timeout=5) as resp:
            resp.read()
        return True, ""
    except urllib.error.HTTPError as e:
        # 后端有响应但返回错误码 —— 服务在，只是 /health 状态异常，仍视为可达
        return True, "HTTP %s" % e.code
    except Exception as e:
        return False, "%s: %s" % (type(e).__name__, e)


class PanelHandler(SimpleHTTPRequestHandler):
    """静态文件托管 + AxData 反向代理"""

    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(directory=str(ROOT), *args, **kwargs)

    def end_headers(self):
        # 静态资源（HTML/CSS/JS）禁用缓存：避免浏览器复用旧版前端代码，
        # 导致面板请求已被移除的旧接口名/旧参数（表现为 400/404 反复出现）。
        # API 代理响应已按需透传，不在此处理。
        if not self._is_proxy_path():
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    # ---- 路由分发 ----
    def _is_proxy_path(self):
        return any(self.path.startswith(p) for p in PROXY_PREFIXES)

    def do_GET(self):
        if self._is_proxy_path():
            self._proxy()
        else:
            super().do_GET()

    def do_HEAD(self):
        if self._is_proxy_path():
            self._proxy(send_body=False)
        else:
            super().do_HEAD()

    def do_POST(self):
        self._proxy_or_405()

    def do_PUT(self):
        self._proxy_or_405()

    def do_DELETE(self):
        self._proxy_or_405()

    def do_PATCH(self):
        self._proxy_or_405()

    def do_OPTIONS(self):
        if self._is_proxy_path():
            # 预检由本服务直接应答，不下发给 AxData。
            # AxData 的路由只注册了 POST，OPTIONS 会被判为 405，导致浏览器预检失败。
            self._send_cors_preflight()
        else:
            self.send_error(405, "Method Not Allowed")

    def _proxy_or_405(self):
        if self._is_proxy_path():
            self._proxy()
        else:
            self.send_error(405, "Method Not Allowed")

    # ---- 代理实现 ----
    def _proxy(self, send_body=True):
        url = API_BASE + self.path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else None

        req = urllib.request.Request(url, data=body, method=self.command)
        for name in FORWARD_HEADERS:
            value = self.headers.get(name)
            if value:
                req.add_header(name, value)

        try:
            resp = OPENER.open(req, timeout=API_TIMEOUT)
        except urllib.error.HTTPError as e:
            resp = e  # HTTPError 同样可读取状态码/响应头/响应体
        except urllib.error.URLError as e:
            reason = e.reason
            if isinstance(reason, socket.timeout) or "timed out" in str(reason).lower():
                hint = "AxData 响应超时。若正在大量采集数据，可稍后重试或调大 API_TIMEOUT"
                self._send_json(504, {"error": "AxData 响应超时（%s）" % API_BASE, "hint": hint})
            elif "proxy" in str(reason).lower():
                hint = "请求被代理进程/系统代理劫持。本服务已强制直连，请检查本机代理软件对 127.0.0.1 的拦截规则"
                self._send_json(502, {"error": "经由代理访问 AxData 失败：%s" % reason, "hint": hint})
            elif isinstance(reason, ConnectionRefusedError) or "refused" in str(reason).lower():
                hint = "AxData 未监听 %s。请先启动 AxData：python -m uvicorn apps.api.main:app --host 127.0.0.1 --port 8666 --reload" % API_BASE
                self._send_json(502, {"error": "AxData 连接被拒绝（%s）" % API_BASE, "hint": hint})
            else:
                hint = "请确认 AxData 已启动且地址正确（AXDATA_API 环境变量可覆盖，当前 %s）" % API_BASE
                self._send_json(502, {"error": "无法连接 AxData（%s）：%s" % (API_BASE, reason), "hint": hint})
            return
        except socket.timeout:
            self._send_json(504, {"error": "AxData 响应超时（%s）" % API_BASE,
                                  "hint": "若正在大量采集数据，可稍后重试或调大 API_TIMEOUT"})
            return
        except Exception as e:  # 兜底
            self._send_json(502, {"error": "代理请求失败：%s" % e,
                                  "hint": "请确认 AxData 已启动且地址正确（AXDATA_API 环境变量可覆盖，当前 %s）" % API_BASE})
            return

        payload = resp.read()
        status = resp.status if hasattr(resp, "status") else resp.code
        try:
            resp.close()
        except Exception:
            pass

        self.send_response(status)
        for key, value in resp.headers.items():
            lower = key.lower()
            if lower in ("transfer-encoding", "connection", "content-length"):
                continue  # 长度由本服务重算，其余原样透传
            if lower.startswith("access-control-") or lower == "vary":
                continue  # CORS 由本服务统一放行，避免与 AxData 的白名单策略冲突
            self.send_header(key, value)
        for key, value in CORS_HEADERS:
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload) if send_body else 0))
        self.end_headers()
        if send_body and payload:
            self._write_all(payload)

    def _write_all(self, payload):
        """写响应体，容忍客户端提前断开（curl | head、页面切换等），避免刷错误栈。"""
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send_cors_preflight(self):
        """应答 OPTIONS 预检：告知浏览器本代理允许跨域，无需下发给 AxData。"""
        self.send_response(204)
        for key, value in CORS_HEADERS:
            self.send_header(key, value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_json(self, status, obj):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        for key, value in CORS_HEADERS:
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        sys.stderr.write("[panel] %s - %s\n" % (self.address_string(), fmt % args))


def main():
    try:
        server = ThreadingHTTPServer((PANEL_HOST, PANEL_PORT), PanelHandler)
    except OSError as e:
        sys.exit("无法监听 %s:%s：%s\n可用 PANEL_PORT=其他端口 python3 server.py 重试"
                 % (PANEL_HOST, PANEL_PORT, e))

    ok, detail = preflight()
    print("=" * 62)
    print(" AxData 买卖时机分析面板 · 本地同源服务器")
    print("=" * 62)
    print(" 面板地址   : http://%s:%s" % (PANEL_HOST, PANEL_PORT))
    print(" 代理目标   : %s  (/health 与 /v1/*)" % API_BASE)
    if ok:
        print(" 后端预检   : AxData 可达%s" % ("（/health 返回 %s）" % detail if detail else "，/health 正常"))
    else:
        print(" 后端预检   : ✖ 暂时连不上 AxData（%s）" % detail)
        print("               面板仍会启动；请确认 AxData 已运行：")
        print("               python -m uvicorn apps.api.main:app --host 127.0.0.1 --port 8666 --reload")
        print("               连通后无需重启本服务，「测试连接」即可通过")
    print()
    print(" 下一步：")
    print("   1. 浏览器打开 http://%s:%s" % (PANEL_HOST, PANEL_PORT))
    print("   2. 进入「设置」页，将服务地址改为 http://%s:%s" % (PANEL_HOST, PANEL_PORT))
    print("   3. 点击「测试连接」，显示连接成功即可开始使用")
    print()
    print(" Ctrl+C 停止服务")
    print("=" * 62)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        server.server_close()


if __name__ == "__main__":
    main()
