"""Build 33 release gate: the server's document links and the App Store URLs on pickchick.kz."""

import contextlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request


spec = importlib.util.spec_from_file_location(
    "check_domain_links", Path(__file__).resolve().parents[2] / "scripts/mobile/check_domain_links.py"
)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

API = "https://api.pickchick.kz"
SITE = "https://pickchick.kz"
STAGING = "https://pickchick.185.129.51.103.nip.io"
# The shape packages/customer-identity config() sends with Telegram as the only channel.
CONFIG = {"enabled": True, "channels": ["telegram"], "channel_selection": "automatic",
          "delivery_consent_required": True, "consent_version": "2026-10-01",
          "terms_url": f"{SITE}/legal/terms", "privacy_url": f"{SITE}/legal/privacy"}


def fake(config=CONFIG, overrides=None):
    """Isolated answers by URL; nothing leaves the process. Records every URL asked."""
    pages = {f"{API}/health/live": (200, b'{"status":"ok"}'),
             f"{API}/v1/customer-checkout/availability": (200, b'{"available":true}'),
             f"{API}/v1/auth/config": (200, json.dumps(config).encode()),
             f"{SITE}/legal/terms": (200, b"<html>terms</html>"),
             f"{SITE}/legal/privacy": (200, b"<html>privacy</html>"),
             f"{SITE}/support/": (200, b"<html>support</html>")}
    pages.update(overrides or {})
    asked = []

    def fetch(url):
        asked.append(url)
        answer = pages.get(url, (404, b""))
        if isinstance(answer, Exception):
            raise answer
        # (status, body[, final URL[, redirect targets]]); without targets, as http_fetch, the
        # final URL is the only hop.
        status, body, *rest = answer
        final = rest[0] if rest else url
        return status, final, body, rest[1] if len(rest) > 1 else ([final] if final != url else [])

    return fetch, asked


def failures(results):
    return {row["check"]: row["reason"] for row in results if not row["ok"]}


