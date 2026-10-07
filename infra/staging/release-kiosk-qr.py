#!/usr/bin/env python3
"""Guarded enrollment-only kiosk API schema042 ->043+044; QR worker stays off.

Requires Python 3.12, exact green CI, owned maintenance, encrypted backup/restore,
immutable artifacts, enrollment SELECT grants and pointer CAS. No live charge,
provider account creation, worker installation, seed or live database restoration.

Requires --environment private0600 JSON with explicit kiosk options (the already
authorized deferred_pilot is supported), and --finance-proof original installed
finance prepared.json. The expected gateway hash must match that proof; no hash
is inferred from an arbitrary current gateway. Public assets stay byte-identical.
For a new candidate after a completed043 rollback, --previous-attempt-proof-dir
must identify the original private prepared/before/backup/rollback evidence.
prepare constructs inactive artifacts; apply requires owned maintenance and backup.
rollback retains043+044 and all data, and fails closed if money changed meanwhile.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import uuid

spec = importlib.util.spec_from_file_location('kiosk_farm_base', Path(__file__).with_name('release-farm-pilot.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, transport, director = base.market, base.transport, base.director
require, quote, digest, REMOTE = market.require, market.quote, market.digest, market.REMOTE
file_writer_program = base.file_writer_program
release_env_program = base.release_env_program
gateway_validation_command = base.gateway_validation_command
BASELINE = 'd6cd144cc7cba9943b614e2a33552111f3f1f44d'
PUBLIC_BASELINE = 'd6cd144cc7cba9943b614e2a33552111f3f1f44d'
COMPOSE_BASELINE = '15f7d29229f5e119250f7893479a08e128778b16c905a523492223b08e3c2071'
MIGRATION_HASHES = {'043_cloud_kiosk_kaspi_qr.sql':'afab40793e930a1c7a647fe2ad7e28e8b94922f7c95bcace4f14fb7e3e08f5e2',
    '044_cloud_kiosk_enrollment.sql':'ea55253db1ef9daf1ec6544204f7a33b3fb33a944c4dbdb36d6bb83563e143a5'}
MIGRATION_TABLES = {'043_cloud_kiosk_kaspi_qr.sql':{'commerce_kiosk_kaspi_qr'},
    '044_cloud_kiosk_enrollment.sql':{'kiosk_enrollment_aliases'}}
NEW_TABLES = set().union(*MIGRATION_TABLES.values())
# Enrollment checks the branch and its catalog ACK even when ordering is disabled.
# Existing SELECTs are deduplicated during exact ACL verification; no write authority.
API_SELECT_TABLES = {'kiosk_devices','commerce_kiosk_kaspi_qr','branches','catalog_branch_heads',
    'commerce_provider_accounts','catalog_menu_deliveries','menu_releases','devices',
    'fulfillment_transport_bindings','branch_menu_activations','outbox_events','inbox_messages'}
API_SELECT_TABLES.add('kiosk_enrollment_aliases')
API_UPDATE_COLUMNS = {'kiosk_enrollment_aliases':{'request_id','failed_attempts','locked_until'},
    'kiosk_devices':{'lock_anchor'}}
API_GRANTS = 'GRANT SELECT ON '+','.join(sorted(API_SELECT_TABLES))+' TO pickchick_app;'
API_GRANTS += 'GRANT UPDATE(request_id,failed_attempts,locked_until) ON kiosk_enrollment_aliases TO pickchick_app;'
API_GRANTS += 'GRANT UPDATE(lock_anchor) ON kiosk_devices TO pickchick_app;'


def verify_manifest(before,after,sha=None):
    require(before==after,'Entire public manifest/assets including finance must be preserved')


def compose_candidate(raw,env):
    require(digest(raw.encode())==COMPOSE_BASELINE,'Unreviewed installed compose')
    require('KIOSK_CHECKOUT_' not in raw and 'KIOSK_KASPI_QR_' not in raw,'Kiosk environment already configured')
    require(raw.count('  api:\n')==1 and raw.count('  provision:\n')==1,'Exact API compose anchors required')
    head,tail=raw.split('  api:\n',1)
    api,provision=tail.split('  provision:\n',1)
    require(api.count('    environment:\n')==1,'Exact API environment anchor required')
    injected=''.join('      '+key+': ${'+key+':?Private kiosk setting required}\n' for key in sorted(env))
    api=api.replace('    environment:\n','    environment:\n'+injected,1)
    return head+'  api:\n'+api+'  provision:\n'+provision

def private_read(path):
    path = Path(path)
    require(path.is_file() and not any(p.is_symlink() for p in [path, *path.parents])
            and path.stat().st_mode & 0o077 == 0, 'Protected 0600 input required')
    return path.read_bytes()


def validate_environment(value):
    keys = {'KIOSK_CHECKOUT_ENABLED','KIOSK_CHECKOUT_PAYMENT_METHOD','KIOSK_CHECKOUT_ORGANIZATION_ID',
        'KIOSK_CHECKOUT_BRANCH_ID','KIOSK_KASPI_QR_ACCOUNT_ID','KIOSK_CHECKOUT_FISCAL_POLICY',
        'KIOSK_CHECKOUT_APPROVAL_REFERENCE','KIOSK_CHECKOUT_TAX_CODE','KIOSK_CHECKOUT_MAX_MINOR',
        'KIOSK_CHECKOUT_PII_KEY','KIOSK_KASPI_QR_ENABLED'}
    require(isinstance(value,dict) and keys <= value.keys() and
            value.keys() <= keys|{'KIOSK_CHECKOUT_FISCAL_ACCOUNT_ID','KIOSK_ENROLLMENT_KEY'}, 'Exact enrollment environment required')
    require(all(isinstance(v,str) and '\n' not in v and '\r' not in v for v in value.values()), 'Invalid environment value')
    require(value['KIOSK_CHECKOUT_ENABLED']=='true' and value['KIOSK_CHECKOUT_PAYMENT_METHOD']=='kaspi_qr'
            and value['KIOSK_KASPI_QR_ENABLED']=='false', 'Enrollment only; QR worker must remain disabled')
    for name in ['KIOSK_CHECKOUT_ORGANIZATION_ID','KIOSK_CHECKOUT_BRANCH_ID','KIOSK_KASPI_QR_ACCOUNT_ID']:
        require(re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',value[name]),'Invalid enrollment UUID')
    require(re.fullmatch('[a-f0-9]{64}',value['KIOSK_CHECKOUT_PII_KEY']), 'Invalid private PII key')
    require('KIOSK_ENROLLMENT_KEY' not in value or re.fullmatch('[a-f0-9]{64}',value['KIOSK_ENROLLMENT_KEY']), 'Invalid enrollment key')
    require(re.fullmatch('[1-9][0-9]{0,8}',value['KIOSK_CHECKOUT_MAX_MINOR']), 'Invalid kiosk limit')
    require(3<=len(value['KIOSK_CHECKOUT_APPROVAL_REFERENCE'].strip())<=250 and
            1<=len(value['KIOSK_CHECKOUT_TAX_CODE'].strip())<=32, 'Explicit fiscal binding required')
    policy=value['KIOSK_CHECKOUT_FISCAL_POLICY']
    require(policy in ['required','deferred_pilot'],'Explicit fiscal policy required')
    if policy=='required':
        require(re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',value.get('KIOSK_CHECKOUT_FISCAL_ACCOUNT_ID','')),'Required fiscal account missing')
    require(all(re.fullmatch(r'[A-Za-z0-9 _.:/+-]+',v) for v in value.values()),'Unsupported private environment characters')
    return value


def gateway_candidate(raw, expected_hash):
    require(re.fullmatch('[a-f0-9]{64}',expected_hash) and digest(raw.encode())==expected_hash,
            'Captured finance gateway hash differs')
    require('/v1/kiosk-checkout' not in raw and raw.count('\t@backoffice_get {')==1 and
            'max_size 16KB' in raw, 'Reviewed bounded gateway anchor required')
    block = '''\t# Enrollment only: no guest checkout or payment routes are exposed.
\t@kiosk_enrollment_check {
\t\tmethod POST
\t\tpath /v1/kiosk-checkout/enrollment/check /v1/kiosk-checkout/enrollment/exchange
\t}
\thandle @kiosk_enrollment_check {
\t\theader X-PickChick-Data kiosk
\t\treverse_proxy pickchick-staging-api-1:3100 {
\t\t\theader_up -Cookie
\t\t\theader_up -Authorization
\t\t\theader_up -X-Device-Id
\t\t\ttransport http {
\t\t\t\tdial_timeout 2s
\t\t\t\tresponse_header_timeout 5s
\t\t\t}
\t\t}
\t}

'''
    result=raw.replace('\t@backoffice_get {',block+'\t@backoffice_get {',1)
    require(result.replace(block,'',1)==raw, 'Existing gateway changed')
    return result


def verify_finance_audit_append(before,after):
    old = {row['id']:row for row in before}
    current = {row['id']:row for row in after}
    require(len(old) == len(before) and len(current) == len(after), 'Duplicate audit proof IDs')
    require(all(key in current and current[key]['sha256'] == row['sha256'] for key,row in old.items()),
            'Pre-existing audit row changed or disappeared')
    added = [row for row in after if row['id'] not in old]
    require(all(row.get('finance_valid') is True and row.get('receipt_key') for row in added),
            'Non-finance or unreceipted audit append')
    require(len({row['receipt_key'] for row in added}) == len(added), 'Duplicate finance audit receipt')


def owner_migration_program():
    return """import {createPool,migrate,transaction} from '@pickchick/database';
