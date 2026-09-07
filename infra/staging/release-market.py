#!/usr/bin/env python3
"""Owner-run, bounded staging release. prepare builds immutable artifacts; apply changes API/gateway.

No manager issuance, seed, payment, SMS, timer installation or automatic database restore.
All command failures stay in a 0600 private log. Read docs/operations/market-release.md first.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tarfile
import tempfile
import time
import traceback
import uuid

REPO = Path(__file__).resolve().parents[2]
REMOTE = '/opt/pickchick-staging'
OLD_API = '5d3eead08c392bdbb60eae64a0bee4e883bb0af3'
OLD_WEB = '00ca82896517813808568d81ed843bc815ff3635'
IP = '185.129.51.103'
HOST = 'pickchick.185.129.51.103.nip.io'
DB = 'pickchick_cloud'
DB_CONTAINER = 'pickchick-staging-cloud-db-1'
API_CONTAINER = 'pickchick-staging-api-1'
GATEWAY = 'pickchick-public-gateway'
ROLE = 'pickchick_app'
ARCHIVE_PATHS = ['.dockerignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
                 'tsconfig.base.json', 'packages', 'services', 'db', 'scripts', 'infra/staging']
MIGRATIONS = ['007_cloud_customer_identity.sql', '008_cloud_commerce_core.sql',
              '009_cloud_catalog_admin.sql', '010_cloud_loyalty.sql',
              '011_cloud_catalog_lock_permissions.sql', '012_cloud_commerce_catalog.sql',
              '013_cloud_identity_receipt_limits.sql']
CI_JOBS = {'Build, contracts and PostgreSQL integration',
           'iPad kiosk state, bundles and browser recovery',
           'Private staging image and restricted database role',
           'Design screens and interaction smoke'}
NEW_SEQUENCES = {'commerce_outbox_sequence_seq', 'loyalty_lots_sequence_seq'}
DEPLOY_LOCK = REMOTE + '/.market-release.lock'


class GuardFailure(RuntimeError):
    """Only curated, non-secret messages may use this exception class."""


class CommandUncertain(GuardFailure):
    """Remote completion is unknown; retain the lock and do not start competing rollback."""


def require(condition, message):
    if not condition:
        raise GuardFailure(message)


def digest(value):
    raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True).encode()
    return hashlib.sha256(raw).hexdigest()


def quote(value):
    return shlex.quote(str(value))


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def api_compose(sha):
    release = f'{REMOTE}/releases/{sha}'
    return (f'docker compose --env-file {REMOTE}/secrets/staging.env '
            f'--env-file {release}/release.env -f {release}/infra/staging/compose.yaml')


def web_compose(sha):
    return f'docker compose -f {REMOTE}/public-https/releases/{sha}/infra/public-staging/compose.yaml'


def release_env_script():
    """The same generated program is exercised locally with synthetic environment files."""
    return """from pathlib import Path
import sys
old,new,sha,old_sha=sys.argv[1:]
lines=Path(old).read_text().splitlines()
assert lines.count('RELEASE_SHA='+old_sha)==1
settings={'RELEASE_SHA':sha,'TEST_ORDER_FLOW_ENABLED':'true','CATALOG_ADMIN_ENABLED':'true','CUSTOMER_AUTH_ENABLED':'false'}
lines=[line for line in lines if line.split('=',1)[0] not in settings]
with open(new,'x') as output:
 Path(new).chmod(0o600)
 output.write('\\n'.join(lines+[key+'='+value for key,value in settings.items()])+'\\n')
