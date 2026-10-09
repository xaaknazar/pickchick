"""Unified-menu cloud release guards. Synthetic data only; no SSH, VPS or real credentials.

Run: python -m pytest tests/operations/test_unified_menu_release.py
 or: python3 -m unittest tests/operations/test_unified_menu_release.py
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('unified_menu_release', ROOT / 'infra/staging/release-unified-menu.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)
GuardFailure = r.GuardFailure

SHA = 'a' * 40
# The documented live baseline (6ac409f API and public pointer); the gateway fixture is synthetic,
# so deploy tests patch LIVE_GATEWAY_SHA256 to its digest (live_gateway below).
OLD = r.LIVE_API_SHA
PUBLIC = r.LIVE_PUBLIC_SHA
BRANCH = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'
DEVICE = '11111111-2222-4333-8444-555555555555'
RELEASE = '99999999-8888-4777-8666-555555555555'
GATEWAY = (ROOT / 'tests/operations/fixtures/unified-menu-gateway-baseline.Caddyfile').read_text()
OTHER_IMAGE = 'sha256:' + '1' * 64
# Synthetic neighbour containers in the market fingerprint format: Id Image StartedAt Status RestartCount.
NEIGHBORS = {'containers': {
    r.LIVE_QR_WORKER: f'qr0 {r.LIVE_API_IMAGE} 2026-10-08T14:20:00Z running 0',
    'pickchick-kaspi-bridge': 'bridge0 sha256:' + '2' * 64 + ' 2026-10-08T12:00:00Z running 0',
    'pickchick-staging-cloud-db-1': 'db0 sha256:' + '3' * 64 + ' 2026-10-01T00:00:00Z running 0'},
    'idrink_caddy_sha256': 'e' * 64}


def live_gateway(test):
    """Accept the synthetic gateway fixture as the documented live gateway for one test."""
    patcher = mock.patch.object(r, 'LIVE_GATEWAY_SHA256', r.digest(GATEWAY.encode()))
    patcher.start()
    test.addCleanup(patcher.stop)


def installed_compose():
    """The repo compose without WP-G's line: the shape of the installed compose."""
    text = (ROOT / 'infra/staging/compose.yaml').read_text()
    return text.replace('      BACKOFFICE_REMOTE_STOPS_ENABLED: ${BACKOFFICE_REMOTE_STOPS_ENABLED:-false}\n', '')


# The unified-menu release ends at 049; later migrations belong to later releases.
UNIFIED_LAST = '049_z'


def files_and_ledger(upto):
    files = sorted(p.name for p in (ROOT / 'db/cloud/migrations').glob('*.sql') if p.name <= UNIFIED_LAST)
    checksums = {n: r.digest((ROOT / 'db/cloud/migrations' / n).read_bytes()) for n in files}
    ledger = [{'version': n, 'scope': 'cloud', 'checksum': checksums[n]} for n in files if n <= upto]
    return files, checksums, ledger


def env_for(compose_text, base):
    """Simulated container environment (digests) for the api service of a compose text."""
    api = compose_text[compose_text.index('\n  api:'):compose_text.index('\n  provision:')]
    env = dict(base)
    for key, value in re.findall(r'\n      ([A-Z_]+): "([^"\n]*)"', api):
        env[key] = r.digest(value.encode())
    return env


def edge(**overrides):
    state = {'device_id': DEVICE, 'active_release_id': RELEASE, 'active_version': 2, 'age_seconds': 3.0}
    state.update(overrides.pop('state', {}))
    return {'devices': [DEVICE], 'state': state, 'unacked': 0, 'head': 5, **overrides}


def parity(**overrides):
    report = {'ok': True, 'branch_id': BRANCH, 'catalog_version': 5, 'edge_release_id': RELEASE,
              'edge_version': 2, 'routing': {'active_version': 2, 'derived_version': 3,
                                             'items_needing_routes': 1},
              'summary': {'matched': 30}, 'failures': [], 'warnings': [{'code': 'ITEM_ADDED'}]}
    report.update(overrides)
    return report


ACL_BASE = [{'name': 'cloud_branch_availability', 'kind': 'r', 'column': None, 'privilege': p, 'grantable': False}
            for p in ['SELECT', 'INSERT', 'UPDATE']] + [
    {'name': 'bo_access_grants', 'kind': 'r', 'column': None, 'privilege': 'SELECT', 'grantable': False},
    {'name': 'bo_access_grants', 'kind': 'r', 'column': 'lock_anchor', 'privilege': 'UPDATE', 'grantable': False},
    {'name': 'catalog_publications', 'kind': 'r', 'column': None, 'privilege': 'SELECT', 'grantable': False}]


def acl_rows(keys):
    return [{'name': n, 'kind': 'r', 'column': c, 'privilege': p, 'grantable': False} for n, c, p in sorted(
        keys, key=lambda k: (k[0], k[1] or '', k[2]))]


class Fake(r.Release):
    """Release with every remote effect simulated in memory; records what it would run."""

    def __init__(self, args, private):
        self.args, self.sha, self.branch_id, self.private = args, args.sha, args.branch_id, Path(private)
        self.calls, self.locks = [], 0
        self.revision = SHA
        self.compose = r.compose_candidate(installed_compose(), r.digest(installed_compose().encode()))
        self.base_env = {'APP_ENV': r.digest(b'staging'), 'CLOUD_DATABASE_URL': r.digest(b'postgresql://synthetic')}
        self.env = env_for(self.compose, self.base_env)
        self.grants = {r.acl_key(x) for x in ACL_BASE} | r.deploy_acl(True)
        self.coverage_missing, self.snapshot, self.beat = 0, edge(), None
        self.fail_up = False

    def save(self, name, value):
        path = self.private / name
        path.write_text(json.dumps(value))
        os.chmod(path, 0o600)

    def candidate_migrations(self):
        files, checksums, _ = files_and_ledger(UNIFIED_LAST)
        return files, checksums

    @contextlib.contextmanager
    def deployment_lock(self):
        self.locks += 1
        yield

    def running_revision(self):
        return self.revision

    def runtime_environment(self):
        return dict(self.env)

    def coverage(self):
        return self.coverage_missing

    def edge_snapshot(self):
        return self.snapshot

    def heartbeat(self):
        return self.beat

    def acl(self):
        return acl_rows(self.grants)

    def read_text(self, path):
        assert path == self.compose_path(SHA)
        return self.compose

    def write_remote(self, path, text, public=False):
        self.calls.append(('write', path))
        self.compose = text

    def http_json(self, path, public=True, status=200):
        return {'ready': True}

    def owner(self, *argv, sha=None):
        self.calls.append(('owner', argv))
        _, flag, value = argv
        before = set(self.grants)
        if value == 'true':
            self.grants |= set(r.flag_acl(flag, True)[2])
        else:
            self.grants -= set(r.flag_acl(flag, False)[1])
        return {'flag': flag, 'privilegesAdded': sorted(map(str, self.grants - before))}

    def remote(self, command, **kwargs):
        self.calls.append(('remote', command.split(' ')[0]))
        if ' up -d ' in command:
            if self.fail_up:
                self.fail_up = False
                raise GuardFailure('Simulated container failure')
            self.env = env_for(self.compose, self.base_env)
        return ''


