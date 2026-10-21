#!/usr/bin/env python3
"""Schema-only 058 -> 060 -> 064/066/068. No runtime, pointers, flags or catalog changes.

Prepare and apply default to inspection. Mutations require --apply, exact CI, clean
published source, reviewed live pins, the shared deployment lock and an encrypted
backup whose isolated restore and migration rehearsal passed. No automatic DOWN.
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

spec = importlib.util.spec_from_file_location('cloud1021_base', Path(__file__).with_name('release-unified-menu.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, require, digest, quote, REMOTE = base.market, base.require, base.digest, base.quote, base.REMOTE
ACCEPTED = 'd15bde82a87a85f1f5c4004c7c3be3c76d0977a2'
BASELINE = '5b6f846b80785f915e9f8dd7d45fa72fd4bc13ee'
MIGRATIONS = ('060_cloud_combo_rewards.sql', '064_cloud_cashier_ordering_state.sql', '066_cloud_edge_identity_rotation.sql', '068_cloud_identity_abuse_limits.sql')
SUPPORT = {'infra/staging/combo-rewards-owner.mjs', 'infra/staging/release-cloud-migrations-1021.py', 'tests/integration/combo-rewards-owner.test.mjs', 'tests/operations/test_cloud_migrations_1021.py', 'docs/operations/deployments/2026-10-21-cloud-migrations.md'}
FLAGS = ('CUSTOMER_COMBO_REWARDS_ENABLED', 'CLOUD_EDGE_IDENTITY_ROTATION_ENABLED')


def check_flags(env):
    require(all(env.get(k) in (None, digest(b'false')) for k in FLAGS), 'Rewards/identity rotation must remain disabled')


def check_source_delta(paths):
    require(set(paths) <= SUPPORT, 'Only reviewed migration tooling may differ from accepted PR262')


def verify_receipt(result):
    require(result.get('ok') is True and result.get('checksum') == 'verified' and result.get('migration') == '058_cloud_device_center.sql' and result.get('rehearsal') == 'passed' and result.get('rollback') == 'passed', 'Backup restore and migration rehearsal required')


class Release(base.Release):
    def __init__(self, args):
        require(args.expected_api_sha == BASELINE, 'Exact installed schema058 API required')
        require(re.fullmatch('[a-f0-9]{40}', args.expected_public_sha), 'Reviewed public SHA required')
        require(re.fullmatch('sha256:[a-f0-9]{64}', args.expected_api_image), 'Reviewed image required')
        for k in ('expected_compose_sha256', 'expected_gateway_sha256'):
            require(re.fullmatch('[a-f0-9]{64}', getattr(args, k)), 'Reviewed live hash required')
        profile = market.ReleaseProfile('cloud-schema-1021', BASELINE, args.expected_public_sha, 57, MIGRATIONS, base.workflow_jobs((market.REPO/'.github/workflows/ci.yml').read_text()), frozenset(), 'cloud-schema-1021', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)
        self.stage = REMOTE + '/cloud-schema-tools/' + self.sha

    def source_checks(self):
        market.Release.source_checks(self)
        self.execute(['git', 'merge-base', '--is-ancestor', ACCEPTED, self.sha])
        check_source_delta(self.git('diff', '--name-only', ACCEPTED, self.sha).splitlines())

    def baseline_migrations(self):
        paths = self.git('ls-tree', '-r', '--name-only', BASELINE, '--', 'db/cloud/migrations').splitlines()
        names = sorted(Path(p).name for p in paths if p.endswith('.sql'))
        require([int(n[:3]) for n in names] == list(range(1, 41)) + list(range(42, 59)), 'Exact schema058 files required')
        return names

    def expected_ledger(self, step=58):
        names = self.baseline_migrations() + [n for n in MIGRATIONS if int(n[:3]) <= step]
        return [{'version': n, 'scope': 'cloud', 'checksum': digest((market.REPO/'db/cloud/migrations'/n).read_bytes())} for n in names]

    def runtime(self):
        a = self.args
        require(self.running_revision() == BASELINE and self.api_image() == a.expected_api_image, 'Live API differs')
        require(self.remote('docker image inspect --format '+quote('{{.Id}}')+' pickchick-api:'+BASELINE) == a.expected_api_image, 'Pinned tools image differs')
        require(self.remote('readlink -f '+REMOTE+'/current') == REMOTE+'/releases/'+BASELINE, 'API pointer differs')
        require(self.remote('readlink -f '+REMOTE+'/public-https/current') == REMOTE+'/public-https/releases/'+a.expected_public_sha, 'Public pointer differs')
        require(self.file_hashes([self.compose_path(BASELINE)])[self.compose_path(BASELINE)] == a.expected_compose_sha256, 'Compose differs')
        require(self.remote('docker exec '+market.GATEWAY+' sha256sum /etc/caddy/Caddyfile').split()[0] == a.expected_gateway_sha256, 'Gateway differs')
        env = self.runtime_environment()
        check_flags(env)
        # Include the API and gateway, which parent fingerprint intentionally omits.
        neighbors = self.fingerprint()
        for name in (market.API_CONTAINER, market.GATEWAY):
            neighbors['containers'][name] = self.remote('docker inspect --format '+quote('{{.Id}} {{.Image}} {{.State.StartedAt}} {{.State.Status}} {{.RestartCount}}')+' '+name)
        self.ready()
        return {'environment': env, 'files': self.rollback_artifacts(), 'neighbors': neighbors}

    def artifacts(self):
        paths = self.git('ls-tree', '-r', '--name-only', self.sha, '--', 'infra/staging', 'db/cloud/migrations').splitlines()
        expected = {self.stage+'/'+p: digest((market.REPO/p).read_bytes()) for p in paths}
        require(self.file_hashes(list(expected)) == expected, 'Staged migration tools differ')
        return digest(expected)

    def owner(self, action):
        require(action in ('inspect-060', 'apply-060', 'inspect-068', 'apply-068'), 'Invalid migration action')
        # The CURRENT pinned image supplies Node/dependencies; only reviewed tools/SQL are mounted.
        command = market.api_compose(BASELINE)+' run --rm --no-deps -T -e CUSTOMER_COMBO_REWARDS_ENABLED=false --entrypoint node'
        for part in ('infra/staging', 'db/cloud/migrations'):
            command += ' -v '+quote(self.stage+'/'+part+':/app/'+part+':ro')
        command += ' provision infra/staging/combo-rewards-owner.mjs '+action
        return json.loads(self.remote(command, timeout=900).splitlines()[-1])

    def prepare(self):
        before = self.runtime()
        require(self.ledger() == self.expected_ledger(), 'Exact schema058 ledger required')
        if not self.args.apply:
            return self.plan('prepare', {'schema_only': True, 'migrations': list(MIGRATIONS)})
        require(not (self.private/'prepared.json').exists(), 'Already prepared; inspect original evidence')
        archive = self.execute(['git', 'archive', self.sha, 'infra/staging', 'db/cloud/migrations'])
        self.remote('mkdir -p '+REMOTE+'/cloud-schema-tools && mkdir -m 700 '+self.stage)
        self.remote('tar -xf - -C '+self.stage, input=archive)
        artifacts = self.artifacts()
        self.owner('inspect-060')
        require(self.runtime() == before, 'Runtime changed during preparation')
        self.save('prepared.json', {'sha': self.sha, 'before': before, 'acl': self.acl(), 'artifacts': artifacts, 'archive_sha256': digest(archive)})
        self.plan('prepared', {'schema_only': True, 'artifacts': artifacts})

    def backup_restore(self, acl):
        identity = self.args.backup_identity
        require(identity and identity.is_file() and not identity.is_symlink() and identity.stat().st_mode & 0o077 == 0, 'Protected local age identity required')
        # On the remote host, isolated containers are short-lived and never join a production network.
        config = {'stage': self.stage, 'image': self.args.expected_api_image, 'acl': acl, 'suffix': uuid.uuid4().hex}
        command = 'python3 '+quote(self.stage+'/infra/staging/release-cloud-migrations-1021.py')+' remote-rehearsal '+quote(json.dumps(config))
        result = json.loads(self.remote(command, input=identity.read_bytes(), timeout=1800))
        verify_receipt(result)
        self.save('backup.json', result)
        # Keep an encrypted copy on this Mac as well; never transfer decrypted rows.
        for path in result['encrypted_files']:
            require(re.fullmatch(REMOTE+r'/backups/cloud-schema1021-[a-f0-9]{32}\.(dump\.age(?:\.sha256)?|manifest\.json\.age)', path), 'Unexpected backup path')
            target = self.private/Path(path).name
            require(not target.exists(), 'Encrypted copy already exists')
            self.execute(['scp', '-q', '-i', str(self.args.ssh_key.expanduser()), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', 'pickchick-ops@'+market.IP+':'+path, str(target)], timeout=180)
            target.chmod(0o600)
        require(digest((self.private/Path(result['encrypted_files'][0]).name).read_bytes()) == result['sha256'], 'Copied encrypted backup differs')
        return result

    def apply(self):
        proof = json.loads((self.private/'prepared.json').read_text())
        require(proof['sha'] == self.sha and self.artifacts() == proof['artifacts'], 'Preparation differs')
        require(self.runtime() == proof['before'] and self.acl() == proof['acl'], 'Live baseline changed')
        require(self.ledger() == self.expected_ledger(), 'Exact schema058 ledger required')
        if not self.args.apply:
            return self.plan('apply', {'backup_restore_rehearsal_required': True, 'runtime_changes': False})
        require(not (self.private/'apply-attempt.json').exists(), 'Apply dispatched already; inspect outcome before retry')
        backup = self.backup_restore(proof['acl'])
        require(self.runtime() == proof['before'] and self.acl() == proof['acl'] and self.ledger() == self.expected_ledger(), 'Baseline drift during backup')
        self.save('apply-attempt.json', {'sha': self.sha, 'backup_sha256': backup['sha256'], 'at': time.time()})
        self.owner('inspect-060')
        first = self.owner('apply-060')
        self.save('owner-060.json', first)
        require(first.get('applied') == [MIGRATIONS[0]] and first.get('existingDataPreserved') is True and first.get('rewardsEnabled') is False, '060 evidence differs')
        require(self.ledger() == self.expected_ledger(60) and self.acl() == proof['acl'], '060 ledger/ACL differs')
        self.owner('inspect-068')
        second = self.owner('apply-068')
        self.save('owner-068.json', second)
        require(second.get('applied') == list(MIGRATIONS[1:]) and second.get('existingDataPreserved') is True and second.get('edgeIdentityRotationEnabled') is False, '068 evidence differs')
        require(self.ledger() == self.expected_ledger(68), 'Final ledger differs')
        before = {tuple(base.acl_key(r)) for r in proof['acl']}
        actual = self.acl()
        expected = {tuple(v or None for v in p.split('|')) for p in second['privilegesAdded']}
        require({tuple(base.acl_key(r)) for r in actual} == before | expected and all(not r['grantable'] for r in actual), 'Unexpected final privileges')
        require(self.runtime() == proof['before'], 'Runtime/flags/pointers changed')
        self.save('applied.json', {'sha': self.sha, 'schema': 68, 'migrations': list(MIGRATIONS), 'runtime_unchanged': True, 'flags_disabled': True, 'backup_sha256': backup['sha256'], 'at': time.time()})
        self.plan('applied', {'schema': 68, 'runtime_unchanged': True, 'flags_disabled': True})

    def run(self):
        self.source_checks()
        self.ci()
        if self.args.apply:
            with self.deployment_lock():
                getattr(self, self.args.action)()
        else:
            getattr(self, self.args.action)()


# Runs only on the trusted VPS, key through stdin; no cleartext dump or key on disk.
def remote_rehearsal(config):
    import subprocess
    spec = importlib.util.spec_from_file_location('cloud1021_drill', Path(__file__).with_name('restore-drill.py'))
    drill = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(drill)
    identity = drill.Identity(sys.stdin.read())
    stage, suffix, image = config['stage'], config['suffix'], config['image']
    require(re.fullmatch(REMOTE+'/cloud-schema-tools/[a-f0-9]{40}', stage) and re.fullmatch('[a-f0-9]{32}', suffix) and re.fullmatch('sha256:[a-f0-9]{64}', image), 'Invalid rehearsal pins')
    dump = REMOTE+'/backups/cloud-schema1021-'+suffix+'.dump.age'
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
    name = 'pickchick-schema-rehearsal-'+suffix
    try:
        drill.run_container(name, drill.IMAGE)
        drill.wait_ready(name)
        restore = subprocess.Popen(['docker','exec','-i',name,'pg_restore','-U','postgres','-d',market.DB,'--exit-on-error','--no-owner','--no-acl'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        decrypted = identity.decrypt(dump, restore.stdin)
        restore.stdin.close()
        require(restore.wait(300) == 0 and decrypted == 0, 'Isolated restore failed')
        counts = drill.counts(name, market.DB)
        require(not drill.compare(counts, expected) and counts['migration'] == '058_cloud_device_center.sql', 'Restored manifest differs')
        # Re-create only the runtime ACL in the isolated clone, which was dumped without owners/ACL.
        sql = ['CREATE ROLE pickchick_app NOLOGIN;']
        for row in config['acl']:
            table, column, privilege = row['name'], row['column'], row['privilege']
            require(re.fullmatch('[a-z][a-z0-9_]*',table) and (column is None or re.fullmatch('[a-z][a-z0-9_]*',column)) and privilege in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','USAGE') and not row['grantable'], 'Unsupported cloned ACL')
            sql.append('GRANT '+privilege+(' ("'+column+'")' if column else '')+' ON '+('SEQUENCE ' if row['kind']=='S' else 'TABLE ')+'"'+table+'" TO pickchick_app;')
        subprocess.run(['docker','exec','-i',name,'psql','-Xq','-v','ON_ERROR_STOP=1','-U','postgres','-d',market.DB], input='\n'.join(sql).encode(), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        info = json.loads(subprocess.check_output(['docker','inspect',name]))[0]
        password = next(x.split('=',1)[1] for x in info['Config']['Env'] if x.startswith('POSTGRES_PASSWORD='))
        program = r'''import{createPool}from'@pickchick/database';import{deployComboRewards}from'./infra/staging/combo-rewards-owner.mjs';import{deployReleaseFixes}from'./infra/staging/release-fixes-1019-owner.mjs';
let input='';for await(const x of process.stdin)input+=x;const p=createPool(JSON.parse(input).url),c=await p.connect();const opts={directory:'/app/db/cloud/migrations',role:'pickchick_app'};try{for(const commit of [false,true]){await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await deployComboRewards(c,opts);await deployReleaseFixes(c,opts);await c.query(commit?'COMMIT':'ROLLBACK');const {rows}=await c.query('SELECT max(version) v FROM schema_migrations');if(!rows[0].v.startsWith(commit?'068_':'058_'))throw Error('Ledger differs');}await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');let refused=false;try{await deployComboRewards(c,opts);}catch{refused=true;}await c.query('ROLLBACK');if(!refused)throw Error('Replay accepted');console.log(JSON.stringify({rehearsal:'passed',rollback:'passed',replay:'refused'}));}catch{console.error('Isolated migration transaction failed');process.exitCode=1;}finally{c.release();await p.end();}'''
        command = ['docker','run','--rm','-i','--network','container:'+name,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--cpus','1','--pids-limit','128']
        for part in ('infra/staging','db/cloud/migrations'):
            command += ['-v',stage+'/'+part+':/app/'+part+':ro']
        command += [image,'node','--input-type=module','-e',program]
        run = subprocess.run(command, input=json.dumps({'url':'postgresql://postgres:'+password+'@127.0.0.1:5432/'+market.DB}).encode(), capture_output=True, timeout=600)
        require(run.returncode == 0, 'Migration rehearsal failed')
        report = json.loads(run.stdout)
        return {**report, 'ok': True, 'checksum':'verified','migration':counts['migration'],'tables':len(counts['tables']),'encrypted_files':[dump,dump+'.sha256',manifest],'sha256':Path(dump+'.sha256').read_text().split()[0]}
    finally:
        drill.docker('rm','-f','-v',name,check=False,capture_output=True)


def parse(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['prepare','apply'])
    for name in ('sha','branch','expected-api-sha','expected-public-sha','expected-api-image','expected-compose-sha256','expected-gateway-sha256'):
        p.add_argument('--'+name,required=True)
    for name in ('ssh-key','backup-identity','ci-proof'):
        p.add_argument('--'+name,type=Path,required=name=='ssh-key')
    p.add_argument('--ci-run')
    p.add_argument('--apply',action='store_true')
    return p.parse_args(argv)


def main():
    os.umask(0o077)
    if len(sys.argv)==3 and sys.argv[1]=='remote-rehearsal':
        try: print(json.dumps(remote_rehearsal(json.loads(sys.argv[2]))))
        except Exception: print('Isolated backup/rehearsal failed; no live migration dispatched.',file=sys.stderr); raise SystemExit(1)
        return
    r=Release(parse())
    try:r.run()
    except Exception as error:
        r.record_error(error)
        print(str(error) if isinstance(error, market.GuardFailure) else 'Stopped; inspect private evidence and retained lock.',file=sys.stderr)
        raise SystemExit(1)
if __name__=='__main__':main()
