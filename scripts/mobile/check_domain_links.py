#!/usr/bin/env python3
"""Read-only release gate before an App Store build on the owned domain (build 33).

Owner 30.10.2026: «переводи на наш домен». The app compiles https://api.pickchick.kz in the
`production` profile, but two links are not in the app: the sign-in consent and profile
«Документы» open whatever the server sends in terms_url / privacy_url (server env
CUSTOMER_AUTH_TERMS_URL / CUSTOMER_AUTH_PRIVACY_URL; the checkout legal block uses the same
pair), and App Store Connect has its own Support URL and Privacy Policy URL fields.

The review notes 33, the Resolution Center reply and metadata.json say the sign-in code comes
in Telegram only. The server decides that too: with its WhatsApp fallback on, the sign-in
screen promises «Telegram или WhatsApp» (AuthScreens.tsx), so the gate checks
/v1/auth/config for it.

Only GET requests, without a body, cookies or credentials. Nothing is changed anywhere. Every
redirect hop is checked, not only the last URL: each must stay on https and on the domain. A
redirect to the staging host is not followed at all, so that host never gets a request from
this script. Exit 0 only when the API answers on the
domain, sign-in sends the code in Telegram only, the server's document links and the given App
Store Connect URLs are on pickchick.kz (never the staging nip.io host or its IP) and every page
opens without passing through another host.

    python3 scripts/mobile/check_domain_links.py \\
        --support-url https://pickchick.kz/support/ --support-url https://pickchick.kz/support/en.html \\
        --privacy-policy-url https://pickchick.kz/legal/privacy

Each App Store Connect flag can repeat (one value per localization: RU, en-GB).
"""

import argparse
import json
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

DEFAULT_API = "https://api.pickchick.kz"
DEFAULT_SITE = "https://pickchick.kz"
SITE_PAGES = ("/legal/terms", "/legal/privacy", "/support/")
STAGING_IP = "185.129.51.103"
MAX_BODY = 256 * 1024


def staging(host):
    return host.endswith("nip.io") or STAGING_IP in host


def base_url(value):
    parts = urlsplit(value)
    if (parts.scheme != "https" or not parts.hostname or parts.username or parts.password
            or parts.query or parts.fragment or parts.path not in ("", "/")):
        raise ValueError(f"Use a bare https origin, got {value!r}")
    return f"https://{parts.netloc}"


class RecordHops(urllib.request.HTTPRedirectHandler):
    """Records every redirect target in order; never follows one to the staging host."""

    def __init__(self):
        super().__init__()
        self.hops = []

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.hops.append(newurl)
        if staging(urlsplit(newurl).hostname or ""):
            return None  # urllib then answers with the 3xx itself; nip.io gets no request
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def http_fetch(url, timeout=15):
    """One GET; returns (status, final URL, first bytes of the body, every redirect target)."""
    request = urllib.request.Request(url, method="GET", headers={
        "Accept": "application/json, text/html;q=0.9", "User-Agent": "PickChick-release-preflight"})
    hops = RecordHops()
    try:
        with urllib.request.build_opener(hops).open(request, timeout=timeout) as response:
            return response.status, response.geturl(), response.read(MAX_BODY), hops.hops
    except urllib.error.HTTPError as error:
        return error.code, error.geturl() or url, b"", hops.hops


def telegram_only(config):
    """Why sign-in would not send the code in Telegram only, as the review texts say; else None.

    The server sends channels without WhatsApp, channel_selection "automatic" when Telegram is
    on and whatsapp_fallback_enabled when a Telegram miss falls back to WhatsApp.
    """
    if config.get("whatsapp_fallback_enabled") is True:
        return ("WhatsApp fallback is on: the sign-in screen says «Telegram или WhatsApp», but the "
                "review notes 33, the reply and metadata.json say Telegram only; turn the fallback "
                "off or change those texts first")
    channels = config.get("channels")
    if not isinstance(channels, list) or "telegram" not in channels:
        return f"no Telegram channel (channels {channels!r}): the app cannot request the code"
    return None


