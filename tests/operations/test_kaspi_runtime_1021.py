import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('invoice_runtime_1021', ROOT/'infra/staging/release-kaspi-runtime-1021.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)


class InvoiceRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.raw = (ROOT/'infra/payments/kaspi-bridge/worker.compose.yaml').read_text()

    def test_installed_compose_is_exact_and_only_image_changes(self):
        baseline = r.worker_candidate(self.raw, r.BASE_SHA)
        candidate = r.worker_candidate(self.raw, 'b'*40)
        self.assertEqual(candidate.replace('pickchick-api:'+'b'*40, 'pickchick-api:'+r.BASE_SHA), baseline)
        self.assertNotIn('${', candidate)
        self.assertIn('network_mode: container:pickchick-kaspi-bridge', candidate)
        self.assertIn("KASPI_INVOICE_TTL_SECONDS: '180'", candidate)

    def test_changed_security_or_credentials_are_refused(self):
        for before, after in [('read_only: true', 'read_only: false'),
                              ('/session.env:ro', '/session.env:rw'),
                              ('0.5', '2.0')]:
            with self.assertRaises(r.GuardFailure):
                r.worker_candidate(self.raw.replace(before, after), 'b'*40)

    def test_invalid_source_is_refused(self):
        with self.assertRaises(r.GuardFailure):
            r.worker_candidate(self.raw, 'latest')

    def test_rollback_uses_original_environment_only(self):
        release = object.__new__(r.Release)
        self.assertIn('--env-file', release.compose(r.BASE_COMPOSE))
        self.assertNotIn('--env-file', release.compose('/candidate/worker.yaml'))

    def test_all_unsettled_and_pending_invoices_block_switch(self):
        release = object.__new__(r.Release)
        queries = []
        release.psql = lambda db, sql: queries.append(sql) or '3'
        self.assertEqual(release.issuing(), 3)
        for state in ('issuing', 'issued', 'unknown', 'payment.submit_requested', "a.state='pending'"):
            self.assertIn(state, queries[0])


if __name__ == '__main__':
    unittest.main()
