"""Temporary LAN delivery of explicitly selected, verified public installers only."""

import argparse
import hashlib
import html
import ipaddress
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote


def load_installers(manifest):
    manifest = Path(manifest).resolve(strict=True)
    entries = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(entries, list) or not 1 <= len(entries) <= 8:
        raise ValueError("Expected one to eight installation files")
    files = {}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"file", "label", "sha256"}:
            raise ValueError("Invalid installer entry")
        name = entry["file"]
        if not isinstance(name, str) or not name.isascii() or not name.endswith((".exe", ".zip")):
            raise ValueError("Installation file must have an ASCII .exe or .zip filename")
        if Path(name).name != name or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_." for c in name):
            raise ValueError("Invalid filename")
        path = manifest.parent / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("Expected regular installer file")
        label = entry["label"]
        if not isinstance(label, str) or not 1 <= len(label) <= 100:
            raise ValueError("Invalid label")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != entry["sha256"] or "/" + name in files:
            raise ValueError("Installer hash mismatch or duplicate")
        # Keep the verified bytes. A later replacement on disk cannot change this release.
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != digest:
            raise ValueError("Installer changed during verification")
        files["/" + name] = {"label": label, "sha256": digest, "content": content}
    return files


def make_server(address, allowed_clients, files):
    allowed = {str(ipaddress.ip_address(value)) for value in allowed_clients}
    cards = "".join(
        '<section><h2>' + html.escape(item["label"]) + '</h2><a href="' + quote(path) +
        '">Скачать установочный файл</a><p>' + html.escape(path[1:]) +
        '</p><small>SHA-256: ' + item["sha256"] + '</small></section>'
        for path, item in files.items()
    )
    page = ('''<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PickChick - установка рабочих мест</title>
<style>body{font:18px system-ui;background:#edf3fc;color:#102650;max-width:850px;margin:40px auto;padding:24px}h1{color:#0047bb}section{background:white;border-radius:20px;padding:24px;margin:20px 0}a{display:inline-block;background:#0047bb;color:white;padding:18px 24px;border-radius:12px;text-decoration:none}small{overflow-wrap:anywhere}p{line-height:1.5}</style>
<h1>PickChick</h1><p>Файлы для установки кассы, кухни и локального сервера на Windows.</p>''' + cards + '''
<p>Клиенты PickChick - предпусковые. Для работы нужен настроенный локальный сервер и отдельный доступ сотрудника. Банк и ККМ ещё не подключены.</p>
<p>Архивы ZIP используются при настройке сервера по инструкции. После установки клиента откройте ярлык PickChick на рабочем столе. Если Windows блокирует неподписанный установщик, сохраните текст сообщения для проверки; системную защиту отключать не нужно.</p>
</html>''').encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            # Do not log arbitrary URLs, headers or credentials.
            pass

        def do_GET(self):
            self.send_file(False)

        def do_HEAD(self):
            self.send_file(True)

        def send_file(self, head):
            expected_host = f"{self.server.server_address[0]}:{self.server.server_address[1]}"
            if (self.client_address[0] not in allowed or self.headers.get("Host") != expected_host
                    or self.headers.get("Sec-Fetch-Site") == "cross-site"):
                self.send_error(403)
                return
            if self.path == "/":
                body, mime, name = page, "text/html; charset=utf-8", None
            elif self.path in files:
                body, mime, name = files[self.path]["content"], "application/octet-stream", self.path[1:]
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            if name:
                self.send_header("Content-Disposition", f'attachment; filename="{name}"')
            self.end_headers()
            if not head:
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

    return ThreadingHTTPServer(address, Handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--bind", required=True)
    parser.add_argument("--allow", action="append", required=True)
    parser.add_argument("--port", type=int, default=48175)
    args = parser.parse_args()
    bind = ipaddress.ip_address(args.bind)
    if bind.version != 4 or bind.is_unspecified or not bind.is_private or not 1024 <= args.port <= 65535:
        parser.error("Use an explicit private IPv4 address and unprivileged port")
    with make_server((str(bind), args.port), args.allow, load_installers(args.manifest)) as server:
        print(f"PickChick installers: http://{bind}:{args.port}/", flush=True)
        server.serve_forever()
