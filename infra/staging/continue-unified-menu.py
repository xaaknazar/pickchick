#!/usr/bin/env python3
"""Continue remote-stops/media flags on exact installed cloud051; default read-only.

No deployment, migrations, publications, bank calls or Windows mutations. Each apply
needs a reviewed fresh plan, full exact-source CI, a restored encrypted backup and
an owned shared lock. Any failed dispatch retains the lock and attempt marker.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

spec=importlib.util.spec_from_file_location('continuation_unified',Path(__file__).with_name('release-unified-menu.py'))
u=importlib.util.module_from_spec(spec);sys.modules[spec.name]=u;spec.loader.exec_module(u)
market,require,digest,quote=u.market,u.require,u.digest,u.quote
GuardFailure=market.GuardFailure
REPO,REMOTE=market.REPO,market.REMOTE
PHASES=('remote-stops','media-upload')
OWNER='infra/staging/unified-menu-continuation-owner.mjs'
BANKS=('pickchick-kaspi-bridge','pickchick-kaspi-worker','pickchick-kiosk-kaspi-qr-worker')
HEAD_KEYS=('source_sha','branch_id','edge_device_id','menu_release_id','menu_version','menu_hash','catalog_version')


def private_json(path):
    require(path and path.is_file() and not path.is_symlink() and path.stat().st_mode&0o077==0 and path.stat().st_size<5_000_000,'Protected JSON evidence required')
    return json.loads(path.read_text())


def check_windows(proof,head,now=None):
    require(proof.get('format')=='pickchick-remote-stops-windows-ready-v1','Actual Windows remote-stops proof required')
    for key in HEAD_KEYS:
        require(proof.get(key)==head[key],'Windows/menu binding differs: '+key)
    require(proof.get('schema')==20 and proof.get('protocol')==4 and proof.get('menu_sync_mode')=='apply' and
            proof.get('remote_stops_enabled') is True and proof.get('runtime_verified') is True and proof.get('grants_verified') is True,'Windows runtime/protocol/stop flag is not ready')
    require(all(re.fullmatch('[a-f0-9]{64}',proof.get(k,'')) for k in ('env_before_sha256','env_after_sha256')),'Windows env CAS evidence missing')
    require(0<=(time.time() if now is None else now)-proof.get('completed_epoch',0)<=21600,'Windows stop proof is stale')


def check_flags(env,phase,enabled,branch):
    flags=u.flag_environment(env)
    if enabled:
        for name in ('access-roles','edge-publication'):
            require(flags[name]=='true','Earlier unified-menu flag is disabled: '+name)
        require(env.get(u.BRANCH_KEY)==digest(branch.encode()),'Publication branch differs')
        require(env.get('BACKOFFICE_DEVICE_ACCESS_ENABLED')==digest(b'true'),'Devices must be activated first')
        require(env.get('CUSTOMER_CHECKOUT_HEAD_GUARD')==digest(b'true'),'Mobile catalog guard is not enabled')
        require(env.get('BACKOFFICE_ENABLED')==digest(b'true') and env.get('CATALOG_ADMIN_ENABLED')==digest(b'true'),'Backoffice/catalog editor unavailable')
    if phase:
        require(flags[phase]==('false' if enabled else 'true'),'Target flag already changed or invalid')
        if enabled and phase=='media-upload':require(flags['remote-stops']=='true','Enable remote-stops before media-upload')
        if not enabled and phase=='remote-stops':require(flags['media-upload']=='false','Disable media-upload before remote-stops')


def check_head(snapshot,branch,sha):
    edge=u.check_edge_state(snapshot,branch);u.check_menu_events(int(snapshot['unacked']))
    menu=snapshot.get('menu') or {}
    require(menu.get('release_id')==edge['active_release_id'] and menu.get('version')==edge['active_version'] and
            menu.get('device_id')==edge['device_id'] and menu.get('catalog_version')==snapshot['head'] and
            menu.get('applied') is True and menu.get('activated') is True,'Current catalog has no matching applied menu ACK')
    require(re.fullmatch('[a-f0-9]{64}',menu.get('checksum','')),'Applied menu checksum missing')
    return dict(zip(HEAD_KEYS,(sha,branch,edge['device_id'],edge['active_release_id'],edge['active_version'],menu['checksum'],snapshot['head'])))


def check_plan(plan,current,phase,enabled,now=None):
    require(plan.get('format')=='pickchick-unified-menu-continuation-plan-v1' and plan.get('phase')==phase and plan.get('enabled') is enabled,'Foreign continuation plan')
    require(0<=(time.time() if now is None else now)-plan.get('completed_epoch',0)<=900,'Reviewed plan is older than 15 minutes')
    require(plan.get('state')==current,'Live state changed after review')


def menu_head_sql(branch):
    require(re.fullmatch(u.UUID_RE,branch or ''),'Branch UUID required')
    b=branch
    return f"""SELECT coalesce((SELECT row_to_json(t) FROM (
          SELECT r.id AS release_id,r.version,r.checksum,d.device_id,d.catalog_version,
            coalesce(v.result='applied',false) AS applied,coalesce(a.release_id=r.id,false) AS activated
          FROM catalog_branch_heads h JOIN catalog_menu_deliveries d ON d.branch_id=h.branch_id AND d.catalog_version=h.published_version
          JOIN menu_releases r ON r.id=d.release_id AND r.branch_id=h.branch_id
          LEFT JOIN catalog_menu_delivery_results v ON v.release_id=r.id AND v.branch_id=h.branch_id
          LEFT JOIN branch_menu_activations a ON a.branch_id=h.branch_id WHERE h.branch_id='{b}') t),'null'::json)"""


class Release(u.Release):
    def __init__(self,args):
        for key in ('sha','expected_public_sha'):
            require(re.fullmatch('[a-f0-9]{40}',getattr(args,key) or ''),'Exact source/public SHA required')
        for key in ('expected_compose_sha256','expected_gateway_sha256'):
            require(re.fullmatch('[a-f0-9]{64}',getattr(args,key) or ''),'Reviewed compose/gateway pin required')
        require(re.fullmatch('sha256:[a-f0-9]{64}',args.expected_api_image or ''),'Exact installed image required')
        require(re.fullmatch(u.UUID_RE,args.branch_id or ''),'Branch UUID required')
        profile=market.ReleaseProfile('unified-menu-continuation051',args.sha,args.expected_public_sha,50,(),u.workflow_jobs((REPO/'.github/workflows/ci.yml').read_text()),frozenset(),'unified-menu-continuation',(),exact_ci_jobs=True)
        market.Release.__init__(self,args,profile);self.branch_id=args.branch_id

    def source_checks(self):
        require(self.git('rev-parse','HEAD')==self.sha and not self.git('status','--porcelain','--untracked-files=all'),'Exact clean checked-out source required')
        require(re.fullmatch('[A-Za-z0-9._/-]{1,160}',self.args.branch) and '..' not in self.args.branch,'Invalid pushed branch')
        require(self.git('ls-remote','--exit-code','--heads','origin','refs/heads/'+self.args.branch).split()[0]==self.sha,'Published branch differs')
        names=sorted(p.name for p in (REPO/'db/cloud/migrations').glob('*.sql'))
        require([int(n[:3]) for n in names]==list(range(1,41))+list(range(42,52)) and names[-1]=='051_cloud_device_registry.sql','Exact schema051 candidate required')
        return [{'version':n,'scope':'cloud','checksum':digest((REPO/'db/cloud/migrations'/n).read_bytes())} for n in names]

    def neighbors(self):
        state=self.fingerprint()
        for name in BANKS:
            require(len(state['containers'].get(name,'').split())==5 and state['containers'][name].split()[3]=='running','Bank neighbor is not running')
        state['gateway']=self.remote('docker inspect --format '+quote('{{.Id}} {{.Image}} {{.State.StartedAt}} {{.State.Status}} {{.RestartCount}}')+' '+market.GATEWAY)
        require(state['gateway'].split()[3]=='running','Gateway is not running')
        return state

    def owner(self,action,phase,enabled,state=None):
        argv=[action,phase,'true' if enabled else 'false']+([state] if state else [])
        out=self.remote(market.api_compose(self.sha)+' run --rm --no-deps --entrypoint node provision '+OWNER+' '+' '.join(map(quote,argv)),timeout=240)
        return json.loads(out.splitlines()[-1])

    def menu_head(self):
        snapshot=self.edge_snapshot()
        snapshot['menu']=self.json_query(menu_head_sql(self.branch_id))
        head=check_head(snapshot,self.branch_id,self.sha)
        beat=self.heartbeat()
        require(beat and beat['device_matches'] and beat['protocol4'] and 0<=beat['age_seconds']<=u.HEARTBEAT_MAX_AGE,'Fresh protocol4 heartbeat required')
        return head

    def baseline(self,phase=None,enabled=True):
        a=self.args
        require(self.running_revision()==self.sha and self.api_image()==a.expected_api_image,'Installed API source/image differs')
        require(self.remote('docker image inspect --format '+quote('{{.Id}}')+' pickchick-api:'+self.sha)==a.expected_api_image,'Image tag was replaced')
        require(self.remote('readlink -f '+REMOTE+'/current')==REMOTE+'/releases/'+self.sha,'API pointer differs')
        require(self.remote('readlink -f '+REMOTE+'/public-https/current')==REMOTE+'/public-https/releases/'+a.expected_public_sha,'Public pointer differs')
        require(self.ledger()==self.source_ledger,'Installed ledger differs from exact051')
        self.role_restricted();self.ready();u.check_access_coverage(self.coverage())
        raw=self.read_text(self.compose_path(self.sha))
        require(digest(raw.encode())==a.expected_compose_sha256,'Installed compose changed')
        gateway=self.public_dir(a.expected_public_sha)+'/gateway.Caddyfile'
        require(self.file_hashes([gateway])[gateway]==a.expected_gateway_sha256,'Gateway file differs')
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0]==a.expected_gateway_sha256,'Mounted gateway differs')
        owner_hash=self.remote('docker exec '+market.API_CONTAINER+' sha256sum /app/'+OWNER).split()[0]
        require(owner_hash==digest((REPO/OWNER).read_bytes()),'Installed owner bytes differ from reviewed source')
        env=self.runtime_environment();check_flags(env,phase,enabled,self.branch_id)
        acl=self.acl();u.check_edge_publication_acl(acl,writable=True)
        head=self.menu_head() if enabled else None
        windows=None
        if phase and enabled:
            windows=private_json(a.windows_proof);check_windows(windows,head)
        owner=self.owner('inspect',phase,enabled) if phase else None
        return {'source_sha':self.sha,'branch_id':self.branch_id,'api_image':a.expected_api_image,'compose_sha256':digest(raw.encode()),
                'public_sha':a.expected_public_sha,'gateway_sha256':a.expected_gateway_sha256,'environment':env,'acl':acl,
                'neighbors':self.neighbors(),'head':head,'windows_sha256':digest(windows) if windows else None,'owner':owner,
                'release_env':self.file_hashes([REMOTE+'/releases/'+self.sha+'/release.env'])}

    def compose_cas(self,before,after,backup):
        script="""import hashlib,os,pathlib,sys
