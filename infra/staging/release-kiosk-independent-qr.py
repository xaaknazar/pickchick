#!/usr/bin/env python3
"""Exact installed85f/schema044 -> schema045, API and QR worker only.

No cashier admission before kiosk QR, per owner 2026-10-08. Preserves the bank
bridge/session, mobile worker, public assets, prices and every existing order.
Full CI, owned maintenance, encrypted backup/restore and rollback guards remain.
Requires installing the paid-without-number iPad fix before apply. No bank create
probe, automatic rollback, SQL admission or live database restoration.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('independent_checkout_base', Path(__file__).with_name('release-kiosk-checkout.py'))
checkout = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = checkout
spec.loader.exec_module(checkout)
qr, market, base, director = checkout.qr, checkout.market, checkout.base, checkout.director
require, quote, digest, REMOTE = checkout.require, checkout.quote, checkout.digest, checkout.REMOTE
BASELINE = '85f23d582540f89b0df86b7415cc764f7594774a'
PUBLIC_ASSETS = '778a718ffe916520fc177aaa663546e863a8574a'
GATEWAY = 'a659c2428163b2e51c2f1affd62fda18ab339c6e55cf576cdcf0865b2d1d7d9f'
IMAGE = 'sha256:dcc7df76c42edb8a85446b26b24e95b16384f006a928f17eaec6d9bbb2da3739'
ENV_HASH = '0dee03ffdbc0603efd587e15a0b8fd5b5bb1162ecbc38782598425a75ba93263'
COMPOSE_HASH = '4422715c2d88148da90056d0b1c9a3833df9817ea1ff7f833c849e2487355767'
MIGRATIONS = {'045_cloud_kiosk_qr_before_admission.sql': '9e2be1892bbb749d1f7780bc7e4d97803748d0592adff63f383a90873d4a3255'}
WORKER = 'pickchick-kiosk-kaspi-qr-worker'
BANK_DIR = REMOTE+'/kaspi-bridge/releases/'+BASELINE
WORKER_HASHES = {BANK_DIR+'/worker-compose.json': '36e3f6cbebdb8dbc2bafe4eae0222fb1e3ddf2561636a7715b6f3d04086e98d8',
                 BANK_DIR+'/qr-worker.env': '1934c3121c1088c8d2bd347c1d29586055969a7618dcb03bea59ec239907e1dc'}


def unchanged_gateway(raw, expected):
    require(expected == GATEWAY and digest(raw.encode()) == GATEWAY, 'Installed gateway changed')
    return raw


def unchanged_compose(raw, env):
    require(env == {} and digest(raw.encode()) == COMPOSE_HASH, 'Installed API compose changed')
    return raw


def worker_candidate(raw, sha):
    require(digest(raw.encode()) == WORKER_HASHES[BANK_DIR+'/worker-compose.json'], 'Installed worker compose changed')
    value = json.loads(raw)
    require(set(value['services']) == {'worker'} and value['services']['worker']['image'] == 'pickchick-api:'+BASELINE, 'Wrong worker service')
    value['services']['worker']['image'] = 'pickchick-api:'+sha
    return json.dumps(value)


def migration_program():
    return """import{createPool,migrate}from'@pickchick/database';