"""


def verify_ci(proof, sha):
    run, jobs = proof['run'], proof['jobs']
    require(run.get('head_sha') == sha and run.get('status') == 'completed'
            and run.get('conclusion') == 'success', 'CI run did not pass for the exact source SHA')
    require(run.get('path') == '.github/workflows/ci.yml'
            and run.get('head_repository', {}).get('full_name') == 'xaaknazar/pickchick',
            'CI proof does not identify the canonical workflow/repository')
    rows = jobs.get('jobs', [])
    require(jobs.get('total_count') == len(rows) and CI_JOBS <= {job.get('name') for job in rows}
            and all(job.get('status') == 'completed' and job.get('conclusion') == 'success'
                    and job.get('head_sha') == sha for job in rows),
            'CI proof is partial or contains a missing/failed job')


def compare_existing(before, after, *, additions=False, new_tables=(), new_sequences=()):
    before_tables, after_tables = before['tables'], after['tables']
    require(set(before_tables) <= set(after_tables), 'A pre-existing table disappeared')
    for name, value in before_tables.items():
        if additions and name == 'schema_migrations':
            continue
        require(after_tables[name] == value, 'Pre-existing table changed: ' + name)
    if additions:
        require(set(after_tables) - set(before_tables) == set(new_tables),
                'Unexpected new or missing tables after migration')
        require(all(after_tables[name]['rows'] == 0 for name in new_tables),
                'New domain tables were seeded or mutated unexpectedly')
    else:
        require(set(before_tables) == set(after_tables), 'Unexpected schema change')
    old_seq = {row['sequencename']: row for row in before['sequences']}
    new_seq = {row['sequencename']: row for row in after['sequences']}
    require(all(new_seq.get(name) == row for name, row in old_seq.items()),
            'A pre-existing sequence changed')
    if not additions:
        require(new_seq == old_seq, 'Unexpected sequence change')
    else:
        require(set(new_seq) - set(old_seq) == set(new_sequences), 'Unexpected new sequence')
        require(all(new_seq[name]['last_value'] is None for name in new_sequences),
                'A new domain sequence was used unexpectedly')


def acl_restore_sql(previous, current):
    """Exact runtime ACL rollback, including explicit column privileges; no migrations or data DML."""
    valid = {'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
             'MAINTAIN', 'USAGE'}
    for row in previous + current:
        require(row['privilege'] in valid and row['kind'] in ['r', 'p', 'v', 'm', 'f', 'S']
                and isinstance(row['name'], str) and isinstance(row['grantable'], bool)
                and (row['column'] is None or isinstance(row['column'], str)),
                'Unexpected ACL object or privilege')
    statements = ['BEGIN', 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM pickchick_app',
                  'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM pickchick_app']
    for row in current:
        if row['column']:
            statements.append(f'REVOKE {row["privilege"]} ({identifier(row["column"])}) '
                              f'ON public.{identifier(row["name"])} FROM {ROLE}')
    for row in previous:
        column = f' ({identifier(row["column"])})' if row['column'] else ''
        target = 'SEQUENCE ' if row['kind'] == 'S' else 'TABLE '
        grant = ' WITH GRANT OPTION' if row['grantable'] else ''
        statements.append(f'GRANT {row["privilege"]}{column} ON {target}public.'
                          f'{identifier(row["name"])} TO {ROLE}{grant}')
    return ';\n'.join(statements + ['COMMIT']) + ';'


class Release:
    def __init__(self, args):
        self.args = args
        self.sha = args.sha
        self.private = REPO / '.local' / 'market-release' / self.sha
        require(all(not path.is_symlink() for path in [self.private, *self.private.parents]
                    if path != REPO and REPO in path.parents),
                'Private evidence directory must not have symlink components')
        self.private.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.private.chmod(0o700)
        self.ssh = ['ssh', '-i', str(args.ssh_key.expanduser()), '-o', 'IdentitiesOnly=yes',
                    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
                    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
                    'pickchick-ops@' + IP]

    def save(self, name, value):
        path = self.private / name
        require(not path.is_symlink(), 'Private evidence file must not be a symlink')
        with open(path, 'w', encoding='utf8') as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(value, output, indent=2, sort_keys=True)
            output.write('\n')

    def record_error(self, error):
        # Parser/SSH/subprocess exceptions may contain raw data: retain only their class.
        self.save('failure-' + uuid.uuid4().hex + '.json', {
            'action': self.args.action, 'error_class': type(error).__name__,
            'reason': str(error) if isinstance(error, GuardFailure) else 'See private command diagnostics',
            'source_sha': self.sha,
        })
        if not isinstance(error, GuardFailure):
            path = self.private / ('exception-' + uuid.uuid4().hex + '.log')
            with open(path, 'x', encoding='utf8') as output:
                os.fchmod(output.fileno(), 0o600)
                output.write(''.join(traceback.format_exception(error, chain=False))[:65_536])

    @contextmanager
    def deployment_lock(self):
        # A failed/ambiguous run leaves an owned lock. Never steal or age out another release.
        owner = {'id': str(uuid.uuid4()), 'sha': self.sha, 'action': self.args.action}
        self.save('lock-owner-' + owner['id'] + '.json', owner)
        acquire = """import json,os,sys
path=sys.argv[1]
os.mkdir(path,0o700)
with open(path+'/owner.json','x') as output:
 os.chmod(path+'/owner.json',0o600)
 output.write(sys.stdin.read())
"""
        self.remote('python3 -c ' + quote(acquire) + ' ' + quote(DEPLOY_LOCK), input=json.dumps(owner))
        try:
            yield
        except BaseException:
            # Leave the lock as evidence: an SSH disconnect is not proof the command stopped.
            raise
        else:
            release = """import json,os,sys
