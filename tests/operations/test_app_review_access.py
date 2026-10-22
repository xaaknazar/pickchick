"""Reject accidental customer takeover and non-review runtime changes."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('app_review_access', Path(__file__).resolve().parents[2]/'infra/staging/app-review-access.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ReviewAccessTests(unittest.TestCase):
    def setUp(self):
        self.private = {'phone': '+77000000000', 'code_digest': 'a'*64}  # Synthetic shape; live parser validates KZ.
        self.config = {'services': {'api': {'image': 'existing', 'environment': {'PAYMENT_ENABLED': 'true'}},
                                    'worker': {'image': 'untouched'}}, 'networks': {'private': {}}}

    def test_no_clear_code_or_extra_private_contact(self):
        for extra in ('code', 'review_code', 'email'):
            with self.assertRaises(m.Refused):
                m.desired({**self.private, extra: 'private'}, 'enable')

    def test_candidate_keeps_image_workers_and_other_flags(self):
        before = copy.deepcopy(self.config)
        wanted = m.desired(self.private, 'enable')
        result = m.candidate(self.config, wanted)
        self.assertEqual(self.config, before)
        self.assertEqual(result['services']['worker'], before['services']['worker'])
        self.assertEqual(result['services']['api']['image'], 'existing')
        self.assertEqual(result['services']['api']['environment']['PAYMENT_ENABLED'], 'true')

    def test_different_existing_review_phone_refused(self):
        self.config['services']['api']['environment']['CUSTOMER_REVIEW_ACCOUNT_PHONE'] = '+77000000001'
        with self.assertRaises(m.Refused):
            m.candidate(self.config, m.desired(self.private, 'enable'))

    def test_disabling_preserves_phone_and_payment_bar(self):
        enabled = m.candidate(self.config, m.desired(self.private, 'enable'))
        disabled = m.candidate(enabled, m.desired(self.private, 'disable'))
        env = disabled['services']['api']['environment']
        self.assertEqual(env['CUSTOMER_REVIEW_ACCOUNT_ENABLED'], 'false')
        self.assertEqual(env['CUSTOMER_REVIEW_ACCOUNT_PHONE'], self.private['phone'])
        self.assertEqual(env['CUSTOMER_REVIEW_ACCOUNT_CODE_SHA256'], self.private['code_digest'])

    def test_disable_cannot_create_new_review_identity(self):
        with self.assertRaises(m.Refused):
            m.candidate(self.config, m.desired(self.private, 'disable'))

    def test_runtime_delta_refuses_unrelated_change(self):
        wanted = m.desired(self.private, 'enable')
        before = {'PAYMENT_ENABLED': 'true'}
        m.verify_environment(before, {**before, **wanted}, wanted)
        for after in ({**wanted, 'PAYMENT_ENABLED': 'false'}, wanted, {**before, **wanted, 'OTHER': '1'}):
            with self.assertRaises(m.Refused):
                m.verify_environment(before, after, wanted)

    def test_runtime_delta_requires_all_review_fields(self):
        wanted = m.desired(self.private, 'enable')
        for key in wanted:
            changed = {k:v for k,v in wanted.items() if k != key}
            with self.assertRaises(m.Refused):
                m.verify_environment({}, changed, wanted)

    def test_existing_dollar_values_are_literal_on_compose_reload(self):
        source = {'environment': {'EXISTING': 'prefix${NOT_AN_ENV}suffix$'}, 'ports': [3100]}
        encoded = m.compose_literals(source)
        self.assertEqual(encoded['environment']['EXISTING'], 'prefix$${NOT_AN_ENV}suffix$$')
        self.assertEqual(encoded['ports'], [3100])
        self.assertEqual(source['environment']['EXISTING'], 'prefix${NOT_AN_ENV}suffix$')


if __name__ == '__main__':
    unittest.main()
