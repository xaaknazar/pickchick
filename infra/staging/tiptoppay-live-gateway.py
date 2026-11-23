#!/usr/bin/env python3
"""Public gateway routes of the TipTopPay LIVE checkout (owner 23.11.2026).

Reads the installed gateway Caddyfile (already extended by tiptoppay-test-gateway.py) on stdin
and prints the candidate on stdout. Adds only: GET payments-setup and POST
orders/<uuid>/tiptoppay to the reviewed @customer_checkout allowlist, and the live TipTopPay
pages/notifications (3ds, 3ds-return, check, pay, fail). Refuses an unknown baseline or a
second run. The domain front (infra/domains, ingress) still answers 503 for these paths until
its own block is changed in the same window (see docs/operations/tiptoppay-live-1123.md).
"""
import sys

ANCHOR = " || (method('GET') && path('/v1/customer-checkout/test-payments-setup'))"
ADDED = (" || (method('GET') && path('/v1/customer-checkout/payments-setup'))"
         " || (method('POST') && path_regexp('^/v1/customer-checkout/orders/[a-f0-9-]{36}/tiptoppay$'))")
TEST_BLOCK = '\t@tiptoppay_test {'
BLOCK = '''\t@tiptoppay_live {
\t\texpression `(method('GET') && path('/v1/integrations/tiptoppay/3ds')) || (method('POST') && path('/v1/integrations/tiptoppay/3ds-return', '/v1/integrations/tiptoppay/check', '/v1/integrations/tiptoppay/pay', '/v1/integrations/tiptoppay/fail'))`
\t}
\thandle @tiptoppay_live {
\t\theader Cache-Control no-store
\t\treverse_proxy pickchick-staging-api-1:3100 {
\t\t\theader_up -Cookie
\t\t\theader_up -X-Device-Id
\t\t\theader_up X-Forwarded-For {client_ip}
\t\t\ttransport http {
\t\t\t\tdial_timeout 2s
\t\t\t\tresponse_header_timeout 25s
\t\t\t}
\t\t}
\t}
'''
HEADER = 'not path /v1/customer-checkout/* /v1/integrations/tiptoppay/test-* '


def require(ok, message):
    if not ok:
        raise SystemExit(message)


def extend(text):
    require('@tiptoppay_live' not in text and 'payments-setup\'))' + " || (method('POST') && path_regexp('^/v1/customer-checkout/orders/" not in text, 'Already applied')
    require(text.count(ANCHOR) == 1 and text.count(TEST_BLOCK) == 1, 'TEST gateway baseline differs')
    require(text.count(HEADER) == 1, 'Data header baseline differs')
    text = text.replace(ANCHOR, ANCHOR + ADDED, 1)
    text = text.replace(HEADER, HEADER + '/v1/integrations/tiptoppay/* ', 1)
    return text.replace(TEST_BLOCK, BLOCK + TEST_BLOCK, 1)


if __name__ == '__main__':
    sys.stdout.write(extend(sys.stdin.read()))
