"""The outer nip.io site must let the menu availability long-poll finish (owner 01.11.2026).

The API holds an unchanged availability answer for 20 s (`GET /v1/customer-checkout/availability
?after=<signature>`). Under the site's default 8 s `response_header_timeout` every wait ended in a
504 from the outer Caddy, and builds 23-32 showed «Нет связи с сервером» while the phone was online.
"""

from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
FRONT = ROOT / 'infra/public-staging/front-site.Caddyfile'
DOMAINS = ROOT / 'infra/domains/pickchick.Caddyfile'
SERVER_HOLD_S = 20


def seconds(value):
    return int(re.fullmatch(r'(\d+)s', value).group(1))


def block(text, opener):
    start = text.index(opener)
    depth = 0
    for index in range(start, len(text)):
        if text[index] == '{':
            depth += 1
        elif text[index] == '}':
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    raise AssertionError('unbalanced ' + opener)


class FrontSiteLongPollTest(unittest.TestCase):
    def test_availability_long_poll_outlives_the_server_hold(self):
        text = FRONT.read_text()
        matcher = block(text, '@availability_watch {')
        self.assertIn('method GET', matcher)
        self.assertRegex(matcher, r'path /v1/customer-checkout/availability\n')
        route = block(text, 'handle @availability_watch {')
        timeout = re.search(r'response_header_timeout (\d+s)', route).group(1)
        self.assertGreaterEqual(seconds(timeout), SERVER_HOLD_S + 10)
        self.assertLess(text.index('handle @availability_watch {'), text.index('\thandle {'))

    def test_other_routes_keep_the_short_default(self):
        default = block(FRONT.read_text(), '\thandle {')
        self.assertIn('response_header_timeout 8s', default)

    def test_same_wait_as_the_domain_site(self):
        domain = re.findall(r'response_header_timeout (\d+s)', DOMAINS.read_text())
        route = block(FRONT.read_text(), 'handle @availability_watch {')
        self.assertIn(re.search(r'response_header_timeout (\d+s)', route).group(1), domain)


if __name__ == '__main__':
    unittest.main()
