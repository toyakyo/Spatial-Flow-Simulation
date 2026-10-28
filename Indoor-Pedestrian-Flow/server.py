"""室內人流模擬器的小伺服器：提供靜態檔案，並把場景存成 scenes/*.json。

只用標準函式庫。沒有這個伺服器，index.html 照樣能用（存取走 JSON 檔下載／上傳）。

    python server.py            # http://localhost:8000
    python server.py 9000       # 指定埠
    HOST=0.0.0.0 python server.py   # 雲端／容器內要對外時
"""
import json
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
SCENES = os.path.join(ROOT, "scenes")
NAME = re.compile(r"^[\w-]{1,40}$")
MAX_BODY = 2 * 1024 * 1024
PROTECTED = {"tainan-station", "tainan-b1-piano"}   # repo 內建範例，不允許從介面刪除


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _path(self):
        """/api/scenes/<name> → 檔案路徑；名稱不合法回 None（擋掉 ../ 之類）"""
        name = self.path.split("?")[0].rsplit("/", 1)[-1]
        return os.path.join(SCENES, name + ".json") if NAME.match(name) else None

    def do_GET(self):
        route = self.path.split("?")[0].rstrip("/")
        if route == "/api/scenes":
            os.makedirs(SCENES, exist_ok=True)
            names = sorted(f[:-5] for f in os.listdir(SCENES) if f.endswith(".json"))
            return self._json(200, names)
        if route.startswith("/api/scenes/"):
            p = self._path()
            if not p or not os.path.isfile(p):
                return self._json(404, {"error": "not found"})
            with open(p, encoding="utf-8") as f:
                return self._json(200, json.load(f))
        super().do_GET()

    def do_DELETE(self):
        if not self.path.startswith("/api/scenes/"):
            return self._json(404, {"error": "not found"})
        p = self._path()
        if not p:
            return self._json(400, {"error": "bad name"})
        if os.path.basename(p)[:-5] in PROTECTED:
            return self._json(403, {"error": "built-in scene"})
        if not os.path.isfile(p):
            return self._json(404, {"error": "not found"})
        os.remove(p)
        self._json(200, {"ok": True})

    def do_PUT(self):
        if not self.path.startswith("/api/scenes/"):
            return self._json(404, {"error": "not found"})
        p = self._path()
        n = int(self.headers.get("Content-Length") or 0)
        if not p or n > MAX_BODY:
            return self._json(400, {"error": "bad name or body too large"})
        try:
            data = json.loads(self.rfile.read(n))
            if not isinstance(data, dict) or not isinstance(data.get("objects"), list):
                raise ValueError
        except ValueError:
            return self._json(400, {"error": "not a scene"})
        os.makedirs(SCENES, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        self._json(200, {"ok": True})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8000))
    host = os.environ.get("HOST", "127.0.0.1")
    print(f"http://{host}:{port}  (Ctrl+C 結束)")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
