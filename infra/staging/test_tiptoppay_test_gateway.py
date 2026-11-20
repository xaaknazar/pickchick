import importlib.util
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


g = load('tiptoppay_test_gateway', 'tiptoppay-test-gateway.py')
k = load('kaspi_checkout_gateway', 'release-kaspi-checkout.py')
BASE = '\theader {\n\t\tnot path /v1/auth/*\n\t}\n\t@health {\n\t}\n'


class Gateway(unittest.TestCase):
    def test_adds_only_test_routes_once(self):
        installed = k.extend_checkout(BASE)
        out = g.extend(installed)
        self.assertIn("path('/v1/customer-checkout/test-payments-setup')", out)
        self.assertIn('[a-f0-9-]{36}$', out)
        self.assertIn('/v1/integrations/tiptoppay/test-check', out)
        self.assertNotIn("tiptoppay/check'", out)
        self.assertNotIn("tiptoppay/pay'", out)
        self.assertEqual(out.count('\t@health {'), 1)
        with self.assertRaises(SystemExit):
            g.extend(out)

    def test_refuses_unknown_baseline(self):
        with self.assertRaises(SystemExit):
            g.extend(BASE)


if __name__ == '__main__':
    unittest.main()
