"""Edge identity rotation flag operator: pure guards and the remote env rewrite; no network."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('identity_flag_test', ROOT / 'infra/staging/edge-identity-rotation-flag.py')
f = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = f
spec.loader.exec_module(f)
Guard = f.market.GuardFailure
SHA = 'b' * 40


def digests(**values):
    return {k: hashlib.sha256(v.encode()).hexdigest() for k, v in values.items()}


def rows(keys, grantable=False):
    return [{'name': t, 'column': c, 'privilege': p, 'grantable': grantable} for t, c, p in keys]


def compose(**env):
    return {'name': 'pickchick-staging', 'services': {
        'api': {'image': 'pickchick-api:' + SHA, 'environment': {'DB': 'secret', **env}},
        'cloud-db': {'image': 'postgres'}}, 'networks': {'private': {}}}


class ComposeFile(unittest.TestCase):
    def test_enable_adds_only_the_api_flag(self):
        for env in ({}, {f.KEY: 'false'}):
            result = f.compose_candidate(compose(**env), True)
            self.assertEqual(result, compose(**{f.KEY: 'true'}))

    def test_disable_removes_only_the_flag(self):
        self.assertEqual(f.compose_candidate(compose(**{f.KEY: 'true'}), False), compose())

    def test_wrong_state_or_format_is_refused(self):
        for config, enabled in [(compose(**{f.KEY: 'true'}), True), (compose(), False),
                                (compose(**{f.KEY: '1'}), True), ({'services': {}}, True),
                                ({'services': {'api': {'environment': ['A=1']}}}, True), ([], True)]:
            with self.assertRaises(Guard):
                f.compose_candidate(config, enabled)

    def run_remote(self, script, *args):
        return subprocess.run([sys.executable, '-c', script, *args], capture_output=True, text=True)

    def test_remote_rewrite_matches_candidate_and_restores(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, backup = os.path.join(tmp, 'compose.yaml'), os.path.join(tmp, 'compose.yaml.before')
            original = json.dumps(compose(), indent=2) + '\n'
            Path(path).write_text(original)
            old = hashlib.sha256(original.encode()).hexdigest()
            script = f.rewrite_script()
            self.assertNotEqual(self.run_remote(script, path, backup, 'true', 'c' * 64).returncode, 0)
            done = self.run_remote(script, path, backup, 'true', old)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(json.loads(Path(path).read_text()), compose(**{f.KEY: 'true'}))
            self.assertEqual(done.stdout.strip(), hashlib.sha256(Path(path).read_bytes()).hexdigest())
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(backup).st_mode & 0o777, 0o600)
            self.assertEqual(Path(backup).read_text(), original)
            self.assertNotEqual(self.run_remote(script, path, backup, 'false',
                                                hashlib.sha256(Path(path).read_bytes()).hexdigest()).returncode, 0,
                                'existing backup must never be overwritten')
            restored = self.run_remote(f.RESTORE_FILE, path, backup, old)
            self.assertEqual(restored.returncode, 0, restored.stderr)
            self.assertEqual(Path(path).read_text(), original)

    def test_state_script_reports_names_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'compose.yaml')
            Path(path).write_text(json.dumps(compose()))
            out = self.run_remote(f.COMPOSE_STATE, path)
            self.assertEqual(json.loads(out.stdout), {'services': ['api', 'cloud-db'], 'api_image': 'pickchick-api:' + SHA, 'flag': 'absent'})
            self.assertNotIn('secret', out.stdout)


class Grants(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'node required')
    def test_sql_matches_reviewed_grants_module(self):
        module = (ROOT / 'infra/staging/edge-identity-rotation-grants.mjs').as_uri()
        for enabled in (True, False):
            script = (f"import {{edgeIdentityRotationGrants}} from {json.dumps(module)};"
                      f"process.stdout.write(edgeIdentityRotationGrants('pickchick_app', {str(enabled).lower()}))")
            out = subprocess.run(['node', '--input-type=module', '-e', script], capture_output=True, text=True, check=True).stdout
            self.assertEqual(f.grants_sql('pickchick_app', enabled), out)

    def test_role_is_validated(self):
        with self.assertRaises(Guard):
            f.grants_sql('app; DROP', True)

    def test_acl_must_match_flag_and_leave_others(self):
        other = {('orders', None, 'SELECT'), ('device_credentials', 'device_id', 'UPDATE')}
        before = rows(other)
        f.verify_acl(before, rows(other | f.ROTATION_ACL), True)
        f.verify_acl(rows(other | f.ROTATION_ACL), before, False)
        for after in (rows(other), rows(other | f.ROTATION_ACL | {('orders', None, 'DELETE')}),
                      rows(f.ROTATION_ACL), rows(other | f.ROTATION_ACL, grantable=True)):
            with self.assertRaises(Guard):
                f.verify_acl(before, after, True)


class Environment(unittest.TestCase):
    def test_flag_state_from_digests(self):
        self.assertEqual(f.flag_state({}), 'false')
        self.assertEqual(f.flag_state(digests(**{f.KEY: 'false'})), 'false')
        self.assertEqual(f.flag_state(digests(**{f.KEY: 'true'})), 'true')
        self.assertEqual(f.flag_state(digests(**{f.KEY: '1'})), 'invalid')

    def test_only_the_flag_may_change(self):
        before = digests(**{f.KEY: 'false', 'A': '1'})
        f.verify_env_delta(before, digests(**{f.KEY: 'true', 'A': '1'}), True)
        with self.assertRaises(Guard):
            f.verify_env_delta(before, digests(**{f.KEY: 'true', 'A': '2'}), True)
        with self.assertRaises(Guard):
            f.verify_env_delta(before, before, True)


class Binding(unittest.TestCase):
    def labels(self, **kw):
        base = {'com.docker.compose.project.environment_file':
                f'{f.SECRETS_ENV},{f.REMOTE}/releases/{"7" * 40}/release.env',
                'com.docker.compose.project.config_files': f'{f.REMOTE}/releases/{SHA}/infra/staging/compose.yaml',
                'com.docker.compose.service': 'api', 'com.docker.compose.project': 'pickchick-staging'}
        return dict(base, **kw)

    def test_running_api_binding(self):
        bind = f.live_binding(self.labels(), f'{f.REMOTE}/releases/{SHA}', 'pickchick-api:' + SHA)
        self.assertEqual(bind['env_file'], f'{f.REMOTE}/releases/{"7" * 40}/release.env')
        self.assertEqual(bind['project'], 'pickchick-staging')

    def test_mismatched_binding_is_refused(self):
        cases = [(self.labels(), f'{f.REMOTE}/releases/{"c" * 40}', 'pickchick-api:' + SHA),
                 (self.labels(), f'{f.REMOTE}/releases/{SHA}', 'pickchick-api:latest'),
                 (self.labels(**{'com.docker.compose.project.environment_file': f.SECRETS_ENV}),
                  f'{f.REMOTE}/releases/{SHA}', 'pickchick-api:' + SHA),
                 (self.labels(**{'com.docker.compose.service': 'provision'}), f'{f.REMOTE}/releases/{SHA}', 'pickchick-api:' + SHA)]
        for labels, current, image in cases:
            with self.assertRaises(Guard):
                f.live_binding(labels, current, image)


if __name__ == '__main__':
    unittest.main()
