#!/usr/bin/env python3
"""Guarded finance ledger schema038 ->039/040/042 (41 files); payment features unchanged.

Requires Python 3.12, exact green CI, owned maintenance, encrypted backup/restore,
immutable artifacts, append-only finance grants and pointer CAS. No live charge,
provider account creation, worker installation, seed or live database restoration.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import tarfile
import uuid

spec = importlib.util.spec_from_file_location('finance_farm_base', Path(__file__).with_name('release-farm-pilot.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, transport, director = base.market, base.transport, base.director
require, quote, digest, REMOTE = market.require, market.quote, market.digest, market.REMOTE
file_writer_program = base.file_writer_program
release_env_program = base.release_env_program
gateway_validation_command = base.gateway_validation_command
BASELINE = '850c6fa5a39296f78e29ff56e2a8b8c78a7137cc'
PUBLIC_BASELINE = '850c6fa5a39296f78e29ff56e2a8b8c78a7137cc'
GATEWAY_BASELINE = '64366439f95f6bba265208f84c47ffcbc090920540dd2055f8bb88491c17f0bd'
COMPOSE_BASELINE = '15f7d29229f5e119250f7893479a08e128778b16c905a523492223b08e3c2071'
MIGRATION_HASHES = {
    '039_cloud_tiptoppay_checkout.sql': '1f7b924b1af678c0f704703119d26d56ad493503e970c03f7175337aef10bfba',
    '040_cloud_tiptoppay_test_checkout.sql': 'c2f308086bf665a504e286e15e3d8dde73dae5217d004f043f3a066bac66219b',
    '042_cloud_finance.sql': 'a1554e3dc90d775d1c899d612fbec46addb8073eac39f034297e09e5aa59113b',
}
PAYMENT_TABLES = {'commerce_checkout_payment_methods','commerce_tiptoppay_sessions','commerce_tiptoppay_test_payments'}
FINANCE_TABLES = {'bo_finance_accounts','bo_finance_entries','bo_finance_voids','bo_finance_commands','bo_finance_periods'}
NEW_TABLES = PAYMENT_TABLES | FINANCE_TABLES
FINANCE_OBJECTS = 'bo_finance_accounts,bo_finance_entries,bo_finance_voids,bo_finance_commands,bo_finance_periods'
FINANCE_GRANTS = 'GRANT SELECT,INSERT ON '+FINANCE_OBJECTS+' TO pickchick_app;GRANT UPDATE(closed,revision) ON bo_finance_periods TO pickchick_app;'
FINANCE_HELPER_SHA256 = 'f88ebf5864411167dd5d7805cab7979df8e4c2817e1d1934dabc9624e31e90c2'


def verify_manifest(before,after,sha):
    require(after['source_sha'] == sha and after.get('component_sources',{}).get('backoffice') == sha, 'Backoffice provenance differs')
    require({k:v for k,v in before['files'].items() if not k.startswith('backoffice/')} ==
            {k:v for k,v in after['files'].items() if not k.startswith('backoffice/')}, 'Non-backoffice files changed')
    require({k:v for k,v in before.get('component_sources',{}).items() if k != 'backoffice'} ==
            {k:v for k,v in after.get('component_sources',{}).items() if k != 'backoffice'}, 'Other component provenance changed')
    require({k:v for k,v in before.items() if k not in ['source_sha','files','component_sources']} ==
            {k:v for k,v in after.items() if k not in ['source_sha','files','component_sources']}, 'Other public metadata changed')
    require(all('backoffice/'+name in after['files'] for name in ['app.js','operations.js','domain.js','index.html','finance.js']), 'Backoffice bundle incomplete')


def compose_candidate(raw):
    require(digest(raw.encode()) == COMPOSE_BASELINE, 'Unreviewed installed compose')
    require('TIPTOPPAY' not in raw and raw.count('      CATALOG_MOBILE_STOREFRONT_ENABLED: "true"') == 1,
            'Unreviewed payment/storefront environment')
    return raw


def gateway_candidate(raw):
    require(digest(raw.encode()) == GATEWAY_BASELINE, 'Unreviewed gateway baseline')
    old_get = r'(/orders/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?$'
    old_post = r'[0-9a-fA-F]{12}/commands$'
    require(raw.count(old_get) == 1 and raw.count(old_post) == 1 and '/finance' not in raw,
            'Finance route boundary differs')
    result = raw.replace(old_get,old_get.replace('(/orders','(/finance|/orders'),1)
    result = result.replace(old_post,old_post.replace('/commands','(/finance)?/commands'),1)
    require(result.replace('/finance|','',1).replace('(/finance)?','',1) == raw,
            'Existing gateway routes changed')
    return result


def owner_migration_program():
    return """import {createPool,migrate,transaction} from '@pickchick/database';
