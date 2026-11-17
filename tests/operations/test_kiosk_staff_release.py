"""Synthetic fixtures only: no daemon, network, secrets or deployment required."""
import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'infra/staging/kiosk-staff-release.py'
SPEC = importlib.util.spec_from_file_location('kiosk_staff_release', SOURCE)
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)
VERIFIER = 'scrypt1$' + 'a' * 32 + '$' + 'b' * 64


def work():
    return {'active': {'pending_payment_attempts': 0, 'unsettled_invoices': 0,
                      'unsettled_qr': 0, 'pending_refunds': 0, 'active_cloud_kitchen': 0,
                      'paid_open_total': 0, 'paid_created_on_or_after_cutoff': 0,
                      'edge_active_total': 58, 'edge_created_on_or_after_cutoff': 4,
                      'edge_set_fingerprint': '081db7135f64e160d825901abaa02c64'},
            'detail': {'total': 58, 'invalid': 0, 'latest': '2026-11-12T10:00:00+05:00'},
            'tables': {'commerce_orders': 'synthetic-orders'}}


def container(name, environment, image='sha256:' + '1' * 64):
    identifier = ('a' if name == r.API else 'b') * 64
    return {'Id': identifier, 'Name': '/' + name, 'Image': image, 'Created': 'original',
            'Config': {'Image': 'pickchick-api:' + r.REVISION, 'Env': environment,
                       'Hostname': identifier[:12], 'Labels': {
                           'com.docker.compose.project': 'pickchick-staging',
                           'com.docker.compose.service': 'api',
                           'com.docker.compose.project.config_files': str(r.COMPOSE),
                           'com.docker.compose.config-hash': 'old', 'custom.label': 'preserve'}},
            'HostConfig': {'Binds': ['/safe/source:/safe/target:ro'], 'ReadonlyRootfs': True},
            'Mounts': [{'Type': 'bind', 'Source': '/safe/source', 'Destination': '/safe/target', 'RW': False}],
            'NetworkSettings': {'Networks': {'private': {'NetworkID': 'stable-network',
                'IPAMConfig': None, 'EndpointID': 'old-endpoint', 'IPAddress': '10.0.0.2',
                'Aliases': ['api', identifier[:12]], 'DNSNames': ['api', identifier[:12]]}}},
            'RestartCount': 0, 'Path': 'node', 'Args': ['api.js'],
            'State': {'Status': 'running', 'Running': True, 'StartedAt': 'old-start',
                      'Health': {'Status': 'healthy'}}}


class FixtureRunner(r.Runner):
    def __init__(self, directory):
        super().__init__(directory)
        self.containers = {r.API: container(r.API, ['PATH=/bin', 'APP_ENV=staging']),
                           r.DB: container(r.DB, ['POSTGRES_DB=synthetic'])}
        self.database_value = {'schema': 'schema', 'acl_ledger': ['acl'], 'bindings': ['binding']}
        self.work_value = work()
        self.commands = []
        self.events = []
        self.revision = r.REVISION
        self.image_id = self.containers[r.API]['Image']
        self.after_up = lambda: None

    def command(self, args, data=None, timeout=180):
        self.commands.append(args)
        if args[:2] == ['image', 'inspect']:
            return r.encoded([{'Id': self.image_id, 'Config': {'Env': ['PATH=/bin'],
                'Labels': {'org.opencontainers.image.revision': self.revision}}}])
        if 'config' in args:
            raw = json.loads(Path(args[args.index('-f') + 1]).read_bytes())
            # Compose config renders literal dollars as $$; up passes a single $.
            return r.encoded(raw)
        if 'up' in args:
            self.events.append('up')
            api = self.containers[r.API]
            old_id = api['Id']
            api['Id'] = ('c' if old_id[0] != 'c' else 'd') * 64
            api['Config']['Hostname'] = api['Id'][:12]
            config = self.resolved()['services']['api']
            api['Config']['Env'] = ['PATH=/bin'] + [k + '=' + v.replace('$$', '$') for k, v in config['environment'].items()]
            api['Config']['Labels']['com.docker.compose.config-hash'] = 'new'
            api['State']['StartedAt'] = 'new-start'
            network = api['NetworkSettings']['Networks']['private']
            network.update(EndpointID='new-endpoint', IPAddress='10.0.0.9',
                           Aliases=['api', api['Id'][:12]], DNSNames=['api', api['Id'][:12]])
            self.after_up()
            return b''
        raise AssertionError('Unexpected synthetic command')

    def inventory(self):
        return copy.deepcopy(self.containers)

    def database(self):
        return copy.deepcopy(self.database_value)

    def work(self):
        self.events.append('work')
        return copy.deepcopy(self.work_value)

    def probes(self):
        return {'ready': True, 'auth': {'enabled': True}, 'availability': {'enabled': True}}


class OperatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.private = self.root / 'private'
        self.private.mkdir(mode=0o700)
        self.compose = self.root / 'compose.yaml'
        self.envs = (self.root / 'staging.env', self.root / 'release.env')
        for path in self.envs:
            path.write_text('SYNTHETIC=yes\n')
        for name, value in [('COMPOSE', self.compose), ('ENV_FILES', self.envs), ('LOCK', self.root / '.market-release.lock')]:
            patcher = patch.object(r, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.original = r.encoded({'name': 'pickchick-staging', 'services': {
            'api': {'image': 'pickchick-api:' + r.REVISION, 'environment': {'APP_ENV': 'staging'}},
            'cloud-db': {'environment': {}}, 'redis-cache': {'environment': {}}}})
        self.compose.write_bytes(self.original)
        self.compose.chmod(0o640)
        self.runner = FixtureRunner(self.private)
        result = self.runner.inspect()
        self.runner.baseline_hash = result['baseline_sha256']
        now = dt.datetime.now(dt.timezone.utc)
        self.proof = {'format': 'pickchick-kiosk-staff-work-v1', 'owner_approved': True,
                      'baseline_sha256': self.runner.baseline_hash, 'approved_at': now.isoformat(),
                      'expires_at': (now + dt.timedelta(minutes=30)).isoformat(), 'work': work()}
        r.save(self.private / 'expected-work.json', r.encoded(self.proof))
        r.save(self.private / 'verifier.env', (r.KEY + '=' + VERIFIER + '\n').encode())

    def test_apply_and_rollback_preserve_bytes_runtime_neighbors_and_private_evidence(self):
        before = self.runner.inventory()
        result = self.runner.apply()
        self.assertEqual(result['status'], 'APPLIED')
        raw = self.compose.read_bytes()
        self.assertIn(VERIFIER.replace('$', '$$').encode(), raw)
        self.assertEqual(r.env_map(self.runner.containers[r.API]['Config']['Env'])[r.KEY], VERIFIER)
        self.assertEqual(self.compose.stat().st_mode & 0o777, 0o600)
        self.assertEqual(before[r.DB], self.runner.containers[r.DB])
        self.assertFalse(r.LOCK.exists())
        self.assertEqual(self.runner.rollback(result['owner_id'])['status'], 'ROLLED_BACK')
        self.assertEqual(self.compose.read_bytes(), self.original)
        self.assertEqual(self.compose.stat().st_mode & 0o777, 0o640)
        self.assertEqual(before[r.DB], self.runner.containers[r.DB])
        self.assertNotIn(r.KEY, r.env_map(self.runner.containers[r.API]['Config']['Env']))
        for path in self.private.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        for command in self.runner.commands:
            if 'up' in command:
                self.assertEqual(command[command.index('up'):], ['up', '-d', '--no-deps', '--no-build',
                    '--pull', 'never', '--wait', '--wait-timeout', '120', 'api'])
                self.assertEqual(command[command.index('-f') + 1], str(self.compose))
        for index, event in enumerate(self.runner.events):
            if event == 'up':
                self.assertEqual(self.runner.events[index - 1:index + 2], ['work', 'up', 'work'])

    def test_missing_or_unapproved_work_proof_blocks_before_lock(self):
        for approved in (False, 'true', None):
            r.save(self.private / 'expected-work.json', r.encoded({**self.proof, 'owner_approved': approved}), replace=True)
            with self.assertRaisesRegex(r.Stop, 'work.owner_approval_required'):
                self.runner.apply()
            self.assertFalse(r.LOCK.exists())

    def test_baseline_drift_stops_before_mutation(self):
        cases = ('env', 'image', 'revision', 'neighbor', 'binding', 'schema', 'acl', 'work', 'compose', 'inputs')
        for case in cases:
            with self.subTest(case=case):
                containers, database = copy.deepcopy(self.runner.containers), copy.deepcopy(self.runner.database_value)
                if case == 'env': self.runner.containers[r.API]['Config']['Env'].append('THIRD_KEY=changed')
                if case == 'image': self.runner.image_id = 'sha256:' + '2' * 64
                if case == 'revision': self.runner.revision = '0' * 40
                if case == 'neighbor': self.runner.containers[r.DB]['State']['StartedAt'] = 'changed'
                if case in ('binding', 'schema', 'acl'):
                    self.runner.database_value[{'binding': 'bindings', 'schema': 'schema', 'acl': 'acl_ledger'}[case]] = 'changed'
                if case == 'work': self.runner.work_value['tables']['commerce_orders'] = 'changed'
                if case == 'compose': self.compose.write_bytes(self.original + b' ')
                if case == 'inputs': self.envs[0].write_text('SYNTHETIC=changed')
                with self.assertRaises(r.Stop): self.runner.apply()
                self.assertFalse(r.LOCK.exists())
                self.assertNotIn('up', self.runner.events)
                self.runner.containers, self.runner.database_value = containers, database
                self.runner.revision, self.runner.image_id = r.REVISION, containers[r.API]['Image']
                self.runner.work_value = work()
                self.compose.write_bytes(self.original)
                self.envs[0].write_text('SYNTHETIC=yes\n')

    def test_only_one_resolved_environment_addition_is_allowed(self):
        old = self.runner.resolved()
        new = copy.deepcopy(old)
        new['services']['api']['environment'][r.KEY] = VERIFIER.replace('$', '$$')
        r.only_verifier(old, new, VERIFIER)
        for case in ('third-key', 'image', 'neighbor', 'unescaped-value', 'double-escaped-value'):
            bad = copy.deepcopy(new)
            if case == 'third-key': bad['services']['api']['environment']['OTHER'] = 'new'
            if case == 'image': bad['services']['api']['image'] = 'other'
            if case == 'neighbor': bad['services']['cloud-db']['environment']['OTHER'] = 'new'
            if case == 'unescaped-value': bad['services']['api']['environment'][r.KEY] = VERIFIER
            if case == 'double-escaped-value': bad['services']['api']['environment'][r.KEY] = VERIFIER.replace('$', '$$$$')
            with self.assertRaisesRegex(r.Stop, 'compose.only_verifier'): r.only_verifier(old, bad, VERIFIER)

    def test_runtime_preserves_non_compose_labels_mounts_network_and_config(self):
        original = self.runner.containers[r.API]
        for case in ('label', 'mount', 'network', 'config', 'image'):
            bad = copy.deepcopy(original)
            if case == 'label': bad['Config']['Labels']['custom.label'] = 'changed'
            if case == 'mount': bad['Mounts'][0]['RW'] = True
            if case == 'network': bad['NetworkSettings']['Networks']['private']['NetworkID'] = 'changed'
            if case == 'config': bad['HostConfig']['ReadonlyRootfs'] = False
            if case == 'image': bad['Image'] = 'other'
            with self.subTest(case=case), self.assertRaises(r.Stop): r.check_runtime(original, bad)

    def test_foreign_lock_never_deleted_even_on_rollback(self):
        result = self.runner.apply()
        r.LOCK.mkdir(mode=0o700)
        foreign = {'id': 'foreign'}
        r.save(r.LOCK / 'owner.json', r.encoded(foreign))
        with self.assertRaisesRegex(r.Stop, 'lock.foreign'):
            self.runner.rollback(result['owner_id'])
        self.assertEqual(json.loads((r.LOCK / 'owner.json').read_bytes()), foreign)
        with self.assertRaisesRegex(r.Stop, 'lock.exists'): self.runner.preflight()

    def test_known_failure_retains_owned_lock_and_explicit_rollback_works(self):
        def fail(): raise r.Stop('fixture.known_failure')
        self.runner.after_up = fail
        with self.assertRaisesRegex(r.Stop, 'fixture.known_failure'): self.runner.apply()
        state = self.runner.json('state.json')
        self.assertEqual(state['status'], 'failed')
        self.assertTrue(r.LOCK.exists())
        self.runner.after_up = lambda: None
        self.assertEqual(self.runner.rollback(state['owner']['id'])['status'], 'ROLLED_BACK')

    def test_uncertain_completion_retains_lock_and_blocks_rollback(self):
        def fail(): raise r.Uncertain('command.completion_unknown')
        self.runner.after_up = fail
        with self.assertRaises(r.Uncertain): self.runner.apply()
        state = self.runner.json('state.json')
        self.assertEqual(state['status'], 'uncertain')
        self.assertTrue(r.LOCK.exists())
        with self.assertRaisesRegex(r.Stop, 'rollback.uncertain_requires_review'):
            self.runner.rollback(state['owner']['id'])

    def test_changed_work_immediately_before_dispatch_prevents_recreation(self):
        original_journal = self.runner.journal
        def journal(**values):
            original_journal(**values)
            if values.get('status') == 'dispatching': self.runner.work_value['active']['edge_set_fingerprint'] = 'changed'
        self.runner.journal = journal
        with self.assertRaisesRegex(r.Stop, 'work.changed'): self.runner.apply()
        self.assertNotIn('up', self.runner.events)
        self.assertTrue(r.LOCK.exists())

    def test_changed_work_after_recreation_is_not_autoaccepted(self):
        self.runner.after_up = lambda: self.runner.work_value['tables'].update(commerce_orders='changed')
        with self.assertRaisesRegex(r.Stop, 'work.changed'): self.runner.apply()
        self.assertTrue(r.LOCK.exists())
        with self.assertRaisesRegex(r.Stop, 'work.changed'):
            self.runner.rollback(self.runner.json('state.json')['owner']['id'])

    def test_foreign_compose_cas_and_candidate_tampering(self):
        self.runner.preflight()
        path = self.private / 'candidate.compose.json'
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaisesRegex(r.Stop, 'candidate.changed'): self.runner.apply()
        self.assertEqual(self.compose.read_bytes(), self.original)
        with self.assertRaisesRegex(r.Stop, 'compose.cas'):
            self.runner.live_compose(self.original + b' ', [0o640, os.geteuid(), os.getegid()])

    def test_work_exception_requires_exact_approval_fingerprint_and_unpaid_old_rows(self):
        for case in ('expiry', 'pending', 'fingerprint', 'count', 'capture', 'recent', 'baseline'):
            proof, observed = copy.deepcopy(self.proof), work()
            if case == 'expiry': proof['expires_at'] = proof['approved_at']
            if case == 'pending': observed['active']['pending_payment_attempts'] = 1
            if case == 'fingerprint': observed['active']['edge_set_fingerprint'] = 'changed'
            if case == 'count': observed['active']['edge_active_total'] = 59
            if case == 'capture': observed['detail']['invalid'] = 1
            if case == 'recent': observed['detail']['latest'] = '2026-11-13T00:00:00+05:00'
            if case == 'baseline': proof['baseline_sha256'] = 'other'
            proof['work'] = observed
            with self.subTest(case=case), self.assertRaises(r.Stop):
                r.check_work(proof, observed, self.runner.baseline_hash)

    def test_protected_input_and_duplicate_json(self):
        path = self.private / 'verifier.env'
        self.assertEqual(r.verifier(r.read(path, True)), VERIFIER)
        path.chmod(0o644)
        with self.assertRaisesRegex(r.Stop, 'file.private_required'): r.read(path, True)
        for data in (b'1234', (r.KEY + '=' + VERIFIER + '\nOTHER=bad').encode()):
            with self.assertRaisesRegex(r.Stop, 'input.verifier_format'): r.verifier(data)
        with self.assertRaisesRegex(r.Stop, 'input.duplicate_key'): r.decode(b'{"a":1,"a":2}')

    def test_queries_are_read_only_and_exclude_worker_bookkeeping_not_business_fields(self):
        queries = []
        self.runner.sql = lambda query: queries.append(query) or [{}, {}, {}]
        with self.assertRaises(KeyError): r.Runner.work(self.runner)
        query = queries[0]
        self.assertIn('REPEATABLE READ READ ONLY', query)
        self.assertIn('commerce_captures', query)
        self.assertIn("-ARRAY['checks','next_check_at','lease_token','lease_until','delivered_at']", query)
        self.assertNotIn("'amount_minor'", query)
        self.assertNotIn("'state_changed_at'", query)
        for mutation in ('INSERT ', 'UPDATE ', 'DELETE ', 'ALTER ', 'GRANT '): self.assertNotIn(mutation, query)
        self.assertNotIn('-ARRAY', r.table_hashes(r.BINDING_TABLES))

    def test_safe_cli_and_subprocess_failures_do_not_echo_output_or_ambient_env(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertEqual(r.main(['--unknown=' + VERIFIER]), 1)
        self.assertNotIn(VERIFIER, output.getvalue())
        with patch.object(r.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, VERIFIER.encode(), VERIFIER.encode())) as run:
            with patch.dict(os.environ, {'COMPOSE_FILE': 'foreign', r.KEY: VERIFIER, 'RELEASE_SHA': 'foreign'}):
                with self.assertRaisesRegex(r.Stop, '^command.failed$'): r.Runner.command(self.runner, ['ps'])
            self.assertEqual(set(run.call_args.kwargs['env']), {'PATH', 'LANG'})

    def test_import_has_no_process_network_or_write_side_effects(self):
        spec = importlib.util.spec_from_file_location('kiosk_staff_import_fixture', SOURCE)
        module = importlib.util.module_from_spec(spec)
        with patch('subprocess.run', side_effect=AssertionError('process on import')), \
             patch('urllib.request.build_opener', side_effect=AssertionError('network on import')), \
             patch('os.open', side_effect=AssertionError('write on import')), \
             patch('signal.signal', side_effect=AssertionError('signal on import')):
            spec.loader.exec_module(module)


if __name__ == '__main__':
    unittest.main()
