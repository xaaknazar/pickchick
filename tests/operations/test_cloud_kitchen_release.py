import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('cloud_kitchen_release', ROOT/'infra/staging/release-cloud-kitchen.py')
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
G = r.market.GuardFailure
SHA, OTHER = 'a'*40, 'f'*40
COMPOSE = ('name: pickchick-staging\nservices:\n  api:\n    <<: *app\n    networks: [private, ingress]\n    environment:\n'
           '      WORKFORCE_ENABLED: "true"\n      APP_ENV: staging\n      API_PORT: \'3100\'\n'
           '  provision:\n    environment:\n      APP_ENV: staging\n\nnetworks:\n  private:\n    internal: true\n  ingress:\n    driver: bridge\n')
BASE_NAMES = [f'{n:03d}_cloud_m{n}.sql' for n in r.BASELINE_NUMBERS]


def args(**extra):
    values = ['prepare', '--sha', SHA, '--branch', 'codex/cloud-kitchen-release', '--expected-api-sha', r.BASELINE,
              '--expected-public-sha', 'b'*40, '--expected-api-image', 'sha256:'+'c'*64, '--expected-compose-sha256', 'd'*64,
              '--expected-gateway-sha256', 'e'*64, '--expected-qr-worker-image', 'sha256:'+'1'*64,
              '--expected-portal-sha', '2'*40, '--expected-portal-config-sha256', '3'*64, '--branch-id', r.BRANCH,
              '--ssh-key', '/tmp/synthetic']
    for key, value in extra.items():
        values += ['--'+key.replace('_', '-')] + ([] if value is True else [value])
    return values


class Repo:
    """Synthetic candidate checkout: baseline 001-052 plus 053-056; git answers are scripted."""
    def __init__(self, tmp):
        self.root = Path(tmp)
        (self.root/'db/cloud/migrations').mkdir(parents=True)
        (self.root/'.github/workflows').mkdir(parents=True)
        (self.root/'.github/workflows/ci.yml').write_text('jobs:\n  build:\n    name: Build\n')
        for name in BASE_NAMES + list(r.MIGRATIONS):
            (self.root/'db/cloud/migrations'/name).write_text('-- ' + name + '\n')
        for name in r.REQUIRED_FILES:
            (self.root/name).parent.mkdir(parents=True, exist_ok=True); (self.root/name).write_text('// synthetic\n')
        self.head, self.ancestor = SHA, True

    def git(self, *a):
        if a[0] == 'rev-parse': return self.head
        if a[0] == 'status': return ''
        if a[0] == 'ls-remote': return SHA + '\trefs/heads/codex/cloud-kitchen-release'
        if a[0] == 'ls-tree': return '\n'.join('db/cloud/migrations/' + n for n in BASE_NAMES)
        if a[0] == 'diff': return ''
        raise AssertionError(a)

    def execute(self, command, **kw):
        if command[:2] == ['git', 'show']:
            return ('-- ' + command[2].rsplit('/', 1)[1] + '\n').encode()
        if command[:2] == ['git', 'merge-base']:
            if not self.ancestor: raise G('Command failed; command-error log has restricted diagnostics')
            return b''
        raise AssertionError(command)


class CloudKitchenReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(); self.repo = Repo(self.tmp)
        self.saved = r.market.REPO; r.market.REPO = self.repo.root

    def tearDown(self):
        r.market.REPO = self.saved; shutil.rmtree(self.tmp)

    def release(self, **extra):
        obj = object.__new__(r.Release)
        obj.args = r.parse(args(**extra)); obj.sha = SHA; obj._portal_changes = None
        obj.profile = r.market.ReleaseProfile('cloud-kitchen-schema056', r.BASELINE, 'b'*40, 51, r.MIGRATIONS,
                                              frozenset({'Build'}), frozenset(), 'cloud-kitchen-release', (), exact_ci_jobs=True)
        obj.git, obj.execute = self.repo.git, self.repo.execute
        return obj

    # ---- source guards ----
    def test_exact_candidate_passes_source_checks(self):
        self.release().source_checks()

    def test_wrong_sha_checked_out_is_refused(self):
        self.repo.head = OTHER
        with self.assertRaisesRegex(G, 'checked HEAD'): self.release().source_checks()

    def test_extra_migration_is_refused(self):
        (self.repo.root/'db/cloud/migrations/057_cloud_extra.sql').write_text('-- extra\n')
        with self.assertRaisesRegex(G, 'migration set'): self.release().source_checks()

    def test_missing_migration_is_refused(self):
        (self.repo.root/'db/cloud/migrations'/r.MIGRATIONS[-1]).unlink()
        with self.assertRaisesRegex(G, 'migration set'): self.release().source_checks()

    def test_modified_installed_migration_is_refused(self):
        (self.repo.root/'db/cloud/migrations'/BASE_NAMES[-1]).write_text('-- edited\n')
        with self.assertRaisesRegex(G, 'existing migration was edited'): self.release().source_checks()

    def test_candidate_must_descend_from_installed_workforce_api(self):
        self.repo.ancestor = False
        with self.assertRaises(G): self.release().source_checks()

    def test_candidate_must_contain_owner_and_grant_files(self):
        (self.repo.root/r.OWNER).unlink()
        with self.assertRaisesRegex(G, 'lacks'): self.release().source_checks()

    def test_baseline_must_be_schema052_with_dormant_051(self):
        obj = self.release()
        obj.git = lambda *a: '\n'.join('db/cloud/migrations/' + n for n in BASE_NAMES if not n.startswith('051'))
        with self.assertRaisesRegex(G, 'schema052'): obj.baseline_migrations()

    # ---- CI ----
    def proof(self, conclusion='success', sha=SHA):
        run = {'head_sha': sha, 'status': 'completed', 'conclusion': conclusion, 'path': '.github/workflows/ci.yml',
               'head_repository': {'full_name': 'xaaknazar/pickchick'}}
        job = {'name': 'Build', 'status': 'completed', 'conclusion': conclusion, 'head_sha': sha}
        path = self.repo.root/'ci.json'; path.write_text(json.dumps({'run': run, 'jobs': {'total_count': 1, 'jobs': [job]}}))
        return str(path)

    def test_green_ci_of_exact_sha_is_accepted(self):
        obj = self.release(ci_proof=self.proof()); obj.save = Mock(); obj.ci()

    def test_red_ci_is_refused(self):
        obj = self.release(ci_proof=self.proof('failure')); obj.save = Mock()
        with self.assertRaises(G): obj.ci()

    def test_ci_of_another_sha_is_refused(self):
        obj = self.release(ci_proof=self.proof(sha=OTHER)); obj.save = Mock()
        with self.assertRaises(G): obj.ci()

    # ---- compose ----
    def test_compose_adds_only_two_off_flags(self):
        result = r.compose_candidate(COMPOSE, r.digest(COMPOSE.encode()))
        self.assertIn('      CLOUD_KITCHEN_API_ENABLED: "0"\n      BACKOFFICE_CLOUD_KITCHEN_ENABLED: "false"\n      APP_ENV: staging', result)
        self.assertEqual(result.replace(r.flag_lines(r.FLAGS_OFF), ''), COMPOSE)
        self.assertEqual(result.count('APP_ENV: staging'), 2)

    def test_compose_drift_is_refused(self):
        with self.assertRaisesRegex(G, 'reviewed hash'): r.compose_candidate(COMPOSE, '0'*64)
        drifted = COMPOSE.replace('API_PORT', 'API_PORTX')
        with self.assertRaisesRegex(G, 'reviewed hash'): r.compose_candidate(drifted, r.digest(COMPOSE.encode()))
        done = r.compose_candidate(COMPOSE, r.digest(COMPOSE.encode()))
        with self.assertRaisesRegex(G, 'already configured'): r.compose_candidate(done, r.digest(done.encode()))

    def test_enable_compose_turns_flags_on_and_attaches_internal_network_only(self):
        candidate = r.compose_candidate(COMPOSE, r.digest(COMPOSE.encode()))
        enabled = r.compose_enabled(candidate)
        self.assertIn('CLOUD_KITCHEN_API_ENABLED: "1"', enabled); self.assertIn('BACKOFFICE_CLOUD_KITCHEN_ENABLED: "true"', enabled)
        self.assertIn('aliases: [pickchick-api]', enabled); self.assertIn('name: pickchick-kitchen_cloud\n    external: true', enabled)
        self.assertNotIn('"0"', enabled)
        self.assertEqual(enabled.count('kitchen_cloud:'), 2)
        with self.assertRaises(G): r.compose_enabled(enabled)
        with self.assertRaises(G): r.compose_enabled(COMPOSE)

    # ---- ACL ----
    def test_privileges_are_least_privilege(self):
        self.assertFalse(any(p in ('DELETE', 'TRUNCATE') for _, _, p in r.PRIVILEGES))
        self.assertFalse(any(t in ('cloud_kitchen_admissions', 'cloud_kitchen_commands', 'branch_channel_mode_changes',
                                   'cloud_kitchen_screen_events') and p == 'UPDATE' for t, _, p in r.PRIVILEGES))
        self.assertFalse(any(t in ('branch_channel_modes', 'cloud_kitchen_stations', 'cloud_kitchen_routing') and p != 'SELECT'
                             for t, _, p in r.PRIVILEGES))

    def test_python_privileges_mirror_owner_script(self):
        node = shutil.which('node')
        if not node: self.skipTest('node unavailable')
        code = ("import('./infra/staging/cloud-kitchen-release-owner.mjs').then(m=>console.log(JSON.stringify("
                "{p:m.EXPECTED_PRIVILEGES,f:m.EXPECTED_FUNCTIONS})))")
        try:
            out = subprocess.run([node, '--input-type=module', '-e', code], cwd=ROOT, capture_output=True, check=True, timeout=60).stdout
        except subprocess.CalledProcessError:
            self.skipTest('workspace packages not built')
        data = json.loads(out)
        self.assertEqual({tuple(x or None for x in p.split('|')) for p in data['p']}, set(r.PRIVILEGES))
        self.assertEqual(data['f'], list(r.FUNCTIONS))

    def test_unexpected_acl_delta_is_refused(self):
        obj = self.release()
        before = [{'name': 'branches', 'kind': 'r', 'column': None, 'privilege': 'SELECT', 'grantable': False}]
        rows = before + [{'name': t, 'kind': 'r', 'column': c, 'privilege': p, 'grantable': False} for t, c, p in r.PRIVILEGES]
        proof = {'before': {'acl': before, 'functions': []}}
        obj.function_acl = Mock(return_value=sorted(r.FUNCTIONS))
        obj.acl = Mock(return_value=rows); obj.verify_acl(proof)
        obj.acl = Mock(return_value=rows + [{'name': 'cloud_kitchen_orders', 'kind': 'r', 'column': None, 'privilege': 'DELETE', 'grantable': False}])
        with self.assertRaisesRegex(G, 'ACL delta'): obj.verify_acl(proof)
        obj.acl = Mock(return_value=rows); obj.function_acl = Mock(return_value=[])
        with self.assertRaisesRegex(G, 'function ACL'): obj.verify_acl(proof)

    # ---- lock / dry run ----
    def test_present_release_lock_stops_read_only_run(self):
        obj = self.release(); obj.source_checks = Mock(); obj.ci = Mock(); obj.prepare = Mock()
        obj.remote = Mock(return_value='')
        with self.assertRaisesRegex(G, 'lock present'): obj.run()
        obj.prepare.assert_not_called()
        obj.remote = Mock(return_value='free'); obj.run(); obj.prepare.assert_called_once()

    def test_mutations_need_explicit_apply_and_source_checkout_is_read_only(self):
        self.assertFalse(r.parse(args()).apply)
        with self.assertRaisesRegex(G, 'read-only'): r.parse(args(source_checkout='/tmp/x', apply=True))

    def test_pins_are_mandatory(self):
        for bad in ({'branch_id': '10000000-0000-4000-8000-000000000003'}, {'expected_api_sha': OTHER},
                    {'expected_qr_worker_image': 'latest'}, {'expected_portal_config_sha256': 'x'}):
            a = r.parse(args(**bad))
            with self.assertRaises(G): r.Release(a)

    def test_enable_needs_operator_and_reason(self):
        a = r.parse(args(apply=True)); a.action = 'enable'
        with self.assertRaisesRegex(G, 'Operator and reason'): r.Release(a)

    # ---- edgeConnected is not a gate ----
    def test_offline_cashier_does_not_block(self):
        self.assertEqual(r.stable_health({'sourceSha': '2'*40, 'edgeConnected': False}), {'sourceSha': '2'*40})
        obj = self.release()
        obj.ready = Mock(); obj.args.expected_gateway_sha256 = 'e'*64
        obj.remote = Mock(side_effect=lambda c, **k: (r.REMOTE + '/public-https/releases/' + 'b'*40) if 'readlink' in c else 'e'*64 + '  /etc/caddy/Caddyfile')
        obj.http_json = Mock(return_value={'sourceSha': '2'*40, 'edgeConnected': False})
        obj.verify_public()
        source = (ROOT/'infra/staging/release-cloud-kitchen.py').read_text()
        self.assertNotIn("get('edgeConnected') is True", source); self.assertNotIn("['edgeConnected'] is True", source)

    def test_screens_need_provisioned_stations(self):
        with self.assertRaisesRegex(G, 'provisioned'): r.screen_plan({'routingVersion': None, 'prepStations': [], 'assemblyStations': []})
        plan = r.screen_plan({'routingVersion': 1, 'prepStations': ['p'], 'assemblyStations': ['a']})
        self.assertEqual([p[0] for p in plan], ['prep', 'assembly', 'display']); self.assertEqual(plan[2][1], [])

    def test_portal_package_import_guard(self):
        files = {'infra/kitchen-portal/server.mjs': "import {x} from './cloud.mjs';\nimport y from '../../apps/kitchen/server.mjs';"}
        self.assertEqual(len(r.unresolved_imports(files)), 2)
        files.update({'infra/kitchen-portal/cloud.mjs': '', 'apps/kitchen/server.mjs': ''})
        self.assertEqual(r.unresolved_imports(files), [])

    def test_remote_scripts_compile_and_never_print_keys(self):
        for script in (r.ENABLE_PORTAL, r.RESTORE_PORTAL, r.PORTAL_FACTS):
            compile(script, 'remote', 'exec')
        last = r.ENABLE_PORTAL.strip().splitlines()[-1]
        self.assertTrue(last.startswith('print(') and 'keys' not in last and 'key' not in last.replace('screens', ''))
        self.assertIn('http://pickchick-api:3100', r.ENABLE_PORTAL)

    def test_restore_portal_returns_exact_original_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            config, pre = Path(tmp)/'config.json', Path(tmp)/'config.pre-cloud.json'
            pre.write_bytes(b'{"origin":"o"}\n'); config.write_bytes(b'{"origin":"o","cloudKitchen":{}}\n')
            expected = r.digest(pre.read_bytes())
            subprocess.run(['python3', '-c', r.RESTORE_PORTAL, str(config), str(pre), expected], check=True, capture_output=True)
            self.assertEqual(config.read_bytes(), b'{"origin":"o"}\n'); self.assertFalse(pre.exists())


if __name__ == '__main__':
    unittest.main()
