#!/usr/bin/env python3
"""Unified menu cloud release: one back-office publication for the cashier, kiosk and app.

Owner-run and guarded. Every phase is a separate, explicit invocation; without --apply a
phase only runs its read-only preflight and prints its plan. Order (each gated on the
previous one's private evidence AND on the live API environment):

  deploy            (a) candidate API with cloud047-049 and EVERY new flag off; inert gateway
                        routes (photos, storefront media map, back-office /stops)
  access-roles      CATALOG_ACCESS_ROLES_ENABLED: catalog writes need a manager grant
  verify-edge       (b) read-only: edge_menu_state for the branch, no unacknowledged
                        menu.published events, clean parity report for the head catalog
  edge-publication  (c) CATALOG_EDGE_PUBLICATION_ENABLED + CATALOG_EDGE_PUBLICATION_BRANCH_ID
  remote-stops      (d) BACKOFFICE_REMOTE_STOPS_ENABLED (+ the INSERT grant)
  media-upload      (e) CATALOG_MEDIA_UPLOAD_ENABLED (+ the asset INSERT grants)
  disable --flag X  rollback of one flag; always allowed after deploy, never reorders data

Preflight: exact-SHA green CI, the documented live baseline (API and public pointer at the
kiosk QR recovery release 6ac409f, its API/QR-worker image, the unchanged checkout gateway
a659c242..., cloud schema046; see LIVE_* below) plus the reviewed compose hash (not
documented, so it is an explicit --expected-compose-sha256), migrations 047-049 pending or
applied with matching checksums, and every unrevoked catalog-manager branch assignment covered
by a bo_access_grants row. The kiosk QR worker, bank bridge, mobile worker and every other
neighbour container must be left exactly as found. deploy takes an encrypted backup and
proves an isolated restore before touching the schema. The owner step
(infra/staging/unified-menu-owner.mjs) migrates in one repeatable-read transaction that
proves existing rows unchanged, so cashier heartbeats to cloud_branch_availability during
the release are tolerated rather than mistaken for data changes (docs/project-status.md,
4 October rollback). Secrets are never printed: environment values are compared as
remote SHA-256 digests and failures keep only curated messages. Read
docs/operations/unified-menu-publication.md first. Never edits release-kiosk-checkout.py,
payments, quotes or orders.
"""
import argparse
import copy
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

spec = importlib.util.spec_from_file_location('unified_menu_market', Path(__file__).with_name('release-market.py'))
market = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = market
spec.loader.exec_module(market)
require, digest, quote, GuardFailure = market.require, market.digest, market.quote, market.GuardFailure
REPO, REMOTE, DB = market.REPO, market.REMOTE, market.DB

MIGRATIONS = ('047_cloud_edge_menu_state.sql', '048_cloud_stop_commands.sql', '049_cloud_catalog_assets.sql')
# Live baseline recorded by the kiosk QR engineer after the 8 October install
# (docs/operations/kiosk-v3-launch.md "Установлено 8 октября: 6ac409f",
# docs/operations/kiosk-v3-installation-2026-10-08.json, payment-blockers-2026-10-09.md):
# release-kiosk-qr-recovery.py moved the API, QR worker and public pointer to 6ac409f and kept
# the gateway bytes of the 85f23d5 checkout release. A later payment release changes these:
# update and review them here, never pass other values. The installed compose hash is not
# recorded for 6ac409f, so deploy takes it only from --expected-compose-sha256.
LIVE_API_SHA = '6ac409f710f96e5247e8423963e2ef511a9e4d4a'
LIVE_PUBLIC_SHA = LIVE_API_SHA
LIVE_GATEWAY_SHA256 = 'a659c2428163b2e51c2f1affd62fda18ab339c6e55cf576cdcf0865b2d1d7d9f'
LIVE_API_IMAGE = 'sha256:6ef62d34b54cf1f6788358a8e972d72c3c4fc2f7ad5325734812d45f8131185c'
LIVE_QR_WORKER = 'pickchick-kiosk-kaspi-qr-worker'
# Cloud schema046: 001-040 and 042-046 (041 was never used), 45 ledger rows; the kiosk QR
# migrations keep the bytes pinned by release-kiosk-independent-qr.py / -qr-recovery.py.
LIVE_SCHEMA = tuple(range(1, 41)) + tuple(range(42, 47))
LIVE_MIGRATIONS = {'045_cloud_kiosk_qr_before_admission.sql': '9e2be1892bbb749d1f7780bc7e4d97803748d0592adff63f383a90873d4a3255',
                   '046_cloud_kiosk_qr_recovery.sql': '18ab7ff9d594eb04e0c6ea6c4588f2377d1da6ed3317dfa39e8a1c9e7602e767'}
NEW_TABLES = frozenset({'edge_menu_state', 'catalog_menu_delivery_results', 'cloud_stop_commands',
                        'catalog_assets', 'catalog_asset_variants', 'catalog_asset_audit'})
PHASES = ('deploy', 'access-roles', 'verify-edge', 'edge-publication', 'remote-stops', 'media-upload')
FLAG_PHASES = ('access-roles', 'edge-publication', 'remote-stops', 'media-upload')
FLAG_KEYS = {
    'access-roles': 'CATALOG_ACCESS_ROLES_ENABLED',
    'edge-publication': 'CATALOG_EDGE_PUBLICATION_ENABLED',
    'remote-stops': 'BACKOFFICE_REMOTE_STOPS_ENABLED',
    'media-upload': 'CATALOG_MEDIA_UPLOAD_ENABLED',
}
BRANCH_KEY = 'CATALOG_EDGE_PUBLICATION_BRANCH_ID'
# Literal compose values written by deploy, in this order, all off.
API_FLAGS_OFF = (('CATALOG_ACCESS_ROLES_ENABLED', 'false'), ('CATALOG_EDGE_PUBLICATION_ENABLED', 'false'),
                 (BRANCH_KEY, ''), ('BACKOFFICE_REMOTE_STOPS_ENABLED', 'false'),
                 ('CATALOG_MEDIA_UPLOAD_ENABLED', 'false'))
# provision.mjs derives grants from these two, so a later full provision keeps the same ACL.
PROVISION_FLAGS_OFF = (('BACKOFFICE_REMOTE_STOPS_ENABLED', 'false'), ('CATALOG_MEDIA_UPLOAD_ENABLED', 'false'))
# Owner steps add only the privileges needed by the selected flag.
OWNER_FLAGS = {'access-roles', 'edge-publication', 'remote-stops', 'media-upload'}
VERIFY_EDGE_MAX_AGE = 2 * 60 * 60
EDGE_STATE_MAX_AGE = 120
HEARTBEAT_MAX_AGE = 30
UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
GATEWAY_UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
CADDY = 'caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648'
GATEWAY_FALLBACK = {'code': 'NOT_FOUND', 'environment': 'staging'}


def workflow_jobs(text):
    """Job display names of .github/workflows/ci.yml; the CI proof must contain exactly these."""
    names, inside = set(), False
    for line in text.splitlines():
        if line == 'jobs:':
            inside = True
        elif inside and re.fullmatch(r'    name: (.+)', line):
            names.add(re.fullmatch(r'    name: (.+)', line).group(1).strip())
        elif inside and line and not line.startswith(' '):
            inside = False
    require(names, 'CI workflow lists no jobs')
    return frozenset(names)


