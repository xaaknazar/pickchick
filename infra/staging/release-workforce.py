#!/usr/bin/env python3
"""Guarded hourly workforce API release over f277/schema050; canonical portal is released separately.

prepare/apply/rollback default to read-only. Exact green CI, fresh pins, shared lock,
immutable artifacts, encrypted backup/isolated restore and owner transaction are mandatory.
051 creates dormant device tables with NO device grants or flag activation; 052 adds workforce.
Only WORKFORCE_ENABLED is added to the live compose. Bank, kiosk, gateway, credentials and
public pointers are preserved. Rollback retains additive schema and all workforce history.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid
spec=importlib.util.spec_from_file_location('workforce_live_base',Path(__file__).with_name('release-live-menu.py'))
lm=importlib.util.module_from_spec(spec);sys.modules[spec.name]=lm;spec.loader.exec_module(lm)
base,market=lm.base,lm.market
require,digest,quote,REMOTE=lm.require,lm.digest,lm.quote,lm.REMOTE
BASELINE='f277d1a45a891057f14db46962406af7723e46d0'
MIGRATIONS=('051_cloud_device_registry.sql','052_cloud_workforce.sql')
FLAG='WORKFORCE_ENABLED'
TABLES=('bo_workforce_records','bo_workforce_events','bo_workforce_periods','bo_workforce_commands')
PRIVILEGES=frozenset([(t,None,p) for t in TABLES for p in ('SELECT','INSERT')]+
 [(TABLES[0],c,'UPDATE') for c in ('revision','payload','updated_at')]+
 [(TABLES[2],c,'UPDATE') for c in ('closed','revision','snapshot')])
lm.BASELINE=BASELINE

def compose_candidate(text, expected):
    require(digest(text.encode())==expected,'Installed compose differs')
    require(FLAG not in text and text.count('\n  api:\n')==1,'Workforce flag exists or ambiguous API')
    start=text.index('\n  api:\n')+1
    next_service=re.search(r'^  [A-Za-z][A-Za-z0-9_-]*:',text[start+len('  api:\n'):],re.M)
    end=start+len('  api:\n')+next_service.start() if next_service else len(text)
    section=text[start:end];anchor='      APP_ENV: staging\n';line=f'      {FLAG}: "true"\n'
    require(section.count(anchor)==1,'API environment anchor differs')
    result=text[:start]+section.replace(anchor,line+anchor)+text[end:]
    require(result.replace(line,'',1)==text,'Unrelated compose delta')
    return result
lm.compose_candidate=compose_candidate

class Release(lm.Release):
    def __init__(self,args):
        require(args.expected_api_sha==BASELINE,'Exact installed f277 API baseline required')
        for name in ('expected_public_sha',):
            require(re.fullmatch('[a-f0-9]{40}',getattr(args,name,'')),'Reviewed SHA required')
        for name in ('expected_compose_sha256','expected_gateway_sha256'):
            require(re.fullmatch('[a-f0-9]{64}',getattr(args,name,'')),'Reviewed hash required')
        require(re.fullmatch('sha256:[a-f0-9]{64}',args.expected_api_image),'Reviewed API image required')
        profile=market.ReleaseProfile('workforce-schema052',BASELINE,args.expected_public_sha,49,MIGRATIONS,
            base.workflow_jobs((market.REPO/'.github/workflows/ci.yml').read_text()),frozenset(),'workforce-release',(),exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)

    def source_checks(self):
        market.Release.source_checks(self)
        self.execute(['git','merge-base','--is-ancestor',BASELINE,self.sha])
        require(not self.git('diff','--name-only',BASELINE,self.sha,'--','packages/commerce-core','services/api/src/customer-checkout-controller.ts',
                            'services/api/src/catalog-publication-listener.ts','infra/staging/compose.yaml'),
                'Bank/menu fixes or live compose changed outside workforce')

    def expected_ledger(self,migrated=False):
        names=self.baseline_migrations()+ (list(MIGRATIONS) if migrated else [])
        return [{'version':n,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in names]

    def baseline(self):
        a=self.args
        require(self.running_revision()==BASELINE and self.api_image()==a.expected_api_image,'Live API baseline differs')
        require(self.remote('readlink -f '+REMOTE+'/current')==REMOTE+'/releases/'+BASELINE,'API pointer differs')
        require(self.remote('docker image inspect --format '+quote('{{.Id}}')+' pickchick-api:'+BASELINE)==a.expected_api_image,'Rollback image differs')
        require(self.ledger()==self.expected_ledger(),'Exact schema050 required')
        self.runtime_acl();self.verify_public()
        env=self.runtime_environment()
        require(env.get(FLAG) is None,'Workforce already configured')
        require(env.get('BACKOFFICE_ENABLED')==digest(b'true'),'Scoped backoffice required')
        require(env.get('BACKOFFICE_DEVICE_ACCESS_ENABLED') in (None,digest(b'false')),'Device access must remain disabled')
        return {'candidate':compose_candidate(self.read_text(self.compose_path(BASELINE)),a.expected_compose_sha256),
                'environment':env,'rollback':self.rollback_artifacts(),'neighbors':self.neighbors(),'acl':self.acl(),
                'capabilities':self.http_json('/v1/capabilities',public=False)}

    def plan(self,phase,detail):
        return base.Release.plan(self,phase,{'api_only':True,'migrations':list(MIGRATIONS),'workforce_enabled':True,
            'devices_enabled':False,'public_and_banks_unchanged':True,'backup_restore_required':phase=='apply'})

    def verify_acl(self,proof):
        before={base.acl_key(r) for r in proof['before']['acl']};after=self.acl()
        require({base.acl_key(r) for r in after}==before|PRIVILEGES and all(not r['grantable'] for r in after),'Unexpected ACL delta')

    def current(self,proof,flag=True):
        require(self.running_revision()==self.sha and self.api_image()==proof['artifacts']['image'],'Installed API differs')
        require(self.remote('readlink -f '+REMOTE+'/current')==REMOTE+'/releases/'+self.sha,'API pointer differs')
        require(self.ledger()==self.expected_ledger(True),'Migration ledger differs')
        self.verify_acl(proof)
        require(self.neighbors()==proof['before']['neighbors'],'Neighbor container changed')
        require(self.rollback_artifacts()==proof['before']['rollback'],'Rollback artifacts changed')
        require(self.artifacts()==proof['artifacts'],'Candidate bytes changed')
        base.verify_environment_delta(proof['before']['environment'],self.runtime_environment(),{FLAG:'true'},release_sha_may_change=True)
        self.runtime_acl();self.verify_public()
        require(self.http_json('/v1/capabilities',public=False)==proof['before']['capabilities'],'Capabilities changed')

    def backup_restore(self):
        # This Mac uses its own authorized backup identity. Do not replace the server's
        # global recipient belonging to the other Mac, and never send the private key to disk.
        key=self.args.backup_identity
        require(key and key.is_file() and not any(p.is_symlink() for p in [key,*key.parents]) and key.stat().st_mode&0o077==0,'Protected backup identity required')
        recipient=self.execute(['age-keygen','-y',str(key)]).decode().strip()
        require(re.fullmatch('age1[0-9a-z]{58}',recipient),'Native backup recipient required')
        suffix=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+uuid.uuid4().hex[:8]
        backup=f'{REMOTE}/backups/cloud-workforce-{suffix}.dump.age'
        script=f"""set -euo pipefail