def args(phase, **extra):
    base = dict(phase=phase, sha=SHA, branch='codex/unified-menu', branch_id=BRANCH, apply=False, flag=None,
                expected_api_sha=None, expected_public_sha=None, expected_compose_sha256=None,
                expected_gateway_sha256=None, parity_report=None, ssh_key=Path('/nonexistent'),
                backup_identity=Path('/nonexistent'), ci_run=None, ci_proof=None, action=phase)
    base.update(extra)
    return SimpleNamespace(**base)


class Pure(unittest.TestCase):
    def test_ci_jobs_come_from_the_workflow(self):
        jobs = r.workflow_jobs((ROOT / '.github/workflows/ci.yml').read_text())
        self.assertEqual(len(jobs), 11)
        self.assertIn('Private staging image and restricted database role', jobs)

    def test_migration_plan_accepts_pending_or_applied_047_049_only(self):
        files, sums, ledger = files_and_ledger('046_z')  # live schema046 (kiosk QR recovery)
        self.assertEqual(r.migration_plan(ledger, files, sums), list(r.MIGRATIONS))
        _, _, applied = files_and_ledger('049_z')
        self.assertEqual(r.migration_plan(applied, files, sums), [])
        _, _, partial = files_and_ledger('047_z')
        self.assertEqual(r.migration_plan(partial, files, sums), list(r.MIGRATIONS[1:]))
        bad = [dict(row) for row in ledger]
        bad[3]['checksum'] = '0' * 64
        older = ledger[:-2]  # 045 and 046 (kiosk QR) pending: not this release's migrations
        for ledger_case, files_case in [(bad, files), (older, files), (ledger, files + ['050_cloud_extra.sql']),
                                        (ledger, files[:-1]), (ledger + [{'version': 'x', 'scope': 'cloud', 'checksum': 'y'}], files)]:
            with self.assertRaises(GuardFailure):
                r.migration_plan(ledger_case, files_case, {**sums, '050_cloud_extra.sql': 'z'})

    def test_live_baseline_is_the_documented_6ac409f_install(self):
        record = json.loads((ROOT / 'docs/operations/kiosk-v3-installation-2026-10-08.json').read_text())
        self.assertEqual(record['releaseSource'], r.LIVE_API_SHA)
        self.assertEqual(record['vps']['image'], r.LIVE_API_IMAGE)
        self.assertEqual(record['vps']['gatewaySha256'], r.LIVE_GATEWAY_SHA256)
        self.assertEqual((record['vps']['migrationFiles'], record['vps']['lastMigration']), (len(r.LIVE_SCHEMA), r.LIVE_SCHEMA[-1]))
        self.assertEqual(r.LIVE_PUBLIC_SHA, r.LIVE_API_SHA)  # release-kiosk-qr-recovery.py moves both pointers
        self.assertIn(r.LIVE_API_SHA, (ROOT / 'docs/operations/payment-blockers-2026-10-09.md').read_text())
        for name, value in r.LIVE_MIGRATIONS.items():
            self.assertEqual(r.digest((ROOT / 'db/cloud/migrations' / name).read_bytes()), value)
        live = sorted(p.name for p in (ROOT / 'db/cloud/migrations').glob('*.sql') if int(p.name[:3]) <= 46)
        self.assertEqual(len(live), 45)
        r.check_live_schema(live, {n: r.digest((ROOT / 'db/cloud/migrations' / n).read_bytes()) for n in live})

    def test_deploy_requires_the_exact_live_baseline(self):
        good = SimpleNamespace(expected_api_sha=r.LIVE_API_SHA, expected_public_sha=r.LIVE_PUBLIC_SHA,
                               expected_gateway_sha256=r.LIVE_GATEWAY_SHA256, expected_compose_sha256='4' * 64)
        r.check_live_baseline(good)
        older = {'85f23d582540f89b0df86b7415cc764f7594774a', '37dbc1a2c1941fb686206e64de7dca9bcaea125d'}
        cases = [dict(expected_api_sha=sha) for sha in older] + [dict(expected_public_sha=sha) for sha in older]
        cases += [dict(expected_public_sha='778a718ffe916520fc177aaa663546e863a8574a'),
                  dict(expected_gateway_sha256='0bb039bde008cd3a25aeec3d4e06d15f3ad5e8dc3f6eda2e8373fd004264d3ff'),
                  dict(expected_compose_sha256=None), dict(expected_compose_sha256='4' * 63)]
        for change in cases:
            with self.assertRaises(GuardFailure, msg=change):
                r.check_live_baseline(SimpleNamespace(**{**vars(good), **change}))

    def test_live_schema_is_exactly_046_with_the_installed_kiosk_bytes(self):
        files, sums, _ = files_and_ledger('049_z')
        live = [n for n in files if n <= '046_z']
        r.check_live_schema(live, sums)
        for names in [files, [n for n in live if n <= '045_z'], live[:-1] + ['046_other.sql'], live + ['../x.sql']]:
            with self.assertRaises(GuardFailure):
                r.check_live_schema(names, sums)
        with self.assertRaisesRegex(GuardFailure, '045/046'):
            r.check_live_schema(live, {**sums, '046_cloud_kiosk_qr_recovery.sql': '0' * 64})
        with self.assertRaisesRegex(GuardFailure, '045/046'):
            r.migration_plan([], files, {**sums, '045_cloud_kiosk_qr_before_admission.sql': '0' * 64})

    def test_qr_worker_must_be_the_running_live_container(self):
        r.check_qr_worker(NEIGHBORS)
        for value in [None, f'qr0 {OTHER_IMAGE} 2026-10-08T14:20:00Z running 0',
                      f'qr0 {r.LIVE_API_IMAGE} 2026-10-08T14:20:00Z exited 0', 'qr0']:
            containers = dict(NEIGHBORS['containers'])
            if value is None:
                containers.pop(r.LIVE_QR_WORKER)
            else:
                containers[r.LIVE_QR_WORKER] = value
            with self.assertRaisesRegex(GuardFailure, 'QR worker'):
                r.check_qr_worker({**NEIGHBORS, 'containers': containers})

    def test_preflight_refuses_missing_access_grants(self):
        r.check_access_coverage(0)
        with self.assertRaisesRegex(GuardFailure, '2 catalog-manager branch assignment.*bo_access_grants'):
            r.check_access_coverage(2)

    def test_unacked_menu_events_block_edge_phases(self):
        r.check_menu_events(0)
        with self.assertRaisesRegex(GuardFailure, '3 unacknowledged menu.published'):
            r.check_menu_events(3)

    def test_edge_state_must_be_fresh_v2_or_newer_for_the_active_device(self):
        self.assertEqual(r.check_edge_state(edge(), BRANCH)['active_version'], 2)
        for bad in [edge(state={'active_version': 1}), edge(state={'device_id': RELEASE}),
                    edge(state={'age_seconds': 600.0}), edge(devices=[]), edge(devices=[DEVICE, RELEASE]),
                    {**edge(), 'state': None}]:
            with self.assertRaises(GuardFailure):
                r.check_edge_state(bad, BRANCH)

    def test_parity_report_must_be_clean_and_for_live_state(self):
        state = r.check_edge_state(edge(), BRANCH)
        self.assertEqual(r.check_parity(parity(), BRANCH, state, 5), {'warnings': 1, 'items': 30})
        for bad, head in [(parity(ok=False), 5), (parity(failures=[{'code': 'PRICE_CHANGED'}]), 5),
                          (parity(branch_id=DEVICE), 5), (parity(edge_version=3), 5),
                          (parity(edge_release_id=DEVICE), 5), (parity(), 6), (parity(), None),
                          (parity(routing=None), 5), (parity(routing={'active_version': 2}), 5), ([], 5)]:
            with self.assertRaises(GuardFailure):
                r.check_parity(bad, BRANCH, state, head)

    def test_phase_gating_follows_the_rollout_order(self):
        done = {}
        flags = {p: 'false' for p in r.FLAG_KEYS}
        r.phase_gate('deploy', done, flags)
        for phase in r.PHASES[1:]:
            with self.assertRaisesRegex(GuardFailure, 'requires completed phase'):
                r.phase_gate(phase, done, flags)
        done['deploy'] = {}
        r.phase_gate('access-roles', done, flags)
        done['access-roles'] = {}
        with self.assertRaisesRegex(GuardFailure, 'access-roles enabled'):
            r.phase_gate('verify-edge', done, flags)  # evidence alone is not enough; live flag must be on
        flags['access-roles'] = 'true'
        r.phase_gate('verify-edge', done, flags)
        done['verify-edge'] = {'completed_epoch': time.time()}
        r.phase_gate('edge-publication', done, flags)
        with self.assertRaisesRegex(GuardFailure, 'older than 2 hours'):
            r.phase_gate('edge-publication', done, flags, now=time.time() + 3 * 3600)
        done['edge-publication'] = {}
        with self.assertRaisesRegex(GuardFailure, 'edge-publication enabled'):
            r.phase_gate('remote-stops', done, flags)
        flags['edge-publication'] = 'true'
        r.phase_gate('remote-stops', done, flags)
        with self.assertRaisesRegex(GuardFailure, 'requires completed phase remote-stops'):
            r.phase_gate('media-upload', done, flags)
        done['remote-stops'] = {}
        flags['remote-stops'] = 'true'
        r.phase_gate('media-upload', done, flags)
        flags['access-roles'] = 'false'  # turning an earlier flag off blocks later enables
        with self.assertRaises(GuardFailure):
            r.phase_gate('media-upload', done, flags)

    def test_compose_candidate_adds_only_flags_off(self):
        text = installed_compose()
        candidate = r.compose_candidate(text, r.digest(text.encode()))
        lines = candidate.splitlines()
        api = lines.index('      CLOUD_DATABASE_URL: postgresql://pickchick_app:${DB_APP_PASSWORD:?Generate a separate secret}@cloud-db:5432/pickchick_cloud')
        self.assertEqual(lines[api - 5:api], [
            '      CATALOG_ACCESS_ROLES_ENABLED: "false"', '      CATALOG_EDGE_PUBLICATION_ENABLED: "false"',
            '      CATALOG_EDGE_PUBLICATION_BRANCH_ID: ""', '      BACKOFFICE_REMOTE_STOPS_ENABLED: "false"',
            '      CATALOG_MEDIA_UPLOAD_ENABLED: "false"'])
        self.assertEqual(candidate.count('BACKOFFICE_REMOTE_STOPS_ENABLED: "false"'), 2)
        self.assertEqual(candidate.count('CATALOG_MEDIA_UPLOAD_ENABLED: "false"'), 2)
        with self.assertRaisesRegex(GuardFailure, 'reviewed hash'):
            r.compose_candidate(text, '0' * 64)
        with self.assertRaisesRegex(GuardFailure, 'already mentions'):
            r.compose_candidate(candidate, r.digest(candidate.encode()))
        repo = (ROOT / 'infra/staging/compose.yaml').read_text()
        with self.assertRaises(GuardFailure):  # the repo compose already has WP-G's key
            r.compose_candidate(repo, r.digest(repo.encode()))

    def test_compose_flag_flips_one_literal(self):
        text = installed_compose()
        base = r.compose_candidate(text, r.digest(text.encode()))
        on = r.compose_flag(base, 'edge-publication', True, BRANCH)
        self.assertIn(f'      CATALOG_EDGE_PUBLICATION_BRANCH_ID: "{BRANCH}"\n', on)
        self.assertIn('      CATALOG_EDGE_PUBLICATION_ENABLED: "true"\n', on)
        off = r.compose_flag(on, 'edge-publication', False)
        self.assertIn('      CATALOG_EDGE_PUBLICATION_ENABLED: "false"\n', off)
        self.assertEqual(r.compose_flag(off, 'edge-publication', True, BRANCH), on)  # re-enable keeps branch
        with self.assertRaisesRegex(GuardFailure, 'branch differs'):
            r.compose_flag(off, 'edge-publication', True, DEVICE)
        stops = r.compose_flag(base, 'remote-stops', True)
        self.assertEqual(stops.count('BACKOFFICE_REMOTE_STOPS_ENABLED: "true"'), 2)  # api and provision
        with self.assertRaises(GuardFailure):
            r.compose_flag(stops, 'remote-stops', True)
        with self.assertRaises(GuardFailure):
            r.compose_flag(base, 'media-upload', False)

    def test_environment_is_compared_as_digests(self):
        before = {'A': r.digest(b'1'), 'CATALOG_MEDIA_UPLOAD_ENABLED': r.digest(b'false')}
        after = {**before, 'CATALOG_MEDIA_UPLOAD_ENABLED': r.digest(b'true')}
        r.verify_environment_delta(before, after, {'CATALOG_MEDIA_UPLOAD_ENABLED': 'true'})
        with self.assertRaises(GuardFailure):
            r.verify_environment_delta(before, {**after, 'A': r.digest(b'2')}, {'CATALOG_MEDIA_UPLOAD_ENABLED': 'true'})
        self.assertEqual(r.flag_environment(after)['media-upload'], 'true')
        self.assertEqual(r.flag_environment({})['remote-stops'], 'false')
        self.assertEqual(r.flag_environment({'BACKOFFICE_REMOTE_STOPS_ENABLED': r.digest(b'yes')})['remote-stops'], 'invalid')

    def test_availability_guard_tolerates_heartbeats_only(self):
        row = {'branch_id': BRANCH, 'device_id': DEVICE, 'revision': 7, 'stopped_ids': [],
               'observed_at': '2026-10-08T10:00:00+00:00'}
        beat = {**row, 'revision': 9, 'observed_at': '2026-10-08T10:00:02+00:00', 'stop_states': None}
        r.verify_availability([row], [beat])
        r.verify_availability([row], [{**row, 'stop_states': None}])
        r.verify_availability([row], [{**beat, 'stopped_ids': [RELEASE]}])  # cashier stop in a newer heartbeat
        for bad in [{**beat, 'device_id': RELEASE}, {**beat, 'revision': 6}, {**row, 'stopped_ids': [RELEASE]},
                    {**beat, 'observed_at': row['observed_at']}, {**beat, 'extra': 1},
                    {**row, 'stop_states': []}]:
            with self.assertRaises(GuardFailure):
                r.verify_availability([row], [bad])
        with self.assertRaises(GuardFailure):
            r.verify_availability([row], [])

    def test_acl_checks(self):
        before = ACL_BASE
        after = before + acl_rows(r.deploy_acl(True))
        r.verify_acl_change(before, after, new_tables=r.NEW_TABLES, exact_new=r.deploy_acl(True))
        with self.assertRaises(GuardFailure):
            r.verify_acl_change(before, after + acl_rows({('cloud_stop_commands', None, 'INSERT')}),
                                new_tables=r.NEW_TABLES, exact_new=r.deploy_acl(True))
        with self.assertRaises(GuardFailure):
            r.verify_acl_change(before, after[1:], new_tables=r.NEW_TABLES)
        with self.assertRaises(GuardFailure):
            r.verify_acl_change(before, before + acl_rows({('commerce_orders', None, 'UPDATE')}))
        self.assertNotIn(('cloud_stop_commands', None, 'SELECT'), r.deploy_acl(False))


