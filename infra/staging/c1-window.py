#!/usr/bin/env python3
"""C1 remote operator. Import is inert; --apply requires a fresh approved UTC window.

No SSH, scheduling, C3 or migration execution is included. Invoke only after the
owner approves a new window and the local published-source/CI gates pass.
Input is a protected JSON payload; never log it or subprocess output.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.parse
import urllib.request
import uuid

OLD = 'https://pickchick.185.129.51.103.nip.io/legal/'
NEW = 'https://pickchick.kz/legal/'
LINKS = {'CUSTOMER_AUTH_TERMS_URL': 'terms', 'CUSTOMER_AUTH_PRIVACY_URL': 'privacy'}
AUTH_KEYS = sorted(['channel_selection', 'channels', 'consent_version',
                    'delivery_consent_required', 'enabled', 'privacy_url', 'terms_url'])
REVISION = 'org.opencontainers.image.revision'
API = '/pickchick-staging-api-1'
COUNTS = {'pending_payment_attempts': 0, 'unsettled_invoices': 0,
          'unsettled_qr': 0, 'pending_refunds': 0, 'active_cloud_kitchen': 0,
          'edge_active_total': 73, 'paid_open_total': 18}
FINGERPRINTS = {'edge_set_fingerprint': 'ae36192ee51ad34c6cd5d4ef0aaa08cb',
                'paid_set_fingerprint': 'cdde16e3e422e09bbd1afc5b9aab2998'}


def digest(value):
    data = value if isinstance(value, bytes) else json.dumps(
        value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
    return hashlib.sha256(data).hexdigest()


def summary(value):
    """One-way evidence only. Never include scalar configuration values."""
    result = {'sha256': digest(value), 'type': type(value).__name__}
    if isinstance(value, (dict, list, tuple, bytes, str)):
        result['count'] = len(value)
    if isinstance(value, dict):
        result['keys'] = sorted(value)
    return result


class Stop(Exception):
    def __init__(self, record):
        self.record = record
        super().__init__(record['check'])


class Checks:
    def __init__(self):
        self.stage = 'preflight'
        self.records = []

    def equal(self, name, expected, actual):
        # Canonical comparison also distinguishes True from 1 and missing from null.
        ok = digest(expected) == digest(actual)
        record = {'phase': 'C1', 'stage': self.stage, 'check': name,
                  'status': 'PASS' if ok else 'STOP',
                  'expected': summary(expected), 'actual': summary(actual)}
        if name in ['api.env.keys', 'api.env.changed_keys', 'auth.before.keys', 'auth.after.keys']:
            record['expected']['keys'] = expected
            record['actual']['keys'] = actual
        if name.startswith('work.') and isinstance(expected, int):
            record['expected']['count'] = expected
            record['actual']['count'] = actual if isinstance(actual, int) else None
        self.records.append(record)
        if not ok:
            raise Stop(record)

    @contextmanager
    def step(self, name):
        try:
            yield
        except Stop:
            raise
        except Exception as error:
            record = {'phase': 'C1', 'stage': self.stage, 'check': name,
                      'status': 'STOP', 'expected': {'completed': True},
                      'actual': {'completed': False, 'error_type': type(error).__name__}}
            self.records.append(record)
            raise Stop(record) from None


def environment(checks, rows):
    result = {}
    for entry in rows:
        key, value = entry.split('=', 1)
        checks.equal('api.env.unique_keys', False, key in result)
        result[key] = value
    return result


def verify_api(checks, before, after, change_links=True):
    checks.equal('api.image_id', before['Image'], after['Image'])
    checks.equal('api.oci_revision', before['Config']['Labels'][REVISION],
                 after['Config']['Labels'].get(REVISION))
    # API Compose metadata is expected to change when the two URLs change.
    old_env = environment(checks, before['Config']['Env'])
    new_env = environment(checks, after['Config']['Env'])
    expected = dict(old_env)
    if change_links:
        for key, suffix in LINKS.items():
            checks.equal('api.env.old.' + key, OLD + suffix, old_env.get(key))
            expected[key] = NEW + suffix
    checks.equal('api.env.keys', sorted(expected), sorted(new_env))
    changed = sorted(k for k in old_env.keys() | new_env.keys()
                     if k not in old_env or k not in new_env or old_env[k] != new_env[k])
    checks.equal('api.env.changed_keys', sorted(LINKS) if change_links else [], changed)
    checks.equal('api.env.exact_values', expected, new_env)


def verify_auth(checks, before, after, change_links=True):
    checks.equal('auth.before.keys', AUTH_KEYS, sorted(before))
    checks.equal('auth.after.keys', AUTH_KEYS, sorted(after))
    expected = dict(before)
    if change_links:
        for field, suffix in [('terms_url', 'terms'), ('privacy_url', 'privacy')]:
            checks.equal('auth.old.' + field, OLD + suffix, before[field])
            expected[field] = NEW + suffix
    checks.equal('auth.exact_values', expected, after)


def neighbors(rows):
    # Full labels for every neighbor, plus all original identity/liveness checks.
    return sorted([{'name': r['Name'], 'id': r['Id'], 'image': r['Image'],
                    'running': r['State']['Running'], 'started': r['State']['StartedAt'],
                    'labels': r['Config'].get('Labels')}
                   for r in rows if r['Name'] != API], key=lambda r: r['name'])


def verify_work(checks, work):
    for key, value in {**COUNTS, **FINGERPRINTS}.items():
        checks.equal('work.' + key, value, work.get(key))


def verify_window(checks, payload, now, starting=False):
    start = datetime.fromisoformat(payload['approved_start_utc'])
    end = datetime.fromisoformat(payload['approved_end_utc'])
    checks.equal('window.aware', True, start.utcoffset() is not None and end.utcoffset() is not None)
    almaty = timezone(timedelta(hours=5))
    local_start, local_end = start.astimezone(almaty), end.astimezone(almaty)
    start_minute = local_start.hour * 60 + local_start.minute
    end_minute = local_end.hour * 60 + local_end.minute
    daytime = 7 * 60 <= start_minute < 16 * 60 and end_minute <= 19 * 60
    nighttime = 30 <= start_minute < 7 * 60 and end_minute <= 7 * 60
    # Owner-approved, date-bound exception. This is not a reusable evening mode.
    evening = (payload.get('window_exception') == 'owner-evening-2026-11-06'
               and start >= datetime(2026, 11, 6, 15, 12, tzinfo=timezone.utc)
               and end <= datetime(2026, 11, 6, 18, 30, tzinfo=timezone.utc))
    checks.equal('window.bounds', True, local_start.date() == local_end.date()
                 and start < end and (daytime or nighttime or evening))
    checks.equal('window.current', True, start <= now < end)
    if starting:
        local_now = now.astimezone(almaty)
        checks.equal('window.start_deadline', True,
                     (now < end - timedelta(minutes=90)) if evening
                     else local_now.hour < (16 if daytime else 7))


class Host:
    """Only used after explicit --apply. All output stays captured, never printed."""
    def __init__(self, payload, checks):
        self.p, self.c = payload, checks
        self.root = Path('/opt/pickchick-staging')
        self.release = self.root / 'releases' / payload['api_revision']
        self.compose = self.release / 'infra/staging/compose.yaml'
        self.lock = self.root / '.market-release.lock'
        self.folder = self.root / 'maintenance' / ('C1-' + payload['owner_id'])
        self.backup = self.folder / 'compose.before.json'
        self.owned = False

    def run(self, name, args, data=None, timeout=40):
        with self.c.step(name):
            result = subprocess.run(args, input=data, capture_output=True, text=True,
                                    timeout=timeout, cwd=self.release)
            self.c.equal(name + '.exit', 0, result.returncode)
            return result.stdout.strip()

    def compose_command(self, name, path, args):
        return self.run(name, ['docker', 'compose', '--env-file', str(self.root / 'secrets/staging.env'),
                              '--env-file', str(self.release / 'release.env'), '-f', str(path), *args],
                        timeout=150)

    def read_compose(self):
        return self.compose.read_bytes()

    def state(self):
        ids = self.run('docker.list', ['docker', 'ps', '-aq']).split()
        rows = json.loads(self.run('docker.inspect', ['docker', 'inspect', *ids]))
        api = next(r for r in rows if r['Name'] == API)
        api_snapshot = {'Image': api['Image'], 'Config': {
            'Labels': api['Config'].get('Labels') or {}, 'Env': api['Config']['Env']}}
        return {'api': api_snapshot, 'neighbors': neighbors(rows),
                'pointers': [str((self.root / name).resolve()) for name in ['current', 'public-https/current']]}

    def db(self, sql):
        return self.run('db.readonly', ['docker', 'exec', '-i', 'pickchick-staging-cloud-db-1',
                        'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'pickchick_cloud'], sql)

    def work(self):
        return json.loads(self.db(self.p['work_sql']))

    def ledger(self):
        return digest(self.db("BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; "
                              "SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text "
                              "FROM schema_migrations m; COMMIT;"))

    def get(self, name, url):
        with self.c.step(name):
            start = time.monotonic()
            with urllib.request.urlopen(url, timeout=38) as response:
                self.c.equal(name + '.http', 200, response.status)
                return json.load(response), time.monotonic() - start

    def auth(self):
        return self.get('auth.get', 'https://api.pickchick.kz/v1/auth/config')[0]

    def health(self):
        code = "fetch('http://127.0.0.1:3100/health/ready').then(r=>{console.log(r.status);if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"
        self.c.equal('readiness.http', '200', self.run('readiness.command', [
            'docker', 'exec', 'pickchick-staging-api-1', 'node', '-e', code]))
        self.get('health.public', 'https://api.pickchick.kz/health/live')

    def availability(self):
        for name, host in [('domain', 'https://api.pickchick.kz'),
                           ('nip', 'https://pickchick.185.129.51.103.nip.io')]:
            url = host + '/v1/customer-checkout/availability'
            body, _ = self.get('availability.' + name, url)
            self.c.equal('availability.' + name + '.signature', True, isinstance(body.get('signature'), str))
            _, seconds = self.get('longpoll.' + name, url + '?' + urllib.parse.urlencode({'after': body['signature']}))
            self.c.equal('longpoll.' + name + '.timeout', True, seconds <= 35)

    def acquire(self):
        self.lock.mkdir(mode=0o700)
        self.owned = True
        # If writing owner metadata fails, keep the lock for manual investigation.
        (self.lock / 'owner.json').write_text(json.dumps({'id': self.p['owner_id'], 'operation': 'C1'}))
        self.folder.mkdir(mode=0o700)

    def lockcheck(self):
        self.c.equal('lock.owner', self.p['owner_id'], json.loads((self.lock / 'owner.json').read_text())['id'])

    def save_backup(self, original):
        with self.backup.open('xb') as stream:
            os.chmod(self.backup, 0o600)
            stream.write(original)
        self.c.equal('backup.sha256', digest(original), digest(self.backup.read_bytes()))

    def backup_bytes(self):
        return self.backup.read_bytes()

    def prepare(self, original):
        self.c.equal('prepare.source_sha256', self.p['prepare_sha256'],
                     hashlib.sha256(self.p['prepare_source'].encode()).hexdigest())
        namespace = {'__name__': 'auth_links_prepare'}
        exec(compile(self.p['prepare_source'], 'auth-links-release.py', 'exec'), namespace)
        return namespace['candidate'](original, self.p['compose_sha256'])

    def install(self, candidate):
        temp = self.compose.with_name('.compose-C1-' + self.p['owner_id'] + '.json')
        try:
            with temp.open('xb') as stream:
                os.chmod(temp, self.compose.stat().st_mode & 0o777)
                stream.write(candidate)
            self.compose_command('compose.validate', temp, ['config', '--quiet'])
            self.lockcheck()
            os.replace(temp, self.compose)
            self.compose_command('api.recreate', self.compose,
                                 ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'api'])
        finally:
            temp.unlink(missing_ok=True)

    def persist(self, result):
        if self.folder.is_dir():
            (self.folder / 'result.json').write_text(json.dumps(result, indent=2) + '\n')

    def release_lock(self):
        self.lockcheck()
        (self.lock / 'owner.json').unlink()
        self.lock.rmdir()
        self.owned = False


def execute(payload, host, checks, clock=lambda: datetime.now(timezone.utc)):
    """Testable transaction. Any failure after replace attempt restores saved bytes."""
    changed = False
    result = {'phase': 'C1', 'status': 'STOP', 'rollback': 'not_needed'}
    try:
        with checks.step('preflight.inputs'):
            checks.equal('owner.uuid', payload['owner_id'], str(uuid.UUID(payload['owner_id'])))
            verify_window(checks, payload, clock(), starting=True)
        with checks.step('preflight.snapshot'):
            original, before, auth_before = host.read_compose(), host.state(), host.auth()
            checks.equal('compose.baseline', payload['compose_sha256'], digest(original))
            checks.equal('api.baseline_image', payload['api_image'], before['api']['Image'])
            checks.equal('api.baseline_revision', payload['api_revision'], before['api']['Config']['Labels'].get(REVISION))
            checks.equal('pointers.baseline', payload['pointers'], before['pointers'])
            verify_auth(checks, auth_before, auth_before, change_links=False)
            checks.equal('auth.telegram_present', True, isinstance(auth_before['channels'], list)
                         and 'telegram' in auth_before['channels'])
            # Reject stale/already-applied baselines before any mutation.
            verify_api(checks, before['api'], before['api'], change_links=False)
            env = environment(checks, before['api']['Config']['Env'])
            for key, suffix in LINKS.items():
                checks.equal('baseline.old.' + key, OLD + suffix, env.get(key))
            for field, suffix in [('terms_url', 'terms'), ('privacy_url', 'privacy')]:
                checks.equal('baseline.auth.' + field, OLD + suffix, auth_before[field])
            verify_work(checks, host.work())
            ledger = host.ledger()
            checks.equal('ledger.baseline', payload['ledger_sha256'], ledger)
            host.health()
        with checks.step('lock.acquire'):
            host.acquire()
        with checks.step('backup.prepare'):
            host.save_backup(original)
            candidate = host.prepare(original)
            checks.equal('compose.only_links', original, candidate.replace(NEW.encode(), OLD.encode()))
        checks.stage = 'install'
        with checks.step('install.guards'):
            verify_window(checks, payload, clock(), starting=True)
            host.lockcheck()
            checks.equal('compose.preinstall', original, host.read_compose())
            checks.equal('state.preinstall', before, host.state())
            checks.equal('auth.preinstall', auth_before, host.auth())
            checks.equal('ledger.preinstall', ledger, host.ledger())
            verify_work(checks, host.work())
        with checks.step('install.api_only'):
            changed = True  # Also rollback if recreate fails after atomic replacement.
            host.install(candidate)
        checks.stage = 'postcheck'
        with checks.step('postcheck.snapshot'):
            host.health()
            after = host.state()
            verify_api(checks, before['api'], after['api'])
            checks.equal('neighbors.full', before['neighbors'], after['neighbors'])
            checks.equal('pointers.unchanged', before['pointers'], after['pointers'])
            checks.equal('ledger.unchanged', ledger, host.ledger())
            verify_auth(checks, auth_before, host.auth())
            checks.equal('compose.installed', candidate, host.read_compose())
            verify_work(checks, host.work())
            host.availability()
            verify_window(checks, payload, clock())
        result.update(status='PASS', compose_sha256=digest(candidate),
                      backup_sha256=digest(original), lock_retained=True)
        # A journal failure after installation is also a rollback trigger.
        result['checks'] = checks.records
        with checks.step('journal.success'):
            host.persist(result)
        # Retain own lock for the external 11/11 domain gate and C3 handoff.
        return result
    except Stop as error:
        result['status'] = 'STOP'
        result['failure'] = error.record
        if changed:
            checks.stage = 'rollback'
            try:
                with checks.step('rollback.restore'):
                    host.lockcheck()
                    checks.equal('rollback.backup', digest(original), digest(host.backup_bytes()))
                    host.install(host.backup_bytes())
                    host.health()
                    restored = host.state()
                    verify_api(checks, before['api'], restored['api'], change_links=False)
                    checks.equal('rollback.neighbors', before['neighbors'], restored['neighbors'])
                    checks.equal('rollback.pointers', before['pointers'], restored['pointers'])
                    checks.equal('rollback.ledger', ledger, host.ledger())
                    verify_auth(checks, auth_before, host.auth(), change_links=False)
                    checks.equal('rollback.compose', original, host.read_compose())
                    verify_work(checks, host.work())
                result['rollback'] = 'PASS'
            except Stop as rollback_error:
                result.update(rollback='FAIL', rollback_failure=rollback_error.record)
        if result['rollback'] in ['PASS', 'not_needed'] and host.owned:
            try:
                with checks.step('lock.release'):
                    host.release_lock()
            except Stop as lock_error:
                result['lock_failure'] = lock_error.record
        result['lock_retained'] = host.owned
    result['checks'] = checks.records
    try:
        with checks.step('journal.persist'):
            host.persist(result)
    except Stop as error:
        result.update(status='STOP', journal_failure=error.record)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    checks = Checks()
    try:
        with checks.step('input.json'):
            import sys
            payload = json.load(sys.stdin)
            host = Host(payload, checks)
        result = execute(payload, host, checks)
    except Stop as error:
        result = {'phase': 'C1', 'status': 'STOP', 'failure': error.record, 'checks': checks.records}
    print(json.dumps(result))
    return 0 if result['status'] == 'PASS' else 2


if __name__ == '__main__':
    raise SystemExit(main())
