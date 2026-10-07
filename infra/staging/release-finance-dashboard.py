#!/usr/bin/env python3
"""Finance UI/API update from installed kiosk menu41d/schema044, with no migrations.

Reuses the historical finance immutable-build, maintenance, lock/CAS and explicit
rollback machinery. The historical module is loaded privately and never edited.
Backups keep the server recipient and add the finance Mac's independent recipient.
Rollback fails closed if any financial/domain data changed after reopening.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
import uuid

spec = importlib.util.spec_from_file_location('finance_dashboard_base', Path(__file__).with_name('release-finance-ledger.py'))
finance = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = finance
spec.loader.exec_module(finance)
market, base = finance.market, finance.base
require, quote, digest, REMOTE = finance.require, finance.quote, finance.digest, finance.REMOTE
BASELINE = '41d2a6173e9efe5af4d07e6da8427a73de917027'
COMPOSE = '4422715c2d88148da90056d0b1c9a3833df9817ea1ff7f833c849e2487355767'
GATEWAY = '0bb039bde008cd3a25aeec3d4e06d15f3ad5e8dc3f6eda2e8373fd004264d3ff'
MANIFEST_SOURCE = 'd6cd144cc7cba9943b614e2a33552111f3f1f44d'
BACKUP_RECIPIENT = REMOTE + '/secrets/backup-recipient.txt'


def verify_changed_paths(paths):
    exact = {'packages/backoffice-core/src/finance.ts', 'services/api/src/finance-controller.ts',
             'infra/staging/release-finance-dashboard.py', 'tests/operations/test_finance_dashboard_release.py'}
    require(all(p in exact or p.startswith(('apps/backoffice/', 'tests/backoffice/finance', 'docs/'))
                for p in paths), 'Candidate changes a component outside the financial release')


def unchanged(raw, expected):
    require(digest(raw.encode()) == expected, 'Installed configuration differs from reviewed baseline')
    return raw


def schema_probe_program():
    # The inherited apply invokes provision twice. Both invocations are strictly
    # read-only; no migrate(), DDL, grants or financial writes occur here.
    return """import {createPool} from '@pickchick/database';
