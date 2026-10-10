#!/usr/bin/env python3
"""Guarded cloud kitchen channel release (ADR-0014) over the installed 8468/schema052 baseline.

Every action is read-only without --apply. Read docs/operations/cloud-kitchen-release.md first.

prepare   immutable API image/compose (+ portal release when the candidate changes the portal).
apply     encrypted backup + isolated restore, owner transaction 053-056 + reviewed grants,
          API (+ portal) switch with both new flags OFF and every branch in mode `edge`.
stations  trusted cloud stations/routing: full JSON, or the minimal known production stations
          with every head-catalog product routed to one prep station.
enable    network + flags ON, the keyless `cloudKitchen` block {enabled, apiOrigin, branchId} in
          the protected portal config (exact new SHA pinned), portal with the cloud overlay,
          branch mode edge -> cloud. Screens are NOT created here.
screen-code  one screen (create, or new code for --screen); the one-time pairing code is printed
          only to the owner's interactive terminal, never to evidence or logs.
mode-edge audited return of the branch to `edge` (fast fallback; kitchen keeps in-flight orders).
disable   mode edge, no active cloud orders, screens revoked, portal config/overlay restored,
          flags OFF. rollback: API (+ portal) back to the baseline; additive schema retained.

Unlike device-access releases, edgeConnected is NOT required: the cashier may be offline and
the channel exists to work without it. Bank, QR worker, gateway and public pointer are preserved.
"""
import argparse
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

spec = importlib.util.spec_from_file_location('cloud_kitchen_live_base', Path(__file__).with_name('release-live-menu.py'))
lm = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = lm
spec.loader.exec_module(lm)
base, market = lm.base, lm.market
require, digest, quote, REMOTE = lm.require, lm.digest, lm.quote, lm.REMOTE

BASELINE = '8468e3aed72c5355cf8b8d998df1de14ca55b03f'
BASELINE_NUMBERS = list(range(1, 41)) + list(range(42, 53))
MIGRATIONS = ('053_cloud_channel_numbers.sql', '054_cloud_kitchen_fulfillment.sql',
              '055_cloud_channel_stops.sql', '056_cloud_kitchen_screens.sql')
BRANCH = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'  # ТЦ Abay Plaza (KIOSK_CHECKOUT_BRANCH_ID)
FLAGS_OFF = {'CLOUD_KITCHEN_API_ENABLED': '0', 'BACKOFFICE_CLOUD_KITCHEN_ENABLED': 'false'}
FLAGS_ON = {'CLOUD_KITCHEN_API_ENABLED': '1', 'BACKOFFICE_CLOUD_KITCHEN_ENABLED': 'true'}
NETWORK, API_ALIAS = 'pickchick-kitchen_cloud', 'pickchick-api'
API_ORIGIN = 'http://' + API_ALIAS + ':3100'
# Read-only production facts (cashier station ids observed in cloud_fulfillment_projection/observed_tasks).
KNOWN_ASSEMBLY_STATION = '2cbc8ef3-359b-4cf0-bda8-28b82b727c93'
KNOWN_PREP_STATION = '9ba8dc69-260c-482b-bed9-cab791b64595'
ROLES = ('prep', 'assembly', 'display')
CODE_RE = '[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{6}'
PORTAL = 'pickchick-kitchen-portal'
PORTAL_STATE = REMOTE + '/kitchen-portal'
PORTAL_CONFIG = PORTAL_STATE + '/private/config.json'
PORTAL_PRE_CLOUD = PORTAL_STATE + '/private/config.pre-cloud.json'
PORTAL_SOURCES = ('infra/kitchen-portal', 'apps/kitchen')
OWNER = 'infra/staging/cloud-kitchen-release-owner.mjs'
SCREEN_OWNER = 'infra/staging/cloud-kitchen-screen-owner.mjs'
REQUIRED_FILES = (OWNER, SCREEN_OWNER, 'infra/staging/channel-number-grants.mjs', 'infra/staging/cloud-kitchen-grants.mjs',
                  'infra/staging/cloud-channel-stop-grants.mjs', 'infra/staging/cloud-kitchen-screen-grants.mjs')
UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
lm.BASELINE = BASELINE


def _tables(names, privileges):
    return {(t, None, p) for t in names.split(',') for p in privileges}


def _columns(table, names):
    return {(table, c, 'UPDATE') for c in names.split(',')}


# Mirror of EXPECTED_PRIVILEGES in cloud-kitchen-release-owner.mjs (union of the four grant files).
PRIVILEGES = frozenset(
    _tables('channel_number_ranges,channel_number_shifts,channel_number_counters,channel_number_holds', ['SELECT'])
    | _tables('branch_channel_modes,branch_channel_mode_changes,cloud_kitchen_stations,cloud_kitchen_routing,'
              'cloud_kitchen_config', ['SELECT'])
    | _tables('cloud_kitchen_admissions,cloud_kitchen_commands', ['SELECT', 'INSERT'])
    | _tables('cloud_kitchen_orders,cloud_kitchen_tasks,cloud_kitchen_outbox,cloud_kitchen_station_presence',
              ['SELECT', 'INSERT', 'UPDATE'])
    | _tables('cloud_channel_stops,cloud_channel_stop_events,cloud_stale_stop_overrides', ['SELECT', 'INSERT'])
    | _columns('cloud_channel_stops', 'stopped,duration,reason,version,actor_id,actor_label')
    | _tables('cloud_kitchen_screens,cloud_kitchen_pairing_codes,cloud_kitchen_screen_events', ['SELECT', 'INSERT'])
    | _columns('cloud_kitchen_screens', 'generation,key_hash,key_issued_at,revoked_at,revoked_by,revoked_reason,last_seen_at')
    | _columns('cloud_kitchen_pairing_codes', 'failed_attempts,used_at,burned_at')
    | _tables('cloud_channel_orders', ['SELECT', 'INSERT']))
FUNCTIONS = ('channel_number_allocate(uuid, text, uuid)', 'channel_number_open_shift(uuid, text)',
             'channel_number_release(uuid)', 'cloud_kitchen_set_mode(uuid, text, text, text)')


