#!/usr/bin/env python3
"""Workforce corrections over exact schema052; preserves compose, ACL and all other services.

Default is inspection. Apply requires immutable published source, exact green CI,
shared release lock, encrypted backup and isolated restore. Rollback to the older
reader is forbidden after any tombstone is written; use a compatible forward fix.
"""
import importlib.util
import json
from pathlib import Path
import os
import re
import sys
import time
spec=importlib.util.spec_from_file_location('workforce_edit_parent',Path(__file__).with_name('release-workforce.py'))
w=importlib.util.module_from_spec(spec);sys.modules[spec.name]=w;spec.loader.exec_module(w)
base,market,lm=w.base,w.market,w.lm
require,digest,quote,REMOTE=w.require,w.digest,w.quote,w.REMOTE
BASELINE='8468e3aed72c5355cf8b8d998df1de14ca55b03f'
w.BASELINE=lm.BASELINE=BASELINE

def compose_candidate(text,expected):
    require(digest(text.encode())==expected,'Installed compose differs')
    require(text.count('      WORKFORCE_ENABLED: "true"\n')==1,'Installed workforce must be enabled')
    return text

class Release(w.Release):
    def __init__(self,args):
        require(args.expected_api_sha==BASELINE,'Exact workforce baseline required')
        require(re.fullmatch('[a-f0-9]{40}',args.expected_public_sha),'Reviewed public SHA required')
        for name in ('expected_compose_sha256','expected_gateway_sha256'):
            require(re.fullmatch('[a-f0-9]{64}',getattr(args,name,'')),'Reviewed hash required')
        require(re.fullmatch('sha256:[a-f0-9]{64}',args.expected_api_image),'Reviewed API image required')
        profile=market.ReleaseProfile('workforce-edit-schema052',BASELINE,args.expected_public_sha,51,(),
            base.workflow_jobs((market.REPO/'.github/workflows/ci.yml').read_text()),frozenset(),'workforce-edit-release',(),exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)
    def baseline_migrations(self):
        names=sorted(Path(p).name for p in self.git('ls-tree','-r','--name-only',BASELINE,'--','db/cloud/migrations/').splitlines() if p.endswith('.sql'))
        require([int(n[:3]) for n in names]==list(range(1,41))+list(range(42,53)),'Exact schema052 required')
        return names
    def expected_ledger(self,migrated=False):
        return [{'version':n,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in self.baseline_migrations()]
    def baseline(self):
        a=self.args
        require(self.running_revision()==BASELINE and self.api_image()==a.expected_api_image,'Live API baseline differs')
        require(self.remote('readlink -f '+REMOTE+'/current')==REMOTE+'/releases/'+BASELINE,'API pointer differs')
        require(self.remote('docker image inspect --format '+quote('{{.Id}}')+' pickchick-api:'+BASELINE)==a.expected_api_image,'Rollback image differs')
        require(self.ledger()==self.expected_ledger(),'Schema052 required')
        self.runtime_acl();self.verify_public()
        env=self.runtime_environment()
        require(env.get('WORKFORCE_ENABLED')==digest(b'true'),'Workforce must be enabled')
        return {'candidate':compose_candidate(self.read_text(self.compose_path(BASELINE)),a.expected_compose_sha256),
                'environment':env,'rollback':self.rollback_artifacts(),'neighbors':self.neighbors(),'acl':self.acl(),
                'capabilities':self.http_json('/v1/capabilities',public=False)}
    def plan(self,phase,detail):
        return base.Release.plan(self,phase,{'api_only':True,'migrations':[],'acl_unchanged':True,'compose_unchanged':True,'backup_restore_required':phase=='apply'})
    def verify_acl(self,proof):
        require(self.acl()==proof['before']['acl'],'ACL changed')
    def compatible_rollback(self):
        query="SELECT count(*)::int n FROM (SELECT 1 FROM bo_workforce_records WHERE payload->>'deleted'='true' UNION ALL SELECT 1 FROM bo_records WHERE kind='employee' AND payload->>'deleted'='true') t"
        program="import{createPool}from'@pickchick/database';const p=createPool(process.env.CLOUD_DATABASE_URL);try{console.log(JSON.stringify((await p.query("+json.dumps(query)+")).rows[0]));}finally{await p.end()}"
        result=json.loads(self.remote('docker exec '+market.API_CONTAINER+' node --input-type=module -e '+quote(program)))
        require(result=={'n':0},'Older reader cannot read deletions; compatible forward fix required, never erase history')
    def restore(self,proof):
        self.compatible_rollback()
        return super().restore(proof)
    def apply(self):
        proof=self.prepared()
        require(self.baseline()==proof['before'] and self.artifacts()==proof['artifacts'],'Baseline/artifacts drift')
        if not self.args.apply:return self.plan('apply',{})
        require(not (self.private/'apply-attempt.json').exists(),'Apply already dispatched; inspect original outcome')
        backup=self.backup_restore();require(backup.get('restore')=='passed','Isolated restore required');self.save('backup.json',backup)
        require(self.baseline()==proof['before'],'Baseline drift during backup')
        self.save('apply-attempt.json',{'sha':self.sha,'at':time.time(),'backup':backup})
        try:
            self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
            self.ready();self.switch(REMOTE+'/current',REMOTE+'/releases/'+BASELINE,REMOTE+'/releases/'+self.sha)
            self.current(proof)
        except market.CommandUncertain:
            raise
        except Exception:
            self.restore(proof)
            raise
        self.save('applied.json',{'sha':self.sha,'schema':52,'migrations':[],'acl_unchanged':True,'backup':backup,'at':time.time()})

def main():
    os.umask(0o077);release=Release(w.parse())
    try:release.run()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error,market.GuardFailure) else 'Release stopped; inspect private evidence and retained lock.',file=sys.stderr)
        raise SystemExit(1)
if __name__=='__main__':main()