def check_live_baseline(args):
    """deploy: exactly the documented live baseline; the compose hash must be given explicitly."""
    require((args.expected_api_sha, args.expected_public_sha, args.expected_gateway_sha256) ==
            (LIVE_API_SHA, LIVE_PUBLIC_SHA, LIVE_GATEWAY_SHA256),
            'Exact live baseline required: API and public ' + LIVE_API_SHA[:7] + ', gateway ' +
            LIVE_GATEWAY_SHA256[:8] + ' (docs/operations/kiosk-v3-launch.md); update LIVE_* after review')
    require(re.fullmatch('[a-f0-9]{64}', args.expected_compose_sha256 or ''),
            '--expected-compose-sha256 must be the SHA-256 of the live API compose')


def check_live_schema(names, checksums):
    """Migrations of the live API tree: exactly schema046 with the installed kiosk QR bytes."""
    require(all(re.fullmatch(r'\d{3}_[a-z0-9_]+\.sql', name) for name in names) and
            [int(name[:3]) for name in names] == list(LIVE_SCHEMA),
            'Live API tree is not the documented cloud schema046 (001-040, 042-046)')
    require(all(name in names and checksums.get(name) == value for name, value in LIVE_MIGRATIONS.items()),
            'Kiosk QR migrations 045/046 differ from the installed bytes')


def check_qr_worker(neighbors):
    """The 6ac409f QR worker runs from the live API image; this release never touches it."""
    fields = neighbors.get('containers', {}).get(LIVE_QR_WORKER, '').split()
    require(len(fields) == 5 and fields[1] == LIVE_API_IMAGE and fields[3] == 'running',
            'Kiosk QR worker is not the documented running 6ac409f container')


def migration_plan(ledger, files, checksums):
    """Installed ledger must be an exact prefix of the candidate; only 047-049 may be pending."""
    require(files[-len(MIGRATIONS):] == list(MIGRATIONS), 'Candidate migrations do not end with 047-049')
    require(all(checksums.get(name) == value for name, value in LIVE_MIGRATIONS.items()),
            'Candidate kiosk QR migrations 045/046 differ from the installed bytes')
    require(len(ledger) <= len(files) and all(
        row == {'version': files[i], 'scope': 'cloud', 'checksum': checksums[files[i]]}
        for i, row in enumerate(ledger)), 'Installed migration ledger differs from the candidate')
    pending = files[len(ledger):]
    require(all(name in MIGRATIONS for name in pending), 'Pending migrations are not exactly 047-049')
    return pending


def check_access_coverage(missing):
    require(isinstance(missing, int) and missing >= 0, 'Invalid access coverage result')
    require(missing == 0, f'{missing} catalog-manager branch assignment(s) have no bo_access_grants row; '
            'backfill roles (docs/operations/unified-menu-publication.md) before this release')


def check_edge_state(snapshot, branch):
    """Edge menu worker (report mode) must be reporting the installed menu for this branch."""
    devices = snapshot.get('devices') or []
    require(len(devices) == 1, 'Branch must have exactly one active edge device')
    state = snapshot.get('state')
    require(state, 'edge_menu_state has no row for the branch: start the menu worker in report mode')
    require(state['device_id'] == devices[0], 'edge_menu_state belongs to another device')
    require(isinstance(state['active_version'], int) and state['active_version'] >= 2,
            'Edge reports a menu older than the installed v2')
    require(0 <= state['age_seconds'] <= EDGE_STATE_MAX_AGE, 'Edge menu state is stale: the worker is not pulling')
    require(re.fullmatch(UUID_RE, state['active_release_id'] or ''), 'Invalid edge release id')
    return {'device_id': state['device_id'], 'active_release_id': state['active_release_id'],
            'active_version': state['active_version']}


def check_menu_events(unacked):
    require(isinstance(unacked, int) and unacked >= 0, 'Invalid outbox result')
    require(unacked == 0, f'{unacked} unacknowledged menu.published event(s) for the branch; '
            'the edge would receive an old publication first')


def check_parity(report, branch, edge, head_version):
    """Output of scripts/catalog-edge-parity.mjs for the current head and the live edge menu."""
    require(isinstance(report, dict), 'Parity report must be a JSON object')
    require(report.get('ok') is True and report.get('failures') == [], 'Parity report has failures')
    require(report.get('branch_id') == branch, 'Parity report is for another branch')
    require(report.get('edge_release_id') == edge['active_release_id'] and
            report.get('edge_version') == edge['active_version'], 'Parity report is not for the edge’s active menu')
    require(head_version is not None and report.get('catalog_version') == head_version,
            'Parity report is not for the current head publication')
    routing = report.get('routing')
    require(isinstance(routing, dict) and 'derived_version' in routing,
            'Parity report must include routing with stations (ROUTING_UNRESOLVED check)')
    return {'warnings': len(report.get('warnings', [])), 'items': report.get('summary', {}).get('matched')}


def phase_gate(phase, evidence, flags, now=None):
    """phase: requested phase; evidence: {phase: saved record}; flags: live flag -> 'true'|'false'."""
    require(phase in PHASES, 'Unknown phase')
    index = PHASES.index(phase)
    if index == 0:
        return
    previous = PHASES[index - 1]
    require(previous in evidence, f'Phase {phase} requires completed phase {previous}')
    require('deploy' in evidence, 'Deploy evidence missing')
    for earlier in PHASES[1:index]:
        if earlier in FLAG_KEYS:
            require(flags.get(earlier) == 'true', f'Phase {phase} requires {earlier} enabled on the live API')
    if phase == 'edge-publication':
        age = (now or time.time()) - evidence['verify-edge']['completed_epoch']
        require(0 <= age <= VERIFY_EDGE_MAX_AGE, 'verify-edge evidence is older than 2 hours; run it again')


def compose_candidate(text, expected_hash):
    """Installed compose plus the five new keys, all off; nothing else changes."""
    require(re.fullmatch('[a-f0-9]{64}', expected_hash or '') and digest(text.encode()) == expected_hash,
            'Installed compose differs from the reviewed hash')
    for key, _ in API_FLAGS_OFF:
        require(key + ':' not in text, 'Installed compose already mentions ' + key)
    api = '      CLOUD_DATABASE_URL: postgresql://pickchick_app:'
    owner = '      CLOUD_DATABASE_URL: postgresql://pickchick_owner:'
    require(text.count('\n' + api) == 1 and text.count('\n' + owner) == 1, 'Compose database anchors differ')
    lines = lambda pairs: ''.join(f'      {k}: "{v}"\n' for k, v in pairs)
    result = text.replace('\n' + api, '\n' + lines(API_FLAGS_OFF) + api, 1)
    result = result.replace('\n' + owner, '\n' + lines(PROVISION_FLAGS_OFF) + owner, 1)
    stripped = result.replace(lines(API_FLAGS_OFF), '', 1).replace(lines(PROVISION_FLAGS_OFF), '', 1)
    require(stripped == text, 'Compose candidate changed more than the flag lines')
    return result


def compose_flag(text, phase, enabled, branch=None):
    """Flip one literal flag (API and, where present, provision). Branch id set once for (c)."""
    key = FLAG_KEYS[phase]
    old, new = ('false', 'true') if enabled else ('true', 'false')
    count = 2 if (key, 'false') in PROVISION_FLAGS_OFF else 1
    require(text.count(f'      {key}: "{old}"\n') == count and f'      {key}: "{new}"\n' not in text,
            f'{key} is not in the expected state in the deployed compose')
    result = text.replace(f'      {key}: "{old}"\n', f'      {key}: "{new}"\n')
    if phase == 'edge-publication' and enabled:
        require(re.fullmatch(UUID_RE, branch or ''), 'Branch id required')
        values = re.findall(r'\n      ' + BRANCH_KEY + r': "([^"\n]*)"\n', result)
        require(len(values) == 1 and values[0] in ('', branch), 'Edge publication branch differs')
        result = result.replace(f'      {BRANCH_KEY}: "{values[0]}"\n', f'      {BRANCH_KEY}: "{branch}"\n')
    return result


