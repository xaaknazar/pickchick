"""Offline safety checks. No VPS, SSH, provider or real customer data calls."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('market_profile', ROOT / 'infra/staging/release-market.py')
market = importlib.util.module_from_spec(spec)
spec.loader.exec_module(market)
SHA = 'a' * 40


def proof():
    jobs = market.TRANSPORT_PROFILE.ci_jobs
    return {'run': {'head_sha': SHA, 'status': 'completed', 'conclusion': 'success',
                    'path': '.github/workflows/ci.yml',
                    'head_repository': {'full_name': 'xaaknazar/pickchick'}},
            'jobs': {'total_count': len(jobs), 'jobs': [
                {'name': name, 'head_sha': SHA, 'status': 'completed', 'conclusion': 'success'}
                for name in sorted(jobs)]}}


class ProfileTests(unittest.TestCase):
    def test_follow_on_baseline_is_distinct_from_historical_profile(self):
        p = market.TRANSPORT_PROFILE
        self.assertEqual(p.old_api, market.TRANSPORT_BASELINE)
        self.assertEqual(p.old_web, p.old_api)
        self.assertEqual(p.baseline_count, 13)
        self.assertEqual(p.migrations, ('014_cloud_fulfillment_transport.sql',))
        self.assertEqual(p.new_sequences, frozenset())
        self.assertEqual(len(market.TRANSPORT_TABLES), 6)
        instance = market.Release.__new__(market.Release)
        instance.profile = p
        instance.git = lambda *args: '\n'.join(f'db/cloud/migrations/{i:03d}_cloud.sql' for i in range(1, 14))
        self.assertEqual(len(instance.baseline_migrations()), 13)
        instance.profile = market.HISTORICAL_PROFILE
        with self.assertRaises(market.GuardFailure):
            instance.baseline_migrations()

    def test_six_exact_ci_jobs_reject_missing_duplicate_or_future_unreviewed_jobs(self):
        p = market.TRANSPORT_PROFILE
        market.verify_ci(proof(), SHA, p.ci_jobs, exact_jobs=p.exact_ci_jobs)
        for mutation in ['missing', 'duplicate', 'extra', 'wrong_sha', 'skipped']:
            value = copy.deepcopy(proof())
            rows = value['jobs']['jobs']
            if mutation == 'missing':
                rows.pop()
            elif mutation == 'duplicate':
                rows[-1] = rows[0]
            elif mutation == 'extra':
                rows.append({**rows[0], 'name': 'Unreviewed extra workflow'})
            elif mutation == 'wrong_sha':
                rows[0]['head_sha'] = 'b' * 40
            else:
                rows[0]['conclusion'] = 'skipped'
            value['jobs']['total_count'] = len(rows)
            with self.subTest(mutation=mutation), self.assertRaises(market.GuardFailure):
                market.verify_ci(value, SHA, p.ci_jobs, exact_jobs=p.exact_ci_jobs)

    def test_environment_preserves_unrelated_settings_and_forces_all_new_flags_off(self):
        p = market.TRANSPORT_PROFILE
        with tempfile.TemporaryDirectory() as directory:
            old, new = Path(directory) / 'old', Path(directory) / 'new'
            old.write_text(f'RELEASE_SHA={p.old_api}\nAPI_BIND=127.0.0.1\n'
                           'CLOUD_FULFILLMENT_TRANSPORT_ENABLED=true\nCUSTOMER_AUTH_ENABLED=true\n')
            subprocess.run([sys.executable, '-c', market.release_env_script(p), str(old), str(new), SHA, p.old_api],
                           check=True, capture_output=True)
            settings = dict(line.split('=', 1) for line in new.read_text().splitlines())
            self.assertEqual(settings, {'API_BIND': '127.0.0.1', 'RELEASE_SHA': SHA, **dict(p.settings)})
            self.assertEqual(new.stat().st_mode & 0o777, 0o600)


# Load the production coordinator and apply orchestrator, without invoking their CLIs.
spec = importlib.util.spec_from_file_location('transport_release', ROOT / 'infra/staging/release-transport.py')
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
import fcntl
import os
import uuid
from types import SimpleNamespace


class MaintenanceTests(unittest.TestCase):
    def test_closed_gateway_has_no_public_bypass_and_replaces_healthcheck(self):
        config = transport.maintenance_config()
        self.assertTrue(config['admin']['disabled'])
        servers = config['apps']['http']['servers']
        self.assertEqual(set(servers), {'closed', 'container_health'})
        self.assertEqual(servers['closed']['listen'], [':8080'])
        routes = servers['closed']['routes']
        self.assertEqual(len(routes), 1)
        self.assertEqual(set(routes[0]), {'handle'})  # No path/header exclusion.
        self.assertEqual(routes[0]['handle'][0]['status_code'], 503)
        self.assertEqual(servers['container_health']['listen'], ['127.0.0.1:8099'])
        self.assertNotIn('reverse_proxy', json.dumps(config))
        overlay = transport.maintenance_overlay('/private/owned')
        self.assertEqual(set(overlay['services']), {'gateway'})
        service = overlay['services']['gateway']
        self.assertNotIn('ports', service)
        self.assertTrue(service['volumes'][0]['read_only'])
        self.assertEqual(service['command'][-1], '/etc/caddy/maintenance.json')
        self.assertEqual(service['healthcheck']['test'][-1], 'http://127.0.0.1:8099/')

    def test_cron_must_stay_exactly_pinned_with_no_second_cleanup(self):
        sha = market.TRANSPORT_BASELINE
        line = f'*/15 * * * * /bin/bash {market.REMOTE}/releases/{sha}/infra/staging/identity-cleanup-cron.sh {sha}'
        text = '# BEGIN PICKCHICK IDENTITY CLEANUP\n' + line + '\n# END PICKCHICK IDENTITY CLEANUP\n'
        transport.check_cron(text)
        for wrong in [text.replace(sha, SHA), text.replace('*/15', '*/5'), text + line,
                      text + '0 * * * * node customer-identity-maintenance.mjs cleanup\n',
                      text + '# BEGIN PICKCHICK IDENTITY CLEANUP\n']:
            with self.assertRaises(transport.GuardFailure):
                transport.check_cron(wrong)

    def test_actual_detached_flock_is_owner_bound_and_persists_until_explicit_release(self):
        script = ROOT / 'infra/staging/release-maintenance-lock.py'
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            directory, lock = root / 'release', root / 'identity-cleanup.lock'
            directory.mkdir(mode=0o700)
            owner = str(uuid.uuid4())
            (directory / 'owner.json').write_text(json.dumps({'id': owner}))
            command = [sys.executable, str(script)]
            def run(action, who=owner):
                return subprocess.run(command + [action, str(directory), str(lock), who], capture_output=True, timeout=10)
            acquired = run('acquire')
            self.assertEqual(acquired.returncode, 0, acquired.stderr.decode())
            try:
                # Launcher already exited, holder is still alive and owns the real kernel flock.
                self.assertEqual(run('status').returncode, 0)
                self.assertNotEqual(run('release', str(uuid.uuid4())).returncode, 0)
                with open(lock, 'r+') as competing:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(competing.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(run('status').returncode, 0)
            finally:
                self.assertEqual(run('release').returncode, 0)
            with open(lock, 'r+') as available:
                fcntl.flock(available.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(available.fileno(), fcntl.LOCK_UN)
            self.assertEqual(run('release').returncode, 0)  # Exact owner release replay.
            self.assertTrue(all(p.stat().st_mode & 0o077 == 0 for p in directory.iterdir() if p.name != 'owner.json'))

    def test_actual_running_cleanup_cannot_be_stolen_or_aged_out(self):
        script = ROOT / 'infra/staging/release-maintenance-lock.py'
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            directory, lock = root / 'release', root / 'identity-cleanup.lock'
            directory.mkdir(mode=0o700)
            owner = str(uuid.uuid4())
            (directory / 'owner.json').write_text(json.dumps({'id': owner}))
            with open(lock, 'w+') as cleanup:
                fcntl.flock(cleanup.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = subprocess.run([sys.executable, str(script), 'acquire', str(directory), str(lock), owner],
                                        capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((directory / 'held.json').exists())
                with open(lock, 'r+') as second:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(second.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


class ApplyFixture(transport.TransportRelease):
    """Process doubles verify orchestration, not SQL or API semantics (Docker test covers those)."""
    def __init__(self, directory, fault=None):
        self.private, self.sha = Path(directory), SHA
        self.lock_owner = {'id': str(uuid.uuid4()), 'sha': SHA, 'action': 'apply'}
        self.args = SimpleNamespace(action='apply')
        self.phase = 'initial'
        self.opening_started = self.maintenance_attempted = self.cleanup_held = False
        self.events, self.fault = [], fault
        self.db = {'tables': {'catalog_draft_versions': {'rows': 1, 'sha256': 'saved-draft'}}, 'sequences': []}
        self.prepared = {'image_id': 'new', 'remote_artifacts': {'cleanup': {}, 'rollback_image': {'id': 'old'}},
                         'public_manifest': {}}

    def event(self, name):
        self.events.append(name)
        if self.fault and self.fault[0] == name:
            raise self.fault[1]

    def source_checks(self): pass
    def runtime_old(self): pass
    def verify_prepared(self): return self.prepared
    def health(self): return {}
    def catalogs(self): return []
    def ledger(self): return []
    def ledger_rows(self): return []
    def acl(self): return []
    def baseline_migrations(self): return []
    def fingerprint(self): return {}
    def prepared_artifacts(self, _): return self.prepared['remote_artifacts']
    def create_maintenance(self): self.event('prepare_maintenance')
    def cleanup(self, action):
        self.event('cleanup_' + action)
        if action == 'acquire': self.cleanup_held = True
        if action == 'release': self.cleanup_held = False
    def close_ingress(self):
        self.maintenance_attempted = True
        self.event('close')
    def stop_api(self): self.event('stop_api')
    def quiescent(self): self.event('quiescent')
    def snapshot(self):
        self.event('snapshot')
        if self.opening_started:
            raise AssertionError('Rowhash after opening would reject valid manager writes')
        return copy.deepcopy(self.db)
    def backup_restore(self, _):
        self.event('backup_restore')
        return {'restore': 'passed'}
    def migration_delta(self, *_): self.event('migration_delta')
    def private_probes(self, *_): self.event('private_probes')
    def disabled_private(self): pass
    def switch(self, *_): self.event('pointer_cas')
    def public_probes(self, *_):
        self.event('public_probes')
        self.db['tables']['catalog_draft_versions']['sha256'] = 'legitimate-edit-after-open'
    def remote(self, command, **_):
        if ' run ' in command:
            self.event('provision')
        elif ' up ' in command and command.endswith(' api'):
            self.event('old_api' if market.TRANSPORT_BASELINE in command else 'new_api')
        elif ' up ' in command and command.endswith(' gateway'):
            self.event('open')
        elif command.startswith('docker inspect'):
            return 'old'
        return ''
    def rollback_closed(self, *_):
        self.assertion = not self.opening_started and self.cleanup_held
        self.event('rollback')


class ApplyTests(unittest.TestCase):
    def test_success_orders_close_drain_snapshot_restore_old_compat_and_reopening(self):
        with tempfile.TemporaryDirectory() as directory:
            app = ApplyFixture(directory)
            app.apply()
            events = app.events
            for before, after in [('cleanup_acquire', 'close'), ('close', 'stop_api'),
                                  ('stop_api', 'snapshot'), ('snapshot', 'backup_restore'),
                                  ('backup_restore', 'provision'), ('provision', 'new_api'),
                                  ('new_api', 'old_api'), ('old_api', 'pointer_cas'),
                                  ('pointer_cas', 'open'), ('open', 'public_probes'),
                                  ('public_probes', 'cleanup_release')]:
                self.assertLess(events.index(before), events.index(after))
            self.assertEqual(events.count('provision'), 2)
            self.assertEqual(events.count('new_api'), 2)
            result = json.loads((Path(directory) / 'result.json').read_text())
            self.assertFalse(result['post_reopen_zero_dml_claim'])
            self.assertTrue(result['all_existing_data_verified_before_reopening'])

    def test_unknown_provision_does_not_open_rollback_release_or_erase(self):
        with tempfile.TemporaryDirectory() as directory:
            app = ApplyFixture(directory, ('provision', transport.CommandUncertain('Synthetic SSH unknown')))
            with self.assertRaises(transport.CommandUncertain): app.apply()
            self.assertNotIn('rollback', app.events)
            self.assertNotIn('open', app.events)
            self.assertNotIn('cleanup_release', app.events)
            self.assertTrue(app.cleanup_held)
            evidence = json.loads((Path(directory) / 'uncertain.json').read_text())
            self.assertTrue(evidence['deployment_lock_retained'])
            self.assertEqual(evidence['ingress'], 'maintenance_expected_verify_actual')

    def test_definite_failure_rolls_back_only_inside_proven_quiescent_window(self):
        with tempfile.TemporaryDirectory() as directory:
            app = ApplyFixture(directory, ('provision', transport.GuardFailure('Synthetic provision rejection')))
            with self.assertRaises(transport.GuardFailure): app.apply()
            self.assertEqual(app.events.count('rollback'), 1)
            self.assertTrue(app.assertion)
        with tempfile.TemporaryDirectory() as directory:
            app = ApplyFixture(directory, ('stop_api', transport.GuardFailure('Cannot prove drained API')))
            with self.assertRaises(transport.GuardFailure): app.apply()
            self.assertNotIn('rollback', app.events)
            self.assertNotIn('open', app.events)

    def test_unknown_open_or_failure_after_open_never_assumes_no_concurrent_manager_writes(self):
        for event, error in [('open', transport.CommandUncertain('Unknown Docker reopen')),
                             ('public_probes', transport.GuardFailure('Public health failure'))]:
            with self.subTest(event=event), tempfile.TemporaryDirectory() as directory:
                app = ApplyFixture(directory, (event, error))
                with self.assertRaises(type(error)): app.apply()
                self.assertNotIn('rollback', app.events)
                self.assertNotIn('cleanup_release', app.events)
                value = json.loads((Path(directory) / 'uncertain.json').read_text())
                self.assertEqual(value['ingress'], 'unknown_or_opening')

    def test_cms_same_count_edit_inside_closed_window_is_not_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            app = ApplyFixture(directory)
            before = {'database': copy.deepcopy(app.db), 'ledger': [], 'acl': []}
            app.db['tables']['catalog_draft_versions']['sha256'] = 'conflicting-owner-edit'
            with self.assertRaises(transport.GuardFailure):
                app.check_data(before)


class EntryPointTests(unittest.TestCase):
    def test_historical_apply_and_rollback_reject_follow_on_before_any_call(self):
        instance = market.Release.__new__(market.Release)
        instance.profile = market.TRANSPORT_PROFILE
        calls = []
        instance.source_checks = instance.remote = lambda *args: calls.append(args)
        with self.assertRaises(market.GuardFailure): instance.apply()
        with self.assertRaises(market.GuardFailure): instance.rollback(None, None, None, None, None)
        self.assertEqual(calls, [])



class PointerTests(unittest.TestCase):
    def test_actual_pointer_CAS_cannot_replace_foreign_target_or_reuse_temporary_link(self):
        import shlex
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for name in ['old', 'new', 'foreign']: (root / name).mkdir()
            pointer = root / 'current'
            pointer.symlink_to(root / 'old')
            instance = market.Release.__new__(market.Release)
            def execute(command):
                result = subprocess.run(shlex.split(command), capture_output=True)
                if result.returncode: raise market.GuardFailure('CAS rejected')
            instance.remote = execute
            instance.switch(str(pointer), str(root / 'old'), str(root / 'new'))
            self.assertEqual(pointer.resolve(), root / 'new')
            pointer.unlink(); pointer.symlink_to(root / 'foreign')
            with self.assertRaises(market.GuardFailure):
                instance.switch(str(pointer), str(root / 'old'), str(root / 'new'))
            self.assertEqual(pointer.resolve(), root / 'foreign')
            pointer.unlink(); pointer.symlink_to(root / 'old')
            (root / 'current.market-next').symlink_to(root / 'foreign')
            with self.assertRaises(market.GuardFailure):
                instance.switch(str(pointer), str(root / 'old'), str(root / 'new'))
            self.assertEqual(pointer.resolve(), root / 'old')



class MaintenancePermissionTests(unittest.TestCase):
    def test_only_static_caddy_config_is_readable_while_owner_and_compose_stay_private(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve() / 'maintenance'
            contents = {'maintenance.json': json.dumps(transport.maintenance_config()),
                        'owner.json': '{"id":"synthetic-owner"}', 'compose.json': '{}'}
            subprocess.run([sys.executable, '-c', transport.maintenance_write_script(), str(directory)],
                           input=json.dumps(contents).encode(), check=True, capture_output=True)
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            for name, mode in [('maintenance.json', 0o644), ('owner.json', 0o600), ('compose.json', 0o600)]:
                self.assertEqual((directory / name).stat().st_mode & 0o777, mode)
                self.assertEqual((directory / name).read_text(), contents[name])

    def test_preflight_validate_uses_the_same_DAC_restrictions_before_gateway_changes(self):
        import shlex
        args = shlex.split(transport.caddy_validation_command('/private/owned/maintenance.json'))
        for flag in ['--read-only', '--rm']: self.assertIn(flag, args)
        self.assertEqual(args[args.index('--cap-drop') + 1], 'ALL')
        self.assertEqual(args[args.index('--cap-add') + 1], 'NET_BIND_SERVICE')
        self.assertEqual(args[args.index('--security-opt') + 1], 'no-new-privileges:true')
        self.assertEqual(args[args.index('--network') + 1], 'none')
        self.assertNotIn('DAC_OVERRIDE', args)
        self.assertEqual(args[-3:], ['validate', '--config', '/tmp/maintenance.json'])


if __name__ == '__main__':
    unittest.main()