const url=new URL(process.env.CLOUD_DATABASE_URL);
if(url.username!=='pickchick_owner'||url.pathname!=='/pickchick_cloud')throw new Error('Owner database required');
const pool=createPool(url.href);
try{await migrate(pool,'/app/db/cloud/migrations','cloud');await transaction(pool,c=>c.query("""+json.dumps(API_GRANTS)+"""));
console.log(JSON.stringify({migrationFiles:43,lastMigration:44,qrWorkerEnabled:false}));}finally{await pool.end();}"""

def enrollment_env_append_program():
    return "from pathlib import Path;import json,sys;p=Path(sys.argv[1]);values=json.load(sys.stdin);raw=p.read_text();assert not any(line.split('=',1)[0] in values for line in raw.splitlines());p.write_text(raw+''.join(k+'='+v+chr(10) for k,v in sorted(values.items())));p.chmod(0o600)"


class Release(base.Release):
    additions = {}
    snapshot = market.Release.snapshot
    def baseline_migrations(self):
        paths=self.git('ls-tree','-r','--name-only',BASELINE,'--','db/cloud/migrations/').splitlines()
        names=sorted(Path(path).name for path in paths if path.endswith('.sql'))
        expected=list(range(1,41))+[42]
        require(len(names)==41 and [int(n[:3]) for n in names]==expected,'Unexpected finance baseline migration set')
        return names

    def __init__(self,args):
        require(sys.version_info >= (3,12),'Python3.12 required for PostgreSQL timestamps')
        require((args.expected_api_sha,args.expected_public_sha)==(BASELINE,PUBLIC_BASELINE),'Unreviewed kiosk baseline')
        self.finance_proof=json.loads(private_read(args.finance_proof))
        require(self.finance_proof.get('sha')==BASELINE and self.finance_proof.get('artifacts',{}).get('revision')==BASELINE,
                'Original installed finance preparation proof required')
        require(re.fullmatch('[a-f0-9]{64}',args.expected_gateway_sha256) and
                args.expected_gateway_sha256==self.finance_proof.get('gateway_sha256'),'Finance gateway proof differs')
        self.environment_bytes=private_read(args.environment)
        self.enrollment_environment=validate_environment(json.loads(self.environment_bytes))
        self.baseline_schema=41
        profile=market.ReleaseProfile('kiosk-enrollment-schema044',BASELINE,PUBLIC_BASELINE,41,
            tuple(MIGRATION_HASHES),base.CI_JOBS,frozenset(),'kiosk-enrollment-release',(),exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)

    def source_checks(self):
        market.Release.source_checks(self)
        require(all(digest((market.REPO/'db/cloud/migrations'/n).read_bytes())==h for n,h in MIGRATION_HASHES.items()),'Unreviewed043 migration')
        require(private_read(self.args.environment)==self.environment_bytes,'Private environment changed')

    def preflight(self):
        self.source_checks();self.ci();self.runtime_old()
        self.save('preflight.json',{'source_sha':self.sha,'baseline_api':BASELINE,
            'baseline_public':PUBLIC_BASELINE,'baseline_migrations':41,'candidate_migrations':43,
            'qr_worker_enabled':False,'enrollment_only':True,'deployed':False,
            'environment_sha256':digest(self.environment_bytes)})
        print('Read-only kiosk enrollment preflight passed; active services unchanged',flush=True)

    def web_manifest_source(self): return BASELINE

    def runtime_old(self):
        market.Release.runtime_old(self)
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] == self.args.expected_gateway_sha256, 'Gateway changed')
        require(self.file_hashes([REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml']) ==
            {REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml':COMPOSE_BASELINE}, 'API compose changed')
        expected = [{'version':n,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in self.baseline_migrations()]
        if getattr(self.args,'previous_attempt_proof_dir',None):
            self.verify_retained_retry(expected,self.args.previous_attempt_proof_dir)
        elif getattr(self.args,'retry_retained_043',False):
            self.verify_retained_retry(expected)
        else:
            require(self.ledger() == expected, 'Baseline schema changed')
        require(not any(k.startswith('TIPTOPPAY_') for k in self.runtime_environment()), 'TipTopPay already configured')
        require(self.psql(market.DB,"SELECT count(*) FROM commerce_provider_accounts WHERE provider='kaspi-qr' AND enabled")== '0','QR account must remain disabled')
        require(not any(k.startswith(('KIOSK_CHECKOUT_','KIOSK_KASPI_QR_','KIOSK_ENROLLMENT_')) for k in self.runtime_environment()),'Kiosk already configured')

    def runtime_snapshot(self):
        original=self.additions
        self.additions={**original,'cloud_branch_availability':['revision','observed_at']}
        try:return base.Release.snapshot(self)
        finally:self.additions=original

    def compare_runtime(self,before):
        base.verify_availability(before['availability'],self.availability_rows())
        market.compare_existing(before['runtime_data'],self.runtime_snapshot(),additions=True,new_tables=NEW_TABLES-set(before['runtime_data']['tables']))

    def verify_data(self,before):
        require(self.ledger()==before['ledger']+[{'version':n,'scope':'cloud','checksum':h} for n,h in MIGRATION_HASHES.items() if n not in {row['version'] for row in before['ledger']}],'Migration ledger differs')
        self.compare_runtime(before)
        wanted=list(before['acl'])
        for name in API_SELECT_TABLES:
            row={'name':name,'kind':'r','column':None,'privilege':'SELECT','grantable':False}
            if row not in wanted:wanted.append(row)
        for name,columns in API_UPDATE_COLUMNS.items():
            for column in columns:
                row={'name':name,'kind':'r','column':column,'privilege':'UPDATE','grantable':False}
                if row not in wanted:wanted.append(row)
        key=lambda row:(row['name'],row['kind'],row['column'] or '',row['privilege'],row['grantable'])
        require(sorted(map(key,self.acl()))==sorted(map(key,wanted)),'Only enrollment SELECT and bounded UPDATE permission delta allowed')
        require(self.worker_acl()==before['worker_acl'],'Kaspi worker permissions changed')
        for table in sorted(NEW_TABLES):
            require(self.psql(market.DB,'SELECT count(*) FROM '+table)=='0','QR worker must remain inactive')

    def audit_rows(self,finance_installed=False):
        projection = "encode(sha256(convert_to(row_to_json(a)::text,'UTF8')),'hex')"
        if finance_installed:
            sql = """SELECT coalesce(json_agg(json_build_object('id',a.id,'sha256',HASH,
            'finance_valid',coalesce(c.actor_id IS NOT NULL AND c.branch_id=a.branch_id
              AND a.action IN ('finance.account','finance.entry','finance.void','finance.period')
              AND a.action='finance.'||(a.after_value->>'type')
              AND a.entity_id::text IS NOT DISTINCT FROM c.result->>'id'
              AND (a.action<>'finance.period' OR
                (c.result->>'month'=a.after_value->>'month' AND c.result->>'closed'=a.after_value->>'closed')),false),
            'receipt_key',CASE WHEN c.actor_id IS NOT NULL THEN c.actor_id::text||':'||c.request_id::text END)
            ORDER BY a.id),'[]') FROM bo_audit a LEFT JOIN bo_finance_commands c
            ON c.actor_id=a.actor_id AND c.request_id=a.request_id"""
        else:
            sql = "SELECT coalesce(json_agg(json_build_object('id',a.id,'sha256',HASH,'finance_valid',false,'receipt_key',NULL) ORDER BY a.id),'[]') FROM bo_audit a"
        return json.loads(self.psql(market.DB,sql.replace('HASH',projection)))

    def retained_rollback_snapshot(self,before):
        ledger = self.ledger()
        additions = [{'version':n,'scope':'cloud','checksum':h} for n,h in MIGRATION_HASHES.items()
                     if n not in {row['version'] for row in before['ledger']}]
        require(len(before['ledger']) <= len(ledger) <= len(before['ledger'])+len(additions) and
                ledger == before['ledger']+additions[:len(ledger)-len(before['ledger'])],
                'Rollback ledger is not an exact reviewed migration prefix')
        applied = {row['version'] for row in ledger[len(before['ledger']):]}
        expected_new={table for name,tables in MIGRATION_TABLES.items() if name in applied for table in tables}
        current=self.runtime_snapshot()
        require(set(current['tables'])-set(before['runtime_data']['tables'])==expected_new,'Rollback schema differs')
        require(all(current['tables'][n]['rows']==0 for n in expected_new),'Enrollment-only QR rail acquired data')
        # Validate receipted audit appends; compare all pre-existing money
        # and domain tables without erasing or importing any new finance rows.
        augmented = {**before['runtime_data'],'tables':{**before['runtime_data']['tables'],
                    **{name:current['tables'][name] for name in expected_new}}}
        if 'bo_audit' in current['tables']:
            require('audit_rows' in before, 'Original per-row audit proof required for journal-preserving rollback')
            verify_finance_audit_append(before['audit_rows'],self.audit_rows(True))
            augmented['tables']['bo_audit'] = current['tables']['bo_audit']
        base.verify_availability(before['availability'],self.availability_rows())
        market.compare_existing(augmented,current,additions=True,new_tables=set())
        return ledger,current

    def verify_environment(self,before):
        after=self.runtime_environment()
        proof=json.loads((self.private/'prepared.json').read_text())
        image=self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER)
        require(image in [proof['image_id'],proof['artifacts']['rollback_image_id']], 'Unreviewed running API image')
        candidate=image==proof['image_id']
        wanted={key:digest(value.encode()) for key,value in self.enrollment_environment.items()} if candidate else {}
        require(all(after.get(key)==value for key,value in wanted.items()),'Enrollment settings differ')
        exclude=set(wanted)
        require({k:v for k,v in after.items() if k not in exclude}=={k:v for k,v in before.items() if k not in exclude},'Existing API environment changed')

    def verify_retained_retry(self,expected,previous=None):
        folder=Path(previous).absolute() if previous else self.private
        proof=json.loads(private_read(folder/'prepared.json'))
        before=json.loads(private_read(folder/'before.json'))
        rollback=json.loads(private_read(folder/'rollback.json'))
        backup=json.loads(private_read(folder/'backup.json'))
        require(re.fullmatch('[a-f0-9]{40}',proof['sha']) and
                (proof['old_api'],proof['old_web'],proof['baseline_schema']) ==
                (BASELINE,PUBLIC_BASELINE,41), 'Retry requires original preparation')
        require(proof['sha'] != self.sha if previous else proof['sha'] == self.sha, 'Previous attempt candidate identity differs')
        require(before['ledger']==expected, 'Retry original baseline ledger differs')
        retained=expected+[{'version':n,'scope':'cloud','checksum':h} for n,h in MIGRATION_HASHES.items() if n.startswith('043_')]
        require(self.ledger()==retained and rollback=={'migration_files_retained':42,
            'last_migration_retained':next(iter(MIGRATION_HASHES)), 'acl_restored':True,
            'live_dump_restored':False,'finance_data_erased':False,'qr_worker_enabled':False}, 'Retry requires completed retained043 rollback')
        require(backup.get('restore')=='passed' and backup.get('path') and
                re.fullmatch('[a-f0-9]{64}',backup.get('sha256','')), 'Original restored backup proof required')
        require(self.acl()==before['acl'] and self.worker_acl()==before['worker_acl'] and
                self.fingerprint()==before['neighbors'], 'Retry rollback runtime differs')
        require(self.runtime_environment()==proof['baseline_environment'], 'Retry baseline environment changed')
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER)==
                proof['artifacts']['rollback_image_id'], 'Retry baseline image differs')
        baseline_image=json.loads(self.remote('docker image inspect --format '+quote('{{json .}}')+' pickchick-api:'+BASELINE))
        require(baseline_image['Id']==proof['artifacts']['rollback_image_id'] and
                baseline_image['Config']['Labels']['org.opencontainers.image.revision']==BASELINE,
                'Original rollback image is not immutable finance baseline')
        self.retained_rollback_snapshot(before)
        if previous:
            require(proof.get('gateway_sha256') and proof.get('image_id')==proof.get('artifacts',{}).get('image_id') and
                    proof['artifacts'].get('revision')==proof['sha'], 'Previous immutable candidate proof differs')
            captured={name:digest(private_read(folder/name)) for name in ['prepared.json','before.json','rollback.json','backup.json']}
            self.previous_attempt_evidence={'sha':proof['sha'],'files':captured,'rollback_image_id':proof['artifacts']['rollback_image_id']}

    def prepared_artifacts(self,manifest):
        result = base.Release.prepared_artifacts(self,manifest)
        old = json.loads(self.remote('docker image inspect --format '+quote('{{json .}}')+' pickchick-api:'+BASELINE))
        require(old['Config']['Labels']['org.opencontainers.image.revision'] == BASELINE, 'Rollback image revision differs')
        result['rollback_image_id'] = old['Id']
        return result

    def probe_json(self,path,body):
        require(path.startswith('/') and '\n' not in path,'Invalid probe path')
        raw=self.execute(['curl','--silent','--show-error','--max-time','15','--max-filesize','2000000',
            '--resolve',f'{market.HOST}:443:{market.IP}','-H','Content-Type: application/json',
            '-X','POST','--data-binary',json.dumps(body),'-w','\n%{http_code}','https://'+market.HOST+path],timeout=20)
        content,status=raw.rsplit(b'\n',1)
        require(len(content)<=2000000,'Probe response too large')
        return int(status),content

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
        require(self.http(branch+'?start_date=2026-10-01&end_date=2026-10-31')[0] == 401, 'Anonymous finance read accepted or route unavailable')
        require(self.probe_json(branch+'/commands',{'request_id':'00000000-0000-4000-a000-000000000001','reason':'Anonymous authorization probe','command':{'type':'void','id':'00000000-0000-4000-a000-000000000002'}})[0] == 401, 'Anonymous finance command accepted or route unavailable')
        for path,method in [('/v1/customer-checkout/test-payments','POST'),('/v1/integrations/tiptoppay/test-checkout','GET'),('/v1/integrations/tiptoppay/checkout','GET')]:
            require(self.http(path,method=method)[0] == 404, 'Payment feature route exposed')
        require(self.http_json('/v1/customer-checkout/catalog') == proof['baseline_catalog'], 'Mobile catalog changed')
        require(self.psql(market.DB,"SELECT count(*) FROM commerce_provider_accounts WHERE provider='kaspi-qr' AND enabled")=='0','QR account became enabled')
        require(self.http('/v1/kiosk-checkout/enrollment/check',method='POST')[0]==400,'Anonymous enrollment unexpectedly accepted')
        for path in ['/v1/kiosk-checkout/sessions','/v1/kiosk-checkout/orders','/v1/kiosk-checkout/quotes']:
            require(self.http(path,method='POST')[0]==404,'Guest ordering route exposed')

    def prepare(self):
        self.source_checks(); self.ci(); self.runtime_old()
        require(not (self.private/'prepared.json').exists(), 'Preparation already exists')
        old = f'{REMOTE}/public-https/releases/{PUBLIC_BASELINE}/infra/public-staging'
        old_gateway = self.remote('cat '+quote(old+'/gateway.Caddyfile'))+'\n'
        gateway = gateway_candidate(old_gateway,self.args.expected_gateway_sha256)
        compose = compose_candidate(self.remote('cat '+quote(REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml'))+'\n',self.enrollment_environment)
        self.kitchen_before = self.http_json('/kitchen-live/health')
        rollback = self.rollback_artifacts()
        archive = self.execute(['git','archive','--format=tar',self.sha,*market.ARCHIVE_PATHS])
        target = REMOTE+'/releases/'+self.sha
        self.remote(f'test ! -e {target} && mkdir {target} && tar -xf - -C {target}',input=archive,timeout=180)
        self.remote('python3 -c '+quote(release_env_program())+' '+' '.join(map(quote,[REMOTE+'/releases/'+BASELINE+'/release.env',target+'/release.env',self.sha,BASELINE])))
        self.remote('python3 -c '+quote(enrollment_env_append_program())+' '+quote(target+'/release.env'),input=json.dumps(self.enrollment_environment))
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
        manifest = previous
        verify_manifest(previous,manifest,self.sha)
        self.remote(market.api_compose(self.sha)+' config --quiet')
        self.remote(market.web_compose(self.sha)+' config --quiet')
        self.remote(gateway_validation_command(new+'/gateway.Caddyfile'))
        prepared = {'sha':self.sha,'old_web':PUBLIC_BASELINE,'old_api':BASELINE,'image_id':image,'public_manifest':manifest,
            'gateway_sha256':digest(gateway.encode()),'rollback_files':rollback,
            'baseline_capabilities':self.http_json('/v1/capabilities',public=False),'baseline_auth':self.http_json('/v1/auth/config'),
            'previous_attempt':getattr(self,'previous_attempt_evidence',None),
            'baseline_schema':self.baseline_schema, 'kitchen_sha':self.kitchen_before['sourceSha'],
            'baseline_catalog':self.http_json('/v1/customer-checkout/catalog'),
            'baseline_hours':self.http_json('/v1/customer-checkout/availability').get('hours'), 'baseline_environment':self.runtime_environment(),'enrollment_environment_sha256':digest(self.environment_bytes)}
        prepared['artifacts'] = self.prepared_artifacts(manifest)
        require(prepared['artifacts']['image_id'] == image and self.rollback_artifacts() == rollback, 'Preparation drift')
        self.save('prepared.json',prepared)
        print('Prepared enrollment-only kiosk API/gateway; active services unchanged',flush=True)

    def apply(self):
        self.source_checks(); self.ci(); self.runtime_old()
        proof = json.loads((self.private/'prepared.json').read_text())
        require((proof['sha'],proof['old_api'],proof['old_web']) == (self.sha,BASELINE,PUBLIC_BASELINE), 'Wrong preparation')
        require(proof.get('baseline_schema',33) == self.baseline_schema, 'Prepared baseline schema differs')
        require(self.prepared_artifacts(proof['public_manifest']) == proof['artifacts'] and
                self.rollback_artifacts() == proof['rollback_files'], 'Prepared or rollback artifacts changed')
        require(proof.get('enrollment_environment_sha256')==digest(self.environment_bytes),'Prepared private environment changed')
        require(proof.get('previous_attempt')==getattr(self,'previous_attempt_evidence',None),'Previous attempt evidence changed')
        key = self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0, 'Protected backup identity required')
        require(self.runtime_environment() == proof['baseline_environment'], 'Baseline running environment changed')
        self.maintenance = REMOTE+'/maintenance/kiosk-enrollment-'+self.lock_owner['id']
        contents = {'owner.json':json.dumps(self.lock_owner),'maintenance.json':json.dumps(transport.maintenance_config()),'compose.json':json.dumps(transport.maintenance_overlay(self.maintenance))}
        self.remote('python3 -c '+quote(transport.maintenance_write_script())+' '+quote(self.maintenance),input=json.dumps(contents))
        self.remote(transport.caddy_validation_command(self.maintenance+'/maintenance.json'))
        self.cleanup('acquire')
        self.remote(market.web_compose(PUBLIC_BASELINE)+' -f '+quote(self.maintenance+'/compose.json')+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        require(self.http('/v1/test/orders',method='POST')[0] == 503, 'Ingress did not close')
        self.remote(market.api_compose(BASELINE)+' stop --timeout 30 api',timeout=60)
        require(self.psql(market.DB,"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND (usename='pickchick_app' OR xact_start IS NOT NULL)") == '0', 'Competing database writer')
        self.quiescent()
        before = {'data':self.snapshot(),'runtime_data':self.runtime_snapshot(),'availability':self.availability_rows(),'ledger':self.ledger(),'acl':self.acl(),'worker_acl':self.worker_acl(),'neighbors':self.fingerprint(),'audit_rows':self.audit_rows()}
        expected = [{'version':name,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/name).read_bytes())} for name in self.baseline_migrations()]
        retry=getattr(self.args,'retry_retained_043',False)
        retained=retry or getattr(self.args,'previous_attempt_proof_dir',None)
        require(before['ledger'] == expected+([{'version':n,'scope':'cloud','checksum':h} for n,h in MIGRATION_HASHES.items() if n.startswith('043_')] if retained else []), 'Baseline migration ledger differs')
        suffix='retry-'+self.lock_owner['id']+'-' if retry else ''
        self.save(suffix+'before.json',before)
        backup = self.backup_restore(before['data']); self.save(suffix+'backup.json',backup)
        for _ in range(2):
            self.cleanup('status'); self.quiescent()
            self.remote(market.api_compose(self.sha)+' run --rm --no-deps --entrypoint node provision --input-type=module -e '+quote(owner_migration_program()),timeout=180)
            self.verify_data(before)
        # Retain schema043+044 (43 files) on rollback; run old API only, never old provision.
        self.remote(market.api_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        require(self.http_json('/health/ready',public=False)['ready'], 'Old image incompatible with retained schema043+044 (43 files)')
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
        self.save('result.json',{'source_sha':self.sha,'migration_files':43,'last_migration':44,'qr_worker_enabled':False,'enrollment_only':True,'backoffice_updated':False,'non_backoffice_assets_preserved':True,'runtime_acl_verified':True,'worker_preserved':True,'old_image_compatible':True,'backup':backup})
        print('Published enrollment-only kiosk API/gateway; QR worker off and all public assets preserved',flush=True)

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
        self.maintenance = REMOTE+'/maintenance/kiosk-enrollment-'+owner['id']
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
        require(self.http_json('/health/ready',public=False)['ready'], 'Old API incompatible with retained schema043+044 (43 files)')
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
        self.save('rollback.json',{'migration_files_retained':len(retained_ledger),'last_migration_retained':retained_ledger[-1]['version'],'acl_restored':True,'live_dump_restored':False,'finance_data_erased':False,'qr_worker_enabled':False})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['preflight','prepare','apply','rollback'])
    for name in ['sha','branch','expected-api-sha','expected-public-sha','expected-gateway-sha256']:
        parser.add_argument('--'+name,required=True)
    for name in ['ssh-key','backup-identity','ci-proof','environment','finance-proof']:
        parser.add_argument('--'+name,type=Path,required=name in ['ssh-key','environment','finance-proof'])
    parser.add_argument('--ci-run')
    parser.add_argument('--owner-id')
    parser.add_argument('--previous-attempt-proof-dir',type=Path,help='Original private completed retained043 rollback evidence for a new candidate')
    parser.add_argument('--retry-retained-043',action='store_true',help='Apply again using original completed rollback proofs; retain043 and baseline')
    args = parser.parse_args(); release = Release(args)
    require(not args.retry_retained_043 or args.action=='apply','Retained043 retry is apply-only')
    require(not (args.retry_retained_043 and args.previous_attempt_proof_dir),'Choose original retry or new candidate predecessor')
    try:
        if args.action == 'preflight':
            require(args.owner_id is None,'Owner UUID is rollback-only')
            release.preflight()
        elif args.action == 'rollback': release.resume_owned_rollback()
        else:
            require(args.owner_id is None,'Owner UUID is rollback-only')
            with release.deployment_lock(): getattr(release,args.action)()
    except Exception as error:
        release.record_error(error)
        if args.action=='preflight':
            print('Preflight stopped; active services unchanged. See private diagnostics.',file=sys.stderr)
            raise SystemExit(1)
        ingress = release.retain_failure(error)
        reason = str(error) if isinstance(error,market.GuardFailure) else 'Stopped; private diagnostics retained.'
        print(reason+' Deployment lock retained; ingress: '+ingress+'.',file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__': main()
