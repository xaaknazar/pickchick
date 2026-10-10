"""Live-menu fixes API release guards. Synthetic fixtures; no SSH, bank calls or live mutation."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('live_menu_fixes_release_test', ROOT/'infra/staging/release-live-menu-fixes.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)
SHA, PUBLIC = 'a'*40, 'b'*40
QR = 'sha256:'+'e'*64
COMPOSE = '''services:
  api:
    image: pickchick-api:${RELEASE_SHA}
    environment:
      CUSTOMER_CHECKOUT_HEAD_GUARD: "true"
      APP_ENV: staging
      CLOUD_DATABASE_URL: postgresql://synthetic
  provision:
    environment:
      APP_ENV: staging
'''


def args(**overrides):
    values = dict(sha=SHA, branch='codex/mobile-integration-1010', action='prepare', apply=False, owner_id=None,
        expected_api_sha=r.BASELINE, expected_public_sha=PUBLIC, expected_api_image=r.DOCUMENTED_API_IMAGE,
        expected_compose_sha256=r.digest(COMPOSE.encode()), expected_gateway_sha256='d'*64,
        expected_qr_worker_image=QR, ssh_key=Path('/nonexistent'), ci_run='1', ci_proof=None, backup_identity=None)
    return SimpleNamespace(**{**values, **overrides})


def git(*argv):
    return subprocess.run(['git', *argv], cwd=ROOT, capture_output=True, text=True, check=True).stdout


class Guards(unittest.TestCase):
    def test_base_profile_file_untouched_and_private_copy_rebased(self):
        spec = importlib.util.spec_from_file_location('live_menu_fixes_pristine', ROOT/'infra/staging/release-live-menu.py')
        pristine = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = pristine
        spec.loader.exec_module(pristine)
        self.assertEqual(pristine.BASELINE, r.PREVIOUS_BASELINE)
        self.assertEqual(r.lm.BASELINE, r.BASELINE)
        self.assertNotEqual(r.lm, pristine)

    def test_exact_3bc98faf_and_reviewed_pins(self):
        r.check_pins(args())
        for field, value in [('expected_api_sha', r.PREVIOUS_BASELINE), ('expected_api_sha', 'e'*40),
                             ('expected_public_sha', 'main'), ('expected_api_image', 'pickchick-api:latest'),
                             ('expected_api_image', 'sha256:'+'c'*64), ('expected_compose_sha256', 'd'*63),
                             ('expected_gateway_sha256', ''), ('expected_qr_worker_image', ''),
                             ('expected_qr_worker_image', 'dab3657b'), ('action', 'enable'), ('action', 'disable')]:
            with self.assertRaises(r.GuardFailure, msg=field+'='+value):
                r.check_pins(args(**{field: value}))

    def test_arguments_are_required(self):
        full = ['prepare', '--sha', SHA, '--branch', 'b', '--expected-api-sha', r.BASELINE, '--expected-public-sha', PUBLIC,
                '--expected-api-image', r.DOCUMENTED_API_IMAGE, '--expected-compose-sha256', 'd'*64,
                '--expected-gateway-sha256', 'd'*64, '--expected-qr-worker-image', QR, '--ssh-key', '/k']
        parsed = r.parse(full)
        self.assertFalse(parsed.apply)
        for flag in ['--expected-api-image', '--expected-compose-sha256', '--expected-qr-worker-image', '--expected-api-sha']:
            index = full.index(flag)
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit, msg=flag):
                r.parse(full[:index] + full[index+2:])
        for action in ['enable', 'disable', 'deploy']:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                r.parse([action] + full[1:])

    def test_compose_carried_byte_for_byte_with_live_head_guard(self):
        carry = r.compose_carry(COMPOSE, r.digest(COMPOSE.encode()))
        self.assertEqual(carry, {'text': COMPOSE, 'head_guard': 'true'})
        off = COMPOSE.replace('"true"', '"false"')
        self.assertEqual(r.compose_carry(off, r.digest(off.encode()))['head_guard'], 'false')
        with self.assertRaises(r.GuardFailure):
            r.compose_carry(COMPOSE, '0'*64)
        missing = COMPOSE.replace('      CUSTOMER_CHECKOUT_HEAD_GUARD: "true"\n', '')
        twice = COMPOSE + '      CUSTOMER_CHECKOUT_HEAD_GUARD: "true"\n'
        moved = missing.replace('  provision:\n    environment:\n', '  provision:\n    environment:\n      CUSTOMER_CHECKOUT_HEAD_GUARD: "true"\n')
        odd = COMPOSE.replace('"true"', '"yes"')
        for text in [missing, twice, moved, odd, COMPOSE.replace('  api:\n', '  api:\n  api:\n')]:
            with self.assertRaises(r.GuardFailure):
                r.compose_carry(text, r.digest(text.encode()))

    def test_release_env_changes_only_release_sha(self):
        profile = r.market.ReleaseProfile('test', r.BASELINE, PUBLIC, 49, (), frozenset(), frozenset(), 'test', ())
        with tempfile.TemporaryDirectory() as tmp:
            old, new = Path(tmp)/'old', Path(tmp)/'new'
            old.write_text('KIOSK_CHECKOUT_ENABLED=true\nRELEASE_SHA='+r.BASELINE+'\n')
            subprocess.run([sys.executable, '-c', r.market.release_env_script(profile), str(old), str(new), SHA, r.BASELINE], check=True)
            self.assertEqual(new.read_text().splitlines(), ['KIOSK_CHECKOUT_ENABLED=true', 'RELEASE_SHA='+SHA])
            self.assertEqual(new.stat().st_mode & 0o777, 0o600)

    def test_baseline_is_schema050_at_3bc98faf(self):
        names = sorted(Path(p).name for p in git('ls-tree', '-r', '--name-only', r.BASELINE, '--', 'db/cloud/migrations/').split()
                       if p.endswith('.sql'))
        self.assertEqual([int(n[:3]) for n in names], list(r.SCHEMA))
        obj = r.Release.__new__(r.Release)
        obj.git = Mock(return_value='\n'.join('db/cloud/migrations/'+n for n in names))
        self.assertEqual(obj.baseline_migrations(), names)
        obj.git.return_value += '\ndb/cloud/migrations/051_cloud_device_registry.sql'
        with self.assertRaises(r.GuardFailure):
            obj.baseline_migrations()

    def test_candidate_migration_set_must_equal_3bc98faf(self):
        names = sorted(Path(p).name for p in git('ls-tree', '-r', '--name-only', r.BASELINE, '--', 'db/cloud/migrations/').split()
                       if p.endswith('.sql'))
        obj = r.Release.__new__(r.Release)
        obj.sha, obj.args = SHA, args()
        obj.profile = r.market.ReleaseProfile('t', r.BASELINE, PUBLIC, 49, (), frozenset(), frozenset(), 't', ())
        obj.baseline_migrations = Mock(return_value=names)
        obj.execute = Mock(side_effect=lambda command, **kw: (ROOT/'db/cloud/migrations'/command[-1].split('/')[-1]).read_bytes()
                           if command[1] == 'show' else b'')
        obj.git = Mock(side_effect=lambda *a: {'rev-parse': SHA, 'status': '', 'ls-remote': SHA+'\trefs/heads/b',
                                               'diff': ''}[a[0]])
        current = sorted(p.name for p in (ROOT/'db/cloud/migrations').glob('*.sql'))
        if current == names:
            obj.source_checks()
        else:  # This checkout carries an extra migration (e.g. 051): the profile must refuse it.
            with self.assertRaisesRegex(r.GuardFailure, 'migration set'):
                obj.source_checks()
        obj.git = Mock(side_effect=lambda *a: {'rev-parse': SHA, 'status': '', 'ls-remote': SHA+'\trefs/heads/b',
                                               'diff': 'infra/staging/compose.yaml'}[a[0]])
        obj.baseline_migrations = Mock(return_value=current)
        with self.assertRaisesRegex(r.GuardFailure, 'repository compose'):
            obj.source_checks()

    def test_neighbours_require_reviewed_qr_worker_and_banks(self):
        obj = r.Release.__new__(r.Release); obj.args = args()
        containers = {name: f'id-{i} sha256:{"f"*64} 2026-10-09T11:00:00Z running 0' for i, name in enumerate(r.lm.BANKS)}
        containers[r.QR_WORKER] = f'id-q {QR} 2026-10-09T11:00:00Z running 0'
        obj.fingerprint = Mock(side_effect=lambda: {'containers': copy.deepcopy(containers)})
        obj.remote = Mock(return_value='gateway image timestamp running 0')
        self.assertIn(r.market.GATEWAY, obj.neighbors()['containers'])
        containers[r.QR_WORKER] = containers[r.QR_WORKER].replace(QR, r.DOCUMENTED_API_IMAGE)
        with self.assertRaisesRegex(r.GuardFailure, 'QR worker'):
            obj.neighbors()

    def test_baseline_head_guard_must_match_running_environment(self):
        obj = r.Release.__new__(r.Release); obj.args = args()
        obj.running_revision = Mock(return_value=r.BASELINE); obj.api_image = Mock(return_value=r.DOCUMENTED_API_IMAGE)
        obj.remote = Mock(side_effect=lambda c, **k: r.DOCUMENTED_API_IMAGE if 'image inspect' in c else r.REMOTE+'/releases/'+r.BASELINE)
        obj.ledger = obj.expected_ledger = Mock(return_value=[])
        obj.runtime_acl = obj.verify_public = Mock()
        obj.read_text = Mock(return_value=COMPOSE)
        obj.rollback_artifacts = obj.neighbors = obj.acl = obj.http_json = Mock(return_value={})
        obj.runtime_environment = Mock(return_value={r.FLAG: r.digest(b'true'), 'RELEASE_SHA': 'x'})
        before = obj.baseline()
        self.assertEqual((before['candidate'], before['head_guard']), (COMPOSE, 'true'))
        obj.runtime_environment.return_value = {r.FLAG: r.digest(b'false')}
        with self.assertRaisesRegex(r.GuardFailure, 'head guard'):
            obj.baseline()
        obj.running_revision.return_value = r.PREVIOUS_BASELINE
        with self.assertRaisesRegex(r.GuardFailure, 'baseline'):
            obj.baseline()

    def test_current_rejects_any_environment_change_besides_release_sha(self):
        obj = r.Release.__new__(r.Release); obj.sha = SHA
        before = {'acl': [], 'neighbors': {}, 'rollback': {}, 'capabilities': {},
                  'environment': {r.FLAG: r.digest(b'true'), 'RELEASE_SHA': 'old'}}
        proof = {'before': before, 'artifacts': {'image': 'img'}}
        obj.running_revision = Mock(return_value=SHA); obj.api_image = Mock(return_value='img')
        obj.remote = Mock(return_value=r.REMOTE+'/releases/'+SHA)
        obj.ledger = obj.expected_ledger = Mock(return_value=[])
        obj.acl = Mock(return_value=[]); obj.neighbors = obj.rollback_artifacts = obj.http_json = Mock(return_value={})
        obj.runtime_acl = obj.verify_public = Mock()
        obj.runtime_environment = Mock(return_value={r.FLAG: r.digest(b'true'), 'RELEASE_SHA': 'new'})
        obj.current(proof)
        obj.runtime_environment.return_value = {r.FLAG: r.digest(b'false'), 'RELEASE_SHA': 'new'}
        with self.assertRaises(r.GuardFailure):
            obj.current(proof)

    def test_default_prepare_performs_no_remote_mutation(self):
        obj = r.Release.__new__(r.Release); obj.args = args(); obj.sha = SHA
        obj.source_checks = Mock(); obj.ci = Mock(); obj.baseline = Mock(return_value={}); obj.remote = Mock()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            obj.run()
        obj.remote.assert_not_called()
        plan = json.loads(output.getvalue())
        self.assertEqual((plan['applied'], plan['head_guard'], plan['baseline'], plan['migrations']),
                         (False, 'unchanged', r.BASELINE, []))

    def apply_fixture(self, tmp, fail_verify=False):
        key = Path(tmp)/'identity'; key.write_text('synthetic'); key.chmod(0o600)
        obj = r.Release.__new__(r.Release); obj.args = args(action='apply', apply=True, backup_identity=key); obj.sha = SHA
        before = {'candidate': COMPOSE, 'head_guard': 'true'}
        proof = {'sha': SHA, 'baseline': r.BASELINE, 'before': before, 'artifacts': {'image': 'sha256:'+'1'*64}}
        obj.prepared = Mock(return_value=proof); obj.baseline = Mock(return_value=before)
        obj.artifacts = Mock(return_value=proof['artifacts'])
        calls = []
        obj.snapshot = Mock(return_value={})
        obj.save = Mock(side_effect=lambda name, value: calls.append(('save', name, value)))
        obj.backup_restore = Mock(side_effect=lambda: calls.append(('backup',)) or {'restore': 'passed'})
        pointer = [r.REMOTE+'/releases/'+r.BASELINE]
        def remote(command, **kwargs):
            calls.append(('remote', command))
            return pointer[0] if command.startswith('readlink') else ''
        obj.remote = Mock(side_effect=remote)
        obj.switch = Mock(side_effect=lambda path, old, new: calls.append(('switch', new)) or pointer.__setitem__(0, new))
        obj.ready = Mock()
        images = iter(['sha256:'+'1'*64, r.DOCUMENTED_API_IMAGE])
        obj.api_image = Mock(side_effect=lambda: next(images))
        obj.running_revision = Mock(return_value=r.BASELINE)
        obj.current = Mock(side_effect=r.GuardFailure('capabilities changed') if fail_verify else None)
        return obj, calls

    def test_apply_backup_before_switch_and_carries_head_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            obj, calls = self.apply_fixture(tmp)
            obj.apply()
            remote = [c[1] for c in calls if c[0] == 'remote']
            self.assertEqual(len(remote), 1)
            self.assertIn('--no-deps --wait --wait-timeout 120 api', remote[0])
            self.assertIn('/releases/'+SHA+'/', remote[0])
            self.assertLess(calls.index(('backup',)), next(i for i, c in enumerate(calls) if c[0] == 'remote'))
            self.assertFalse(any(word in remote[0] for word in ['provision', 'gateway', 'worker', 'enable']))
            applied = next(c[2] for c in calls if c[0] == 'save' and c[1] == 'applied.json')
            self.assertEqual((applied['head_guard'], applied['migrations'], applied['baseline']), ('true', [], r.BASELINE))
            obj.backup_restore = Mock(side_effect=r.GuardFailure('restore failed')); obj.remote.reset_mock()
            with self.assertRaises(r.GuardFailure):
                obj.apply()
            obj.remote.assert_not_called()

    def test_failed_verification_rolls_back_to_3bc98faf(self):
        with tempfile.TemporaryDirectory() as tmp:
            obj, calls = self.apply_fixture(tmp, fail_verify=True)
            with self.assertRaisesRegex(r.GuardFailure, 'capabilities'):
                obj.apply()
            self.assertEqual([c[1] for c in calls if c[0] == 'switch'],
                             [r.REMOTE+'/releases/'+SHA, r.REMOTE+'/releases/'+r.BASELINE])
            ups = [c[1] for c in calls if c[0] == 'remote' and ' up -d ' in c[1]]
            self.assertIn('/releases/'+r.BASELINE+'/', ups[-1])
            rollback = next(c[2] for c in calls if c[0] == 'save' and c[1] == 'rollback.json')
            self.assertEqual((rollback['restored_api'], rollback['database_restored']), (r.BASELINE, False))
            self.assertFalse(any(c[0] == 'save' and c[1] == 'applied.json' for c in calls))

    def test_unverified_rollback_is_uncertain(self):
        with tempfile.TemporaryDirectory() as tmp:
            obj, _ = self.apply_fixture(tmp, fail_verify=True)
            obj.running_revision = Mock(return_value=SHA)
            with self.assertRaises(r.CommandUncertain):
                obj.apply()


if __name__ == '__main__':
    unittest.main()
