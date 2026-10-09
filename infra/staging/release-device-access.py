#!/usr/bin/env python3
"""Guarded Devices cloud050 -> 051 / BO release. Every action is read-only unless --apply.

The reviewed API baseline may be cf25 or its schema050 mobile successor. Exact SHA,
image, compose and public/gateway pins are mandatory. Existing API flags, portal,
bank containers, iPad keys, staff accounts and order data are preserved. Only the
API, BO subtree and two BO gateway matchers change. No generic provision runs.
Failures retain the shared lock; unknown apply is never replayed. Rollback retains
schema051 and is allowed only before any Device command/registration was created.
"""
import argparse
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile
import time

spec = importlib.util.spec_from_file_location('devices_unified_base', Path(__file__).with_name('release-unified-menu.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, require, digest, quote = base.market, base.require, base.digest, base.quote
REMOTE, DB, GuardFailure = market.REMOTE, market.DB, market.GuardFailure
ANCHOR = 'cf25cb9e4712a7beedc2d2b52a9d64d3e557598f'
MIGRATION = '051_cloud_device_registry.sql'
FLAG = 'BACKOFFICE_DEVICE_ACCESS_ENABLED'
TABLES = frozenset({'device_terminal_registry', 'cloud_device_commands', 'device_events',
                    'cloud_kitchen_password_resets', 'kitchen_password_reset_events'})
BANKS = ('pickchick-kaspi-bridge', 'pickchick-kaspi-worker', 'pickchick-kiosk-kaspi-qr-worker')
LINK_FILES = ('infra/kitchen-portal/agent.mjs', 'infra/kitchen-portal/link.mjs',
              'apps/kitchen/server.mjs', 'apps/kitchen/terminal-cookie.mjs')


def compose_candidate(text, expected):
    require(digest(text.encode()) == expected, 'Installed compose differs from reviewed hash')
    require(FLAG not in text and text.count('\n  api:\n') == 1, 'Flag exists or API boundary ambiguous')
    start = text.index('\n  api:\n') + 1
    match = re.search(r'^  [A-Za-z][A-Za-z0-9_-]*:', text[start + len('  api:\n'):], re.M)
    end = start + len('  api:\n') + match.start() if match else len(text)
    section = text[start:end]
    anchor = '      APP_ENV: staging\n'
    require(section.count(anchor) == 1, 'API environment anchor differs')
    line = f'      {FLAG}: "false"\n'
    candidate = text[:start] + section.replace(anchor, line + anchor) + text[end:]
    require(candidate.replace(line, '', 1) == text, 'Unrelated compose change')
    return candidate


def compose_flag(text, enabled):
    old, new = ('false', 'true') if enabled else ('true', 'false')
    prior, later = f'      {FLAG}: "{old}"\n', f'      {FLAG}: "{new}"\n'
    require(text.count(FLAG) == 1 and text.count(prior) == 1, 'Flag not in expected state')
    return text.replace(prior, later, 1)


def gateway_candidate(text, expected, original, candidate):
    require(digest(text.encode()) == expected, 'Gateway differs from reviewed hash')
    result = text
    for name in ('backoffice_get', 'backoffice_post'):
        pattern = r'^\t\tpath_regexp ' + name + r' [^\n]+$'
        old = re.findall(pattern, original, re.M)
        new = re.findall(pattern, candidate, re.M)
        require(len(old) == len(new) == 1 and old[0] != new[0], 'Reviewed gateway matcher missing')
        require(result.count(old[0]) == 1 and new[0] not in result, 'Live gateway matcher differs')
        result = result.replace(old[0], new[0], 1)
    return result


def verify_tree(before, after, bo):
    require({k:v for k,v in before.items() if not k.startswith('backoffice/') and k != '.release.json'} ==
            {k:v for k,v in after.items() if not k.startswith('backoffice/') and k != '.release.json'},
            'Non-backoffice public assets changed')
    require({k:v for k,v in after.items() if k.startswith('backoffice/')} == bo,
            'Public BO bytes differ from the built bundle')


def check_windows(proof, sha, branch, device, migration_hash, now=None):
    require(proof.get('format') == 'pickchick-device-access-prepared-v1' and
            proof.get('source_sha') == sha and proof.get('branch_id') == branch and
            proof.get('edge_device_id') == device, 'Foreign Windows preparation proof')
    require(proof.get('schema') == 20 and proof.get('migrationChecksum020') == migration_hash and
            proof.get('runtime_verified') is True and proof.get('grants_verified') is True,
            'Windows schema/runtime/ACL not verified')
    require(proof.get('worker', {}).get('installed') is True and
            re.fullmatch('[a-f0-9]{64}', proof.get('worker', {}).get('script_sha256', '')) and
            proof.get('link', {}).get('verified') is True, 'Worker/Link installation not verified')
    age = (time.time() if now is None else now) - proof.get('completed_epoch', 0)
    require(0 <= age <= 21600, 'Windows preparation is stale')


def check_pins(args):
    for name in ('sha', 'expected_api_sha', 'expected_public_sha'):
        require(re.fullmatch('[a-f0-9]{40}', getattr(args, name) or ''), 'Full source/baseline SHA required')
    for name in ('expected_compose_sha256', 'expected_gateway_sha256'):
        require(re.fullmatch('[a-f0-9]{64}', getattr(args, name) or ''), 'Reviewed compose/gateway hash required')
    require(re.fullmatch('sha256:[a-f0-9]{64}', args.expected_api_image or ''), 'Reviewed API image required')
    require(re.fullmatch(base.UUID_RE, args.branch_id or ''), 'Branch UUID required')


class Release(base.Release):
    def __init__(self, args):
        check_pins(args)
        profile = market.ReleaseProfile('devices-schema051', args.expected_api_sha, args.expected_public_sha,
            49, (MIGRATION,), base.workflow_jobs((market.REPO/'.github/workflows/ci.yml').read_text()),
            frozenset(), 'device-access-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)
        self.branch_id = args.branch_id

    def baseline_migrations(self):
        names = sorted(Path(p).name for p in self.git('ls-tree', '-r', '--name-only', self.profile.old_api,
                                                     '--', 'db/cloud/migrations/').splitlines() if p.endswith('.sql'))
        require([int(n[:3]) for n in names] == list(range(1, 41)) + list(range(42, 51)), 'Exact schema050 baseline required')
        return names

    def source_checks(self):
        market.Release.source_checks(self)
        self.execute(['git', 'merge-base', '--is-ancestor', ANCHOR, self.profile.old_api])
        self.execute(['git', 'merge-base', '--is-ancestor', self.profile.old_api, self.sha])
        require(self.sha != self.profile.old_api, 'New integrated source required')

    def expected_ledger(self, migrated=False):
        names = self.baseline_migrations() + ([MIGRATION] if migrated else [])
        return [{'version': n, 'scope':'cloud', 'checksum':digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in names]

    def neighbors(self):
        result = self.fingerprint()
        for name in BANKS:
            fields = result['containers'].get(name, '').split()
            require(len(fields) == 5 and fields[3] == 'running', 'Bank/QR container unavailable')
        return result

    def tree(self, sha):
        program = '''from pathlib import Path
import hashlib,json,sys
r=Path(sys.argv[1]);out={}
assert r.is_dir() and not r.is_symlink()
for p in sorted(r.rglob('*')):
 assert not p.is_symlink()
 if p.is_file():out[str(p.relative_to(r))]=hashlib.sha256(p.read_bytes()).hexdigest()
print(json.dumps(out,sort_keys=True))'''
        return json.loads(self.remote('python3 -c '+quote(program)+' '+quote(self.public_dir(sha)+'/public-web')))

    def public_state(self):
        old = self.profile.old_web
        require(self.remote('readlink -f '+REMOTE+'/public-https/current') == REMOTE+'/public-https/releases/'+old, 'Public pointer changed')
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] == self.args.expected_gateway_sha256, 'Mounted gateway changed')
        health = self.http_json('/kitchen-live/health')
        require(health.get('edgeConnected') is True, 'Kitchen portal disconnected')
        return self.tree(old)

    def baseline(self):
        a = self.args
        require(self.running_revision() == self.profile.old_api and self.api_image() == a.expected_api_image, 'Live API baseline differs')
        require(self.remote('readlink -f '+REMOTE+'/current') == REMOTE+'/releases/'+self.profile.old_api, 'API pointer differs')
        require(self.remote('docker image inspect --format '+quote('{{.Id}}')+' pickchick-api:'+self.profile.old_api) == a.expected_api_image, 'Rollback image differs')
        require(self.ledger() == self.expected_ledger(), 'Installed ledger is not exact schema050')
        self.role_restricted(); self.ready()
        env = self.runtime_environment()
        require(env.get(FLAG) in (None, digest(b'false')), 'Devices already enabled')
        require(env.get('BACKOFFICE_ENABLED') == digest(b'true'), 'Backoffice is not enabled')
        raw = self.read_text(self.compose_path(self.profile.old_api))
        gateway = self.read_text(self.public_dir(self.profile.old_web)+'/gateway.Caddyfile')
        original = self.execute(['git','show',ANCHOR+':infra/public-staging/gateway.Caddyfile']).decode()
        return {'compose':compose_candidate(raw,a.expected_compose_sha256),
                'gateway':gateway_candidate(gateway,a.expected_gateway_sha256,original,(market.REPO/'infra/public-staging/gateway.Caddyfile').read_text()),
                'environment':env,'neighbors':self.neighbors(),'acl':self.acl(),'rollback':self.rollback_artifacts(),
                'public_tree':self.public_state(),'capabilities':self.http_json('/v1/capabilities',public=False)}

    def owner(self, action):
        result = self.remote(market.api_compose(self.sha)+' run --rm --no-deps --entrypoint node provision infra/staging/device-access-owner.mjs '+quote(action),timeout=240)
        return json.loads(result.splitlines()[-1])

    def prepared(self):
        path=self.private/'prepared.json'
        require(path.is_file() and not path.is_symlink(),'Preparation evidence required')
        proof=json.loads(path.read_text())
        require(proof['sha']==self.sha and proof['api_baseline']==self.profile.old_api and proof['public_baseline']==self.profile.old_web,'Foreign preparation')
        return proof

    def artifacts(self):
        image=json.loads(self.remote('docker image inspect --format '+quote('{{json .}}')+' pickchick-api:'+self.sha))
        require(image['Config']['Labels']['org.opencontainers.image.revision']==self.sha,'Candidate image revision differs')
        paths=[self.compose_path(self.sha),REMOTE+'/releases/'+self.sha+'/release.env',self.public_dir(self.sha)+'/compose.yaml',self.public_dir(self.sha)+'/gateway.Caddyfile']
        return {'image':image['Id'],'files':self.file_hashes(paths),'public_tree':self.tree(self.sha)}

    def prepare(self):
        before=self.baseline()
        if not self.args.apply:return self.plan('prepare',{'pending_migrations':[MIGRATION],'devices_enabled':False,'public_changes':'BO only'})
        require(not (self.private/'prepared.json').exists(),'Preparation already exists; inspect before retry')
        archive=self.execute(['git','archive','--format=tar',self.sha,*market.ARCHIVE_PATHS])
        target=REMOTE+'/releases/'+self.sha
        self.remote(f'test ! -e {target} && mkdir {target} && tar -xf - -C {target}',input=archive,timeout=180)
        self.remote('python3 -c '+quote(market.release_env_script(self.profile))+' '+' '.join(map(quote,[REMOTE+'/releases/'+self.profile.old_api+'/release.env',target+'/release.env',self.sha,self.profile.old_api])))
        self.write_remote(self.compose_path(self.sha),before['compose'])
        self.remote('! docker image inspect pickchick-api:'+self.sha+' >/dev/null 2>&1')
        image=self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} -t pickchick-api:{self.sha} .',timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}',image),'Invalid candidate image')
        self.remote(market.api_compose(self.sha)+' config --quiet')
        require(self.execute(['corepack','pnpm','--version']).decode().strip()=='11.19.0','Pinned pnpm required')
        directory=market.REPO/'apps/backoffice/dist'
        require(not directory.is_symlink(),'BO output must not be a symlink')
        if directory.exists():shutil.rmtree(directory)
        self.execute(['corepack','pnpm','--filter','@pickchick/backoffice...','build'],timeout=180)
        directory=market.REPO/'apps/backoffice/dist';bundle=self.private/'backoffice.tar';bo={}
        with tarfile.open(bundle,'w') as tar:
            for file in sorted(directory.rglob('*')):
                require(not file.is_symlink(),'Symlink in BO bundle')
                if file.is_file():
                    require(file.suffix in ('.html','.js','.css','.svg','.png','.jpg','.jpeg','.webp','.avif','.ico','.woff','.woff2','.ttf','.mp4'),'Unexpected BO asset')
                    name='backoffice/'+str(file.relative_to(directory));bo[name]=digest(file.read_bytes());tar.add(file,arcname=name)
        old,new=self.public_dir(self.profile.old_web),self.public_dir(self.sha)
        self.remote(f'test ! -e {REMOTE}/public-https/releases/{self.sha} && mkdir -p {new} && cp -a {old}/. {new}/ && rm -rf {new}/public-web/backoffice && tar -xf - -C {new}/public-web',input=bundle.read_bytes(),timeout=180)
        web=json.loads(self.remote(market.web_compose(self.profile.old_web)+' config --format json'))
        self.write_remote(new+'/compose.yaml',json.dumps(base.relocate_public_mounts(web,old,new)))
        self.write_remote(new+'/gateway.Caddyfile',before['gateway'],public=True)
        program='''from pathlib import Path
import json,hashlib,sys
r=Path(sys.argv[1]);p=r/'public-web/.release.json';m=json.loads(p.read_text());m['source_sha']=sys.argv[2]
m.setdefault('component_sources',{})['backoffice']=sys.argv[2]
m['files']={k:v for k,v in m['files'].items() if not k.startswith('backoffice/')}
for f in (r/'public-web/backoffice').rglob('*'):
 assert not f.is_symlink()
 f.chmod(0o755 if f.is_dir() else 0o644)
 if f.is_file():m['files'][str(f.relative_to(r/'public-web'))]=hashlib.sha256(f.read_bytes()).hexdigest()
p.write_text(json.dumps(m,indent=2)+'\\n');p.chmod(0o644)
'''
        self.remote('python3 -c '+quote(program)+' '+quote(new)+' '+self.sha)
        self.remote(market.web_compose(self.sha)+' config --quiet')
        self.remote(base.caddy_validation_command(new+'/gateway.Caddyfile'),timeout=45)
        artifacts=self.artifacts();verify_tree(before['public_tree'],artifacts['public_tree'],bo)
        require(artifacts['image']==image and self.baseline()==before,'Preparation baseline drift')
        self.save('prepared.json',{'sha':self.sha,'api_baseline':self.profile.old_api,'public_baseline':self.profile.old_web,'before':before,'artifacts':artifacts,'bo':bo,'archive_sha256':digest(archive)})

    def verify_current(self,proof,enabled):
        require(self.running_revision()==self.sha and self.api_image()==proof['artifacts']['image'],'Candidate API changed')
        require(self.remote('readlink -f '+REMOTE+'/current')==REMOTE+'/releases/'+self.sha,'Candidate API pointer changed')
        require(self.remote('readlink -f '+REMOTE+'/public-https/current')==REMOTE+'/public-https/releases/'+self.sha,'Candidate public pointer changed')
        require(self.ledger()==self.expected_ledger(True),'Candidate schema differs')
        require(self.neighbors()==proof['before']['neighbors'],'Neighbour bank/portal/DB container changed')
        require(self.rollback_artifacts()==proof['before']['rollback'],'Rollback artifacts changed')
        base.verify_environment_delta(proof['before']['environment'],self.runtime_environment(),{FLAG:str(enabled).lower()},release_sha_may_change=True)
        self.ready();self.role_restricted()
        expected=proof['artifacts'].copy();expected['files']=dict(expected['files'])
        expected['files'][self.compose_path(self.sha)]=digest((compose_flag(proof['before']['compose'],True) if enabled else proof['before']['compose']).encode())
        require(self.artifacts()==expected,'Candidate artifact drift')
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0]==digest(proof['before']['gateway'].encode()),'Mounted gateway changed')
        mounts=json.loads(self.remote('docker inspect --format '+quote('{{json .Mounts}}')+' '+market.GATEWAY))
        bydest={r['Destination']:r['Source'] for r in mounts}
        require(bydest.get('/etc/caddy/Caddyfile')==self.public_dir(self.sha)+'/gateway.Caddyfile' and bydest.get('/srv/public')==self.public_dir(self.sha)+'/public-web','Gateway mounted a foreign tree')
        require(self.http_json('/v1/capabilities',public=False)==proof['before']['capabilities'],'Capabilities changed')
        require(self.http_json('/kitchen-live/health').get('edgeConnected') is True,'Kitchen portal disconnected')
        self.routed('/v1/admin/backoffice/branches/'+self.branch_id+'/devices',{401,403,503})
        self.http_json('/v1/customer-checkout/catalog')

    def apply(self):
        proof=self.prepared()
        require(self.baseline()==proof['before'] and self.artifacts()==proof['artifacts'],'Prepared baseline/artifacts drift')
        if not self.args.apply:return self.plan('apply',{'migration':MIGRATION,'devices_enabled':False,'backup_restore_required':True})
        require(not (self.private/'apply-attempt.json').exists(),'Apply already dispatched; inspect original outcome, no replay')
        key=self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode&0o077==0,'Protected backup identity required')
        backup=self.backup_restore();require(backup.get('restore')=='passed','Backup restore not confirmed');self.save('backup.json',backup)
        require(self.baseline()==proof['before'],'Baseline changed during backup')
        self.save('apply-attempt.json',{'sha':self.sha,'dispatched_at':time.time(),'backup':backup})
        result=self.owner('deploy');self.save('owner-deploy.json',result)
        require(result.get('applied')==[MIGRATION] and result.get('existingDataPreserved') is True and result.get('privilegesRemoved')==[],'Owner result invalid')
        self.ready() # old API remains compatible with additive schema051
        self.verify_acl(proof,result)
        require(self.neighbors()==proof['before']['neighbors'],'Neighbours changed before API switch')
        self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        self.ready();self.switch(REMOTE+'/current',REMOTE+'/releases/'+self.profile.old_api,REMOTE+'/releases/'+self.sha)
        self.switch(REMOTE+'/public-https/current',REMOTE+'/public-https/releases/'+self.profile.old_web,REMOTE+'/public-https/releases/'+self.sha)
        self.remote(market.web_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        self.verify_current(proof,False);self.verify_acl(proof,result)
        self.save('applied.json',{'sha':self.sha,'schema':51,'devices_enabled':False,'backup':backup,'applied_at':time.time()})

    def verify_acl(self,proof,result):
        additions={tuple(p.split('|')) for p in result['privilegesAdded']}
        expected={base.acl_key(r) for r in proof['before']['acl']} | {(t,c or None,p) for t,c,p in additions}
        current=self.acl()
        require({base.acl_key(r) for r in current}==expected and all(not r['grantable'] for r in current),'Unexpected runtime ACL delta')

    def windows_ready(self):
        path=self.args.windows_proof
        require(path and path.is_file() and not path.is_symlink() and path.stat().st_mode&0o077==0,'Protected Windows preparation proof required')
        proof=json.loads(path.read_text())
        devices=self.json_query("SELECT coalesce(json_agg(id ORDER BY id),'[]') FROM devices WHERE branch_id='"+self.branch_id+"' AND kind='edge' AND status='active'")
        require(len(devices)==1,'Exactly one active edge required')
        check_windows(proof,self.sha,self.branch_id,devices[0],digest((market.REPO/'db/edge/migrations/020_terminal_access.sql').read_bytes()))
        require(proof['worker']['script_sha256']==digest((market.REPO/'infra/windows/native-device-access-worker.mjs').read_bytes()),'Windows worker differs')
        require(proof['link'].get('files')=={p:digest((market.REPO/p).read_bytes()) for p in LINK_FILES},'Windows KitchenLink files differ')
        heart=self.heartbeat();require(isinstance(heart,dict) and heart.get('device_matches') is True and 0<=heart.get('age_seconds',999)<=30,'Edge heartbeat stale or mismatched')
        self.save('windows-prepared.json',proof)
        return proof

    def switch_flag(self,enabled):
        proof=self.prepared();p=self.private/'applied.json'
        require(p.is_file() and json.loads(p.read_text()).get('sha')==self.sha,'Completed off deploy required')
        self.verify_current(proof,not enabled)
        self.verify_acl(proof,json.loads((self.private/'owner-deploy.json').read_text()))
        windows=self.windows_ready() if enabled else None
        if not self.args.apply:return self.plan('enable' if enabled else 'disable',{'flag':FLAG,'value':enabled})
        self.write_remote(self.compose_path(self.sha),compose_flag(self.read_text(self.compose_path(self.sha)),enabled))
        self.remote(market.api_compose(self.sha)+' config --quiet')
        self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        self.verify_current(proof,enabled)
        self.save(('enabled' if enabled else 'disabled')+'.json',{'format':'pickchick-device-access-cloud-enabled-v1','source_sha':self.sha,'branch_id':self.branch_id,'edge_device_id':windows['edge_device_id'] if windows else None,'device_access_enabled':enabled,'completed_epoch':time.time()})

    def rollback(self):
        proof=self.prepared()
        require(self.neighbors()==proof['before']['neighbors'] and self.rollback_artifacts()==proof['before']['rollback'],'Rollback baseline drift')
        require(self.ledger() in (self.expected_ledger(),self.expected_ledger(True)),'Foreign rollback schema')
        if self.ledger()==self.expected_ledger(True):
            counts=self.json_query('SELECT json_agg(row_to_json(t)) FROM ('+' UNION ALL '.join("SELECT '"+t+"' AS name,count(*)::int AS n FROM "+t for t in sorted(TABLES))+') t')
            require(all(r['n']==0 for r in counts),'Device commands exist; disable and plan explicit recovery instead')
        require(self.running_revision() in (self.sha,self.profile.old_api),'Foreign running API')
        if not self.args.apply:return self.plan('rollback',{'schema':'retained','database_restore':False})
        for pointer,old,new in [(REMOTE+'/current',REMOTE+'/releases/'+self.profile.old_api,REMOTE+'/releases/'+self.sha),(REMOTE+'/public-https/current',REMOTE+'/public-https/releases/'+self.profile.old_web,REMOTE+'/public-https/releases/'+self.sha)]:
            actual=self.remote('readlink -f '+pointer);require(actual in (old,new),'Foreign pointer')
            if actual==new:self.switch(pointer,new,old)
        self.remote(market.api_compose(self.profile.old_api)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
        self.remote(market.web_compose(self.profile.old_web)+' up -d --no-deps --wait --wait-timeout 90 gateway',timeout=150)
        self.ready();require(self.running_revision()==self.profile.old_api and self.api_image()==self.args.expected_api_image,'Rollback API differs')
        require(self.neighbors()==proof['before']['neighbors'] and self.public_state()==proof['before']['public_tree'],'Rollback neighbours/assets differ')
        self.save('rollback.json',{'sha':self.sha,'database_restored':False,'schema_retained':True})

    @contextmanager
    def owned_lock(self):
        owner=self.args.owner_id
        if not owner:
            with self.deployment_lock():yield
            return
        require(self.args.action in ('rollback','disable') and re.fullmatch(base.UUID_RE,owner),'Owned recovery only')
        path=self.private/('lock-owner-'+owner+'.json');require(path.is_file() and not path.is_symlink(),'Local owned lock absent')
        expected=json.loads(path.read_text());require(expected.get('id')==owner and expected.get('sha')==self.sha,'Foreign local lock')
        require(json.loads(self.remote('cat '+quote(market.DEPLOY_LOCK+'/owner.json')))==expected,'Foreign live lock')
        yield
        program="import json,os,sys;p,o=sys.argv[1:];assert json.load(open(p+'/owner.json'))['id']==o;os.unlink(p+'/owner.json');os.rmdir(p)"
        self.remote('python3 -c '+quote(program)+' '+quote(market.DEPLOY_LOCK)+' '+quote(owner))

    def run(self):
        self.source_checks();self.ci()
        action=self.args.action
        call=(lambda:self.switch_flag(action=='enable')) if action in ('enable','disable') else getattr(self,action)
        if self.args.apply:
            with self.owned_lock():call()
        else:
            require(not self.args.owner_id,'Recovery owner requires --apply');call()


def parse(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['prepare','apply','enable','disable','rollback'])
    for name in ('sha','branch','branch-id','expected-api-sha','expected-public-sha','expected-api-image','expected-compose-sha256','expected-gateway-sha256'):
        p.add_argument('--'+name,required=True)
    p.add_argument('--ssh-key',type=Path,required=True);p.add_argument('--backup-identity',type=Path);p.add_argument('--windows-proof',type=Path)
    ci=p.add_mutually_exclusive_group(required=True);ci.add_argument('--ci-run');ci.add_argument('--ci-proof',type=Path)
    p.add_argument('--owner-id');p.add_argument('--apply',action='store_true');return p.parse_args(argv)


def main(argv=None):
    os.umask(0o077);release=Release(parse(argv))
    try:release.run()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error,GuardFailure) else 'Stopped; inspect private evidence and retained lock.',file=sys.stderr)
        raise SystemExit(1)

if __name__=='__main__':main()
