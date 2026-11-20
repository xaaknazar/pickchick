#!/usr/bin/env python3
"""Public gateway routes of the TipTopPay TEST checkout (owner 20.11.2026).

Reads the installed gateway Caddyfile on stdin and prints the candidate on stdout.
Adds only: GET test-payments-setup, POST test-payments, GET test-payments/<uuid> to the
reviewed @customer_checkout allowlist, and the sandbox TipTopPay pages/notifications
(test-3ds, test-3ds-return, test-check, test-pay, test-fail). Live /check and /pay stay
unrouted. Refuses an unknown baseline or a second run.
"""
import sys

CHECKOUT = "(method('POST') && path('/v1/customer-checkout/quotes', '/v1/customer-checkout/orders'))"
ADDED = (" || (method('GET') && path('/v1/customer-checkout/test-payments-setup'))"
         " || (method('POST') && path('/v1/customer-checkout/test-payments'))"
         " || (method('GET') && path_regexp('^/v1/customer-checkout/test-payments/[a-f0-9-]{36}$'))")
TEST_PATHS = ' '.join('/v1/integrations/tiptoppay/' + p for p in
                      ['test-3ds', 'test-3ds-return', 'test-check', 'test-pay', 'test-fail'])
BLOCK = '''\t@tiptoppay_test {
\t\texpression `(method('GET') && path('/v1/integrations/tiptoppay/test-3ds')) || (method('POST') && path('/v1/integrations/tiptoppay/test-3ds-return', '/v1/integrations/tiptoppay/test-check', '/v1/integrations/tiptoppay/test-pay', '/v1/integrations/tiptoppay/test-fail'))`
\t}
\thandle @tiptoppay_test {
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


def require(ok, message):
    if not ok:
        raise SystemExit(message)


def extend(text):
    require('@tiptoppay_test' not in text and 'test-payments' not in text, 'Already applied')
    require(text.count('\t@customer_checkout {') == 1 and text.count(CHECKOUT) == 1, 'Checkout baseline differs')
    require(text.count('not path /v1/customer-checkout/* ') == 1, 'Data header baseline differs')
    require(text.count('\t@health {') == 1, 'Health anchor differs')
    text = text.replace(CHECKOUT, CHECKOUT + ADDED, 1)
    text = text.replace('not path /v1/customer-checkout/* ',
                        'not path /v1/customer-checkout/* /v1/integrations/tiptoppay/test-* ', 1)
    return text.replace('\t@health {', BLOCK + '\n\t@health {', 1)


if __name__ == '__main__':
    sys.stdout.write(extend(sys.stdin.read()))
