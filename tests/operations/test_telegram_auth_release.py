import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('telegram_auth_release', ROOT/'infra/staging/release-telegram-auth.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)

class TelegramActivationGuards(unittest.TestCase):
    def test_activation_keeps_existing_routes_and_excludes_identity_from_synthetic_header(self):
        baseline = (ROOT/'infra/public-staging/gateway.Caddyfile').read_text()
        start = baseline.index('\t@synthetic_surfaces {')
        end = baseline.index('\n\t}', start)
        baseline = baseline[:start] + '\t@synthetic_surfaces {\n\t\tnot path /v1/customer-checkout/* /v1/catalog/* /v1/admin/catalog/* /backoffice /backoffice/*' + baseline[end:]
        result = r.gateway_candidate(baseline, '172.18.0.4')
        self.assertIn('/backoffice/* /v1/auth/* /v1/customers/* /legal/*', result)
        self.assertIn('handle @pilot_auth {\n\t\theader Cache-Control no-store', result)
        self.assertEqual(baseline[baseline.index('\t@health {'):], result[result.index('\t@health {'):])
        with self.assertRaises(r.market.GuardFailure): r.gateway_candidate(result, '172.18.0.4')
        with self.assertRaises(r.market.GuardFailure): r.gateway_candidate(baseline.replace('/v1/customer-checkout/*','/unknown/*'), '172.18.0.4')

    def test_schema_and_table_contents_cannot_change(self):
        release = object.__new__(r.Release)
        data = {'tables': {'identity_customers': {'rows': 0, 'sha256':'empty'}}, 'sequences': []}
        release.ledger = lambda: ['027']
        release.snapshot = lambda: data
        release.acl = lambda: []
        from unittest.mock import patch
        with patch.object(r, 'verify_identity_acl'):
            release.verify_data({'ledger':['027'], 'data':data, 'acl':[]})
            with self.assertRaises(r.market.GuardFailure):
                release.verify_data({'ledger':['026'], 'data':data, 'acl':[]})
            with self.assertRaises(r.market.GuardFailure):
                release.verify_data({'ledger':['027'], 'data':{'tables':{},'sequences':[]}, 'acl':[]})

    def test_only_identity_grants_may_change(self):
        from unittest.mock import patch
        row = {'name':'commerce_orders','privilege':'UPDATE'}
        with patch.object(r.pilot, 'verify_acl'):
            r.verify_identity_acl([], [{'name':'identity_customers','privilege':'SELECT'}])
            with self.assertRaises(r.market.GuardFailure): r.verify_identity_acl([], [row])
            with self.assertRaises(r.market.GuardFailure): r.verify_identity_acl([row], [])

    def test_legal_draft_and_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            text = '<html>' + r.pilot.VERSION + 'x'*501 + '</html>'
            for name in ['terms','privacy']: (root/(name+'.html')).write_text(text)
            r.validate_legal(root)
            (root/'privacy.html').write_text(text+'[До публикации: заполнить]')
            with self.assertRaises(r.market.GuardFailure): r.validate_legal(root)
            (root/'privacy.html').unlink()
            (root/'privacy.html').symlink_to(root/'terms.html')
            with self.assertRaises(r.market.GuardFailure): r.validate_legal(root)

    def test_exact_baseline_only_and_no_migrations(self):
        args = SimpleNamespace(expected_api_sha='0'*40,expected_public_sha=r.PUBLIC_BASELINE,expected_gateway_sha256=r.GATEWAY_BASELINE)
        with self.assertRaises(r.market.GuardFailure): r.Release(args)
        self.assertEqual(len(list((ROOT/'db/cloud/migrations').glob('*.sql'))),27)
        self.assertIs(r.Release.snapshot, r.market.Release.snapshot)

if __name__ == '__main__': unittest.main()