def run_checks(api, site, fetch=None, store_urls=()):
    """Every check as {check, url, ok, reason}; store_urls are (App Store Connect field, value)."""
    fetch = fetch or http_fetch
    site_host = urlsplit(site).hostname
    results = []

    def owned(host):
        return host == site_host or host.endswith("." + site_host)

    def record(check, url, reason=None):
        results.append({"check": check, "url": url, "ok": reason is None,
                        **({"reason": reason} if reason else {})})

    def bad_hop(url, hops):
        """The first redirect that leaves https, the domain or reaches the staging host."""
        start_host = urlsplit(url).hostname or ""
        targets = [urlsplit(hop) for hop in hops]
        for parts in targets:
            if staging(parts.hostname or ""):
                return f"redirects to the staging host {parts.hostname}"
        for parts in targets:
            if parts.scheme != "https":
                return f"redirects to plain {parts.scheme or 'relative'} {parts.geturl()}"
        for parts in targets:
            host = parts.hostname or ""
            if host != start_host and not owned(host):
                return f"redirects off {site_host} to {host}"
        return None

    def get(check, url, expect_json=False):
        try:
            status, final, body, *rest = fetch(url)
        except Exception as error:  # noqa: BLE001 - every network failure fails the gate
            record(check, url, f"no answer: {type(error).__name__}")
            return None
        # Every hop counts: a pickchick.kz link through nip.io back to pickchick.kz still fails.
        hop = bad_hop(url, [*(rest[0] if rest else ()), final])
        if hop:
            record(check, url, hop)
        elif status != 200:
            record(check, url, f"HTTP {status}")
        elif expect_json:
            try:
                value = json.loads(body)
            except ValueError:
                record(check, url, "not JSON")
                return None
            if not isinstance(value, dict):
                record(check, url, "not a JSON object")
                return None
            record(check, url)
            return value
        else:
            record(check, url)
        return None

    def owned_link(check, value):
        if not isinstance(value, str) or not value:
            record(check, str(value), "missing")
            return
        parts = urlsplit(value)
        host = parts.hostname or ""
        if parts.scheme != "https":
            record(check, value, "not https")
        elif staging(host):
            record(check, value, "on the staging host; move it to pickchick.kz")
        elif not owned(host):
            record(check, value, f"not on {site_host}")
        else:
            get(check, value)

    get("api health", f"{api}/health/live")
    get("api checkout availability", f"{api}/v1/customer-checkout/availability", expect_json=True)
    config = get("api sign-in config", f"{api}/v1/auth/config", expect_json=True)
    if config is not None:
        if config.get("enabled") is not True:
            record("sign-in enabled", f"{api}/v1/auth/config", "customer sign-in is disabled")
        else:
            # Review notes 33 / reply / metadata.json: «Regular customers receive their code in
            # Telegram». The WhatsApp fallback would make that false on the sign-in screen.
            record("sign-in code in Telegram only", f"{api}/v1/auth/config", telegram_only(config))
        # CUSTOMER_AUTH_TERMS_URL / CUSTOMER_AUTH_PRIVACY_URL: consent, profile, checkout.
        owned_link("server terms_url", config.get("terms_url"))
        owned_link("server privacy_url", config.get("privacy_url"))
    for path in SITE_PAGES:
        get(f"site {path}", f"{site}{path}")
    for field, value in store_urls:
        owned_link(f"App Store Connect {field}", value)
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--site", default=DEFAULT_SITE)
    parser.add_argument("--support-url", action="append", default=[],
                        help="App Store Connect Support URL as entered; repeat per localization")
    parser.add_argument("--privacy-policy-url", action="append", default=[],
                        help="App Store Connect Privacy Policy URL as entered; repeat per localization")
    args = parser.parse_args(argv)
    try:
        api, site = base_url(args.api), base_url(args.site)
    except ValueError as error:
        print(json.dumps({"message": "Stopped", "reason": str(error)}, ensure_ascii=False))
        return 2
    store = ([("Support URL", value) for value in args.support_url]
             + [("Privacy Policy URL", value) for value in args.privacy_policy_url])
    results = run_checks(api, site, store_urls=store)
    for row in results:
        print(json.dumps(row, ensure_ascii=False), flush=True)
    failed = [row for row in results if not row["ok"]]
    print(json.dumps({"message": "Domain gate " + ("FAIL" if failed else "PASS"),
                      "checks": len(results), "failed": len(failed),
                      "store_urls_checked": len(store)}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