p=pathlib.Path(sys.argv[1]);expected=sys.argv[2];b=pathlib.Path(sys.argv[3]);raw=p.read_bytes();assert not p.is_symlink() and hashlib.sha256(raw).hexdigest()==expected
with b.open('xb') as f:os.fchmod(f.fileno(),0o600);f.write(raw);f.flush();os.fsync(f.fileno())
data=sys.stdin.buffer.read()
with p.open('r+b') as f:
 assert hashlib.sha256(f.read()).hexdigest()==expected
 f.seek(0);f.write(data);f.truncate();f.flush();os.fsync(f.fileno())
assert p.read_bytes()==data
"""
        self.remote('python3 -c '+quote(script)+' '+quote(self.compose_path(self.sha))+' '+quote(digest(before.encode()))+' '+quote(backup),input=after)

    def switch(self,phase,enabled,state):
        key=u.FLAG_KEYS[phase];original=self.read_text(self.compose_path(self.sha))
        require(digest(original.encode())==state['compose_sha256'],'Compose changed before switch')
        candidate=u.compose_flag(original,phase,enabled,self.branch_id)
        backup=self.compose_path(self.sha)+'.continuation-'+phase+('-enable' if enabled else '-disable')+'.previous'
        owner=None
        if enabled:owner=self.owner('apply',phase,True,state['owner']['state_digest'])
        self.compose_cas(original,candidate,backup)
        self.remote(market.api_compose(self.sha)+' config --quiet')
        self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        self.ready()
        require(self.running_revision()==self.sha and self.api_image()==state['api_image'],'API identity changed')
        u.verify_environment_delta(state['environment'],self.runtime_environment(),{key:'true' if enabled else 'false'})
        if not enabled:owner=self.owner('apply',phase,False,state['owner']['state_digest'])
        require(owner.get('existingDataPreserved') is True,'Owner transaction preservation not confirmed')
        added,removed,present,absent=u.flag_acl(phase,enabled)
        u.verify_acl_change(state['acl'],self.acl(),added=added,removed=removed,present=present,absent=absent)
        require(self.ledger()==self.source_ledger,'Ledger changed during continuation')
        require(self.neighbors()==state['neighbors'],'A neighbor changed during continuation')
        require(self.file_hashes(list(state['release_env']))==state['release_env'],'Release environment file changed')
        require(digest(self.read_text(self.compose_path(self.sha)).encode())==digest(candidate.encode()),'Compose changed after switch')
        return {'format':'pickchick-unified-menu-continuation-result-v1','source_sha':self.sha,'branch_id':self.branch_id,'phase':phase,'enabled':enabled,
                'schema':51,'compose_sha256':digest(candidate.encode()),'previous_compose':backup,'owner':owner,'completed_epoch':time.time(),
                'windows_sha256':state['windows_sha256'],'head':state['head'],'functional_test_performed':False}

    def run(self):
        self.source_ledger=self.source_checks();self.ci()
        if self.args.action=='menu-head':
            state=self.baseline()
            record={'format':'pickchick-unified-menu-head-v1',**state['head'],'completed_epoch':time.time()}
            self.save('menu-head.json',record);print(json.dumps(record,sort_keys=True));return
        phase=self.args.action if self.args.action in PHASES else self.args.flag
        require(phase in PHASES,'Disable requires --flag')
        enabled=self.args.action!='disable';label=phase+('-enable' if enabled else '-disable')
        state=self.baseline(phase,enabled)
        if not self.args.apply:
            record={'format':'pickchick-unified-menu-continuation-plan-v1','phase':phase,'enabled':enabled,'completed_epoch':time.time(),'state':state}
            path=self.private/(label+'-plan.json');self.save(path.name,record)
            self.plan(phase,{'enabled':enabled,'plan':str(path),'plan_sha256':digest(path.read_bytes()),'owner':state['owner']});return
        require(self.args.plan and re.fullmatch('[a-f0-9]{64}',self.args.plan_sha256 or ''),'Reviewed plan path/hash required')
        plan=private_json(self.args.plan);require(digest(self.args.plan.read_bytes())==self.args.plan_sha256,'Reviewed plan hash differs')
        check_plan(plan,state,phase,enabled)
        require(not (self.private/(label+'-attempt.json')).exists(),'An attempt exists; inspect actual state, no replay')
        key=self.args.backup_identity
        require(key.is_file() and not key.is_symlink() and key.stat().st_mode&0o077==0,'Protected backup identity required')
        with self.deployment_lock():
            check_plan(plan,self.baseline(phase,enabled),phase,enabled)
            backup=self.backup_restore();require(backup.get('restore')=='passed','Isolated backup restore not confirmed')
            check_plan(plan,self.baseline(phase,enabled),phase,enabled)
            self.save(label+'-attempt.json',{'reviewed_plan_sha256':self.args.plan_sha256,'backup':backup,'lock_owner':self.lock_owner,'created_epoch':time.time()})
            result=self.switch(phase,enabled,state)
            result['backup']=backup;self.save(label+'-result.json',result)
        print(json.dumps({'phase':phase,'enabled':enabled,'applied':True,'compose_sha256':result['compose_sha256'],'functional_test_performed':False},sort_keys=True))


def parse(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['menu-head',*PHASES,'disable']);p.add_argument('sha')
    p.add_argument('--branch',required=True);p.add_argument('--branch-id',required=True)
    for name in ('expected-api-image','expected-public-sha','expected-compose-sha256','expected-gateway-sha256'):p.add_argument('--'+name,required=True)
    p.add_argument('--flag',choices=PHASES);p.add_argument('--apply',action='store_true')
    p.add_argument('--windows-proof',type=Path);p.add_argument('--plan',type=Path);p.add_argument('--plan-sha256')
    p.add_argument('--ssh-key',type=Path,default=Path.home()/'.ssh/pickchick_staging_ed25519')
    p.add_argument('--backup-identity',type=Path,default=REPO/'.local/vps/backup-identity.agekey')
    proof=p.add_mutually_exclusive_group(required=True);proof.add_argument('--ci-proof',type=Path);proof.add_argument('--ci-run')
    args=p.parse_args(argv);require(not(args.action=='menu-head' and args.apply),'menu-head is read-only');return args


def main(argv=None):
    os.umask(0o077);release=Release(parse(argv))
    try:release.run()
    except BaseException as error:release.record_error(error);raise


if __name__=='__main__':
    try:main()
    except GuardFailure as error:print('Continuation stopped: '+str(error));raise SystemExit(1) from None
    except Exception:print('Continuation stopped. Review protected evidence and actual state; do not retry an uncertain dispatch.');raise SystemExit(1) from None
