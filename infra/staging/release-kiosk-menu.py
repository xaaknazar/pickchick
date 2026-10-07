#!/usr/bin/env python3
"""Guarded menu-only kiosk release from installed393/schema044.

Reuses enrollment release backup, maintenance, immutable artifacts, CAS and
owned rollback. No migrations, new environment, bank routes or worker changes.
Requires --enrollment-proof-dir with the original private393 prepared/result proof.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys

spec=importlib.util.spec_from_file_location('kiosk_menu_enrollment_base',Path(__file__).with_name('release-kiosk-qr.py'))
qr=importlib.util.module_from_spec(spec);sys.modules[spec.name]=qr;spec.loader.exec_module(qr)
market,base=qr.market,qr.base
require,quote,digest,REMOTE=qr.require,qr.quote,qr.digest,qr.REMOTE
BASELINE='39336a77f2f62bfbfe1ae98c65c5d428a9b11202'
PUBLIC_MANIFEST_SOURCE='d6cd144cc7cba9943b614e2a33552111f3f1f44d'
COMPOSE_BASELINE='4422715c2d88148da90056d0b1c9a3833df9817ea1ff7f833c849e2487355767'
GATEWAY_BASELINE='c220af2f979dac9e6db6615d8b3778b201198e6a97d89cfc649f6e983281e261'
INSERT_COLUMNS={'id','device_id','organization_id','branch_id','token_hash','expires_at'}
GRANTS='GRANT SELECT ON kiosk_sessions TO pickchick_app;GRANT INSERT('+','.join(sorted(INSERT_COLUMNS))+') ON kiosk_sessions TO pickchick_app;GRANT UPDATE(ended_at) ON kiosk_sessions TO pickchick_app;'


def gateway_candidate(raw,expected_hash):
    require(expected_hash==GATEWAY_BASELINE and digest(raw.encode())==expected_hash,'Installed393 gateway differs')
    require(raw.count('\t@kiosk_enrollment_check {')==1 and '\t@kiosk_menu_' not in raw,'Exact enrollment gateway anchor required')
    blocks=[]
    for name,method,paths in [('read','GET','config catalog availability'),('session','POST','sessions sessions/end')]:
        paths=' '.join('/v1/kiosk-checkout/'+path for path in paths.split())
        blocks.append(f'''\t@kiosk_menu_{name} {{
\t\tmethod {method}
\t\tpath {paths}
\t}}
\thandle @kiosk_menu_{name} {{
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
    block=''.join(blocks)
    result=raw.replace('\t@kiosk_enrollment_check {',block+'\t@kiosk_enrollment_check {',1)
    require(result.replace(block,'',1)==raw,'Existing gateway changed')
    return result


def compose_candidate(raw,environment):
    require(not environment and digest(raw.encode())==COMPOSE_BASELINE,'Installed393 compose differs')
    return raw


def owner_grants_program():
    return """import {createPool,transaction} from '@pickchick/database';
