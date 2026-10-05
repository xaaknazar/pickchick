#!/usr/bin/env python3
"""Guarded TEST-only TipTopPay schema038 -> 040; preserve all commercial services.

Requires Python 3.12, exact green CI, owned maintenance, encrypted backup/restore,
immutable artifacts, narrow test-table grants and pointer CAS. No live charge,
provider account creation, worker installation, seed or live database restoration.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import uuid

spec = importlib.util.spec_from_file_location('tiptoppay_farm_base', Path(__file__).with_name('release-farm-pilot.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, transport, director = base.market, base.transport, base.director
require, quote, digest, REMOTE = market.require, market.quote, market.digest, market.REMOTE
file_writer_program = base.file_writer_program
release_env_program = base.release_env_program
gateway_validation_command = base.gateway_validation_command
verify_manifest = base.verify_manifest
BASELINE = 'f39863718f074e923ae24ffecf37d8bf36987cdf'
PUBLIC_BASELINE = '239148bf3329f6ec8e467b9425bcdff6189dd414'
GATEWAY_BASELINE = '1df3d12b60e829081bc90b77256cfc5a84b30064cabe8039cae519a41465ed51'
COMPOSE_BASELINE = 'c62c24cb90418e791b9740352ffcafe4c664a1669887914d79dfea96dbbc5db2'
MIGRATION_HASHES = {
    '039_cloud_tiptoppay_checkout.sql': '1f7b924b1af678c0f704703119d26d56ad493503e970c03f7175337aef10bfba',
    '040_cloud_tiptoppay_test_checkout.sql': 'c2f308086bf665a504e286e15e3d8dde73dae5217d004f043f3a066bac66219b',
}
NEW_TABLES = {'commerce_checkout_payment_methods','commerce_tiptoppay_sessions','commerce_tiptoppay_test_payments'}
TEST_TABLE = 'commerce_tiptoppay_test_payments'
TEST_GRANTS = 'GRANT SELECT,INSERT,UPDATE ON commerce_tiptoppay_test_payments TO pickchick_app;'
TEST_FLAGS = {
    'TIPTOPPAY_MODE':'test', 'TIPTOPPAY_TEST_CHECKOUT_ENABLED':'true',
    'TIPTOPPAY_TEST_WEBHOOKS_ENABLED':'true', 'TIPTOPPAY_TEST_CHECKOUT_METHODS':'card',
    'TIPTOPPAY_TEST_MAX_MINOR':'10000000',
    'TIPTOPPAY_CHECKOUT_ORIGIN':'https://pickchick.185.129.51.103.nip.io',
    'TIPTOPPAY_CHECKOUT_ENABLED':'false', 'TIPTOPPAY_WEBHOOKS_ENABLED':'false',
    'TIPTOPPAY_LIVE_VERIFIED':'false', 'TIPTOPPAY_RECONCILE_ENABLED':'false',
    'TIPTOPPAY_METHOD_ROUTING_VERIFIED':'false', 'TIPTOPPAY_APPLE_PAY_DOMAIN_VERIFIED':'false',
}


def test_environment(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_mode & 0o077 == 0,
            'Protected local TEST credentials required')
    rows = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith('#'): continue
        require('=' in line, 'Invalid credential file')
        key,value = line.split('=',1)
        require(key not in rows and re.fullmatch('[A-Z_]+',key), 'Duplicate or invalid credential key')
        rows[key] = value
    require(set(rows) <= {'TIPTOPPAY_PUBLIC_ID','TIPTOPPAY_API_SECRET','TIPTOPPAY_MODE',
        'TIPTOPPAY_WEBHOOKS_ENABLED','TIPTOPPAY_ACCOUNT_ID','FISCAL_PROVIDER','WEBKASSA_ENABLED'},
        'Unexpected credential setting')
    require(rows.get('TIPTOPPAY_MODE') == 'test', 'Only TEST credentials allowed')
    require(re.fullmatch('(pk_|test_api_)[a-zA-Z0-9]+',rows.get('TIPTOPPAY_PUBLIC_ID','')) and
            re.fullmatch('[A-Za-z0-9+/=_-]{16,256}',rows.get('TIPTOPPAY_API_SECRET','')),
            'Invalid protected TEST credentials')
    return '\n'.join(k+'='+v for k,v in {**TEST_FLAGS,
        'TIPTOPPAY_PUBLIC_ID':rows['TIPTOPPAY_PUBLIC_ID'],
        'TIPTOPPAY_API_SECRET':rows['TIPTOPPAY_API_SECRET']}.items())+'\n'


def compose_candidate(raw, sha):
    require(digest(raw.encode()) == COMPOSE_BASELINE and re.fullmatch('[a-f0-9]{40}',sha), 'Unreviewed compose/source')
    start,end = raw.index('  api:\n'),raw.index('  provision:\n')
    api = raw[start:end]
    match = re.findall(r'    env_file: \[([^\n]+)\]\n',api)
    require(len(match) == 1 and 'TIPTOPPAY' not in raw, 'Unexpected API environment boundary')
    old = '    env_file: ['+match[0]+']\n'
    new = '    env_file: ['+match[0]+', '+REMOTE+'/releases/'+sha+'/tiptoppay-test.env]\n'
    result = raw[:start]+api.replace(old,new,1)+raw[end:]
    require(result.replace(new,old,1) == raw, 'Non-TEST compose changed')
    return result


def gateway_block():
    uuid_pattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
    blocks = ['\t@tiptop_test_preflight {\n\t\tmethod OPTIONS\n'+
        '\t\tpath_regexp tiptop_test_options ^/v1/customer-checkout/test-payments(/'+uuid_pattern+')?$\n'+
        '\t\theader_regexp tiptop_test_method Access-Control-Request-Method ^(GET|POST)$\n\t}\n'+
        '\thandle @tiptop_test_preflight {\n\t\theader Access-Control-Allow-Origin *\n'+
        '\t\theader Access-Control-Allow-Methods GET,POST\n'+
        '\t\theader Access-Control-Allow-Headers Authorization,Content-Type\n\t\trespond "" 204\n\t}\n']
    for name,method,matcher,authorization in [
        ('customer_post','POST','path /v1/customer-checkout/test-payments',True),
        ('customer_get','GET','path_regexp tiptop_test_read ^/v1/customer-checkout/test-payments/'+uuid_pattern+'$',True),
        ('hosted_get','GET','path /v1/integrations/tiptoppay/test-checkout',False),
        ('provider_post','POST','path /v1/integrations/tiptoppay/test-checkout-session /v1/integrations/tiptoppay/test-checkout-status /v1/integrations/tiptoppay/test-check /v1/integrations/tiptoppay/test-pay /v1/integrations/tiptoppay/test-fail',False),
    ]:
        blocks.append('\t@tiptop_test_'+name+' {\n\t\tmethod '+method+'\n\t\t'+matcher+'\n\t}\n'+
            '\thandle @tiptop_test_'+name+' {\n\t\theader X-PickChick-Data test-payment\n'+
            '\t\theader Cache-Control no-store\n'+
            ('\t\theader Access-Control-Allow-Origin *\n' if authorization else '')+
            '\t\treverse_proxy pickchick-staging-api-1:3100 {\n\t\t\theader_up -Cookie\n\t\t\theader_up -X-Device-Id\n'+
            ('' if authorization else '\t\t\theader_up -Authorization\n')+
            '\t\t\theader_up X-Forwarded-For {client_ip}\n\t\t\ttransport http {\n\t\t\t\tdial_timeout 2s\n\t\t\t\tresponse_header_timeout 7s\n\t\t\t}\n\t\t}\n\t}\n')
    return ''.join(blocks)


def gateway_candidate(raw):
    require(digest(raw.encode()) == GATEWAY_BASELINE and '@tiptop_test_' not in raw, 'Unreviewed gateway baseline')
    anchor = '\t@farm_preflight {'
    require(raw.count(anchor) == 1, 'Gateway insertion boundary differs')
    block = gateway_block()
    candidate = raw.replace(anchor,block+anchor,1)
    require(candidate.replace(block,'',1) == raw, 'Existing gateway rules changed')
    return candidate


def owner_migration_program():
    return '''import {createPool,migrate,transaction} from '@pickchick/database';
import {tipTopPayTestGrants} from './infra/staging/tiptoppay-test-grants.mjs';
const url=new URL(process.env.CLOUD_DATABASE_URL);
if(url.username!=='pickchick_owner'||url.pathname!=='/pickchick_cloud')throw new Error('Owner database required');
const pool=createPool(url.href);
try{await migrate(pool,'/app/db/cloud/migrations','cloud');
await transaction(pool,c=>c.query(tipTopPayTestGrants('pickchick_app',true)));
console.log(JSON.stringify({schema:40,testGrants:true}));}finally{await pool.end();}'''


class Release(base.Release):
    additions = {}
    snapshot = market.Release.snapshot
    baseline_migrations = market.Release.baseline_migrations
    def __init__(self,args):
        require(sys.version_info >= (3,12), 'Python 3.12 required for PostgreSQL timestamps')
        require((args.expected_api_sha,args.expected_public_sha,args.expected_gateway_sha256) ==
                (BASELINE,PUBLIC_BASELINE,GATEWAY_BASELINE), 'Unreviewed TEST TipTopPay baseline')
        self.baseline_schema = 38
        profile = market.ReleaseProfile('tiptoppay-test-schema040',BASELINE,PUBLIC_BASELINE,38,
            tuple(MIGRATION_HASHES),base.CI_JOBS,frozenset(),'tiptoppay-test-release',(),exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)

    def source_checks(self):
        market.Release.source_checks(self)
        require(all(digest((market.REPO/'db/cloud/migrations'/n).read_bytes()) == h
            for n,h in MIGRATION_HASHES.items()), 'Unreviewed TEST migration')
        program = "import {tipTopPayTestGrants} from './infra/staging/tiptoppay-test-grants.mjs';process.stdout.write(tipTopPayTestGrants('pickchick_app',true))"
        require(self.execute(['node','--input-type=module','-e',program]).decode() == TEST_GRANTS, 'Unreviewed TEST permissions')
        test_environment(self.args.test_env)

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
        wanted = before['acl']+[{'name':TEST_TABLE,'kind':'r','column':None,'privilege':p,'grantable':False} for p in ['SELECT','INSERT','UPDATE']]
        key = lambda row:(row['name'],row['kind'],row['column'] or '',row['privilege'],row['grantable'])
        require(sorted(map(key,self.acl())) == sorted(map(key,wanted)), 'Only TEST table permission delta allowed')
        require(self.worker_acl() == before['worker_acl'], 'Kaspi worker permissions changed')
        require(all(self.psql(market.DB,'SELECT count(*) FROM '+n) == '0' for n in NEW_TABLES), 'New payment tables must stay empty during rollout')

    def verify_environment(self,before):
        after = self.runtime_environment()
        expected = {k:digest(v.encode()) for k,v in TEST_FLAGS.items()}
        credentials = dict(line.split('=',1) for line in test_environment(self.args.test_env).splitlines())
        expected.update({k:digest(credentials[k].encode()) for k in ['TIPTOPPAY_PUBLIC_ID','TIPTOPPAY_API_SECRET']})
        require({k:v for k,v in after.items() if k.startswith('TIPTOPPAY_')} == expected, 'TEST flags or protected credentials differ')
        require({k:v for k,v in after.items() if k != 'RELEASE_SHA' and not k.startswith('TIPTOPPAY_')} ==
            {k:v for k,v in before.items() if k != 'RELEASE_SHA'}, 'Existing API environment changed')

    def prepared_artifacts(self,manifest):
        result = base.Release.prepared_artifacts(self,manifest)
        result['test_env'] = self.file_hashes([REMOTE+'/releases/'+self.sha+'/tiptoppay-test.env'])
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
        verify_manifest(proof['public_manifest'],actual)
        require(self.prepared_artifacts(actual) == proof['artifacts'], 'Prepared/public artifacts changed')
        require(self.http('/v1/customer-checkout/test-payments',method='POST')[0] == 401, 'Anonymous TEST creation accepted or route unavailable')
        require(self.http('/v1/customer-checkout/test-payments/00000000-0000-4000-8000-000000000001')[0] == 401, 'Anonymous TEST read accepted')
        require(self.http('/v1/integrations/tiptoppay/test-checkout')[0] == 200, 'Hosted TEST page unavailable')
        for event in ['check','pay','fail']:
            require(self.http('/v1/integrations/tiptoppay/test-'+event,method='POST',headers={'Content-Type':'application/x-www-form-urlencoded'},body=b'')[0] == 401, 'Unsigned TEST webhook accepted')
        for event in ['check','pay','fail','checkout']:
            require(self.http('/v1/integrations/tiptoppay/'+event,method='POST' if event != 'checkout' else 'GET')[0] == 404, 'Live TipTopPay route exposed')

    def http(self,path,*,public=True,method='GET',headers=None,body=None):
        if headers is None and body is None:
            return market.Release.http(self,path,public=public,method=method)
        require(public and method == 'POST' and headers == {'Content-Type':'application/x-www-form-urlencoded'} and body == b'', 'Only empty unsigned TEST probes allowed')
        command = ['curl','--silent','--show-error','--max-time','15','--max-filesize','2000000',
            '-X','POST','-H','Content-Type: application/x-www-form-urlencoded','--data-binary','@-',
            '--resolve',market.HOST+':443:'+market.IP,'-w','\n%{http_code}','https://'+market.HOST+path]
        raw = self.execute(command,input=body,timeout=20)
        payload,status = raw.rsplit(b'\n',1)
        return int(status),payload

    def prepare(self):
        self.source_checks(); self.ci(); self.runtime_old()
        require(not (self.private/'prepared.json').exists(), 'Preparation already exists')
        old = f'{REMOTE}/public-https/releases/{PUBLIC_BASELINE}/infra/public-staging'
        old_gateway = self.remote('cat '+quote(old+'/gateway.Caddyfile'))+'\n'
        gateway = gateway_candidate(old_gateway)
        compose = compose_candidate(self.remote('cat '+quote(REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml'))+'\n',self.sha)
        self.kitchen_before = self.http_json('/kitchen-live/health')
        rollback = self.rollback_artifacts()
        archive = self.execute(['git','archive','--format=tar',self.sha,*market.ARCHIVE_PATHS])
        target = REMOTE+'/releases/'+self.sha
        self.remote(f'test ! -e {target} && mkdir {target} && tar -xf - -C {target}',input=archive,timeout=180)
        self.remote('python3 -c '+quote(release_env_program())+' '+' '.join(map(quote,[REMOTE+'/releases/'+BASELINE+'/release.env',target+'/release.env',self.sha,BASELINE])))
        writer = file_writer_program()
        self.remote('python3 -c '+quote(writer)+' '+quote(target+'/tiptoppay-test.env'),input=test_environment(self.args.test_env))
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
        manifest = json.loads(self.remote('cat '+quote(new+'/public-web/.release.json')))
        verify_manifest(previous,manifest)
        require(self.file_hashes([old+'/public-web/.release.json'])[old+'/public-web/.release.json'] ==
                self.file_hashes([new+'/public-web/.release.json'])[new+'/public-web/.release.json'], 'Manifest bytes changed')
        self.remote(market.api_compose(self.sha)+' config --quiet')
        self.remote(market.web_compose(self.sha)+' config --quiet')
        self.remote(gateway_validation_command(new+'/gateway.Caddyfile'))
        prepared = {'sha':self.sha,'old_web':PUBLIC_BASELINE,'old_api':BASELINE,'image_id':image,'public_manifest':manifest,
            'gateway_sha256':digest(gateway.encode()),'rollback_files':rollback,
            'baseline_capabilities':self.http_json('/v1/capabilities',public=False),'baseline_auth':self.http_json('/v1/auth/config'),
            'baseline_schema':self.baseline_schema, 'kitchen_sha':self.kitchen_before['sourceSha'],
            'baseline_hours':self.http_json('/v1/customer-checkout/availability').get('hours'), 'baseline_environment':self.runtime_environment()}
        prepared['artifacts'] = self.prepared_artifacts(manifest)
        require(prepared['artifacts']['image_id'] == image and self.rollback_artifacts() == rollback, 'Preparation drift')
        self.save('prepared.json',prepared)
        print('Prepared TEST TipTopPay API and gateway; public files and active services unchanged',flush=True)

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
        self.maintenance = REMOTE+'/maintenance/tiptoppay-test-'+self.lock_owner['id']
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
        # Retain schema040 on rollback; run old API only, never old provision.
        self.remote(market.api_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'], 'Old image incompatible with retained schema040')
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
        self.save('result.json',{'source_sha':self.sha,'schema':40,'tiptoppay_test_enabled':True,'public_assets_preserved':True,'runtime_acl_verified':True,'worker_preserved':True,'old_image_compatible':True,'backup':backup})
        print('Published TEST TipTopPay API and bounded gateway; all existing public assets preserved',flush=True)

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
        self.maintenance = REMOTE+'/maintenance/tiptoppay-test-'+owner['id']
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
        self.compare_runtime(before)
        require(self.worker_acl() == before['worker_acl'] and self.fingerprint() == before['neighbors'], 'Worker or neighbor changed')
        self.psql(market.DB,market.acl_restore_sql(before['acl'],self.acl()))
        require(self.acl() == before['acl'], 'Old ACL not restored exactly')
        self.remote(market.api_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'], 'Old API incompatible with retained schema040')
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER) == proof['artifacts']['rollback_image_id'], 'Rollback image changed')
        self.verify_capabilities(self.http_json('/v1/capabilities',public=False))
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
        self.save('rollback.json',{'schema_retained':40,'acl_restored':True,'live_dump_restored':False,'test_data_erased':False})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['prepare','apply','rollback'])
    for name in ['sha','branch','expected-api-sha','expected-public-sha','expected-gateway-sha256']:
        parser.add_argument('--'+name,required=True)
    for name in ['ssh-key','test-env','backup-identity','ci-proof']:
        parser.add_argument('--'+name,type=Path,required=name in ['ssh-key','test-env'])
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
