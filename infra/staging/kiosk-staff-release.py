#!/usr/bin/env python3
"""On-host, API-only configuration operator; importing this module performs no IO.

No SSH, builds, migrations, DB writes, enrollment or PIN authentication probes.
The official kiosk-staff-pin.mjs must produce private-dir/verifier.env (0600).
Use a dedicated existing private-dir (0700). inspect saves immutable original
bytes and a full private baseline; subsequent commands require its SHA256.

Main must supply private-dir/expected-work.json (0600), never generated here:
 {"format":"pickchick-kiosk-staff-work-v1", "owner_approved":true,
  "baseline_sha256":"<inspect result>", "approved_at":"<UTC ISO time>",
  "expires_at":"<UTC ISO time, at most 1 hour later>", "work":<baseline.work>}
The owner approved the exact 58-row exception on 16.11; a fresh bound proof is still required.

apply/rollback journal before dispatch. Failures retain our UUID release lock;
rollback needs --owner-id. An interrupted/timeout dispatch cannot be retried or
rolled back automatically: an operator must reconcile Docker first. No foreign
lock is removed. A fresh baseline is needed after unrelated server changes.
On a known failure main must promptly run rollback with the same private-dir,
baseline-sha256 and owner-id from private state.json, then verify its result.
Read-only snapshots detect work drift, but do not suspend concurrent admissions.
They cannot prove absence of activity between snapshots; arrange a quiet window.
"""
import argparse
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import urllib.request
import uuid

REVISION = 'a728cd31855870ab3c792365ba8fbf70d33b083a'
ROOT = Path('/opt/pickchick-staging')
COMPOSE = ROOT / 'releases' / REVISION / 'infra/staging/compose.yaml'
ENV_FILES = (ROOT / 'secrets/staging.env', ROOT / 'releases/7e3120438461cbe561b01a587578060ff2cd9d3b/release.env')
LOCK = ROOT / '.market-release.lock'
API, DB = 'pickchick-staging-api-1', 'pickchick-staging-cloud-db-1'
KEY = 'KIOSK_STAFF_PIN_VERIFIER'
WORK_SQL = Path(__file__).resolve().parents[2] / 'docs/operations/server-window-1105/window-1106-work.sql'
WORK_SQL_SHA = '06c99a189414618471b17306f30c1089aa3e72042a58174b889854c3ec4d771d'
COMPOSE_METADATA = {'com.docker.compose.' + k for k in
                    ('config-hash', 'project.config_files', 'project.working_dir', 'image', 'version', 'replace')}
WORK_TABLES = ('commerce_orders', 'commerce_payment_attempts', 'commerce_kaspi_invoices',
               'commerce_kiosk_kaspi_qr', 'commerce_refunds', 'commerce_refund_effects',
               'commerce_captures', 'cloud_kitchen_orders', 'cloud_fulfillment_projection')
BINDING_TABLES = ('kiosk_devices', 'kiosk_enrollment_aliases', 'devices', 'device_credentials',
                  'fulfillment_transport_bindings', 'pos_order_sync_bindings', 'device_terminal_registry')


class Stop(Exception):
    """Fixed, secret-free failure identifier only."""


class Uncertain(Stop):
    """Completion is unknown; retain lock and do not dispatch again."""


def require(condition, name):
    if not condition:
        raise Stop(name)


def unique(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'input.duplicate_key')
        value[key] = item
    return value


def decode(data):
    return json.loads(data, object_pairs_hook=unique)


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, protected=False):
    require(path.is_absolute() and all(not p.is_symlink() for p in (path, *path.parents)), 'file.symlink')
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'file.not_regular')
    if protected:
        require(stat.S_IMODE(info.st_mode) == 0o600 and info.st_uid == os.geteuid(), 'file.private_required')
    return info


