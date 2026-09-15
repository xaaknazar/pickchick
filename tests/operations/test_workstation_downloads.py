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
            archive = b"PK-known-runtime-fixture"
            (root / "PickChick.exe").write_bytes(payload)
            (root / "edge.zip").write_bytes(archive)
            (root / "secret.json").write_text('"not for download"')
            entry = {"file": "PickChick.exe", "label": "Касса", "sha256": hashlib.sha256(payload).hexdigest()}
            archive_entry = {"file": "edge.zip", "label": "Локальный сервер", "sha256": hashlib.sha256(archive).hexdigest()}
            (root / "manifest.json").write_text(json.dumps([entry, archive_entry]))
            files = downloads.load_installers(root / "manifest.json")
            (root / "PickChick.exe").write_bytes(b"replaced after verification")
            (root / "edge.zip").write_bytes(b"archive replaced after verification")
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
                    self.assertEqual(get("/edge.zip"), (200, archive))
                    self.assertEqual(get("/")[0], 200)
                    for path in ["/secret.json", "/manifest.json", "/../secret.json", "/%2e%2e/secret.json", "/PickChick.exe?file=secret.json", "/edge.zip?file=secret.json", "/edge.zip/secret.json"]:
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
            for name in ["../leak.exe", "subdir/file.exe", "config.json", "a\\b.exe", "../leak.zip", "subdir/file.zip", "a\\b.zip", "config.env", "archive.zip.exe.json"]:
                path.write_text(json.dumps([{"file": name, "label": "x", "sha256": "0" * 64}]))
                with self.assertRaisesRegex(ValueError, "filename"):
                    downloads.load_installers(path)

    def test_up_to_eight_pinned_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = root / "manifest.json"
            entries = []
            for index in range(9):
                name = f"installer-{index}.{'exe' if index % 2 else 'zip'}"
                content = f"public installation file {index}".encode("ascii")
                (root / name).write_bytes(content)
                entries.append({"file": name, "label": name, "sha256": hashlib.sha256(content).hexdigest()})
            manifest.write_text(json.dumps(entries[:8]))
            self.assertEqual(len(downloads.load_installers(manifest)), 8)
            manifest.write_text(json.dumps(entries))
            with self.assertRaisesRegex(ValueError, "one to eight"):
                downloads.load_installers(manifest)
            manifest.write_text(json.dumps([entries[0], entries[0]]))
            with self.assertRaisesRegex(ValueError, "duplicate"):
                downloads.load_installers(manifest)
            manifest.write_text(json.dumps([dict(entries[0], sha256="0" * 64)]))
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                downloads.load_installers(manifest)


if __name__ == "__main__":
    unittest.main()