class Gateway(unittest.TestCase):
    def test_candidate_applies_media_stops_and_storefront_routes(self):
        candidate = r.gateway_candidate(GATEWAY, r.digest(GATEWAY.encode()))
        repo = (ROOT / 'infra/public-staging/gateway.Caddyfile').read_text()
        # WP-F blocks are byte-identical to the reviewed repository gateway.
        for start, end in [('\t@catalog_asset_upload {', '\t@small_body {'),
                           ('\thandle @catalog_asset_upload {', '\t@published_catalog {'),
                           ('\t# Every response is no-store', '\t@synthetic_surfaces {')]:
            block = repo[repo.index(start):repo.index(end)]
            self.assertEqual(candidate.count(block), 1, start)
        self.assertNotIn('\t\tCache-Control no-store\n\t\tX-Content-Type-Options', candidate)
        self.assertIn('/v1/admin/catalog/* /v1/media/catalog/* ', candidate)
        self.assertIn('(/finance|/stops|/orders/', candidate)
        self.assertIn('((/finance)?/commands|/stops)$', candidate)
        self.assertIn('/v1/kiosk-checkout/availability /v1/kiosk-checkout/catalog/media\n', candidate)
        self.assertIn("'/v1/customer-checkout/catalog', '/v1/customer-checkout/catalog/media'", candidate)
        read = candidate[candidate.index('\thandle @kiosk_menu_read {'):candidate.index('\t@kiosk_menu_session {')]
        self.assertIn('response_header_timeout 30s', read)
        # Every other line of the installed gateway is kept.
        removed = set(GATEWAY.splitlines()) - set(candidate.splitlines())
        self.assertEqual(len(removed), 7, removed)  # no-store, surfaces, 3 regexes, kiosk and customer paths
        self.assertEqual(candidate.count('response_header_timeout 5s'), GATEWAY.count('response_header_timeout 5s'))

    def test_live_kiosk_checkout_routes_are_kept_byte_for_byte(self):
        # a659c242... carries the 85f23d5 checkout routes (release-kiosk-checkout.py).
        candidate = r.gateway_candidate(GATEWAY, r.digest(GATEWAY.encode()))
        for name in ['create', 'payment', 'read']:
            start = GATEWAY.index(f'\t@kiosk_checkout_{name} {{')
            block = GATEWAY[start:GATEWAY.index('\n\n', GATEWAY.index(f'\thandle @kiosk_checkout_{name} {{')) + 2]
            self.assertIn('response_header_timeout 5s', block)
            self.assertEqual(candidate.count(block), 1, name)

    def test_candidate_refuses_unreviewed_or_already_patched_text(self):
        candidate = r.gateway_candidate(GATEWAY, r.digest(GATEWAY.encode()))
        with self.assertRaisesRegex(GuardFailure, 'reviewed hash'):
            r.gateway_candidate(GATEWAY, '0' * 64)
        with self.assertRaises(GuardFailure):
            r.gateway_candidate(candidate, r.digest(candidate.encode()))
        for old, new in [('\t@published_catalog {\n', '\t@published_catalog_x {\n'),
                         ('\t\tpath /v1/kiosk-checkout/config /v1/kiosk-checkout/catalog /v1/kiosk-checkout/availability\n', ''),
                         ("'/v1/customer-checkout/catalog'", "'/v1/customer-checkout/menu'"),
                         ('(/finance|/orders/', '(/orders/')]:
            bad = GATEWAY.replace(old, new, 1)
            with self.assertRaisesRegex(GuardFailure, 'anchor not found'):
                r.gateway_candidate(bad, r.digest(bad.encode()))

    @unittest.skipUnless(os.environ.get('CADDY_BIN') or shutil.which('caddy'), 'caddy binary not available')
    def test_candidate_is_valid_caddy(self):
        candidate = r.gateway_candidate(GATEWAY, r.digest(GATEWAY.encode()))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'Caddyfile'
            path.write_text(candidate)
            result = subprocess.run([os.environ.get('CADDY_BIN') or shutil.which('caddy'), 'validate', '--config', str(path),
                                     '--adapter', 'caddyfile'], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr[-500:])

    def test_public_mount_relocation(self):
        old, new = '/x/releases/old/infra/public-staging', '/x/releases/new/infra/public-staging'
        config = {'services': {'gateway': {'volumes': [
            {'type': 'bind', 'read_only': True, 'source': old + '/gateway.Caddyfile', 'target': '/etc/caddy/Caddyfile'},
            {'type': 'bind', 'read_only': True, 'source': old + '/public-web', 'target': '/srv/public'}]}}}
        moved = r.relocate_public_mounts(config, old, new)
        self.assertEqual({v['source'] for v in moved['services']['gateway']['volumes']},
                         {new + '/gateway.Caddyfile', new + '/public-web'})
        config['services']['gateway']['volumes'][0]['read_only'] = False
        with self.assertRaises(GuardFailure):
            r.relocate_public_mounts(config, old, new)


