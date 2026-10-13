#!/usr/bin/env python3
"""Scoped payroll release from installed f01/schema052, preserving all flags, ACL and neighbors.

Prerequisite 053-056 stay dormant. Exact green CI, backup+restore, owner transaction,
live pins, immutable artifacts and the shared release lock are required.
Never roll back to an incompatible reader after new payroll data has been written.
"""
import importlib.util
import json
from pathlib import Path
import os
import re
import sys
import time
spec=importlib.util.spec_from_file_location('payroll_parent',Path(__file__).with_name('release-workforce-edit.py'))
e=importlib.util.module_from_spec(spec);sys.modules[spec.name]=e;spec.loader.exec_module(e)
w,base,market,lm=e.w,e.base,e.market,e.lm
require,digest,quote,REMOTE=e.require,e.digest,e.quote,e.REMOTE
BASELINE='f01cb45f441de1b664806c42aa93deb5cbb568b6'
MIGRATIONS=('053_cloud_channel_numbers.sql','054_cloud_kitchen_fulfillment.sql','055_cloud_channel_stops.sql','056_cloud_kitchen_screens.sql','057_cloud_workforce_payroll.sql')
e.BASELINE=w.BASELINE=lm.BASELINE=BASELINE

class Release(e.Release):
    def __init__(self,args):
        require(args.expected_api_sha==BASELINE,'Exact installed API required')
        require(re.fullmatch('[a-f0-9]{40}',args.expected_public_sha),'Public SHA required')
        for name in ('expected_compose_sha256','expected_gateway_sha256'):
            require(re.fullmatch('[a-f0-9]{64}',getattr(args,name,'')),'Reviewed hash required')
        require(re.fullmatch('sha256:[a-f0-9]{64}',args.expected_api_image),'Reviewed API image required')
        profile=market.ReleaseProfile('payroll-schema057',BASELINE,args.expected_public_sha,51,MIGRATIONS,
            base.workflow_jobs((market.REPO/'.github/workflows/ci.yml').read_text()),frozenset(),'payroll-release',(),exact_ci_jobs=True)
        market.Release.__init__(self,args,profile)
    def source_checks(self):
        market.Release.source_checks(self)
        self.execute(['git','merge-base','--is-ancestor',BASELINE,self.sha])
        require(not self.git('diff','--name-only',BASELINE,self.sha,'--','packages/commerce-core','services','infra/staging/compose.yaml','pnpm-lock.yaml'),'Unrelated runtime delta')
    def expected_ledger(self,migrated=False):
        names=self.baseline_migrations()+(list(MIGRATIONS) if migrated else [])
        return [{'version':n,'scope':'cloud','checksum':digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in names]
    def plan(self,phase,detail):
        return base.Release.plan(self,phase,{'api_only':True,'migrations':list(MIGRATIONS),'channels_dormant':True,'acl_unchanged':True,'compose_unchanged':True,'backup_restore_required':phase=='apply'})
    def compatible_rollback(self):
        query="SELECT count(*)::int n FROM (SELECT 1 FROM bo_workforce_records WHERE kind='payroll' OR payload ? 'paid_duration_ms' OR payload ? 'valid_until' UNION ALL SELECT 1 FROM bo_records WHERE kind='employee' AND (payload ? 'employment_status' OR payload ? 'position' OR payload->>'role'='staff')) t"
        require(json.loads(self.psql(market.DB,"SELECT row_to_json(t) FROM ("+query+") t"))=={'n':0},'Older reader incompatible with new workforce data; forward fix required')
    def restore(self,proof):
        self.compatible_rollback()
        return w.Release.restore(self,proof)
    def apply(self):
        proof=self.prepared()
        require(self.baseline()==proof['before'] and self.artifacts()==proof['artifacts'],'Baseline/artifacts drift')
        if not self.args.apply:return self.plan('apply',{})
        require(not (self.private/'apply-attempt.json').exists(),'Apply already dispatched; inspect outcome')
        backup=self.backup_restore();require(backup.get('restore')=='passed','Isolated restore required');self.save('backup.json',backup)
        require(self.baseline()==proof['before'],'Baseline drift during backup')
        self.save('apply-attempt.json',{'sha':self.sha,'at':time.time(),'backup':backup})
        raw=self.remote(market.api_compose(self.sha)+' run --rm --no-deps --entrypoint node provision infra/staging/payroll-owner.mjs deploy',timeout=240)
        result=json.loads(raw.splitlines()[-1]);self.save('owner-deploy.json',result)
        require(result=={'applied':list(MIGRATIONS),'existingDataPreserved':True,'privilegesAdded':[],'privilegesRemoved':[],'channelsDormant':True},'Owner evidence differs')
        self.verify_acl(proof);self.ready()
        require(self.neighbors()==proof['before']['neighbors'],'Neighbors changed before switch')
        try:
            self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
            self.ready();self.switch(REMOTE+'/current',REMOTE+'/releases/'+BASELINE,REMOTE+'/releases/'+self.sha)
            self.current(proof)
        except market.CommandUncertain:raise
        except Exception:
            self.restore(proof)
            raise
        self.save('applied.json',{'sha':self.sha,'schema':57,'channels_dormant':True,'acl_unchanged':True,'backup':backup,'at':time.time()})

def main():
    os.umask(0o077);release=Release(w.parse())
    try:release.run()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error,market.GuardFailure) else 'Release stopped; inspect private evidence and retained lock.',file=sys.stderr)
        raise SystemExit(1)
if __name__=='__main__':main()