def flag_environment(env):
    """Live flag values from remote env digests (the value itself never leaves the server)."""
    on, off = digest(b'true'), digest(b'false')
    result = {}
    for phase, key in FLAG_KEYS.items():
        value = env.get(key)
        result[phase] = 'true' if value == on else 'false' if value in (off, None) else 'invalid'
    return result


def verify_environment_delta(before, after, changes, *, release_sha_may_change=False):
    """Only the reviewed keys changed, to the reviewed values (compared as digests)."""
    ignored = {'RELEASE_SHA'} if release_sha_may_change else set()
    for key, value in changes.items():
        require(after.get(key) == digest(value.encode()), 'Environment value missing for ' + key)
    unchanged = lambda env: {k: v for k, v in env.items() if k not in changes and k not in ignored}
    require(unchanged(before) == unchanged(after), 'Other API environment changed')


def verify_availability(before, after):
    """Heartbeats may advance revision/observed_at (and report new stops); bindings never change."""
    def keyed(rows):
        result = {row['branch_id']: row for row in rows}
        require(len(result) == len(rows), 'Duplicate availability branch')
        return result
    old, new = keyed(before), keyed(after)
    require(old.keys() == new.keys(), 'Availability rows appeared or disappeared')
    for branch, row in old.items():
        current = new[branch]
        require(set(row) <= set(current) and set(current) - set(row) <= {'stop_states'}, 'Availability columns changed')
        require(current['device_id'] == row['device_id'], 'Availability device binding changed')
        revision, prior = int(current['revision']), int(row['revision'])
        stamp = datetime.fromisoformat(current['observed_at'])
        earlier = datetime.fromisoformat(row['observed_at'])
        require(revision >= prior and stamp >= earlier, 'Availability heartbeat regressed')
        if revision == prior:
            require(stamp == earlier and all(current[k] == row[k] for k in row), 'Availability changed without a heartbeat')
            require(current.get('stop_states') is None or 'stop_states' in row, 'stop_states filled without a heartbeat')
        else:
            require(stamp > earlier, 'Availability heartbeat pair inconsistent')


def acl_key(row):
    return (row['name'], row['column'], row['privilege'])


def deploy_acl(transport):
    """Exact runtime privileges on the new tables after deploy (flags off)."""
    rows = {('edge_menu_state', None, 'SELECT'), ('edge_menu_state', None, 'INSERT'),
            ('catalog_menu_delivery_results', None, 'SELECT'), ('catalog_menu_delivery_results', None, 'INSERT'),
            ('catalog_assets', None, 'SELECT'), ('catalog_asset_variants', None, 'SELECT')}
    rows |= {('edge_menu_state', c, 'UPDATE') for c in ['active_release_id', 'active_version', 'observed_at']}
    if transport:
        rows |= {('cloud_stop_commands', None, 'SELECT')}
        rows |= {('cloud_stop_commands', c, 'UPDATE') for c in ['state', 'result_version', 'delivered_at', 'resolved_at']}
    return rows


STOP_INSERT = ('cloud_stop_commands', None, 'INSERT')
MEDIA_WRITE = frozenset({('catalog_assets', None, 'INSERT'), ('catalog_asset_variants', None, 'INSERT'),
                         ('catalog_asset_audit', None, 'SELECT'), ('catalog_asset_audit', None, 'INSERT')})
ACCESS_READ = frozenset({('bo_access_grants', None, 'SELECT'), ('bo_access_grants', 'lock_anchor', 'UPDATE')})
EDGE_PUBLICATION_WRITE = frozenset({(table, None, 'INSERT') for table in
                                   ['catalog_menu_deliveries', 'menu_releases', 'menu_streams', 'outbox_events']} |
                                  {('menu_streams', 'last_sequence', 'UPDATE')})
EDGE_PUBLICATION_READ = frozenset({(table, None, 'SELECT') for table in
                                  ['catalog_menu_deliveries', 'menu_releases', 'menu_streams', 'outbox_events',
                                   'branches', 'devices', 'branch_menu_activations', 'inbox_messages',
                                   'fulfillment_transport_bindings', 'edge_menu_state', 'catalog_menu_delivery_results']})


def check_edge_publication_acl(rows, *, writable=False):
    keys = {acl_key(row) for row in rows}
    required = EDGE_PUBLICATION_READ | (EDGE_PUBLICATION_WRITE if writable else frozenset())
    require(required <= keys, 'Menu publication runtime privileges missing')
    for table in ['branches', 'devices']:
        require(any(name == table and privilege == 'UPDATE' for name, _, privilege in keys),
                'Menu publication row-lock privilege missing: ' + table)


def flag_acl(phase, enabled):
    """(may be added, may be removed, must hold afterwards, must be absent afterwards) per flag switch."""
    if phase == 'remote-stops':
        extra = {('catalog_publications', None, 'SELECT'), ('cloud_stop_commands', 'state', 'UPDATE'),
                 ('cloud_stop_commands', 'resolved_at', 'UPDATE')}
        return ((frozenset({STOP_INSERT} | extra), frozenset(), frozenset({STOP_INSERT}), frozenset()) if enabled
                else (frozenset(), frozenset({STOP_INSERT}), frozenset(), frozenset({STOP_INSERT})))
    if phase == 'media-upload':
        return ((MEDIA_WRITE, frozenset(), MEDIA_WRITE, frozenset()) if enabled
                else (frozenset(), MEDIA_WRITE, frozenset(), MEDIA_WRITE))
    if phase == 'access-roles' and enabled:
        return ACCESS_READ, frozenset(), ACCESS_READ, frozenset()
    if phase == 'edge-publication' and enabled:
        return EDGE_PUBLICATION_WRITE, frozenset(), EDGE_PUBLICATION_WRITE, frozenset()
    return frozenset(), frozenset(), frozenset(), frozenset()


def verify_acl_change(before, after, *, added=frozenset(), removed=frozenset(), new_tables=frozenset(),
                      exact_new=None, present=frozenset(), absent=frozenset()):
    old = {acl_key(r) for r in before}
    new = {acl_key(r) for r in after}
    require(all(r['grantable'] is False for r in after), 'Grantable runtime privilege found')
    require(new - old <= set(added) | {k for k in new if k[0] in new_tables}, 'Unexpected runtime privilege added')
    require(old - new <= set(removed), 'Unexpected runtime privilege removed')
    require(set(present) <= new and not (set(absent) & new), 'Runtime privileges do not match the flag')
    if exact_new is not None:
        require({k for k in new if k[0] in new_tables} == exact_new, 'New-table runtime privileges differ from review')


def relocate_public_mounts(config, old, new):
    result = copy.deepcopy(config)
    volumes = result['services']['gateway']['volumes']
    expected = {'/etc/caddy/Caddyfile': 'gateway.Caddyfile', '/srv/public': 'public-web'}
    require(len(volumes) == 2 and {v['target'] for v in volumes} == set(expected), 'Unexpected gateway mount set')
    for volume in volumes:
        require(volume['type'] == 'bind' and volume['read_only'] is True and
                volume['source'] == old + '/' + expected[volume['target']], 'Unexpected gateway bind source')
        volume['source'] = new + '/' + expected[volume['target']]
    return result