const u=new URL(process.env.CLOUD_DATABASE_URL);
if(u.username!=='pickchick_owner'||u.pathname!=='/pickchick_cloud')throw Error('Owner database required');
const p=createPool(u.href);try{await migrate(p,'/app/db/cloud/migrations','cloud');
console.log(JSON.stringify({migrationFiles:44,lastMigration:45}));}finally{await p.end()}"""


# Isolated imported modules specialize the existing guarded release lifecycle.
qr.BASELINE = qr.PUBLIC_BASELINE = BASELINE
qr.MIGRATION_HASHES = MIGRATIONS
qr.MIGRATION_TABLES = {name:set() for name in MIGRATIONS}
qr.NEW_TABLES = set()
qr.gateway_candidate = unchanged_gateway
qr.compose_candidate = unchanged_compose
qr.enrollment_env_append_program = lambda: 'import json,sys;assert json.load(sys.stdin)=={}'
qr.owner_migration_program = migration_program


class Release(qr.Release):
    backup_restore = checkout.Release.backup_restore
    def quiescent(self):
        director.Release.quiescent(self)
        require(self.psql(market.DB,"SELECT count(*) FROM commerce_kiosk_kaspi_qr WHERE state IN ('issuing','issued','unknown') OR delivered_at IS NULL") == '0', 'QR reconciliation pending; retain maintenance')

    def __init__(self, args):
        require(sys.version_info >= (3,12), 'Python3.12+ required')
        require((args.expected_api_sha,args.expected_public_sha,args.expected_gateway_sha256) == (BASELINE,BASELINE,GATEWAY), 'Exact installed85f baseline required')
        self.environment_bytes = qr.private_read(args.environment)
        require(json.loads(self.environment_bytes) == {}, 'Environment changes are outside this profile')
        self.enrollment_environment = {}
        self.baseline_schema = 43
        profile = market.ReleaseProfile('kiosk-independent-qr-schema045', BASELINE, BASELINE, 43,
            tuple(MIGRATIONS), base.CI_JOBS, frozenset(), 'kiosk-independent-qr-release', (), exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)

    def source_checks(self):
        market.Release.source_checks(self)
        require(all(digest((market.REPO/'db/cloud/migrations'/n).read_bytes()) == h for n,h in MIGRATIONS.items()), 'Unreviewed migration045')
        require(qr.private_read(self.args.environment) == self.environment_bytes, 'Environment proof changed')
        qr.private_read(self.args.backup_identity)

    def baseline_migrations(self):
        names = sorted(Path(p).name for p in self.git('ls-tree','-r','--name-only',BASELINE,'--','db/cloud/migrations/').splitlines() if p.endswith('.sql'))
        require([int(n[:3]) for n in names] == list(range(1,41))+[42,43,44], 'Exact schema044 required')
        return names

    def web_manifest_source(self): return PUBLIC_ASSETS

    def fingerprint(self):
        # QR worker is the only additional container updated by this profile.
        result = market.Release.fingerprint(self)
        require(WORKER in result['containers'], 'Installed QR worker absent')
        result['containers'].pop(WORKER)
        return result

    def verify_worker(self, image):
        actual = json.loads(self.remote('docker inspect --format '+quote('{{json .}}')+' '+WORKER))
        bridge = self.remote('docker inspect --format '+quote('{{.Id}}')+' pickchick-kaspi-bridge')
        require(actual['Image'] == image and actual['State']['Running'] and actual['RestartCount'] == 0, 'QR worker image/state differs')
        require(actual['HostConfig']['NetworkMode'] == 'container:'+bridge and not actual['HostConfig']['PortBindings'], 'Worker bridge binding changed')
        require(self.file_hashes(list(WORKER_HASHES)) == WORKER_HASHES, 'Worker configuration/secrets changed')
        require(self.psql(market.DB,"SELECT count(*) FROM commerce_provider_accounts WHERE provider='kaspi-qr' AND enabled") == '1', 'Expected enabled QR account')

    def runtime_old(self):
        market.Release.runtime_old(self)
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER) == IMAGE, 'Installed API image differs')
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] == GATEWAY, 'Gateway bytes differ')
        paths = {REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml':COMPOSE_HASH, REMOTE+'/releases/'+BASELINE+'/release.env':ENV_HASH}
        require(self.file_hashes(list(paths)) == paths, 'Baseline configuration changed')
        require(self.ledger() == [{'version':n,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in self.baseline_migrations()], 'Baseline migration ledger changed')
        self.verify_worker(IMAGE)

    def prepared_artifacts(self, manifest):
        result = market.Release.prepared_artifacts(self,manifest)
        result['preserved_policy'] = {**self.protected_policy(), **self.file_hashes(list(WORKER_HASHES))}
        result['neighbors'] = self.fingerprint()
        result['rollback_image_id'] = IMAGE
        require(self.remote('docker image inspect --format '+quote('{{.Id}}')+' pickchick-api:'+BASELINE) == IMAGE, 'Rollback image changed')
        return result

    def verify_data(self, before):
        require(self.ledger() == before['ledger']+[{'version':n,'scope':'cloud','checksum':h} for n,h in MIGRATIONS.items()], 'Migration ledger differs')
        self.compare_runtime(before)
        require(self.acl() == before['acl'] and self.worker_acl() == before['worker_acl'], 'Runtime grants changed')

    def switch_worker(self, candidate):
        self.quiescent()
        proof = json.loads(qr.private_read(self.private/'prepared.json'))
        path = BANK_DIR+'/worker-compose.json'
        if candidate:
            raw = self.remote('cat '+quote(path))
            content = worker_candidate(raw, self.sha)
            path = REMOTE+'/releases/'+self.sha+'/kiosk-qr-worker.json'
            self.remote('python3 -c '+quote(qr.file_writer_program())+' '+quote(path), input=content)
        self.remote('docker compose -f '+quote(path)+' config --quiet')
        self.remote('docker compose -f '+quote(path)+' up -d --no-deps --force-recreate worker',timeout=120)
        self.verify_worker(proof['image_id'] if candidate else IMAGE)
        self.save('worker-result.json',{'source_sha':self.sha if candidate else BASELINE,'bank_bridge_preserved':True})

    def verify_public(self):
        proof = json.loads(qr.private_read(self.private/'prepared.json'))
        require(self.http_json('/v1/auth/config') == proof['baseline_auth'], 'Auth policy changed')
        require(self.http_json('/v1/customer-checkout/catalog') == proof['baseline_catalog'], 'Published menu changed')
        require(self.http_json('/v1/customer-checkout/availability').get('hours') == proof['baseline_hours'], 'Mobile hours changed')
        require(self.http_json('/kitchen-live/health')['sourceSha'] == proof['kitchen_sha'], 'Kitchen bridge changed')
        require(json.loads(self.remote('docker exec '+market.GATEWAY+' cat /srv/public/.release.json')) == proof['public_manifest'], 'Public assets changed')
        for path,method in [('config','GET'),('catalog','GET'),('quotes','POST'),('orders','POST'),('orders/00000000-0000-4000-a000-000000000001/payment','POST')]:
            require(self.http('/v1/kiosk-checkout/'+path,method=method)[0] in [400,401], 'Anonymous kiosk route accepted or absent')
        self.verify_worker(proof['image_id'])

    def preflight(self):
        self.source_checks(); self.ci(); self.runtime_old()
        self.save('preflight.json',{'source_sha':self.sha,'deployed':False,'baseline_api':BASELINE})
        print('Independent QR read-only preflight passed',flush=True)

    def save(self,name,value):
        if name == 'result.json':
            value = {**value,'migration_files':44,'last_migration':45,'qr_worker_enabled':True,'enrollment_only':False,
                     'worker_preserved':False,'mobile_worker_preserved':True,'bank_bridge_preserved':True,'requires_cashier_before_qr':False}
        return super().save(name,value)

    def apply(self):
        self.source_checks(); self.ci(); self.runtime_old()
        proof = json.loads((self.private/'prepared.json').read_text())
        require((proof['sha'],proof['old_api'],proof['old_web']) == (self.sha,BASELINE,BASELINE), 'Wrong preparation')
        require(proof.get('baseline_schema',33) == self.baseline_schema, 'Prepared baseline schema differs')
        require(self.prepared_artifacts(proof['public_manifest']) == proof['artifacts'] and
                self.rollback_artifacts() == proof['rollback_files'], 'Prepared or rollback artifacts changed')
        require(proof.get('enrollment_environment_sha256')==digest(self.environment_bytes),'Prepared private environment changed')
        require(proof.get('previous_attempt')==getattr(self,'previous_attempt_evidence',None),'Previous attempt evidence changed')
        key = self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0, 'Protected backup identity required')
        require(self.runtime_environment() == proof['baseline_environment'], 'Baseline running environment changed')
        self.maintenance = REMOTE+'/maintenance/kiosk-enrollment-'+self.lock_owner['id']
        contents = {'owner.json':json.dumps(self.lock_owner),'maintenance.json':json.dumps(qr.transport.maintenance_config()),'compose.json':json.dumps(qr.transport.maintenance_overlay(self.maintenance))}
        self.remote('python3 -c '+quote(qr.transport.maintenance_write_script())+' '+quote(self.maintenance),input=json.dumps(contents))
        self.remote(qr.transport.caddy_validation_command(self.maintenance+'/maintenance.json'))
        self.cleanup('acquire')
        self.remote(market.web_compose(BASELINE)+' -f '+quote(self.maintenance+'/compose.json')+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        require(self.http('/v1/test/orders',method='POST')[0] == 503, 'Ingress did not close')
        self.remote(market.api_compose(BASELINE)+' stop --timeout 30 api',timeout=60)
        require(self.psql(market.DB,"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND (usename='pickchick_app' OR xact_start IS NOT NULL)") == '0', 'Competing database writer')
        self.quiescent()
        before = {'data':self.snapshot(),'runtime_data':self.runtime_snapshot(),'availability':self.availability_rows(),'ledger':self.ledger(),'acl':self.acl(),'worker_acl':self.worker_acl(),'neighbors':self.fingerprint(),'audit_rows':self.audit_rows()}
        expected = [{'version':name,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/name).read_bytes())} for name in self.baseline_migrations()]
        retry=getattr(self.args,'retry_retained_043',False)
        retained=retry or getattr(self.args,'previous_attempt_proof_dir',None)
        require(before['ledger'] == expected+([{'version':n,'scope':'cloud','checksum':h} for n,h in MIGRATIONS.items() if n.startswith('043_')] if retained else []), 'Baseline migration ledger differs')
        suffix='retry-'+self.lock_owner['id']+'-' if retry else ''
        self.save(suffix+'before.json',before)
        backup = self.backup_restore(before['data']); self.save(suffix+'backup.json',backup)
        for _ in range(2):
            self.cleanup('status'); self.quiescent()
            self.remote(market.api_compose(self.sha)+' run --rm --no-deps --entrypoint node provision --input-type=module -e '+quote(migration_program()),timeout=180)
            self.verify_data(before)
        # Retain schema045 on rollback; run old API only, never old provision.
        self.remote(market.api_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'], 'Old image incompatible with retained schema045')
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER) == proof['artifacts']['rollback_image_id'], 'Old compatibility image differs')
        self.verify_environment(proof['baseline_environment'])
        self.verify_capabilities(self.http_json('/v1/capabilities',public=False))
        self.verify_data(before)
        self.switch_worker(True)
        self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'], 'Candidate API not ready')
        caps = self.http_json('/v1/capabilities',public=False); self.verify_capabilities(caps)
        self.verify_environment(proof['baseline_environment']); self.verify_data(before)
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER) == proof['image_id'], 'Running image differs')
        require(self.fingerprint() == before['neighbors'] and self.prepared_artifacts(proof['public_manifest']) == proof['artifacts'], 'Neighbor or prepared artifacts changed')
        self.switch(REMOTE+'/current',REMOTE+'/releases/'+BASELINE,REMOTE+'/releases/'+self.sha)
        self.switch(REMOTE+'/public-https/current',REMOTE+'/public-https/releases/'+BASELINE,REMOTE+'/public-https/releases/'+self.sha)
        self.phase = 'reopening'
        self.save('phase.json',{'phase':self.phase,'ingress':'unknown'})
        self.remote(market.web_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        self.phase = 'reopened'
        self.save('phase.json',{'phase':self.phase,'ingress':'open'})
        mounts = json.loads(self.remote('docker inspect --format '+quote('{{json .Mounts}}')+' '+market.GATEWAY))
        mounted = {row['Destination']:row['Source'] for row in mounts}
        public = f'{REMOTE}/public-https/releases/{self.sha}/infra/public-staging'
        require(mounted.get('/etc/caddy/Caddyfile') == public+'/gateway.Caddyfile' and mounted.get('/srv/public') == public+'/public-web', 'Actual gateway mounts differ')
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] == proof['gateway_sha256'], 'Mounted gateway differs')
        require(self.http_json('/v1/capabilities') == caps, 'Public capabilities differ')
        self.verify_public()
        require(self.fingerprint() == before['neighbors'], 'Neighbors changed after reopening')
        self.cleanup('release')
        self.phase = 'complete'
        self.save('phase.json',{'phase':self.phase,'ingress':'open'})
        self.save('result.json',{'source_sha':self.sha,'migration_files':43,'last_migration':44,'qr_worker_enabled':False,'enrollment_only':True,'backoffice_updated':False,'non_backoffice_assets_preserved':True,'runtime_acl_verified':True,'worker_preserved':True,'old_image_compatible':True,'backup':backup})
        print('Published independent kiosk QR API and worker; existing bank bridge and public assets preserved',flush=True)


    def rollback_closed(self):
        self.source_checks(); self.ci()
        require(hasattr(self,'maintenance') and hasattr(self,'lock_owner'), 'Original owner maintenance context required')
        before = json.loads((self.private/'before.json').read_text()); proof = json.loads((self.private/'prepared.json').read_text())
        require(self.rollback_artifacts() == proof['rollback_files'], 'Rollback artifacts changed')
        self.cleanup('status')
        require(self.http('/v1/test/orders',method='POST')[0] == 503, 'Rollback requires retained maintenance')
        self.remote(market.api_compose(self.sha)+' stop --timeout 30 api',timeout=60)
        self.quiescent()
        retained_ledger,retained_runtime = self.retained_rollback_snapshot(before)
        self.switch_worker(False)
        require(self.worker_acl() == before['worker_acl'] and self.fingerprint() == before['neighbors'], 'Worker or neighbor changed')
        self.psql(market.DB,market.acl_restore_sql(before['acl'],self.acl()))
        require(self.acl() == before['acl'], 'Old ACL not restored exactly')
        self.remote(market.api_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'], 'Old API incompatible with retained schema045')
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER) == proof['artifacts']['rollback_image_id'], 'Rollback image changed')
        self.verify_capabilities(self.http_json('/v1/capabilities',public=False))
        self.verify_environment(proof['baseline_environment'])
        require(self.ledger() == retained_ledger, 'Rollback changed retained migration ledger')
        market.compare_existing(retained_runtime,self.runtime_snapshot())
        for path,old,new in [(REMOTE+'/current',REMOTE+'/releases/'+BASELINE,REMOTE+'/releases/'+self.sha),
                (REMOTE+'/public-https/current',REMOTE+'/public-https/releases/'+BASELINE,REMOTE+'/public-https/releases/'+self.sha)]:
            actual = self.remote('readlink -f '+path)
            require(actual in [old,new], 'Concurrent pointer change; inspect before rollback')
            if actual == new: self.switch(path,new,old)
        self.phase = 'rollback_reopening'
        self.save('phase.json',{'phase':self.phase,'ingress':'unknown'})
        self.remote(market.web_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        self.phase = 'rollback_reopened'
        self.save('phase.json',{'phase':self.phase,'ingress':'open'})
        require(self.fingerprint() == before['neighbors'], 'Neighbor changed during rollback')
        self.cleanup('release')
        self.save('rollback.json',{'migration_files_retained':len(retained_ledger),'last_migration_retained':retained_ledger[-1]['version'],'acl_restored':True,'live_dump_restored':False,'finance_data_erased':False,'qr_worker_enabled':True})

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
