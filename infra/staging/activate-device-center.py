#!/usr/bin/env python3
"""Enable pairing on the reviewed schema058 API after real Windows020 preparation.

No deployment, migration, credentials, data edits or public route changes. Exact
operator/API CI, source/image/config/ledger pins, Windows proof and shared lease
are mandatory. Unknown completion retains the lease. Default is read-only.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

spec = importlib.util.spec_from_file_location('center_access_base', Path(__file__).with_name('release-device-access.py'))
d = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = d
spec.loader.exec_module(d)
b, m = d.base, d.market
require, digest, quote = d.require, d.digest, d.quote
FLAG = 'BACKOFFICE_DEVICE_ACCESS_ENABLED'
TABLES = ('device_terminal_registry', 'cloud_device_commands', 'device_events',
          'cloud_kitchen_password_resets', 'kitchen_password_reset_events')
ADDITIONS = frozenset([(t, None, 'INSERT') for t in TABLES] +
                     [('device_terminal_registry', c, 'UPDATE') for c in ('generation', 'paired_at')] +
                     [(t, c, 'UPDATE') for t in ('cloud_device_commands', 'cloud_kitchen_password_resets')
                      for c in ('state', 'delivered_at', 'resolved_at')] + [('devices', None, 'INSERT')])


def candidate(text, expected):
    require(digest(text.encode()) == expected, 'Reviewed compose changed')
    require(FLAG not in text and text.count('\n  api:\n') == 1, 'Expected absent pairing flag')
    start = text.index('\n  api:\n') + 1
    match = re.search(r'^  [A-Za-z][A-Za-z0-9_-]*:', text[start + 7:], re.M)
    end = start + 7 + match.start() if match else len(text)
    section = text[start:end]
    anchor = '      DEVICE_CENTER_ENABLED: "true"\n'
    require(section.count(anchor) == 1, 'Device center must be installed first')
    line = f'      {FLAG}: "true"\n'
    result = text[:start] + section.replace(anchor, anchor + line) + text[end:]
    require(result.replace(line, '', 1) == text, 'Unrelated compose delta')
    return result


def grant_sql():
    statements = []
    for table, column, privilege in sorted(ADDITIONS, key=str):
        name = f'"{table}"'
        columns = f'("{column}")' if column else ''
        statements.append(f'GRANT {privilege}{columns} ON {name} TO pickchick_app')
    return "BEGIN; SET LOCAL lock_timeout='5s'; SELECT pg_advisory_xact_lock(724001);\n" + ';\n'.join(statements) + ';\nCOMMIT;'


class Activation(d.Release):
    def __init__(self, args):
        d.check_pins(args)
        jobs = b.workflow_jobs((m.REPO/'.github/workflows/ci.yml').read_text())
        profile = m.ReleaseProfile('device-center-pairing058', args.expected_api_sha,
            args.expected_public_sha, 57, (), jobs, frozenset(), 'device-center-activation', (), exact_ci_jobs=True)
        m.Release.__init__(self, args, profile)
        self.branch_id = args.branch_id

    def sources(self):
        require(self.git('rev-parse', 'HEAD') == self.sha and not self.git('status', '--porcelain'),
                'Clean checked operator source required')
        require(re.fullmatch(r'codex/[a-z0-9/-]+', self.args.branch), 'Reviewed branch required')
        require(self.git('ls-remote', 'origin', 'refs/heads/'+self.args.branch).split()[0] == self.sha,
                'Published operator source differs')
        self.ci()
        m.verify_ci(json.loads(self.args.api_ci_proof.read_text()), self.args.expected_api_sha,
                    self.profile.ci_jobs, exact_jobs=True)
        require(self.git('show', self.args.expected_api_sha+':db/cloud/migrations/058_cloud_device_center.sql') ==
                (m.REPO/'db/cloud/migrations/058_cloud_device_center.sql').read_text().strip(), 'API schema differs')

    def baseline(self):
        a = self.args
        require(self.running_revision() == a.expected_api_sha and self.api_image() == a.expected_api_image,
                'Reviewed API changed')
        require(self.remote('readlink -f '+m.REMOTE+'/current') == m.REMOTE+'/releases/'+a.expected_api_sha,
                'API pointer changed')
        require(self.remote('readlink -f '+m.REMOTE+'/public-https/current') == m.REMOTE+'/public-https/releases/'+a.expected_public_sha,
                'Public pointer changed')
        require(self.remote('docker exec '+m.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] ==
                a.expected_gateway_sha256, 'Gateway changed')
        names = sorted(Path(p).name for p in self.git('ls-tree','-r','--name-only',a.expected_api_sha,'--','db/cloud/migrations').splitlines())
        require([int(n[:3]) for n in names] == list(range(1,41))+list(range(42,59)), 'Exact schema058 source required')
        expected = [{'version':n, 'scope':'cloud', 'checksum':digest(self.execute(['git','show',a.expected_api_sha+':db/cloud/migrations/'+n]))} for n in names]
        require(self.ledger() == expected, 'Live schema058 ledger differs')
        self.ready(); self.role_restricted()
        env = self.runtime_environment()
        require(env.get(FLAG) is None and env.get('DEVICE_CENTER_ENABLED') == digest(b'true'),
                'Pairing must be off and inventory on')
        acl = self.acl()
        require(not ({b.acl_key(r) for r in acl} & ADDITIONS), 'Pairing grants already present; inspect prior attempt')
        require(all((t, None, 'SELECT') in {b.acl_key(r) for r in acl} for t in TABLES), 'Inventory read grants missing')
        old = self.read_text(self.compose_path(a.expected_api_sha))
        return {'compose': old, 'candidate': candidate(old,a.expected_compose_sha256),
                'environment': env, 'acl':acl, 'neighbors':self.neighbors(), 'ledger':expected,
                'capabilities':self.http_json('/v1/capabilities',public=False)}

    def windows_ready(self):
        path = self.args.windows_proof
        require(path.is_file() and not path.is_symlink() and path.stat().st_mode & 0o077 == 0,
                'Protected actual Windows preparation proof required')
        proof = json.loads(path.read_text()); sha = self.args.expected_api_sha
        devices = self.json_query("SELECT coalesce(json_agg(id),'[]') FROM devices WHERE kind='edge' AND status='active' AND branch_id='"+self.branch_id+"'")
        require(len(devices)==1,'Exactly one active edge required')
        raw = lambda p: self.execute(['git','show',sha+':'+p])
        d.check_windows(proof,sha,self.branch_id,devices[0],digest(raw('db/edge/migrations/020_terminal_access.sql')))
        require(proof['worker']['script_sha256']==digest(raw('infra/windows/native-device-access-worker.mjs')),
                'Prepared worker source differs')
        require(proof['link']['files']=={p:digest(raw(p)) for p in d.LINK_FILES}, 'Prepared KitchenLink source differs')
        heart=self.heartbeat()
        require(heart and heart.get('device_matches') is True and 0<=heart.get('age_seconds',999)<=30,
                'Fresh matching edge heartbeat required')
        return proof

    def run(self):
        self.sources(); before=self.baseline(); windows=self.windows_ready()
        if not self.args.apply:
            print(json.dumps({'validated':True,'applied':False,'schema':58,'windows_schema':20}));return
        with self.deployment_lock():
            require(self.baseline()==before,'Baseline drift after lease')
            windows=self.windows_ready()
            require(not (self.private/'enable-attempt.json').exists(), 'Attempt already exists; inspect outcome')
            self.save('before.json',before);self.save('windows-prepared.json',windows)
            self.save('enable-attempt.json',{'api_sha':self.args.expected_api_sha,'at':time.time()})
            self.psql(m.DB,grant_sql())
            b.verify_acl_change(before['acl'],self.acl(),added=ADDITIONS,present=ADDITIONS)
            path=self.compose_path(self.args.expected_api_sha)
            require(self.read_text(path)==before['compose'],'Compose changed before activation')
            try:
                self.write_remote(path,before['candidate'])
                self.remote(m.api_compose(self.args.expected_api_sha)+' config --quiet')
                self.remote(m.api_compose(self.args.expected_api_sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
                self.ready();self.role_restricted()
                b.verify_environment_delta(before['environment'],self.runtime_environment(),{FLAG:'true'})
                require(self.running_revision()==self.args.expected_api_sha and self.api_image()==self.args.expected_api_image,'API image changed')
                require(self.ledger()==before['ledger'] and self.neighbors()==before['neighbors'],'Schema or neighbor changed')
                require(self.http_json('/v1/capabilities',public=False)==before['capabilities'],'Capabilities changed')
                b.verify_acl_change(before['acl'],self.acl(),added=ADDITIONS,present=ADDITIONS)
            except m.CommandUncertain: raise
            except Exception:
                self.write_remote(path,before['compose'])
                self.remote(m.api_compose(self.args.expected_api_sha)+' up -d --no-deps --wait --wait-timeout 120 api',timeout=180)
                self.ready()
                b.verify_environment_delta(before['environment'],self.runtime_environment(),{})
                self.save('rollback.json',{'pairing':False,'additive_grants_retained':True,'data_unchanged':True})
                raise
            self.save('enabled.json',{'format':'pickchick-device-access-cloud-enabled-v1',
                'source_sha':self.args.expected_api_sha,'operator_sha':self.sha,'branch_id':self.branch_id,
                'edge_device_id':windows['edge_device_id'],'device_access_enabled':True,'completed_epoch':time.time()})
        print(json.dumps({'enabled':True,'api_sha':self.args.expected_api_sha,'schema':58}))


def main():
    os.umask(0o077)
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('sha','branch','branch-id','expected-api-sha','expected-api-image','expected-public-sha',
                 'expected-compose-sha256','expected-gateway-sha256'):
        p.add_argument('--'+name,required=True)
    for name in ('ci-proof','api-ci-proof','windows-proof','ssh-key'):
        p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--apply',action='store_true')
    a=p.parse_args();a.action='enable';a.ci_run=None
    r=Activation(a)
    try:r.run()
    except Exception as error:
        r.record_error(error)
        print(str(error) if isinstance(error,m.GuardFailure) else 'Activation stopped; inspect protected evidence and lease.',file=sys.stderr)
        raise SystemExit(1)

if __name__=='__main__': main()
