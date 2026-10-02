import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('commerce_feedback_release', ROOT/'infra/staging/release-commerce-feedback.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)

BASE_GATEWAY = '''\t@customer_checkout_preflight {
\t\tmethod OPTIONS
\t\tpath /v1/customer-checkout/*
\t}
\t@customer_checkout {
\t\texpression `(method('GET') && path('/v1/customer-checkout/config', '/v1/customer-checkout/orders', '/v1/customer-checkout/availability')) || (method('POST') && path('/v1/customer-checkout/quotes', '/v1/customer-checkout/orders')) || (method('GET') && path_regexp('^/v1/customer-checkout/orders/[a-f0-9-]{36}(/watch)?$')) || (method('POST') && path_regexp('^/v1/customer-checkout/orders/[a-f0-9-]{36}/payment$'))`
\t}
\thandle @customer_checkout {
\t\theader Cache-Control no-store
\t\treverse_proxy pickchick-staging-api-1:3100 {
\t\t\theader_up -Cookie
\t\t\theader_up -X-Device-Id
\t\t\ttransport http {
\t\t\t\tresponse_header_timeout 25s
\t\t\t}
\t\t}
\t}
\t@cashier { path /v1/pos/* }
\t@kitchen { path /kitchen-live/* }
'''


def row(name, column, privilege, grantable=False):
    return {'name': name, 'kind': 'r', 'column': column, 'privilege': privilege, 'grantable': grantable}


OLD_ACL = [row('commerce_orders', None, 'SELECT'), row('commerce_orders', 'state', 'UPDATE')]
NEW_ACL = OLD_ACL + [row(r.FEEDBACK_TABLE, col, privilege) for col, privilege in
                     [('comment', 'UPDATE'), ('rating', 'UPDATE'), ('updated_at', 'UPDATE'),
                      (None, 'INSERT'), (None, 'SELECT')]]


class FeedbackRelease(unittest.TestCase):
    def test_exact_gateway_extension_preserves_live_handlers(self):
        candidate = r.extend_feedback(BASE_GATEWAY)
        self.assertEqual(candidate[candidate.index('\thandle @customer_checkout'):],
                         BASE_GATEWAY[BASE_GATEWAY.index('\thandle @customer_checkout'):])
        self.assertEqual(candidate[:candidate.index('\t@customer_checkout {')],
                         BASE_GATEWAY[:BASE_GATEWAY.index('\t@customer_checkout {')])
        self.assertIn("'/v1/customer-checkout/availability', '/v1/customer-checkout/feedback'", candidate)
        self.assertIn(r.FEEDBACK_ROUTE, candidate)
        self.assertIn('/feedback$\'', candidate)
        self.assertNotIn("method('DELETE')", candidate)
        self.assertNotIn("method('PATCH')", candidate)
        self.assertIn(r.PAYMENT_ROUTE, candidate)
        self.assertIn('(/watch)?$', candidate)

    def test_gateway_rejects_repeat_unknown_and_ambiguous_baselines(self):
        for text in [r.extend_feedback(BASE_GATEWAY), BASE_GATEWAY + BASE_GATEWAY,
                     BASE_GATEWAY.replace('/availability', '/unreviewed'),
                     BASE_GATEWAY.replace('/payment$', '/payment/.*$')]:
            with self.subTest(text=text[-40:]), self.assertRaises(r.market.GuardFailure):
                r.extend_feedback(text)

    def test_allowlisted_migration_and_baseline_pins(self):
        args = SimpleNamespace(expected_api_sha=r.BASELINE, expected_public_sha=r.PUBLIC_BASELINE,
                               expected_gateway_sha256=r.GATEWAY_BASELINE)
        with patch.object(r.market.Release, '__init__') as initialize:
            r.Release(args)
        profile = initialize.call_args.args[2]
        self.assertEqual(profile.baseline_count, 31)
        self.assertEqual(profile.migrations, ('032_cloud_order_feedback.sql',))
        self.assertTrue(profile.exact_ci_jobs)
        self.assertEqual(profile.ci_jobs, r.market.TRANSPORT_PROFILE.ci_jobs)
        for field in vars(args):
            changed = copy.copy(args)
            setattr(changed, field, '0' * len(getattr(args, field)))
            with self.subTest(field=field), self.assertRaises(r.market.GuardFailure):
                r.Release(changed)

    def test_acl_accepts_only_bounded_feedback_grants(self):
        r.verify_feedback_acl(OLD_ACL, NEW_ACL)
        for extra in [row(r.FEEDBACK_TABLE, None, 'UPDATE'), row(r.FEEDBACK_TABLE, None, 'DELETE'),
                      row(r.FEEDBACK_TABLE, 'order_id', 'UPDATE'), row(r.FEEDBACK_TABLE, 'created_at', 'UPDATE'),
                      row(r.FEEDBACK_TABLE, None, 'SELECT', True), row('commerce_captures', None, 'INSERT')]:
            with self.subTest(extra=extra), self.assertRaises(r.market.GuardFailure):
                r.verify_feedback_acl(OLD_ACL, NEW_ACL + [extra])
        with self.assertRaises(r.market.GuardFailure):
            r.verify_feedback_acl(OLD_ACL, NEW_ACL[1:])
        with self.assertRaises(r.market.GuardFailure):
            r.verify_feedback_acl(OLD_ACL, NEW_ACL[:-1])
        with self.assertRaises(r.market.GuardFailure):
            r.verify_feedback_acl(NEW_ACL, NEW_ACL)

    def test_data_verifier_preserves_money_receipts_identity_and_sequences(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            migration = repo/'db/cloud/migrations'/r.MIGRATION
            migration.parent.mkdir(parents=True)
            migration.write_text('CREATE TABLE commerce_order_feedback (order_id uuid PRIMARY KEY);')
            before = {'ledger': [], 'acl': OLD_ACL, 'data': {'tables': {
                name: {'rows': 1, 'sha256': name} for name in
                ['commerce_orders', 'commerce_captures', 'commerce_fiscal_documents',
                 'identity_customers', 'schema_migrations']},
                'sequences': [{'sequencename': 'commerce_outbox_sequence_seq', 'last_value': 9}]}}
            after = copy.deepcopy(before['data'])
            after['tables'][r.FEEDBACK_TABLE] = {'rows': 0, 'sha256': 'empty'}
            after['tables']['schema_migrations'] = {'rows': 32, 'sha256': 'new'}
            obj = object.__new__(r.Release)
            obj.ledger = lambda: [{'version': r.MIGRATION, 'scope': 'cloud', 'checksum': r.market.digest(migration.read_bytes())}]
            obj.acl = lambda: NEW_ACL
            obj.psql = lambda db, sql: 'f'
            obj.snapshot = lambda: after
            with patch.object(r.market, 'REPO', repo):
                obj.verify_data(before)
                for table in before['data']['tables'].keys() - {'schema_migrations'}:
                    mutated = copy.deepcopy(after)
                    mutated['tables'][table]['sha256'] = 'changed'
                    obj.snapshot = lambda: mutated
                    with self.subTest(table=table), self.assertRaises(r.market.GuardFailure):
                        obj.verify_data(before)
                for mutate in ['seed_feedback', 'new_table', 'sequence']:
                    mutated = copy.deepcopy(after)
                    if mutate == 'seed_feedback':
                        mutated['tables'][r.FEEDBACK_TABLE]['rows'] = 1
                    elif mutate == 'new_table':
                        mutated['tables']['unexpected'] = {'rows': 0}
                    else:
                        mutated['sequences'][0]['last_value'] = 10
                    obj.snapshot = lambda: mutated
                    with self.subTest(mutate=mutate), self.assertRaises(r.market.GuardFailure):
                        obj.verify_data(before)
                obj.snapshot = lambda: after
                for unsafe_role in ['pickchick_app', 'pickchick_kaspi_worker']:
                    obj.psql = lambda db, sql: 't' if unsafe_role in sql else 'f'
                    with self.subTest(unsafe_role=unsafe_role), self.assertRaises(r.market.GuardFailure):
                        obj.verify_data(before)
                obj.psql = lambda db, sql: 'f'
                obj.ledger = lambda: []
                with self.assertRaises(r.market.GuardFailure):
                    obj.verify_data(before)

    def test_prepare_preserves_entire_checkout_policy(self):
        with tempfile.TemporaryDirectory() as tmp:
            auth, checkout = Path(tmp)/'auth.env', Path(tmp)/'checkout.env'
            auth.write_text('auth=unchanged')
            checkout.write_text('policy=unchanged')
            obj = object.__new__(r.Release)
            obj.args = SimpleNamespace(auth_env=auth, checkout_env=checkout)
            obj.remote = lambda command: 'policy=unchanged'
            obj.validate_checkout = lambda raw: raw
            with patch.object(r.base.pilot, 'auth_environment') as validate_auth, \
                 patch.object(r.base.base.base.rollout.MobileRelease, 'prepare_api') as prepare_api:
                obj.prepare_api('/unused')
                validate_auth.assert_called_once_with('auth=unchanged')
                prepare_api.assert_called_once_with(obj, '/unused')
                checkout.write_text('policy=changed')
                prepare_api.reset_mock()
                with self.assertRaises(r.market.GuardFailure):
                    obj.prepare_api('/unused')
                prepare_api.assert_not_called()

    def test_public_probes_are_anonymous_and_never_bank_or_review_mutations(self):
        obj = object.__new__(r.Release)
        calls = []
        obj.http = lambda path, **kwargs: calls.append((path, kwargs.get('method'))) or (401, '')
        with patch.object(r.base.Release, 'verify_public'):
            obj.verify_public()
        self.assertEqual([method for path, method in calls], ['GET', 'GET', 'POST'])
        self.assertTrue(all(path.endswith('/feedback') for path, method in calls))


if __name__ == '__main__':
    unittest.main()
