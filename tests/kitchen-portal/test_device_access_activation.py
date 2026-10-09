import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('portal_activation', ROOT / 'infra/kitchen-portal/activate-device-access.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
SHA = 'a' * 40
BRANCH = '11111111-1111-4111-8111-111111111111'
DEVICE = '22222222-2222-4222-8222-222222222222'
RAW = json.dumps({'origin': p.b.ORIGIN, 'key': 'b' * 64, 'branchLabel': 'Synthetic',
                  'terminals': dict.fromkeys(('prep', 'assembly', 'display'), BRANCH)}).encode()


def ci():
    return {'run': {'head_sha': SHA, 'status': 'completed', 'conclusion': 'success',
                    'path': '.github/workflows/ci.yml', 'head_repository': {'full_name': 'xaaknazar/pickchick'}},
            'jobs': {'total_count': len(p.JOBS), 'jobs': [{'name': name, 'head_sha': SHA,
                     'status': 'completed', 'conclusion': 'success'} for name in p.JOBS]}}


def evidence():
    scope = {'source_sha': SHA, 'branch_id': BRANCH, 'edge_device_id': DEVICE, 'completed_epoch': time.time()}
    manifest = {'files': {name: p.b.digest(ROOT / name) for name in p.LINK_FILES}}
    cloud = {**scope, 'format': 'pickchick-device-access-cloud-enabled-v1', 'device_access_enabled': True}
    windows = {**scope, 'format': 'pickchick-device-access-ready-v1', 'schema': 20,
               'migrationChecksum020': p.b.digest(ROOT / 'db/edge/migrations/020_terminal_access.sql'),
               'runtime_verified': True, 'grants_verified': True,
               'worker': {'installed': True, 'enabled': True, 'running': True,
                          'script_sha256': p.b.digest(ROOT / 'infra/windows/native-device-access-worker.mjs')},
               'link': {'verified': True, 'running': True, 'files': manifest['files']}}
    return cloud, windows, manifest


class Activation(unittest.TestCase):
    def test_config_changes_only_flag_and_never_key_or_legacy_ids(self):
        for raw in (RAW, RAW.replace(b'}', b'}', 1) + b'\r\n',
                    RAW[:-1] + b', "terminalAccess" : false}\n'):
            after = p.config_candidate(raw, True)
            self.assertEqual(p.decode(after), {**p.decode(raw), 'terminalAccess': True})
            self.assertEqual(after.count(b'b' * 64), 1)
            off = p.config_candidate(after, False)
            self.assertEqual(p.decode(off), {**p.decode(raw), 'terminalAccess': False})
            with self.assertRaisesRegex(RuntimeError, 'already changed'):
                p.config_candidate(after, True)
        for raw in (RAW[:-1] + b', "terminalAccess":false,"terminalAccess":false}',
                    RAW[:-1] + b', "terminalAccess":"false"}',
                    RAW[:-1] + b', "terminal\\u0041ccess":false}'):
            with self.assertRaises(RuntimeError):
                p.config_candidate(raw, True)

    def test_ci_requires_all_exact_jobs(self):
        p.check_ci(ci(), SHA)
        for change in ('missing', 'failed', 'foreign'):
            value = ci()
            if change == 'missing':
                value['jobs']['jobs'].pop()
            elif change == 'failed':
                value['jobs']['jobs'][0]['conclusion'] = 'failure'
            else:
                value['run']['head_sha'] = 'c' * 40
            with self.assertRaises(RuntimeError):
                p.check_ci(value, SHA)

    def test_activation_requires_ready_not_prepared_and_matching_bytes(self):
        args = SimpleNamespace(expected_source_sha=SHA, branch_id=BRANCH, edge_device_id=DEVICE)
        cloud, windows, manifest = evidence()
        p.check_ready(cloud, windows, args, manifest)
        for change in ('prepared', 'off', 'stale', 'other-device', 'old-worker', 'old-link'):
            c, w, m = evidence()
            if change == 'prepared':
                w['format'] = 'pickchick-device-access-prepared-v1'
            elif change == 'off':
                w['worker']['enabled'] = False
            elif change == 'stale':
                c['completed_epoch'] -= 21601
            elif change == 'other-device':
                w['edge_device_id'] = BRANCH
            elif change == 'old-worker':
                w['worker']['script_sha256'] = '0' * 64
            else:
                w['link']['files'] = {**m['files'], p.LINK_FILES[0]: '0' * 64}
            with self.assertRaises(RuntimeError, msg=change):
                p.check_ready(c, w, args, m)

    def test_real_config_cas_preserves_bind_inode_and_private_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory).resolve() / 'config.json'
            p.write_new(file, RAW)
            identity = [file.stat().st_dev, file.stat().st_ino]
            after = p.config_candidate(RAW, True)
            p.cas_write(file, RAW, after, identity)
            self.assertEqual(p.private_bytes(file), after)
            self.assertEqual([file.stat().st_dev, file.stat().st_ino], identity)
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(RuntimeError):
                p.cas_write(file, RAW, after, identity)
            p.cas_write(file, after, RAW, identity)
            self.assertEqual(file.read_bytes(), RAW)
            file.chmod(0o644)
            with self.assertRaises(RuntimeError):
                p.private_bytes(file)

    def fixture(self, directory):
        directory = str(Path(directory).resolve())
        state = Path(directory) / 'portal'
        (state / 'private').mkdir(parents=True, mode=0o700)
        p.write_new(state / 'private/config.json', RAW)
        cloud, windows, manifest = evidence()
        paths = {}
        for name, value in (('ci', ci()), ('cloud', cloud), ('windows', windows)):
            path = Path(directory) / (name + '.json')
            p.save_new(path, value)
            paths[name] = str(path)
        args = SimpleNamespace(mode='enable', apply=False, expected_source_sha=SHA, branch_id=BRANCH,
                               edge_device_id=DEVICE, operation_id=str(uuid.uuid4()), owner_id=None,
                               ci_proof=paths['ci'], cloud_proof=paths['cloud'], windows_proof=paths['windows'],
                               expected_config_sha256=p.sha(RAW), plan=None)
        actual = {'portal': ['portal-id', 'portal-image', 'started'],
                  'neighbors': {'db': ['db-id'], 'bank': ['bank-id']}, 'public': '/public', 'api': '/api',
                  'release': str(state / 'releases' / SHA), 'manifest': manifest}
        return state, args, actual

    def test_default_plan_no_write_and_apply_verifies_backup_before_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            state, args, actual = self.fixture(directory)
            directory = str(Path(directory).resolve())
            lock = Path(directory) / 'lock'
            with patch.object(p, 'STATE', state), patch.object(p.b, 'LOCK', lock), \
                    patch.object(p, 'baseline', return_value=actual), patch.object(p, 'restart_config') as restart:
                plan = p.operate(args)
                self.assertFalse(lock.exists())
                self.assertFalse((state / 'device-access').exists())
                restart.assert_not_called()
                args.plan = str(Path(directory) / 'plan.json')
                p.save_new(Path(args.plan), plan)
                args.apply = True

                def start(a, folder, record, before, after):
                    self.assertTrue(lock.exists())
                    self.assertEqual(p.private_bytes(folder / 'before.json'), RAW)
                    self.assertEqual(p.private_bytes(folder / 'restore-drill.json'), RAW)
                    self.assertEqual(p.private_bytes(folder / 'after.json'), after)
                    self.assertEqual(p.decode(p.private_bytes(folder / 'attempt.json')), plan)
                    return {'success': True}

                restart.side_effect = start
                self.assertEqual(p.operate(args), {'success': True})
                self.assertFalse(lock.exists())
                restart.assert_called_once()

    def test_unknown_outcome_retains_lock_and_exclusive_attempt_no_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            state, args, actual = self.fixture(directory)
            directory = str(Path(directory).resolve())
            lock = Path(directory) / 'lock'
            with patch.object(p, 'STATE', state), patch.object(p.b, 'LOCK', lock), \
                    patch.object(p, 'baseline', return_value=actual), patch.object(p, 'restart_config') as restart:
                plan = p.operate(args)
                args.plan = str(Path(directory) / 'plan.json')
                p.save_new(Path(args.plan), plan)
                args.apply = True
                restart.side_effect = p.b.Uncertain('Synthetic timeout')
                with self.assertRaises(p.b.Uncertain):
                    p.operate(args)
                self.assertTrue(lock.exists())
                self.assertTrue((state / 'device-access' / args.operation_id / 'attempt.json').exists())
                with self.assertRaises(FileExistsError):
                    p.operate(args)
                self.assertEqual(restart.call_count, 1)

    def test_stale_plan_or_backup_failure_never_stops_portal(self):
        with tempfile.TemporaryDirectory() as directory:
            state, args, actual = self.fixture(directory)
            directory = str(Path(directory).resolve())
            with patch.object(p, 'STATE', state), patch.object(p.b, 'LOCK', Path(directory) / 'lock'), \
                    patch.object(p, 'baseline', return_value=actual), patch.object(p, 'restart_config') as restart:
                plan = p.operate(args)
                args.plan = str(Path(directory) / 'plan.json')
                p.save_new(Path(args.plan), {**plan, 'after_sha256': '0' * 64})
                args.apply = True
                with self.assertRaises(RuntimeError):
                    p.operate(args)
                Path(args.plan).unlink()
                p.save_new(Path(args.plan), plan)
                with patch.object(p, 'write_new', side_effect=RuntimeError('Synthetic failed readback')):
                    with self.assertRaises(RuntimeError):
                        p.operate(args)
                restart.assert_not_called()

    def test_explicit_restore_uses_actual_saved_bytes_and_owned_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = str(Path(directory).resolve())
            state, args, actual = self.fixture(directory)
            lock = Path(directory) / 'lock'
            with patch.object(p, 'STATE', state), patch.object(p.b, 'LOCK', lock), \
                    patch.object(p, 'baseline', return_value=actual), patch.object(p, 'restart_config') as restart:
                plan = p.operate(args)
                args.plan = str(Path(directory) / 'plan.json')
                p.save_new(Path(args.plan), plan)
                args.apply = True

                def fail_after_write(a, folder, record, before, after):
                    p.cas_write(state / 'private/config.json', before, after, record['config_identity'])
                    raise p.b.Uncertain('Synthetic start timeout')

                restart.side_effect = fail_after_write
                with self.assertRaises(p.b.Uncertain):
                    p.operate(args)
                args.mode = 'restore'
                args.owner_id = str(uuid.uuid4())
                args.expected_config_sha256 = p.sha(p.private_bytes(state / 'private/config.json'))
                with self.assertRaisesRegex(RuntimeError, 'Foreign retained lock'):
                    p.operate(args)
                self.assertEqual(restart.call_count, 1)
                args.owner_id = p.decode(p.private_bytes(lock / 'owner.json'))['id']
                args.apply = False
                self.assertEqual(p.operate(args)['status'], 'restore-plan')
                self.assertEqual(restart.call_count, 1)

                def restore(a, folder, record, before, after):
                    self.assertTrue(p.decode(before)['terminalAccess'])
                    self.assertEqual(after, RAW)
                    p.cas_write(state / 'private/config.json', before, after, record['config_identity'])
                    return {'restored': True}

                restart.side_effect = restore
                args.apply = True
                self.assertEqual(p.operate(args), {'restored': True})
                self.assertEqual(p.private_bytes(state / 'private/config.json'), RAW)
                self.assertFalse(lock.exists())

    def test_disable_is_independent_and_preserves_all_private_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            state, args, actual = self.fixture(directory)
            args.mode = 'disable'
            args.cloud_proof = args.windows_proof = None
            file = state / 'private/config.json'
            enabled = p.config_candidate(RAW, True)
            p.cas_write(file, RAW, enabled, [file.stat().st_dev, file.stat().st_ino])
            args.expected_config_sha256 = p.sha(enabled)
            with patch.object(p, 'STATE', state), patch.object(p, 'baseline', return_value=actual), \
                    patch.object(p, 'restart_config') as restart:
                plan = p.operate(args)
            self.assertEqual(plan['mode'], 'disable')
            self.assertEqual(plan['proof_sha256'], {})
            self.assertEqual(plan['after_sha256'], p.sha(p.config_candidate(enabled, False)))
            restart.assert_not_called()

    def test_real_restart_sequence_touches_only_portal_and_checks_bind_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            state, args, actual = self.fixture(directory)
            folder = state / 'evidence'
            folder.mkdir(mode=0o700)
            record = {**actual, 'config_identity': [
                (state / 'private/config.json').stat().st_dev, (state / 'private/config.json').stat().st_ino]}
            after = p.config_candidate(RAW, True)
            stopped = False
            commands = []

            def inspect(_):
                return {'Id': 'portal-id', 'Image': 'portal-image', 'State': {'StartedAt': 'started', 'Running': not stopped}}

            def run(command, **_):
                nonlocal stopped
                commands.append(command)
                if command[1] == 'stop':
                    stopped = True
                elif command[1] == 'start':
                    self.assertEqual(p.private_bytes(state / 'private/config.json'), after)
                    stopped = False
                elif command[1] == 'exec':
                    return p.sha(after)
                return ''

            pointers = {state / 'current': Path(actual['release']), p.b.ROOT / 'current': Path('/api'),
                        p.b.ROOT / 'public-https/current': Path('/public')}
            with patch.object(p, 'STATE', state), patch.object(p, 'inspect', side_effect=inspect), \
                    patch.object(p.b, 'run', side_effect=run), patch.object(p, 'public_mode'), \
                    patch.object(p.b, 'pointer', side_effect=lambda path: pointers[path]), patch.object(p.u, 'unchanged') as unchanged:
                result = p.restart_config(args, folder, record, RAW, after)
            self.assertEqual([c[1] for c in commands], ['stop', 'start', 'exec'])
            self.assertTrue(all('portal-id' in command for command in commands))
            self.assertTrue(result['terminal_access_enabled'])
            self.assertFalse(result['pairing_or_password_test_performed'])
            unchanged.assert_called_once_with(actual['neighbors'])

    def test_standalone_git_bundle_imports_and_ready_validation_without_repository(self):
        spec = importlib.util.spec_from_file_location('bundle_builder', ROOT / 'infra/kitchen-portal/package-device-activation.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory).resolve()
            repo, unpacked = directory / 'repo', directory / 'unpacked'
            repo.mkdir()
            unpacked.mkdir(mode=0o700)
            for name in builder.FILES:
                path = repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, path)
            for arguments in (['init', '-q'], ['add', '.'], ['-c', 'user.name=Synthetic', '-c',
                              'user.email=test@example.invalid', 'commit', '-qm', 'Synthetic operator fixture']):
                subprocess.run(['git', *arguments], cwd=repo, check=True, capture_output=True)
            source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
            # The builder must ignore a dirty worktree and use only the requested commit.
            (repo / builder.FILES[0]).write_text('raise RuntimeError("dirty workspace must not ship")')
            archive = directory / 'operator.tar.gz'
            result = builder.build(repo, source, archive)
            self.assertEqual(result['files'], 7)
            self.assertEqual(result['sha256'], p.sha(archive.read_bytes()))
            with tarfile.open(archive) as stream:
                self.assertEqual(set(stream.getnames()), {*builder.FILES, builder.MANIFEST})
                self.assertTrue(all(member.isfile() and member.mode == 0o600 for member in stream.getmembers()))
                stream.extractall(unpacked)  # All names above equal the fixed trusted allowlist.
            cloud, windows, manifest = evidence()
            cloud['source_sha'] = windows['source_sha'] = source
            program = """import importlib.util,json,sys
from types import SimpleNamespace
s=importlib.util.spec_from_file_location('packaged',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.check_bundle(sys.argv[2])
c,w,manifest=json.loads(sys.argv[3]);a=SimpleNamespace(expected_source_sha=sys.argv[2],branch_id=c['branch_id'],edge_device_id=c['edge_device_id'])
m.check_ready(c,w,a,manifest)
print('BUNDLE_READY_CHECKED')
"""
            command = [sys.executable, '-c', program, str(unpacked / builder.FILES[0]), source,
                       json.dumps([cloud, windows, manifest])]
            completed = subprocess.run(command, cwd=directory, text=True, capture_output=True)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout.strip(), 'BUNDLE_READY_CHECKED')
            (unpacked / 'infra/windows/native-device-access-worker.mjs').unlink()
            self.assertNotEqual(subprocess.run(command, cwd=directory, capture_output=True).returncode, 0)
            with self.assertRaises(ValueError):
                builder.build(repo, source, archive)


if __name__ == '__main__':
    unittest.main()
