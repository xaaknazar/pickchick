#!/usr/bin/env python3
"""Guarded checkout preparation from installed778/schema044. Bank activation stays separate.

Preserves published prices, public assets, mobile policy and bank processes. Adds
bounded API/QR-role grants and authenticated checkout routes, with QR account off.
Uses owned maintenance, encrypted backup/isolated restore, immutable image, exact
11-job CI, old-image compatibility and pointer CAS. Rollback never restores live data.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
import uuid

spec = importlib.util.spec_from_file_location('checkout_enrollment_base', Path(__file__).with_name('release-kiosk-qr.py'))
qr = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = qr
spec.loader.exec_module(qr)
market, base, director = qr.market, qr.base, qr.director
require, quote, digest, REMOTE = qr.require, qr.quote, qr.digest, qr.REMOTE
BASELINE = '778a718ffe916520fc177aaa663546e863a8574a'
COMPOSE_BASELINE = '4422715c2d88148da90056d0b1c9a3833df9817ea1ff7f833c849e2487355767'
GATEWAY_BASELINE = '0bb039bde008cd3a25aeec3d4e06d15f3ad5e8dc3f6eda2e8373fd004264d3ff'
ENV_BASELINE = '6ae2cb96d376f1182931a88f73f2b4bd0e6e08bd92347c8cc1faa6cb682c8287'
IMAGE_BASELINE = 'sha256:aaac929c00e95ff747ee2362ed3b16e66dddc09575cede2aeb22e1ff3ec1944d'
ENV_KEYS = {'KIOSK_CHECKOUT_MAX_MINOR', 'KIOSK_CHECKOUT_FISCAL_POLICY', 'KIOSK_CHECKOUT_APPROVAL_REFERENCE'}
BACKUP_RECIPIENT = REMOTE + '/secrets/backup-recipient.txt'


def validate_environment(value):
    require(isinstance(value, dict) and set(value) == ENV_KEYS, 'Only reviewed kiosk amount/fiscal policy keys allowed')
    require(value['KIOSK_CHECKOUT_MAX_MINOR'] == 'unlimited', 'Owner approved explicit unlimited kiosk business cap')
    require(value['KIOSK_CHECKOUT_FISCAL_POLICY'] == 'deferred_pilot', 'Owner deferred receipts for this stage')
    require(value['KIOSK_CHECKOUT_APPROVAL_REFERENCE'] == 'owner-2026-10-08-no-receipt-unlimited-backoffice', 'Exact owner decision reference required')
    return value


def environment_program():
    return '''from pathlib import Path
import json,sys
p=Path(sys.argv[1]);values=json.load(sys.stdin);lines=p.read_text().splitlines()
assert set(values)=={'KIOSK_CHECKOUT_MAX_MINOR','KIOSK_CHECKOUT_FISCAL_POLICY','KIOSK_CHECKOUT_APPROVAL_REFERENCE'}
assert all(sum(line.startswith(k+'=') for line in lines)==1 for k in values)
p.write_text('\\n'.join(line.split('=',1)[0]+'='+values[line.split('=',1)[0]] if line.split('=',1)[0] in values else line for line in lines)+'\\n')
p.chmod(0o600)
'''


def gateway_candidate(raw, expected_hash):
    require(expected_hash == GATEWAY_BASELINE and digest(raw.encode()) == expected_hash, 'Exact installed778 gateway required')
    anchor = '\t@kiosk_menu_read {'
    require(raw.count(anchor) == 1 and '@kiosk_checkout_' not in raw, 'Ambiguous checkout route insertion')
    uuid_pattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
    blocks = []
    for name, method, path in [
        ('create', 'POST', 'path /v1/kiosk-checkout/quotes /v1/kiosk-checkout/orders'),
        ('payment', 'POST', 'path_regexp kiosk_checkout_payment ^/v1/kiosk-checkout/orders/'+uuid_pattern+'/payment$'),
        ('read', 'GET', 'path_regexp kiosk_checkout_read ^/v1/kiosk-checkout/orders/'+uuid_pattern+'$'),
    ]:
        blocks.append(f'''\t@kiosk_checkout_{name} {{
\t\tmethod {method}
\t\t{path}
\t}}
\thandle @kiosk_checkout_{name} {{
\t\theader X-PickChick-Data kiosk
\t\treverse_proxy pickchick-staging-api-1:3100 {{
\t\t\theader_up -Cookie
\t\t\theader_up -X-Device-Id
\t\t\ttransport http {{
\t\t\t\tdial_timeout 2s
\t\t\t\tresponse_header_timeout 5s
\t\t\t}}
\t\t}}
\t}}

''')
    block = ''.join(blocks)
    candidate = raw.replace(anchor, block+anchor, 1)
    require(candidate.replace(block, '', 1) == raw, 'Existing routes or body limits changed')
    return candidate


def compose_candidate(raw, env):
    validate_environment(env)
    require(digest(raw.encode()) == COMPOSE_BASELINE, 'Exact installed778 compose required')
    return raw


def grants_sql(worker=False):
    helper = 'kioskQrWorkerGrants' if worker else 'kioskCheckoutGrants'
    role = 'pickchick_kaspi_worker' if worker else 'pickchick_app'
    # The reviewed checkout helper is also used by fresh provisioning. On this
    # installed server add permissions only; do not revoke existing mobile ACL.
    import subprocess
    result = subprocess.run(['node', '--input-type=module', '-e',
        f"import {{{helper}}} from './infra/staging/commercial-channel-grants.mjs';console.log({helper}('{role}',true));"],
        cwd=market.REPO, check=True, capture_output=True, text=True).stdout
    statements = [re.sub(r'\s*,\s*', ',', re.sub(r'\s+', ' ', s.strip())) for s in result.split(';') if s.strip().startswith('GRANT ')]
    if not worker: statements.append('GRANT SELECT ON commerce_kiosk_kaspi_qr TO pickchick_app')
    return ';'.join(statements)+';'


def owner_grants_program():
    return """import {createPool,transaction} from '@pickchick/database';