const url=new URL(process.env.CLOUD_DATABASE_URL);
if(url.username!=='pickchick_owner'||url.pathname!=='/pickchick_cloud')throw new Error('Owner database required');
const pool=createPool(url.href);
try{await migrate(pool,'/app/db/cloud/migrations','cloud');
await transaction(pool,c=>c.query("""+json.dumps(FINANCE_GRANTS)+"""));
console.log(JSON.stringify({migrationFiles:41,lastMigration:42,financeGrants:true}));}finally{await pool.end();}"""


class Release(base.Release):
    additions = {}
    snapshot = market.Release.snapshot
    baseline_migrations = market.Release.baseline_migrations
    def __init__(self,args):
        require(sys.version_info >= (3,12), 'Python 3.12 required for PostgreSQL timestamps')
        require((args.expected_api_sha,args.expected_public_sha,args.expected_gateway_sha256) ==
                (BASELINE,PUBLIC_BASELINE,GATEWAY_BASELINE), 'Unreviewed finance baseline')
        self.baseline_schema = 38
        profile = market.ReleaseProfile('finance-ledger-schema042',BASELINE,PUBLIC_BASELINE,38,
            tuple(MIGRATION_HASHES),base.CI_JOBS,frozenset(),'finance-ledger-release',(),exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)

    def source_checks(self):
        market.Release.source_checks(self)
        require(all(digest((market.REPO/'db/cloud/migrations'/n).read_bytes()) == h
            for n,h in MIGRATION_HASHES.items()), 'Unreviewed prerequisite or finance migration')
        require(digest((market.REPO/'infra/staging/backoffice-grants.mjs').read_bytes()) == FINANCE_HELPER_SHA256,
                'Unreviewed finance permission helper')
        program = "import {backofficeGrants} from './infra/staging/backoffice-grants.mjs';process.stdout.write(backofficeGrants('pickchick_app',true))"
        helper = self.execute(['node','--input-type=module','-e',program]).decode()
        require(helper.startswith("DO $finance$ BEGIN IF to_regclass('bo_finance_entries') IS NOT NULL THEN REVOKE ALL ON "+FINANCE_OBJECTS+" FROM pickchick_app;"+FINANCE_GRANTS+" END IF; END $finance$;"),
                'Finance delta differs from reviewed helper')

    def web_manifest_source(self): return 'e236824b80ee315eae48c371d722f4f6459aac8c'

    def runtime_old(self):
        market.Release.runtime_old(self)
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] == GATEWAY_BASELINE, 'Gateway changed')
        require(self.file_hashes([REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml']) ==
            {REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml':COMPOSE_BASELINE}, 'API compose changed')
        require(self.ledger() == [{'version':n,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in self.baseline_migrations()], 'Baseline schema changed')
        require(not any(k.startswith('TIPTOPPAY_') for k in self.runtime_environment()), 'TipTopPay already configured')

    def compare_runtime(self,before):
        base.verify_availability(before['availability'],self.availability_rows())
        market.compare_existing(before['runtime_data'],self.runtime_snapshot(),additions=True,new_tables=NEW_TABLES)

    def verify_data(self,before):
        require(self.ledger() == before['ledger']+[{'version':n,'scope':'cloud','checksum':h} for n,h in MIGRATION_HASHES.items()], 'Migration ledger differs')
        self.compare_runtime(before)
        wanted = before['acl']+[{'name':name,'kind':'r','column':None,'privilege':p,'grantable':False} for name in FINANCE_TABLES for p in ['SELECT','INSERT']]
        wanted += [{'name':'bo_finance_periods','kind':'r','column':column,'privilege':'UPDATE','grantable':False} for column in ['closed','revision']]
        key = lambda row:(row['name'],row['kind'],row['column'] or '',row['privilege'],row['grantable'])
        require(sorted(map(key,self.acl())) == sorted(map(key,wanted)), 'Only append-only finance permission delta allowed')
        require(self.worker_acl() == before['worker_acl'], 'Kaspi worker permissions changed')
        require(all(self.psql(market.DB,'SELECT count(*) FROM '+n) == '0' for n in NEW_TABLES), 'All new finance/payment tables must stay empty during rollout')

    def retained_rollback_snapshot(self,before):
        ledger = self.ledger()
        additions = [{'version':n,'scope':'cloud','checksum':h} for n,h in MIGRATION_HASHES.items()]
        require(len(before['ledger']) <= len(ledger) <= len(before['ledger'])+len(additions) and
                ledger == before['ledger']+additions[:len(ledger)-len(before['ledger'])],
                'Rollback ledger is not an exact reviewed migration prefix')
        applied = {row['version'] for row in ledger[len(before['ledger']):]}
        expected_new = set()
        if '039_cloud_tiptoppay_checkout.sql' in applied:
            expected_new |= {'commerce_checkout_payment_methods','commerce_tiptoppay_sessions'}
        if '040_cloud_tiptoppay_test_checkout.sql' in applied:
            expected_new.add('commerce_tiptoppay_test_payments')
        if '042_cloud_finance.sql' in applied: expected_new |= FINANCE_TABLES
        current = self.runtime_snapshot()
        require(set(current['tables'])-set(before['runtime_data']['tables']) == expected_new,
                'Rollback schema differs from retained migration prefix')
        require(all(current['tables'][name]['rows'] == 0 for name in expected_new & PAYMENT_TABLES),
                'Disabled payment prerequisites acquired data')
        # Retain journal rows written after reopening; compare all pre-existing money
        # and domain tables without erasing or importing any new finance rows.
        augmented = {**before['runtime_data'],'tables':{**before['runtime_data']['tables'],
                    **{name:current['tables'][name] for name in expected_new}}}
        base.verify_availability(before['availability'],self.availability_rows())
        market.compare_existing(augmented,current,additions=True,new_tables=set())
        return ledger,current

    def verify_environment(self,before):
        after = self.runtime_environment()
        require({k:v for k,v in after.items() if k != 'RELEASE_SHA'} ==
                {k:v for k,v in before.items() if k != 'RELEASE_SHA'}, 'Existing API environment changed')

    def prepared_artifacts(self,manifest):
        result = base.Release.prepared_artifacts(self,manifest)
        old = json.loads(self.remote('docker image inspect --format '+quote('{{json .}}')+' pickchick-api:'+BASELINE))
        require(old['Config']['Labels']['org.opencontainers.image.revision'] == BASELINE, 'Rollback image revision differs')
        result['rollback_image_id'] = old['Id']
        return result

    def verify_public(self):
        proof = json.loads((self.private/'prepared.json').read_text())
        require(self.http_json('/v1/auth/config') == proof['baseline_auth'], 'Auth policy changed')
        require(self.http_json('/v1/customer-checkout/availability').get('hours') == proof['baseline_hours'], 'Kaspi checkout hours changed')
        require(self.http_json('/kitchen-live/health')['sourceSha'] == proof['kitchen_sha'], 'Kitchen bridge changed')
        actual = json.loads(self.remote('docker exec '+market.GATEWAY+' cat /srv/public/.release.json'))
        require(proof['public_manifest'] == actual, 'Published manifest differs')
        require(self.prepared_artifacts(actual) == proof['artifacts'], 'Prepared/public artifacts changed')
        code,body = self.http('/backoffice/finance.js')
        require(code == 200 and digest(body) == actual['files']['backoffice/finance.js'], 'Published finance bundle differs')
        branch = '/v1/admin/backoffice/branches/7a6f6d98-395d-4462-b5e4-b0364a4a8ec1/finance'
        require(self.http(branch)[0] == 401, 'Anonymous finance read accepted or route unavailable')
        require(self.http(branch+'/commands',method='POST')[0] == 401, 'Anonymous finance command accepted or route unavailable')
        for path,method in [('/v1/customer-checkout/test-payments','POST'),('/v1/integrations/tiptoppay/test-checkout','GET'),('/v1/integrations/tiptoppay/checkout','GET')]:
            require(self.http(path,method=method)[0] == 404, 'Payment feature route exposed')
        require(self.http_json('/v1/customer-checkout/catalog') == proof['baseline_catalog'], 'Mobile catalog changed')

    def prepare(self):
        self.source_checks(); self.ci(); self.runtime_old()
        require(not (self.private/'prepared.json').exists(), 'Preparation already exists')
        old = f'{REMOTE}/public-https/releases/{PUBLIC_BASELINE}/infra/public-staging'
        old_gateway = self.remote('cat '+quote(old+'/gateway.Caddyfile'))+'\n'
        gateway = gateway_candidate(old_gateway)
        compose = compose_candidate(self.remote('cat '+quote(REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml'))+'\n')
        self.kitchen_before = self.http_json('/kitchen-live/health')
        rollback = self.rollback_artifacts()
        archive = self.execute(['git','archive','--format=tar',self.sha,*market.ARCHIVE_PATHS])
        target = REMOTE+'/releases/'+self.sha
        self.remote(f'test ! -e {target} && mkdir {target} && tar -xf - -C {target}',input=archive,timeout=180)
        self.remote('python3 -c '+quote(release_env_program())+' '+' '.join(map(quote,[REMOTE+'/releases/'+BASELINE+'/release.env',target+'/release.env',self.sha,BASELINE])))
        writer = file_writer_program()
        self.remote('python3 -c '+quote(writer)+' '+quote(target+'/infra/staging/compose.yaml'),input=compose)
        self.remote('! docker image inspect pickchick-api:'+self.sha+' >/dev/null 2>&1')
        image = self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} -t pickchick-api:{self.sha} .',timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}',image), 'Invalid immutable API image')
        new = f'{REMOTE}/public-https/releases/{self.sha}/infra/public-staging'
        self.remote(f'test ! -e {REMOTE}/public-https/releases/{self.sha} && mkdir -p {new} && cp -a {old}/. {new}/',timeout=180)
        web_compose = json.loads(self.remote(market.web_compose(PUBLIC_BASELINE)+' config --format json'))
        relocated = director.relocate_public_mounts(web_compose,old,new)
        self.remote('python3 -c '+quote(writer)+' '+quote(new+'/compose.yaml'),input=json.dumps(relocated))
        self.remote('python3 -c '+quote(file_writer_program(public_gateway=True))+' '+quote(new+'/gateway.Caddyfile'),input=gateway)
        previous = json.loads(self.remote('cat '+quote(old+'/public-web/.release.json')))
        self.execute(['corepack','pnpm','--filter','@pickchick/backoffice...','build'],timeout=180)
        bundle = self.private/'backoffice.tar'
        with tarfile.open(bundle,'w') as tar:
            for file in (market.REPO/'apps/backoffice/dist').rglob('*'):
                require(not file.is_symlink(), 'Backoffice build contains symlink')
                if file.is_file():tar.add(file,arcname='backoffice/'+str(file.relative_to(market.REPO/'apps/backoffice/dist')))
        # Replace only the BO directory inside this newly created immutable public release.
        remover = "from pathlib import Path;import shutil,sys;p=Path(sys.argv[1]);assert not p.is_symlink() and p.name=='backoffice';shutil.rmtree(p)"
        self.remote('python3 -c '+quote(remover)+' '+quote(new+'/public-web/backoffice'))
        self.remote('tar -xf - -C '+quote(new+'/public-web'),input=bundle.read_bytes(),timeout=180)
        updater = r'''from pathlib import Path
import json,hashlib,sys
root=Path(sys.argv[1]);sha=sys.argv[2];p=root/'public-web/.release.json'
m=json.loads(p.read_text());m['files']={k:v for k,v in m['files'].items() if not k.startswith('backoffice/')};m['source_sha']=sha
m.setdefault('component_sources',{})['backoffice']=sha
for f in (root/'public-web/backoffice').rglob('*'):
 assert not f.is_symlink()
 if f.is_file():
  f.chmod(0o644);m['files'][str(f.relative_to(root/'public-web'))]=hashlib.sha256(f.read_bytes()).hexdigest()
 elif f.is_dir():f.chmod(0o755)
p.write_text(json.dumps(m,indent=2)+'\n');p.chmod(0o644)
print(json.dumps(m))
'''
        manifest = json.loads(self.remote('python3 -c '+quote(updater)+' '+quote(new)+' '+quote(self.sha)))
        verify_manifest(previous,manifest,self.sha)
        self.remote(market.api_compose(self.sha)+' config --quiet')
        self.remote(market.web_compose(self.sha)+' config --quiet')
        self.remote(gateway_validation_command(new+'/gateway.Caddyfile'))
        prepared = {'sha':self.sha,'old_web':PUBLIC_BASELINE,'old_api':BASELINE,'image_id':image,'public_manifest':manifest,
            'gateway_sha256':digest(gateway.encode()),'rollback_files':rollback,
            'baseline_capabilities':self.http_json('/v1/capabilities',public=False),'baseline_auth':self.http_json('/v1/auth/config'),
            'baseline_schema':self.baseline_schema, 'kitchen_sha':self.kitchen_before['sourceSha'],
            'baseline_catalog':self.http_json('/v1/customer-checkout/catalog'),
            'baseline_hours':self.http_json('/v1/customer-checkout/availability').get('hours'), 'baseline_environment':self.runtime_environment()}
        prepared['artifacts'] = self.prepared_artifacts(manifest)
        require(prepared['artifacts']['image_id'] == image and self.rollback_artifacts() == rollback, 'Preparation drift')
        self.save('prepared.json',prepared)
        print('Prepared finance ledger API, backoffice and gateway; active services unchanged',flush=True)

    def apply(self):
        self.source_checks(); self.ci(); self.runtime_old()
        proof = json.loads((self.private/'prepared.json').read_text())
        require((proof['sha'],proof['old_api'],proof['old_web']) == (self.sha,BASELINE,PUBLIC_BASELINE), 'Wrong preparation')
        require(proof.get('baseline_schema',33) == self.baseline_schema, 'Prepared baseline schema differs')
        require(self.prepared_artifacts(proof['public_manifest']) == proof['artifacts'] and
                self.rollback_artifacts() == proof['rollback_files'], 'Prepared or rollback artifacts changed')
        key = self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0, 'Protected backup identity required')
        require(self.runtime_environment() == proof['baseline_environment'], 'Baseline running environment changed')
        self.maintenance = REMOTE+'/maintenance/finance-ledger-'+self.lock_owner['id']
        contents = {'owner.json':json.dumps(self.lock_owner),'maintenance.json':json.dumps(transport.maintenance_config()),'compose.json':json.dumps(transport.maintenance_overlay(self.maintenance))}
        self.remote('python3 -c '+quote(transport.maintenance_write_script())+' '+quote(self.maintenance),input=json.dumps(contents))
        self.remote(transport.caddy_validation_command(self.maintenance+'/maintenance.json'))
        self.cleanup('acquire')
        self.remote(market.web_compose(PUBLIC_BASELINE)+' -f '+quote(self.maintenance+'/compose.json')+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        require(self.http('/v1/test/orders',method='POST')[0] == 503, 'Ingress did not close')
        self.remote(market.api_compose(BASELINE)+' stop --timeout 30 api',timeout=60)
        require(self.psql(market.DB,"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND (usename='pickchick_app' OR xact_start IS NOT NULL)") == '0', 'Competing database writer')
        self.quiescent()
        before = {'data':self.snapshot(),'runtime_data':self.runtime_snapshot(),'availability':self.availability_rows(),'ledger':self.ledger(),'acl':self.acl(),'worker_acl':self.worker_acl(),'neighbors':self.fingerprint()}
        expected = [{'version':name,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/name).read_bytes())} for name in self.baseline_migrations()]
        require(before['ledger'] == expected, 'Baseline migration ledger differs')
        self.save('before.json',before)
        backup = self.backup_restore(before['data']); self.save('backup.json',backup)
        for _ in range(2):
            self.cleanup('status'); self.quiescent()
            self.remote(market.api_compose(self.sha)+' run --rm --no-deps --entrypoint node provision --input-type=module -e '+quote(owner_migration_program()),timeout=180)
            self.verify_data(before)
        # Retain schema042 (41 files) on rollback; run old API only, never old provision.
        self.remote(market.api_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'], 'Old image incompatible with retained schema042 (41 files)')
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER) == proof['artifacts']['rollback_image_id'], 'Old compatibility image differs')
        self.verify_environment(proof['baseline_environment'])
        self.verify_capabilities(self.http_json('/v1/capabilities',public=False))
        self.verify_data(before)
        self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'], 'Candidate API not ready')
        caps = self.http_json('/v1/capabilities',public=False); self.verify_capabilities(caps)
        self.verify_environment(proof['baseline_environment']); self.verify_data(before)
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER) == proof['image_id'], 'Running image differs')
        require(self.fingerprint() == before['neighbors'] and self.prepared_artifacts(proof['public_manifest']) == proof['artifacts'], 'Neighbor or prepared artifacts changed')
        self.switch(REMOTE+'/current',REMOTE+'/releases/'+BASELINE,REMOTE+'/releases/'+self.sha)
        self.switch(REMOTE+'/public-https/current',REMOTE+'/public-https/releases/'+PUBLIC_BASELINE,REMOTE+'/public-https/releases/'+self.sha)
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
        self.save('result.json',{'source_sha':self.sha,'migration_files':41,'last_migration':42,'tiptoppay_enabled':False,'backoffice_updated':True,'non_backoffice_assets_preserved':True,'runtime_acl_verified':True,'worker_preserved':True,'old_image_compatible':True,'backup':backup})
        print('Published finance ledger API, backoffice and bounded gateway; other public assets preserved',flush=True)

    def retain_failure(self, error):
        phase = getattr(self,'phase','before_reopening')
        ingress = 'unknown'
        reclosed = False
        if phase in ['reopening','reopened','rollback_reopening','rollback_reopened'] and not isinstance(error,market.CommandUncertain):
            try:
                self.cleanup('status')
                web_sha = PUBLIC_BASELINE if phase.startswith('rollback_') else self.sha
                self.remote(market.web_compose(web_sha)+' -f '+quote(self.maintenance+'/compose.json')+
                    ' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
                require(self.http('/v1/test/orders',method='POST')[0] == 503,'Failure maintenance did not close ingress')
                ingress, reclosed = 'closed', True
            except Exception:
                # Never claim a failed/uncertain reclose succeeded or start a rollback.
                ingress = 'unknown'
        elif hasattr(self,'maintenance'):
            ingress = 'unknown' if isinstance(error,market.CommandUncertain) else 'maintenance_expected'
        self.save('failure-context.json',{'phase':phase,'ingress':ingress,'maintenance_reclosed':reclosed,
            'automatic_rollback_started':False,'deployment_lock_retained':True})
        return ingress

    def resume_owned_rollback(self):
        require(self.args.owner_id and str(uuid.UUID(self.args.owner_id)) == self.args.owner_id,
                'Original owner UUID required for rollback')
        owner_path = self.private/('lock-owner-'+self.args.owner_id+'.json')
        require(owner_path.is_file() and not owner_path.is_symlink() and owner_path.stat().st_mode & 0o077 == 0,
                'Protected original local owner evidence required')
        owner = json.loads(owner_path.read_text())
        require(owner == {'id':self.args.owner_id,'sha':self.sha,'action':'apply'}, 'Original apply owner evidence differs')
        actual = json.loads(self.remote('cat '+quote(market.DEPLOY_LOCK+'/owner.json')))
        require(actual == owner, 'Retained deployment lock belongs to another operation')
        self.lock_owner = owner
        self.maintenance = REMOTE+'/maintenance/finance-ledger-'+owner['id']
        require(json.loads(self.remote('cat '+quote(self.maintenance+'/owner.json'))) == owner,
                'Maintenance directory belongs to another operation')
        self.cleanup('status')
        self.source_checks(); self.ci()
        proof = json.loads((self.private/'prepared.json').read_text())
        require((proof['sha'],proof['old_api'],proof['old_web']) == (self.sha,BASELINE,PUBLIC_BASELINE), 'Wrong retained preparation')
        require(self.rollback_artifacts() == proof['rollback_files'], 'Rollback artifacts changed')
        # Explicit operator rollback re-closes ingress before inspecting any data.
        self.phase = 'rollback_closing'
        self.remote(market.web_compose(self.sha)+' -f '+quote(self.maintenance+'/compose.json')+
            ' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        require(self.http('/v1/test/orders',method='POST')[0] == 503,'Rollback maintenance not closed')
        self.rollback_closed()
        release_lock = """import json,os,sys
