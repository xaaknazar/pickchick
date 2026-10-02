import copy
import importlib.util
from pathlib import Path
import sys
import json
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('connection_release', ROOT/'infra/staging/release-connection-recovery.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)

COMPOSE = '''x-api: &api
  image: pickchick-api:${RELEASE_SHA:?Set verified release SHA}
services:
  api:
    env_file: [/private/customer-auth.env, /private/customer-kaspi-all.env]
    environment:
      APP_ENV: staging
      CLOUD_FULFILLMENT_TRANSPORT_ENABLED: "true"
      CUSTOMER_KASPI_PILOT_ENABLED: "true"
    ports: ["127.0.0.1:13100:3100"]
  provision:
    environment:
      APP_ENV: staging
  postgres:
    image: pinned-postgres
'''


class ConnectionRelease(unittest.TestCase):
    def test_exact_baseline_no_migrations_full_ci(self):
        args = SimpleNamespace(expected_api_sha=r.BASELINE, expected_public_sha=r.BASELINE,
                               expected_gateway_sha256=r.GATEWAY_BASELINE)
        with patch.object(r.market.Release, '__init__') as init:
            r.Release(args)
        profile = init.call_args.args[2]
        self.assertEqual(profile.baseline_count, 32)
        self.assertEqual(profile.migrations, ())
        self.assertEqual(profile.settings, ())
        self.assertEqual(profile.ci_jobs, r.market.TRANSPORT_PROFILE.ci_jobs)
        self.assertTrue(profile.exact_ci_jobs)
        for field in vars(args):
            bad = copy.copy(args)
            setattr(bad, field, '0'*len(getattr(args, field)))
            with self.subTest(field=field), self.assertRaises(r.market.GuardFailure):
                r.Release(bad)

    def test_failed_ci_blocks_prepare_and_apply_before_remote_actions(self):
        obj = object.__new__(r.Release)
        calls = []
        obj.source_checks = lambda: None
        def ci():
            raise r.market.GuardFailure('CI not green')
        obj.ci = ci
        obj.remote = lambda *args, **kwargs: calls.append(args)
        for action in ['prepare', 'apply']:
            with self.subTest(action=action), self.assertRaises(r.market.GuardFailure):
                getattr(obj, action)()
        self.assertEqual(calls, [])

    def test_compose_changes_only_api_hours(self):
        with patch.object(r, 'COMPOSE_BASELINE', r.market.digest(COMPOSE.encode())):
            candidate = r.api_compose_candidate(COMPOSE)
        for key, value in r.HOURS.items():
            self.assertEqual(candidate.count(key), 1)
            candidate = candidate.replace('      '+key+': "'+value+'"\n', '')
        self.assertEqual(candidate, COMPOSE)
        self.assertEqual(r.HOURS, {'CUSTOMER_KASPI_OPENING_TIME': '10:00',
                                  'CUSTOMER_KASPI_CLOSING_TIME': '00:00',
                                  'CUSTOMER_KASPI_TIMEZONE': 'Asia/Almaty'})

    def test_compose_rejects_unknown_or_already_configured(self):
        with self.assertRaises(r.market.GuardFailure):
            r.api_compose_candidate(COMPOSE)
        for raw in [COMPOSE+COMPOSE, COMPOSE.replace('  api:', '  api-other:'),
                    COMPOSE.replace('      APP_ENV: staging', '      APP_ENV: local'),
                    COMPOSE+'# CUSTOMER_KASPI_TIMEZONE=unreviewed\n']:
            with patch.object(r, 'COMPOSE_BASELINE', r.market.digest(raw.encode())):
                with self.subTest(raw=raw[-40:]), self.assertRaises(r.market.GuardFailure):
                    r.api_compose_candidate(raw)

    def test_no_data_acl_or_ledger_delta_allowed(self):
        before = {'ledger': [{'version': '032', 'checksum': 'original'}], 'acl': [{'privilege': 'SELECT'}],
                  'data': {'tables': {'orders': {'rows': 1, 'sha256': 'original'}}, 'sequences': [{'sequencename': 'orders_seq', 'last_value': 4}]}}
        obj = object.__new__(r.Release)
        obj.ledger = lambda: before['ledger']
        obj.acl = lambda: before['acl']
        obj.snapshot = lambda: before['data']
        obj.verify_data(before)
        for field in ['ledger', 'acl', 'data']:
            obj.ledger = lambda: before['ledger']
            obj.acl = lambda: before['acl']
            obj.snapshot = lambda: before['data']
            if field == 'data':
                after = copy.deepcopy(before['data'])
                after['sequences'][0]['last_value'] += 1
                obj.snapshot = lambda: after
            else:
                setattr(obj, field, lambda: [])
            with self.subTest(field=field), self.assertRaises(r.market.GuardFailure):
                obj.verify_data(before)

    def test_published_hours_require_exact_contract_and_boolean(self):
        obj = object.__new__(r.Release)
        valid = {'hours': {'openingTime': '10:00', 'closingTime': '00:00', 'timeZone': 'Asia/Almaty'},
                 'orderingOpen': True}
        obj.http_json = lambda *_: valid
        obj.verify_hours()
        for after in [{**valid, 'hours': {**valid['hours'], 'closingTime': '23:59'}},
                      {**valid, 'orderingOpen': 'true'}, {'hours': valid['hours']},
                      {**valid, 'hours': None}]:
            obj.http_json = lambda *_: after
            with self.assertRaises(r.market.GuardFailure):
                obj.verify_hours()

    def test_apply_executes_only_api_switch_and_preserves_public_and_bank(self):
        for drift in [False, True]:
            with tempfile.TemporaryDirectory() as tmp:
                obj = object.__new__(r.Release)
                obj.sha = 'a'*40
                obj.private = Path(tmp)
                key = obj.private/'backup.agekey'
                key.write_text('synthetic')
                key.chmod(0o600)
                obj.args = SimpleNamespace(backup_identity=key)
                obj.lock_owner = {'id': 'synthetic-owner'}
                artifacts = {'image_id': 'sha256:synthetic'}
                (obj.private/'prepared.json').write_text(json.dumps({'sha': obj.sha, 'old_api': r.BASELINE,
                    'old_web': r.BASELINE, 'artifacts': artifacts}))
                commands, switches, locks = [], [], []
                obj.source_checks = lambda: None
                obj.ci = lambda: None
                obj.runtime_old = lambda: None
                obj.api_artifacts = lambda: artifacts
                obj.cleanup = lambda action: locks.append(action)
                obj.quiescent = lambda: None
                obj.psql = lambda *_: '0'
                obj.snapshot = lambda: {'tables': {}, 'sequences': []}
                obj.ledger = lambda: []
                obj.acl = lambda: []
                obj.baseline_migrations = lambda: []
                obj.save = lambda *_: None
                obj.backup_restore = lambda *_: {'restore': 'passed'}
                count = [0]
                def fingerprint():
                    count[0] += 1
                    return {'bank': 'changed' if drift and count[0] > 1 else 'unchanged'}
                obj.fingerprint = fingerprint
                obj.http_json = lambda *_args, **_kwargs: {'ready': True}
                obj.verify_capabilities = lambda *_: None
                obj.verify_public = lambda: None
                obj.verify_hours = lambda: None
                obj.switch = lambda *args: switches.append(args)
                def remote(command, **kwargs):
                    commands.append(command)
                    if '.Config.Env' in command:
                        return json.dumps([k+'='+v for k, v in r.HOURS.items()])
                    if '{{.Image}}' in command:
                        return 'sha256:synthetic'
                    if 'readlink -f' in command:
                        return r.market.REMOTE+'/public-https/releases/'+r.BASELINE
                    if 'sha256sum /etc/caddy/Caddyfile' in command:
                        return r.GATEWAY_BASELINE+'  /etc/caddy/Caddyfile'
                    return ''
                obj.remote = remote
                if drift:
                    with self.assertRaises(r.market.GuardFailure):
                        obj.apply()
                    self.assertEqual(switches, [])
                    self.assertEqual(locks, ['acquire'])
                else:
                    obj.apply()
                    self.assertEqual(len(switches), 1)
                    self.assertEqual(switches[0][0], r.market.REMOTE+'/current')
                    self.assertEqual(locks, ['acquire', 'release'])
                self.assertFalse(any(' provision' in command or 'migrate' in command for command in commands))
                self.assertFalse(any('kaspi-worker' in command for command in commands))
                self.assertTrue(all(r.BASELINE in command for command in commands if ' gateway' in command))

    def test_apply_has_api_only_cas_and_no_provision_or_public_replacement(self):
        import inspect
        source = inspect.getsource(r.Release.apply)
        self.assertNotIn('run --rm', source)
        self.assertEqual(source.count('self.switch('), 1)
        self.assertIn("self.switch(market.REMOTE+'/current'", source)
        self.assertIn("self.source_checks(); self.ci(); self.runtime_old()", source)
        self.assertIn("self.backup_restore(before['data'])", source)
        self.assertIn('self.cleanup(\'acquire\')', source)
        self.assertIn('self.verify_data(before)', source)
        self.assertIn('self.api_artifacts() == proof[\'artifacts\']', source)
        self.assertIn('self.fingerprint() == before[\'neighbors\']', source)
        self.assertIn('GATEWAY_BASELINE', source)
        self.assertIn("market.web_compose(BASELINE)", source)


if __name__ == '__main__':
    unittest.main()
