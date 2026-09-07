#!/usr/bin/env python3
"""Follow-on staging 7cd/001–013 → reviewed SHA/001–014, new domains disabled.

Owner-run prepare/apply. Apply closes our public gateway, cooperates with the pinned
cleanup flock, stops only our API, and verifies all existing data before reopening.
No live database restore, credential issuance, timer replacement or lock stealing.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import time
import uuid

spec = importlib.util.spec_from_file_location('market_release', Path(__file__).with_name('release-market.py'))
market = importlib.util.module_from_spec(spec)
spec.loader.exec_module(market)
require, digest, quote = market.require, market.digest, market.quote
GuardFailure, CommandUncertain = market.GuardFailure, market.CommandUncertain
REMOTE, REPO = market.REMOTE, market.REPO
PROFILE = market.TRANSPORT_PROFILE
CLEANUP_LOCK = REMOTE + '/maintenance/identity-cleanup.lock'
CADDY = 'caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648'


def maintenance_config():
    """No reverse proxy, header bypass or public health exception. Admin API is disabled."""
    return {'admin': {'disabled': True}, 'apps': {'http': {'servers': {
        'closed': {'listen': [':8080'], 'routes': [{'handle': [{
            'handler': 'static_response', 'status_code': 503,
            'headers': {'Retry-After': ['60'], 'Cache-Control': ['no-store'],
                        'Content-Type': ['text/plain; charset=utf-8']},
            'body': 'PickChick: temporary maintenance. Please retry shortly.\n',
        }]}]},
        'container_health': {'listen': ['127.0.0.1:8099'], 'routes': [{'handle': [{
            'handler': 'static_response', 'status_code': 200, 'body': 'maintenance\n',
        }]}]},
    }}}}


def maintenance_overlay(directory):
    # Compose treats command and healthcheck.test as replacements, volumes by destination.
    return {'services': {'gateway': {
        'command': ['caddy', 'run', '--config', '/etc/caddy/maintenance.json'],
        'volumes': [{'type': 'bind', 'source': directory + '/maintenance.json',
                     'target': '/etc/caddy/maintenance.json', 'read_only': True}],
        'healthcheck': {'test': ['CMD', 'wget', '-q', '-O', '/dev/null',
                                'http://127.0.0.1:8099/'], 'interval': '2s',
                        'timeout': '3s', 'retries': 15},
    }}}


def check_cron(text):
    expected = ('*/15 * * * * /bin/bash ' + REMOTE + '/releases/' + PROFILE.old_api +
                '/infra/staging/identity-cleanup-cron.sh ' + PROFILE.old_api)
    lines = [line.strip() for line in text.splitlines()]
    require(lines.count('# BEGIN PICKCHICK IDENTITY CLEANUP') == 1 and
            lines.count('# END PICKCHICK IDENTITY CLEANUP') == 1,
            'Expected pinned cleanup cron block is missing or duplicated')
    begin, end = lines.index('# BEGIN PICKCHICK IDENTITY CLEANUP'), lines.index('# END PICKCHICK IDENTITY CLEANUP')
    require(lines[begin + 1:end] == [expected], 'Cleanup cron does not match the reviewed pinned 7cd runner')
    active = [line for line in lines if line and not line.startswith('#')]
    require([line for line in active if 'identity-cleanup' in line or 'customer-identity-maintenance' in line]
            == [expected], 'Additional identity cleanup entry requires operator coordination')
    return digest(text.encode())


class TransportRelease(market.Release):
    profile = PROFILE

    def __init__(self, args):
        super().__init__(args, PROFILE)
        self.phase = 'initial'
        self.opening_started = False
        self.maintenance_attempted = False
        self.cleanup_held = False
        self.window_started = None

    def journal(self, phase, **extra):
        self.phase = phase
        self.save('phase-' + str(time.time_ns()) + '.json', {
            'profile': PROFILE.name, 'source_sha': self.sha, 'owner': self.lock_owner,
            'phase': phase, **extra,
        })

    def source_checks(self):
        super().source_checks()
        text = (REPO / 'db/cloud/migrations' / PROFILE.migrations[0]).read_text()
        require(set(re.findall(r'CREATE\s+TABLE\s+([a-z][a-z0-9_]*)', text, re.I)) == market.TRANSPORT_TABLES,
                '014 does not create exactly the six reviewed cloud transport tables')
        require(not re.search(r'CREATE\s+SEQUENCE|\b(?:BIG)?SERIAL\b|GENERATED\s+.*IDENTITY', text, re.I),
                '014 unexpectedly defines a sequence')
        require((REPO / 'infra/staging/release-maintenance-lock.py').is_file(), 'Cleanup coordinator source is missing')

    def cron_fingerprint(self):
        cron = self.remote('crontab -l')
        runner = f'{REMOTE}/releases/{PROFILE.old_api}/infra/staging/identity-cleanup-cron.sh'
        hashes = self.file_hashes([runner])
        expected = digest(self.execute(['git', 'show', PROFILE.old_api + ':infra/staging/identity-cleanup-cron.sh']))
        require(hashes[runner] == expected, 'Pinned cleanup runner bytes changed')
        return {'crontab_sha256': check_cron(cron), 'runner_sha256': expected, 'source_sha': PROFILE.old_api}

    def old_image(self):
        image = json.loads(self.remote('docker image inspect --format ' + quote('{{json .}}') +
                                       ' pickchick-api:' + PROFILE.old_api))
        require(image['Config']['Labels']['org.opencontainers.image.revision'] == PROFILE.old_api,
                'Rollback image revision differs from 7cd')
        return {'id': image['Id'], 'revision': PROFILE.old_api}

    def runtime_old(self):
        super().runtime_old()
        require(self.remote('docker inspect --format ' + quote('{{.Image}}') + ' ' + market.API_CONTAINER)
                == self.old_image()['id'], 'Running baseline image differs from its rollback tag')
        self.disabled_private()
        self.cron_fingerprint()

    def prepared_artifacts(self, manifest):
        return {**super().prepared_artifacts(manifest), 'rollback_image': self.old_image(),
                'cleanup': self.cron_fingerprint(),
                'coordinator_sha256': digest((REPO / 'infra/staging/release-maintenance-lock.py').read_bytes())}

    def health(self):
        # Private loopback only. Public traffic remains closed for the entire invariant window.
        ready = self.http_json('/health/ready', public=False)
        require(ready.get('ready') is True and ready.get('degraded') is False and
                ready.get('dependencies') == {'database': 'up', 'schema': 'up', 'redis': 'up'},
                'API dependencies are not ready')
        caps = self.http_json('/v1/capabilities', public=False)
        require(caps.get('environment') == 'staging' and caps.get('data_mode') == 'synthetic'
                and caps.get('ordering_enabled') is False and caps.get('features') == {
                    'phone_auth': False, 'checkout': False, 'payments': False, 'fiscal': False,
                    'loyalty': False, 'test_order_flow': True}, 'Unexpected runtime capability')
        return caps

    def catalogs(self):
        return [self.http_json('/v1/test/catalog?catalog_version=' + version, public=False)
                for version in ['mockup-v0.2', 'mockup-v0.3']]

    def disabled_private(self):
        require(self.http_json('/v1/auth/config', public=False) == {
            'enabled': False, 'consent_version': None, 'terms_url': None, 'privacy_url': None},
            'Customer authentication is not disabled')
        body = self.http_json('/v1/admin/catalog/branches', public=False, status=401)
        require(body.get('code') == 'UNAUTHORIZED', 'CMS is disabled or unauthenticated')

    def runtime_grants(self, before):
        current = self.acl()
        require(current == before, 'A disabled follow-on release changed an existing runtime ACL')
        require(not any(row['name'] in market.TRANSPORT_TABLES or
                        row['name'].startswith(('identity_', 'commerce_', 'loyalty_')) for row in current),
                'A disabled domain unexpectedly has runtime privileges')

    def create_maintenance(self):
        self.maintenance_path = f'{REMOTE}/maintenance/transport-{self.sha}-{self.lock_owner["id"]}'
        contents = {'owner.json': json.dumps(self.lock_owner),
                    'maintenance.json': json.dumps(maintenance_config(), sort_keys=True),
                    'compose.json': json.dumps(maintenance_overlay(self.maintenance_path), sort_keys=True)}
        self.maintenance_hashes = {self.maintenance_path + '/' + name: digest(value.encode())
                                   for name, value in contents.items()}
        program = '''import json,os,pathlib,sys
path=pathlib.Path(sys.argv[1]); path.mkdir(mode=0o700)
assert not path.is_symlink()
for name,value in json.load(sys.stdin).items():
 with open(path/name,'x') as output:
  os.fchmod(output.fileno(),0o600); output.write(value)
'''
        self.remote('python3 -c ' + quote(program) + ' ' + quote(self.maintenance_path), input=json.dumps(contents))
        self.journal('maintenance_prepared', file_sha256=self.maintenance_hashes)
        require(self.file_hashes(list(self.maintenance_hashes)) == self.maintenance_hashes,
                'Maintenance artifacts changed after writing')
        self.remote(f'docker run --rm --network none --entrypoint caddy '
                    f'-v {quote(self.maintenance_path + "/maintenance.json")}:/tmp/maintenance.json:ro '
                    + CADDY + ' validate --config /tmp/maintenance.json', timeout=45)
        self.remote(self.closed_compose(PROFILE.old_web) + ' config --quiet')

    def cleanup(self, action):
        script = f'{REMOTE}/releases/{self.sha}/infra/staging/release-maintenance-lock.py'
        require(self.file_hashes([script])[script] == digest((REPO / 'infra/staging/release-maintenance-lock.py').read_bytes()),
                'Cleanup coordinator differs from source')
        value = json.loads(self.remote('python3 ' + quote(script) + ' ' + action + ' ' +
            ' '.join(map(quote, [self.maintenance_path, CLEANUP_LOCK, self.lock_owner['id']])), timeout=15))
        require(value['owner'] == self.lock_owner['id'], 'Cleanup owner changed')
        if action == 'acquire':
            self.cleanup_held = True
        if action == 'release':
            self.cleanup_held = False
        return value

    def closed_compose(self, sha):
        return market.web_compose(sha) + ' -f ' + quote(self.maintenance_path + '/compose.json')

    def close_ingress(self):
        self.window_started = time.monotonic()
        self.maintenance_attempted = True
        self.journal('closing_public_ingress')
        self.remote(self.closed_compose(PROFILE.old_web) + ' up -d --no-deps --wait --wait-timeout 90 gateway', timeout=150)
        self.quiescent()
        self.journal('public_ingress_closed')

    def quiescent(self):
        require(self.window_started is not None and time.monotonic() - self.window_started < 900,
                'Maintenance verification window exceeded 15 minutes; ingress remains closed for review')
        self.cleanup('status')
        require(self.cron_fingerprint() == self.expected_cleanup, 'Existing cleanup configuration changed')
        require(self.file_hashes(list(self.maintenance_hashes)) == self.maintenance_hashes,
                'Maintenance configuration or ownership changed')
        require(self.remote(f'docker exec {market.GATEWAY} sha256sum /etc/caddy/maintenance.json').split()[0]
                == self.maintenance_hashes[self.maintenance_path + '/maintenance.json'],
                'Actual gateway maintenance bytes differ')
        command = json.loads(self.remote('docker inspect --format ' + quote('{{json .Config.Cmd}}') + ' ' + market.GATEWAY))
        require(command == ['caddy', 'run', '--config', '/etc/caddy/maintenance.json'],
                'Gateway is not running the reviewed maintenance config')
        for path, method in [('/health/live', 'GET'), ('/v1/admin/catalog/branches', 'GET'),
                             ('/v1/test/orders', 'POST'), ('/v1/auth/otp/request', 'POST')]:
            require(self.http(path, method=method)[0] == 503, 'Public maintenance route is not closed')

    def stop_api(self):
        self.remote(market.api_compose(PROFILE.old_api) + ' stop --timeout 30 api', timeout=60)
        require(self.remote('docker inspect --format ' + quote('{{.State.Running}}') + ' ' + market.API_CONTAINER)
                == 'false', 'Previous API has not stopped')
        # A direct owner/worker writer is outside this tool's authority; do not terminate it.
        active = self.psql(market.DB, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                           "AND pid<>pg_backend_pid() AND (usename='pickchick_app' OR xact_start IS NOT NULL)")
        require(active == '0', 'Another database session can write during the maintenance snapshot')
        self.journal('api_drained_and_stopped')

    def backup_restore(self, expected):
        # Same encrypted format as the historical helper; unknown restore never races dropdb.
        suffix = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
        backup = f'{REMOTE}/backups/cloud-transport-{suffix}.dump.age'
        script = f'''set -euo pipefail
umask 077
exec 9>{REMOTE}/backups/.lock
flock -n 9
recipient=$(cat {REMOTE}/secrets/backup-recipient.txt)
[[ "$recipient" == age1* ]]
test ! -e {backup}
trap 'rm -f {backup}.tmp' EXIT
docker exec {market.DB_CONTAINER} pg_dump -U postgres -d {market.DB} --format=custom --no-owner --no-acl | age -r "$recipient" -o {backup}.tmp
test -s {backup}.tmp
mv {backup}.tmp {backup}
sha256sum {backup} > {backup}.sha256
'''
        self.remote('bash -o pipefail -c ' + quote(script), timeout=180)
        self.remote('sha256sum --check ' + backup + '.sha256')
        database = 'pickchick_restore_transport_' + uuid.uuid4().hex[:12]
        self.journal('restore_starting', temporary_database=database, encrypted_backup=backup)
        self.remote(f'docker exec {market.DB_CONTAINER} createdb -U postgres {database}')
        try:
            pipeline = f'age --decrypt --identity /dev/stdin {backup} | docker exec -i {market.DB_CONTAINER} '
            pipeline += f'pg_restore -U postgres -d {database} --exit-on-error --no-owner --no-acl'
            self.remote('bash -o pipefail -c ' + quote(pipeline), input=self.args.backup_identity.read_bytes(), timeout=180)
            market.compare_existing(expected, self.snapshot(database))
            self.quiescent()
            market.compare_existing(expected, self.snapshot())
        except CommandUncertain:
            # Both the temporary database and maintenance locks remain for process inspection.
            raise
        except Exception:
            self.remote(f'docker exec {market.DB_CONTAINER} dropdb -U postgres {database}')
            raise
        else:
            self.remote(f'docker exec {market.DB_CONTAINER} dropdb -U postgres {database}')
        return {'path': backup, 'sha256': self.remote('sha256sum ' + backup).split()[0],
                'restore': 'passed', 'temporary_database_removed': True}

    def ledger_rows(self):
        return json.loads(self.psql(market.DB,
            "SELECT json_agg(json_build_object('version',version,'sha256',"
            "encode(sha256(convert_to(row_to_json(m)::text,'UTF8')),'hex')) ORDER BY version) "
            "FROM schema_migrations m"))

    def migration_delta(self, before_ledger, before):
        super().migration_delta(before_ledger, before)
        # The additive table hash skips schema_migrations as a whole; preserve old applied_at too.
        require(self.ledger_rows()[:len(before_ledger)] == self.baseline_ledger_rows,
                'A complete pre-existing migration ledger row changed')

    def check_data(self, before, *, check_acl=True):
        self.quiescent()
        ledger = self.ledger()
        if ledger == before['ledger']:
            market.compare_existing(before['database'], self.snapshot())
        else:
            self.migration_delta(before['ledger'], before['database'])
        if check_acl:
            self.runtime_grants(before['acl'])
        self.quiescent()

    def private_probes(self, prepared, caps, catalogs):
        require(self.health() == caps and self.catalogs() == catalogs, 'Private legacy capability/catalog regression')
        self.disabled_private()
        for action in ['pull', 'ack', 'events']:
            require(self.http('/internal/v1/edge/fulfillment/' + action, public=False, method='POST')[0] == 404,
                    'Cloud fulfillment transport is unexpectedly enabled')
        require(self.remote('docker inspect --format ' + quote('{{.Image}}') + ' ' + market.API_CONTAINER)
                == prepared['image_id'], 'Actual candidate image differs from prepared image')

    def rollback_closed(self, before, caps, catalogs, fingerprint, prepared):
        self.quiescent()
        require(self.rollback_artifacts() == prepared['remote_artifacts']['rollback_files'] and
                self.old_image() == prepared['remote_artifacts']['rollback_image'], 'Rollback artifacts changed')
        # No dump restore. Refuse to pretend concurrent/extra DML can be erased by rollback.
        self.check_data(before, check_acl=False)
        self.psql(market.DB, market.acl_restore_sql(before['acl'], self.acl()))
        self.runtime_grants(before['acl'])
        self.remote(market.api_compose(PROFILE.old_api) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
        require(self.remote('docker inspect --format ' + quote('{{.Image}}') + ' ' + market.API_CONTAINER)
                == prepared['remote_artifacts']['rollback_image']['id'], 'Rollback image identity changed')
        require(self.health() == caps and self.catalogs() == catalogs, 'Old API does not accept retained schema')
        self.disabled_private()
        for path, old, new in self.pointers():
            actual = self.remote('readlink -f ' + path)
            require(actual in [old, new], 'Pointer belongs to another release; rollback stopped')
            if actual == new:
                self.switch(path, new, old)
        self.check_data(before)
        require(self.fingerprint() == fingerprint, 'Unrelated service changed during rollback')
        self.journal('rollback_verified_before_reopening', zero_existing_dml=True, retained_ledger=self.ledger())
        self.open_gateway(PROFILE.old_web)
        self.public_probes(prepared, caps, catalogs, old=True)
        self.cleanup('release')
        self.save('rollback.json', {'api_sha': PROFILE.old_api, 'web_sha': PROFILE.old_web,
                  'schema_retained': True, 'database_restored_over_live': False,
                  'all_existing_data_verified_before_reopening': True, 'cleanup_pin_unchanged': True})

    def pointers(self):
        return [(REMOTE + '/current', f'{REMOTE}/releases/{PROFILE.old_api}', f'{REMOTE}/releases/{self.sha}'),
                (REMOTE + '/public-https/current', f'{REMOTE}/public-https/releases/{PROFILE.old_web}',
                 f'{REMOTE}/public-https/releases/{self.sha}')]

    def open_gateway(self, sha):
        self.opening_started = True
        self.journal('reopening_public_ingress', gateway_sha=sha)
        self.remote(market.web_compose(sha) + ' up -d --no-deps --wait --wait-timeout 90 gateway', timeout=150)
        self.journal('public_ingress_reopened', gateway_sha=sha)

    def public_probes(self, prepared, caps, catalogs, *, old=False):
        # Legitimate requests may now mutate data. Absolutely no baseline rowhash assertions here.
        require(self.http_json('/v1/capabilities') == caps, 'Public capability regression')
        require([self.http_json('/v1/test/catalog?catalog_version=' + version)
                 for version in ['mockup-v0.2', 'mockup-v0.3']] == catalogs, 'Public TEST catalog regression')
        for path in ['/v1/auth/config', '/v1/customers/me', '/health/ready', '/health/metrics',
                     '/internal/v1/edge/fulfillment/config']:
            require(self.http(path)[0] == 404, 'Private route exposed after reopening')
        for path in ['/v1/auth/otp/request', '/v1/auth/otp/verify', '/v1/auth/refresh', '/v1/auth/logout',
                     '/internal/v1/edge/fulfillment/pull', '/internal/v1/edge/fulfillment/ack', '/internal/v1/edge/fulfillment/events']:
            require(self.http(path, method='POST')[0] == 404, 'Private write route exposed after reopening')
        body = self.http_json('/v1/admin/catalog/branches', status=401)
        require(body.get('code') == 'UNAUTHORIZED', 'Public CMS authentication regression')
        source = PROFILE.old_web if old else self.sha
        manifest = json.loads(self.remote(f'docker exec {market.GATEWAY} cat /srv/public/.release.json'))
        require(manifest['source_sha'] == source, 'Actual gateway source differs after reopening')
        expected = manifest if old else prepared['public_manifest']
        require(manifest == expected, 'Actual gateway manifest changed')
        config_hash = (prepared['remote_artifacts']['rollback_files'][f'{REMOTE}/public-https/releases/{PROFILE.old_web}/infra/public-staging/gateway.Caddyfile']
                       if old else prepared['gateway_sha256'])
        require(self.remote(f'docker exec {market.GATEWAY} sha256sum /etc/caddy/Caddyfile').split()[0]
                == config_hash, 'Actual gateway configuration changed after reopening')
        if old:
            manifest_path = f'{REMOTE}/public-https/releases/{PROFILE.old_web}/infra/public-staging/public-web/.release.json'
            require(self.remote(f'docker exec {market.GATEWAY} sha256sum /srv/public/.release.json').split()[0]
                    == prepared['remote_artifacts']['rollback_files'][manifest_path], 'Old gateway manifest bytes changed')
        status, body = self.http('/backoffice/api.js')
        require(status == 200 and digest(body) == expected['files']['backoffice/api.js'], 'Public CMS asset differs')

    def verify_prepared(self):
        prepared = json.loads((self.private / 'prepared.json').read_text())
        require(prepared['profile'] == PROFILE.name and prepared['sha'] == self.sha and
                prepared['old_api'] == PROFILE.old_api and prepared['old_web'] == PROFILE.old_web,
                'Prepared evidence belongs to another release profile')
        proof = json.loads((self.private / 'ci-proof.json').read_text())
        market.verify_ci(proof, self.sha, PROFILE.ci_jobs, exact_jobs=True)
        require(digest({'run': proof['run'], 'jobs': proof['jobs']}) == prepared['ci_proof_sha256'], 'CI proof changed')
        require(self.prepared_artifacts(prepared['public_manifest']) == prepared['remote_artifacts'],
                'Prepared or rollback artifacts changed')
        key = self.args.backup_identity
        require(key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0,
                'Protected local age identity is required')
        return prepared

    def apply(self):
        self.source_checks()
        self.runtime_old()
        prepared = self.verify_prepared()
        self.expected_cleanup = prepared['remote_artifacts']['cleanup']
        caps, catalogs = self.health(), self.catalogs()
        before = None
        fingerprint = None
        try:
            self.create_maintenance()
            self.cleanup('acquire')
            self.journal('existing_cleanup_flock_acquired')
            self.close_ingress()
            self.stop_api()
            self.quiescent()
            self.baseline_ledger_rows = self.ledger_rows()
            before = {'database': self.snapshot(), 'ledger': self.ledger(), 'acl': self.acl(),
                      'ledger_rows': self.baseline_ledger_rows}
            expected = [{'version': name, 'scope': 'cloud', 'checksum': digest((REPO / 'db/cloud/migrations' / name).read_bytes())}
                        for name in self.baseline_migrations()]
            require(before['ledger'] == expected, 'Unexpected 001–013 live baseline')
            self.runtime_grants(before['acl'])
            fingerprint = self.fingerprint()
            self.save('before.json', {**before, 'fingerprint': fingerprint, 'caps': caps,
                      'catalog_hashes': list(map(digest, catalogs)), 'quiescent_window': True})
            self.journal('quiescent_baseline_captured')
            backup = self.backup_restore(before['database'])
            self.save('backup.json', backup)
            require(self.prepared_artifacts(prepared['public_manifest']) == prepared['remote_artifacts'],
                    'Artifacts changed during backup rehearsal')
            for index in range(2):
                self.quiescent()
                self.remote(market.api_compose(self.sha) + ' run --rm --no-deps provision', timeout=180)
                self.migration_delta(before['ledger'], before['database'])
                self.runtime_grants(before['acl'])
                self.journal('provision_verified', iteration=index + 1)
            self.remote(market.api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            self.private_probes(prepared, caps, catalogs)
            # Real rollback compatibility rehearsal, still behind maintenance. Never run old provision.
            self.remote(market.api_compose(PROFILE.old_api) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            require(self.remote('docker inspect --format ' + quote('{{.Image}}') + ' ' + market.API_CONTAINER)
                    == prepared['remote_artifacts']['rollback_image']['id'], 'Old compatibility image changed')
            require(self.health() == caps and self.catalogs() == catalogs, '7cd image cannot read retained 014 schema')
            self.disabled_private()
            self.check_data(before)
            self.journal('old_image_on_014_verified')
            self.remote(market.api_compose(self.sha) + ' up -d --no-deps --wait --wait-timeout 120 api', timeout=180)
            self.private_probes(prepared, caps, catalogs)
            self.check_data(before)
            require(self.fingerprint() == fingerprint, 'Unrelated container or iDrink configuration changed')
            for path, old, new in self.pointers():
                self.switch(path, old, new)
            self.check_data(before)
            self.journal('all_invariants_verified_before_reopening', zero_existing_dml=True,
                         old_image_014_compatible=True, backup_restore='passed')
            self.open_gateway(self.sha)
            self.public_probes(prepared, caps, catalogs)
            self.cleanup('release')
            self.save('result.json', {'sha': self.sha, 'profile': PROFILE.name, 'backup': backup,
                      'migration_delta': PROFILE.migrations, 'new_tables_empty': sorted(market.TRANSPORT_TABLES),
                      'no_new_sequences': True, 'runtime_acl_unchanged': True,
                      'old_7cd_on_014_verified': True, 'all_existing_data_verified_before_reopening': True,
                      'post_reopen_zero_dml_claim': False, 'cleanup_pin_unchanged': True,
                      'new_flags_enabled': False, 'catalog_editor_enabled': True,
                      'customer_auth_enabled': False, 'checks': 'passed'})
            self.journal('complete')
            print('Follow-on release verified. Existing data matched before reopening; cleanup pin unchanged.', flush=True)
        except BaseException as error:
            self.record_error(error)
            uncertain = isinstance(error, CommandUncertain) or not isinstance(error, Exception)
            if uncertain or self.opening_started:
                self.save('uncertain.json', {'source_sha': self.sha, 'phase': self.phase,
                    'automatic_rollback_started': False, 'deployment_lock_retained': True,
                    'cleanup_lock_release_not_attempted': self.cleanup_held,
                    'ingress': 'unknown_or_opening' if self.opening_started else
                               ('maintenance_expected_verify_actual' if self.maintenance_attempted else 'unchanged_or_unknown'),
                    'requires_process_container_and_owner_review': True})
            elif before is not None and fingerprint is not None:
                self.rollback_closed(before, caps, catalogs, fingerprint, prepared)
            else:
                # Baseline is not proven. Never automatically open a partially closed gateway or erase data.
                self.journal('stopped_before_proven_baseline', maintenance_retained=self.maintenance_attempted,
                             cleanup_lock_retained=self.cleanup_held)
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
    require(re.fullmatch('[a-f0-9]{40}', args.sha), 'Expected full source SHA')
    release = TransportRelease(args)
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
    except Exception:
        print('Follow-on release stopped. Inspect private evidence and owned maintenance before retrying.', flush=True)
        raise SystemExit(1) from None