def read(path, protected=False):
    regular(path, protected)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        return stream.read()


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save(path, data, replace=False, mode=0o600):
    """Durable write, exclusive by default; never make a private backup public."""
    if replace:
        regular(path, protected=True)
    temporary = path.with_name('.' + path.name + '.' + str(uuid.uuid4()))
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path)
        sync_dir(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def env_map(values):
    require(isinstance(values, list) and all(isinstance(v, str) and '=' in v for v in values), 'env.invalid')
    return unique([v.split('=', 1) for v in values])


def verifier(data):
    match = re.fullmatch(rb'KIOSK_STAFF_PIN_VERIFIER=(scrypt1\$[0-9a-f]{32}\$[0-9a-f]{64})\n?', data)
    require(match is not None, 'input.verifier_format')
    return match[1].decode()


def candidate(raw, value):
    config = decode(raw)
    require(set(config['services']) == {'api', 'cloud-db', 'redis-cache'}, 'compose.services')
    service = config['services']['api']
    require('env_file' not in service and isinstance(service['environment'], dict), 'compose.environment_dict')
    require(KEY not in service['environment'], 'compose.verifier_already_present')
    service['environment'][KEY] = value.replace('$', '$$')
    return encoded(config)


def only_verifier(old, new, value):
    expected = copy.deepcopy(old)
    require(KEY not in expected['services']['api']['environment'], 'compose.baseline_verifier')
    # Compose config re-escapes literal dollars for reusable JSON/YAML output.
    # Container Env is checked separately against the original single-dollar value.
    expected['services']['api']['environment'][KEY] = value.replace('$', '$$')
    require(new == expected, 'compose.only_verifier')


def mounts(value):
    return sorted(copy.deepcopy(value), key=lambda m: (m['Type'], m['Destination'], m['Source']))


def identity(value):
    result = {k: copy.deepcopy(value.get(k)) for k in
              ('Id', 'Name', 'Image', 'Created', 'Config', 'HostConfig', 'NetworkSettings',
               'RestartCount', 'Path', 'Args')}
    result['Mounts'] = mounts(value['Mounts'])
    result['state'] = {k: v for k, v in value['State'].items() if k != 'Health'}
    return result


def runtime(value):
    config = copy.deepcopy(value['Config'])
    config['Env'] = sorted(config['Env'])
    config['Labels'] = {k: v for k, v in (config.get('Labels') or {}).items() if k not in COMPOSE_METADATA}
    if config.get('Hostname') == value['Id'][:12]:
        config['Hostname'] = '<docker-generated>'
    networks = copy.deepcopy(value['NetworkSettings']['Networks'])
    for network in networks.values():
        network.pop('EndpointID', None)
        ipam = network.get('IPAMConfig') or {}
        for field, request in (('IPAddress', 'IPv4Address'), ('GlobalIPv6Address', 'IPv6Address')):
            if not ipam.get(request):
                network.pop(field, None)  # Dynamic allocation, not requested network configuration.
        network.pop('MacAddress', None)  # Explicit MAC requests remain in Config/HostConfig.
        for key in ('Aliases', 'DNSNames'):
            if key in network and network[key] is not None:
                network[key] = sorted(x for x in network[key] if x not in (value['Id'], value['Id'][:12]))
    return {'name': value['Name'], 'config': config, 'host': value['HostConfig'],
            'mounts': mounts(value['Mounts']), 'networks': networks,
            'path': value['Path'], 'args': value['Args']}


def check_runtime(old, actual, value=None):
    require(actual['Image'] == old['Image'] and actual['Config']['Image'] == old['Config']['Image'], 'runtime.image')
    expected = runtime(old)
    environment = env_map(old['Config']['Env'])
    if value is not None:
        require(KEY not in environment, 'runtime.baseline_verifier')
        environment[KEY] = value
    require(env_map(actual['Config']['Env']) == environment, 'runtime.env')
    expected['config']['Env'] = sorted(k + '=' + v for k, v in environment.items())
    require(runtime(actual) == expected, 'runtime.shape')
    labels = actual['Config']['Labels']
    require(labels.get('com.docker.compose.project.config_files') == str(COMPOSE), 'runtime.compose_path')


def neighbors(before, after):
    require(set(before) == set(after), 'neighbors.inventory')
    require(all(identity(before[n]) == identity(after[n]) for n in before if n != API), 'neighbors.changed')


def epoch(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.utcoffset() == dt.timedelta(0), 'proof.utc_required')
    return parsed.timestamp()


def check_work(proof, work, baseline_hash, now=None):
    now = time.time() if now is None else now
    require(proof.get('format') == 'pickchick-kiosk-staff-work-v1'
            and proof.get('owner_approved') is True, 'work.owner_approval_required')
    require(proof['baseline_sha256'] == baseline_hash, 'work.baseline')
    start, end = epoch(proof['approved_at']), epoch(proof['expires_at'])
    require(start <= now < end and 0 < end - start <= 3600, 'work.approval_expired')
    require(proof['work'] == work, 'work.changed')
    active, detail = work['active'], work['detail']
    zeros = ('pending_payment_attempts', 'unsettled_invoices', 'unsettled_qr',
             'pending_refunds', 'active_cloud_kitchen', 'paid_open_total', 'paid_created_on_or_after_cutoff')
    require(all(type(active[k]) is int and active[k] == 0 for k in zeros), 'work.pending')
    require(type(active['edge_active_total']) is int and active['edge_active_total'] == 58
            and active['edge_set_fingerprint'] == '081db7135f64e160d825901abaa02c64', 'work.exact_exception')
    require(detail['invalid'] == 0 and detail['total'] == 58 and detail['latest'] is not None
            and dt.datetime.fromisoformat(detail['latest']) < dt.datetime.fromisoformat('2026-11-13T00:00:00+05:00'),
            'work.historical_unpaid_only')


def table_hashes(tables):
    # Fixed internal table names only. No row contents leave PostgreSQL.
    entries = []
    for table in tables:
        row = 'to_jsonb(t)'
        if table in ('commerce_kaspi_invoices', 'commerce_kiosk_kaspi_qr'):
            # Worker bookkeeping can move without new financial work. Keep all business
            # identity, state, amount, remote status and deadline fields in the fingerprint.
            row += "-ARRAY['checks','next_check_at','lease_token','lease_until','delivered_at']"
        entries.append("'%s',(SELECT md5(coalesce(string_agg(h,',' ORDER BY h),'')) FROM "
                       '(SELECT md5((%s)::text) h FROM %s t) rows)' % (table, row, table))
    return 'SELECT json_build_object(' + ','.join(entries) + ');'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise Stop('probe.redirect')


class Runner:
    def __init__(self, directory, baseline_hash=None):
        self.directory = directory
        self.baseline_hash = baseline_hash
        self.owner = None
        self.state = None

    def command(self, args, data=None, timeout=180):
        # Compose must resolve only the two pinned env files, never ambient shell overrides.
        environment = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}
        try:
            result = subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', *args],
                                    input=data, capture_output=True, env=environment, timeout=timeout)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            raise Uncertain('command.completion_unknown') from None
        require(result.returncode == 0, 'command.failed')
        return result.stdout

    def compose(self, path=None):
        path = COMPOSE if path is None else path
        return ['compose', '-p', 'pickchick-staging', '--project-directory', str(COMPOSE.parent),
                '--env-file', str(ENV_FILES[0]), '--env-file', str(ENV_FILES[1]), '-f', str(path)]

    def resolved(self, path=None):
        return decode(self.command(self.compose(path) + ['config', '--format', 'json']))

    def inventory(self):
        ids = self.command(['ps', '-aq']).decode().split()
        require(bool(ids), 'inventory.empty')
        return unique([(v['Name'].lstrip('/'), v) for v in decode(self.command(['inspect', *ids]))])

    def image(self, api):
        value = decode(self.command(['image', 'inspect', api['Config']['Image']]))[0]
        require(value['Id'] == api['Image'], 'image.id')
        require(value['Config']['Labels']['org.opencontainers.image.revision'] == REVISION, 'image.revision')
        return value

    def environment(self, resolved, api):
        image = self.image(api)
        service = resolved['services']['api']
        require(service['image'] == api['Config']['Image'], 'compose.image')
        require('env_file' not in service and isinstance(service['environment'], dict), 'compose.environment_dict')
        require((env_map(image['Config'].get('Env') or []) | service['environment']) ==
                env_map(api['Config']['Env']), 'compose.baseline_env')
        labels = api['Config']['Labels']
        require(labels.get('com.docker.compose.project') == 'pickchick-staging'
                and labels.get('com.docker.compose.service') == 'api'
                and labels.get('com.docker.compose.project.config_files') == str(COMPOSE), 'compose.runtime_owner')

    def sql(self, query):
        raw = self.command(['exec', '-i', DB, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
                            '-U', 'postgres', '-d', 'pickchick_cloud'], query.encode())
        return [decode(line) for line in raw.splitlines() if line.strip()]

    def database(self):
        # pg_dump includes schema, owners, column/function/default privileges and policies.
        dump = self.command(['exec', DB, 'pg_dump', '-U', 'postgres', '-d', 'pickchick_cloud',
                             '--schema-only', '--no-comments', '--lock-wait-timeout=10s'])
        stable_dump = b'\n'.join(line for line in dump.splitlines()
                                 if not line.startswith((b'\\restrict ', b'\\unrestrict ')))
        values = self.sql("""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15s';
SELECT json_build_object(
 'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY version) FROM schema_migrations t),
 'roles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY rolname) FROM
   (SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,
           rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig FROM pg_roles) t),
 'members',(SELECT jsonb_agg(to_jsonb(t) ORDER BY roleid,member,grantor) FROM pg_auth_members t),
 'database',(SELECT jsonb_build_object('owner',datdba,'acl',datacl,'config',
   (SELECT jsonb_agg(to_jsonb(s) ORDER BY setdatabase,setrole) FROM pg_db_role_setting s))
   FROM pg_database WHERE datname=current_database()));
""" + table_hashes(BINDING_TABLES) + '\nCOMMIT;')
        require(len(values) == 2, 'database.result')
        return {'schema': sha(stable_dump), 'acl_ledger': values[0], 'bindings': values[1]}

    def work(self):
        raw = read(WORK_SQL)
        require(sha(raw) == WORK_SQL_SHA, 'work.query_hash')
        query = raw.decode().replace('BEGIN READ ONLY;', 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;')
        query = query.rsplit('COMMIT;', 1)[0] + """
SELECT json_build_object('total',count(*),
 'invalid',count(*) FILTER (WHERE f.state<>'held' OR o.state<>'awaiting_payment'
   OR EXISTS(SELECT 1 FROM commerce_captures c WHERE c.order_id=o.id)),
 'latest',max(greatest(o.updated_at,f.observed_at,o.created_at)))
FROM cloud_fulfillment_projection f JOIN commerce_orders o ON o.id=f.order_id
WHERE f.state IN ('held','accepted','in_production','ready','cancel_requested');
""" + table_hashes(WORK_TABLES) + '\nCOMMIT;'
        values = self.sql(query)
        require(len(values) == 3, 'work.result')
        values[0].pop('observed_at')
        return dict(zip(('active', 'detail', 'tables'), values))

    def probes(self):
        result = {}
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        for origin, routes in (
            ('http://127.0.0.1:13100', ('/health/ready', '/v1/auth/config', '/v1/customer-checkout/availability')),
            ('https://api.pickchick.kz', ('/v1/auth/config', '/v1/customer-checkout/availability')),
        ):
            for route in routes:
                request = urllib.request.Request(origin + route, headers={'Cache-Control': 'no-cache'})
                with opener.open(request, timeout=15) as response:
                    require(response.status == 200, 'probe.status')
                    value = decode(response.read(2_000_000))
                require(isinstance(value, dict), 'probe.json')
                if route == '/health/ready':
                    require(value.get('ready') is True, 'probe.ready')
                if route.endswith('/availability'):
                    require(type(value.get('enabled')) is bool and type(value.get('fresh')) is bool
                            and isinstance(value.get('products'), list) and isinstance(value.get('signature'), str),
                            'probe.availability')
                result[origin + route] = {k: v for k, v in value.items() if k not in ('timestamp', 'server_time')}
        return result

    def inputs(self):
        return {str(path): sha(read(path)) for path in ENV_FILES}

    def json(self, name):
        return decode(read(self.directory / name, True))

    def baseline(self):
        data = read(self.directory / 'baseline.json', True)
        require(sha(data) == self.baseline_hash, 'baseline.cas')
        value = decode(data)
        require(value['revision'] == REVISION and value['compose_path'] == str(COMPOSE), 'baseline.target')
        require(sha(read(self.directory / 'original.compose.json', True)) == value['compose_sha256'], 'backup.cas')
        return value

    def live_compose(self, expected, metadata):
        info = regular(COMPOSE)
        require(read(COMPOSE) == expected and
                [stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid] == metadata, 'compose.cas')

    def stable(self, baseline, exact_api=False):
        require(self.inputs() == baseline['inputs'], 'inputs.changed')
        items = self.inventory()
        neighbors(baseline['containers'], items)
        if exact_api:
            require(identity(items[API]) == identity(baseline['containers'][API]), 'api.identity_changed')
        self.image(items[API])
        require(self.database() == baseline['database'], 'database.changed')
        return items

    def inspect(self):
        require(not LOCK.exists() and not LOCK.is_symlink(), 'lock.exists')
        require(not (self.directory / 'state.json').exists(), 'state.exists')
        original = read(COMPOSE)
        candidate(original, 'scrypt1$' + '0' * 32 + '$' + '0' * 64)  # Shape only, no secret input yet.
        info = regular(COMPOSE)
        containers = self.inventory()
        require(API in containers and DB in containers, 'inventory.required')
        require(KEY not in env_map(containers[API]['Config']['Env']), 'runtime.verifier_already_present')
        resolved = self.resolved()
        self.environment(resolved, containers[API])
        value = {'revision': REVISION, 'compose_path': str(COMPOSE), 'compose_sha256': sha(original),
                 'metadata': [stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid],
                 'containers': containers, 'resolved': resolved, 'inputs': self.inputs(),
                 'database': self.database(), 'work': self.work(), 'probes': self.probes()}
        self.live_compose(original, value['metadata'])
        self.stable(value, exact_api=True)
        require(self.work() == value['work'] and self.resolved() == resolved, 'baseline.capture_drift')
        require(not LOCK.exists() and not LOCK.is_symlink(), 'lock.exists')
        save(self.directory / 'original.compose.json', original)
        save(self.directory / 'baseline.json', encoded(value))
        return {'status': 'BASELINE_SAVED', 'baseline_sha256': sha(encoded(value))}

    def approval(self, baseline):
        proof = self.json('expected-work.json')
        check_work(proof, baseline['work'], self.baseline_hash)
        require(self.work() == baseline['work'], 'work.changed')
        return proof

    def prepared(self, baseline):
        original = read(self.directory / 'original.compose.json', True)
        value = verifier(read(self.directory / 'verifier.env', True))
        data = candidate(original, value)
        path = self.directory / 'candidate.compose.json'
        if path.exists():
            require(read(path, True) == data, 'candidate.changed')
        else:
            save(path, data)
        only_verifier(baseline['resolved'], self.resolved(path), value)
        return data, value

    def preflight(self):
        require(not LOCK.exists() and not LOCK.is_symlink(), 'lock.exists')
        baseline = self.baseline()
        self.live_compose(read(self.directory / 'original.compose.json', True), baseline['metadata'])
        items = self.stable(baseline, exact_api=True)
        resolved = self.resolved()
        require(resolved == baseline['resolved'], 'compose.resolved_changed')
        self.environment(resolved, items[API])
        self.prepared(baseline)
        require(self.probes() == baseline['probes'], 'probe.changed')
        self.approval(baseline)
        return baseline

    def owned(self):
        require(self.owner is not None and LOCK.is_dir() and not LOCK.is_symlink(), 'lock.foreign')
        require(decode(read(LOCK / 'owner.json', True)) == self.owner, 'lock.foreign')
        require(set(p.name for p in LOCK.iterdir()) == {'owner.json'}, 'lock.contents')

    def acquire(self, owner):
        require(not LOCK.exists() and not LOCK.is_symlink(), 'lock.foreign')
        try:
            LOCK.mkdir(mode=0o700)
        except FileExistsError:
            raise Stop('lock.foreign') from None
        save(LOCK / 'owner.json', encoded(owner))
        sync_dir(LOCK.parent)
        self.owner = owner

    def release(self):
        self.owned()
        (LOCK / 'owner.json').unlink()
        LOCK.rmdir()
        sync_dir(LOCK.parent)
        self.owner = None

    def journal(self, **values):
        self.owned()
        self.state.update(values)
        path = self.directory / 'state.json'
        save(path, encoded(self.state), replace=path.exists())

    def cas_compose(self, old, new, metadata, mode):
        self.owned()
        self.live_compose(old, metadata)
        # Same-directory atomic replace; compare again after writing/fsyncing the temporary.
        temporary = COMPOSE.with_name('.kiosk-staff-' + self.owner['id'] + '.json')
        save(temporary, new)
        info = regular(temporary, True)
        if (info.st_uid, info.st_gid) != tuple(metadata[1:]):
            os.chown(temporary, metadata[1], metadata[2])
        os.chmod(temporary, mode)
        self.owned()
        self.live_compose(old, metadata)
        os.replace(temporary, COMPOSE)
        sync_dir(COMPOSE.parent)
        self.live_compose(new, [mode, *metadata[1:]])

    def up(self):
        self.owned()
        self.command(self.compose() + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                                      '--wait', '--wait-timeout', '120', 'api'])

    def verify(self, baseline, value):
        items = self.stable(baseline)
        check_runtime(baseline['containers'][API], items[API], value)
        require(items[API]['State']['Running'] and items[API]['State'].get('Health', {}).get('Status') == 'healthy',
                'runtime.health')
        require(self.probes() == baseline['probes'], 'probe.changed')
        self.approval(baseline)
        self.owned()
        return items[API]['Id']

    def dispatch(self, baseline, value):
        # Intent remains ambiguous on crash even if no exception handler gets to run.
        self.journal(status='dispatching')
        self.approval(baseline)  # Last read immediately before API recreation.
        self.up()
        self.journal(status='verifying')
        self.approval(baseline)  # First check after Compose completion.
        return self.verify(baseline, value)

    def apply(self):
        baseline = self.preflight()  # Capture/verify BEFORE creating shared lock.
        require(not (self.directory / 'state.json').exists(), 'state.exists')
        owner = {'id': str(uuid.uuid4()), 'action': 'kiosk-staff-env', 'baseline_sha256': self.baseline_hash}
        self.acquire(owner)
        self.state = {'owner': owner, 'status': 'locked'}
        try:
            self.journal()
            self.stable(baseline, exact_api=True)
            original = read(self.directory / 'original.compose.json', True)
            data, value = self.prepared(baseline)
            self.approval(baseline)
            self.journal(status='replacing')
            self.cas_compose(original, data, baseline['metadata'], 0o600)
            only_verifier(baseline['resolved'], self.resolved(), value)
            self.stable(baseline, exact_api=True)
            deployed_id = self.dispatch(baseline, value)
            self.live_compose(data, [0o600, *baseline['metadata'][1:]])
            self.journal(status='applied', deployed_id=deployed_id)
            self.release()
            return {'status': 'APPLIED', 'owner_id': owner['id']}
        except BaseException as error:
            self.failed(error)
            raise

    def failed(self, error):
        # No automatic rollback: work, binding or neighbor drift must stop all mutations.
        status = 'uncertain' if isinstance(error, (Uncertain, KeyboardInterrupt, SystemExit)) else 'failed'
        try:
            self.journal(status=status)
        except Exception:
            pass  # Preserve lock and durable previous intent if writing evidence fails.

    def rollback(self, owner_id):
        baseline = self.baseline()
        self.state = self.json('state.json')
        owner = self.state['owner']
        require(owner['id'] == owner_id and owner['baseline_sha256'] == self.baseline_hash, 'rollback.owner')
        require(self.state['status'] in ('applied', 'failed', 'replacing', 'locked', 'verifying'),
                'rollback.uncertain_requires_review')
        data, value = self.prepared(baseline)
        original = read(self.directory / 'original.compose.json', True)
        items = self.stable(baseline)
        api = items[API]
        # Only the exact original or our env-only candidate may be replaced.
        current_value = value if KEY in env_map(api['Config']['Env']) else None
        check_runtime(baseline['containers'][API], api, current_value)
        if self.state['status'] == 'applied':
            require(api['Id'] == self.state['deployed_id'], 'rollback.identity')
        elif current_value is None:
            require(api['Id'] == baseline['containers'][API]['Id'], 'rollback.foreign_target')
        self.approval(baseline)
        if LOCK.exists() or LOCK.is_symlink():
            self.owner = owner
            self.owned()
        else:
            require(self.state['status'] == 'applied', 'rollback.lock_missing')
            self.acquire(owner)
        try:
            self.stable(baseline)
            live = read(COMPOSE)
            require(live in (original, data), 'rollback.compose_changed')
            metadata = baseline['metadata'] if live == original else [0o600, *baseline['metadata'][1:]]
            self.journal(status='replacing')
            if live != original:
                self.cas_compose(data, original, metadata, baseline['metadata'][0])
            self.live_compose(original, baseline['metadata'])
            require(self.resolved() == baseline['resolved'], 'rollback.resolved_changed')
            self.dispatch(baseline, None)
            self.live_compose(original, baseline['metadata'])
            self.journal(status='rolled_back')
            self.release()
            return {'status': 'ROLLED_BACK', 'owner_id': owner_id}
        except BaseException as error:
            self.failed(error)
            raise


