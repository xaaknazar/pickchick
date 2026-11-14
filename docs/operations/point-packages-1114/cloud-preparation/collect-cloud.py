#!/usr/bin/env python3
"""Read-only cloud checks. Issue a one-hour receipt only on the owner's later request."""
import argparse
import datetime
import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
SOURCE = '7e3120438461cbe561b01a587578060ff2cd9d3b'
BRANCH = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'
IMAGE = 'sha256:3f661b6dd3a18cef72b303aa9a21cf50bcc1b998751d272bff2b71f936b69786'
REMOTE = r'''
import json,subprocess,hashlib,datetime
def command(args,stdin=None):
 r=subprocess.run(args,input=stdin,text=True,capture_output=True,timeout=40)
 if r.returncode: raise RuntimeError('Read-only command failed; raw output suppressed')
 return r.stdout
def inspect():
 x=json.loads(command(['docker','inspect','pickchick-staging-api-1']))[0]
 env=dict(v.split('=',1) for v in x['Config']['Env'])
 return x,env
before,env=inspect()
sql="""BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
SELECT json_build_object(
 'ledger',(SELECT json_agg(row_to_json(m) ORDER BY version) FROM (SELECT version,checksum,scope FROM schema_migrations) m),
 'branchCount',(SELECT count(*) FROM branches WHERE id='7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'),
 'role',(SELECT json_build_object('super',rolsuper,'createdb',rolcreatedb,'createrole',rolcreaterole,'bypassrls',rolbypassrls,'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=pg_roles.oid)) FROM pg_roles WHERE rolname='pickchick_app'),
 'owners',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='pickchick_app')),
 'grants',(SELECT coalesce(json_agg(row_to_json(a) ORDER BY name,privilege),'[]') FROM (
 SELECT c.relname AS name,coalesce(r.rolname,'PUBLIC') AS grantee,x.privilege_type AS privilege,x.is_grantable AS grantable
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN LATERAL aclexplode(c.relacl) x LEFT JOIN pg_roles r ON r.oid=x.grantee
 WHERE n.nspname='public' AND c.relname IN ('pos_kitchen_restore_conflicts','pos_kitchen_restore_decisions') AND x.grantee<>c.relowner
 UNION ALL
 SELECT c.relname||'.'||a.attname,coalesce(r.rolname,'PUBLIC'),x.privilege_type,x.is_grantable
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN LATERAL aclexplode(a.attacl) x LEFT JOIN pg_roles r ON r.oid=x.grantee
 WHERE n.nspname='public' AND c.relname IN ('pos_kitchen_restore_conflicts','pos_kitchen_restore_decisions') AND x.grantee<>c.relowner
 ) a),
 'functionCount',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_pos_kitchen_restore_history'),
 'functionExternalGrants',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE n.nspname='public' AND p.proname='guard_pos_kitchen_restore_history' AND x.grantee<>p.proowner)
);
ROLLBACK;"""
db=json.loads(command(['docker','exec','-i','pickchick-staging-cloud-db-1','psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','pickchick_cloud'],sql))
ready=command(['docker','exec','pickchick-staging-api-1','node','-e',"fetch('http://127.0.0.1:3100/health/ready',{signal:AbortSignal.timeout(5000)}).then(r=>{console.log(r.status);if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]).strip()
after,envAfter=inspect()
if before['Id']!=after['Id'] or env!=envAfter: raise RuntimeError('API changed during inspection')
if any(env.get(k,'false') not in ('true','false') for k in ('CLOUD_POS_ORDER_SYNC_ENABLED','BACKOFFICE_ENABLED')): raise RuntimeError('Unexpected flag encoding')
db.update({'apiSourceCommit':before['Config']['Labels'].get('org.opencontainers.image.revision'),
 'apiImageId':before['Image'],'apiReady':ready=='200','apiContainerId':before['Id'],
 'environmentSha256':hashlib.sha256(json.dumps(env,sort_keys=True).encode()).hexdigest(),
 'posSyncEnabled':env.get('CLOUD_POS_ORDER_SYNC_ENABLED','false')=='true',
 'backofficeEnabled':env.get('BACKOFFICE_ENABLED','false')=='true',
 'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()})
print(json.dumps(db))
'''