path,owner=sys.argv[1:]
assert json.load(open(path+'/owner.json'))['id']==owner
os.unlink(path+'/owner.json')
os.rmdir(path)
"""
            self.remote('python3 -c ' + quote(release) + ' ' + quote(DEPLOY_LOCK) + ' ' + quote(owner['id']))

    def execute(self, command, *, remote=False, input=None, timeout=120):
        args = self.ssh + [command] if remote else command
        payload = input.encode() if isinstance(input, str) else input
        # Temporary output is private and not echoed, including failures of owner-only commands.
        with tempfile.TemporaryFile(dir=self.private) as out, tempfile.TemporaryFile(dir=self.private) as err:
            try:
                result = subprocess.run(args, input=payload, stdout=out, stderr=err,
                                        cwd=REPO, timeout=timeout, check=False)
            except subprocess.TimeoutExpired:
                self.save('timeout-' + uuid.uuid4().hex + '.json',
                          {'phase': 'command_timeout', 'timeout_seconds': timeout})
                kind = CommandUncertain if remote else GuardFailure
                raise kind('Command timed out; inspect state before retrying') from None
            size = out.tell() + err.tell()
            out.seek(0)
            err.seek(0)
            stdout, stderr = out.read(16_777_216), err.read(16_777_216)
            if result.returncode or size > 16_777_216:
                path = self.private / ('command-error-' + uuid.uuid4().hex + '.log')
                with open(path, 'xb') as log:
                    os.fchmod(log.fileno(), 0o600)
                    log.write(stdout + b'\n' + stderr)
                if remote and result.returncode in [124, 125, 137, 255]:
                    raise CommandUncertain('Remote completion is uncertain; deployment lock retained')
                raise GuardFailure('Command failed; command-error log has restricted diagnostics')
            return stdout

    def remote(self, command, **kwargs):
        deadline = kwargs.pop('timeout', 120)
        # Server deadline ends the command process group before the longer local SSH deadline.
        wrapped = ('timeout --signal=TERM --kill-after=10s ' + str(deadline) + 's '
                   'bash -o pipefail -c ' + quote(command))
        return self.execute(wrapped, remote=True, timeout=deadline + 25, **kwargs).decode().strip()

    def git(self, *args):
        return self.execute(['git', *args]).decode().strip()

    def source_checks(self):
        require(re.fullmatch('[a-f0-9]{40}', self.sha) and self.sha not in [OLD_API, OLD_WEB],
                'A new full commit SHA is required')
        require(self.git('rev-parse', 'HEAD') == self.sha, 'Release must use checked HEAD')
        require(not self.git('status', '--porcelain', '--untracked-files=all'), 'Source checkout is dirty')
        require(re.fullmatch('[A-Za-z0-9._/-]{1,160}', self.args.branch)
                and '..' not in self.args.branch, 'Invalid pushed branch name')
        pushed = self.git('ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/' + self.args.branch)
        require(pushed.split()[0] == self.sha, 'Pushed branch differs from checked SHA')
        actual = sorted(path.name for path in (REPO / 'db/cloud/migrations').glob('*.sql'))
        require(actual == sorted(self.baseline_migrations() + MIGRATIONS),
                'Release scope requires exactly the reviewed migrations 001 through 013')
        for filename in self.baseline_migrations():
            current = (REPO / 'db/cloud/migrations' / filename).read_bytes()
            prior = self.execute(['git', 'show', OLD_API + ':db/cloud/migrations/' + filename])
            require(current == prior, 'An existing migration was edited: ' + filename)

    def baseline_migrations(self):
        paths = self.git('ls-tree', '-r', '--name-only', OLD_API, '--', 'db/cloud/migrations/').splitlines()
        names = sorted(Path(path).name for path in paths if path.endswith('.sql'))
        require(len(names) == 6 and all(name.startswith(f'{index:03d}_')
                                      for index, name in enumerate(names, 1)), 'Unexpected baseline migrations')
        return names

    def ci(self):
        if self.args.ci_proof:
            proof = json.loads(self.args.ci_proof.read_text())
            source = 'operator_supplied_github_api_capture'
        else:
            require(self.args.ci_run and re.fullmatch('[0-9]+', self.args.ci_run), 'CI run ID is required')
            prefix = 'repos/xaaknazar/pickchick/actions/runs/' + self.args.ci_run
            proof = {name: json.loads(self.execute(['gh', 'api', endpoint])) for name, endpoint in
                     [('run', prefix), ('jobs', prefix + '/jobs?per_page=100')]}
            source = 'github_api_via_gh'
        verify_ci(proof, self.sha)
        self.save('ci-proof.json', {'source': source, **proof})
        return digest(proof)

    def psql(self, database, sql):
        require(re.fullmatch('[a-z][a-z0-9_]{0,62}', database), 'Invalid database name')
        return self.remote(f'docker exec -i {DB_CONTAINER} psql -X -qAt -v ON_ERROR_STOP=1 '
                           f'-U postgres -d {database}', input='SET statement_timeout=30000;\n' + sql,
                           timeout=45)

    def ledger(self, database=DB):
        return json.loads(self.psql(database, "SELECT json_agg(json_build_object('version',version,"
                                      "'checksum',checksum,'scope',scope) ORDER BY version) FROM schema_migrations"))

    def snapshot(self, database=DB):
        tables = json.loads(self.psql(database, "SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]') FROM pg_tables WHERE schemaname='public'"))
        pieces = []
        for table in tables:
            require(re.fullmatch('[a-z][a-z0-9_]*', table), 'Unexpected table identifier')
            pieces.append(f"SELECT '{table}' AS name,count(*) AS rows,encode(sha256(convert_to("
                          "coalesce(string_agg(row_hash,'' ORDER BY row_hash),''),'UTF8')),'hex') AS sha256 "
                          "FROM (SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') row_hash "
                          f'FROM public.{identifier(table)} t) hashed')
        require(pieces, 'Database has no expected tables')
        return json.loads(self.psql(database, "SELECT json_build_object('tables',(SELECT json_object_agg(name,"
                          "json_build_object('rows',rows,'sha256',sha256)) FROM (" + ' UNION ALL '.join(pieces) +
                          ") h),'sequences',(SELECT coalesce(json_agg(row_to_json(s) ORDER BY sequencename),'[]') FROM "
                          "(SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value "
                          "FROM pg_sequences WHERE schemaname='public') s))"))

    def acl(self):
        sql = """SELECT coalesce(json_agg(row_to_json(a) ORDER BY name,"column",privilege),'[]') FROM (
          SELECT c.relname AS name,c.relkind AS kind,NULL::text AS "column",x.privilege_type AS privilege,x.is_grantable AS grantable
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          CROSS JOIN LATERAL aclexplode(c.relacl) x JOIN pg_roles r ON r.oid=x.grantee
          WHERE n.nspname='public' AND r.rolname='pickchick_app' AND c.relkind IN ('r','p','v','m','f','S')
          UNION ALL
          SELECT c.relname,c.relkind,t.attname,x.privilege_type,x.is_grantable
          FROM pg_attribute t JOIN pg_class c ON c.oid=t.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          CROSS JOIN LATERAL aclexplode(t.attacl) x JOIN pg_roles r ON r.oid=x.grantee
          WHERE n.nspname='public' AND r.rolname='pickchick_app' AND t.attnum>0 AND NOT t.attisdropped
        ) a"""
        return json.loads(self.psql(DB, sql))

    def fingerprint(self):
        names = sorted(self.remote("docker ps -a --format '{{.Names}}'").splitlines())
        template = '{{.Id}} {{.Image}} {{.State.StartedAt}} {{.State.Status}} {{.RestartCount}}'
        containers = {name: self.remote('docker inspect --format ' + quote(template) + ' ' + quote(name))
                      for name in names if name not in [API_CONTAINER, GATEWAY]}
        return {'containers': containers, 'idrink_caddy_sha256': self.remote(
            'sha256sum /opt/idrink/deploy/Caddyfile').split()[0]}

    def file_hashes(self, paths):
        script = """import hashlib,json,pathlib,sys