const url=new URL(process.env.CLOUD_DATABASE_URL);
if(url.username!=='pickchick_owner'||url.pathname!=='/pickchick_cloud')throw new Error('Owner database required');
const pool=createPool(url.href);
try{await transaction(pool,c=>c.query("""+json.dumps(GRANTS)+"""));
console.log(JSON.stringify({migrationFiles:43,lastMigration:44,qrWorkerEnabled:false,menuOnly:true}));}finally{await pool.end();}"""


# Specialize only this privately loaded module. The historical release helper
# remains byte-identical and its immutable393 evidence retains its meaning.
qr.BASELINE=qr.PUBLIC_BASELINE=BASELINE
qr.COMPOSE_BASELINE=COMPOSE_BASELINE
qr.MIGRATION_HASHES={};qr.NEW_TABLES=set();qr.MIGRATION_TABLES={}
qr.gateway_candidate=gateway_candidate;qr.compose_candidate=compose_candidate
qr.owner_migration_program=owner_grants_program


class Release(qr.Release):
    def __init__(self,args):
        require(sys.version_info>=(3,12),'Python3.12 required for PostgreSQL timestamps')
        require((args.expected_api_sha,args.expected_public_sha)==(BASELINE,BASELINE),'Exact installed393 baseline required')
        require(args.expected_gateway_sha256==GATEWAY_BASELINE,'Exact installed393 gateway required')
        folder=Path(args.enrollment_proof_dir).absolute()
        self.installed_proof=json.loads(qr.private_read(folder/'prepared.json'))
        result=json.loads(qr.private_read(folder/'result.json'))
        proof=self.installed_proof
        require(proof.get('sha')==BASELINE and proof.get('artifacts',{}).get('revision')==BASELINE and
                proof.get('image_id')==proof['artifacts'].get('image_id') and proof.get('gateway_sha256')==GATEWAY_BASELINE,
                'Original immutable393 preparation required')
        require(result.get('source_sha')==BASELINE and result.get('migration_files')==43 and result.get('last_migration')==44 and
                result.get('qr_worker_enabled') is False and result.get('runtime_acl_verified') is True,'Completed393 installation proof required')
        self.installed_proof_hashes={name:digest(qr.private_read(folder/name)) for name in ['prepared.json','result.json']}
        self.environment_bytes=b'{}';self.enrollment_environment={};self.baseline_schema=43
        profile=market.ReleaseProfile('kiosk-menu-schema044',BASELINE,BASELINE,43,(),base.CI_JOBS,
            frozenset(),'kiosk-menu-release',(),exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)

    def source_checks(self):
        market.Release.source_checks(self)
        folder=Path(self.args.enrollment_proof_dir).absolute()
        require(self.installed_proof_hashes=={name:digest(qr.private_read(folder/name)) for name in ['prepared.json','result.json']},'Installed393 proof changed')

    def baseline_migrations(self):
        names=sorted(Path(path).name for path in self.git('ls-tree','-r','--name-only',BASELINE,'--','db/cloud/migrations/').splitlines() if path.endswith('.sql'))
        require(len(names)==43 and [int(n[:3]) for n in names]==list(range(1,41))+[42,43,44],'Exact schema044 baseline required')
        return names

    def web_manifest_source(self):return PUBLIC_MANIFEST_SOURCE

    def runtime_old(self):
        market.Release.runtime_old(self)
        require(self.remote('docker inspect --format '+quote('{{.Image}}')+' '+market.API_CONTAINER)==self.installed_proof['image_id'],'Installed393 immutable image differs')
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0]==GATEWAY_BASELINE,'Mounted393 gateway differs')
        path=REMOTE+'/releases/'+BASELINE+'/infra/staging/compose.yaml'
        env=REMOTE+'/releases/'+BASELINE+'/release.env'
        require(self.file_hashes([path,env])=={path:COMPOSE_BASELINE,
            env:self.installed_proof['artifacts']['file_sha256'][env]},'Installed393 compose/environment changed')
        actual=json.loads(self.remote('docker exec '+market.GATEWAY+' cat /srv/public/.release.json'))
        require(actual==self.installed_proof['public_manifest'],'Installed393 public manifest changed')
        require(self.ledger()==self.expected_ledger(),'Installed schema044 ledger changed')
        self.verify_qr_off()

    def expected_ledger(self):
        return [{'version':n,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in self.baseline_migrations()]

    def verify_qr_off(self):
        require(self.runtime_environment().get('KIOSK_KASPI_QR_ENABLED')==digest(b'false'),'QR worker must remain disabled')
        require(self.psql(market.DB,"SELECT count(*) FROM commerce_provider_accounts WHERE provider='kaspi-qr' AND enabled")=='0','QR account became enabled')

    def save(self,name,value):
        if name=='prepared.json':value={**value,'installed393_proof':self.installed_proof_hashes}
        if name in ['prepared.json','result.json','preflight.json']:
            value={**value,'baseline_api':BASELINE,'baseline_public':BASELINE,'baseline_migrations':43,
                'candidate_migrations':43,'enrollment_only':False,'menu_only':True,'guest_checkout_enabled':False}
        return super().save(name,value)

    def apply(self):
        proof=json.loads(qr.private_read(self.private/'prepared.json'))
        require(proof.get('installed393_proof')==self.installed_proof_hashes,'Prepared installed393 proof differs')
        super().apply()

    def verify_environment(self,before):
        super().verify_environment(before)
        self.verify_qr_off()

    def verify_data(self,before):
        require(self.ledger()==before['ledger']==self.expected_ledger(),'Menu release must not migrate')
        self.compare_runtime(before)
        wanted=list(before['acl'])
        rows=[{'name':'kiosk_sessions','kind':'r','column':None,'privilege':'SELECT','grantable':False}]
        rows += [{'name':'kiosk_sessions','kind':'r','column':column,'privilege':'INSERT','grantable':False} for column in INSERT_COLUMNS]
        rows += [{'name':'kiosk_sessions','kind':'r','column':'ended_at','privilege':'UPDATE','grantable':False}]
        for row in rows:
            if row not in wanted:wanted.append(row)
        key=lambda row:(row['name'],row['kind'],row['column'] or '',row['privilege'],row['grantable'])
        require(sorted(map(key,self.acl()))==sorted(map(key,wanted)),'Only bounded kiosk session grants allowed')
        require(self.worker_acl()==before['worker_acl'],'Bank worker ACL changed')

    def verify_public(self):
        proof=json.loads(qr.private_read(self.private/'prepared.json'))
        for path,key in [('/v1/auth/config','baseline_auth'),('/v1/customer-checkout/catalog','baseline_catalog')]:
            require(self.http_json(path)==proof[key],'Existing public API changed')
        require(self.http_json('/v1/customer-checkout/availability').get('hours')==proof['baseline_hours'],'Mobile hours changed')
        require(self.http_json('/kitchen-live/health')['sourceSha']==proof['kitchen_sha'],'Kitchen bridge changed')
        actual=json.loads(self.remote('docker exec '+market.GATEWAY+' cat /srv/public/.release.json'))
        require(actual==proof['public_manifest'] and self.prepared_artifacts(actual)==proof['artifacts'],'Public assets/artifacts changed')
        code,body=self.http('/backoffice/finance.js')
        require(code==200 and digest(body)==actual['files']['backoffice/finance.js'],'Finance asset changed')
        branch='/v1/admin/backoffice/branches/7a6f6d98-395d-4462-b5e4-b0364a4a8ec1/finance'
        require(self.http(branch+'?start_date=2026-10-01&end_date=2026-10-31')[0]==401,'Anonymous finance read accepted')
        require(self.probe_json(branch+'/commands',{'request_id':'00000000-0000-4000-a000-000000000001','reason':'Anonymous authorization probe','command':{'type':'void','id':'00000000-0000-4000-a000-000000000002'}})[0]==401,'Anonymous finance command accepted')
        for path in ['config','catalog','availability']:
            require(self.http('/v1/kiosk-checkout/'+path)[0]==400,'Anonymous menu read accepted or route absent')
        for path in ['sessions','sessions/end','enrollment/check']:
            require(self.http('/v1/kiosk-checkout/'+path,method='POST')[0]==400,'Anonymous kiosk session accepted or route absent')
        for path,method in [('/v1/kiosk-checkout/quotes','POST'),('/v1/kiosk-checkout/orders','POST'),('/v1/kiosk-checkout/orders/00000000-0000-4000-a000-000000000001/payment','POST'),('/v1/customer-checkout/test-payments','POST'),('/v1/integrations/tiptoppay/test-checkout','GET'),('/v1/integrations/tiptoppay/checkout','GET')]:
            require(self.http(path,method=method)[0]==404,'Guest/payment feature exposed')
        self.verify_qr_off()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['preflight','prepare','apply','rollback'])
    for name in ['sha','branch','expected-api-sha','expected-public-sha','expected-gateway-sha256']:
        parser.add_argument('--'+name,required=True)
    for name in ['ssh-key','backup-identity','ci-proof','enrollment-proof-dir']:
        parser.add_argument('--'+name,type=Path,required=name in ['ssh-key','enrollment-proof-dir'])
    parser.add_argument('--ci-run');parser.add_argument('--owner-id')
    args=parser.parse_args();release=Release(args)
    try:
        if args.action=='rollback':release.resume_owned_rollback()
        else:
            require(args.owner_id is None,'Owner UUID is rollback-only')
            if args.action=='preflight':release.preflight()
            else:
                with release.deployment_lock():getattr(release,args.action)()
    except Exception as error:
        release.record_error(error)
        if args.action=='preflight':
            print('Read-only preflight stopped; inspect private diagnostics.',file=sys.stderr)
        else:
            ingress=release.retain_failure(error)
            print('Menu release stopped; deployment lock retained; ingress: '+ingress,file=sys.stderr)
        raise SystemExit(1)


if __name__=='__main__':main()