class SafeParser(argparse.ArgumentParser):
    def error(self, _message):
        raise Stop('arguments.invalid')  # argparse otherwise echoes unrecognized private argv.


def main(argv=None):
    try:
        parser = SafeParser(description=__doc__)
        parser.add_argument('action', choices=('inspect', 'preflight', 'apply', 'rollback'))
        parser.add_argument('--private-dir', required=True, type=Path)
        parser.add_argument('--baseline-sha256')
        parser.add_argument('--owner-id')
        args = parser.parse_args(argv)
        require(sys.platform == 'linux' and ROOT.is_dir(), 'host.linux_staging_only')
        import fcntl
        directory = args.private_dir
        require(directory.is_absolute() and directory.is_dir()
                and all(not p.is_symlink() for p in (directory, *directory.parents))
                and stat.S_IMODE(directory.stat().st_mode) == 0o700
                and directory.stat().st_uid == os.geteuid(), 'directory.private_required')
        if args.action != 'inspect':
            require(re.fullmatch('[a-f0-9]{64}', args.baseline_sha256 or ''), 'arguments.baseline_hash')
        if args.action == 'rollback':
            require(str(uuid.UUID(args.owner_id)) == args.owner_id, 'arguments.owner_uuid')
        os.umask(0o077)
        def interrupted(_signal, _frame):
            raise Uncertain('signal.completion_unknown')
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGINT, interrupted)
        fd = os.open(directory / '.runner.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w'):
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            runner = Runner(directory, args.baseline_sha256)
            if args.action == 'preflight':
                runner.preflight()
                result = {'status': 'PREFLIGHT_PASSED'}
            elif args.action == 'rollback':
                result = runner.rollback(args.owner_id)
            else:
                result = getattr(runner, args.action)()
        print(json.dumps(result))
        return 0
    except Stop as error:
        print(json.dumps({'status': 'STOP', 'check': str(error)}))
    except Exception:
        print(json.dumps({'status': 'STOP', 'check': 'input_or_runtime.failed'}))
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