# ---------- pure transformations (unit-tested) ----------
def _api_section(text):
    require(text.count('\n  api:\n') == 1, 'API boundary ambiguous')
    start = text.index('\n  api:\n') + 1
    match = re.search(r'^  [A-Za-z][A-Za-z0-9_-]*:', text[start + len('  api:\n'):], re.M)
    end = start + len('  api:\n') + match.start() if match else len(text)
    return start, end


def flag_lines(flags):
    return ''.join(f'      {k}: "{v}"\n' for k, v in flags.items())


def compose_candidate(text, expected):
    """Installed compose plus the two new API flags OFF; nothing else."""
    require(digest(text.encode()) == expected, 'Installed compose differs from reviewed hash')
    require(not any(k in text for k in FLAGS_OFF) and NETWORK not in text, 'Cloud kitchen already configured')
    start, end = _api_section(text)
    section, anchor = text[start:end], '      APP_ENV: staging\n'
    require(section.count(anchor) == 1, 'API environment anchor differs')
    result = text[:start] + section.replace(anchor, flag_lines(FLAGS_OFF) + anchor) + text[end:]
    require(result.replace(flag_lines(FLAGS_OFF), '', 1) == text, 'Unrelated compose delta')
    return result


API_NETWORKS = '    networks: [private, ingress]\n'
API_NETWORKS_CLOUD = ('    networks:\n      private: {}\n      ingress: {}\n'
                      f'      kitchen_cloud:\n        aliases: [{API_ALIAS}]\n')
TOP_NETWORK = f'  kitchen_cloud:\n    name: {NETWORK}\n    external: true\n'


def compose_enabled(candidate):
    """Flags ON and the API on the internal portal network (alias pickchick-api); exact inverse known."""
    require(candidate.count(flag_lines(FLAGS_OFF)) == 1 and NETWORK not in candidate, 'Compose is not the applied candidate')
    start, end = _api_section(candidate)
    section = candidate[start:end]
    require(section.count(API_NETWORKS) == 1, 'API networks differ from the reviewed baseline')
    section = section.replace(flag_lines(FLAGS_OFF), flag_lines(FLAGS_ON)).replace(API_NETWORKS, API_NETWORKS_CLOUD)
    result = candidate[:start] + section + candidate[end:]
    require(result.count('\nnetworks:\n') == 1, 'Top-level networks ambiguous')
    result = result.replace('\nnetworks:\n', '\nnetworks:\n' + TOP_NETWORK, 1)
    restored = result.replace(TOP_NETWORK, '', 1).replace(API_NETWORKS_CLOUD, API_NETWORKS, 1)
    require(restored.replace(flag_lines(FLAGS_ON), flag_lines(FLAGS_OFF), 1) == candidate, 'Unrelated compose delta')
    return result


def stable_health(health):
    """Portal health without link-state fields: edgeConnected is deliberately NOT a gate here."""
    require(isinstance(health, dict) and re.fullmatch('[a-f0-9]{40}', str(health.get('sourceSha'))), 'Portal health invalid')
    return {k: v for k, v in health.items() if k not in ('edgeConnected', 'cloudConnected')}


IMPORT_RE = re.compile(r'''(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}/[^'"]+)['"]''')


def unresolved_imports(files):
    """Relative imports of shipped .mjs that would not resolve inside the portal package."""
    missing = []
    for name, text in files.items():
        if not name.endswith('.mjs') or name.startswith('apps/kitchen/dist/'):
            continue
        for target in IMPORT_RE.findall(text):
            resolved = os.path.normpath(os.path.join(os.path.dirname(name), target))
            if resolved not in files:
                missing.append(name + ' -> ' + target)
    return missing


def stations_ready(status):
    require(status.get('routingVersion') and status.get('prepStations') and status.get('assemblyStations'),
            'Cloud stations and routing must be provisioned first (stations action)')
    return status


def kitchen_setup_form(setup):
    """'full' ({branchId, stations, routing}) or 'route_all' (the two known production stations,
    names from the input, every head-catalog product to the named prep station)."""
    require(isinstance(setup, dict) and setup.get('branchId') == BRANCH, 'Setup branch differs')
    keys = sorted(setup)
    if keys == ['branchId', 'routing', 'stations']:
        require(isinstance(setup['stations'], list) and setup['stations'] and isinstance(setup['routing'], dict),
                'Full setup needs stations and routing')
        return 'full'
    require(keys == ['branchId', 'routeAllProductsTo', 'stations'],
            'Setup must be {branchId,stations,routing} or {branchId,stations,routeAllProductsTo}')
    stations = setup['stations']
    require(isinstance(stations, list) and all(isinstance(x, dict) and sorted(x) == ['id', 'kind', 'name'] for x in stations),
            'Stations must be {id, kind, name}')
    require({x['id']: x['kind'] for x in stations} == {KNOWN_ASSEMBLY_STATION: 'assembly', KNOWN_PREP_STATION: 'prep'}
            and len(stations) == 2, 'Minimal setup uses exactly the known production assembly and prep station ids')
    require(all(isinstance(x['name'], str) and x['name'].strip() and len(x['name']) <= 100 for x in stations),
            'Station names come from the input and must be non-empty')
    require(setup['routeAllProductsTo'] == KNOWN_PREP_STATION, 'routeAllProductsTo must be the known prep station')
    return 'route_all'


def screen_request(status, role, name=None):
    """Stations and name of a new screen: prep/assembly screens see all stations of their kind and
    are named after them (names from the stations input); the display needs --screen-name or 'Табло'."""
    require(role in ROLES, 'Role must be prep, assembly or display')
    stations_ready(status)
    stations = [] if role == 'display' else status[role + 'Stations']
    names = status.get('stationNames') or {}
    default = 'Табло' if role == 'display' else ', '.join(names.get(i) or '' for i in stations)
    name = (name if name is not None else default).strip()
    require(0 < len(name) <= 100, 'Screen name required (--screen-name)')
    return stations, name