umask 077
exec 9>{REMOTE}/backups/.lock
flock -n 9
test ! -e {backup}
trap 'rm -f {backup}.tmp' EXIT
docker exec {market.DB_CONTAINER} pg_dump -U postgres -d {market.DB} --format=custom --no-owner --no-acl | age -r {quote(recipient)} -o {backup}.tmp
test -s {backup}.tmp
mv {backup}.tmp {backup}
sha256sum {backup} > {backup}.sha256
"""
        ledger,tables=self.ledger(),self.table_names(market.DB)
        self.remote('bash -o pipefail -c '+quote(script),timeout=180)
        self.remote('sha256sum --check '+backup+'.sha256')
        database='pickchick_restore_workforce_'+uuid.uuid4().hex[:12]
        created=False
        try:
            self.remote(f'docker exec {market.DB_CONTAINER} createdb -U postgres {database}');created=True
            pipeline=f'age --decrypt --identity /dev/stdin {backup} | docker exec -i {market.DB_CONTAINER} pg_restore -U postgres -d {database} --exit-on-error --no-owner --no-acl'
            self.remote('bash -o pipefail -c '+quote(pipeline),input=key.read_bytes(),timeout=180)
            require(self.ledger(database)==ledger and self.table_names(database)==tables,'Isolated restored backup differs')
        finally:
            if created:self.remote(f'docker exec {market.DB_CONTAINER} dropdb -U postgres {database}')
        return {'path':backup,'sha256':self.remote('sha256sum '+backup).split()[0],'restore':'passed','recipient':recipient}

    def apply(self):
        proof=self.prepared()
        require(self.baseline()==proof['before'] and self.artifacts()==proof['artifacts'],'Baseline/artifacts drift')
        if not self.args.apply:return self.plan('apply',{})
        require(not (self.private/'apply-attempt.json').exists(),'Apply already dispatched; inspect original outcome')
        key=self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode&0o077==0,'Protected backup identity required')
        backup=self.backup_restore();require(backup.get('restore')=='passed','Isolated restore required');self.save('backup.json',backup)
        require(self.baseline()==proof['before'],'Baseline drift during backup')
        self.save('apply-attempt.json',{'sha':self.sha,'at':time.time(),'backup':backup})
        result=self.remote(market.api_compose(self.sha)+' run --rm --no-deps --entrypoint node provision infra/staging/workforce-owner.mjs deploy',timeout=240)
        result=json.loads(result.splitlines()[-1]);self.save('owner-deploy.json',result)
        require(result.get('applied')==list(MIGRATIONS) and result.get('existingDataPreserved') is True and result.get('privilegesRemoved')==[],'Owner result differs')
        self.verify_acl(proof);self.ready()
        require(self.neighbors()==proof['before']['neighbors'],'Neighbors drifted before switch')
        # Transport uncertainty retains the lock; never repeat a possibly applied operation.
        try:
            self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
            self.ready();self.switch(REMOTE+'/current',REMOTE+'/releases/'+BASELINE,REMOTE+'/releases/'+self.sha)
            self.current(proof)
        except market.CommandUncertain:
            raise
        except Exception:
            self.restore(proof)
            raise
        self.save('applied.json',{'sha':self.sha,'schema':52,'workforce_enabled':True,'devices_enabled':False,'backup':backup,'at':time.time()})

    def restore(self,proof):
        require(self.ledger()==self.expected_ledger(True),'Rollback migration drift')
        self.verify_acl(proof)
        require(self.neighbors()==proof['before']['neighbors'] and self.rollback_artifacts()==proof['before']['rollback'],'Rollback baseline drift')
        pointer=self.remote('readlink -f '+REMOTE+'/current')
        require(pointer in (REMOTE+'/releases/'+BASELINE,REMOTE+'/releases/'+self.sha),'Foreign pointer')
        self.remote(market.api_compose(BASELINE)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        if pointer.endswith(self.sha):self.switch(REMOTE+'/current',pointer,REMOTE+'/releases/'+BASELINE)
        require(self.running_revision()==BASELINE and self.api_image()==self.args.expected_api_image,'Rollback API differs')
        self.ready();self.verify_public()
        require(self.runtime_environment()==proof['before']['environment'],'Restored environment differs')
        require(self.neighbors()==proof['before']['neighbors'],'Restored neighbors differ')
        self.save('rollback.json',{'sha':self.sha,'restored_api':BASELINE,'schema_retained':52,'history_retained':True,'database_restore':False})

    def rollback(self):
        proof=self.prepared()
        require(self.running_revision() in (BASELINE,self.sha),'Foreign API revision; stop rollback')
        if not self.args.apply:return self.plan('rollback',{})
        self.restore(proof)

def parse(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['prepare','apply','rollback'])
    for name in ['sha','branch','expected-api-sha','expected-public-sha','expected-api-image','expected-compose-sha256','expected-gateway-sha256']:
        p.add_argument('--'+name,required=True)
    for name in ['ssh-key','backup-identity','ci-proof']:
        p.add_argument('--'+name,type=Path,required=name=='ssh-key')
    p.add_argument('--ci-run');p.add_argument('--owner-id');p.add_argument('--apply',action='store_true')
    return p.parse_args(argv)

def main():
    os.umask(0o077);release=Release(parse())
    try:release.run()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error,market.GuardFailure) else 'Release stopped; inspect private evidence and retained lock.',file=sys.stderr)
        raise SystemExit(1)
if __name__=='__main__':main()