path,owner=sys.argv[1:]
assert json.load(open(path+'/owner.json'))['id']==owner
os.unlink(path+'/owner.json');os.rmdir(path)
"""
        self.remote('python3 -c '+quote(release_lock)+' '+quote(market.DEPLOY_LOCK)+' '+quote(owner['id']))

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
        require(self.worker_acl() == before['worker_acl'] and self.fingerprint() == before['neighbors'], 'Worker or neighbor changed')
        self.psql(market.DB,market.acl_restore_sql(before['acl'],self.acl()))
        require(self.acl() == before['acl'], 'Old ACL not restored exactly')
        self.remote(market.api_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'], 'Old API incompatible with retained schema042 (41 files)')
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER) == proof['artifacts']['rollback_image_id'], 'Rollback image changed')
        self.verify_capabilities(self.http_json('/v1/capabilities',public=False))
        self.verify_environment(proof['baseline_environment'])
        require(self.ledger() == retained_ledger, 'Rollback changed retained migration ledger')
        market.compare_existing(retained_runtime,self.runtime_snapshot())
        for path,old,new in [(REMOTE+'/current',REMOTE+'/releases/'+BASELINE,REMOTE+'/releases/'+self.sha),
                (REMOTE+'/public-https/current',REMOTE+'/public-https/releases/'+PUBLIC_BASELINE,REMOTE+'/public-https/releases/'+self.sha)]:
            actual = self.remote('readlink -f '+path)
            require(actual in [old,new], 'Concurrent pointer change; inspect before rollback')
            if actual == new: self.switch(path,new,old)
        self.phase = 'rollback_reopening'
        self.save('phase.json',{'phase':self.phase,'ingress':'unknown'})
        self.remote(market.web_compose(PUBLIC_BASELINE)+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        self.phase = 'rollback_reopened'
        self.save('phase.json',{'phase':self.phase,'ingress':'open'})
        require(self.fingerprint() == before['neighbors'], 'Neighbor changed during rollback')
        self.cleanup('release')
        self.save('rollback.json',{'migration_files_retained':len(retained_ledger),'last_migration_retained':retained_ledger[-1]['version'],'acl_restored':True,'live_dump_restored':False,'finance_data_erased':False})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['prepare','apply','rollback'])
    for name in ['sha','branch','expected-api-sha','expected-public-sha','expected-gateway-sha256']:
        parser.add_argument('--'+name,required=True)
    for name in ['ssh-key','backup-identity','ci-proof']:
        parser.add_argument('--'+name,type=Path,required=name == 'ssh-key')
    parser.add_argument('--ci-run')
    parser.add_argument('--owner-id')
    args = parser.parse_args(); release = Release(args)
    try:
        if args.action == 'rollback': release.resume_owned_rollback()
        else:
            require(args.owner_id is None,'Owner UUID is rollback-only')
            with release.deployment_lock(): getattr(release,args.action)()
    except Exception as error:
        release.record_error(error)
        ingress = release.retain_failure(error)
        reason = str(error) if isinstance(error,market.GuardFailure) else 'Stopped; private diagnostics retained.'
        print(reason+' Deployment lock retained; ingress: '+ingress+'.',file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__': main()
