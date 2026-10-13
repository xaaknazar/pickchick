#!/usr/bin/env python3
"""Guarded device inventory/telemetry release over installed ad7132/schema057.

Pairing remains off until the independently verified Windows migration/worker rollout.
Only the API is replaced. Requires exact green CI, backup/restore, CAS pins and lock.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
spec=importlib.util.spec_from_file_location('device_center_parent',Path(__file__).with_name('release-workforce-edit.py'))
e=importlib.util.module_from_spec(spec);sys.modules[spec.name]=e;spec.loader.exec_module(e)
w,base,market,lm=e.w,e.base,e.market,e.lm
require,digest,quote,REMOTE=e.require,e.digest,e.quote,e.REMOTE
BASELINE='ad7132fa5f4ae93bfa0693c8dd5e790c885d0201'
MIGRATION='058_cloud_device_center.sql'
FLAG='DEVICE_CENTER_ENABLED'
e.BASELINE=w.BASELINE=lm.BASELINE=BASELINE

def compose_candidate(text,expected):
    require(digest(text.encode())==expected,'Installed compose differs')
    require(FLAG not in text,'Device center already configured')
    require(text.count('\n  api:\n')==1,'API boundary ambiguous')
    start=text.index('\n  api:\n')+1
    match=re.search(r'^  [A-Za-z][A-Za-z0-9_-]*:',text[start+len('  api:\n'):],re.M)
    end=start+len('  api:\n')+match.start() if match else len(text)
    section=text[start:end];anchor='      APP_ENV: staging\n';line=f'      {FLAG}: "true"\n'
    require(section.count(anchor)==1,'API environment anchor differs')
    candidate=text[:start]+section.replace(anchor,line+anchor)+text[end:]
    require(candidate.replace(line,'',1)==text,'Unrelated compose change')
    return candidate

class Release(e.Release):
    def __init__(self,args):
        require(args.expected_api_sha==BASELINE,'Exact installed schema057 API required')
        require(re.fullmatch('[a-f0-9]{40}',args.expected_public_sha),'Reviewed public SHA required')
        for name in ('expected_compose_sha256','expected_gateway_sha256'):
            require(re.fullmatch('[a-f0-9]{64}',getattr(args,name,'')),'Reviewed hash required')
        require(re.fullmatch('sha256:[a-f0-9]{64}',args.expected_api_image),'Reviewed image required')
        profile=market.ReleaseProfile('device-center-schema058',BASELINE,args.expected_public_sha,56,(MIGRATION,),base.workflow_jobs((market.REPO/'.github/workflows/ci.yml').read_text()),frozenset(),'device-center-release',(),exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)
    def source_checks(self):
        market.Release.source_checks(self)
        self.execute(['git','merge-base','--is-ancestor',BASELINE,self.sha])
        allowed={'packages/backoffice-core/src/device-registry.ts','packages/backoffice-core/src/device-presence.ts','packages/contracts/src/device-access.ts','packages/contracts/openapi.json','services/api/src/device-registry-controller.ts','services/api/src/index.ts'}
        changed=set(self.git('diff','--name-only',BASELINE,self.sha,'--','services/api','packages/backoffice-core','packages/contracts','packages/commerce-core','infra/staging/compose.yaml','pnpm-lock.yaml').splitlines())
        require(changed<=allowed,'Unrelated API/payment dependency delta')
        # Other controllers already installed must remain byte-for-byte identical.
    def baseline_migrations(self):
        names=sorted(Path(p).name for p in self.git('ls-tree','-r','--name-only',BASELINE,'--','db/cloud/migrations/').splitlines() if p.endswith('.sql'))
        require([int(n[:3]) for n in names]==list(range(1,41))+list(range(42,58)),'Exact schema057 required')
        return names
    def expected_ledger(self,migrated=False):
        return [{'version':n,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in self.baseline_migrations()+([MIGRATION] if migrated else [])]
    def baseline(self):
        a=self.args
        require(self.running_revision()==BASELINE and self.api_image()==a.expected_api_image,'Live API baseline differs')
        require(self.remote('readlink -f '+REMOTE+'/current')==REMOTE+'/releases/'+BASELINE,'API pointer differs')
        require(self.remote('docker image inspect --format '+quote('{{.Id}}')+' pickchick-api:'+BASELINE)==a.expected_api_image,'Rollback image differs')
        require(self.ledger()==self.expected_ledger(),'Exact schema057 ledger required')
        self.runtime_acl();self.verify_public();env=self.runtime_environment()
        require(env.get(FLAG) is None,'Device center already configured')
        require(env.get('BACKOFFICE_ENABLED')==digest(b'true') and env.get('WORKFORCE_ENABLED')==digest(b'true'),'Existing backoffice/workforce required')
        require(env.get('BACKOFFICE_DEVICE_ACCESS_ENABLED') in (None,digest(b'false')),'Pairing must remain separately gated')
        return {'candidate':compose_candidate(self.read_text(self.compose_path(BASELINE)),a.expected_compose_sha256),'environment':env,'rollback':self.rollback_artifacts(),'neighbors':self.neighbors(),'acl':self.acl(),'capabilities':self.http_json('/v1/capabilities',public=False)}
    def plan(self,phase,detail):
        return base.Release.plan(self,phase,{'api_only':True,'migrations':[MIGRATION],'device_center':True,'pairing':False,'backup_restore_required':phase=='apply'})
    def owner_plan(self,action):
        result=self.remote(market.api_compose(self.sha)+' run --rm --no-deps --entrypoint node provision infra/staging/device-center-owner.mjs '+quote(action),timeout=240)
        return json.loads(result.splitlines()[-1])
    def verify_acl(self,proof):
        before={base.acl_key(r) for r in proof['before']['acl']};after=self.acl()
        raw=self.execute(['node','--input-type=module','-e',"import{PRIVILEGES}from'./infra/staging/device-center-owner.mjs';console.log(JSON.stringify(PRIVILEGES))"]).decode()
        allowed={tuple(v or None for v in p.split('|')) for p in json.loads(raw)}
        require({base.acl_key(r) for r in after}==before|allowed and all(not r['grantable'] for r in after),'Unexpected ACL delta')
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
    def apply(self):
        proof=self.prepared()
        require(self.baseline()==proof['before'] and self.artifacts()==proof['artifacts'],'Baseline/artifacts drift')
        if not self.args.apply:return self.plan('apply',{})
        require(not (self.private/'apply-attempt.json').exists(),'Apply already dispatched; inspect outcome')
        backup=self.backup_restore();require(backup.get('restore')=='passed','Isolated restore required');self.save('backup.json',backup)
        require(self.baseline()==proof['before'],'Baseline drift during backup')
        self.save('apply-attempt.json',{'sha':self.sha,'at':time.time(),'backup':backup})
        result=self.owner_plan('deploy');self.save('owner-deploy.json',result)
        require(result.get('applied')==[MIGRATION] and result.get('existingDataPreserved') is True and result.get('privilegesRemoved')==[] and result.get('pairingEnabled') is False,'Owner evidence differs')
        self.verify_acl(proof)
        require(self.neighbors()==proof['before']['neighbors'],'Neighbors changed before switch')
        try:
            self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
            self.ready();self.switch(REMOTE+'/current',REMOTE+'/releases/'+BASELINE,REMOTE+'/releases/'+self.sha)
            self.current(proof)
        except market.CommandUncertain:raise
        except Exception:
            self.restore(proof)
            raise
        self.save('applied.json',{'sha':self.sha,'schema':58,'pairing':False,'backup':backup,'at':time.time()})
    def restore(self,proof):
        # ad7132 understands imported workforce payroll. New device tables remain additive.
        w.Release.restore(self,proof)
        self.save('rollback.json',{'sha':self.sha,'restored_api':BASELINE,'schema_retained':58,'history_retained':True,'database_restore':False})

def main():
    os.umask(0o077);release=Release(w.parse())
    try:release.run()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error,market.GuardFailure) else 'Release stopped; inspect private evidence and retained lock.',file=sys.stderr)
        raise SystemExit(1)
if __name__=='__main__':main()