def _once(text, old, new, label):
    require(text.count(old) == 1, 'Gateway anchor not found exactly once: ' + label)
    return text.replace(old, new, 1)


def _handle(name, timeout, extra=''):
    return (f'\thandle @{name} {{\n\t\theader X-PickChick-Data catalog\n{extra}'
            '\t\treverse_proxy pickchick-staging-api-1:3100 {\n'
            + ('\t\t\theader_up -Authorization\n' if name == 'catalog_media' else '') +
            '\t\t\theader_up -Cookie\n\t\t\theader_up -X-Device-Id\n\t\t\ttransport http {\n'
            f'\t\t\t\tdial_timeout 2s\n\t\t\t\tresponse_header_timeout {timeout}\n\t\t\t}}\n\t\t}}\n\t}}\n')


MEDIA_RE = '^/v1/media/catalog/[a-f0-9]{64}(\\.(card|hero|thumb))?\\.webp$'
UPLOAD_RE = f'^/v1/admin/catalog/branches/{GATEWAY_UUID}/assets$'


def gateway_media(text):
    """WP-F: photo upload (10 MiB, one route), immutable media and the narrowed no-store."""
    header = ('\theader {\n\t\tCache-Control no-store\n\t\tX-Content-Type-Options nosniff\n'
              '\t\tX-PickChick-Environment staging\n\t\tX-PickChick-Ordering disabled\n\t\t-Server\n\t}\n')
    no_store = ('\t# Every response is no-store, except a GET/HEAD of a catalog photo rendition: its route\n'
                '\t# (@catalog_media) caches a success immutably and keeps no-store on any error.\n'
                '\t@no_store {\n\t\tnot {\n\t\t\tmethod GET HEAD\n'
                f'\t\t\tpath_regexp no_store_media_exception {MEDIA_RE}\n\t\t}}\n\t}}\n'
                '\theader @no_store >Cache-Control no-store\n')
    text = _once(text, header, header.replace('\t\tCache-Control no-store\n', '', 1) + no_store, 'site headers')
    surfaces = re.findall(r'\t@synthetic_surfaces \{\n\t\tnot path ([^\n]+)\n\t\}\n', text)
    require(len(surfaces) == 1 and ' /v1/admin/catalog/* ' in f' {surfaces[0]} ' and
            '/v1/media/' not in surfaces[0], 'Gateway anchor not found exactly once: synthetic surfaces')
    paths = surfaces[0].replace('/v1/admin/catalog/*', '/v1/admin/catalog/* /v1/media/catalog/*', 1)
    text = _once(text, f'\t\tnot path {surfaces[0]}\n', f'\t\tnot path {paths}\n', 'synthetic surfaces')
    upload = ('\t# Catalog photo upload: raw image bytes, re-encoded by the API (CATALOG_MEDIA_UPLOAD_ENABLED).\n'
              f'\t@catalog_asset_upload {{\n\t\tmethod POST\n\t\tpath_regexp catalog_asset_upload {UPLOAD_RE}\n\t}}\n'
              '\trequest_body @catalog_asset_upload {\n\t\tmax_size 10MiB\n\t}\n')
    small = ('\t@small_body {\n\t\tnot {\n\t\t\tmethod PUT\n\t\t\tpath_regexp small_body_exception '
             f'^/v1/admin/catalog/branches/{GATEWAY_UUID}/draft$\n\t\t}}\n')
    exception = (f'\t\tnot {{\n\t\t\tmethod POST\n\t\t\tpath_regexp small_body_asset_exception {UPLOAD_RE}\n\t\t}}\n')
    text = _once(text, small, upload + small + exception, 'small body')
    admin = f'\t\tpath_regexp catalog_admin_get ^/v1/admin/catalog/branches(/{GATEWAY_UUID})?$\n'
    text = _once(text, admin, admin.replace(f'{GATEWAY_UUID})?$', f'{GATEWAY_UUID}(/assets)?)?$'), 'catalog admin get')
    media = ('\t# Immutable, content-addressed photo renditions. No credentials reach the API; only a\n'
             '\t# successful (or not-modified) response may be cached, never an error.\n'
             f'\t@catalog_media {{\n\t\tmethod GET HEAD\n\t\tpath_regexp catalog_media {MEDIA_RE}\n\t}}\n')
    cache = ('\t\theader {\n\t\t\t>Cache-Control "public, max-age=31536000, immutable"\n\t\t\tmatch status 200 304\n\t\t}\n'
             '\t\theader {\n\t\t\t>Cache-Control no-store\n\t\t\tmatch status 4xx 5xx\n\t\t}\n')
    block = _handle('catalog_asset_upload', '30s') + media + _handle('catalog_media', '5s', cache)
    return _once(text, '\t@published_catalog {\n', block + '\t@published_catalog {\n', 'published catalog')


def gateway_stops(text):
    """WP-G/H: the v2 stop list (GET) and stop/unstop requests (POST, 16 KB cap) in token mode."""
    get_old = f'(/finance|/orders/{GATEWAY_UUID})?$\n'
    text = _once(text, f'path_regexp backoffice_get ^/v1/admin/backoffice/branches/{GATEWAY_UUID}{get_old}',
                 f'path_regexp backoffice_get ^/v1/admin/backoffice/branches/{GATEWAY_UUID}(/finance|/stops|/orders/{GATEWAY_UUID})?$\n',
                 'back-office get')
    return _once(text, f'path_regexp backoffice_post ^/v1/admin/backoffice/branches/{GATEWAY_UUID}(/finance)?/commands$\n',
                 f'path_regexp backoffice_post ^/v1/admin/backoffice/branches/{GATEWAY_UUID}((/finance)?/commands|/stops)$\n',
                 'back-office post')


def gateway_storefront(text):
    """WP-K: media maps for both storefronts; kiosk availability long-poll needs > 25 s."""
    kiosk = '\t\tpath /v1/kiosk-checkout/config /v1/kiosk-checkout/catalog /v1/kiosk-checkout/availability\n'
    text = _once(text, kiosk, kiosk[:-1] + ' /v1/kiosk-checkout/catalog/media\n', 'kiosk read paths')
    read = ('\thandle @kiosk_menu_read {\n\t\theader X-PickChick-Data kiosk\n\t\treverse_proxy pickchick-staging-api-1:3100 {\n'
            '\t\t\theader_up -Cookie\n\t\t\theader_up -X-Device-Id\n\t\t\ttransport http {\n'
            '\t\t\t\tdial_timeout 2s\n\t\t\t\tresponse_header_timeout 5s\n')
    text = _once(text, read, read.replace('response_header_timeout 5s', 'response_header_timeout 30s'), 'kiosk read handle')
    require("'/v1/customer-checkout/catalog/media'" not in text, 'Customer media route already present')
    return _once(text, "'/v1/customer-checkout/catalog'", "'/v1/customer-checkout/catalog', '/v1/customer-checkout/catalog/media'",
                 'customer catalog path')


def gateway_candidate(text, expected_hash):
    require(re.fullmatch('[a-f0-9]{64}', expected_hash or '') and digest(text.encode()) == expected_hash,
            'Installed gateway differs from the reviewed hash')
    require('@catalog_media' not in text and '/stops' not in text, 'Gateway already carries unified-menu routes')
    return gateway_storefront(gateway_stops(gateway_media(text)))


