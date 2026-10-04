#!/usr/bin/env python3
"""Guarded first farm pilot: installed schema033 -> reviewed034-038 and API farm flag.

Preserves all public assets/manifest, checkout/auth flags, worker and unrelated ACL.
No automatic rollback, destructive migration reversal or live-dump restore. Any
failure retains owned maintenance and locks for inspection and explicit rollback.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import uuid

spec = importlib.util.spec_from_file_location('farm_director_base', Path(__file__).with_name('release-director-console.py'))
director = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = director
spec.loader.exec_module(director)
market, transport = director.market, director.transport
require, quote, digest, REMOTE = market.require, market.quote, market.digest, market.REMOTE
BASELINE = 'e236824b80ee315eae48c371d722f4f6459aac8c'
PUBLIC_BASELINE = '9bb92b9eaf9bd46c9459664384af652cc2426fdf'
GATEWAY_BASELINE = '381b7a17d707d54a72053fd13a882ceffea1e7203a0ab70aae1ae6f962520e17'
COMPOSE_BASELINE = '0e4dc2823261f5153c91aad0ce4052a055a29e50f81bd10b2f47af2bf5f7ebb1'
MIGRATION_HASHES = {
    '034_cloud_catalog_menu_delivery.sql': '647de8d40b6e8547f1f66bedde95d1145ccb93743c2ccbe1872806768aded2cd',
    '035_cloud_kiosk_sessions.sql': 'd57394b0dd82a4aaf0b059e660dc3183b24e236141e6e10523ee3649391d4c2c',
    '036_cloud_kiosk_commerce.sql': '54f8a12127812176bcd3ef3d9363d7978b7d8223b1c79af39ff7472d422a13f7',
    '037_cloud_farm.sql': '07eeee827a6540c951aef7574d0a1e766e5a4d310755443c8748f4cca7d158a3',
    '038_cloud_farm_field_capacity.sql': '70c7e5442b92b6c104caac0d9bda2c1f88fd8f344d7190d606e8ef798b0a6c0b',
}
NEW_TABLES = {'catalog_menu_deliveries', 'kiosk_devices', 'kiosk_sessions', 'customer_farms', 'customer_farm_commands'}
FARM_TABLES = {'customer_farms', 'customer_farm_commands'}
CI_JOBS = director.CI_JOBS
FARM_PATHS = '/v1/customer-farm /v1/customer-farm/commands '
FARM_GRANTS = '''REVOKE ALL ON customer_farms, customer_farm_commands FROM pickchick_app;
GRANT SELECT, INSERT, UPDATE ON customer_farms TO pickchick_app;
GRANT SELECT, INSERT ON customer_farm_commands TO pickchick_app;
GRANT SELECT(id, deleted_at), UPDATE(id) ON identity_customers TO pickchick_app;'''


def compose_candidate(raw):
    require(digest(raw.encode()) == COMPOSE_BASELINE, 'Unreviewed installed API compose')
    require(raw.count('  api:\n') == 1 and raw.count('  provision:\n') == 1 and 'FARM_ENABLED' not in raw,
            'Ambiguous API/provision boundary or farm already configured')
    start, end = raw.index('  api:\n'), raw.index('  provision:\n')
    require(start < end, 'API service boundary differs')
    api = raw[start:end]
    require(api.count('      APP_ENV: staging') == 1, 'API environment anchor differs')
    updated = api.replace('      APP_ENV: staging', '      FARM_ENABLED: "1"\n      APP_ENV: staging', 1)
    return raw[:start] + updated + raw[end:]


def farm_gateway_block():
    text = (market.REPO/'infra/public-staging/gateway.Caddyfile').read_text()
    start, end = '\t@farm_preflight {', '\t@catalog_admin_get {'
    require(text.count(start) == 1 and text.count(end) == 1, 'Canonical farm route boundaries differ')
    block = text[text.index(start):text.index(end)]
    require(block.count('\t@farm_get {') == 1 and block.count('\t@farm_post {') == 1 and
            block.count('reverse_proxy pickchick-staging-api-1:3100') == 2 and
            block.count('header_up -Cookie') == 2 and block.count('header_up -X-Device-Id') == 2 and
            'header_up -Authorization' not in block and 'path_regexp' not in block and
            'path /v1/customer-farm\n' in block and 'path /v1/customer-farm/commands\n' in block and
            'method GET' in block and 'method POST' in block and 'method OPTIONS' in block,
            'Canonical farm routes differ from bounded customer API contract')
    return block


def gateway_candidate(text):
    require(digest(text.encode()) == GATEWAY_BASELINE, 'Installed gateway baseline differs')
    anchor = '\t@catalog_admin_get {'
    require(text.count(anchor) == 1 and '/v1/customer-farm' not in text and '@farm_' not in text,
            'Farm gateway already configured or insertion boundary differs')
    matches = re.findall(r'(\t@synthetic_surfaces \{\n\t\tnot path )([^\n]+)(\n\t\})', text)
    require(len(matches) == 1, 'Synthetic data header boundary differs')
    prefix, paths, suffix = matches[0]
    old_header, new_header = prefix + paths + suffix, prefix + FARM_PATHS + paths + suffix
    block = farm_gateway_block()
    candidate = text.replace(old_header, new_header, 1).replace(anchor, block + anchor, 1)
    require(candidate.replace(block, '', 1).replace(new_header, old_header, 1) == text,
            'Existing gateway routing/CORS changed')
    return candidate


def verify_manifest(before, after):
    require(before == after, 'Farm pilot must preserve entire public manifest and all asset hashes')


def verify_farm_acl(before, after):
    require(not any(row['name'] in FARM_TABLES for row in before), 'Farm permissions already exist in baseline')
    wanted = list(before)
    for name, privileges in [('customer_farms', ['SELECT','INSERT','UPDATE']), ('customer_farm_commands',['SELECT','INSERT'])]:
        wanted += [{'name':name,'kind':'r','column':None,'privilege':p,'grantable':False} for p in privileges]
    for column, privilege in [('id','SELECT'), ('deleted_at','SELECT'), ('id','UPDATE')]:
        row = {'name':'identity_customers','kind':'r','column':column,'privilege':privilege,'grantable':False}
        if row not in wanted: wanted.append(row)
    key = lambda row: (row['name'],row['kind'],row['column'] or '',row['privilege'],row['grantable'])
    require(sorted(map(key,after)) == sorted(map(key,wanted)), 'Runtime ACL differs from exact farm-only delta')


def release_env_program():
    # The inherited historical generator used literal backslash-n delimiters.
    return r'''from pathlib import Path
import sys
old,new,sha,old_sha=sys.argv[1:]
lines=Path(old).read_text().splitlines()
assert lines.count('RELEASE_SHA='+old_sha)==1
lines=[line for line in lines if not line.startswith('RELEASE_SHA=')]
with open(new,'x') as output:
 Path(new).chmod(0o600)
 output.write('\n'.join(lines+['RELEASE_SHA='+sha])+'\n')
'''


def owner_migration_program():
    # Deliberately bypass full provision.mjs; it rewrites unrelated runtime ACL.
    return '''import {createPool,migrate,transaction} from '@pickchick/database';
import {farmGrants} from './infra/staging/farm-grants.mjs';
const url=new URL(process.env.CLOUD_DATABASE_URL);
if(url.username!=='pickchick_owner'||url.pathname!=='/pickchick_cloud')throw new Error('Owner database required');
const pool=createPool(url.href);
try{
 await migrate(pool,'/app/db/cloud/migrations','cloud');
 await transaction(pool,c=>c.query(farmGrants('pickchick_app',true)));
 console.log(JSON.stringify({schema:38,farmGrants:true}));
}finally{await pool.end();}'''


class Release(director.Release):
    additions = {'branches': ['menu_publication_lock_anchor']}
    snapshot = director.base.base.pilot.Release.snapshot
    checkout_file = REMOTE + '/secrets/customer-kaspi-all.env'

    def __init__(self, args):
        require((args.expected_api_sha,args.expected_public_sha,args.expected_gateway_sha256) ==
                (BASELINE,PUBLIC_BASELINE,GATEWAY_BASELINE), 'Unreviewed farm pilot baseline')
        profile = market.ReleaseProfile('farm-pilot-schema033-038', BASELINE, PUBLIC_BASELINE, 33,
            tuple(MIGRATION_HASHES), CI_JOBS, frozenset(), 'farm-pilot-release', (), exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)

    def source_checks(self):
        market.Release.source_checks(self)
        require(all(digest((market.REPO/'db/cloud/migrations'/name).read_bytes()) == checksum
                    for name,checksum in MIGRATION_HASHES.items()), 'Unreviewed prerequisite or farm migration')
        program = "import {farmGrants} from './infra/staging/farm-grants.mjs';process.stdout.write(farmGrants('pickchick_app',true))"
        require(self.execute(['node','--input-type=module','-e',program]).decode() == FARM_GRANTS,
                'Farm grant helper differs from reviewed narrow permissions')
        farm_gateway_block()

    def web_manifest_source(self): return BASELINE

    def runtime_old(self):
        market.Release.runtime_old(self)
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] == GATEWAY_BASELINE,
                'Mounted gateway baseline changed')
        require(list(self.file_hashes([REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml']).values()) == [COMPOSE_BASELINE], 'Installed API compose changed')
        require([row['version'] for row in self.ledger()] == self.baseline_migrations(), 'Schema033 baseline differs')
        self.kitchen_before = self.http_json('/kitchen-live/health')

    def runtime_environment(self):
        script = '''import hashlib,json,sys
rows=json.load(sys.stdin);result={}
for row in rows:
 key,value=row.split('=',1)
 assert key not in result
 result[key]=hashlib.sha256(value.encode()).hexdigest()
print(json.dumps(result,sort_keys=True))'''
        return json.loads(self.remote('docker inspect --format '+quote('{{json .Config.Env}}')+' '+market.API_CONTAINER+' | python3 -c '+quote(script)))

    def verify_environment(self, before):
        after = self.runtime_environment()
        require(after.get('FARM_ENABLED') == digest(b'1'), 'Running farm flag missing')
        exclude = {'FARM_ENABLED','RELEASE_SHA'}
        require({k:v for k,v in before.items() if k not in exclude} ==
                {k:v for k,v in after.items() if k not in exclude}, 'Other running API flags/environment changed')

    def prepared_artifacts(self, manifest):
        artifacts = market.Release.prepared_artifacts(self,manifest)
        artifacts['preserved_policy'] = self.protected_policy()
        artifacts['bank_worker_acl'] = self.worker_acl()
        artifacts['neighbors'] = self.fingerprint()
        return artifacts

    def verify_data(self, before):
        expected = before['ledger'] + [{'version':name,'scope':'cloud','checksum':checksum} for name,checksum in MIGRATION_HASHES.items()]
        require(self.ledger() == expected, 'Unexpected migration delta')
        market.compare_existing(before['data'],self.snapshot(),additions=True,new_tables=NEW_TABLES)
        require(self.psql(market.DB,'SELECT count(*) FROM branches WHERE menu_publication_lock_anchor IS DISTINCT FROM false') == '0', 'New branch anchor mutated existing data')
        verify_farm_acl(before['acl'],self.acl())
        require(self.worker_acl() == before['worker_acl'], 'Bank worker permissions changed')
        require(self.psql(market.DB,"SELECT has_table_privilege('pickchick_app','commerce_captures','INSERT') OR has_column_privilege('pickchick_app','commerce_orders','total_minor','UPDATE')") == 'f', 'Farm API gained bank/price mutation authority')

    def verify_capabilities(self, caps):
        proof = json.loads((self.private/'prepared.json').read_text())
        require(caps == proof['baseline_capabilities'], 'Commercial capabilities changed')

    def verify_public(self):
        proof = json.loads((self.private/'prepared.json').read_text())
        require(self.http_json('/v1/auth/config') == proof['baseline_auth'], 'Auth policy changed')
        require(self.http_json('/v1/customer-checkout/availability').get('hours') == proof['baseline_hours'], 'Checkout hours changed')
        require(self.http_json('/kitchen-live/health')['sourceSha'] == self.kitchen_before['sourceSha'], 'Kitchen bridge changed')
        for path, method in [('/v1/customer-farm','GET'),('/v1/customer-farm/commands','POST')]:
            require(self.http(path,method=method)[0] == 401, 'Farm route missing, disabled or anonymous access accepted')
        require(self.http('/v1/customer-checkout/catalog')[0] == 404, 'Mobile storefront unexpectedly enabled')
        actual = json.loads(self.remote('docker exec '+market.GATEWAY+' cat /srv/public/.release.json'))
        verify_manifest(proof['public_manifest'],actual)
        require(self.prepared_artifacts(actual) == proof['artifacts'], 'Public assets or preserved policy drifted')

    def prepare(self):
        self.source_checks(); self.ci(); self.runtime_old()
        require(not (self.private/'prepared.json').exists(), 'Preparation already exists')
        old = f'{REMOTE}/public-https/releases/{PUBLIC_BASELINE}/infra/public-staging'
        old_gateway = self.remote('cat '+quote(old+'/gateway.Caddyfile'))+'\n'
        gateway = gateway_candidate(old_gateway)
        compose = compose_candidate(self.remote('cat '+quote(REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml'))+'\n')
        rollback = self.rollback_artifacts()
        archive = self.execute(['git','archive','--format=tar',self.sha,*market.ARCHIVE_PATHS])
        target = REMOTE+'/releases/'+self.sha
        self.remote(f'test ! -e {target} && mkdir {target} && tar -xf - -C {target}',input=archive,timeout=180)
        self.remote('python3 -c '+quote(release_env_program())+' '+' '.join(map(quote,[REMOTE+'/releases/'+BASELINE+'/release.env',target+'/release.env',self.sha,BASELINE])))
        writer = 'from pathlib import Path;import sys;p=Path(sys.argv[1]);p.write_bytes(sys.stdin.buffer.read());p.chmod(0o600)'
        self.remote('python3 -c '+quote(writer)+' '+quote(target+'/infra/staging/compose.yaml'),input=compose)
        self.remote('! docker image inspect pickchick-api:'+self.sha+' >/dev/null 2>&1')
        image = self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} -t pickchick-api:{self.sha} .',timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}',image), 'Invalid immutable API image')
        new = f'{REMOTE}/public-https/releases/{self.sha}/infra/public-staging'
        self.remote(f'test ! -e {REMOTE}/public-https/releases/{self.sha} && mkdir -p {new} && cp -a {old}/. {new}/',timeout=180)
        web_compose = json.loads(self.remote(market.web_compose(PUBLIC_BASELINE)+' config --format json'))
        relocated = director.relocate_public_mounts(web_compose,old,new)
        self.remote('python3 -c '+quote(writer)+' '+quote(new+'/compose.yaml'),input=json.dumps(relocated))
        self.remote('python3 -c '+quote(writer)+' '+quote(new+'/gateway.Caddyfile'),input=gateway)
        previous = json.loads(self.remote('cat '+quote(old+'/public-web/.release.json')))
        manifest = json.loads(self.remote('cat '+quote(new+'/public-web/.release.json')))
        verify_manifest(previous,manifest)
        require(self.file_hashes([old+'/public-web/.release.json'])[old+'/public-web/.release.json'] ==
                self.file_hashes([new+'/public-web/.release.json'])[new+'/public-web/.release.json'], 'Manifest bytes changed')
        self.remote(market.api_compose(self.sha)+' config --quiet')
        self.remote(market.web_compose(self.sha)+' config --quiet')
        self.remote('docker run --rm --network none --entrypoint caddy -v '+new+'/gateway.Caddyfile:/tmp/Caddyfile:ro '+transport.CADDY+' validate --config /tmp/Caddyfile --adapter caddyfile')
        prepared = {'sha':self.sha,'old_web':PUBLIC_BASELINE,'old_api':BASELINE,'image_id':image,'public_manifest':manifest,
            'gateway_sha256':digest(gateway.encode()),'rollback_files':rollback,
            'baseline_capabilities':self.http_json('/v1/capabilities',public=False),'baseline_auth':self.http_json('/v1/auth/config'),
            'baseline_hours':self.http_json('/v1/customer-checkout/availability').get('hours'), 'baseline_environment':self.runtime_environment()}
        prepared['artifacts'] = self.prepared_artifacts(manifest)
        require(prepared['artifacts']['image_id'] == image and self.rollback_artifacts() == rollback, 'Preparation drift')
        self.save('prepared.json',prepared)
        print('Prepared farm API and gateway; public files and active services unchanged',flush=True)

    def apply(self):
        self.source_checks(); self.ci(); self.runtime_old()
        proof = json.loads((self.private/'prepared.json').read_text())
        require((proof['sha'],proof['old_api'],proof['old_web']) == (self.sha,BASELINE,PUBLIC_BASELINE), 'Wrong preparation')
        require(self.prepared_artifacts(proof['public_manifest']) == proof['artifacts'] and
                self.rollback_artifacts() == proof['rollback_files'], 'Prepared or rollback artifacts changed')
        key = self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0, 'Protected backup identity required')
        require(self.runtime_environment() == proof['baseline_environment'], 'Baseline running environment changed')
        self.maintenance = REMOTE+'/maintenance/farm-'+self.lock_owner['id']
        contents = {'owner.json':json.dumps(self.lock_owner),'maintenance.json':json.dumps(transport.maintenance_config()),'compose.json':json.dumps(transport.maintenance_overlay(self.maintenance))}
        self.remote('python3 -c '+quote(transport.maintenance_write_script())+' '+quote(self.maintenance),input=json.dumps(contents))
        self.remote(transport.caddy_validation_command(self.maintenance+'/maintenance.json'))
        self.cleanup('acquire')
        self.remote(market.web_compose(PUBLIC_BASELINE)+' -f '+quote(self.maintenance+'/compose.json')+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        require(self.http('/v1/test/orders',method='POST')[0] == 503, 'Ingress did not close')
        self.remote(market.api_compose(BASELINE)+' stop --timeout 30 api',timeout=60)
        require(self.psql(market.DB,"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND (usename='pickchick_app' OR xact_start IS NOT NULL)") == '0', 'Competing database writer')
        self.quiescent()
        before = {'data':self.snapshot(),'ledger':self.ledger(),'acl':self.acl(),'worker_acl':self.worker_acl(),'neighbors':self.fingerprint()}
        expected = [{'version':name,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/name).read_bytes())} for name in self.baseline_migrations()]
        require(before['ledger'] == expected, 'Baseline migration ledger differs')
        self.save('before.json',before)
        backup = self.backup_restore(before['data']); self.save('backup.json',backup)
        for _ in range(2):
            self.cleanup('status'); self.quiescent()
            self.remote(market.api_compose(self.sha)+' run --rm --no-deps --entrypoint node provision --input-type=module -e '+quote(owner_migration_program()),timeout=180)
            self.verify_data(before)
        # Retain schema038 on rollback; run old API only, never old provision.
        self.remote(market.api_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'], 'Old image incompatible with retained schema038')
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
        self.save('result.json',{'source_sha':self.sha,'schema':38,'farm_enabled':True,'public_assets_preserved':True,'runtime_acl_verified':True,'worker_preserved':True,'old_image_compatible':True,'backup':backup})
        print('Published farm pilot API and bounded gateway; all existing public assets preserved',flush=True)

    def retain_failure(self, error):
        phase = getattr(self,'phase','before_reopening')
        ingress = 'unknown'
        reclosed = False
        if phase in ['reopening','reopened'] and not isinstance(error,market.CommandUncertain):
            try:
                self.cleanup('status')
                self.remote(market.web_compose(self.sha)+' -f '+quote(self.maintenance+'/compose.json')+
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
        self.maintenance = REMOTE+'/maintenance/farm-'+owner['id']
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
        market.compare_existing(before['data'],self.snapshot(),additions=True,new_tables=NEW_TABLES)
        require(self.worker_acl() == before['worker_acl'] and self.fingerprint() == before['neighbors'], 'Worker or neighbor changed')
        self.psql(market.DB,market.acl_restore_sql(before['acl'],self.acl()))
        require(self.acl() == before['acl'], 'Old ACL not restored exactly')
        self.remote(market.api_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'], 'Old API incompatible with retained schema038')
        self.verify_capabilities(self.http_json('/v1/capabilities',public=False))
        for path,old,new in [(REMOTE+'/current',REMOTE+'/releases/'+BASELINE,REMOTE+'/releases/'+self.sha),
                (REMOTE+'/public-https/current',REMOTE+'/public-https/releases/'+PUBLIC_BASELINE,REMOTE+'/public-https/releases/'+self.sha)]:
            actual = self.remote('readlink -f '+path)
            require(actual in [old,new], 'Concurrent pointer change; inspect before rollback')
            if actual == new: self.switch(path,new,old)
        self.remote(market.web_compose(PUBLIC_BASELINE)+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        require(self.fingerprint() == before['neighbors'], 'Neighbor changed during rollback')
        self.cleanup('release')
        self.save('rollback.json',{'schema_retained':38,'acl_restored':True,'live_dump_restored':False,'farm_data_erased':False})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['prepare','apply','rollback'])
    for name in ['sha','branch','expected-api-sha','expected-public-sha','expected-gateway-sha256']:
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--ssh-key',type=Path,required=True)
    parser.add_argument('--backup-identity',type=Path)
    parser.add_argument('--ci-proof',type=Path)
    parser.add_argument('--ci-run')
    parser.add_argument('--owner-id',help='Original retained apply owner UUID; rollback only')
    args = parser.parse_args(); release = Release(args)
    try:
        if args.action == 'rollback':
            release.resume_owned_rollback()
        else:
            require(args.owner_id is None,'Owner UUID is only valid for explicit rollback')
            with release.deployment_lock(): getattr(release,args.action)()
    except Exception as error:
        release.record_error(error)
        ingress = release.retain_failure(error)
        reason = str(error) if isinstance(error,market.GuardFailure) else 'Release stopped; private diagnostics retained.'
        print(reason+' Deployment lock retained; ingress state: '+ingress+'. No automatic rollback.',file=sys.stderr)
        raise SystemExit(1)
if __name__ == '__main__': main()