result={}
for name in json.load(sys.stdin):
 path=pathlib.Path(name)
 assert path.is_file() and not path.is_symlink()
 result[name]=hashlib.sha256(path.read_bytes()).hexdigest()
print(json.dumps(result,sort_keys=True))
"""
        return json.loads(self.remote('python3 -c ' + quote(script), input=json.dumps(paths)))

    def rollback_artifacts(self):
        return self.file_hashes([
            f'{REMOTE}/secrets/staging.env',
            f'{REMOTE}/releases/{OLD_API}/release.env',
            f'{REMOTE}/releases/{OLD_API}/infra/staging/compose.yaml',
            f'{REMOTE}/public-https/releases/{OLD_WEB}/infra/public-staging/compose.yaml',
            f'{REMOTE}/public-https/releases/{OLD_WEB}/infra/public-staging/gateway.Caddyfile',
            f'{REMOTE}/public-https/releases/{OLD_WEB}/infra/public-staging/public-web/.release.json',
        ])

    def prepared_artifacts(self, manifest):
        api = f'{REMOTE}/releases/{self.sha}'
        web = f'{REMOTE}/public-https/releases/{self.sha}/infra/public-staging'
        paths = [api + '/infra/staging/compose.yaml', api + '/release.env',
                 web + '/compose.yaml', web + '/gateway.Caddyfile', web + '/public-web/.release.json']
        for name in manifest['files']:
            require(re.fullmatch('[A-Za-z0-9._/-]+', name) and not name.startswith('/')
                    and '..' not in Path(name).parts, 'Invalid manifest path')
            paths.append(web + '/public-web/' + name)
        image = json.loads(self.remote('docker image inspect --format ' +
            quote('{{json .}}') + ' pickchick-api:' + self.sha))
        require(image['Config']['Labels']['org.opencontainers.image.revision'] == self.sha,
                'Prepared API OCI revision changed')
        hashes = self.file_hashes(paths)
        require(all(hashes[web + '/public-web/' + name] == value
                    for name, value in manifest['files'].items()), 'Prepared web asset changed')
        return {'file_sha256': hashes, 'image_id': image['Id'], 'revision': self.sha,
                'rollback_files': self.rollback_artifacts()}

    def runtime_grants(self, before):
        current = self.acl()
        expected = set()
        for table, privileges in {
            'catalog_managers': ['SELECT'], 'catalog_manager_branches': ['SELECT'],
            'catalog_draft_versions': ['SELECT', 'INSERT'],
            'catalog_publications': ['SELECT', 'INSERT'],
            'catalog_branch_heads': ['SELECT', 'INSERT', 'UPDATE'],
            'catalog_audit': ['SELECT', 'INSERT'],
            'catalog_command_receipts': ['SELECT', 'INSERT'],
            'catalog_manager_audit': ['SELECT'],
        }.items():
            expected.update((table, 'r', None, item, False) for item in privileges)
        expected.update((table, 'r', 'lock_anchor', 'UPDATE', False)
                        for table in ['catalog_managers', 'catalog_manager_branches'])
        key = lambda row: tuple(row[name] for name in ['name', 'kind', 'column', 'privilege', 'grantable'])
        actual = {key(row) for row in current if row['name'].startswith('catalog_')}
        require(actual == expected, 'Catalog runtime grants are not the reviewed least-privilege set')
        require(not any(row['name'].startswith(('identity_', 'commerce_', 'loyalty_')) for row in current),
                'Disabled identity, commerce or loyalty gained runtime privileges')
        require([row for row in current if not row['name'].startswith('catalog_')] == before,
                'Pre-existing runtime permissions changed')

    def http(self, path, *, public=True, method='GET'):
        require(path.startswith('/') and '\n' not in path and method in ['GET', 'POST'], 'Invalid probe')
        curl = ['curl', '--silent', '--show-error', '--max-time', '15', '--max-filesize', '2000000',
                '-X', method, '-w', '\n%{http_code}']
        if public:
            raw = self.execute(curl + ['--resolve', f'{HOST}:443:{IP}', 'https://' + HOST + path], timeout=20)
        else:
            raw = self.remote(' '.join(map(quote, curl + ['http://127.0.0.1:13100' + path])), timeout=20).encode()
        body, status = raw.rsplit(b'\n', 1)
        require(len(body) <= 2_000_000, 'Probe response is too large')
        return int(status), body

    def http_json(self, path, public=True, status=200):
        code, body = self.http(path, public=public)
        require(code == status, 'Unexpected probe status for ' + path)
        return json.loads(body)

    def health(self):
        ready = self.http_json('/health/ready', public=False)
        require(ready.get('ready') is True and ready.get('degraded') is False
                and ready.get('dependencies') == {'database': 'up', 'schema': 'up', 'redis': 'up'},
                'API dependencies are not ready')
        caps = self.http_json('/v1/capabilities')
        require(caps.get('environment') == 'staging' and caps.get('data_mode') == 'synthetic'
                and caps.get('ordering_enabled') is False and caps.get('features') == {
                    'phone_auth': False, 'checkout': False, 'payments': False, 'fiscal': False,
                    'loyalty': False, 'test_order_flow': True}, 'Unexpected runtime capability')
        return caps

    def catalogs(self):
        return [self.http_json('/v1/test/catalog?catalog_version=' + version)
                for version in ['mockup-v0.2', 'mockup-v0.3']]

    def runtime_old(self):
        role = json.loads(self.psql(DB, "SELECT json_build_object('superuser',rolsuper,'createdb',rolcreatedb,"
            "'createrole',rolcreaterole,'replication',rolreplication,'bypassrls',rolbypassrls,"
            "'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=r.oid)) "
            "FROM pg_roles r WHERE rolname='pickchick_app'"))
        require(role == {'superuser': False, 'createdb': False, 'createrole': False,
                         'replication': False, 'bypassrls': False, 'memberships': 0},
                'Runtime role is more privileged than the reviewed baseline')
        require(self.remote('docker inspect --format ' + quote('{{index .Config.Labels "org.opencontainers.image.revision"}}')
                            + ' ' + API_CONTAINER) == OLD_API, 'Running API is not the reviewed baseline')
        require(self.remote('readlink -f ' + REMOTE + '/current') == f'{REMOTE}/releases/{OLD_API}', 'API pointer changed')
        require(self.remote('readlink -f ' + REMOTE + '/public-https/current') ==
                f'{REMOTE}/public-https/releases/{OLD_WEB}', 'Web pointer changed')
        require(json.loads(self.remote(f'docker exec {GATEWAY} cat /srv/public/.release.json'))['source_sha'] == OLD_WEB,
                'Actual gateway bundle differs from its pointer')
        require(self.remote('docker image inspect --format ' + quote('{{index .Config.Labels "org.opencontainers.image.revision"}}')
                            + ' pickchick-api:' + OLD_API) == OLD_API, 'Rollback API image missing')
        self.remote(api_compose(OLD_API) + ' config --quiet')
        self.remote(web_compose(OLD_WEB) + ' config --quiet')

    def prepare(self):
        self.source_checks()
        ci_hash = self.ci()
        self.runtime_old()
        require(not (self.private / 'prepared.json').exists(), 'Prepared evidence already exists; inspect before resuming')
        print('Preparing immutable API and public web artifacts for ' + self.sha, flush=True)
        api_tar = self.execute(['git', 'archive', '--format=tar', self.sha, *ARCHIVE_PATHS])
        api_path = f'{REMOTE}/releases/{self.sha}'
        web_path = f'{REMOTE}/public-https/releases/{self.sha}/infra/public-staging'
        self.remote(f'test ! -e {api_path} && mkdir {api_path} && tar -xf - -C {api_path}', input=api_tar, timeout=180)
        self.remote('python3 -c ' + quote(release_env_script()) + ' ' + ' '.join(map(quote, [
            f'{REMOTE}/releases/{OLD_API}/release.env', api_path + '/release.env', self.sha, OLD_API])))
        self.remote('! docker image inspect pickchick-api:' + self.sha + ' >/dev/null 2>&1')
        image_id = self.remote(f'cd {api_path} && docker build -q -f infra/staging/Dockerfile '
                               f'--build-arg RELEASE_SHA={self.sha} -t pickchick-api:{self.sha} .', timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image_id), 'Docker build did not return one immutable image ID')
        self.remote(api_compose(self.sha) + ' config --quiet')
        output = self.private / 'public-web'
        self.execute(['python3', 'infra/public-staging/prepare-web.py', '--source-sha', self.sha,
                      '--output', str(output)], timeout=180)
        manifest = json.loads((output / '.release.json').read_text())
        require(manifest['source_sha'] == self.sha and 'backoffice/api.js' in manifest['files'], 'Public bundle manifest incomplete')
        for name, expected in manifest['files'].items():
            path = output / name
            require(path.is_file() and not path.is_symlink() and output in path.resolve().parents
                    and digest(path.read_bytes()) == expected, 'Public bundle hash mismatch')
        tar_path = self.private / 'public-web.tar'
        with tarfile.open(tar_path, 'w') as archive:
            archive.add(output, arcname='public-web')
            for name in ['compose.yaml', 'gateway.Caddyfile']:
                archive.add(REPO / 'infra/public-staging' / name, arcname=name)
        self.remote(f'test ! -e {REMOTE}/public-https/releases/{self.sha} && mkdir -p {web_path} '
                    f'&& tar -xf - -C {web_path}', input=tar_path.read_bytes(), timeout=180)
        self.remote(web_compose(self.sha) + ' config --quiet')
        self.remote(f'docker run --rm --network none --entrypoint caddy '
                    f'-v {web_path}/gateway.Caddyfile:/tmp/Caddyfile:ro '
                    'caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 '
                    'validate --config /tmp/Caddyfile --adapter caddyfile', timeout=45)
        artifacts = self.prepared_artifacts(manifest)
        require(artifacts['image_id'] == image_id, 'Prepared image tag changed after the build')
        self.save('prepared.json', {'sha': self.sha, 'old_api': OLD_API, 'old_web': OLD_WEB,
                  'ci_proof_sha256': ci_hash, 'api_archive_sha256': digest(api_tar), 'image_id': image_id,
                  'public_archive_sha256': digest(tar_path.read_bytes()), 'public_manifest': manifest,
                  'gateway_sha256': digest((REPO / 'infra/public-staging/gateway.Caddyfile').read_bytes()),
                  'remote_artifacts': artifacts})
        print('Preparation complete. Active services, database and release pointers were not changed.', flush=True)

    def backup_restore(self, expected):
        suffix = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
        backup = f'{REMOTE}/backups/cloud-market-{suffix}.dump.age'
        script = f'''set -euo pipefail
umask 077
exec 9>{REMOTE}/backups/.lock
flock -n 9
recipient=$(cat {REMOTE}/secrets/backup-recipient.txt)
[[ "$recipient" == age1* ]]
test ! -e {backup}
trap 'rm -f {backup}.tmp' EXIT
docker exec {DB_CONTAINER} pg_dump -U postgres -d {DB} --format=custom --no-owner --no-acl | age -r "$recipient" -o {backup}.tmp
test -s {backup}.tmp
mv {backup}.tmp {backup}
sha256sum {backup} > {backup}.sha256
'''
        self.remote('bash -o pipefail -c ' + quote(script), timeout=180)
        self.remote('sha256sum --check ' + backup + '.sha256')
        database = 'pickchick_restore_market_' + uuid.uuid4().hex[:12]
        created = False
        try:
            self.remote(f'docker exec {DB_CONTAINER} createdb -U postgres {database}')
            created = True
            pipeline = f'age --decrypt --identity /dev/stdin {backup} | docker exec -i {DB_CONTAINER} '
            pipeline += f'pg_restore -U postgres -d {database} --exit-on-error --no-owner --no-acl'
            self.remote('bash -o pipefail -c ' + quote(pipeline),
                        input=self.args.backup_identity.read_bytes(), timeout=180)
            compare_existing(expected, self.snapshot(database))
            compare_existing(expected, self.snapshot())
        finally:
            if created:
                self.remote(f'docker exec {DB_CONTAINER} dropdb -U postgres {database}')
        return {'path': backup, 'sha256': self.remote('sha256sum ' + backup).split()[0], 'restore': 'passed'}

    def migration_delta(self, before_ledger, before):
        after = self.ledger()
        require(after[:len(before_ledger)] == before_ledger, 'Existing migration checksums changed')
        additions = after[len(before_ledger):]
        expected = [{'version': name, 'checksum': digest((REPO / 'db/cloud/migrations' / name).read_bytes()),
                     'scope': 'cloud'} for name in MIGRATIONS]
        require(additions == expected, 'Migration delta does not match reviewed source files')
        new_tables = set()
        for name in MIGRATIONS:
            new_tables.update(re.findall(r'CREATE\s+TABLE\s+([a-z][a-z0-9_]*)',
                                        (REPO / 'db/cloud/migrations' / name).read_text(), re.I))
        compare_existing(before, self.snapshot(), additions=True, new_tables=new_tables,
                         new_sequences=NEW_SEQUENCES)

    def probes(self, prepared, caps, catalogs):
        require(self.health() == caps and self.catalogs() == catalogs, 'Legacy capabilities/catalog changed')
        require(self.http_json('/v1/auth/config', public=False) == {'enabled': False, 'consent_version': None,
                'terms_url': None, 'privacy_url': None}, 'Customer auth is unexpectedly enabled')
        for path in ['/v1/auth/config', '/v1/customers/me', '/health/ready', '/health/metrics']:
            require(self.http(path)[0] == 404, 'Private route exposed by gateway: ' + path)
        for path in ['/v1/auth/otp/request', '/v1/auth/otp/verify', '/v1/auth/refresh', '/v1/auth/logout']:
            require(self.http(path, method='POST')[0] == 404, 'Private auth write route exposed')
        for public in [False, True]:
            body = self.http_json('/v1/admin/catalog/branches', public=public, status=401)
            require(body.get('code') == 'UNAUTHORIZED', 'CMS authentication is not enforced')
        code, body = self.http('/backoffice/api.js')
        require(code == 200 and digest(body) == prepared['public_manifest']['files']['backoffice/api.js'],
                'Actual public backoffice asset differs from prepared bundle')
        require(json.loads(self.remote(f'docker exec {GATEWAY} cat /srv/public/.release.json'))
                == prepared['public_manifest'], 'Actual gateway bundle differs from manifest')
        require(self.remote(f'docker exec {GATEWAY} sha256sum /etc/caddy/Caddyfile').split()[0]
                == prepared['gateway_sha256'], 'Actual gateway config differs from prepared config')
        require(self.remote('docker inspect --format ' + quote('{{.Image}}') + ' ' + API_CONTAINER)
                == prepared['image_id'], 'Running API image is not the prepared immutable image')

    def switch(self, path, expected, target):
        script = """import os,sys