class CaddyValidation(unittest.TestCase):
    def test_offline_validator_keeps_only_caddy_file_capability(self):
        path = '/private/owned/gateway.Caddyfile'
        command = r.caddy_validation_command(path)
        guard, not_symlink, container = command.split(' && ')
        self.assertEqual(shlex.split(guard), ['test', '-f', path])
        self.assertEqual(shlex.split(not_symlink), ['test', '!', '-L', path])
        argv = shlex.split(container)
        self.assertEqual(argv[:2], ['docker', 'run'])
        for flag in ['--read-only', '--rm']:
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index('--cap-drop') + 1], 'ALL')
        self.assertEqual(argv.count('--cap-add'), 1)
        self.assertEqual(argv[argv.index('--cap-add') + 1], 'NET_BIND_SERVICE')
        self.assertEqual(argv[argv.index('--network') + 1], 'none')
        self.assertEqual(argv[argv.index('--security-opt') + 1], 'no-new-privileges:true')
        self.assertEqual(argv[argv.index('--mount') + 1],
                         'type=bind,source=' + path + ',target=/tmp/Caddyfile,readonly')
        self.assertNotIn('-v', argv)
        self.assertNotIn('DAC_OVERRIDE', argv)
        self.assertIn(r.CADDY, argv)
        self.assertEqual(argv[-5:], ['validate', '--config', '/tmp/Caddyfile', '--adapter', 'caddyfile'])

    def test_missing_directory_and_symlink_sources_never_start_docker(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / 'bin'
            binary.mkdir()
            marker = root / 'docker-started'
            docker = binary / 'docker'
            docker.write_text('#!/bin/sh\nprintf started > ' + shlex.quote(str(marker)) + '\n')
            docker.chmod(0o700)
            config = root / 'Caddyfile'
            config.write_text(':8080 { respond "ok" }')
            link = root / 'link'
            link.symlink_to(config)
            for path in [root / 'missing', root, link]:
                result = subprocess.run(['/bin/sh', '-c', r.caddy_validation_command(str(path))],
                                        env={'PATH': str(binary)}, capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(marker.exists())
            result = subprocess.run(['/bin/sh', '-c', r.caddy_validation_command(str(config))],
                                    env={'PATH': str(binary)}, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(marker.read_text(), 'started')


class Phases(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def release(self, phase, **extra):
        return Fake(args(phase, **extra), self.tmp.name)

    def record(self, phase, **extra):
        path = Path(self.tmp.name) / f'phase-{phase}.json'
        path.write_text(json.dumps({'phase': phase, 'source_sha': SHA, 'completed_epoch': time.time(), **extra}))

    def output(self, release):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            release.run()
        return buffer.getvalue()

    def test_deploy_preflight_refuses_missing_grants(self):
        live_gateway(self)
        release = self.release('deploy', expected_api_sha=OLD, expected_public_sha=PUBLIC,
                               expected_compose_sha256=r.digest(installed_compose().encode()),
                               expected_gateway_sha256=r.digest(GATEWAY.encode()))
        _, _, ledger = files_and_ledger('046_z')
        release.revision = OLD
        release.ledger = lambda database=r.DB: ledger
        release.role_restricted = lambda: None
        texts = {release.compose_path(OLD): installed_compose(),
                 release.public_dir(PUBLIC) + '/gateway.Caddyfile': GATEWAY}
        release.read_text = lambda path: texts[path]
        neighbors = json.loads(json.dumps(NEIGHBORS))
        release.fingerprint = lambda: neighbors
        image = 'docker inspect --format ' + "'{{.Image}}' " + r.market.API_CONTAINER
        answers = {'readlink -f /opt/pickchick-staging/current': f'{r.REMOTE}/releases/{OLD}',
                   'readlink -f /opt/pickchick-staging/public-https/current': f'{r.REMOTE}/public-https/releases/{PUBLIC}',
                   image: r.LIVE_API_IMAGE,
                   "docker image inspect --format '{{.Id}}' pickchick-api:" + OLD: r.LIVE_API_IMAGE}
        release.remote = lambda command, **kw: answers.get(command, r.digest(GATEWAY.encode()) + '  /etc/caddy/Caddyfile')
        release.coverage_missing = 1
        with self.assertRaisesRegex(GuardFailure, 'bo_access_grants'):
            release.deploy_baseline()
        release.coverage_missing = 0
        base = release.deploy_baseline()
        self.assertEqual(base['pending'], list(r.MIGRATIONS))
        self.assertIn('CATALOG_MEDIA_UPLOAD_ENABLED: "false"', base['compose'])
        # The QR worker of the live install must be running from the documented image.
        neighbors['containers'][r.LIVE_QR_WORKER] = f'qr0 {OTHER_IMAGE} 2026-10-08T14:20:00Z running 0'
        with self.assertRaisesRegex(GuardFailure, 'QR worker'):
            release.deploy_baseline()
        neighbors['containers'][r.LIVE_QR_WORKER] = NEIGHBORS['containers'][r.LIVE_QR_WORKER]
        answers[image] = OTHER_IMAGE  # same revision label, another image
        with self.assertRaisesRegex(GuardFailure, 'documented live image'):
            release.deploy_baseline()
        answers[image] = r.LIVE_API_IMAGE
        release.args.expected_gateway_sha256 = '0' * 64
        with self.assertRaisesRegex(GuardFailure, 'Exact live baseline'):
            release.deploy_baseline()
        release.args.expected_gateway_sha256 = r.digest(GATEWAY.encode())
        release.revision = SHA  # someone else deployed in between
        with self.assertRaisesRegex(GuardFailure, 'not the reviewed baseline'):
            release.deploy_baseline()

    def test_flag_phases_are_gated_on_evidence_and_live_flags(self):
        for phase in ['access-roles', 'edge-publication', 'remote-stops', 'media-upload']:
            with self.assertRaisesRegex(GuardFailure, 'requires completed phase'):
                self.release(phase, apply=True).run()
        with self.assertRaisesRegex(GuardFailure, 'requires completed phase'):
            self.release('verify-edge', parity_report=Path('/nonexistent')).run()
        self.record('deploy')
        release = self.release('remote-stops', apply=True)
        with self.assertRaisesRegex(GuardFailure, 'requires completed phase edge-publication'):
            release.run()
        self.assertEqual(release.locks, 0)
        self.assertEqual(release.calls, [])

    def test_access_roles_refuses_missing_grants_then_enables(self):
        self.record('deploy')
        release = self.release('access-roles', apply=True)
        release.coverage_missing = 4
        with self.assertRaisesRegex(GuardFailure, '4 catalog-manager'):
            release.run()
        self.assertEqual(release.calls, [])
        release.coverage_missing = 0
        out = self.output(release)
        self.assertEqual(json.loads(out)['flag'], 'CATALOG_ACCESS_ROLES_ENABLED')
        self.assertEqual(r.flag_environment(release.env)['access-roles'], 'true')
        self.assertEqual(release.locks, 1)
        self.assertTrue((Path(self.tmp.name) / 'phase-access-roles.json').exists())
        # Idempotent: a second run changes nothing.
        release.calls.clear()
        self.assertIn('already_complete', self.output(release))
        self.assertEqual(release.calls, [])

    def test_verify_edge_refuses_unacked_events_and_stale_state(self):
        self.record('deploy')
        self.record('access-roles')
        report = Path(self.tmp.name) / 'parity.json'
        report.write_text(json.dumps(parity()))
        release = self.release('verify-edge', parity_report=report)
        release.env['CATALOG_ACCESS_ROLES_ENABLED'] = r.digest(b'true')
        release.snapshot = edge(unacked=2)
        with self.assertRaisesRegex(GuardFailure, '2 unacknowledged menu.published'):
            release.run()
        release.snapshot = edge(state={'age_seconds': 900.0})
        with self.assertRaisesRegex(GuardFailure, 'stale'):
            release.run()
        release.snapshot = {**edge(), 'state': None}
        with self.assertRaisesRegex(GuardFailure, 'report mode'):
            release.run()
        self.assertFalse((Path(self.tmp.name) / 'phase-verify-edge.json').exists())
        release.snapshot = edge()
        out = json.loads(self.output(release))
        self.assertEqual(out['edge']['active_version'], 2)
        self.assertEqual(out['parity_sha256'], r.digest(report.read_bytes()))

    def test_full_flag_sequence_and_disable(self):
        self.record('deploy')
        report = Path(self.tmp.name) / 'parity.json'
        report.write_text(json.dumps(parity()))
        fake = self.release('access-roles', apply=True)
        self.output(fake)
        state = {'compose': fake.compose, 'env': fake.env, 'grants': fake.grants}

        def step(phase, **extra):
            release = self.release(phase, **extra)
            release.compose, release.env, release.grants = state['compose'], state['env'], state['grants']
            release.beat = {'protocol4': True, 'age_seconds': 1.0, 'device_matches': True}
            output = self.output(release)
            state.update(compose=release.compose, env=release.env, grants=release.grants)
            return release, output

        step('verify-edge', parity_report=report)
        # Edge menu moved after verify-edge: publication refuses until verified again.
        moved = self.release('edge-publication', apply=True)
        moved.compose, moved.env = state['compose'], state['env']
        moved.snapshot = edge(state={'active_version': 3})
        with self.assertRaisesRegex(GuardFailure, 'changed since verify-edge'):
            moved.run()
        release, _ = step('edge-publication', apply=True)
        self.assertEqual(release.env[r.BRANCH_KEY], r.digest(BRANCH.encode()))
        self.assertNotIn(('owner', ('flag', 'edge-publication', 'true')), release.calls)
        release, _ = step('remote-stops', apply=True)
        self.assertIn(('cloud_stop_commands', None, 'INSERT'), state['grants'])
        self.assertIn(('owner', ('flag', 'remote-stops', 'true')), release.calls)
        release, _ = step('media-upload', apply=True)
        self.assertTrue(r.MEDIA_WRITE <= state['grants'])
        flags = r.flag_environment(state['env'])
        self.assertEqual(set(flags.values()), {'true'})
        # Rollback of one flag: env off first, then the grant is revoked.
        release, out = step('disable', apply=True, flag='remote-stops')
        self.assertEqual(json.loads(out)['value'], 'false')
        self.assertNotIn(('cloud_stop_commands', None, 'INSERT'), state['grants'])
        order = [c for c in release.calls if c[0] in ('owner', 'write')]
        self.assertEqual(order[0][0], 'write')
        self.assertEqual(order[-1], ('owner', ('flag', 'remote-stops', 'false')))
        self.assertEqual(r.flag_environment(state['env'])['remote-stops'], 'false')
        # A later phase cannot be re-enabled while an earlier flag is off.
        step('disable', apply=True, flag='media-upload')
        with self.assertRaisesRegex(GuardFailure, 'remote-stops enabled'):
            step('media-upload', apply=True)

    def test_failed_flag_switch_restores_compose_and_grants(self):
        self.record('deploy')
        self.record('access-roles')
        self.record('verify-edge')
        self.record('edge-publication')
        release = self.release('remote-stops', apply=True)
        release.compose = r.compose_flag(r.compose_flag(release.compose, 'access-roles', True), 'edge-publication', True, BRANCH)
        release.env = env_for(release.compose, release.base_env)
        release.beat = {'protocol4': True, 'age_seconds': 1.0, 'device_matches': True}
        before_compose, before_grants = release.compose, set(release.grants)
        release.fail_up = True
        with self.assertRaisesRegex(GuardFailure, 'Simulated'):
            release.run()
        self.assertEqual(release.compose, before_compose)
        self.assertEqual(release.grants, before_grants)
        self.assertFalse((Path(self.tmp.name) / 'phase-remote-stops.json').exists())

    def test_remote_stops_needs_protocol4_heartbeat(self):
        for phase in ['deploy', 'access-roles', 'verify-edge', 'edge-publication']:
            self.record(phase)
        release = self.release('remote-stops', apply=True)
        release.compose = r.compose_flag(r.compose_flag(release.compose, 'access-roles', True), 'edge-publication', True, BRANCH)
        release.env = env_for(release.compose, release.base_env)
        for beat in [None, {'protocol4': False, 'age_seconds': 1.0, 'device_matches': True},
                     {'protocol4': True, 'age_seconds': 90.0, 'device_matches': True},
                     {'protocol4': True, 'age_seconds': 1.0, 'device_matches': False}]:
            release.beat = beat
            with self.assertRaises(GuardFailure):
                release.run()
        self.assertEqual(release.calls, [])

    def test_cli_requires_reviewed_baseline_for_deploy_and_never_prints_secrets(self):
        with self.assertRaisesRegex(GuardFailure, 'expected-api-sha'):
            r.parse(['deploy', SHA, '--branch', 'x', '--branch-id', BRANCH])
        baseline = ['--expected-public-sha', r.LIVE_PUBLIC_SHA, '--expected-compose-sha256', '4' * 64,
                    '--expected-gateway-sha256', r.LIVE_GATEWAY_SHA256, '--ci-run', '1']
        parsed = r.parse(['deploy', SHA, '--branch', 'x', '--branch-id', BRANCH, '--expected-api-sha', r.LIVE_API_SHA, *baseline])
        self.assertEqual(parsed.expected_api_sha, r.LIVE_API_SHA)
        with self.assertRaisesRegex(GuardFailure, 'Exact live baseline'):  # the pre-6ac409f install
            r.parse(['deploy', SHA, '--branch', 'x', '--branch-id', BRANCH,
                     '--expected-api-sha', '37dbc1a2c1941fb686206e64de7dca9bcaea125d', *baseline])
        parsed = r.parse(['disable', SHA, '--branch', 'x', '--branch-id', BRANCH, '--flag', 'media-upload'])
        self.assertEqual(parsed.flag, 'media-upload')
        script = ROOT / 'infra/staging/release-unified-menu.py'
        result = subprocess.run([sys.executable, str(script), 'deploy', SHA, '--branch', 'x', '--branch-id', BRANCH],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Release stopped: --expected-api-sha is required', result.stdout)
        self.assertNotIn('Traceback', result.stdout + result.stderr)
        # Flag output names keys and booleans only, never environment values.
        self.record('deploy')
        release = self.release('access-roles', apply=True)
        release.base_env['CLOUD_DATABASE_URL'] = 'secret-digest-placeholder'
        release.env = env_for(release.compose, release.base_env)
        out = self.output(release)
        self.assertNotIn('secret-digest-placeholder', out)
        self.assertNotIn('postgresql', out)


class DeployFake(Fake):
    """Deploy apply against an in-memory VPS: pointers, containers, schema and ACL."""

    def __init__(self, args, private):
        super().__init__(args, private)
        self.revision = OLD
        self.pointers = {r.REMOTE + '/current': f'{r.REMOTE}/releases/{OLD}',
                         r.REMOTE + '/public-https/current': f'{r.REMOTE}/public-https/releases/{PUBLIC}'}
        self.installed = installed_compose()
        self.env = env_for(self.installed, self.base_env)
        self.grants = {r.acl_key(x) for x in ACL_BASE}
        self.mounted_gateway = GATEWAY
        self.files = {}
        self.fail_gateway = False
        self.neighbor_state = json.loads(json.dumps(NEIGHBORS))
        _, _, self.ledger_rows = files_and_ledger('046_z')
        self.capabilities = {'environment': 'staging'}

    def execute(self, command, **kwargs):
        return b'synthetic-archive'

    def ledger(self, database=r.DB):
        return self.ledger_rows

    def table_names(self, database):
        return ['branches', 'devices']

    def role_restricted(self):
        pass

    def fingerprint(self):
        return json.loads(json.dumps(self.neighbor_state))

    def availability_rows(self):
        return [{'branch_id': BRANCH, 'device_id': DEVICE, 'revision': 7, 'stopped_ids': [],
                 'observed_at': '2026-10-08T10:00:00+00:00'}]

    def read_text(self, path):
        if path == self.compose_path(OLD):
            return self.installed
        if path == self.public_dir(PUBLIC) + '/gateway.Caddyfile':
            return GATEWAY
        return self.files[path]

    def write_remote(self, path, text, public=False):
        self.calls.append(('write', path))
        self.files[path] = text

    def switch(self, path, expected, target):
        assert self.pointers[path] == expected
        self.pointers[path] = target
        self.calls.append(('switch', path, target))

    def owner(self, *argv, sha=None):
        self.calls.append(('owner', argv))
        assert argv == ('deploy',)
        _, _, self.ledger_rows = files_and_ledger('049_z')
        self.grants |= r.deploy_acl(True)
        return {'applied': list(r.MIGRATIONS), 'lastMigration': r.MIGRATIONS[-1], 'migrationFiles': 48,
                'privilegesRemoved': [], 'transportGrants': True, 'createdTables': sorted(r.NEW_TABLES)}

    def http_json(self, path, public=True, status=200):
        return {'ready': True} if path == '/health/ready' else self.capabilities

    def http(self, path, *, public=True, method='GET'):
        if '/stops' in path:
            return 401, b'{"code":"UNAUTHORIZED","trace_id":"x"}'
        return 404, b'{"code":"NOT_FOUND","trace_id":"x"}'

    def remote(self, command, **kwargs):
        self.calls.append(('remote', command[:60]))
        if command.startswith('readlink -f '):
            return self.pointers[command[len('readlink -f '):]]
        if 'sha256sum /etc/caddy/Caddyfile' in command:
            return r.digest(self.mounted_gateway.encode()) + '  /etc/caddy/Caddyfile'
        if 'docker build' in command:
            return OTHER_IMAGE
        if '{{.Image}}' in command:
            return r.LIVE_API_IMAGE if self.revision == OLD else OTHER_IMAGE
        if '{{.Id}}' in command:
            return r.LIVE_API_IMAGE if command.endswith('pickchick-api:' + OLD) else OTHER_IMAGE
        if 'config --format json' in command:
            old = self.public_dir(PUBLIC)
            return json.dumps({'services': {'gateway': {'volumes': [
                {'type': 'bind', 'read_only': True, 'source': old + '/gateway.Caddyfile', 'target': '/etc/caddy/Caddyfile'},
                {'type': 'bind', 'read_only': True, 'source': old + '/public-web', 'target': '/srv/public'}]}}})
        if command.startswith('sha256sum /opt'):
            return 'f' * 64 + '  backup'
        if ' up -d ' in command and command.endswith('api'):
            sha = SHA if f'/releases/{SHA}/' in command else OLD
            self.revision = sha
            self.env = env_for(self.files[self.compose_path(SHA)] if sha == SHA else self.installed, self.base_env)
        if ' up -d ' in command and command.endswith('gateway'):
            if self.fail_gateway:
                self.fail_gateway = False
                raise GuardFailure('Simulated gateway failure')
            sha = SHA if f'/releases/{SHA}/' in command else PUBLIC
            self.mounted_gateway = self.files[self.public_dir(SHA) + '/gateway.Caddyfile'] if sha == SHA else GATEWAY
        return ''


class Deploy(unittest.TestCase):
    def setUp(self):
        live_gateway(self)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        identity = Path(self.tmp.name) / 'identity.agekey'
        identity.write_text('AGE-SECRET-KEY-SYNTHETIC')
        identity.chmod(0o600)
        self.release = DeployFake(args('deploy', apply=True, expected_api_sha=OLD, expected_public_sha=PUBLIC,
                                       expected_compose_sha256=r.digest(installed_compose().encode()),
                                       expected_gateway_sha256=r.digest(GATEWAY.encode()), backup_identity=identity),
                                  self.tmp.name)
        self.release.source_checks = lambda: None
        self.release.ci = lambda: 'proof'

    def test_prepare_artifacts_uses_offline_validator_for_actual_prepared_gateway(self):
        base = {'compose': self.release.compose, 'gateway': r.gateway_candidate(GATEWAY, r.digest(GATEWAY.encode()))}
        with mock.patch.object(self.release, 'remote', wraps=self.release.remote) as remote:
            self.release.prepare_artifacts(base)
        path = self.release.public_dir(SHA) + '/gateway.Caddyfile'
        self.assertEqual(remote.call_args, mock.call(r.caddy_validation_command(path), timeout=45))
        self.assertEqual(self.release.files[path], base['gateway'])
        self.assertTrue(any('config --quiet' in call.args[0] for call in remote.call_args_list[:-1]))

    def run_deploy(self):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            self.release.run()
        return buffer.getvalue()

    def test_deploy_applies_flags_off_then_is_idempotent(self):
        out = json.loads(self.run_deploy())
        self.assertEqual(out['migrations'], list(r.MIGRATIONS))
        rel = self.release
        self.assertEqual(rel.revision, SHA)
        self.assertEqual(rel.pointers[r.REMOTE + '/current'], f'{r.REMOTE}/releases/{SHA}')
        self.assertEqual(rel.pointers[r.REMOTE + '/public-https/current'], f'{r.REMOTE}/public-https/releases/{SHA}')
        self.assertEqual(set(r.flag_environment(rel.env).values()), {'false'})
        self.assertIn('@catalog_media', rel.mounted_gateway)
        # Backup and its restore check happen before the owner migration step.
        names = [c[1] for c in rel.calls]
        backup = next(i for i, c in enumerate(rel.calls) if c[0] == 'remote' and 'bash -o pipefail' in c[1])
        owner = rel.calls.index(('owner', ('deploy',)))
        self.assertLess(backup, owner, names)
        evidence = json.loads((Path(self.tmp.name) / 'phase-deploy.json').read_text())
        self.assertEqual(evidence['applied_migrations'], list(r.MIGRATIONS))
        self.assertEqual(rel.locks, 1)
        rel.calls.clear()
        self.assertIn('already_complete', self.run_deploy())
        self.assertEqual([c for c in rel.calls if c[0] != 'remote'], [])

    def test_gateway_failure_rolls_back_api_and_gateway_keeps_schema(self):
        self.release.fail_gateway = True
        with self.assertRaisesRegex(GuardFailure, 'Simulated gateway failure'):
            self.run_deploy()
        rel = self.release
        self.assertEqual(rel.revision, OLD)
        self.assertEqual(rel.pointers[r.REMOTE + '/current'], f'{r.REMOTE}/releases/{OLD}')
        self.assertEqual(rel.pointers[r.REMOTE + '/public-https/current'], f'{r.REMOTE}/public-https/releases/{PUBLIC}')
        self.assertFalse((Path(self.tmp.name) / 'phase-deploy.json').exists())
        rollback = json.loads((Path(self.tmp.name) / 'rollback.json').read_text())
        self.assertEqual(rollback['schema'], 'retained 047-049')

    def test_changed_neighbour_container_rolls_back_api_and_gateway(self):
        rel = self.release
        original = rel.public_probes

        def probes(capabilities):
            original(capabilities)
            rel.neighbor_state['containers'][r.LIVE_QR_WORKER] = f'qr0 {r.LIVE_API_IMAGE} 2026-10-08T14:20:00Z running 1'
        rel.public_probes = probes
        with self.assertRaisesRegex(GuardFailure, 'Neighbour containers changed'):
            self.run_deploy()
        self.assertEqual(rel.revision, OLD)
        self.assertEqual(rel.pointers[r.REMOTE + '/current'], f'{r.REMOTE}/releases/{OLD}')
        self.assertEqual(rel.pointers[r.REMOTE + '/public-https/current'], f'{r.REMOTE}/public-https/releases/{PUBLIC}')
        self.assertEqual(rel.mounted_gateway, GATEWAY)
        self.assertFalse((Path(self.tmp.name) / 'phase-deploy.json').exists())

    def test_neighbour_change_during_migration_stops_before_the_api_switch(self):
        original = self.release.owner

        def owner(*argv, sha=None):
            result = original(*argv)
            self.release.neighbor_state['containers'].pop('pickchick-kaspi-bridge')
            return result
        self.release.owner = owner
        with self.assertRaisesRegex(GuardFailure, 'Neighbour containers changed'):
            self.run_deploy()
        self.assertEqual(self.release.revision, OLD)
        self.assertFalse(any(c[0] == 'switch' for c in self.release.calls))

    def test_resume_after_a_stopped_migration_reuses_identical_artifacts(self):
        original = self.release.owner

        def broken(*argv, sha=None):
            raise GuardFailure('Simulated owner failure')
        self.release.owner = broken
        with self.assertRaisesRegex(GuardFailure, 'Simulated owner failure'):
            self.run_deploy()
        self.assertEqual(self.release.revision, OLD)
        builds = sum(1 for c in self.release.calls if c[0] == 'remote' and 'docker build' in c[1])
        self.release.owner = original
        json.loads(self.run_deploy())
        self.assertEqual(sum(1 for c in self.release.calls if c[0] == 'remote' and 'docker build' in c[1]), builds)
        self.assertEqual(self.release.revision, SHA)
        # A changed prepared file is never reused.
        other = DeployFake(self.release.args, self.tmp.name)
        other.source_checks, other.ci = (lambda: None), (lambda: 'proof')
        (Path(self.tmp.name) / 'phase-deploy.json').unlink()
        other.files = dict(self.release.files)
        other.files[other.compose_path(SHA)] += '# edited\n'
        with self.assertRaisesRegex(GuardFailure, 'Prepared remote files changed'):
            other.run()

    def test_unexpected_owner_privilege_stops_before_the_api_switch(self):
        original = self.release.owner

        def owner(*argv, sha=None):
            result = original(*argv)
            self.release.grants.add(('commerce_orders', None, 'UPDATE'))
            return result
        self.release.owner = owner
        with self.assertRaisesRegex(GuardFailure, 'Unexpected runtime privilege'):
            self.run_deploy()
        self.assertEqual(self.release.revision, OLD)
        self.assertFalse(any(c[0] == 'switch' for c in self.release.calls))


if __name__ == '__main__':
    unittest.main()
