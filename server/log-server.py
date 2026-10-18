#!/usr/bin/env python3
"""发音 App 诊断日志接收：POST /api/log/ -> 追加一行 JSON 到 /opt/pronunciation-trainer/logs/app.log。
只用 Python 标准库。只接受白名单字段，不保存密码/token 等敏感信息（客户端已脱敏，这里再过滤一次）。
监听 127.0.0.1:18081，仅供本机 nginx 反代，不对外暴露端口。
"""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG_FILE = "/opt/pronunciation-trainer/logs/app.log"
MAX_BODY = 256 * 1024
SENSITIVE = ("token", "password", "passwd", "secret", "authorization", "cookie", "apikey", "api_key")


def _clean_str(v, limit=2000):
    if not isinstance(v, str):
        return ""
    low = v.lower()
    for k in SENSITIVE:
        if k in low:
            return "[redacted]"
    return v[:limit]


def _clean_dict(d, limit=2000):
    if not isinstance(d, dict):
        return {}
    out = {}
    for k, v in list(d.items())[:50]:
        if any(s in str(k).lower() for s in SENSITIVE):
            out[str(k)[:80]] = "[redacted]"
        elif isinstance(v, str):
            out[str(k)[:80]] = _clean_str(v, limit)
        else:
            out[str(k)[:80]] = str(v)[:limit]
    return out


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # 热更新文件：GET /updates/manifest.json 或 /updates/<path>，带 CORS 头（nginx 静态 add_header 被 Cloudflare 剥掉，改由本服务发）
        if not self.path.startswith('/updates/'):
            self._send(404, {"ok": False, "error": "not found"})
            return
        rel = self.path[len('/updates/'):].lstrip('/')
        # 防目录穿越：只允许字母数字/点/横线/下划线/斜杠
        import re as _re
        if not rel or '..' in rel or not _re.match(r'^[A-Za-z0-9_\-\./]+$', rel):
            self._send(404, {"ok": False, "error": "not found"})
            return
        fpath = os.path.join('/opt/pronunciation-trainer/dist/updates', rel)
        if not os.path.isfile(fpath):
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            with open(fpath, 'rb') as f:
                data = f.read()
        except Exception:
            self._send(500, {"ok": False, "error": "read failed"})
            return
        ctype = 'application/json' if fpath.endswith('.json') else ('application/javascript' if fpath.endswith('.js') else ('text/css' if fpath.endswith('.css') else 'application/octet-stream'))
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        # CORS preflight (App 是 https://localhost，跨域 POST 需要)
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        # OTA 补丁升级：POST /api/updates/manifest（清单）与 /api/updates/file（文件 base64）。
        # 走 POST 而不用 GET /updates/*：Cloudflare 会剥掉 GET 响应的 CORS 头，
        # 但 POST 响应（同 /api/log/）的 CORS 头能透过。
        if self.path in ("/api/updates/manifest", "/api/updates/manifest/"):
            try:
                with open("/opt/pronunciation-trainer/dist/updates/manifest.json", "r", encoding="utf-8") as f:
                    m = json.load(f)
            except Exception:
                self._send(404, {"ok": False, "error": "manifest not found"})
                return
            self._send(200, m)
            return
        if self.path in ("/api/updates/file", "/api/updates/file/"):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8")) if n > 0 else {}
            except Exception:
                self._send(400, {"ok": False, "error": "bad json"})
                return
            rel = str(body.get("path", "")).lstrip("/")
            import re as _re
            if not rel or ".." in rel or not _re.match(r"^[A-Za-z0-9_\-\./]+$", rel):
                self._send(404, {"ok": False, "error": "not found"})
                return
            fpath = os.path.join("/opt/pronunciation-trainer/dist/updates", rel)
            if not os.path.isfile(fpath):
                self._send(404, {"ok": False, "error": "not found"})
                return
            try:
                with open(fpath, "rb") as f:
                    data = f.read()
                import base64 as _b64
                self._send(200, {"ok": True, "base64": _b64.b64encode(data).decode(), "size": len(data)})
            except Exception:
                self._send(500, {"ok": False, "error": "read failed"})
            return
        if self.path not in ("/api/log", "/api/log/"):
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            self._send(413, {"ok": False, "error": "bad body"})
            return
        try:
            data = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            self._send(400, {"ok": False, "error": "bad json"})
            return
        if not isinstance(data, dict):
            self._send(400, {"ok": False, "error": "bad json"})
            return
        logs = data.get("logs") if isinstance(data.get("logs"), list) else []
        clean_logs = []
        for e in logs[:300]:
            if isinstance(e, dict):
                clean_logs.append(
                    {
                        "t": e.get("t"),
                        "level": _clean_str(str(e.get("level", "")), 20),
                        "msg": _clean_str(str(e.get("msg", "")), 500),
                    }
                )
        # 附带录音（用户点“发送日志”时才传）：base64 解码存为 logs/audio-<ts>.webm，供诊断
        audio_file = None
        audio = data.get("audio") if isinstance(data.get("audio"), dict) else None
        if audio and isinstance(audio.get("base64"), str):
            try:
                import base64 as _b64
                raw = _b64.b64decode(audio["base64"])
                if 0 < len(raw) <= 2 * 1024 * 1024:  # 最多 2MB
                    ts_ms = int(time.time() * 1000)
                    ext = ".m4a" if "mp4" in str(audio.get("mimeType", "")) else ".webm"
                    audio_file = f"audio-{ts_ms}{ext}"
                    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
                    with open(os.path.join(os.path.dirname(LOG_FILE), audio_file), "wb") as af:
                        af.write(raw)
            except Exception:
                audio_file = None
        rec = {
            "ts": int(time.time() * 1000),
            "app": _clean_str(str(data.get("app", "")), 50),
            "version": _clean_str(str(data.get("version", "")), 50),
            "client_ts": data.get("ts") if isinstance(data.get("ts"), (int, float)) else None,
            "deviceInfo": _clean_dict(data.get("deviceInfo")),
            "logs": clean_logs,
            **({"audioFile": audio_file} if audio_file else {}),
        }
        try:
            os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except Exception:
            self._send(500, {"ok": False, "error": "write failed"})
            return
        self._send(200, {"ok": True})

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 18081), Handler).serve_forever()