path,expected,target=sys.argv[1:]
assert os.path.realpath(path)==expected
temp=path+'.market-next'
assert not os.path.lexists(temp)
os.symlink(target,temp)
os.replace(temp,path)
assert os.path.realpath(path)==target
"""
        self.remote('python3 -c ' + quote(script) + ' ' + ' '.join(map(quote, [path, expected, target])))

    def rollback(self, before, caps, catalogs, fingerprint, prepared):
        # The new schema is intentionally retained. Old provision rejects the new migration ledger.
        require(self.rollback_artifacts() == prepared['remote_artifacts']['rollback_files'],
                'Rollback compose or environment changed; manual review required')
        self.psql(DB, acl_restore_sql(before['acl'], self.acl()))
        require(self.acl() == before['acl'], 'Previous runtime ACL was not restored exactly')
        self.remote(api_compose(OLD_API) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
        self.remote(web_compose(OLD_WEB) + ' up -d --no-deps --wait --wait-timeout 90 gateway', timeout=150)
        for path, old, new in [(REMOTE + '/current', f'{REMOTE}/releases/{OLD_API}', f'{REMOTE}/releases/{self.sha}'),
                              (REMOTE + '/public-https/current', f'{REMOTE}/public-https/releases/{OLD_WEB}',
                               f'{REMOTE}/public-https/releases/{self.sha}')]:
            actual = self.remote('readlink -f ' + path)
            require(actual in [old, new], 'Concurrent pointer change; rollback requires manual review')
            if actual == new:
                self.switch(path, new, old)
        self.runtime_old()
        require(self.health() == caps and self.catalogs() == catalogs, 'Rollback probes failed')
        require(self.fingerprint() == fingerprint, 'Unrelated service changed during rollback')
        current = self.snapshot()
        for name, value in before['database']['tables'].items():
            if name != 'schema_migrations':
                require(current['tables'].get(name) == value, 'Existing data changed during rollback')
        sequences = {row['sequencename']: row for row in current['sequences']}
        require(all(sequences.get(row['sequencename']) == row for row in before['database']['sequences']),
                'Existing sequence changed during rollback')
        require(self.ledger()[:len(before['ledger'])] == before['ledger'],
                'Previous migration ledger changed during rollback')
        self.save('rollback.json', {'api_sha': OLD_API, 'web_sha': OLD_WEB, 'acl_restored': True,
                  'schema_retained': True, 'database_restored_over_live': False, 'checks': 'passed'})

    def apply(self):
        self.source_checks()
        self.runtime_old()
        prepared = json.loads((self.private / 'prepared.json').read_text())
        require(prepared['sha'] == self.sha and prepared['old_api'] == OLD_API and prepared['old_web'] == OLD_WEB,
                'Prepared release evidence is for another source or baseline')
        proof = json.loads((self.private / 'ci-proof.json').read_text())
        verify_ci(proof, self.sha)
        require(digest({'run': proof['run'], 'jobs': proof['jobs']}) == prepared['ci_proof_sha256'], 'CI proof changed')
        require(self.prepared_artifacts(prepared['public_manifest']) == prepared['remote_artifacts'],
                'Prepared image, compose, environment or bundle changed before apply')
        require(self.args.backup_identity.is_file() and not self.args.backup_identity.is_symlink()
                and self.args.backup_identity.stat().st_mode & 0o077 == 0, 'Protected local age identity is required')
        before = {'database': self.snapshot(), 'ledger': self.ledger(), 'acl': self.acl()}
        require(before['ledger'] == [
            {'version': name, 'scope': 'cloud', 'checksum': digest((REPO / 'db/cloud/migrations' / name).read_bytes())}
            for name in self.baseline_migrations()], 'Unexpected live migration baseline or checksum')
        fingerprint, caps, catalogs = self.fingerprint(), self.health(), self.catalogs()
        self.save('before.json', {**before, 'fingerprint': fingerprint, 'caps': caps, 'catalog_hashes': list(map(digest, catalogs))})
        backup = self.backup_restore(before['database'])
        self.save('backup.json', backup)
        require(self.fingerprint() == fingerprint, 'Unrelated service changed before apply')
        mutation_attempted = False
        try:
            self.runtime_old()
            compare_existing(before['database'], self.snapshot())
            require(self.prepared_artifacts(prepared['public_manifest']) == prepared['remote_artifacts'],
                    'Prepared artifact changed during restore rehearsal')
            mutation_attempted = True
            print('Applying reviewed migrations and runtime grants; real auth remains disabled.', flush=True)
            for _ in range(2):
                self.remote(api_compose(self.sha) + ' run --rm --no-deps provision', timeout=180)
                self.migration_delta(before['ledger'], before['database'])
                self.runtime_grants(before['acl'])
            self.remote(api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            self.remote(web_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 90 gateway', timeout=150)
            self.probes(prepared, caps, catalogs)
            self.migration_delta(before['ledger'], before['database'])
            require(self.fingerprint() == fingerprint, 'Unrelated service or iDrink config changed')
            self.switch(REMOTE + '/current', f'{REMOTE}/releases/{OLD_API}', f'{REMOTE}/releases/{self.sha}')
            self.switch(REMOTE + '/public-https/current', f'{REMOTE}/public-https/releases/{OLD_WEB}',
                        f'{REMOTE}/public-https/releases/{self.sha}')
            self.save('result.json', {'sha': self.sha, 'backup': backup, 'migration_delta': MIGRATIONS,
                      'catalog_editor_enabled': True, 'customer_auth_enabled': False,
                      'manager_issued': False, 'catalog_seeded': False, 'orders_created': False,
                      'cleanup_installed': False, 'preserved_services': fingerprint, 'checks': 'passed'})
            print('API and public gateway verified. Existing data preserved; no manager or order was created.', flush=True)
        except Exception as error:
            self.record_error(error)
            if isinstance(error, CommandUncertain):
                self.save('uncertain.json', {'source_sha': self.sha, 'automatic_rollback_started': False,
                          'deployment_lock_retained': True, 'requires_remote_process_and_container_review': True})
                print('Remote completion is uncertain. No competing rollback started; deployment lock retained.', flush=True)
            elif mutation_attempted:
                print('Release verification failed. Restoring previous services and runtime ACL; retaining additive schema.', flush=True)
                self.rollback(before, caps, catalogs, fingerprint, prepared)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'apply'])
    parser.add_argument('sha')
    parser.add_argument('--branch', required=True)
    parser.add_argument('--ssh-key', type=Path, default=Path.home() / '.ssh/pickchick_staging_ed25519')
    parser.add_argument('--backup-identity', type=Path, default=REPO / '.local/vps/backup-identity.agekey')
    proof = parser.add_mutually_exclusive_group()
    proof.add_argument('--ci-run')
    proof.add_argument('--ci-proof', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    require(re.fullmatch('[a-f0-9]{40}', args.sha), 'Expected a full SHA')
    release = Release(args)
    try:
        release.source_checks()
        with release.deployment_lock():
            getattr(release, args.action)()
    except Exception as error:
        release.record_error(error)
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No exception repr/cause or command output: those can contain connection credentials.
        print('Release stopped. Review private evidence and actual state before retrying.', flush=True)
        raise SystemExit(1) from None