const url=new URL(process.env.CLOUD_DATABASE_URL);
if(url.username!=='pickchick_owner'||url.pathname!=='/pickchick_cloud')throw new Error('Owner database required');
const pool=createPool(url.href);
try{await transaction(pool,c=>c.query("""+json.dumps(grants_sql()+grants_sql(True))+"""));
console.log(JSON.stringify({migrationsApplied:0,qrAccountEnabled:false}));}finally{await pool.end();}"""


def acl_key(row):
    return row['name'], row.get('kind', 'r'), row.get('column') or '', row['privilege'], row['grantable']


def worker_rows(rows):
    return [dict(name=r['name'],kind='S' if r['name'].endswith('_seq') else 'r',column=r['column_name'],privilege=r['privilege'],grantable=r['grantable']) for r in rows]


def verify_grants(before, after, worker=False):
    if worker: before, after = worker_rows(before), worker_rows(after)
    sql = grants_sql(worker).replace('pickchick_kaspi_worker', 'pickchick_app')
    expected = director.expected_acl(before, sql)
    require(sorted(map(acl_key, after)) == sorted(map(acl_key, expected)), 'Runtime permissions differ from exact reviewed delta')


# Private module specialization leaves historical scripts and their evidence intact.
qr.BASELINE = qr.PUBLIC_BASELINE = BASELINE
qr.MIGRATION_HASHES = {}; qr.MIGRATION_TABLES = {}; qr.NEW_TABLES = set()
qr.gateway_candidate = gateway_candidate; qr.compose_candidate = compose_candidate
qr.enrollment_env_append_program = environment_program; qr.owner_migration_program = owner_grants_program


class Release(qr.Release):
    def __init__(self, args):
        require(sys.version_info >= (3, 12), 'Python3.12+ required for PostgreSQL timestamps')
        require((args.expected_api_sha,args.expected_public_sha,args.expected_gateway_sha256) == (BASELINE,BASELINE,GATEWAY_BASELINE), 'Exact installed778 baseline required')
        self.environment_bytes = qr.private_read(args.environment)
        self.enrollment_environment = validate_environment(json.loads(self.environment_bytes))
        self.baseline_schema = 43
        profile = market.ReleaseProfile('kiosk-checkout-schema044', BASELINE, BASELINE, 43, (), base.CI_JOBS, frozenset(), 'kiosk-checkout-release', (), exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)

    def source_checks(self):
        market.Release.source_checks(self)
        require(qr.private_read(self.args.environment) == self.environment_bytes, 'Private environment changed')
        qr.private_read(self.args.backup_identity)

    def baseline_migrations(self):
        names = sorted(Path(p).name for p in self.git('ls-tree','-r','--name-only',BASELINE,'--','db/cloud/migrations/').splitlines() if p.endswith('.sql'))
        require([int(n[:3]) for n in names] == list(range(1,41))+[42,43,44], 'Exact schema044 required')
        return names

    def expected_ledger(self):
        return [{'version':n,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in self.baseline_migrations()]

    def web_manifest_source(self): return BASELINE

    def verify_bank_off(self):
        env = self.runtime_environment()
        require(env.get('KIOSK_KASPI_QR_ENABLED') == digest(b'false') and 'KIOSK_KASPI_INVOICE_ACCOUNT_ID' not in env, 'Bank methods must remain closed during API preparation')
        require(self.psql(market.DB,"SELECT count(*) FROM commerce_provider_accounts WHERE provider='kaspi-qr' AND enabled") == '0', 'QR account enabled before final activation')

    def quiescent(self):
        super().quiescent()
        require(self.psql(market.DB,"SELECT count(*) FROM commerce_kiosk_kaspi_qr WHERE state IN ('issuing','issued','unknown') OR delivered_at IS NULL") == '0', 'QR reconciliation is pending; retain maintenance')

    def runtime_old(self):
        market.Release.runtime_old(self)
        safe_worker = self.psql(market.DB,"SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) FROM pg_roles r WHERE rolname='pickchick_kaspi_worker'")
        require(safe_worker == 't', 'Bank worker role must remain restricted')
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER) == IMAGE_BASELINE, 'Installed immutable API differs')
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] == GATEWAY_BASELINE, 'Mounted gateway differs')
        paths = {REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml':COMPOSE_BASELINE, REMOTE+'/releases/'+BASELINE+'/release.env':ENV_BASELINE}
        require(self.file_hashes(list(paths)) == paths, 'Baseline compose/environment changed')
        require(self.ledger() == self.expected_ledger(), 'Migration ledger differs')
        self.verify_bank_off()

    def prepared_artifacts(self, manifest):
        result = market.Release.prepared_artifacts(self, manifest)
        result['preserved_policy'] = self.protected_policy()
        result['neighbors'] = self.fingerprint()
        result['rollback_image_id'] = self.remote('docker image inspect --format '+quote('{{.Id}}')+' pickchick-api:'+BASELINE)
        require(result['rollback_image_id'] == IMAGE_BASELINE, 'Rollback image differs')
        return result

    def verify_data(self, before):
        require(self.ledger() == before['ledger'] == self.expected_ledger(), 'Checkout release must not migrate')
        self.compare_runtime(before)
        verify_grants(before['acl'], self.acl())
        verify_grants(before['worker_acl'], self.worker_acl(), True)

    def verify_environment(self, before):
        super().verify_environment(before)
        self.verify_bank_off()

    def preflight(self):
        self.source_checks(); self.ci(); self.runtime_old()
        self.save('preflight.json', {'source_sha':self.sha,'deployed':False,'baseline_api':BASELINE,'qr_account_enabled':False})
        print('Read-only checkout preflight passed; bank activation remains closed', flush=True)

    def save(self, name, value):
        if name in ['prepared.json','result.json']:
            value = {**value,'baseline_api':BASELINE,'baseline_public':BASELINE,'enrollment_only':False,
                'migrations_applied':0,'guest_checkout_enabled':False,'qr_account_enabled':False,
                'fiscal_policy':'deferred_pilot','max_order_minor':'unlimited','prices':'published_backoffice'}
        return super().save(name,value)

    def backup_restore(self, expected):
        suffix = time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+uuid.uuid4().hex[:8]
        backup = REMOTE+'/backups/cloud-kiosk-checkout-'+suffix+'.dump.age'
        script = f'''set -euo pipefail
umask 077
exec 9>{REMOTE}/backups/.lock
flock -n 9
recipient=$(cat {BACKUP_RECIPIENT})
[[ "$recipient" == age1* ]]
test ! -e {backup}
trap 'rm -f {backup}.tmp' EXIT
docker exec {market.DB_CONTAINER} pg_dump -U postgres -d {market.DB} --format=custom --no-owner --no-acl | age -r "$recipient" -o {backup}.tmp
test -s {backup}.tmp
mv {backup}.tmp {backup}
sha256sum {backup} > {backup}.sha256
'''
        self.remote('bash -o pipefail -c '+quote(script),timeout=180)
        self.remote('sha256sum --check '+backup+'.sha256')
        database = 'pickchick_restore_kiosk_'+uuid.uuid4().hex[:12]
        self.save('restore-started.json',{'temporary_database':database,'encrypted_backup':backup})
        self.remote(f'docker exec {market.DB_CONTAINER} createdb -U postgres {database}')
        try:
            pipeline = f'age --decrypt --identity /dev/stdin {backup} | docker exec -i {market.DB_CONTAINER} pg_restore -U postgres -d {database} --exit-on-error --no-owner --no-acl'
            self.remote('bash -o pipefail -c '+quote(pipeline),input=self.args.backup_identity.read_bytes(),timeout=180)
            market.compare_existing(expected,self.snapshot(database))
            self.quiescent(); market.compare_existing(expected,self.snapshot())
        except market.CommandUncertain:
            raise
        except Exception:
            self.remote(f'docker exec {market.DB_CONTAINER} dropdb -U postgres {database}')
            raise
        else:
            self.remote(f'docker exec {market.DB_CONTAINER} dropdb -U postgres {database}')
        return {'path':backup,'sha256':self.remote('sha256sum '+backup).split()[0],'restore':'passed','temporary_database_removed':True}

    def verify_public(self):
        proof = json.loads(qr.private_read(self.private/'prepared.json'))
        for path,key in [('/v1/auth/config','baseline_auth'),('/v1/customer-checkout/catalog','baseline_catalog')]:
            require(self.http_json(path) == proof[key], 'Existing public API changed')
        require(self.http_json('/v1/customer-checkout/availability').get('hours') == proof['baseline_hours'], 'Mobile hours changed')
        require(self.http_json('/kitchen-live/health')['sourceSha'] == proof['kitchen_sha'], 'Kitchen bridge changed')
        actual = json.loads(self.remote('docker exec '+market.GATEWAY+' cat /srv/public/.release.json'))
        require(actual == proof['public_manifest'] and self.prepared_artifacts(actual) == proof['artifacts'], 'Public artifacts changed')
        code,body = self.http('/backoffice/finance.js')
        require(code == 200 and digest(body) == actual['files']['backoffice/finance.js'], 'Finance asset changed')
        branch = '/v1/admin/backoffice/branches/7a6f6d98-395d-4462-b5e4-b0364a4a8ec1/finance'
        require(self.http(branch+'?start_date=2026-10-01&end_date=2026-10-31')[0] == 401, 'Anonymous finance read accepted')
        require(self.probe_json(branch+'/commands',{'request_id':'00000000-0000-4000-a000-000000000001','reason':'Anonymous authorization probe','command':{'type':'void','id':'00000000-0000-4000-a000-000000000002'}})[0] == 401, 'Anonymous finance command accepted')
        for path,method in [('config','GET'),('catalog','GET'),('availability','GET'),('sessions','POST'),('sessions/end','POST'),('enrollment/check','POST'),('quotes','POST'),('orders','POST'),('orders/00000000-0000-4000-a000-000000000001','GET'),('orders/00000000-0000-4000-a000-000000000001/payment','POST')]:
            require(self.http('/v1/kiosk-checkout/'+path,method=method)[0] in [400,401], 'Anonymous kiosk request accepted or route absent')
        for path,method in [('/v1/customer-checkout/test-payments','POST'),('/v1/integrations/tiptoppay/test-checkout','GET'),('/v1/integrations/tiptoppay/checkout','GET')]:
            require(self.http(path,method=method)[0] == 404, 'Unrelated payment feature exposed')
        self.verify_bank_off()

    def rollback_closed(self):
        # Restore the exact worker ACL only under original maintenance, after
        # confirming that no money changed. Then inherited rollback restores API.
        self.source_checks(); self.ci()
        require(hasattr(self,'maintenance') and hasattr(self,'lock_owner'), 'Owned rollback context required')
        self.cleanup('status')
        require(self.http('/v1/test/orders',method='POST')[0] == 503, 'Rollback requires closed ingress')
        before = json.loads(qr.private_read(self.private/'before.json'))
        self.remote(market.api_compose(self.sha)+' stop --timeout 30 api',timeout=60)
        self.quiescent(); self.retained_rollback_snapshot(before)
        current = self.worker_acl()
        if current != before['worker_acl']:
            verify_grants(before['worker_acl'],current,True)
            sql = market.acl_restore_sql(worker_rows(before['worker_acl']),worker_rows(current)).replace('pickchick_app','pickchick_kaspi_worker')
            self.psql(market.DB,sql)
        require(self.worker_acl() == before['worker_acl'], 'Worker ACL restoration differs')
        super().rollback_closed()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['preflight','prepare','apply','rollback'])
    for name in ['sha','branch','expected-api-sha','expected-public-sha','expected-gateway-sha256']:
        parser.add_argument('--'+name,required=True)
    for name in ['ssh-key','backup-identity','environment','ci-proof']:
        parser.add_argument('--'+name,type=Path,required=name != 'ci-proof')
    parser.add_argument('--ci-run'); parser.add_argument('--owner-id')
    args = parser.parse_args(); release = Release(args)
    try:
        if args.action == 'rollback': release.resume_owned_rollback()
        else:
            require(args.owner_id is None,'Owner UUID is rollback-only')
            if args.action == 'preflight': release.preflight()
            else:
                with release.deployment_lock(): getattr(release,args.action)()
    except Exception as error:
        release.record_error(error)
        if args.action == 'preflight': print('Read-only checkout preflight stopped; inspect private diagnostics.',file=sys.stderr)
        else: print('Checkout release stopped; owned lock retained; ingress: '+release.retain_failure(error),file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__': main()