const pool=createPool(process.env.CLOUD_DATABASE_URL);
try {const r=await pool.query('SELECT count(*)::int AS n,max(version) AS last FROM schema_migrations');
if(r.rows[0].n!==43||r.rows[0].last!=='044_cloud_kiosk_enrollment.sql')throw new Error('Schema changed');
console.log(JSON.stringify({migrationFiles:43,lastMigration:44,migrationsApplied:0}));}finally{await pool.end();}"""


# Module-local specialization: keep historical profiles and their tests intact.
finance.BASELINE = finance.PUBLIC_BASELINE = BASELINE
finance.COMPOSE_BASELINE = COMPOSE
finance.GATEWAY_BASELINE = GATEWAY
finance.MIGRATION_HASHES = {}
finance.NEW_TABLES = set()
finance.compose_candidate = lambda raw: unchanged(raw, COMPOSE)
finance.gateway_candidate = lambda raw: unchanged(raw, GATEWAY)
finance.owner_migration_program = schema_probe_program


class Release(finance.Release):
    def execute(self, args, **kwargs):
        # Node24 does not bundle Corepack. Use the repository-pinned pnpm directly.
        if isinstance(args, list) and args[:2] == ['corepack', 'pnpm']:
            args = args[1:]
        return super().execute(args, **kwargs)

    def __init__(self, args):
        require(sys.version_info >= (3, 12), 'Python 3.12 required for PostgreSQL timestamps')
        require((args.expected_api_sha, args.expected_public_sha, args.expected_gateway_sha256) ==
                (BASELINE, BASELINE, GATEWAY), 'Exact installed menu41d baseline required')
        self.baseline_schema = 43
        profile = market.ReleaseProfile('finance-dashboard-schema044', BASELINE, BASELINE,
            43, (), base.CI_JOBS, frozenset(), 'finance-dashboard-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def baseline_migrations(self):
        names = sorted(Path(p).name for p in self.git('ls-tree', '-r', '--name-only', BASELINE,
                       '--', 'db/cloud/migrations/').splitlines() if p.endswith('.sql'))
        require([int(n[:3]) for n in names] == list(range(1, 41)) + [42, 43, 44], 'Exact schema044 required')
        return names

    def expected_ledger(self):
        return [{'version': n, 'scope': 'cloud', 'checksum': digest((market.REPO/'db/cloud/migrations'/n).read_bytes())}
                for n in self.baseline_migrations()]

    def source_checks(self):
        market.Release.source_checks(self)
        verify_changed_paths(self.git('diff', '--name-only', BASELINE, self.sha).splitlines())
        package = json.loads((market.REPO/'package.json').read_text())
        require(self.execute(['pnpm', '--version']).decode().strip() == package['packageManager'].split('@')[1],
                'Pinned pnpm version required')
        require(self.execute(['node', '--version']).decode().strip().lstrip('v') == (market.REPO/'.node-version').read_text().strip(),
                'Pinned Node version required')
        key = self.args.backup_identity
        require(key and key.is_file() and not any(p.is_symlink() for p in [key, *key.parents])
                and key.stat().st_mode & 0o077 == 0, 'Protected local backup identity required')
        recipient = self.execute(['age-keygen', '-y', str(key)]).decode().strip()
        require(re.fullmatch('age1[0-9a-z]{58}', recipient) is not None, 'Expected native age recipient')
        self.backup_recipient = recipient

    def web_manifest_source(self):
        return MANIFEST_SOURCE

    def protected_policy(self):
        return {**super().protected_policy(), **self.file_hashes([BACKUP_RECIPIENT])}

    def runtime_old(self):
        market.Release.runtime_old(self)
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] == GATEWAY,
                'Mounted gateway changed')
        path = REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml'
        require(self.file_hashes([path]) == {path: COMPOSE}, 'Installed API compose changed')
        require(self.ledger() == self.expected_ledger(), 'Installed migration ledger changed')
        self.verify_qr_off()
        self.kitchen_before = self.http_json('/kitchen-live/health')

    def verify_qr_off(self):
        require(self.runtime_environment().get('KIOSK_KASPI_QR_ENABLED') == digest(b'false'), 'QR worker flag changed')
        require(self.psql(market.DB, "SELECT count(*) FROM commerce_provider_accounts WHERE provider='kaspi-qr' AND enabled") == '0',
                'QR provider account became enabled')

    def runtime_snapshot(self):
        original = self.additions
        self.additions = {**original, 'cloud_branch_availability': ['revision', 'observed_at']}
        try:
            return base.Release.snapshot(self)
        finally:
            self.additions = original

    def compare_runtime(self, before):
        base.verify_availability(before['availability'], self.availability_rows())
        market.compare_existing(before['runtime_data'], self.runtime_snapshot())

    def verify_data(self, before):
        require(self.ledger() == before['ledger'] == self.expected_ledger(), 'Financial update must not migrate')
        self.compare_runtime(before)
        require(self.acl() == before['acl'], 'Runtime ACL changed')
        require(self.worker_acl() == before['worker_acl'], 'Bank worker ACL changed')

    def retained_rollback_snapshot(self, before):
        # The old API cannot validate new accountless cash entries. Never roll it
        # back over post-release financial writes, even if they would be retained.
        self.verify_data(before)
        return self.ledger(), self.runtime_snapshot()

    def save(self, name, value):
        if name == 'prepared.json':
            value = {**value, 'finance_backup_recipient': self.backup_recipient}
        if name == 'result.json':
            value = {**value, 'migration_files': 43, 'last_migration': 44, 'migrations_applied': 0,
                     'baseline_api': BASELINE, 'baseline_public': BASELINE, 'qr_worker_enabled': False,
                     'gateway_routes_preserved': True, 'accountless_finance_enabled': True}
        return super().save(name, value)

    def backup_restore(self, expected):
        proof = json.loads((self.private/'prepared.json').read_text())
        require(proof['finance_backup_recipient'] == self.backup_recipient, 'Prepared backup recipient changed')
        suffix = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
        backup = f'{REMOTE}/backups/cloud-finance-{suffix}.dump.age'
        script = f'''set -euo pipefail
umask 077
exec 9>{REMOTE}/backups/.lock
flock -n 9
recipient=$(cat {BACKUP_RECIPIENT})
[[ "$recipient" == age1* ]]
test ! -e {backup}
trap 'rm -f {backup}.tmp' EXIT
docker exec {market.DB_CONTAINER} pg_dump -U postgres -d {market.DB} --format=custom --no-owner --no-acl | age -r "$recipient" -r {quote(self.backup_recipient)} -o {backup}.tmp
test -s {backup}.tmp
mv {backup}.tmp {backup}
sha256sum {backup} > {backup}.sha256
'''
        self.remote('bash -o pipefail -c '+quote(script), timeout=180)
        self.remote('sha256sum --check '+backup+'.sha256')
        database = 'pickchick_restore_finance_' + uuid.uuid4().hex[:12]
        self.save('restore-started.json', {'temporary_database': database, 'encrypted_backup': backup})
        self.remote(f'docker exec {market.DB_CONTAINER} createdb -U postgres {database}')
        try:
            pipeline = f'age --decrypt --identity /dev/stdin {backup} | docker exec -i {market.DB_CONTAINER} '
            pipeline += f'pg_restore -U postgres -d {database} --exit-on-error --no-owner --no-acl'
            self.remote('bash -o pipefail -c '+quote(pipeline), input=self.args.backup_identity.read_bytes(), timeout=180)
            market.compare_existing(expected, self.snapshot(database))
            self.quiescent()
            market.compare_existing(expected, self.snapshot())
        except market.CommandUncertain:
            raise  # Retain temporary DB and locks until the remote process is inspected.
        except Exception:
            self.remote(f'docker exec {market.DB_CONTAINER} dropdb -U postgres {database}')
            raise
        else:
            self.remote(f'docker exec {market.DB_CONTAINER} dropdb -U postgres {database}')
        return {'path': backup, 'sha256': self.remote('sha256sum '+backup).split()[0],
                'restore': 'passed', 'temporary_database_removed': True, 'original_recipient_retained': True}

    def probe_json(self, path, body):
        raw = self.execute(['curl', '--silent', '--show-error', '--max-time', '15', '--max-filesize', '2000000',
            '--resolve', f'{market.HOST}:443:{market.IP}', '-H', 'Content-Type: application/json',
            '--data-binary', json.dumps(body), '-w', '\n%{http_code}', 'https://'+market.HOST+path], timeout=20)
        body, status = raw.rsplit(b'\n', 1)
        return int(status), body

    def verify_public(self):
        proof = json.loads((self.private/'prepared.json').read_text())
        for path, key in [('/v1/auth/config', 'baseline_auth'), ('/v1/customer-checkout/catalog', 'baseline_catalog')]:
            require(self.http_json(path) == proof[key], 'Existing public API changed')
        require(self.http_json('/v1/customer-checkout/availability').get('hours') == proof['baseline_hours'], 'Mobile hours changed')
        require(self.http_json('/kitchen-live/health')['sourceSha'] == proof['kitchen_sha'], 'Kitchen bridge changed')
        actual = json.loads(self.remote('docker exec '+market.GATEWAY+' cat /srv/public/.release.json'))
        require(actual == proof['public_manifest'] and self.prepared_artifacts(actual) == proof['artifacts'], 'Public artifacts changed')
        for name in ['finance.js', 'finance-model.js', 'finance-report.js', 'finance-charts.js', 'styles.css']:
            code, body = self.http('/backoffice/'+name)
            require(code == 200 and digest(body) == actual['files']['backoffice/'+name], 'Finance bundle missing or stale')
        branch = '/v1/admin/backoffice/branches/7a6f6d98-395d-4462-b5e4-b0364a4a8ec1/finance'
        require(self.http(branch+'?start_date=2026-10-01&end_date=2026-10-31')[0] == 401, 'Anonymous finance read accepted')
        require(self.probe_json(branch+'/commands', {'request_id': '00000000-0000-4000-a000-000000000001',
            'reason': 'Anonymous authorization probe', 'command': {'type': 'void', 'id': '00000000-0000-4000-a000-000000000002'}})[0] == 401,
            'Anonymous finance command accepted')
        for path in ['config', 'catalog', 'availability']:
            require(self.http('/v1/kiosk-checkout/'+path)[0] == 400, 'Kiosk menu boundary changed')
        for path in ['sessions', 'sessions/end', 'enrollment/check']:
            require(self.http('/v1/kiosk-checkout/'+path, method='POST')[0] == 400, 'Kiosk session boundary changed')
        for path, method in [('/v1/kiosk-checkout/quotes', 'POST'), ('/v1/kiosk-checkout/orders', 'POST'),
            ('/v1/kiosk-checkout/orders/00000000-0000-4000-a000-000000000001/payment', 'POST'),
            ('/v1/customer-checkout/test-payments', 'POST'), ('/v1/integrations/tiptoppay/test-checkout', 'GET'),
            ('/v1/integrations/tiptoppay/checkout', 'GET')]:
            require(self.http(path, method=method)[0] == 404, 'Disabled payment route exposed')
        self.verify_qr_off()

    def preflight(self):
        self.source_checks(); self.ci(); self.runtime_old()
        self.save('preflight.json', {'source_sha': self.sha, 'baseline_api': BASELINE,
            'baseline_public': BASELINE, 'migration_files': 43, 'last_migration': 44,
            'gateway_sha256': GATEWAY, 'migrations_applied': 0, 'deployed': False})
        print('Read-only finance preflight passed', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preflight', 'prepare', 'apply', 'rollback'])
    for name in ['sha', 'branch', 'expected-api-sha', 'expected-public-sha', 'expected-gateway-sha256']:
        parser.add_argument('--'+name, required=True)
    for name in ['ssh-key', 'backup-identity', 'ci-proof']:
        parser.add_argument('--'+name, type=Path, required=name != 'ci-proof')
    parser.add_argument('--ci-run'); parser.add_argument('--owner-id')
    args = parser.parse_args(); release = Release(args)
    try:
        if args.action == 'rollback': release.resume_owned_rollback()
        else:
            require(args.owner_id is None, 'Owner UUID is rollback-only')
            if args.action == 'preflight': release.preflight()
            else:
                with release.deployment_lock(): getattr(release, args.action)()
    except Exception as error:
        release.record_error(error)
        if args.action == 'preflight':
            print('Read-only preflight stopped; inspect private diagnostics.', file=sys.stderr)
        else:
            ingress = release.retain_failure(error)
            print('Finance release stopped; deployment lock retained; ingress: '+ingress, file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__': main()