def caddy_validation_command(path):
    """Match the pinned Caddy file capability without granting network or filesystem access."""
    # The official binary has cap_net_bind_service=ep; dropping it from the bounding set
    # prevents exec even for offline validation. --mount refuses a missing source instead
    # of creating a directory as Docker -v does; refuse non-files and symlinks first.
    return ('test -f ' + quote(path) + ' && test ! -L ' + quote(path) +
            ' && docker run --rm --network none --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE '
            '--security-opt no-new-privileges:true --tmpfs /tmp --tmpfs /config --tmpfs /data '
            '--entrypoint caddy --mount ' + quote('type=bind,source=' + path + ',target=/tmp/Caddyfile,readonly') +
            ' ' + CADDY + ' validate --config /tmp/Caddyfile --adapter caddyfile')


class Release(market.Release):
    """Remote effects go through market.Release (ssh, psql, private evidence, shared lock)."""

    def __init__(self, args):
        args.action = args.phase
        jobs = workflow_jobs((REPO / '.github/workflows/ci.yml').read_text())
        profile = market.ReleaseProfile('unified-menu-047-049', args.expected_api_sha or '', args.expected_public_sha or '',
                                        0, MIGRATIONS, jobs, frozenset(), 'unified-menu-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)
        require(re.fullmatch(UUID_RE, args.branch_id or ''), 'A lower-case catalog branch UUID is required')
        self.branch_id = args.branch_id

    # ---------- evidence ----------
    def evidence(self):
        result = {}
        for phase in PHASES:
            path = self.private / ('phase-' + phase + '.json')
            if path.is_file() and not path.is_symlink():
                record = json.loads(path.read_text())
                require(record.get('phase') == phase and record.get('source_sha') == self.sha, 'Foreign phase evidence')
                result[phase] = record
        return result

    def complete(self, phase, record):
        self.save('phase-' + phase + '.json', {'phase': phase, 'source_sha': self.sha, 'completed_epoch': time.time(),
                                               'completed_at': datetime.now(timezone.utc).isoformat(), **record})

    # ---------- live reads ----------
    def runtime_environment(self):
        script = '''import hashlib,json,sys
rows=json.load(sys.stdin);result={}
for row in rows:
 key,value=row.split('=',1)
 assert key not in result
 result[key]=hashlib.sha256(value.encode()).hexdigest()
print(json.dumps(result,sort_keys=True))'''
        return json.loads(self.remote('docker inspect --format ' + quote('{{json .Config.Env}}') + ' ' +
                                      market.API_CONTAINER + ' | python3 -c ' + quote(script)))

    def running_revision(self):
        return self.remote('docker inspect --format ' + quote('{{index .Config.Labels "org.opencontainers.image.revision"}}')
                           + ' ' + market.API_CONTAINER)

    def compose_path(self, sha):
        return f'{REMOTE}/releases/{sha}/infra/staging/compose.yaml'

    def read_text(self, path):
        return self.remote('cat ' + quote(path)) + '\n'

    def json_query(self, sql):
        return json.loads(self.psql(DB, sql))

    def coverage(self):
        return int(self.psql(DB, """SELECT count(*) FROM catalog_manager_branches s
          JOIN catalog_managers m ON m.id=s.actor_id AND m.organization_id=s.organization_id
          LEFT JOIN bo_access_grants g ON g.actor_id=s.actor_id AND g.branch_id=s.branch_id
          WHERE m.revoked_at IS NULL AND g.actor_id IS NULL"""))

    def edge_snapshot(self):
        b = self.branch_id  # validated UUID; interpolation is safe
        return self.json_query(f"""SELECT json_build_object(
          'devices',(SELECT coalesce(json_agg(id ORDER BY id),'[]') FROM devices WHERE branch_id='{b}' AND kind='edge' AND status='active'),
          'state',(SELECT to_json(s) FROM (SELECT device_id,active_release_id,active_version,
              extract(epoch FROM clock_timestamp()-observed_at)::float AS age_seconds FROM edge_menu_state WHERE branch_id='{b}') s),
          'unacked',(SELECT count(*) FROM outbox_events WHERE branch_id='{b}' AND event_type='menu.published' AND acknowledged_at IS NULL),
          'head',(SELECT published_version FROM catalog_branch_heads WHERE branch_id='{b}'))""")

    def heartbeat(self):
        b = self.branch_id
        return self.json_query(f"""SELECT coalesce((SELECT json_build_object('protocol4',(stop_states IS NOT NULL),
          'age_seconds',extract(epoch FROM clock_timestamp()-observed_at)::float,
          'device_matches',device_id=(SELECT id FROM devices WHERE branch_id='{b}' AND kind='edge' AND status='active'))
          FROM cloud_branch_availability WHERE branch_id='{b}'),'null'::json)""")

    def availability_rows(self):
        return self.json_query("SELECT coalesce(json_agg(to_jsonb(t) ORDER BY branch_id),'[]') FROM cloud_branch_availability t")

    def candidate_migrations(self):
        files = sorted(p.name for p in (REPO / 'db/cloud/migrations').glob('*.sql'))
        return files, {name: digest((REPO / 'db/cloud/migrations' / name).read_bytes()) for name in files}

    def role_restricted(self):
        role = self.json_query("SELECT json_build_object('superuser',rolsuper,'createdb',rolcreatedb,'createrole',rolcreaterole,"
                               "'replication',rolreplication,'bypassrls',rolbypassrls,'memberships',"
                               "(SELECT count(*) FROM pg_auth_members WHERE member=r.oid)) FROM pg_roles r WHERE rolname='pickchick_app'")
        require(role == {'superuser': False, 'createdb': False, 'createrole': False, 'replication': False,
                         'bypassrls': False, 'memberships': 0}, 'Runtime role is more privileged than reviewed')

    def owner(self, *argv, sha=None):
        output = self.remote(market.api_compose(sha or self.sha) + ' run --rm --no-deps --entrypoint node provision '
                             'infra/staging/unified-menu-owner.mjs ' + ' '.join(map(quote, argv)), timeout=240)
        return json.loads(output.splitlines()[-1])

    def ready(self):
        ready = self.http_json('/health/ready', public=False)
        require(ready.get('ready') is True, 'API is not ready')

    # ---------- source and baseline ----------
    def source_checks(self):
        args = self.args
        require(re.fullmatch('[a-f0-9]{40}', self.sha) and self.sha != args.expected_api_sha, 'A new full commit SHA is required')
        require(self.git('rev-parse', 'HEAD') == self.sha, 'Release must use the checked-out HEAD')
        require(not self.git('status', '--porcelain', '--untracked-files=all'), 'Source checkout is dirty')
        require(re.fullmatch('[A-Za-z0-9._/-]{1,160}', args.branch) and '..' not in args.branch, 'Invalid pushed branch name')
        pushed = self.git('ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/' + args.branch)
        require(pushed.split()[0] == self.sha, 'Pushed branch differs from the checked SHA')
        files, _ = self.candidate_migrations()
        require(files[-len(MIGRATIONS):] == list(MIGRATIONS), 'Candidate migrations do not end with 047-049')
        installed = sorted(Path(p).name for p in self.git('ls-tree', '-r', '--name-only', args.expected_api_sha, '--',
                                                         'db/cloud/migrations/').splitlines() if p.endswith('.sql'))
        require(installed and files[:len(installed)] == installed, 'Installed migrations are not a prefix of the candidate')
        for name in installed:
            prior = self.execute(['git', 'show', args.expected_api_sha + ':db/cloud/migrations/' + name])
            require((REPO / 'db/cloud/migrations' / name).read_bytes() == prior, 'An installed migration was edited: ' + name)
        check_live_schema(installed, {name: digest((REPO / 'db/cloud/migrations' / name).read_bytes()) for name in installed})

    def api_image(self):
        return self.remote('docker inspect --format ' + quote('{{.Image}}') + ' ' + market.API_CONTAINER)

    def neighbors(self):
        """Every container except the API and gateway (QR worker, bank bridge, mobile worker,
        database) and the shared front: deploy must leave them exactly as found."""
        result = self.fingerprint()
        check_qr_worker(result)
        return result

    def deploy_baseline(self):
        a = self.args
        for value in [a.expected_api_sha, a.expected_public_sha]:
            require(re.fullmatch('[a-f0-9]{40}', value or ''), 'Expected API and public SHAs are required')
        check_live_baseline(a)
        require(self.running_revision() == a.expected_api_sha, 'Running API is not the reviewed baseline')
        require(self.api_image() == LIVE_API_IMAGE, 'Running API image is not the documented live image')
        require(self.remote('docker image inspect --format ' + quote('{{.Id}}') + ' pickchick-api:' + a.expected_api_sha) ==
                LIVE_API_IMAGE, 'Rollback image differs from the documented live image')
        require(self.remote('readlink -f ' + REMOTE + '/current') == f'{REMOTE}/releases/{a.expected_api_sha}', 'API pointer changed')
        require(self.remote('readlink -f ' + REMOTE + '/public-https/current') ==
                f'{REMOTE}/public-https/releases/{a.expected_public_sha}', 'Public pointer changed')
        require(self.remote('docker exec ' + market.GATEWAY + ' sha256sum /etc/caddy/Caddyfile').split()[0] ==
                a.expected_gateway_sha256, 'Mounted gateway differs from the reviewed hash')
        compose = self.read_text(self.compose_path(a.expected_api_sha))
        gateway = self.read_text(self.public_dir(a.expected_public_sha) + '/gateway.Caddyfile')
        self.role_restricted()
        files, checksums = self.candidate_migrations()
        pending = migration_plan(self.ledger(), files, checksums)
        check_access_coverage(self.coverage())
        self.neighbors()
        return {'compose': compose_candidate(compose, a.expected_compose_sha256),
                'gateway': gateway_candidate(gateway, a.expected_gateway_sha256), 'pending': pending,
                'environment': self.runtime_environment()}

    def public_dir(self, sha):
        return f'{REMOTE}/public-https/releases/{sha}/infra/public-staging'

    # ---------- phases ----------
    def run(self):
        phase = self.args.phase
        if phase == 'deploy':
            return self.deploy()
        if phase == 'verify-edge':
            return self.verify_edge()
        if phase == 'disable':
            return self.disable()
        return self.enable(phase)

    def plan(self, phase, detail):
        print(json.dumps({'phase': phase, 'validated': True, 'applied': False, **detail}, sort_keys=True), flush=True)

    def deploy(self):
        evidence = self.evidence()
        if 'deploy' in evidence:
            require(self.running_revision() == self.sha, 'Deploy evidence exists but another API is running')
            print(json.dumps({'phase': 'deploy', 'already_complete': True}), flush=True)
            return
        self.source_checks()
        self.ci()
        base = self.deploy_baseline()
        if not self.args.apply:
            return self.plan('deploy', {'pending_migrations': base['pending']})
        key = self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0,
                'Protected backup identity required')
        with self.deployment_lock():
            self.deploy_apply(base)

    def prepare_artifacts(self, base):
        a, target = self.args, f'{REMOTE}/releases/{self.sha}'
        archive = self.execute(['git', 'archive', '--format=tar', self.sha, *market.ARCHIVE_PATHS])
        self.remote(f'test ! -e {target} && mkdir {target} && tar -xf - -C {target}', input=archive, timeout=180)
        env = '''from pathlib import Path
import sys
old,new,sha,old_sha=sys.argv[1:]
lines=Path(old).read_text().splitlines()
assert lines.count('RELEASE_SHA='+old_sha)==1
lines=[line for line in lines if not line.startswith('RELEASE_SHA=')]
with open(new,'x') as output:
 Path(new).chmod(0o600)
 output.write('\\n'.join(lines+['RELEASE_SHA='+sha])+'\\n')
'''
        self.remote('python3 -c ' + quote(env) + ' ' + ' '.join(map(quote, [
            f'{REMOTE}/releases/{a.expected_api_sha}/release.env', target + '/release.env', self.sha, a.expected_api_sha])))
        self.write_remote(self.compose_path(self.sha), base['compose'])
        self.remote('! docker image inspect pickchick-api:' + self.sha + ' >/dev/null 2>&1')
        image = self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} '
                            f'-t pickchick-api:{self.sha} .', timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'Docker build did not return one image ID')
        self.remote(market.api_compose(self.sha) + ' config --quiet')
        old, new = self.public_dir(a.expected_public_sha), self.public_dir(self.sha)
        self.remote(f'test ! -e {REMOTE}/public-https/releases/{self.sha} && mkdir -p {new} && cp -a {old}/. {new}/', timeout=180)
        web = json.loads(self.remote(market.web_compose(a.expected_public_sha) + ' config --format json'))
        self.write_remote(new + '/compose.yaml', json.dumps(relocate_public_mounts(web, old, new)))
        self.write_remote(new + '/gateway.Caddyfile', base['gateway'], public=True)
        self.remote(market.web_compose(self.sha) + ' config --quiet')
        self.remote(caddy_validation_command(new + '/gateway.Caddyfile'), timeout=45)
        return {'image_id': image, 'archive_sha256': digest(archive), 'gateway_sha256': digest(base['gateway'].encode()),
                'compose_sha256': digest(base['compose'].encode())}

    def verify_prepared(self, prepared, base):
        require(prepared['compose_sha256'] == digest(base['compose'].encode()) and
                prepared['gateway_sha256'] == digest(base['gateway'].encode()), 'Prepared candidate differs from today’s')
        require(digest(self.read_text(self.compose_path(self.sha)).encode()) == prepared['compose_sha256'] and
                digest(self.read_text(self.public_dir(self.sha) + '/gateway.Caddyfile').encode()) == prepared['gateway_sha256'],
                'Prepared remote files changed')
        require(self.remote('docker image inspect --format ' + quote('{{.Id}}') + ' pickchick-api:' + self.sha) ==
                prepared['image_id'], 'Prepared API image changed')

    def write_remote(self, path, text, public=False):
        mode = '0o644' if public else '0o600'
        writer = ('from pathlib import Path;import sys;p=Path(sys.argv[1]);p.write_bytes(sys.stdin.buffer.read());'
                  'p.chmod(' + mode + ')')
        self.remote('python3 -c ' + quote(writer) + ' ' + quote(path), input=text)

    def backup_restore(self):
        """Encrypted dump plus isolated restore; checks ledger and table set, not live row equality."""
        suffix = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
        backup = f'{REMOTE}/backups/cloud-unified-menu-{suffix}.dump.age'
        script = f'''set -euo pipefail
umask 077
exec 9>{REMOTE}/backups/.lock
flock -n 9
recipient=$(cat {REMOTE}/secrets/backup-recipient.txt)
[[ "$recipient" == age1* ]]
test ! -e {backup}
trap 'rm -f {backup}.tmp' EXIT
docker exec {market.DB_CONTAINER} pg_dump -U postgres -d {DB} --format=custom --no-owner --no-acl | age -r "$recipient" -o {backup}.tmp
test -s {backup}.tmp
mv {backup}.tmp {backup}
sha256sum {backup} > {backup}.sha256
'''
        ledger, tables = self.ledger(), self.table_names(DB)
        self.remote('bash -o pipefail -c ' + quote(script), timeout=180)
        self.remote('sha256sum --check ' + backup + '.sha256')
        database = 'pickchick_restore_unified_' + uuid.uuid4().hex[:12]
        created = False
        try:
            self.remote(f'docker exec {market.DB_CONTAINER} createdb -U postgres {database}')
            created = True
            pipeline = (f'age --decrypt --identity /dev/stdin {backup} | docker exec -i {market.DB_CONTAINER} '
                        f'pg_restore -U postgres -d {database} --exit-on-error --no-owner --no-acl')
            self.remote('bash -o pipefail -c ' + quote(pipeline), input=self.args.backup_identity.read_bytes(), timeout=180)
            require(self.ledger(database) == ledger and self.table_names(database) == tables, 'Restored backup differs')
        finally:
            if created:
                self.remote(f'docker exec {market.DB_CONTAINER} dropdb -U postgres {database}')
        return {'path': backup, 'sha256': self.remote('sha256sum ' + backup).split()[0], 'restore': 'passed'}

    def table_names(self, database):
        return json.loads(self.psql(database, "SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]') FROM pg_tables WHERE schemaname='public'"))

    def deploy_apply(self, base):
        a = self.args
        if (self.private / 'prepared.json').is_file():
            # Resume after a stop before the API switch: reuse only byte-identical artifacts.
            prepared = json.loads((self.private / 'prepared.json').read_text())
            self.verify_prepared(prepared, base)
        else:
            prepared = self.prepare_artifacts(base)
            self.save('prepared.json', prepared)
        before = {'acl': self.acl(), 'availability': self.availability_rows(), 'environment': base['environment'],
                  'capabilities': self.http_json('/v1/capabilities', public=False), 'neighbors': self.neighbors()}
        transport = any(acl_key(r) == ('cloud_branch_availability', None, 'UPDATE') for r in before['acl'])
        self.save('before.json', {k: v for k, v in before.items() if k != 'environment'})
        backup = self.backup_restore()
        self.save('backup.json', backup)
        stage = 'migrating'
        try:
            result = self.owner('deploy')
            self.save('owner-deploy.json', result)
            require(result['applied'] == base['pending'] and result['lastMigration'] == MIGRATIONS[-1] and
                    result['privilegesRemoved'] == [] and result['transportGrants'] == transport, 'Owner step result differs')
            # The old API keeps serving on the retained, additive schema (compatibility proof).
            self.ready()
            verify_acl_change(before['acl'], self.acl(), new_tables=NEW_TABLES, exact_new=deploy_acl(transport))
            verify_availability(before['availability'], self.availability_rows())
            require(self.neighbors() == before['neighbors'], 'Neighbour containers changed (QR worker, bank bridge, database)')
            stage = 'api'
            self.remote(market.api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            self.ready()
            require(self.remote('docker inspect --format ' + quote('{{.Image}}') + ' ' + market.API_CONTAINER) ==
                    prepared['image_id'], 'Running image differs from the prepared image')
            verify_environment_delta(before['environment'], self.runtime_environment(),
                                     {k: v for k, v in API_FLAGS_OFF}, release_sha_may_change=True)
            require(self.http_json('/v1/capabilities', public=False) == before['capabilities'], 'API capabilities changed')
            self.switch(REMOTE + '/current', f'{REMOTE}/releases/{a.expected_api_sha}', f'{REMOTE}/releases/{self.sha}')
            stage = 'gateway'
            self.switch(REMOTE + '/public-https/current', f'{REMOTE}/public-https/releases/{a.expected_public_sha}',
                        f'{REMOTE}/public-https/releases/{self.sha}')
            self.remote(market.web_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 90 gateway', timeout=150)
            require(self.remote('docker exec ' + market.GATEWAY + ' sha256sum /etc/caddy/Caddyfile').split()[0] ==
                    prepared['gateway_sha256'], 'Mounted gateway differs from the prepared one')
            self.public_probes(before['capabilities'])
            verify_availability(before['availability'], self.availability_rows())
            require(self.neighbors() == before['neighbors'], 'Neighbour containers changed (QR worker, bank bridge, database)')
        except market.CommandUncertain:
            raise  # Completion unknown: keep the lock, inspect before any rollback.
        except Exception:
            self.save('failure-stage.json', {'stage': stage})
            if stage != 'migrating':
                self.rollback_deploy(stage)
            raise
        self.complete('deploy', {'image_id': prepared['image_id'], 'compose_sha256': prepared['compose_sha256'],
                                 'gateway_sha256': prepared['gateway_sha256'], 'backup': backup,
                                 'applied_migrations': result['applied'], 'transport_grants': transport})
        print(json.dumps({'phase': 'deploy', 'applied': True, 'migrations': result['applied'],
                          'flags': 'all off', 'backup_restore': 'passed'}), flush=True)

    def routed(self, path, statuses):
        """The API (not the gateway's 404 fallback) answered with one of the expected statuses."""
        status, body = self.http(path)
        try:
            payload = json.loads(body)
        except ValueError:
            payload = None
        require(status in statuses and payload != GATEWAY_FALLBACK, 'Route not served by the API: ' + path.split('?')[0])

    def public_probes(self, capabilities):
        require(self.http_json('/v1/capabilities') == capabilities, 'Public capabilities changed')
        self.routed('/v1/media/catalog/' + '0' * 64 + '.webp', {404})  # uploads off: API 404
        self.routed(f'/v1/admin/backoffice/branches/{self.branch_id}/stops', {401, 503})
        self.routed('/v1/kiosk-checkout/catalog/media?version=1', {400, 401, 403, 404, 503})

    def rollback_deploy(self, stage):
        """Old API and gateway back; schema 047-049 retained (additive, proven compatible)."""
        a = self.args
        try:
            if stage == 'gateway':
                if self.remote('readlink -f ' + REMOTE + '/public-https/current') != f'{REMOTE}/public-https/releases/{a.expected_public_sha}':
                    self.switch(REMOTE + '/public-https/current', f'{REMOTE}/public-https/releases/{self.sha}',
                                f'{REMOTE}/public-https/releases/{a.expected_public_sha}')
                self.remote(market.web_compose(a.expected_public_sha) + ' up -d --no-deps --wait --wait-timeout 90 gateway', timeout=150)
            if self.remote('readlink -f ' + REMOTE + '/current') != f'{REMOTE}/releases/{a.expected_api_sha}':
                self.switch(REMOTE + '/current', f'{REMOTE}/releases/{self.sha}', f'{REMOTE}/releases/{a.expected_api_sha}')
            self.remote(market.api_compose(a.expected_api_sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            self.ready()
            require(self.running_revision() == a.expected_api_sha, 'Rollback API revision differs')
            require(self.api_image() == LIVE_API_IMAGE, 'Rollback API image differs')
            self.save('rollback.json', {'stage': stage, 'api': a.expected_api_sha, 'public': a.expected_public_sha,
                                        'schema': 'retained 047-049'})
        except Exception:
            raise market.CommandUncertain('Rollback unverified; deployment lock retained') from None

    def verify_edge(self):
        phase_gate('verify-edge', self.evidence(), flag_environment(self.runtime_environment()))
        require(self.running_revision() == self.sha, 'Running API is not this release')
        require(self.args.parity_report, '--parity-report is required')
        path = self.args.parity_report
        require(path.is_file() and not path.is_symlink() and path.stat().st_size < 5_000_000, 'Unreadable parity report')
        raw = path.read_bytes()
        snapshot = self.edge_snapshot()
        edge = check_edge_state(snapshot, self.branch_id)
        check_menu_events(int(snapshot['unacked']))
        parity = check_parity(json.loads(raw), self.branch_id, edge, snapshot['head'])
        check_access_coverage(self.coverage())
        record = {'edge': edge, 'head_version': snapshot['head'], 'parity_sha256': digest(raw), 'parity': parity}
        self.complete('verify-edge', record)
        print(json.dumps({'phase': 'verify-edge', 'validated': True, **record}, sort_keys=True), flush=True)

    def phase_preflight(self, phase):
        if phase == 'access-roles':
            check_access_coverage(self.coverage())
        elif phase == 'edge-publication':
            check_edge_publication_acl(self.acl())
            snapshot = self.edge_snapshot()
            edge = check_edge_state(snapshot, self.branch_id)
            require(edge == self.evidence()['verify-edge']['edge'], 'Edge menu changed since verify-edge')
            require(snapshot['head'] == self.evidence()['verify-edge']['head_version'], 'Head catalog changed since verify-edge')
            check_menu_events(int(snapshot['unacked']))
        elif phase == 'remote-stops':
            beat = self.heartbeat()
            require(beat and beat['device_matches'] and beat['protocol4'], 'Edge does not send protocol-4 stop states')
            require(0 <= beat['age_seconds'] <= HEARTBEAT_MAX_AGE, 'Cashier heartbeat is stale')

    def enable(self, phase):
        evidence = self.evidence()
        env = self.runtime_environment()
        flags = flag_environment(env)
        require(self.running_revision() == self.sha, 'Running API is not this release')
        if flags.get(phase) == 'true' and phase in evidence:
            if phase == 'edge-publication':
                check_edge_publication_acl(self.acl(), writable=True)
            print(json.dumps({'phase': phase, 'already_complete': True}), flush=True)
            return
        phase_gate(phase, evidence, flags)
        self.phase_preflight(phase)
        if not self.args.apply:
            return self.plan(phase, {'flag': FLAG_KEYS[phase], 'grants': phase in OWNER_FLAGS})
        with self.deployment_lock():
            record = self.switch_flag(phase, True, env)
        self.complete(phase, record)
        print(json.dumps({'phase': phase, 'applied': True, 'flag': FLAG_KEYS[phase], 'value': 'true'}), flush=True)

    def disable(self):
        flag = self.args.flag
        require(flag in FLAG_PHASES, '--flag must name one unified-menu flag phase')
        require('deploy' in self.evidence(), 'Deploy evidence missing')
        require(self.running_revision() == self.sha, 'Running API is not this release')
        env = self.runtime_environment()
        if flag_environment(env).get(flag) == 'false':
            print(json.dumps({'phase': 'disable', 'flag': FLAG_KEYS[flag], 'already_off': True}), flush=True)
            return
        if not self.args.apply:
            return self.plan('disable', {'flag': FLAG_KEYS[flag]})
        with self.deployment_lock():
            record = self.switch_flag(flag, False, env)
        self.save('disable-' + flag + '-' + uuid.uuid4().hex[:8] + '.json', record)
        print(json.dumps({'phase': 'disable', 'applied': True, 'flag': FLAG_KEYS[flag], 'value': 'false'}), flush=True)

    def switch_flag(self, phase, enabled, env):
        """CAS on the deployed compose; enabling grants before env, disabling env before revoke."""
        path = self.compose_path(self.sha)
        current = self.read_text(path)
        candidate = compose_flag(current, phase, enabled, self.branch_id)
        acl = self.acl()
        changes = {FLAG_KEYS[phase]: 'true' if enabled else 'false'}
        if phase == 'edge-publication' and enabled:
            changes[BRANCH_KEY] = self.branch_id
        previous = path + '.' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '.previous'
        self.remote('test ! -e ' + quote(previous) + ' && cp -p ' + quote(path) + ' ' + quote(previous))
        owner = None
        try:
            if enabled and phase in OWNER_FLAGS:
                owner = self.owner('flag', phase, 'true')
            if enabled and phase == 'edge-publication':
                # Prove the additive five grants before exposing the publication path.
                added, removed, present, absent = flag_acl(phase, True)
                current_acl = self.acl()
                verify_acl_change(acl, current_acl, added=added, removed=removed, present=present, absent=absent)
                check_edge_publication_acl(current_acl, writable=True)
            require(digest(self.read_text(path).encode()) == digest(current.encode()), 'Compose changed concurrently')
            self.write_remote(path, candidate)
            self.remote(market.api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            self.ready()
            verify_environment_delta(env, self.runtime_environment(), changes)
            if not enabled and phase in OWNER_FLAGS:
                owner = self.owner('flag', phase, 'false')
            added, removed, present, absent = flag_acl(phase, enabled)
            verify_acl_change(acl, self.acl(), added=added, removed=removed, present=present, absent=absent)
        except market.CommandUncertain:
            raise
        except Exception:
            # Restore the previous compose bytes and API; grants follow the restored flag.
            try:
                self.write_remote(path, current)
                self.remote(market.api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
                self.ready()
                if phase in OWNER_FLAGS and (enabled or owner is not None):
                    self.owner('flag', phase, 'false' if enabled else 'true')
            except Exception:
                raise market.CommandUncertain('Flag rollback unverified; deployment lock retained') from None
            raise
        return {'flag': FLAG_KEYS[phase], 'enabled': enabled, 'compose_sha256': digest(candidate.encode()),
                'previous_compose': previous, 'owner': owner}


def parse(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('phase', choices=[*PHASES, 'disable'])
    p.add_argument('sha')
    p.add_argument('--branch', required=True, help='pushed git branch of the SHA')
    p.add_argument('--branch-id', required=True, help='catalog branch UUID served by the cashier edge')
    p.add_argument('--apply', action='store_true', help='perform the phase; without it only preflight runs')
    p.add_argument('--flag', choices=FLAG_PHASES, help='disable: the flag phase to turn off')
    p.add_argument('--expected-api-sha')
    p.add_argument('--expected-public-sha')
    p.add_argument('--expected-compose-sha256')
    p.add_argument('--expected-gateway-sha256')
    p.add_argument('--parity-report', type=Path)
    p.add_argument('--ssh-key', type=Path, default=Path.home() / '.ssh/pickchick_staging_ed25519')
    p.add_argument('--backup-identity', type=Path, default=REPO / '.local/vps/backup-identity.agekey')
    proof = p.add_mutually_exclusive_group()
    proof.add_argument('--ci-run')
    proof.add_argument('--ci-proof', type=Path)
    args = p.parse_args(argv)
    if args.phase == 'deploy':
        for name in ['expected_api_sha', 'expected_public_sha', 'expected_compose_sha256', 'expected_gateway_sha256']:
            require(getattr(args, name), '--' + name.replace('_', '-') + ' is required for deploy')
        check_live_baseline(args)
        require(args.ci_run or args.ci_proof, 'CI proof is required for deploy')
    return args


def main(argv=None, factory=Release):
    os.umask(0o077)
    args = parse(argv)
    require(re.fullmatch('[a-f0-9]{40}', args.sha), 'Expected a full SHA')
    release = factory(args)
    try:
        release.run()
    except Exception as error:
        release.record_error(error)
        raise


if __name__ == '__main__':
    try:
        main()
    except GuardFailure as error:
        print('Release stopped: ' + str(error), flush=True)
        raise SystemExit(1) from None
    except Exception:
        # No exception repr/cause or command output: those can contain connection credentials.
        print('Release stopped. Review private evidence and actual state before retrying.', flush=True)
        raise SystemExit(1) from None