class DomainGateTests(unittest.TestCase):
    def test_everything_on_the_domain_passes(self):
        fetch, asked = fake()
        results = gate.run_checks(API, SITE, fetch, [("Support URL", f"{SITE}/support/"),
                                                     ("Privacy Policy URL", f"{SITE}/legal/privacy")])
        self.assertEqual(failures(results), {})
        self.assertEqual(len(results), 11)
        self.assertIn("sign-in code in Telegram only", [row["check"] for row in results])
        self.assertTrue(all(url.startswith((API, SITE)) for url in asked), asked)

    def test_the_14_10_server_links_on_nip_io_fail_and_are_not_opened(self):
        # The audit of 14.10 recorded CUSTOMER_AUTH_TERMS_URL / _PRIVACY_URL on the staging host.
        fetch, asked = fake({**CONFIG, "terms_url": f"{STAGING}/legal/terms",
                             "privacy_url": "https://185.129.51.103/legal/privacy"})
        found = failures(gate.run_checks(API, SITE, fetch))
        self.assertIn("staging host", found["server terms_url"])
        self.assertIn("staging host", found["server privacy_url"])
        self.assertEqual(set(found), {"server terms_url", "server privacy_url"})
        self.assertFalse([url for url in asked if "nip.io" in url or "185.129" in url])

    def test_app_store_connect_fields_must_be_on_the_domain(self):
        fetch, _ = fake()
        found = failures(gate.run_checks(API, SITE, fetch, [
            ("Support URL", f"{STAGING}/support/"),
            ("Privacy Policy URL", "https://example.com/privacy")]))
        self.assertIn("staging host", found["App Store Connect Support URL"])
        self.assertIn("not on pickchick.kz", found["App Store Connect Privacy Policy URL"])
        found = failures(gate.run_checks(API, SITE, fetch, [("Support URL", "http://pickchick.kz/support/")]))
        self.assertEqual(found, {"App Store Connect Support URL": "not https"})

    def test_missing_pages_redirects_to_staging_and_a_silent_api_fail(self):
        fetch, _ = fake(overrides={
            f"{SITE}/support/": (404, b""),
            f"{SITE}/legal/terms": (200, b"<html/>", f"{STAGING}/legal/terms"),
            f"{API}/health/live": urllib.error.URLError("timed out"),
            f"{API}/v1/customer-checkout/availability": (200, b"<html>gateway</html>")})
        found = failures(gate.run_checks(API, SITE, fetch))
        self.assertEqual(found["site /support/"], "HTTP 404")
        self.assertIn("redirects to the staging host", found["site /legal/terms"])
        self.assertIn("redirects to the staging host", found["server terms_url"])
        self.assertEqual(found["api health"], "no answer: URLError")
        self.assertEqual(found["api checkout availability"], "not JSON")

    def test_sign_in_disabled_or_without_links_fails(self):
        fetch, _ = fake({"enabled": False, "consent_version": None, "terms_url": None,
                         "privacy_url": None})
        found = failures(gate.run_checks(API, SITE, fetch))
        self.assertEqual(found, {"sign-in enabled": "customer sign-in is disabled",
                                 "server terms_url": "missing", "server privacy_url": "missing"})

    def test_whatsapp_fallback_makes_the_telegram_only_texts_false(self):
        # Review notes 33, the reply and metadata.json say «code in Telegram». With the fallback
        # on, AuthScreens.tsx says «Telegram или WhatsApp» on the sign-in screen App Review sees.
        server = {**CONFIG, "whatsapp_fallback_enabled": True}
        fetch, _ = fake(server)
        found = failures(gate.run_checks(API, SITE, fetch))
        self.assertEqual(set(found), {"sign-in code in Telegram only"})
        self.assertIn("WhatsApp fallback is on", found["sign-in code in Telegram only"])
        self.assertIn("review notes 33", found["sign-in code in Telegram only"])
        fetch, _ = fake(server)
        out = io.StringIO()
        with patch.object(gate, "http_fetch", fetch), contextlib.redirect_stdout(out):
            self.assertEqual(gate.main(["--support-url", f"{SITE}/support/"]), 1)
        self.assertIn('"Domain gate FAIL"', out.getvalue())
        # Explicitly off, or SMS next to Telegram (the app asks "auto" = Telegram first): passes.
        for config in ({**CONFIG, "whatsapp_fallback_enabled": False},
                       {**CONFIG, "channels": ["sms", "telegram"]}):
            fetch, _ = fake(config)
            self.assertEqual(failures(gate.run_checks(API, SITE, fetch)), {}, config)
        # Without Telegram the app has no channel to request the code at all.
        for channels in (["sms"], None):
            config = {key: value for key, value in CONFIG.items() if key != "channel_selection"}
            config["channels"] = channels
            fetch, _ = fake(config)
            found = failures(gate.run_checks(API, SITE, fetch))
            self.assertEqual(set(found), {"sign-in code in Telegram only"}, channels)
            self.assertIn("no Telegram channel", found["sign-in code in Telegram only"])

    def test_every_redirect_hop_counts_not_only_the_last_url(self):
        # pickchick.kz -> nip.io -> pickchick.kz used to pass on the final host alone.
        fetch, _ = fake(overrides={
            f"{SITE}/legal/privacy": (200, b"<html/>", f"{SITE}/legal/privacy",
                                      [f"{STAGING}/legal/privacy", f"{SITE}/legal/privacy"]),
            f"{SITE}/support/": (200, b"<html/>", f"{SITE}/support/",
                                 ["http://pickchick.kz/support/", f"{SITE}/support/"]),
            f"{API}/health/live": (200, b"{}", f"{API}/health/live",
                                   ["https://example.com/health", f"{API}/health/live"]),
            # Within the domain (a trailing slash, the API subdomain) is fine.
            f"{SITE}/legal/terms": (200, b"<html/>", f"{SITE}/legal/terms/",
                                    [f"{SITE}/legal/terms/"])})
        found = failures(gate.run_checks(API, SITE, fetch))
        self.assertEqual(found["site /legal/privacy"], "redirects to the staging host "
                         "pickchick.185.129.51.103.nip.io")
        self.assertEqual(found["server privacy_url"], found["site /legal/privacy"])
        self.assertEqual(found["site /support/"], "redirects to plain http http://pickchick.kz/support/")
        self.assertEqual(found["api health"], "redirects off pickchick.kz to example.com")
        self.assertNotIn("site /legal/terms", found)
        self.assertNotIn("server terms_url", found)
        # A redirect refused before nip.io (http_fetch answers with the 3xx) fails the same way.
        fetch, _ = fake(overrides={f"{SITE}/legal/terms": (302, b"", f"{SITE}/legal/terms",
                                                           [f"{STAGING}/legal/terms"])})
        found = failures(gate.run_checks(API, SITE, fetch))
        self.assertIn("redirects to the staging host", found["site /legal/terms"])

    def test_cli_exit_codes_and_bare_https_origins(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(gate.main(["--api", "http://api.pickchick.kz"]), 2)
            self.assertEqual(gate.main(["--site", "https://pickchick.kz/legal"]), 2)
        fetch, _ = fake()
        with patch.object(gate, "http_fetch", fetch), contextlib.redirect_stdout(out):
            self.assertEqual(gate.main(["--support-url", f"{SITE}/support/"]), 0)
        self.assertIn('"Domain gate PASS"', out.getvalue())
        # One value per App Store localization (RU /support/, en-GB /support/en.html).
        fetch, asked = fake(overrides={f"{SITE}/support/en.html": (200, b"<html>en</html>")})
        both = ["--support-url", f"{SITE}/support/", "--support-url", f"{SITE}/support/en.html",
                "--privacy-policy-url", f"{SITE}/legal/privacy"]
        out = io.StringIO()
        with patch.object(gate, "http_fetch", fetch), contextlib.redirect_stdout(out):
            self.assertEqual(gate.main(both), 0)
        summary = json.loads(out.getvalue().splitlines()[-1])
        self.assertEqual((summary["message"], summary["store_urls_checked"]), ("Domain gate PASS", 3))
        self.assertIn(f"{SITE}/support/en.html", asked)
        fetch, _ = fake()
        out = io.StringIO()
        with patch.object(gate, "http_fetch", fetch), contextlib.redirect_stdout(out):
            self.assertEqual(gate.main(["--support-url", f"{SITE}/support/",
                                        "--support-url", f"{STAGING}/support/en.html"]), 1)
        rows = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual([row["url"] for row in rows if not row.get("ok", True)],
                         [f"{STAGING}/support/en.html"])
        fetch, _ = fake({**CONFIG, "terms_url": f"{STAGING}/legal/terms"})
        out = io.StringIO()
        with patch.object(gate, "http_fetch", fetch), contextlib.redirect_stdout(out):
            self.assertEqual(gate.main([]), 1)
        summary = json.loads(out.getvalue().splitlines()[-1])
        self.assertEqual((summary["message"], summary["failed"], summary["store_urls_checked"]),
                         ("Domain gate FAIL", 1, 0))

    def test_http_fetch_sends_only_a_plain_get(self):
        seen = []

        redirects = {"/two": "/hop", "/hop": "/ok",
                     "/to-staging": f"{STAGING}/legal/terms",
                     "/to-staging-ip": "https://185.129.51.103/legal/privacy"}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                seen.append((self.command, self.headers.get("Cookie"),
                             self.headers.get("Authorization"), self.headers.get("Content-Length")))
                if self.path in redirects:
                    self.send_response(302)
                    self.send_header("Location", redirects[self.path])
                    self.end_headers()
                    return
                self.send_response(404 if self.path == "/missing" else 200)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *_):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        refuse = AssertionError("an https request left the process")
        try:
            # Only the loopback fixture answers; any https request (the staging host) would raise.
            with patch.dict(os.environ, {"no_proxy": "127.0.0.1", "NO_PROXY": "127.0.0.1"}), \
                    patch.object(urllib.request.HTTPSHandler, "https_open", side_effect=refuse):
                self.assertEqual(gate.http_fetch(f"{base}/ok", timeout=5),
                                 (200, f"{base}/ok", b"{}", []))
                self.assertEqual(gate.http_fetch(f"{base}/missing", timeout=5)[0], 404)
                self.assertEqual(gate.http_fetch(f"{base}/two", timeout=5),
                                 (200, f"{base}/ok", b"{}", [f"{base}/hop", f"{base}/ok"]))
                # The staging hop is recorded and not followed: the 302 itself comes back.
                self.assertEqual(gate.http_fetch(f"{base}/to-staging", timeout=5),
                                 (302, f"{base}/to-staging", b"", [f"{STAGING}/legal/terms"]))
                self.assertEqual(gate.http_fetch(f"{base}/to-staging-ip", timeout=5)[::3],
                                 (302, ["https://185.129.51.103/legal/privacy"]))
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(seen, [("GET", None, None, None)] * 7)


if __name__ == "__main__":
    unittest.main()
