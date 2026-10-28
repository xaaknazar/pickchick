"""Reject accidental customer takeover and non-review runtime changes."""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
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

    @unittest.skipUnless(shutil.which('docker'), 'Docker Compose CLI is required')
    def test_resolved_compose_dollars_survive_review_patch_and_reload(self):
        # `config` needs no daemon and starts no containers. Synthetic values only.
        def resolve(config):
            result = subprocess.run(['docker', 'compose', '-f', '-', 'config', '--format', 'json'],
                                    input=json.dumps(config), capture_output=True, text=True, check=True)
            return json.loads(result.stdout)
        literal = 'prefix$${PICKCHICK_SYNTHETIC_UNSET}suffix$$'
        original = resolve({'name': 'review-literal-regression', 'services': {
            'api': {'image': 'alpine:3', 'environment': {'EXISTING': literal}},
            'redis-cache': {'image': 'redis:7', 'healthcheck': {
                'test': ['CMD-SHELL', 'echo '+literal]}}}})
        updated = m.candidate(original, m.desired(self.private, 'enable'))
        self.assertEqual(resolve(updated), updated)
        self.assertEqual(updated['services']['redis-cache'], original['services']['redis-cache'])

    def test_installed_oci_revision_without_optional_environment_marker(self):
        sha = 'a'*40
        container = {'Config': {'Labels': {'org.opencontainers.image.revision': sha}}}
        m.verify_revision(container, {}, sha)
        m.verify_revision(container, {'RELEASE_SHA': sha}, sha)
        for state, env in (({'Config': {'Labels': {}}}, {}),
                           (container, {'RELEASE_SHA': 'b'*40}),
                           ({'Config': {'Labels': {'org.opencontainers.image.revision': 'b'*40}}}, {})):
            with self.assertRaises(m.Refused):
                m.verify_revision(state, env, sha)


if __name__ == '__main__':
    unittest.main()
