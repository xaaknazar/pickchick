#!/usr/bin/env python3
"""Turn cloud-side edge identity renewal on or off (CLOUD_EDGE_IDENTITY_ROTATION_ENABLED).

docs/operations/edge-identity-rotation.md, "Включение", step 2. One flag on the live API, no
image, migration, pointer or neighbour change. The general provision.mjs is NOT run
(docs/operations/stage2-windows-1030/README.md): only the reviewed grants of
infra/staging/edge-identity-rotation-grants.mjs are applied to the API role.

  inspect (default)   read-only: live API release, env file, flag, grants, ready, probe
  enable  --apply     grants, "true" in the API environment of the installed resolved compose
                      (releases/<api sha>/infra/staging/compose.yaml), recreate only the API
  disable --apply     recreate the API without the flag, then revoke the grants

apply requires the values printed by inspect (--expected-api-sha, --expected-compose-sha256), so
it runs exactly on the state that was reviewed, takes the shared deployment lock
(/opt/pickchick-staging/.market-release.lock, never stolen) and keeps a private copy (600) of
the previous compose next to it. The compose holds resolved secrets, so it is edited only on
the server by the same compose_candidate function the tests exercise. A definite failed check after the change restores that copy
and the previous grants, recreates the API again and releases the lock; an uncertain remote
result keeps the lock for manual inspection. Secrets are never printed: environment values
are compared as remote SHA-256 digests, private evidence goes to .local/edge-identity-flag.
"""
import argparse
import inspect
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
import uuid

spec = importlib.util.spec_from_file_location('identity_flag_market', Path(__file__).with_name('release-market.py'))
market = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = market
spec.loader.exec_module(market)
require, digest, quote, GuardFailure = market.require, market.digest, market.quote, market.GuardFailure
REPO, REMOTE, DB, ROLE = market.REPO, market.REMOTE, market.DB, market.ROLE
API_CONTAINER = market.API_CONTAINER

KEY = 'CLOUD_EDGE_IDENTITY_ROTATION_ENABLED'
SECRETS_ENV = REMOTE + '/secrets/staging.env'
COLUMNS = ('token_hash', 'expires_at', 'issued_at', 'previous_token_hash', 'previous_expires_at')
ROTATION_ACL = frozenset(
    {('device_identity_rotations', None, 'SELECT'), ('device_identity_rotations', None, 'INSERT'),
     ('device_identity_rotations', 'confirmed_at', 'UPDATE'), ('device_identity_rotations', 'replay_count', 'UPDATE')}
    | {('device_credentials', c, 'UPDATE') for c in COLUMNS})
SHA_RE = '[a-f0-9]{40}'
HASH_RE = '[a-f0-9]{64}'
READY_TIMEOUT = 120


def grants_sql(role, enabled):
    """Same statements as edgeIdentityRotationGrants (tests compare both)."""
    require(re.fullmatch('[a-z][a-z0-9_]{0,62}', role) and isinstance(enabled, bool), 'Invalid edge identity rotation grants')
    columns = ','.join(COLUMNS)
    sql = (f'REVOKE ALL ON device_identity_rotations FROM {role};\n'
           f'REVOKE UPDATE({columns}) ON device_credentials FROM {role};')
    if enabled:
        sql += (f'\nGRANT SELECT, INSERT ON device_identity_rotations TO {role};\n'
                f'GRANT UPDATE(confirmed_at, replay_count) ON device_identity_rotations TO {role};\n'
                f'GRANT UPDATE({columns}) ON device_credentials TO {role};')
    return sql


def compose_candidate(config, enabled):
    """Resolved live compose (JSON) with only the API flag changed: absent/false -> "true", "true" -> absent.

    Runs on the server (the file holds resolved secrets and never leaves it); tests call it locally.
    """
    require(isinstance(config, dict) and isinstance(config.get('services'), dict), 'Unexpected compose format')
    api = config['services'].get('api')
    require(isinstance(api, dict) and isinstance(api.get('environment'), dict), 'Resolved API environment required')
    current = api['environment'].get(KEY)
    if enabled:
        require(current in (None, 'false'), f'{KEY} is not off in the live compose')
    else:
        require(current == 'true', f'{KEY} is not on in the live compose')
    result = json.loads(json.dumps(config))
    environment = result['services']['api']['environment']
    if enabled:
        environment[KEY] = 'true'
    else:
        del environment[KEY]
    before = {k: v for k, v in api['environment'].items() if k != KEY}
    require({k: v for k, v in environment.items() if k != KEY} == before and
            {**result, 'services': {**result['services'], 'api': None}} ==
            {**config, 'services': {**config['services'], 'api': None}} and
            {k: v for k, v in result['services']['api'].items() if k != 'environment'} ==
            {k: v for k, v in api.items() if k != 'environment'}, 'Compose candidate changed more than the flag')
    return result


