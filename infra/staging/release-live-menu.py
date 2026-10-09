#!/usr/bin/env python3
"""Guarded cf25/schema050 API-only release; default is read-only.

prepare/apply/enable/disable/rollback need --apply. No migration, provision,
SQL grant, banking request, gateway replacement or production dump restoration.
All failures retain the owned release lock; an explicit rollback may resume only
that owner. Apply installs with the head guard off; enable is a separate step.
"""
import argparse
from contextlib import contextmanager
import importlib.util
import json
from pathlib import Path
import re
import sys
import time

spec = importlib.util.spec_from_file_location('live_menu_unified_base', Path(__file__).with_name('release-unified-menu.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, require, digest, quote = base.market, base.require, base.digest, base.quote
GuardFailure, REMOTE = market.GuardFailure, market.REMOTE
BASELINE = 'cf25cb9e4712a7beedc2d2b52a9d64d3e557598f'
FLAG = 'CUSTOMER_CHECKOUT_HEAD_GUARD'
BANKS = ('pickchick-kaspi-bridge', 'pickchick-kaspi-worker', 'pickchick-kiosk-kaspi-qr-worker')
SELECT_TABLES = ('branches', 'catalog_branch_heads', 'commerce_quotes', 'commerce_orders',
                 'commerce_payment_attempts', 'commerce_captures', 'commerce_refunds',
                 'commerce_cancellation_intents', 'fulfillment_transport_bindings',
                 'cloud_fulfillment_projection', 'commerce_outbox', 'commerce_commands')
INSERT_TABLES = ('commerce_cancellation_intents', 'commerce_outbox', 'commerce_commands')
UPDATE_COLUMNS = {
    'catalog_branch_heads': ('lock_anchor',),
    'fulfillment_transport_bindings': ('lock_anchor',),
    'commerce_orders': ('state',),  # FOR UPDATE requires one updateable column.
    'commerce_cancellation_intents': ('state', 'resolution_code', 'updated_at',
                                    'release_event_id', 'expected_edge_version', 'reservation_id'),
}


def compose_candidate(text, expected):
    require(digest(text.encode()) == expected, 'Installed compose differs from reviewed hash')
    require(FLAG not in text and text.count('\n  api:\n') == 1, 'Flag already present or API boundary ambiguous')
    start = text.index('\n  api:\n') + 1
    match = re.search(r'^  [A-Za-z][A-Za-z0-9_-]*:', text[start + len('  api:\n'):], re.M)
    end = start + len('  api:\n') + match.start() if match else len(text)
    section = text[start:end]
    anchor = '      APP_ENV: staging\n'
    require(section.count(anchor) == 1, 'API environment anchor differs')
    line = f'      {FLAG}: "false"\n'
    result = text[:start] + section.replace(anchor, line + anchor) + text[end:]
    require(result.replace(line, '', 1) == text, 'Unrelated compose change')
    return result


def compose_flag(text, enabled):
    old, new = ('false', 'true') if enabled else ('true', 'false')
    before, after = f'      {FLAG}: "{old}"\n', f'      {FLAG}: "{new}"\n'
    require(text.count(FLAG) == 1 and text.count(before) == 1, 'Flag is not in expected state')
    return text.replace(before, after, 1)


def check_pins(args):
    require(args.expected_api_sha == BASELINE, 'Exact cf25 API baseline required')
    require(re.fullmatch('[a-f0-9]{40}', args.expected_public_sha or ''), 'Reviewed public pointer required')
    for name in ['expected_compose_sha256', 'expected_gateway_sha256']:
        require(re.fullmatch('[a-f0-9]{64}', getattr(args, name) or ''), 'Reviewed compose/gateway hashes required')
    require(re.fullmatch('sha256:[a-f0-9]{64}', args.expected_api_image or ''), 'Reviewed API image ID required')


def acl_sql():
    checks = [(f'{table}:{priv}', f"has_table_privilege(current_user,'{table}','{priv}')")
              for priv, tables in [('SELECT', SELECT_TABLES), ('INSERT', INSERT_TABLES)] for table in tables]
    checks += [(f'{table}.{column}:UPDATE', f"has_column_privilege(current_user,'{table}','{column}','UPDATE')")
               for table, columns in UPDATE_COLUMNS.items() for column in columns]
    checks += [('commerce_outbox_sequence_seq:USAGE', "has_sequence_privilege(current_user,'commerce_outbox_sequence_seq','USAGE')")]
    checks += [('no_capture_insert', "NOT has_table_privilege(current_user,'commerce_captures','INSERT')"),
               ('no_order_price_update', "NOT has_column_privilege(current_user,'commerce_orders','total_minor','UPDATE')")]
    values = ','.join(f"('{name}',{condition})" for name, condition in checks)
    return "SELECT current_user AS role, ARRAY(SELECT name FROM (VALUES " + values + ") AS checks(name,ok) WHERE NOT coalesce(ok,false)) AS missing"


def acl_program():
    return """import{createPool}from'@pickchick/database';
const pool=createPool(process.env.CLOUD_DATABASE_URL);const c=await pool.connect();
try{await c.query('BEGIN READ ONLY');const r=await c.query(%s);
console.log(JSON.stringify(r.rows[0]));await c.query('ROLLBACK');}
finally{c.release();await pool.end();}""" % json.dumps(acl_sql())


class Release(base.Release):
    def __init__(self, args):
        check_pins(args)
        profile = market.ReleaseProfile('mobile-live-menu-api-schema050', BASELINE, args.expected_public_sha,
            49, (), base.workflow_jobs((market.REPO/'.github/workflows/ci.yml').read_text()), frozenset(),
            'live-menu-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    source_checks = market.Release.source_checks

    def baseline_migrations(self):
        names = sorted(Path(p).name for p in self.git('ls-tree', '-r', '--name-only', BASELINE, '--',
                                                     'db/cloud/migrations/').splitlines() if p.endswith('.sql'))
        require([int(n[:3]) for n in names] == list(range(1, 41)) + list(range(42, 51)), 'Exact schema050 required')
        return names

    def expected_ledger(self):
        return [{'version': n, 'scope': 'cloud', 'checksum': digest((market.REPO/'db/cloud/migrations'/n).read_bytes())}
                for n in self.baseline_migrations()]

    def runtime_acl(self):
        self.role_restricted()
        raw = self.remote('docker exec ' + market.API_CONTAINER + ' node --input-type=module -e ' + quote(acl_program()))
        result = json.loads(raw)
        self.save('runtime-acl.json', result)
        require(result == {'role': 'pickchick_app', 'missing': []}, 'Runtime unpaid cancellation/head lock/release ACL missing or unsafe')
        return result

    def neighbors(self):
        result = self.fingerprint()
        template = '{{.Id}} {{.Image}} {{.State.StartedAt}} {{.State.Status}} {{.RestartCount}}'
        result['containers'][market.GATEWAY] = self.remote('docker inspect --format ' + quote(template) + ' ' + market.GATEWAY)
        for name in BANKS:
            row = result['containers'].get(name, '').split()
            require(len(row) == 5 and row[3] == 'running', 'Required bank/QR container unavailable')
        return result

    def verify_public(self):
        require(self.remote('readlink -f ' + REMOTE + '/public-https/current') ==
                REMOTE + '/public-https/releases/' + self.args.expected_public_sha, 'Public pointer changed')
        require(self.remote('docker exec ' + market.GATEWAY + ' sha256sum /etc/caddy/Caddyfile').split()[0] ==
                self.args.expected_gateway_sha256, 'Mounted gateway changed')
        self.ready()
        for path in ['/v1/customer-checkout/catalog', '/v1/customer-checkout/availability', '/kitchen-live/health']:
            self.http_json(path)

    def baseline(self):
        a = self.args
        require(self.running_revision() == BASELINE and self.api_image() == a.expected_api_image, 'Live API baseline differs')
        require(self.remote('docker image inspect --format ' + quote('{{.Id}}') + ' pickchick-api:' + BASELINE) ==
                a.expected_api_image, 'Rollback image differs')
        require(self.remote('readlink -f ' + REMOTE + '/current') == REMOTE + '/releases/' + BASELINE, 'API pointer differs')
        require(self.ledger() == self.expected_ledger(), 'Installed ledger is not exact schema050')
        self.runtime_acl(); self.verify_public()
        env = self.runtime_environment()
        require(env.get(FLAG) in (None, digest(b'false')), 'Baseline flag must be absent/off')
        text = self.read_text(self.compose_path(BASELINE))
        return {'candidate': compose_candidate(text, a.expected_compose_sha256), 'environment': env,
                'rollback': self.rollback_artifacts(), 'neighbors': self.neighbors(), 'acl': self.acl(),
                'capabilities': self.http_json('/v1/capabilities', public=False)}

    def prepared(self):
        path = self.private/'prepared.json'
        require(path.is_file() and not path.is_symlink(), 'Preparation evidence required')
        record = json.loads(path.read_text())
        require(record['sha'] == self.sha and record['baseline'] == BASELINE, 'Foreign preparation')
        return record

    def artifacts(self):
        image = json.loads(self.remote('docker image inspect --format ' + quote('{{json .}}') + ' pickchick-api:' + self.sha))
        require(image['Config']['Labels']['org.opencontainers.image.revision'] == self.sha, 'Candidate image revision differs')
        return {'image': image['Id'], 'files': self.file_hashes([self.compose_path(self.sha), REMOTE+'/releases/'+self.sha+'/release.env'])}

    def prepare(self):
        before = self.baseline()
        if not self.args.apply:
            return self.plan('prepare', {'api_only': True, 'migrations': [], 'head_guard': False})
        require(not (self.private/'prepared.json').exists(), 'Preparation already exists; no replay')
        target = REMOTE + '/releases/' + self.sha
        archive = self.execute(['git', 'archive', '--format=tar', self.sha, *market.ARCHIVE_PATHS])
        self.remote(f'test ! -e {target} && mkdir {target} && tar -xf - -C {target}', input=archive, timeout=180)
        self.remote('python3 -c ' + quote(market.release_env_script(self.profile)) + ' ' + ' '.join(map(quote,
            [REMOTE+'/releases/'+BASELINE+'/release.env', target+'/release.env', self.sha, BASELINE])))
        self.write_remote(self.compose_path(self.sha), before['candidate'])
        self.remote('! docker image inspect pickchick-api:' + self.sha + ' >/dev/null 2>&1')
        image = self.remote(f'cd {target} && docker build -q -f infra/staging/Dockerfile --build-arg RELEASE_SHA={self.sha} '
                            f'-t pickchick-api:{self.sha} .', timeout=1200)
        require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'Invalid immutable image')
        self.remote(market.api_compose(self.sha) + ' config --quiet')
        artifacts = self.artifacts()
        require(artifacts['image'] == image and self.baseline() == before, 'Preparation drift')
        self.save('prepared.json', {'sha': self.sha, 'baseline': BASELINE, 'before': before, 'artifacts': artifacts,
                                    'archive_sha256': digest(archive)})

    def current(self, proof, flag):
        require(self.running_revision() == self.sha and self.api_image() == proof['artifacts']['image'], 'Candidate API changed')
        require(self.remote('readlink -f ' + REMOTE + '/current') == REMOTE+'/releases/'+self.sha, 'Candidate pointer changed')
        require(self.ledger() == self.expected_ledger() and self.acl() == proof['before']['acl'], 'Schema or ACL changed')
        require(self.neighbors() == proof['before']['neighbors'], 'Bank/QR/gateway or another container changed')
        require(self.rollback_artifacts() == proof['before']['rollback'], 'Rollback artifacts changed')
        base.verify_environment_delta(proof['before']['environment'], self.runtime_environment(),
                                      {FLAG: str(flag).lower()}, release_sha_may_change=True)
        self.runtime_acl(); self.verify_public()
        require(self.http_json('/v1/capabilities', public=False) == proof['before']['capabilities'], 'Capabilities changed')

    def apply(self):
        proof = self.prepared()
        require(self.baseline() == proof['before'] and self.artifacts() == proof['artifacts'], 'Prepared baseline/artifacts drift')
        if not self.args.apply:
            return self.plan('apply', {'api_only': True, 'head_guard': False, 'backup_restore_required': True})
        key = self.args.backup_identity
        require(key and key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0, 'Protected backup identity required')
        self.save('before-snapshot.json', self.snapshot())
        backup = self.backup_restore()
        require(backup.get('restore') == 'passed', 'Isolated backup restore not confirmed')
        self.save('backup.json', backup)
        require(self.baseline() == proof['before'], 'Baseline changed during backup/restore')
        self.remote(market.api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
        self.ready()
        require(self.api_image() == proof['artifacts']['image'], 'API image differs')
        self.switch(REMOTE+'/current', REMOTE+'/releases/'+BASELINE, REMOTE+'/releases/'+self.sha)
        self.current(proof, False)
        self.save('after-snapshot.json', self.snapshot())
        self.save('applied.json', {'sha': self.sha, 'head_guard': False, 'backup': backup,
                                  'applied_at': time.time(), 'schema': 50, 'migrations': [], 'acl_unchanged': True})

    def switch_flag(self, enabled):
        proof = self.prepared()
        applied = self.private/'applied.json'
        require(applied.is_file() and json.loads(applied.read_text()).get('sha') == self.sha, 'Completed API-off deploy required')
        self.current(proof, not enabled)
        expected = proof['before']['candidate'] if enabled else compose_flag(proof['before']['candidate'], True)
        text = self.read_text(self.compose_path(self.sha))
        require(text == expected, 'Candidate compose changed beyond the flag')
        require(self.file_hashes([REMOTE+'/releases/'+self.sha+'/release.env'])[REMOTE+'/releases/'+self.sha+'/release.env'] ==
                proof['artifacts']['files'][REMOTE+'/releases/'+self.sha+'/release.env'], 'Candidate environment file changed')
        if not self.args.apply:
            return self.plan('enable' if enabled else 'disable', {'flag': FLAG, 'value': enabled})
        candidate = compose_flag(text, enabled)
        self.save(('enable' if enabled else 'disable')+'-before.json', {'compose_sha256': digest(text.encode())})
        self.write_remote(self.compose_path(self.sha), candidate)
        self.remote(market.api_compose(self.sha) + ' config --quiet')
        self.remote(market.api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
        self.current(proof, enabled)
        self.save(('enabled' if enabled else 'disabled')+'.json', {'sha': self.sha, 'flag': FLAG, 'enabled': enabled})

    def rollback(self):
        proof = self.prepared()
        require(self.running_revision() == self.sha, 'Rollback requires candidate API; inspect any interrupted switch first')
        require(self.ledger() == self.expected_ledger() and self.acl() == proof['before']['acl'], 'Rollback schema/ACL drift')
        require(self.rollback_artifacts() == proof['before']['rollback'] and
                self.neighbors() == proof['before']['neighbors'], 'Rollback artifacts or neighbors drifted')
        require(self.remote('docker image inspect --format ' + quote('{{.Id}}') + ' pickchick-api:' + BASELINE) ==
                self.args.expected_api_image, 'Rollback image drifted')
        if not self.args.apply:
            return self.plan('rollback', {'api_only': True, 'database_restore': False})
        pointer = self.remote('readlink -f ' + REMOTE+'/current')
        require(pointer in (REMOTE+'/releases/'+BASELINE, REMOTE+'/releases/'+self.sha), 'Foreign API pointer')
        self.remote(market.api_compose(BASELINE) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
        if pointer.endswith(self.sha):
            self.switch(REMOTE+'/current', pointer, REMOTE+'/releases/'+BASELINE)
        require(self.baseline() == proof['before'], 'Rollback verification differs')
        self.save('rollback.json', {'sha': self.sha, 'restored_api': BASELINE, 'database_restored': False})

    @contextmanager
    def owned_lock(self):
        owner = self.args.owner_id
        if not owner:
            with self.deployment_lock():
                yield
            return
        require(self.args.action in ('rollback', 'disable') and re.fullmatch(base.UUID_RE, owner), 'Owned recovery only')
        path = self.private/('lock-owner-'+owner+'.json')
        require(path.is_file() and not path.is_symlink(), 'Local owned-lock evidence absent')
        expected = json.loads(path.read_text())
        require(expected['id'] == owner and expected['sha'] == self.sha, 'Foreign local lock')
        actual = json.loads(self.remote('cat ' + quote(market.DEPLOY_LOCK+'/owner.json')))
        require(actual == expected, 'Foreign live release lock')
        yield  # Any failure retains the same lock; no automatic rollback or lock deletion.
        script = "import json,os,sys;p,o=sys.argv[1:];assert json.load(open(p+'/owner.json'))['id']==o;os.unlink(p+'/owner.json');os.rmdir(p)"
        self.remote('python3 -c '+quote(script)+' '+quote(market.DEPLOY_LOCK)+' '+quote(owner))

    def run(self):
        self.source_checks(); self.ci()
        action = self.args.action
        call = (lambda: self.switch_flag(action == 'enable')) if action in ('enable', 'disable') else getattr(self, action)
        if self.args.apply:
            with self.owned_lock():
                call()
        else:
            require(not self.args.owner_id, 'Owner recovery requires --apply')
            call()


def parse(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'apply', 'enable', 'disable', 'rollback'])
    for name in ['sha', 'branch', 'expected-api-sha', 'expected-public-sha', 'expected-api-image',
                 'expected-compose-sha256', 'expected-gateway-sha256']:
        parser.add_argument('--'+name, required=True)
    for name in ['ssh-key', 'backup-identity', 'ci-proof']:
        parser.add_argument('--'+name, type=Path, required=name == 'ssh-key')
    parser.add_argument('--ci-run'); parser.add_argument('--owner-id')
    parser.add_argument('--apply', action='store_true')
    return parser.parse_args(argv)


def main(argv=None):
    release = Release(parse(argv))
    try:
        release.run()
    except Exception as error:
        release.record_error(error)
        print(str(error) if isinstance(error, GuardFailure) else 'Stopped; inspect private evidence; owned lock retained.', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
