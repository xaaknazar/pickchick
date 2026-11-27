import importlib.util
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


live = load('tiptoppay_live_gateway', 'tiptoppay-live-gateway.py')
test = load('tiptoppay_test_gateway', 'tiptoppay-test-gateway.py')
k = load('kaspi_checkout_gateway', 'release-kaspi-checkout.py')
BASE = '\theader {\n\t\tnot path /v1/auth/*\n\t}\n\t@health {\n\t}\n'


class Gateway(unittest.TestCase):
    def test_adds_only_live_routes_once_after_the_test_gateway(self):
        installed = test.extend(k.extend_checkout(BASE))
        out = live.extend(installed)
        self.assertIn("path('/v1/customer-checkout/payments-setup')", out)
        self.assertIn('/v1/customer-checkout/orders/[a-f0-9-]{36}/tiptoppay$', out)
        for path in ['3ds', '3ds-return', 'check', 'pay', 'fail']:
            self.assertIn(f"'/v1/integrations/tiptoppay/{path}'", out)
        self.assertEqual(out.count('\t@health {'), 1)
        self.assertEqual(out.count('\t@tiptoppay_test {'), 1)
        self.assertTrue(out.index('@tiptoppay_live') < out.index('@tiptoppay_test'))
        with self.assertRaises(SystemExit):
            live.extend(out)

    def test_accepts_other_paths_before_checkout_in_the_header(self):
        installed = test.extend(k.extend_checkout(BASE))
        moved = installed.replace(
            'not path /v1/customer-checkout/*',
            'not path /v1/customer-farm /v1/admin/backoffice/* /v1/customer-checkout/*',
            1,
        )
        self.assertNotEqual(moved, installed)
        out = live.extend(moved)
        self.assertIn('/v1/integrations/tiptoppay/test-* /v1/integrations/tiptoppay/* ', out)

    def test_refuses_a_gateway_without_the_test_routes(self):
        with self.assertRaises(SystemExit):
            live.extend(k.extend_checkout(BASE))


if __name__ == '__main__':
    unittest.main()