def flag_state(env):
    value = env.get(KEY)
    return 'true' if value == digest(b'true') else 'false' if value in (None, digest(b'false')) else 'invalid'


def verify_env_delta(before, after, enabled):
    """Only the flag changed in the API environment; values compared as digests."""
    require(flag_state(after) == ('true' if enabled else 'false'), 'API flag did not reach the requested state')
    strip = lambda env: {k: v for k, v in env.items() if k != KEY}
    require(strip(before) == strip(after), 'Other API environment changed')


def rotation_acl(rows):
    return {(r['name'], r['column'], r['privilege']) for r in rows if r['name'] in ('device_identity_rotations', 'device_credentials')
            and (r['name'] == 'device_identity_rotations' or (r['privilege'] == 'UPDATE' and r['column'] in COLUMNS))}


def verify_acl(before, after, enabled):
    require(all(r['grantable'] is False for r in after), 'Grantable runtime privilege found')
    key = lambda rows: {(r['name'], r['column'], r['privilege']) for r in rows}
    other = lambda rows: key(rows) - ROTATION_ACL
    require(other(before) == other(after), 'Runtime privileges outside identity rotation changed')
    require(rotation_acl(after) == (set(ROTATION_ACL) if enabled else set()), 'Identity rotation privileges do not match the flag')


def live_binding(labels, current, image):
    """Compose labels of the running API -> (sha, compose path, env file); all must agree."""
    files = labels.get('com.docker.compose.project.environment_file', '').split(',')
    compose = labels.get('com.docker.compose.project.config_files', '')
    match = re.fullmatch(r'pickchick-api:(' + SHA_RE + ')', image or '')
    require(match, 'Unexpected API image')
    sha = match.group(1)
    require(current == f'{REMOTE}/releases/{sha}', 'API pointer differs from the running image')
    require(compose == f'{REMOTE}/releases/{sha}/infra/staging/compose.yaml', 'API runs from another compose file')
    require(len(files) == 2 and files[0] == SECRETS_ENV and
            re.fullmatch(re.escape(REMOTE) + '/releases/' + SHA_RE + '/release.env', files[1]), 'Unexpected API env files')
    # The release tooling installs a resolved JSON compose; the env files are only passed back to
    # docker compose unchanged so the recreate matches the installed invocation.
    require(labels.get('com.docker.compose.service') == 'api' and
            re.fullmatch('[a-z0-9][a-z0-9_-]*', labels.get('com.docker.compose.project', '')), 'Unexpected API compose project')
    return {'sha': sha, 'compose': compose, 'env_file': files[1], 'project': labels['com.docker.compose.project']}


ENV_DIGESTS = """import hashlib,json,sys
env=json.load(sys.stdin)
out={}
for item in env:
 k,_,v=item.partition('=')
 out[k]=hashlib.sha256(v.encode()).hexdigest()
print(json.dumps(out,sort_keys=True))
"""

# argv: compose path, backup path, enabled ("true"/"false"), expected sha256 of the current file.
# The candidate function is shipped verbatim, so the server applies exactly the tested logic.
REWRITE_COMPOSE = """import hashlib,json,os,sys
KEY=%r
class GuardFailure(Exception): pass
def require(c,m):
 if not c: raise GuardFailure(m)
%s
path,backup,enabled,expected=sys.argv[1:]
data=open(path,'rb').read()
require(hashlib.sha256(data).hexdigest()==expected,'compose changed')
new=(json.dumps(compose_candidate(json.loads(data),enabled=='true'),indent=2)+'\\n').encode()
fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
os.write(fd,data);os.fsync(fd);os.close(fd)
tmp=path+'.edge-identity.tmp'
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
os.write(fd,new);os.fsync(fd);os.close(fd)
os.replace(tmp,path)
print(hashlib.sha256(new).hexdigest())
"""


def rewrite_script():
    source = inspect.getsource(compose_candidate)
    return REWRITE_COMPOSE % (KEY, source)


# Names and flag state only; values never leave the server.
COMPOSE_STATE = """import json,sys
c=json.load(open(sys.argv[1]))
e=c['services']['api']['environment']
print(json.dumps({'services':sorted(c['services']),'api_image':c['services']['api'].get('image'),'flag':e.get(%r,'absent') if e.get(%r) in (None,'true','false') else 'invalid'}))
""" % (KEY, KEY)