# Runs on the VPS: compute (plan) or write (apply) the keyless cloudKitchen block of the portal
# config. The original bytes are kept in config.pre-cloud.json (0600); stdout carries hashes only.
ENABLE_PORTAL = r"""import hashlib,json,os,sys
mode,config,pre,expected,branch,origin,want=sys.argv[1:]
sha=lambda b:hashlib.sha256(b).hexdigest()
raw=open(config,'rb').read()
assert sha(raw)==expected and not os.path.lexists(pre)
data=json.loads(raw);assert 'cloudKitchen' not in data
data['cloudKitchen']={'enabled':True,'apiOrigin':origin,'branchId':branch}
nxt=(json.dumps(data,ensure_ascii=False,indent=2)+'\n').encode()
if mode=='apply':
 assert sha(nxt)==want
 fd=os.open(pre,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as o:o.write(raw)
 tmp=config+'.cloud-next';fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as o:o.write(nxt)
 os.replace(tmp,config)
 assert sha(open(config,'rb').read())==want
else:
 assert mode=='plan'
print(json.dumps({'config_sha256':sha(nxt),'original_sha256':expected}))
"""

# Runs on the VPS: put the pre-cloud config back (exact bytes, verified hash).
RESTORE_PORTAL = r"""import hashlib,json,os,sys
config,pre,expected=sys.argv[1:]
sha=lambda p:hashlib.sha256(open(p,'rb').read()).hexdigest()
assert sha(pre)==expected
if sha(config)!=expected:
 tmp=config+'.restore-next';fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as o:o.write(open(pre,'rb').read())
 os.replace(tmp,config)
assert sha(config)==expected
os.replace(pre,pre+'.restored-'+os.urandom(4).hex())
print(json.dumps({'config_sha256':expected}))
"""

PORTAL_FACTS = r'''import hashlib,json,os,sys
config=sys.argv[1]
data=json.load(open(config))
print(json.dumps({'config_sha256':hashlib.sha256(open(config,'rb').read()).hexdigest(),
 'cloud':'cloudKitchen' in data,'pre_cloud':os.path.lexists(sys.argv[2]),
 'uid':os.stat(config).st_uid,'mode':oct(os.stat(config).st_mode&0o777)}))
'''


def portal_compose(release, cloud=False):
    files = f'-f {release}/infra/kitchen-portal/compose.yaml' + (f' -f {release}/infra/kitchen-portal/compose.cloud.yaml' if cloud else '')
    return f'docker compose --env-file {release}/portal.env {files}'


