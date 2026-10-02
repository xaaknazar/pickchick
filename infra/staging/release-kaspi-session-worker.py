from pathlib import Path
import argparse, subprocess, shlex, json, runpy, uuid, os, re
os.umask(0o077)
parser=argparse.ArgumentParser(description="Install the CI-verified Kaspi connectivity worker without changing the API/public releases")
parser.add_argument("--sha", required=True)
parser.add_argument("--ci-proof", type=Path, required=True)
parser.add_argument("--prepared", type=Path, required=True)
parser.add_argument("--ssh-key", type=Path, required=True)
parser.add_argument('--expected-api-sha', default='f83794ce68c10906d2924a3a04351f7550d62b40')
parser.add_argument('--expected-public-sha', default='9e2e5dcd605bd5273e23e66380a0bf8b37b36736')
args=parser.parse_args()
assert re.fullmatch('[a-f0-9]{40}',args.expected_api_sha) and re.fullmatch('[a-f0-9]{40}',args.expected_public_sha)
root=Path(__file__).resolve().parents[2]; sha=args.sha
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==sha
assert not subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],text=True).strip()
proof=json.loads(args.ci_proof.read_text())
m=runpy.run_path(str(root/'infra/staging/release-market.py'))
m['verify_ci'](proof,sha,required_jobs=m['CI_JOBS'] | {'Cloud-edge fulfillment transport and recovery','Local kitchen UI and recovery'},exact_jobs=True)
prepared=json.loads(args.prepared.read_text());assert prepared['sha']==sha
compose=subprocess.check_output(['git','show',sha+':infra/payments/kaspi-bridge/worker.compose.yaml'],text=True)
payload={'sha':sha,'image':prepared['image_id'],'lock':str(uuid.uuid4()),'compose':compose,'ci':proof['run']['html_url'],'api':args.expected_api_sha,'public':args.expected_public_sha}
code=r'''import pathlib,json,subprocess,sys,os,time,hashlib
p=json.load(sys.stdin);r=pathlib.Path('/opt/pickchick-staging')
old='289da31b47915b2d5cc3bb1813a4df613eb265b2';api=p['api'];public=p['public'];lock=r/'.market-release.lock'
def call(args):return subprocess.check_output(args,text=True).strip()
def inspect(name):return json.loads(call(['docker','inspect',name]))[0]
def private(path,data):
 with path.open('x') as f:os.fchmod(f.fileno(),0o600);f.write(data)
def compose(directory):return ['docker','compose','--env-file',str(directory/'release.env'),'-f',str(directory/'compose.yaml')]
def owner_sql(sql):return subprocess.check_output(['docker','exec','-i','pickchick-staging-cloud-db-1','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','pickchick_cloud'],input=sql,text=True).strip()
def pointers():
 assert (r/'current').resolve()==r/'releases'/api
 assert (r/'public-https/current').resolve()==r/'public-https/releases'/public
pointers()
previous=inspect('pickchick-kaspi-worker');assert previous['Config']['Image']=='pickchick-api:'+old and previous['State']['Running']
image=inspect('pickchick-api:'+p['sha']);assert image['Id']==p['image'] and image['Config']['Labels']['org.opencontainers.image.revision']==p['sha']
js=r"""import{createPool}from'/app/packages/database/dist/index.js';const p=createPool(process.env.CLOUD_DATABASE_URL,1);try{const r=await p.query(`SELECT (SELECT count(*) FROM commerce_payment_attempts)::int attempts,(SELECT count(*) FROM commerce_kaspi_invoices)::int invoices,(SELECT count(*) FROM commerce_captures)::int captures,(SELECT sum(amount_minor)::text FROM commerce_captures) amount,(SELECT count(*) FROM commerce_kaspi_invoices WHERE state IN ('issuing','issued','unknown'))::int unsettled,(SELECT count(*) FROM commerce_outbox e JOIN commerce_payment_attempts a ON a.id=(e.payload->>'attemptId')::uuid WHERE e.event_type='payment.submit_requested' AND e.acknowledged_at IS NULL AND a.state='pending')::int pending`);console.log(JSON.stringify(r.rows[0]));}finally{await p.end()}"""
def worker_node(code):return call(['docker','exec','pickchick-kaspi-worker','node','--env-file=/run/pickchick/worker.env','--env-file=/run/pickchick/session.env','--input-type=module','-e',code])
def ledger():return json.loads(worker_node(js))
def secret_hashes():return call(['docker','exec','pickchick-kaspi-worker','sha256sum','/run/pickchick/worker.env','/run/pickchick/session.env'])
# Preserve financial data and credentials; grant projection SELECT to the worker.
before=ledger();assert before['unsettled']==0 and before['pending']==0
assert owner_sql("SELECT has_table_privilege('pickchick_kaspi_worker','cloud_fulfillment_projection','SELECT')")=='t'
readiness_tables=['cloud_branch_availability','fulfillment_transport_bindings','devices']
previous_grants={t:owner_sql("SELECT has_table_privilege('pickchick_kaspi_worker','"+t+"','SELECT')")== 't' for t in readiness_tables}
new_grants=[t for t in readiness_tables if not previous_grants[t]]
secrets=secret_hashes();others={x:inspect(x)['Id'] for x in ['pickchick-staging-api-1','pickchick-kaspi-bridge','pickchick-staging-cloud-db-1','pickchick-staging-redis-cache-1','pickchick-kitchen-portal','pickchick-public-gateway']}
new=r/'kaspi-companion'/p['sha'];assert not new.exists()
lock.mkdir(mode=0o700);private(lock/'owner.json',json.dumps({'id':p['lock'],'operation':'kaspi-session-readiness','sha':p['sha']}))
try:
 pointers();assert inspect('pickchick-kaspi-worker')['Id']==previous['Id'];assert ledger()==before
 # Add only read access for the restaurant readiness probe; preserve existing ACLs.
 subprocess.run(['docker','exec','-i','pickchick-staging-cloud-db-1','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','pickchick_cloud'],
   input=''.join('GRANT SELECT ON '+t+' TO pickchick_kaspi_worker;' for t in new_grants),text=True,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)

 new.mkdir(mode=0o700);private(new/'compose.yaml',p['compose']);private(new/'release.env','API_RELEASE_SHA='+p['sha']+'\nKASPI_SECRETS_DIR='+str(r/'secrets/kaspi-bridge')+'\n')
 subprocess.run(compose(new)+['up','-d','--no-deps','worker'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 time.sleep(4)
 actual=inspect('pickchick-kaspi-worker');assert actual['Image']==p['image'] and actual['State']['Running'] and actual['RestartCount']==0
 assert actual['HostConfig']['ReadonlyRootfs'] and actual['Config']['User']=='1000:1000'
 assert sorted(actual['Mounts'],key=lambda x:x['Destination'])==sorted(previous['Mounts'],key=lambda x:x['Destination']);assert secret_hashes()==secrets
 probe=r"""import{kaspiRemoteConfig,kaspiInvoiceComment}from'/app/packages/commerce-core/dist/index.js';const c=kaspiRemoteConfig(process.env);if(c?.invoiceTtlSeconds!==180)throw Error('TTL not installed');const message=kaspiInvoiceComment('12',{lines:[{title:'Pick Combo',quantity:1,selectedDetails:{modifiers:[{label:{ru:'Cola'},quantity:1}]}}]});if(message!=='Заказ №12: Pick Combo - 1 шт. (Cola)')throw Error('Wrong message');const {KaspiBridgeClient}=await import('/app/packages/commerce-core/dist/index.js');let calls=0;const client=new KaspiBridgeClient(c,async(url,init)=>{if(!url.endsWith('/api/session/check')||init.method!=='GET')throw Error('Unexpected request');calls++;return new Response(JSON.stringify({active:true}));});if(!(await client.checkSession())||calls!==1)throw Error('Session probe absent');console.log(JSON.stringify({invoiceTtlSeconds:c.invoiceTtlSeconds,readableMessage:true,sessionPreflight:true,newInvoiceCreated:false}));"""
 result=json.loads(worker_node(probe));assert ledger()==before
 assert all(inspect(x)['Id']==v for x,v in others.items());pointers()
 proof={'sourceSha':p['sha'],'image':p['image'],'ci':p['ci'],'probe':result,'ledgerUnchanged':True,'credentialsUnchanged':True,'neighborContainersUnchanged':True,'apiSha':api,'publicSha':public,'previousWorkerSha':old,'readinessReadGrants':readiness_tables,'newInvoiceCreated':False}
 private(new/'completed.json',json.dumps(proof));assert json.loads((lock/'owner.json').read_text())['id']==p['lock'];(lock/'owner.json').unlink();lock.rmdir();print(json.dumps(proof))
except BaseException:
 subprocess.run(['docker','exec','-i','pickchick-staging-cloud-db-1','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','pickchick_cloud'],input=''.join('REVOKE SELECT ON '+t+' FROM pickchick_kaspi_worker;' for t in new_grants),text=True,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 subprocess.run(compose(r/'kaspi-companion'/old)+['up','-d','--no-deps','worker'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 raise
'''
ssh=['ssh','-i',str(args.ssh_key),'-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','pickchick-ops@185.129.51.103']
r=subprocess.run(ssh+['python3 -c '+shlex.quote(code)],input=json.dumps(payload),capture_output=True,text=True,timeout=180)
f=root/'.local/kaspi-session-worker-apply.log';f.write_text(r.stdout+'\n'+r.stderr);f.chmod(0o600)
if r.returncode:raise SystemExit('Worker update stopped; private diagnostics and owned lock retained.')
print(r.stdout)