def require(ok, check):
    if not ok:
        raise RuntimeError(check)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--issue-receipt', action='store_true')
    args = parser.parse_args()
    proof = json.loads((ROOT.parent / 'ci/ci-7e312043.json').read_text())
    require(proof['run']['head_sha'] == SOURCE and proof['run']['conclusion'] == 'success'
            and proof['run']['path'] == '.github/workflows/ci.yml'
            and proof['run']['head_repository']['full_name'] == 'xaaknazar/pickchick'
            and proof['jobs']['total_count'] == len(proof['jobs']['jobs']) == 11
            and all(j['head_sha'] == SOURCE and j['conclusion'] == 'success'
                    and j['status'] == 'completed' for j in proof['jobs']['jobs']), 'canonical_exact_source_ci')
    compatibility = json.loads((ROOT / 'compatibility-evidence.json').read_text())
    require(compatibility['sourceCommit'] == SOURCE and compatibility['ciRun'] == proof['run']['id'], 'compatibility_source')
    cmd = ['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',
           '-i',str(pathlib.Path.home()/'.ssh/pickchick_staging_ed25519'),
           'pickchick-ops@185.129.51.103','python3 -']
    result = subprocess.run(cmd, input=REMOTE, text=True, capture_output=True, timeout=100)
    require(result.returncode == 0, 'cloud_read_only_inspection_failed_raw_output_suppressed')
    observed = json.loads(result.stdout)
    require(observed['apiSourceCommit'] == SOURCE and observed['apiImageId'] == IMAGE, 'api_source_and_image')
    require(observed['ledger'] == json.loads((ROOT/'cloud-ledger-7e312043.json').read_text()), 'exact_cloud_077_ledger')
    require(observed['branchCount'] == 1 and observed['apiReady'], 'branch_and_readiness')
    require(observed['role'] == {'super':False,'createdb':False,'createrole':False,'bypassrls':False,'memberships':0}
            and observed['owners'] == 0, 'unprivileged_api_role')
    expected = []
    if observed['posSyncEnabled'] or observed['backofficeEnabled']:
        expected.append(('pos_kitchen_restore_conflicts','SELECT'))
    if observed['posSyncEnabled']:
        expected.append(('pos_kitchen_restore_conflicts','INSERT'))
    if observed['backofficeEnabled']:
        expected.extend([('pos_kitchen_restore_decisions','SELECT'),('pos_kitchen_restore_decisions','INSERT')])
    grants = observed['grants']
    require(all(g['grantee']=='pickchick_app' and not g['grantable'] for g in grants)
            and sorted((g['name'],g['privilege']) for g in grants)==sorted(expected)
            and observed['functionCount']==1 and observed['functionExternalGrants']==0, 'exact_cloud_072_grants')
    safe = {k:observed[k] for k in ('observedAt','apiSourceCommit','apiImageId','environmentSha256')}
    safe.update({'ledgerSha256':hashlib.sha256(json.dumps(observed['ledger'],sort_keys=True).encode()).hexdigest(),
                 'databaseVerified':True,'grantsVerified':True,'apiReady':True})
    baseline = ROOT/'preparation-baseline.json'
    if not args.issue_receipt:
        require(not baseline.exists(), 'preparation_baseline_exists_do_not_replace')
        baseline.write_text(json.dumps(safe,indent=2)+'\n')
        print('PREPARATION PASS: read-only checks; no cloud release receipt issued')
        return
    old = json.loads(baseline.read_text())
    require(all(safe[k]==old[k] for k in ('apiSourceCommit','apiImageId','environmentSha256','ledgerSha256')), 'cloud_changed_since_preparation')
    receipt = {'format':'pickchick-queue-recovery-cloud-v1','sourceCommit':SOURCE,
       'apiSourceCommit':SOURCE,'apiImageId':IMAGE,'branchId':BRANCH,'observedAt':observed['observedAt'],
       'migration':{'version':'072_cloud_kitchen_restore_review.sql','checksum':'d222ea9bf0aeebcaaeea96bc119c9b8aa3e1d9f032a1af7914aefe5c8981c5e2'},
       'databaseVerified':True,'grantsVerified':True,'apiReady':True,
       'schema023Compatible':True,'schema024Compatible':True,'flagsPreserved':True}
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    path=ROOT.parent/('cloud-receipt-'+stamp+'.json')
    require(not path.exists(),'receipt_exists')
    path.write_text(json.dumps(receipt,indent=2)+'\n')
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    path.with_suffix('.json.sha256').write_text(digest+'  '+path.name+'\n')
    print(json.dumps({'receipt':path.name,'sha256':digest,'observedAt':receipt['observedAt']}))

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        # Do not relay subprocess stderr, environment or connection details.
        print('STOP: '+(str(e) if isinstance(e,RuntimeError) else type(e).__name__),file=sys.stderr)
        sys.exit(1)