class Release(lm.Release):
    def __init__(self, args):
        require(args.expected_api_sha == BASELINE, 'Exact installed 8468 API baseline required')
        require(args.branch_id == BRANCH, 'Abay Plaza branch id required')
        for name in ('expected_public_sha', 'expected_portal_sha'):
            require(re.fullmatch('[a-f0-9]{40}', getattr(args, name) or ''), 'Reviewed SHA required: ' + name)
        for name in ('expected_compose_sha256', 'expected_gateway_sha256', 'expected_portal_config_sha256'):
            require(re.fullmatch('[a-f0-9]{64}', getattr(args, name) or ''), 'Reviewed hash required: ' + name)
        for name in ('expected_api_image', 'expected_qr_worker_image'):
            require(re.fullmatch('sha256:[a-f0-9]{64}', getattr(args, name) or ''), 'Reviewed image required: ' + name)
        if args.expected_enabled_config_sha256 is not None:
            require(re.fullmatch('[a-f0-9]{64}', args.expected_enabled_config_sha256), 'Reviewed hash required: expected_enabled_config_sha256')
        if args.action == 'screen-code':
            require(args.role in ROLES, '--role prep|assembly|display required')
        if args.action in ('enable', 'disable', 'mode-edge', 'screen-code') and args.apply:
            require(re.fullmatch('[A-Za-z0-9._-]{1,60}', args.operator or '') and len((args.reason or '').strip()) >= 3,
                    'Operator and reason required')
        profile = market.ReleaseProfile('cloud-kitchen-schema056', BASELINE, args.expected_public_sha, 51, MIGRATIONS,
            base.workflow_jobs((market.REPO/'.github/workflows/ci.yml').read_text()), frozenset(),
            'cloud-kitchen-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)
        self._portal_changes = None

    # ---------- source ----------
    def baseline_migrations(self):
        names = sorted(Path(p).name for p in self.git('ls-tree', '-r', '--name-only', BASELINE, '--',
                                                     'db/cloud/migrations/').splitlines() if p.endswith('.sql'))
        require([int(n[:3]) for n in names] == BASELINE_NUMBERS, 'Exact schema052 (incl. dormant 051) required')
        return names

    def source_checks(self):
        market.Release.source_checks(self)  # exact SHA/branch, clean, migration set = 052 + 053-056, 001-052 unchanged
        self.execute(['git', 'merge-base', '--is-ancestor', BASELINE, self.sha])
        missing = [name for name in REQUIRED_FILES if not (market.REPO/name).is_file()]
        if self.args.source_checkout:
            # Read-only dry run of a partial candidate: report, never apply (parse forbids --apply).
            self.blockers = ['Candidate lacks ' + name for name in missing]
        else:
            require(not missing, 'Candidate lacks ' + ', '.join(missing))

    def portal_changes(self):
        if self._portal_changes is None:
            self._portal_changes = bool(self.git('diff', '--name-only', self.args.expected_portal_sha, self.sha, '--', *PORTAL_SOURCES))
        return self._portal_changes

    def expected_ledger(self, migrated=False):
        names = self.baseline_migrations() + (list(MIGRATIONS) if migrated else [])
        return [{'version': n, 'scope': 'cloud', 'checksum': digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in names]

    # ---------- live reads ----------
    def owner(self, *argv, sha=None, input=None, timeout=240):
        out = self.remote(market.api_compose(sha or self.sha) + ' run --rm --no-deps -T --entrypoint node provision ' +
                          OWNER + ' ' + ' '.join(map(quote, argv)), input=input, timeout=timeout)
        return json.loads(out.splitlines()[-1])

    def status(self):
        result = self.owner('status', '--branch', BRANCH)
        require(result.get('branch') == BRANCH, 'Owner status differs')
        return result

    def function_acl(self):
        return json.loads(self.psql(market.DB, "SELECT coalesce(json_agg(f ORDER BY f),'[]') FROM (SELECT p.proname||'('||"
            "oidvectortypes(p.proargtypes)||')' AS f FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN "
            "LATERAL aclexplode(p.proacl) x JOIN pg_roles r ON r.oid=x.grantee WHERE n.nspname='public' AND "
            "r.rolname='pickchick_app' AND x.privilege_type='EXECUTE') s"))

    def neighbors(self, without_portal=False):
        result = lm.Release.neighbors(self)  # all containers but API/gateway; banks/QR worker must run
        row = result['containers'].get('pickchick-kiosk-kaspi-qr-worker', '').split()
        require(len(row) == 5 and row[1] == self.args.expected_qr_worker_image and row[3] == 'running', 'QR worker differs')
        if without_portal:
            result['containers'].pop(PORTAL, None)
        return result

    def networks(self, container):
        raw = json.loads(self.remote('docker inspect --format ' + quote('{{json .NetworkSettings.Networks}}') + ' ' + container))
        return {name: sorted(a for a in (value.get('Aliases') or []) if not re.fullmatch('[a-f0-9]{12}', a)) for name, value in raw.items()}

    def network_present(self):
        names = self.remote("docker network ls --format '{{.Name}}'").splitlines()
        return NETWORK in names

    def portal(self):
        facts = json.loads(self.remote('python3 -c ' + quote(PORTAL_FACTS) + ' ' + quote(PORTAL_CONFIG) + ' ' + quote(PORTAL_PRE_CLOUD)))
        require(facts['uid'] == 1000 and facts['mode'] == '0o600', 'Portal config must stay 0600 for the operator')
        health = self.http_json('/kitchen-live/health')
        return {'health': stable_health(health), 'cloud_connected': health.get('cloudConnected'),
                'pointer': self.remote('readlink -f ' + PORTAL_STATE + '/current'), 'facts': facts,
                'networks': sorted(self.networks(PORTAL))}

    def portal_release(self, sha):
        return PORTAL_STATE + '/releases/' + sha

    # ---------- baseline ----------
    def baseline(self):
        a = self.args
        require(self.running_revision() == BASELINE and self.api_image() == a.expected_api_image, 'Live API baseline differs')
        require(self.remote('readlink -f ' + REMOTE + '/current') == REMOTE + '/releases/' + BASELINE, 'API pointer differs')
        require(self.remote('docker image inspect --format ' + quote('{{.Id}}') + ' pickchick-api:' + BASELINE) == a.expected_api_image, 'Rollback image differs')
        require(self.ledger() == self.expected_ledger(), 'Exact schema052 ledger required')
        self.runtime_acl(); self.verify_public()
        env = self.runtime_environment()
        require(all(env.get(k) is None for k in FLAGS_OFF), 'Cloud kitchen flags already configured')
        require(env.get('BACKOFFICE_ENABLED') == digest(b'true'), 'Scoped backoffice required')
        portal = self.portal()
        require(portal['health']['sourceSha'] == a.expected_portal_sha and
                portal['pointer'] == self.portal_release(a.expected_portal_sha), 'Portal baseline differs')
        require(portal['facts']['config_sha256'] == a.expected_portal_config_sha256 and not portal['facts']['cloud']
                and not portal['facts']['pre_cloud'], 'Portal config differs or already has cloudKitchen')
        require(NETWORK not in self.networks(market.API_CONTAINER) and NETWORK not in portal['networks'], 'Cloud network already attached')
        return {'candidate': compose_candidate(self.read_text(self.compose_path(BASELINE)), a.expected_compose_sha256),
                'environment': env, 'rollback': self.rollback_artifacts(), 'neighbors': self.neighbors(),
                'acl': self.acl(), 'functions': self.function_acl(), 'portal': portal,
                'capabilities': self.http_json('/v1/capabilities', public=False)}

    def plan(self, phase, detail):
        base.Release.plan(self, phase, {'migrations': list(MIGRATIONS), 'flags_after_apply': FLAGS_OFF,
            'portal_update': self.portal_changes(), 'branch': BRANCH, 'edge_connected_required': False,
            'blockers': getattr(self, 'blockers', []), **detail})

    def prepared(self):
        record = lm.Release.prepared(self)
        require(record.get('profile') == 'cloud-kitchen-schema056', 'Foreign preparation')
        return record

    # ---------- prepare ----------
    def portal_package(self):
        """Tracked portal sources + freshly built kitchen dist of the exact candidate checkout."""
        self.execute(['corepack', 'pnpm', '--filter', '@pickchick/kitchen', 'build'], timeout=600)
        require(not self.git('status', '--porcelain', '--untracked-files=all'), 'Portal build dirtied the checkout')
        names = [p for p in self.git('ls-files', '--', 'infra/kitchen-portal', 'apps/kitchen/server.mjs',
                                     'apps/kitchen/terminal-cookie.mjs', 'infra/roadmap/remote-deploy.py').splitlines()]
        dist = market.REPO/'apps/kitchen/dist'
        names += sorted(str(p.relative_to(market.REPO)) for p in dist.rglob('*') if p.is_file() and not p.is_symlink())
        files = {n: (market.REPO/n).read_bytes() for n in names}
        texts = {n: b.decode('utf8', 'replace') for n, b in files.items()}
        require(not unresolved_imports(texts), 'Portal package has unresolved relative imports')
        for need in ('infra/kitchen-portal/server.mjs', 'infra/kitchen-portal/compose.yaml', 'apps/kitchen/dist/app.js'):
            require(need in files, 'Portal package incomplete: ' + need)
        return files

    def prepare(self):
        before = self.baseline()
        if not self.args.apply:
            # Read-only: the exact portal config SHA `enable` will write (keyless cloudKitchen block).
            return self.plan('prepare', {'api_build': True, 'migrations_applied_by': 'apply',
                                         'enabled_portal_config_sha256': self.enabled_portal_config()})
        require(not (self.private/'prepared.json').exists(), 'Preparation already exists; no replay')
        target = REMOTE + '/releases/' + self.sha
        archive = self.execute(['git', 'archive', '--format=tar', self.sha, *market.ARCHIVE_PATHS])
        self.remote(f'test ! -e {target} && mkdir {target} && tar -xf - -C {target}', input=archive, timeout=180)
        self.remote('python3 -c ' + quote(market.release_env_script(self.profile)) + ' ' + ' '.join(map(quote,
            [REMOTE+'/releases/'+BASELINE+'/release.env', target+'/release.env', self.sha, BASELINE])))
        self.write_remote(self.compose_path(self.sha), before['candidate'])
        self.remote('! docker image inspect pickchick-api:' + self.sha + ' >/dev/null 2>&1')
        image = self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} '
                            f'-t pickchick-api:{self.sha} .', timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'Invalid immutable image')
        self.remote(market.api_compose(self.sha) + ' config --quiet')
        self.remote(market.api_compose(self.sha) + ' run --rm --no-deps -T --entrypoint node provision ' + OWNER + ' inspect', timeout=240)
        portal = None
        if self.portal_changes():
            import io, tarfile
            files = self.portal_package()
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w') as tar:
                for name, data in sorted(files.items()):
                    info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o644
                    tar.addfile(info, io.BytesIO(data))
            release = self.portal_release(self.sha)
            self.remote(f'test ! -e {release} && mkdir -p {release} && tar -xf - -C {release} --no-same-owner', input=buffer.getvalue(), timeout=180)
            self.write_remote(release + '/portal.env', f'KITCHEN_RELEASE={release}\nKITCHEN_STATE={PORTAL_STATE}\nKITCHEN_SOURCE_SHA={self.sha}\n')
            self.remote(portal_compose(release) + ' config --quiet')
            if 'infra/kitchen-portal/compose.cloud.yaml' in files:
                self.remote(portal_compose(release, True) + ' config --quiet --no-interpolate')
            portal = {'files': {n: digest(b) for n, b in files.items()}, 'release': release}
        artifacts = self.artifacts(portal)
        require(artifacts['image'] == image and self.baseline() == before, 'Preparation drift')
        self.save('prepared.json', {'profile': 'cloud-kitchen-schema056', 'sha': self.sha, 'baseline': BASELINE,
                                    'before': before, 'artifacts': artifacts, 'portal': portal, 'archive_sha256': digest(archive)})

    def artifacts(self, portal=None):
        result = lm.Release.artifacts(self)
        if portal:
            paths = [portal['release'] + '/' + n for n in sorted(portal['files'])] + [portal['release'] + '/portal.env']
            hashes = self.file_hashes(paths)
            require(all(hashes[portal['release'] + '/' + n] == v for n, v in portal['files'].items()), 'Portal package changed')
            result['portal'] = digest(hashes)
        return result

    # ---------- verification ----------
    def verify_acl(self, proof):
        before = {base.acl_key(r) for r in proof['before']['acl']}
        after = self.acl()
        require({base.acl_key(r) for r in after} == before | PRIVILEGES and all(not r['grantable'] for r in after), 'Unexpected ACL delta')
        require(self.function_acl() == sorted(set(proof['before']['functions']) | set(FUNCTIONS)), 'Unexpected function ACL delta')

    def verify_portal(self, proof, cloud):
        portal = self.portal()
        for _ in range(12):  # the portal reports cloudConnected after its first upstream probe
            if not cloud or portal['cloud_connected'] is True:
                break
            time.sleep(5); portal = self.portal()
        sha = self.sha if proof['portal'] else self.args.expected_portal_sha
        require(portal['health']['sourceSha'] == sha and portal['pointer'] == self.portal_release(sha), 'Portal release differs')
        require(portal['facts']['cloud'] == cloud and (NETWORK in portal['networks']) == cloud, 'Portal cloud state differs')
        if cloud:
            require(portal['cloud_connected'] is True, 'Portal cannot reach the cloud kitchen API')
            require(portal['facts']['config_sha256'] == self.expected_enabled_config() and portal['facts']['pre_cloud'],
                    'Portal cloud config differs from the reviewed enabled SHA')
        else:
            require(portal['facts']['config_sha256'] == self.args.expected_portal_config_sha256, 'Portal config differs')
        return portal

    def current(self, proof, enabled=False):
        require(self.running_revision() == self.sha and self.api_image() == proof['artifacts']['image'], 'Installed API differs')
        require(self.remote('readlink -f ' + REMOTE + '/current') == REMOTE + '/releases/' + self.sha, 'API pointer differs')
        require(self.ledger() == self.expected_ledger(True), 'Migration ledger differs')
        self.verify_acl(proof)
        portal_moves = self.portal_moved(proof) or enabled
        require(self.neighbors(portal_moves) == self.strip(proof['before']['neighbors'], portal_moves), 'Neighbor container changed')
        require(self.rollback_artifacts() == proof['before']['rollback'], 'Rollback artifacts changed')
        base.verify_environment_delta(proof['before']['environment'], self.runtime_environment(),
                                      FLAGS_ON if enabled else FLAGS_OFF, release_sha_may_change=True)
        api_networks = self.networks(market.API_CONTAINER)
        require((NETWORK in api_networks) == enabled and (not enabled or API_ALIAS in api_networks[NETWORK]), 'API network state differs')
        self.runtime_acl(); self.verify_public()
        require(self.http_json('/v1/capabilities', public=False) == proof['before']['capabilities'], 'Capabilities changed')
        return self.verify_portal(proof, enabled)

    def portal_moved(self, proof):
        return bool(proof['portal']) or (self.private/'enable-steps.json').exists()

    @staticmethod
    def strip(neighbors, without_portal):
        result = json.loads(json.dumps(neighbors))
        if without_portal:
            result['containers'].pop(PORTAL, None)
        return result

    # ---------- apply / rollback ----------
    def backup_restore(self):
        key = self.args.backup_identity
        require(key and key.is_file() and not any(p.is_symlink() for p in [key, *key.parents]) and key.stat().st_mode & 0o077 == 0, 'Protected backup identity required')
        recipient = self.execute(['age-keygen', '-y', str(key)]).decode().strip()
        require(re.fullmatch('age1[0-9a-z]{58}', recipient), 'Native backup recipient required')
        suffix = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
        backup = f'{REMOTE}/backups/cloud-kitchen-{suffix}.dump.age'
        script = f"""set -euo pipefail
umask 077
exec 9>{REMOTE}/backups/.lock
flock -n 9
test ! -e {backup}
trap 'rm -f {backup}.tmp' EXIT
docker exec {market.DB_CONTAINER} pg_dump -U postgres -d {market.DB} --format=custom --no-owner --no-acl | age -r {quote(recipient)} -o {backup}.tmp
test -s {backup}.tmp
mv {backup}.tmp {backup}
sha256sum {backup} > {backup}.sha256
"""
        ledger, tables = self.ledger(), self.table_names(market.DB)
        self.remote('bash -o pipefail -c ' + quote(script), timeout=180)
        self.remote('sha256sum --check ' + backup + '.sha256')
        database = 'pickchick_restore_cloud_kitchen_' + uuid.uuid4().hex[:12]
        created = False
        try:
            self.remote(f'docker exec {market.DB_CONTAINER} createdb -U postgres {database}'); created = True
            pipeline = f'age --decrypt --identity /dev/stdin {backup} | docker exec -i {market.DB_CONTAINER} pg_restore -U postgres -d {database} --exit-on-error --no-owner --no-acl'
            self.remote('bash -o pipefail -c ' + quote(pipeline), input=key.read_bytes(), timeout=180)
            require(self.ledger(database) == ledger and self.table_names(database) == tables, 'Isolated restored backup differs')
        finally:
            if created:
                self.remote(f'docker exec {market.DB_CONTAINER} dropdb -U postgres {database}')
        return {'path': backup, 'sha256': self.remote('sha256sum ' + backup).split()[0], 'restore': 'passed', 'recipient': recipient}

    def apply(self):
        proof = self.prepared()
        require(self.baseline() == proof['before'] and self.artifacts(proof['portal']) == proof['artifacts'], 'Baseline/artifacts drift')
        if not self.args.apply:
            return self.plan('apply', {'backup_restore_required': True, 'flags': FLAGS_OFF})
        require(not (self.private/'apply-attempt.json').exists(), 'Apply already dispatched; inspect original outcome')
        backup = self.backup_restore()
        require(backup.get('restore') == 'passed', 'Isolated restore required'); self.save('backup.json', backup)
        require(self.baseline() == proof['before'], 'Baseline drift during backup')
        self.save('apply-attempt.json', {'sha': self.sha, 'at': time.time(), 'backup': backup})
        result = self.owner('deploy')
        self.save('owner-deploy.json', result)
        require(result.get('applied') == list(MIGRATIONS) and result.get('existingDataPreserved') is True and
                result.get('privilegesRemoved') == [] and result.get('allBranchesEdge') is True, 'Owner result differs')
        self.verify_acl(proof); self.ready()
        require(self.neighbors() == proof['before']['neighbors'], 'Neighbors drifted before switch')
        try:
            self.remote(market.api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            self.ready(); self.switch(REMOTE+'/current', REMOTE+'/releases/'+BASELINE, REMOTE+'/releases/'+self.sha)
            if proof['portal']:
                release = self.portal_release(self.sha)
                self.remote(portal_compose(release) + ' up -d --no-deps --wait --wait-timeout 60 portal', timeout=120)
                self.switch(PORTAL_STATE+'/current', self.portal_release(self.args.expected_portal_sha), release)
            self.current(proof)
        except market.CommandUncertain:
            raise  # transport uncertainty: lock retained, no competing rollback
        except Exception:
            self.restore(proof)
            raise
        self.save('applied.json', {'sha': self.sha, 'schema': 56, 'flags': FLAGS_OFF, 'branch_mode': 'edge',
                                   'portal_updated': bool(proof['portal']), 'backup': backup, 'at': time.time()})

    def restore(self, proof):
        require(self.ledger() == self.expected_ledger(True), 'Rollback migration drift')
        self.verify_acl(proof)
        require(self.read_text(self.compose_path(self.sha)) == proof['before']['candidate'], 'Cloud kitchen enabled; run disable first')
        require(self.status()['mode'] == 'edge', 'Branch is in cloud mode; run disable first')
        moved = self.portal_moved(proof)
        require(self.neighbors(moved) == self.strip(proof['before']['neighbors'], moved) and
                self.rollback_artifacts() == proof['before']['rollback'], 'Rollback baseline drift')
        pointer = self.remote('readlink -f ' + REMOTE + '/current')
        require(pointer in (REMOTE+'/releases/'+BASELINE, REMOTE+'/releases/'+self.sha), 'Foreign pointer')
        self.remote(market.api_compose(BASELINE) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
        if pointer.endswith(self.sha):
            self.switch(REMOTE+'/current', pointer, REMOTE+'/releases/'+BASELINE)
        if proof['portal']:
            old = self.portal_release(self.args.expected_portal_sha)
            current = self.remote('readlink -f ' + PORTAL_STATE + '/current')
            require(current in (old, self.portal_release(self.sha)), 'Foreign portal pointer')
            self.remote(portal_compose(old) + ' up -d --no-deps --wait --wait-timeout 60 portal', timeout=120)
            if current != old:
                self.switch(PORTAL_STATE+'/current', current, old)
        require(self.running_revision() == BASELINE and self.api_image() == self.args.expected_api_image, 'Rollback API differs')
        self.ready(); self.verify_public()
        require(self.runtime_environment() == proof['before']['environment'], 'Restored environment differs')
        require(self.neighbors(moved) == self.strip(proof['before']['neighbors'], moved), 'Restored neighbors differ')
        portal = self.portal()
        require(portal['health']['sourceSha'] == self.args.expected_portal_sha and not portal['facts']['cloud'], 'Restored portal differs')
        self.save('rollback.json', {'sha': self.sha, 'restored_api': BASELINE, 'schema_retained': 56, 'grants_retained': True,
                                    'database_restore': False, 'portal_restored': bool(proof['portal'])})

    def rollback(self):
        proof = self.prepared()
        require(self.running_revision() in (BASELINE, self.sha), 'Foreign API revision; stop rollback')
        if not self.args.apply:
            return self.plan('rollback', {'database_restore': False})
        self.restore(proof)

    # ---------- enable / disable ----------
    def applied(self):
        proof = self.prepared()
        path = self.private/'applied.json'
        require(path.is_file() and not path.is_symlink() and json.loads(path.read_text()).get('sha') == self.sha, 'Completed apply required')
        return proof

    def enabled_now(self, proof):
        """True when the candidate compose carries the enable delta (flags ON + network)."""
        compose = self.read_text(self.compose_path(self.sha))
        if compose == proof['before']['candidate']:
            return False
        require(compose == compose_enabled(proof['before']['candidate']), 'Unexpected compose state')
        return True

    def enabled_portal_config(self, mode='plan', want='0'*64):
        """Exact SHA-256 of the portal config with the keyless cloudKitchen block (read-only in plan)."""
        out = json.loads(self.remote('python3 -c ' + quote(ENABLE_PORTAL) + ' ' + ' '.join(map(quote, [
            mode, PORTAL_CONFIG, PORTAL_PRE_CLOUD, self.args.expected_portal_config_sha256, BRANCH, API_ORIGIN, want]))))
        require(re.fullmatch('[a-f0-9]{64}', out.get('config_sha256', '')) and
                out.get('original_sha256') == self.args.expected_portal_config_sha256, 'Portal config plan differs')
        return out['config_sha256']

    def expected_enabled_config(self):
        if self.args.expected_enabled_config_sha256:
            return self.args.expected_enabled_config_sha256
        path = self.private/'enabled.json'
        require(path.is_file() and not path.is_symlink(), '--expected-enabled-config-sha256 required')
        return json.loads(path.read_text())['config_sha256']

    def stations(self):
        proof = self.applied(); self.current(proof, self.enabled_now(proof))
        setup_path = self.args.kitchen_setup
        require(setup_path and setup_path.is_file(), '--kitchen-setup JSON required')
        setup = json.loads(setup_path.read_text())
        form = kitchen_setup_form(setup)
        preview = self.owner('stations-preview', '--branch', BRANCH, input=json.dumps(setup))
        require(preview.get('routeAll') == (form == 'route_all') and preview.get('routes', 0) > 0, 'Stations preview differs')
        if not self.args.apply:
            return self.plan('stations', {'status': self.status(), 'form': form, 'preview': preview})
        result = self.owner('stations', '--branch', BRANCH, input=json.dumps(setup))
        self.save('stations.json', result)
        require(result.get('provisioned', {}).get('routingVersion') == preview['routingVersion'] and
                result.get('routingVersion') == preview['routingVersion'], 'Provisioned routing differs from preview')
        stations_ready(result)

    def enable(self):
        proof = self.applied()
        self.current(proof)
        status = stations_ready(self.status())
        require(status['mode'] == 'edge', 'Branch must be edge')
        release = self.portal_release(self.sha if proof['portal'] else self.args.expected_portal_sha)
        self.remote(f'test -f {release}/infra/kitchen-portal/compose.cloud.yaml -a -f {release}/infra/kitchen-portal/cloud.mjs')
        require(self.read_text(self.compose_path(self.sha)) == proof['before']['candidate'], 'Candidate compose changed')
        config_sha = self.enabled_portal_config()
        if not self.args.apply:
            return self.plan('enable', {'status': status, 'flags': FLAGS_ON, 'network': NETWORK,
                                        'portal_cloud_kitchen': {'enabled': True, 'apiOrigin': API_ORIGIN, 'branchId': BRANCH},
                                        'enabled_portal_config_sha256': config_sha, 'screens_created': False})
        require(self.args.expected_enabled_config_sha256 == config_sha, 'Pass --expected-enabled-config-sha256 from the enable dry run')
        steps = {}
        if not self.network_present():
            self.remote(f'docker network create --internal {NETWORK}')
        net = json.loads(self.remote('docker network inspect --format ' + quote('{{json .}}') + ' ' + NETWORK))
        require(net.get('Internal') is True and net.get('Driver') == 'bridge', 'Cloud network must be internal bridge')
        candidate = compose_enabled(proof['before']['candidate'])
        self.write_remote(self.compose_path(self.sha), candidate)
        self.remote(market.api_compose(self.sha) + ' config --quiet')
        self.remote(market.api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
        self.ready(); steps['api'] = 'flags_on'; self.save('enable-steps.json', steps)
        steps['config_sha256'] = self.enabled_portal_config('apply', config_sha); self.save('enable-steps.json', steps)
        self.remote(portal_compose(release, True) + ' up -d --no-deps --wait --wait-timeout 60 portal', timeout=120)
        steps['portal'] = 'cloud_overlay'; self.save('enable-steps.json', steps)
        steps['mode'] = self.owner('mode', '--branch', BRANCH, '--owner', 'cloud', '--operator', self.args.operator,
                                   '--reason', self.args.reason.strip())
        require(steps['mode'].get('after') == 'cloud' and steps['mode'].get('audited') is True, 'Mode change differs')
        self.save('enable-steps.json', steps)
        self.current(proof, True)
        after = self.status()
        require(after['mode'] == 'cloud', 'Enabled status differs')
        self.save('enabled.json', {'sha': self.sha, 'branch': BRANCH, 'mode': 'cloud', 'epoch': after['epoch'],
                                   'config_sha256': config_sha, 'at': time.time()})

    def screen_code(self):
        """One screen per call; the plain pairing code goes only to this interactive terminal."""
        proof = self.applied()
        self.current(proof, self.enabled_now(proof))
        role, screen = self.args.role, self.args.screen
        status = stations_ready(self.status())
        if screen:
            require(re.fullmatch(UUID, screen) and {'id': screen, 'role': role} in status['activeScreens'],
                    'Active screen of this role required for a new code')
            argv, detail = ['pairing-code', '--branch', BRANCH, '--screen', screen], {'screen': screen}
        else:
            stations, name = screen_request(status, role, self.args.screen_name)
            argv = ['create', '--branch', BRANCH, '--role', role] + sum([['--station', x] for x in stations], []) + ['--name', name]
            detail = {'stations': stations, 'name': name}
        if not self.args.apply:
            return self.plan('screen-code', {'role': role, 'mode': status['mode'], **detail,
                                             'code_output': 'owner terminal only, once, 10 minutes'})
        require(sys.stdout.isatty(), 'screen-code prints the code only to an interactive terminal (no pipe/redirect)')
        argv += ['--operator', self.args.operator, '--reason', self.args.reason.strip()]
        out = self.remote(market.api_compose(self.sha) + ' run --rm --no-deps -T --entrypoint node provision ' + SCREEN_OWNER + ' ' +
                          ' '.join(map(quote, argv)), timeout=240)
        result = json.loads(out.splitlines()[-1])
        code, issued = result.get('pairingCode', ''), result.get('screen') or {}
        require(re.fullmatch(CODE_RE, code) and issued.get('role') == role, 'Pairing code response differs')
        self.save('screen-code-' + uuid.uuid4().hex + '.json', {
            'sha': self.sha, 'role': role, 'screen': issued.get('screenId'), 'expiresAt': result.get('expiresAt'),
            'operator': self.args.operator, 'reason': self.args.reason.strip(), 'code_recorded': False, 'at': time.time()})
        path = {'prep': 'pickchick.kz/kitchen/prep', 'assembly': 'pickchick.kz/kitchen/assembly', 'display': 'pickchick.kz/display'}[role]
        sys.stdout.write(f'Код экрана {role}: {code}\nДействует до {result.get("expiresAt")}. Ввести на {path} -> «Код экрана».\n')
        sys.stdout.flush()

    def mode_edge(self):
        self.applied()
        status = self.status()
        require(status['mode'] == 'cloud', 'Branch is not in cloud mode')
        if not self.args.apply:
            return self.plan('mode-edge', {'status': status})
        result = self.owner('mode', '--branch', BRANCH, '--owner', 'edge', '--operator', self.args.operator, '--reason', self.args.reason.strip())
        require(result.get('after') == 'edge' and result.get('audited') is True, 'Mode change differs')
        self.save('mode-edge-' + uuid.uuid4().hex + '.json', result)

    def disable(self):
        proof = self.applied()
        status = self.status()
        if not self.args.apply:
            return self.plan('disable', {'status': status})
        if status['mode'] == 'cloud':
            result = self.owner('mode', '--branch', BRANCH, '--owner', 'edge', '--operator', self.args.operator, '--reason', self.args.reason.strip())
            require(result.get('after') == 'edge', 'Mode change differs')
            status = self.status()
        require(status['activeCloudOrders'] == 0, 'Active cloud orders remain: finish them on the kitchen pages, then rerun disable')
        for screen in status['activeScreens']:
            self.remote(market.api_compose(self.sha) + ' run --rm --no-deps -T --entrypoint node provision ' + SCREEN_OWNER + ' revoke ' +
                        ' '.join(map(quote, ['--branch', BRANCH, '--screen', screen['id'], '--operator', self.args.operator,
                                             '--reason', self.args.reason.strip()])), timeout=240)
        require(not self.status()['activeScreens'], 'Screens still active')
        release = self.portal_release(self.sha if proof['portal'] else self.args.expected_portal_sha)
        facts = self.portal()['facts']
        if facts['cloud'] or facts['pre_cloud']:
            self.remote('python3 -c ' + quote(RESTORE_PORTAL) + ' ' + ' '.join(map(quote, [PORTAL_CONFIG, PORTAL_PRE_CLOUD,
                        self.args.expected_portal_config_sha256])))
        if facts['cloud'] or NETWORK in self.networks(PORTAL):
            self.remote(portal_compose(release) + ' up -d --no-deps --wait --wait-timeout 60 portal', timeout=120)
        if self.read_text(self.compose_path(self.sha)) != proof['before']['candidate']:
            require(self.read_text(self.compose_path(self.sha)) == compose_enabled(proof['before']['candidate']), 'Unexpected compose state')
            self.write_remote(self.compose_path(self.sha), proof['before']['candidate'])
            self.remote(market.api_compose(self.sha) + ' config --quiet')
            self.remote(market.api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
        self.ready(); self.current(proof, False)
        self.save('disabled-' + uuid.uuid4().hex + '.json', {'sha': self.sha, 'mode': 'edge', 'flags': FLAGS_OFF, 'at': time.time()})

    # ---------- dispatch ----------
    @contextmanager
    def owned_lock(self):
        owner = self.args.owner_id
        if not owner:
            with self.deployment_lock():
                yield
            return
        require(self.args.action in ('rollback', 'disable', 'mode-edge') and re.fullmatch(UUID, owner), 'Owned recovery only')
        path = self.private/('lock-owner-'+owner+'.json')
        require(path.is_file() and not path.is_symlink(), 'Local owned-lock evidence absent')
        expected = json.loads(path.read_text())
        require(expected['id'] == owner and expected['sha'] == self.sha, 'Foreign local lock')
        require(json.loads(self.remote('cat ' + quote(market.DEPLOY_LOCK+'/owner.json'))) == expected, 'Foreign live release lock')
        yield  # failure retains the same lock
        script = "import json,os,sys;p,o=sys.argv[1:];assert json.load(open(p+'/owner.json'))['id']==o;os.unlink(p+'/owner.json');os.rmdir(p)"
        self.remote('python3 -c '+quote(script)+' '+quote(market.DEPLOY_LOCK)+' '+quote(owner))

    def run(self):
        self.source_checks(); self.ci()
        if not self.args.apply:
            require(not self.args.owner_id, 'Owner recovery requires --apply')
            require(self.remote('test ! -e ' + market.DEPLOY_LOCK + ' && echo free') == 'free', 'Release lock present; inspect owner first')
        call = getattr(self, self.args.action.replace('-', '_'))
        if self.args.apply:
            with self.owned_lock():
                call()
        else:
            call()


def parse(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('action', choices=['prepare', 'apply', 'stations', 'enable', 'screen-code', 'mode-edge', 'disable', 'rollback'])
    for name in ['sha', 'branch', 'expected-api-sha', 'expected-public-sha', 'expected-api-image', 'expected-compose-sha256',
                 'expected-gateway-sha256', 'expected-qr-worker-image', 'expected-portal-sha', 'expected-portal-config-sha256',
                 'branch-id']:
        p.add_argument('--'+name, required=True)
    for name in ['ssh-key', 'backup-identity', 'ci-proof', 'kitchen-setup', 'source-checkout']:
        p.add_argument('--'+name, type=Path, required=name == 'ssh-key')
    p.add_argument('--ci-run'); p.add_argument('--owner-id'); p.add_argument('--operator'); p.add_argument('--reason')
    p.add_argument('--expected-enabled-config-sha256'); p.add_argument('--role'); p.add_argument('--screen')
    p.add_argument('--screen-name')
    p.add_argument('--apply', action='store_true')
    args = p.parse_args(argv)
    require(not (args.source_checkout and args.apply), '--source-checkout is for read-only dry runs only')
    return args


def use_source_checkout(path):
    """Dry run only: inspect another exact candidate checkout with this profile."""
    path = path.resolve()
    require((path/'.git').exists() and (path/'db/cloud/migrations').is_dir(), 'Invalid source checkout')
    market.REPO = base.REPO = path


def main(argv=None):
    os.umask(0o077)
    args = parse(argv)
    if args.source_checkout:
        use_source_checkout(args.source_checkout)
    release = Release(args)
    try:
        release.run()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error, market.GuardFailure) else 'Release stopped; inspect private evidence and retained lock.', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
