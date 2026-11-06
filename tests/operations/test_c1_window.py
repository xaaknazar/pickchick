import copy
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('c1', ROOT / 'infra/staging/c1-window.py')
links = load('links', ROOT / 'infra/staging/auth-links-release.py')
NOW = datetime(2026, 11, 7, 19, 30, tzinfo=timezone.utc)  # 08.11 00:30 Almaty
SECRET = 'fixture-secret-do-not-log-123'


class FixtureHost:
    """No network, Docker or database. Execute the real transaction on copies."""
    def __init__(self, mutate=None):
        self.owned = False
        self.installs = 0
        self.mutate = mutate or (lambda h: None)
        self.events = []
        self.api = {'Image': 'sha256:pinned-image', 'Config': {
            'Labels': {r.REVISION: 'pinned-revision', 'com.docker.compose.config-hash': 'old'},
            'Env': [k + '=' + r.OLD + v for k, v in r.LINKS.items()] + ['SECRET=' + SECRET]}}
        self.neighbors = [{'name': '/bank', 'id': 'same-id', 'image': 'same-image',
                           'running': True, 'started': 'same-time',
                           'labels': {'com.docker.compose.config-hash': 'unchanged', 'opaque': SECRET}}]
        self.pointers = ['same-api', 'same-gateway']
        self.config = {'channel_selection': 'automatic', 'channels': ['telegram', 'sms'],
                       'consent_version': 'same-version', 'delivery_consent_required': True,
                       'enabled': True, 'privacy_url': r.OLD + 'privacy', 'terms_url': r.OLD + 'terms'}
        self.work_state = {**r.COUNTS, **r.FINGERPRINTS}
        self.ledger_state = 'ledger068-hash'
        self.raw = json.dumps({'services': {'api': {'image': 'pinned-image', 'environment': {
            **{k: r.OLD + v for k, v in r.LINKS.items()}, 'SECRET': SECRET}}}}, indent=2).encode()
        self.initial = copy.deepcopy((self.api, self.config, self.raw))
        self.payload = {'owner_id': 'ab75ec12-d1cd-46dd-a8cb-1c3523ed6996',
                        'approved_start_utc': '2026-11-07T19:30:00+00:00',
                        'approved_end_utc': '2026-11-08T02:00:00+00:00',
                        'api_image': self.api['Image'], 'api_revision': 'pinned-revision',
                        'pointers': self.pointers, 'compose_sha256': r.digest(self.raw),
                        'ledger_sha256': self.ledger_state}

    def read_compose(self): return self.raw
    def state(self):
        return copy.deepcopy({'api': self.api, 'neighbors': self.neighbors, 'pointers': self.pointers})
    def auth(self): return copy.deepcopy(self.config)
    def work(self): return copy.deepcopy(self.work_state)
    def ledger(self): return self.ledger_state
    def health(self): self.events.append('health')
    def availability(self): self.events.append('availability')
    def acquire(self): self.owned = True
    def lockcheck(self):
        if not self.owned:
            raise RuntimeError(SECRET)
    def save_backup(self, original): self.backup = original
    def backup_bytes(self): return self.backup
    def prepare(self, original): return links.candidate(original, self.payload['compose_sha256'])
    def persist(self, result): self.saved = copy.deepcopy(result)
    def release_lock(self): self.owned = False
    def install(self, data):
        self.installs += 1
        self.raw = data
        if self.installs == 1:
            self.api['Config']['Env'] = [s.replace(r.OLD, r.NEW) for s in self.api['Config']['Env']]
            self.api['Config']['Labels']['com.docker.compose.config-hash'] = 'new'
            self.api['Config']['Labels']['com.docker.compose.image'] = 'new-compose-metadata'
            self.config.update(terms_url=r.NEW+'terms', privacy_url=r.NEW+'privacy')
            self.mutate(self)
        else:
            self.api, self.config, self.raw = copy.deepcopy(self.initial)
            # Docker metadata can change again on rollback too.
            self.api['Config']['Labels']['com.docker.compose.config-hash'] = 'rollback'