RESTORE_FILE = """import hashlib,os,sys
path,backup,expected=sys.argv[1:]
data=open(backup,'rb').read()
assert hashlib.sha256(data).hexdigest()==expected,'backup differs'
tmp=path+'.edge-identity.tmp'
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
os.write(fd,data);os.fsync(fd);os.close(fd)
os.replace(tmp,path)
print(hashlib.sha256(data).hexdigest())
"""


class FlagRelease(market.Release):
    """Reuses market.Release for ssh, psql, ACL capture, private evidence and the shared lock."""

    def __init__(self, args):
        self.args = args
        self.profile = market.HISTORICAL_PROFILE
        self.sha = 'edge-identity-flag'
        self.private = REPO / '.local' / 'edge-identity-flag' / time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        require(not any(p.is_symlink() for p in [self.private, *self.private.parents] if REPO in p.parents),
                'Private evidence directory must not have symlink components')
        self.private.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.private.chmod(0o700)
        self.ssh = ['ssh', '-i', str(args.ssh_key.expanduser()), '-o', 'IdentitiesOnly=yes',
                    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
                    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', 'pickchick-ops@' + market.IP]

    def binding(self):
        labels = json.loads(self.remote(f"docker inspect --format '{{{{json .Config.Labels}}}}' {API_CONTAINER}"))
        image = self.remote(f"docker inspect --format '{{{{.Config.Image}}}}' {API_CONTAINER}")
        return live_binding(labels, self.remote(f'readlink -f {REMOTE}/current'), image)

    def env_digests(self):
        return json.loads(self.remote(f"docker inspect --format '{{{{json .Config.Env}}}}' {API_CONTAINER} | python3 -c "
                                      + quote(ENV_DIGESTS)))

    def file_sha(self, path):
        return self.remote('sha256sum ' + quote(path)).split()[0]

    def compose_state(self, bind):
        state = json.loads(self.remote('python3 -c ' + quote(COMPOSE_STATE) + ' ' + quote(bind['compose'])))
        require(state['api_image'] == 'pickchick-api:' + bind['sha'], 'Live compose pins another API image')
        require(state['flag'] in ('absent', 'true', 'false'), 'Live compose flag is invalid')
        return state

    def probe(self):
        body = json.dumps({'rotation_id': str(uuid.uuid4())})
        curl = ['curl', '--silent', '--output', '/dev/null', '--max-time', '15', '-w', '%{http_code}', '-X', 'POST',
                '-H', 'Content-Type: application/json', '--data', body,
                'http://127.0.0.1:13100/internal/v1/edge/identity/rotate']
        return int(self.remote(' '.join(map(quote, curl)), timeout=20))

    def ready(self):
        code, body = self.http('/health/ready', public=False)
        if code != 200:
            return False
        value = json.loads(body)
        return value.get('ready') is True and value.get('degraded') is False

    def metrics(self):
        code, body = self.http('/health/metrics', public=False)
        return code == 200 and b'pickchick_edge_identity_min_days_remaining' in body

    def neighbours(self):
        names = sorted(self.remote("docker ps -a --format '{{.Names}}'").splitlines())
        template = '{{.Id}} {{.Image}} {{.State.StartedAt}} {{.State.Status}}'
        return {n: self.remote('docker inspect --format ' + quote(template) + ' ' + quote(n))
                for n in names if n != API_CONTAINER}

    def api_identity(self):
        return self.remote(f"docker inspect --format '{{{{.Id}}}} {{{{.Image}}}}' {API_CONTAINER}")

    def state(self):
        bind = self.binding()
        compose = self.compose_state(bind)
        env = self.env_digests()
        acl = self.acl()
        result = {
            'api_sha': bind['sha'], 'compose': bind['compose'], 'compose_sha256': self.file_sha(bind['compose']),
            'compose_project': bind['project'], 'compose_services': compose['services'], 'compose_flag': compose['flag'],
            'flag': flag_state(env),
            'rotation_grants': sorted(f'{t}.{c or "*"}:{p}' for t, c, p in rotation_acl(acl)),
            'ready': self.ready(), 'rotate_probe_status': self.probe(), 'metrics': self.metrics(),
            'unconfirmed_rotations': int(self.psql(DB, 'SELECT count(*) FROM device_identity_rotations WHERE confirmed_at IS NULL')),
        }
        return bind, env, acl, result

    def recreate(self, bind):
        command = (f'docker compose -p {quote(bind["project"])} --env-file {quote(SECRETS_ENV)} '
                   f'--env-file {quote(bind["env_file"])} -f {quote(bind["compose"])} up -d --no-deps --force-recreate api')
        self.remote(command, timeout=180)
        deadline = time.time() + READY_TIMEOUT
        while time.time() < deadline:
            time.sleep(5)
            try:
                if self.ready():
                    return
            except GuardFailure:
                pass
        raise GuardFailure('API did not become ready after recreate')

    def apply(self, enabled):
        a = self.args
        require(re.fullmatch(SHA_RE, a.expected_api_sha or '') and re.fullmatch(HASH_RE, a.expected_compose_sha256 or ''),
                'Run inspect first and pass --expected-api-sha and --expected-compose-sha256')
        with self.deployment_lock():
            bind, env, acl, before = self.state()
            self.save('before.json', before)
            require(bind['sha'] == a.expected_api_sha, 'Live API differs from the inspected release')
            require(before['compose_sha256'] == a.expected_compose_sha256, 'Live compose changed since inspect')
            require(before['compose_flag'] in (('absent', 'false') if enabled else ('true',)),
                    'Compose flag disagrees with the running API')
            require(before['ready'] is True, 'API is not ready before the change')
            require(before['flag'] == ('false' if enabled else 'true'), 'Flag is already in the requested state')
            require(before['unconfirmed_rotations'] == 0 or enabled, 'Unconfirmed rotations exist; finish them before disabling')
            neighbours, api_before = self.neighbours(), self.api_identity()
            backup = f'{bind["compose"]}.before-edge-identity-{time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())}'
            changed_env = granted = False
            failure = None
            try:
                if enabled:
                    self.psql(DB, 'BEGIN;\n' + grants_sql(ROLE, True) + '\nCOMMIT;')
                    granted = True
                self.remote('python3 -c ' + quote(rewrite_script()) + ' ' + ' '.join(map(quote, [
                    bind['compose'], backup, 'true' if enabled else 'false', before['compose_sha256']])))
                changed_env = True
                self.recreate(bind)
                if not enabled:
                    self.psql(DB, 'BEGIN;\n' + grants_sql(ROLE, False) + '\nCOMMIT;')
                    granted = True
                after_bind, after_env, after_acl, after = self.state()
                self.save('after.json', after)
                require(after_bind == bind, 'API binding changed')
                require(self.api_identity().split()[1] == api_before.split()[1], 'API image changed')
                verify_env_delta(env, after_env, enabled)
                verify_acl(acl, after_acl, enabled)
                require(after['ready'] is True, 'API is not ready after the change')
                require(after['rotate_probe_status'] == (401 if enabled else 404), 'Rotate probe has the wrong status')
                require(after['metrics'] is True, 'Identity metrics missing')
                require(self.neighbours() == neighbours, 'A neighbour container changed')
            except market.CommandUncertain:
                raise  # Remote completion unknown: keep the lock, inspect by hand before anything else.
            except GuardFailure as error:
                # A definite failed check: restore the inspected state, then release the lock.
                # If the restore itself fails, the exception keeps the lock as evidence.
                failure = str(error)
                self.save('rollback-start.json', {'reason': failure})
                if changed_env:
                    self.remote('python3 -c ' + quote(RESTORE_FILE) + ' ' + ' '.join(map(quote, [
                        bind['compose'], backup, before['compose_sha256']])))
                    self.recreate(bind)
                if granted:
                    self.psql(DB, 'BEGIN;\n' + grants_sql(ROLE, not enabled) + '\nCOMMIT;')
                restored = self.state()[3]
                self.save('rollback-done.json', restored)
                require(restored['flag'] == before['flag'] and restored['ready'] is True, 'Rollback did not restore the API')
        if failure:
            raise GuardFailure('Rolled back: ' + failure)
        return {'before': before, 'after': after, 'compose_backup': backup}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', nargs='?', default='inspect', choices=['inspect', 'enable', 'disable'])
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--expected-api-sha')
    parser.add_argument('--expected-compose-sha256')
    parser.add_argument('--ssh-key', type=Path, default=Path('~/.ssh/pickchick_staging_ed25519'))
    args = parser.parse_args()
    release = FlagRelease(args)
    try:
        if args.action == 'inspect' or not args.apply:
            result = release.state()[3]
            result['mode'] = 'inspect' if args.action == 'inspect' else args.action + ' (plan only, add --apply)'
        else:
            result = release.apply(args.action == 'enable')
            result['mode'] = args.action
        release.save('result.json', result)
        print(json.dumps(result, indent=2, sort_keys=True))
    except Exception as error:
        release.record_error(error)
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, GuardFailure) else type(error).__name__,
                          'evidence': str(release.private)}), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
