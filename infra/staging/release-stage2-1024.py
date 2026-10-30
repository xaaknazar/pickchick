#!/usr/bin/env python3
"""API-only release on installed schema071; no migrations, workers or prices; three new flags stay false.

Default is read-only. An exact published source/CI, owned deployment lock,
encrypted backup, isolated restore and candidate startup are required for apply.
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

spec = importlib.util.spec_from_file_location('stage21024_base', Path(__file__).with_name('release-live-menu.py'))
live = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = live
spec.loader.exec_module(live)
base, market = live.base, live.market
require, digest, quote, REMOTE = live.require, live.digest, live.quote, live.REMOTE
BASELINE = 'c3a0fbeea69e3c94b4a0994f5cdee74ba98c77da'
# Reviewed shared runtime including the installed App Review/legal API contract.
# Evidence and remaining release gates: docs/operations/stage2-windows-1030/README.md.
ACCEPTED = 'e4eb91b52ed912254e388513853e72b430d12c88'
# Inherited prepare/rollback use their module's pin; this private import does not change old tools.
live.BASELINE = BASELINE
SUPPORT = {'infra/staging/release-stage2-1024.py', 'tests/operations/test_stage2_release_1024.py',
           'infra/windows/update-runtime-stage2-1024.ps1', 'tests/operations/test_windows_stage2_release.py',
           '.github/workflows/ci.yml', '.github/workflows/offline-stand.yml', '.github/workflows/windows-pos.yml',
           'docs/project-status.md', 'docs/roadmap/project.json',
           'docs/collaboration/handoff.md'}
FLAGS = {'CATALOG_EDGE_COMBO_STOPS_ENABLED', 'BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED',
         'BACKOFFICE_RECONCILIATION_ENABLED'}
LEDGER_HEAD = '071_cloud_daily_reconciliation.sql'


def compose_candidate(text, expected):
    require(digest(text.encode()) == expected, 'Installed compose differs from reviewed hash')
    require(not any(k in text for k in FLAGS), 'Stage2 flags already present; inspect baseline')
    original = text
    block = ''.join('      '+k+': "false"\n' for k in sorted(FLAGS))
    for name in ('api', 'provision'):
        marker = '\n  '+name+':\n'
        require(text.count(marker) == 1, 'Ambiguous service boundary')
        start = text.index(marker)+1
        tail = start+len(marker)-1
        match = re.search(r'^  [A-Za-z][A-Za-z0-9_-]*:', text[tail:], re.M)
        end = tail+match.start() if match else len(text)
        section = text[start:end]
        anchor = '      APP_ENV: staging\n'
        require(section.count(anchor) == 1, 'Service environment anchor differs')
        text = text[:start]+section.replace(anchor, block+anchor)+text[end:]
    require(text.replace(block, '') == original, 'Unrelated compose change')
    return text


def check_environment(before, after):
    base.verify_environment_delta(before, after, {k:'false' for k in FLAGS}, release_sha_may_change=True)


def check_flags(env):
    require(all(env.get(k) in (None, digest(b'false'), digest(b'0')) for k in FLAGS), 'New optional programs must remain disabled')


def check_delta(paths):
    require(all(p in SUPPORT or p.startswith(('docs/operations/stage2-2026-10-24/', 'docs/operations/stage2-windows-1030/')) for p in paths), 'Runtime differs from reviewed candidate; refresh accepted pin after integration')


def check_receipt(result):
    require(result.get('ok') is True and result.get('checksum') == 'verified'
            and result.get('migration') == LEDGER_HEAD and result.get('restore') == 'passed'
            and result.get('candidate_startup') == 'passed', 'Isolated backup restore and API startup required')


def check_capabilities(before, after):
    require({k:v for k,v in before.items() if k != 'notice'} == {k:v for k,v in after.items() if k != 'notice'},
            'Installed-client capability gates changed')
    require(set(after.get('notice', {})) == {'ru', 'kk'} and all(isinstance(v, str) and v for v in after['notice'].values()),
            'Missing translated capability notice')


def rehearsal_environment(env, password, redis_password, sha):
    """Keep the staging URL contract; both hostnames resolve inside network:none."""
    require(all(re.fullmatch('[a-f0-9]{64}', p) for p in (password, redis_password)),
            'Synthetic rehearsal credentials required')
    return {**env, 'CLOUD_DATABASE_URL':'postgresql://pickchick_app:'+password+'@cloud-db:5432/'+market.DB,
            'REDIS_URL':'redis://default:'+redis_password+'@redis-cache:6379/0', 'RELEASE_SHA':sha}


class Release(live.Release):
    def __init__(self, args):
        live.check_pins(args)
        profile = market.ReleaseProfile('stage2-schema071-1024', BASELINE, args.expected_public_sha,
            64, (), base.workflow_jobs((market.REPO/'.github/workflows/ci.yml').read_text()), frozenset(),
            'stage2-release-1024', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def source_checks(self):
        require(re.fullmatch('[a-f0-9]{40}', self.sha) and self.sha != BASELINE, 'Full candidate SHA required')
        require(self.git('rev-parse', 'HEAD') == self.sha and not self.git('status', '--porcelain', '--untracked-files=all'),
                'Release checkout must be clean and exact')
        require(re.fullmatch('[A-Za-z0-9._/-]{1,160}', self.args.branch) and '..' not in self.args.branch, 'Invalid branch')
        require(self.git('ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/'+self.args.branch).split()[0] == self.sha,
                'Published source differs')
        self.execute(['git', 'merge-base', '--is-ancestor', ACCEPTED, self.sha])
        # Never remove already deployed legal/App Review behavior. Integration needs a new reviewed pin.
        self.execute(['git', 'merge-base', '--is-ancestor', BASELINE, self.sha])
        check_delta(self.git('diff', '--name-only', ACCEPTED, self.sha).splitlines())

    def baseline_migrations(self):
        names = sorted(p.name for p in (market.REPO/'db/cloud/migrations').glob('*.sql') if int(p.name[:3]) <= 71)
        require([int(n[:3]) for n in names] == list(range(1,41))+list(range(42,59))+[60,64,66,68,69,70,71], 'Exact schema071 required')
        return names

    def baseline(self):
        a = self.args
        require(self.running_revision() == BASELINE and self.api_image() == a.expected_api_image, 'Live API baseline differs')
        require(self.remote('docker image inspect --format '+quote('{{.Id}}')+' pickchick-api:'+BASELINE) == a.expected_api_image,
                'Rollback image differs')
        require(self.remote('readlink -f '+REMOTE+'/current') == REMOTE+'/releases/'+BASELINE, 'API pointer differs')
        require(self.ledger() == self.expected_ledger(), 'Installed schema is not exact071')
        self.runtime_acl(); self.verify_public()
        env = self.runtime_environment(); check_flags(env)
        text = self.read_text(self.compose_path(BASELINE))
        text = compose_candidate(text, a.expected_compose_sha256)
        return {'candidate':text, 'environment':env, 'rollback':self.rollback_artifacts(),
                'neighbors':self.neighbors(), 'acl':self.acl(), 'capabilities':self.http_json('/v1/capabilities', public=False)}

    def prepare(self):
        if not self.args.apply:
            self.baseline()
            return self.plan('prepare', {'api_only': True, 'schema': 71, 'stage2_flags': 'false'})
        return super().prepare()

    def current(self, proof):
        require(self.running_revision() == self.sha and self.api_image() == proof['artifacts']['image'], 'Candidate API differs')
        require(self.remote('readlink -f '+REMOTE+'/current') == REMOTE+'/releases/'+self.sha, 'Candidate pointer differs')
        require(self.ledger() == self.expected_ledger() and self.acl() == proof['before']['acl'], 'Schema or ACL changed')
        require(self.neighbors() == proof['before']['neighbors'] and self.rollback_artifacts() == proof['before']['rollback'],
                'Neighbor or rollback artifacts changed')
        require(self.artifacts() == proof['artifacts'], 'Candidate artifacts changed')
        env = self.runtime_environment(); check_flags(env)
        check_environment(proof['before']['environment'], env)
        self.runtime_acl(); self.verify_public()
        check_capabilities(proof['before']['capabilities'], self.http_json('/v1/capabilities', public=False))

    def rollback(self):
        check_flags(self.runtime_environment())
        return super().rollback()

    def backup_restore(self):
        identity = self.args.backup_identity
        require(identity and identity.is_file() and not identity.is_symlink() and identity.stat().st_mode & 0o077 == 0,
                'Protected local backup identity required')
        proof = self.prepared()
        config = {'stage':REMOTE+'/releases/'+self.sha, 'image':proof['artifacts']['image'],
                  'acl':proof['before']['acl'], 'suffix':uuid.uuid4().hex, 'sha':self.sha,
                  'capabilities':proof['before']['capabilities']}
        command = 'python3 '+quote(config['stage']+'/infra/staging/release-stage2-1024.py')+' remote-rehearsal '+quote(json.dumps(config))
        result = json.loads(self.remote(command, input=identity.read_bytes(), timeout=900))
        check_receipt(result)
        self.save('backup.json', result)
        for path in result['encrypted_files']:
            require(re.fullmatch(REMOTE+r'/backups/cloud-stage21024-[a-f0-9]{32}\.(dump\.age(?:\.sha256)?|manifest\.json\.age)', path), 'Invalid backup path')
            target = self.private/Path(path).name
            require(not target.exists(), 'Encrypted copy exists')
            self.execute(['scp','-q','-i',str(self.args.ssh_key.expanduser()),'-o','IdentitiesOnly=yes','-o','BatchMode=yes',
                          '-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','pickchick-ops@'+market.IP+':'+path,str(target)], timeout=180)
            target.chmod(0o600)
        require(digest((self.private/Path(result['encrypted_files'][0]).name).read_bytes()) == result['sha256'], 'Copied backup differs')
        return result

    def apply(self):
        proof = self.prepared()
        require(self.baseline() == proof['before'] and self.artifacts() == proof['artifacts'], 'Prepared baseline/artifacts drift')
        if not self.args.apply:
            return self.plan('apply', {'api_only':True, 'schema':71, 'backup_restore_startup_required':True})
        backup = self.backup_restore(); check_receipt(backup)
        require(self.baseline() == proof['before'] and self.artifacts() == proof['artifacts'], 'Drift during backup/rehearsal')
        self.save('apply-attempt.json', {'sha':self.sha, 'backup_sha256':backup['sha256'], 'at':time.time()})
        self.remote(market.api_compose(self.sha)+' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
        self.ready()
        require(self.api_image() == proof['artifacts']['image'], 'API image differs')
        self.switch(REMOTE+'/current', REMOTE+'/releases/'+BASELINE, REMOTE+'/releases/'+self.sha)
        self.current(proof)
        self.save('applied.json', {'sha':self.sha, 'schema':71, 'backup_sha256':backup['sha256'],
                                  'stage2_flags_false':True, 'other_environment_acl_neighbors_unchanged':True, 'at':time.time()})


def remote_rehearsal(config):
    import subprocess
    import secrets
    spec = importlib.util.spec_from_file_location('stage21024_drill', Path(__file__).with_name('restore-drill.py'))
    drill = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(drill)
    identity = drill.Identity(sys.stdin.read())
    stage, suffix, image = config['stage'], config['suffix'], config['image']
    require(re.fullmatch(REMOTE+'/releases/[a-f0-9]{40}', stage) and re.fullmatch('[a-f0-9]{32}', suffix) and re.fullmatch('sha256:[a-f0-9]{64}', image), 'Invalid rehearsal pins')
    dump = REMOTE+'/backups/cloud-stage21024-'+suffix+'.dump.age'
    manifest = dump.replace('.dump.age', '.manifest.json.age')
    # The same per-table manifest and shared backup lock as backup.sh; no retention/offsite changes.
    script = f'''set -euo pipefail
umask 077
exec 9>{REMOTE}/backups/.lock
flock -n 9
recipient=$(cat {REMOTE}/secrets/backup-recipient.txt)
[[ "$recipient" == age1* ]]
test ! -e {dump}
before=$(docker exec {market.DB_CONTAINER} psql -XqAt -v ON_ERROR_STOP=1 -U postgres -d {market.DB} -c {quote(drill.COUNTS_SQL)})
docker exec {market.DB_CONTAINER} pg_dump -U postgres -d {market.DB} --format=custom --no-owner --no-acl | age -r "$recipient" -o {dump}
after=$(docker exec {market.DB_CONTAINER} psql -XqAt -v ON_ERROR_STOP=1 -U postgres -d {market.DB} -c {quote(drill.COUNTS_SQL)})
printf '{{"before":%s,"after":%s}}' "$before" "$after" | age -r "$recipient" -o {manifest}
sha256sum {dump} > {dump}.sha256
'''
    subprocess.run(['bash','-c',script], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)
    require(drill.verify_checksum(Path(dump)), 'Encrypted checksum required')
    expected = json.loads(identity.decrypt_bytes(manifest))
    name = 'pickchick-runtime-rehearsal-'+suffix
    try:
        drill.run_container(name, drill.IMAGE)
        # Containers sharing this network also inherit its hosts file. Keep the
        # production hostname validation, with no external route or DNS lookup.
        subprocess.run(['docker','exec',name,'sh','-c',
                        "printf '\\n127.0.0.1 cloud-db redis-cache\\n' >> /etc/hosts"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        drill.wait_ready(name)
        restore = subprocess.Popen(['docker','exec','-i',name,'pg_restore','-U','postgres','-d',market.DB,'--exit-on-error','--no-owner','--no-acl'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        decrypted = identity.decrypt(dump, restore.stdin)
        restore.stdin.close()
        require(restore.wait(300) == 0 and decrypted == 0, 'Isolated restore failed')
        counts = drill.counts(name, market.DB)
        require(not drill.compare(counts, expected) and counts['migration'] == LEDGER_HEAD, 'Restored manifest differs')
        # Re-create only the runtime ACL in the isolated clone, which was dumped without owners/ACL.
        password = secrets.token_hex(32)
        sql = ["CREATE ROLE pickchick_app LOGIN PASSWORD '"+password+"';", 'GRANT USAGE ON SCHEMA public TO pickchick_app;']
        for row in config['acl']:
            table, column, privilege = row['name'], row['column'], row['privilege']
            require(re.fullmatch('[a-z][a-z0-9_]*',table) and (column is None or re.fullmatch('[a-z][a-z0-9_]*',column)) and privilege in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','USAGE') and not row['grantable'], 'Unsupported cloned ACL')
            sql.append('GRANT '+privilege+(' ("'+column+'")' if column else '')+' ON '+('SEQUENCE ' if row['kind']=='S' else 'TABLE ')+'"'+table+'" TO pickchick_app;')
        subprocess.run(['docker','exec','-i',name,'psql','-Xq','-v','ON_ERROR_STOP=1','-U','postgres','-d',market.DB], input='\n'.join(sql).encode(), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        runtime = json.loads(subprocess.check_output(['docker','inspect',market.API_CONTAINER]))[0]
        require(runtime['Mounts'] == [], 'Unreviewed runtime mounts')
        env = dict(v.split('=',1) for v in runtime['Config']['Env'])
        check_flags({k:digest(v.encode()) for k,v in env.items()})
        redis_password = secrets.token_hex(32)
        env = rehearsal_environment({**env, **{k:'false' for k in FLAGS}}, password, redis_password, config['sha'])
        redis_image = subprocess.check_output(['docker','inspect','--format','{{.Image}}','pickchick-staging-redis-cache-1'], text=True).strip()
        require(re.fullmatch('sha256:[a-f0-9]{64}', redis_image), 'Redis image not immutable')
        common = ['docker','run','-d','--network','container:'+name,'--read-only','--cap-drop','ALL',
                  '--security-opt','no-new-privileges:true','--memory','512m','--cpus','1','--pids-limit','128']
        subprocess.run(common+['--name',name+'-redis',redis_image,'redis-server','--save','','--appendonly','no',
                               '--requirepass',redis_password],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        command = common+['--name',name+'-api']
        for key in sorted(env): command += ['-e',key]
        subprocess.run(command+[image,'node','services/api/dist/main.js'], env={**os.environ,**env},
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        program = "const r=await fetch('http://127.0.0.1:3100/health/ready');if(!r.ok)process.exit(1);const j=await r.json();if(!j.ready)process.exit(1);"
        deadline = time.monotonic()+120
        while True:
            probe = subprocess.run(['docker','exec',name+'-api','node','--input-type=module','-e',program],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            if probe.returncode == 0: break
            require(time.monotonic() < deadline, 'Isolated candidate readiness failed')
            time.sleep(2)
        program = "const r=await fetch('http://127.0.0.1:3100/v1/capabilities');if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()));"
        caps = subprocess.run(['docker','exec',name+'-api','node','--input-type=module','-e',program],
                              check=True, capture_output=True, timeout=20)
        check_capabilities(config['capabilities'], json.loads(caps.stdout))
        program = "for(const p of ['/v1/customer-checkout/catalog','/v1/customer-checkout/availability']){const r=await fetch('http://127.0.0.1:3100'+p);if(!r.ok)process.exit(1);await r.json();}"
        subprocess.run(['docker','exec',name+'-api','node','--input-type=module','-e',program],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        require(drill.counts(name, market.DB)['tables'] == counts['tables'], 'Startup unexpectedly changed restored data')
        return {'restore':'passed', 'candidate_startup':'passed', 'ok':True, 'checksum':'verified',
                'migration':counts['migration'], 'tables':len(counts['tables']),
                'encrypted_files':[dump,dump+'.sha256',manifest], 'sha256':Path(dump+'.sha256').read_text().split()[0]}

    finally:
        for container in (name+'-api', name+'-redis', name):
            drill.docker('rm','-f','-v',container,check=False,capture_output=True)


def parse(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['prepare','apply','rollback'])
    for name in ('sha','branch','expected-api-sha','expected-public-sha','expected-api-image','expected-compose-sha256','expected-gateway-sha256'):
        p.add_argument('--'+name, required=True)
    for name in ('ssh-key','backup-identity','ci-proof'):
        p.add_argument('--'+name, type=Path, required=name=='ssh-key')
    p.add_argument('--ci-run'); p.add_argument('--owner-id'); p.add_argument('--apply', action='store_true')
    return p.parse_args(argv)


def main():
    os.umask(0o077)
    if len(sys.argv) == 3 and sys.argv[1] == 'remote-rehearsal':
        try: print(json.dumps(remote_rehearsal(json.loads(sys.argv[2]))))
        except Exception:
            print('Isolated backup/API rehearsal failed; no live API switch dispatched.', file=sys.stderr)
            raise SystemExit(1)
        return
    release = Release(parse())
    try: release.run()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error, market.GuardFailure) else 'Stopped; inspect private evidence; owned lock retained.', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