class C1(unittest.TestCase):
    def execute(self, host=None, now=NOW):
        host = host or FixtureHost()
        # Guard against accidental use of a real server by the fixture tests.
        with patch.object(r.subprocess, 'run', side_effect=AssertionError('No subprocess')), \
                patch.object(r.urllib.request, 'urlopen', side_effect=AssertionError('No network')):
            result = r.execute(host.payload, host, r.Checks(), clock=lambda: now)
        serialized = json.dumps(result)
        self.assertNotIn(SECRET, serialized)
        self.assertNotIn(r.OLD, serialized)
        self.assertNotIn(r.NEW, serialized)
        for check in result['checks']:
            self.assertIn('check', check)
            self.assertIn('stage', check)
            self.assertIn('expected', check)
            self.assertIn('actual', check)
        return result, host

    def test_config_hash_change_with_two_urls_passes(self):
        result, host = self.execute()
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(host.installs, 1)
        self.assertTrue(result['lock_retained'])
        self.assertIn('availability', host.events)
        # Other response values (including a legacy advertised channel) unchanged.
        self.assertEqual(host.config['channels'], ['telegram', 'sms'])

    def stop(self, mutate, name, rollback='PASS'):
        result, host = self.execute(FixtureHost(mutate))
        self.assertEqual(result['status'], 'STOP')
        self.assertEqual(result['failure']['check'], name)
        self.assertEqual(result['failure']['stage'], 'postcheck')
        self.assertEqual(result['rollback'], rollback)
        self.assertEqual(host.installs, 2)
        self.assertEqual(result['lock_retained'], rollback != 'PASS')
        return result

    def test_image_change_stops(self):
        self.stop(lambda h: h.api.update(Image='different'), 'api.image_id')

    def test_revision_change_stops(self):
        self.stop(lambda h: h.api['Config']['Labels'].update({r.REVISION:'different'}), 'api.oci_revision')

    def test_missing_revision_stops(self):
        self.stop(lambda h: h.api['Config']['Labels'].pop(r.REVISION), 'api.oci_revision')

    def test_third_environment_key_change_stops(self):
        self.stop(lambda h: h.api['Config']['Env'].__setitem__(-1, 'SECRET=changed'), 'api.env.changed_keys')

    def test_added_environment_key_stops(self):
        self.stop(lambda h: h.api['Config']['Env'].append('EXTRA='+SECRET), 'api.env.keys')

    def test_removed_environment_key_stops(self):
        self.stop(lambda h: h.api['Config']['Env'].pop(), 'api.env.keys')

    def test_duplicate_environment_key_stops(self):
        self.stop(lambda h: h.api['Config']['Env'].append('SECRET='+SECRET), 'api.env.unique_keys')

    def test_wrong_new_url_stops(self):
        self.stop(lambda h: h.api['Config']['Env'].__setitem__(0, 'CUSTOMER_AUTH_TERMS_URL=wrong'), 'api.env.exact_values')

    def test_neighbor_label_change_stops_and_prevents_unlock(self):
        result = self.stop(lambda h: h.neighbors[0]['labels'].update(opaque='changed'), 'neighbors.full', 'FAIL')
        self.assertEqual(result['rollback_failure']['check'], 'rollback.neighbors')

    def test_neighbor_identity_and_liveness_changes_stop(self):
        for key, value in [('id','changed'),('image','changed'),('started','changed'),('running',False)]:
            with self.subTest(key=key):
                self.stop(lambda h: h.neighbors[0].update({key:value}), 'neighbors.full', 'FAIL')

    def test_extra_auth_key_stops(self):
        self.stop(lambda h: h.config.update(extra=SECRET), 'auth.after.keys')

    def test_missing_auth_key_stops(self):
        self.stop(lambda h: h.config.pop('channels'), 'auth.after.keys')

    def test_other_auth_values_cannot_change(self):
        for field, value in [('channels',['other']), ('consent_version','new'),
                             ('delivery_consent_required',False), ('enabled',1),
                             ('channel_selection','manual'), ('terms_url','wrong')]:
            with self.subTest(field=field):
                self.stop(lambda h: h.config.update({field:value}), 'auth.exact_values')

    def test_active_payment_stops_before_mutation(self):
        host = FixtureHost(); host.work_state['unsettled_qr'] = 1
        result, host = self.execute(host)
        self.assertEqual(result['failure']['check'], 'work.unsettled_qr')
        self.assertEqual(host.installs, 0)
        self.assertFalse(host.owned)

    def test_historical_set_drift_stops(self):
        host = FixtureHost(); host.work_state['edge_set_fingerprint'] = 'new'
        result, host = self.execute(host)
        self.assertEqual(result['failure']['check'], 'work.edge_set_fingerprint')
        self.assertEqual(host.installs, 0)

    def test_ledger_drift_after_install_stops(self):
        self.stop(lambda h: setattr(h, 'ledger_state', 'changed'), 'ledger.unchanged', 'FAIL')

    def test_exception_text_is_never_logged(self):
        def explode(host): raise ValueError(SECRET)
        result, host = self.execute(FixtureHost(explode))
        self.assertEqual(result['failure']['check'], 'install.api_only')
        self.assertEqual(result['failure']['actual']['error_type'], 'ValueError')
        self.assertEqual(result['rollback'], 'PASS')

    def test_rollback_failure_keeps_lock_and_original_failure(self):
        host = FixtureHost(lambda h: h.api.update(Image='bad'))
        install = host.install
        def failing_rollback(data):
            if host.installs: raise RuntimeError(SECRET)
            install(data)
        host.install = failing_rollback
        result, _ = self.execute(host)
        self.assertEqual(result['failure']['check'], 'api.image_id')
        self.assertEqual(result['rollback_failure']['check'], 'rollback.restore')
        self.assertTrue(result['lock_retained'])

    def test_no_old_or_expired_window_can_start(self):
        for now in [datetime(2026,11,7,19,29,tzinfo=timezone.utc),
                    datetime(2026,11,8,2,tzinfo=timezone.utc)]:
            result, host = self.execute(now=now)
            self.assertEqual(result['failure']['check'], 'window.current')
            self.assertEqual(host.installs, 0)

    def test_daytime_must_start_before_1600_almaty(self):
        host = FixtureHost(); host.payload.update(approved_start_utc='2026-11-06T10:00:00+00:00',
                                                 approved_end_utc='2026-11-06T14:00:00+00:00')
        result, host = self.execute(host, datetime(2026,11,6,11,tzinfo=timezone.utc))
        self.assertEqual(result['failure']['check'], 'window.start_deadline')
        self.assertEqual(host.installs, 0)

    def test_late_day_and_night_deadlines_refused(self):
        for start,end in [('2026-11-06T10:00:00+00:00','2026-11-06T14:01:00+00:00'),
                          ('2026-11-07T19:30:00+00:00','2026-11-08T02:01:00+00:00')]:
            host=FixtureHost();host.payload.update(approved_start_utc=start, approved_end_utc=end)
            result, host=self.execute(host)
            self.assertEqual(result['failure']['check'],'window.bounds')
            self.assertEqual(host.installs,0)

    def test_neighbor_snapshot_includes_all_labels(self):
        rows=[{'Name':'/bank','Id':'x','Image':'y','State':{'Running':True,'StartedAt':'z'},
               'Config':{'Labels':{'com.docker.compose.config-hash':'abc','custom':SECRET}}}]
        self.assertEqual(r.neighbors(rows)[0]['labels'],rows[0]['Config']['Labels'])

    def test_success_journal_failure_triggers_rollback(self):
        host = FixtureHost()
        persist = host.persist
        def fail_success(result):
            if result['status'] == 'PASS': raise OSError(SECRET)
            persist(result)
        host.persist = fail_success
        result, host = self.execute(host)
        self.assertEqual(result['status'], 'STOP')
        self.assertEqual(result['failure']['check'], 'journal.success')
        self.assertEqual(result['rollback'], 'PASS')
        self.assertEqual(host.installs, 2)

    def test_baseline_extra_key_stops_before_lock(self):
        host = FixtureHost(); host.config['extra'] = SECRET
        result, host = self.execute(host)
        self.assertEqual(result['failure']['check'], 'auth.before.keys')
        self.assertFalse(host.owned)
        self.assertEqual(host.installs, 0)

    def test_guard_survives_python_optimization(self):
        # Safety must use named explicit checks, never Python's removable assert.
        import ast
        tree=ast.parse((ROOT/'infra/staging/c1-window.py').read_text())
        self.assertFalse(any(isinstance(node,ast.Assert) for node in ast.walk(tree)))


if __name__ == '__main__':
    unittest.main()
