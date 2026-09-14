import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location("downloads", Path(__file__).resolve().parents[2] / "scripts/workstation-downloads.py")
downloads = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloads)


class DownloadsTest(unittest.TestCase):
    def test_only_verified_installer_is_served(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            payload = b"MZ-known-installer-fixture"
            (root / "PickChick.exe").write_bytes(payload)
            (root / "secret.json").write_text('"not for download"')
            entry = {"file": "PickChick.exe", "label": "Касса", "sha256": hashlib.sha256(payload).hexdigest()}
            (root / "manifest.json").write_text(json.dumps([entry]))
            files = downloads.load_installers(root / "manifest.json")
            (root / "PickChick.exe").write_bytes(b"replaced after verification")
            with downloads.make_server(("127.0.0.1", 0), ["127.0.0.1"], files) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    def get(path, headers=None):
                        client = http.client.HTTPConnection(*server.server_address)
                        client.request("GET", path, headers=headers or {})
                        response = client.getresponse()
                        result = response.status, response.read()
                        client.close()
                        return result
                    self.assertEqual(get("/PickChick.exe"), (200, payload))
                    self.assertEqual(get("/")[0], 200)
                    for path in ["/secret.json", "/manifest.json", "/../secret.json", "/%2e%2e/secret.json", "/PickChick.exe?file=secret.json"]:
                        self.assertEqual(get(path)[0], 404)
                    self.assertEqual(get("/", {"Host": "untrusted.invalid"})[0], 403)
                    self.assertEqual(get("/", {"Sec-Fetch-Site": "cross-site"})[0], 403)
                finally:
                    server.shutdown()
                    thread.join()
            with self.assertRaises(ValueError):
                downloads.load_installers(root / "manifest.json")

    def test_clients_and_paths_are_restricted(self):
        with downloads.make_server(("127.0.0.1", 0), ["192.0.2.1"], {}) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                client = http.client.HTTPConnection(*server.server_address)
                client.request("GET", "/")
                response = client.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                client.close()
            finally:
                server.shutdown()
                thread.join()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "manifest.json"
            for name in ["../leak.exe", "subdir/file.exe", "config.json", "a\\b.exe"]:
                path.write_text(json.dumps([{"file": name, "label": "x", "sha256": "0" * 64}]))
                with self.assertRaises(ValueError):
                    downloads.load_installers(path)


if __name__ == "__main__":
    unittest.main()
