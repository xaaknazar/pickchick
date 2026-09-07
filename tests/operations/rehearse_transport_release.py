#!/usr/bin/env python3
"""Explicit local Docker rehearsal, synthetic data only; never SSH or use existing databases.

Requires prebuilt old/new API images and a local helper image containing pg_dump,
pg_restore, age, age-keygen, python3 and flock. See the runbook for reproducible builds.
Creates random named containers/network, removes only those in finally. Raw diagnostics
and encrypted synthetic backup stay in a private directory, never stdout.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('transport_rehearsal', ROOT / 'infra/staging/release-transport.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
market = release.market
PG = 'postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7'
REDIS = 'redis:8.2.1-alpine@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232'

SEED = """import {randomUUID} from 'node:crypto';
import {createPool} from './packages/database/dist/index.js';
import {CatalogAdmin,provisionCatalogManager} from './packages/catalog-admin/dist/index.js';
import {TestOrderFlow,TEST_BRANCH_ID} from './packages/test-order-flow/dist/index.js';
const pool=createPool(process.env.CLOUD_DATABASE_URL);
try {
 const org=randomUUID(),legal=randomUUID(),branch=randomUUID();
 await pool.query("INSERT INTO organizations(id,name)VALUES($1,'Synthetic release rehearsal')",[org]);
 await pool.query("INSERT INTO legal_entities(id,organization_id,name,bin)VALUES($1,$2,'Synthetic','000000000000')",[legal,org]);
 for(const [id,code] of [[branch,'REHEARSAL'],[TEST_BRANCH_ID,'TEST-ALMATY-01']])
  await pool.query("INSERT INTO branches(id,organization_id,legal_entity_id,code,name)VALUES($1,$2,$3,$4,'Synthetic')",[id,org,legal,code]);
 // Synthetic non-decryptable marker; cleanup never dispatches or decrypts this fixture.
 await pool.query("INSERT INTO identity_otp_challenges(id,request_id,phone_lookup,phone_cipher,device_hash,ip_hash,code_hash,state,created_at,expires_at) VALUES($1,$2,repeat('f',64),'synthetic-not-a-real-cipher',repeat('e',64),repeat('d',64),repeat('c',64),'unknown',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')",[randomUUID(),randomUUID()]);
 const manager=await provisionCatalogManager(pool,{organization_id:org,name:'Synthetic manager',branch_ids:[branch]});
 const service=new CatalogAdmin(pool,{enabled:true});
 let state=await service.seed(manager.token,branch,{expected_revision:0,request_id:randomUUID()});
 state.draft.payload.content_reviewed=true;
 state=await service.save(manager.token,branch,{expected_revision:state.draft.revision,request_id:randomUUID(),payload:state.draft.payload});
 state=await service.publish(manager.token,branch,{expected_revision:state.draft.revision,expected_published_version:0,request_id:randomUUID(),confirmation:'publish_catalog'});
 const flow=new TestOrderFlow(pool,{enabled:true,environment:'staging'});
 const customer=await flow.issueSession({channel:'mobile'});
 const quote=await flow.quote(customer.token,randomUUID(),{catalog_version:'mockup-v0.2',service_mode:'takeaway',items:[{product_id:'pick-combo',quantity:1}]});
 let order=await flow.createOrder(customer.token,randomUUID(),{quote_id:quote.quote_id});
 order=await flow.simulatePayment(customer.token,randomUUID(),order.order_id,{expected_version:order.version,outcome:'approved'});
 console.log(JSON.stringify({branch,manager_token:manager.token,state,test_order:order.order_id}));
}finally{await pool.end()}
"""


class Rehearsal(market.Release):
    profile = market.TRANSPORT_PROFILE

    def __init__(self, args):
        self.args = args
        self.sha = args.new_sha
        self.private = args.output.resolve()
        self.private.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.prefix = 'pickchick-transport-' + uuid.uuid4().hex[:10]
        self.names = []
        self.network_created = False
        self.steps = []
        self.original_db = market.DB_CONTAINER
        self.db = self.prefix + '-db'
        self.api = self.prefix + '-api'
        self.gateway = self.prefix + '-gateway'
        self.tool = self.prefix + '-tool'
        market.DB_CONTAINER = self.db
        self.api_url = self.gateway_url = None

    def run(self, args, *, input=None, timeout=120):
        raw = input.encode() if isinstance(input, str) else input
        result = subprocess.run(args, input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if result.returncode:
            self.save('failed-command.json', {'executable': args[0], 'returncode': result.returncode})
            path = self.private / ('error-' + uuid.uuid4().hex + '.log')
            path.write_bytes(result.stdout + b'\n' + result.stderr)
            path.chmod(0o600)
            raise RuntimeError('Local command failed; private diagnostics retained')
        return result.stdout

    def remote(self, command, **kwargs):
        # Only snapshot/ACL SQL inherited here: no production command or SSH is ever dispatched.
        if not command.startswith('docker exec -i ' + self.db + ' psql '):
            raise AssertionError('Rehearsal rejected a non-local SQL command')
        import shlex
        return self.run(shlex.split(command), **kwargs).decode().strip()

    def inspect(self, image):
        value = json.loads(self.run(['docker', 'image', 'inspect', image]))[0]
        return {'id': value['Id'], 'revision': value['Config'].get('Labels', {}).get('org.opencontainers.image.revision')}

    def env_file(self, name, values):
        path = self.private / name
        with open(path, 'x') as output:
            os.fchmod(output.fileno(), 0o600)
            output.write('\n'.join(key + '=' + value for key, value in values.items()) + '\n')
        return str(path)

    def start(self, name, image, arguments=(), *, env=None, port=None, volumes=(), command=()):
        args = ['docker', 'run', '-d', '--name', name, '--network', self.prefix]
        if env: args += ['--env-file', env]
        if port: args += ['-p', '127.0.0.1::' + str(port)]
        for source, target, mode in volumes: args += ['-v', str(source) + ':' + target + ':' + mode]
        self.run(args + list(arguments) + [image] + list(command))
        self.names.append(name)
        if port:
            binding = json.loads(self.run(['docker', 'inspect', name]))[0]['NetworkSettings']['Ports'][str(port) + '/tcp'][0]
            assert binding['HostIp'] == '127.0.0.1'
            return 'http://127.0.0.1:' + binding['HostPort']

    def remove(self, name):
        self.run(['docker', 'rm', '-f', name])
        self.names.remove(name)

    def http(self, path, *, public=True, method='GET', body=None, token=None):
        url = self.gateway_url if public else self.api_url
        assert url.startswith('http://127.0.0.1:')
        headers = {'Content-Type': 'application/json'}
        if token: headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request(url + path, data=None if body is None else json.dumps(body).encode(),
                                         headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read(1_300_001)
        except urllib.error.HTTPError as error:
            return error.code, error.read(1_300_001)

    def wait_api(self):
        for _ in range(60):
            try:
                value = self.http('/health/ready', public=False)
                if value[0] == 200 and json.loads(value[1]).get('ready') is True:
                    return
            except (OSError, urllib.error.URLError): pass
            time.sleep(0.2)
        raise AssertionError('Local API was not ready')

    def start_api(self, image):
        if self.api in self.names: self.remove(self.api)
        self.api_url = self.start(self.api, image, env=self.app_env, port=3100)
        self.wait_api()

    def gateway_mode(self, closed):
        if self.gateway in self.names: self.remove(self.gateway)
        config = release.maintenance_config() if closed else {
            'admin': {'disabled': True}, 'apps': {'http': {'servers': {'local': {
                'listen': [':8080'], 'routes': [{'handle': [{'handler': 'reverse_proxy',
                    'upstreams': [{'dial': self.api + ':3100'}]}]}],
            }}}}}
        path = self.private / ('closed.json' if closed else 'normal.json')
        path.write_text(json.dumps(config)); path.chmod(0o600)
        self.gateway_url = self.start(self.gateway, release.CADDY, port=8080,
            volumes=[(path, '/etc/caddy/rehearsal.json', 'ro')],
            command=['caddy', 'run', '--config', '/etc/caddy/rehearsal.json'])
        for _ in range(40):
            try:
                if self.http('/health/live')[0] == (503 if closed else 200): return
            except (OSError, urllib.error.URLError): pass
            time.sleep(0.1)
        raise AssertionError('Local gateway did not reach expected state')

    def provision(self, image):
        self.run(['docker', 'run', '--rm', '--network', self.prefix, '--env-file', self.owner_env,
                  image, 'node', 'infra/staging/provision.mjs'], timeout=180)

    def main(self):
        host = json.loads(self.run(['docker', 'context', 'inspect']))[0]['Endpoints']['docker']['Host']
        assert host.startswith('unix://'), 'Only a local Unix Docker socket is allowed'
        old, new = self.inspect(self.args.old_image), self.inspect(self.args.new_image)
        assert old['revision'] == market.TRANSPORT_BASELINE and new['revision'] == self.sha
        assert re.fullmatch('[a-f0-9]{40}', self.sha) and self.sha != old['revision']
        # Values only enter protected files, never argv or public result JSON.
        admin, owner, app, redis_password = (secrets.token_hex(32) for _ in range(4))
        pg_env = self.env_file('pg.env', {'POSTGRES_PASSWORD': admin, 'POSTGRES_DB': market.DB})
        common = {'APP_ENV': 'staging', 'API_PORT': '3100', 'TEST_ORDER_FLOW_ENABLED': 'true',
                  'CATALOG_ADMIN_ENABLED': 'true', 'CUSTOMER_AUTH_ENABLED': 'false',
                  'CLOUD_FULFILLMENT_TRANSPORT_ENABLED': 'false', 'EDGE_FULFILLMENT_ENABLED': 'false',
                  'EDGE_FULFILLMENT_TRANSPORT_ENABLED': 'false', 'REDIS_URL': 'redis://default:' + redis_password + '@redis-cache:6379/0'}
        self.app_env = self.env_file('app.env', {**common, 'CLOUD_DATABASE_URL': f'postgresql://pickchick_app:{app}@cloud-db:5432/{market.DB}'})
        self.owner_env = self.env_file('owner.env', {**common, 'CLOUD_DATABASE_URL': f'postgresql://pickchick_owner:{owner}@cloud-db:5432/{market.DB}',
                                                   'DB_ADMIN_PASSWORD': admin, 'DB_APP_PASSWORD': app})
        self.run(['docker', 'network', 'create', self.prefix])
        self.network_created = True
        self.start(self.db, PG, arguments=['--network-alias', 'cloud-db'], env=pg_env)
        redis_config = self.private / 'redis.conf'
        redis_config.write_text('bind 0.0.0.0\nprotected-mode yes\nsave \"\"\nappendonly no\nrequirepass ' + redis_password + '\n')
        redis_config.chmod(0o644)
        self.start(self.prefix + '-redis', REDIS, arguments=['--network-alias', 'redis-cache'],
                   volumes=[(redis_config, '/etc/redis.conf', 'ro')], command=['redis-server', '/etc/redis.conf'])
        for _ in range(100):
            try:
                self.psql(market.DB, 'SELECT 1')
                break
            except RuntimeError: time.sleep(0.2)
        self.provision(self.args.old_image)
        seed = json.loads(self.run(['docker', 'run', '--rm', '-i', '--network', self.prefix, '--env-file', self.owner_env,
                                   self.args.old_image, 'node', '--input-type=module'], input=SEED))
        branch, token = seed['branch'], seed['manager_token']
        self.start_api(self.args.old_image)
        self.gateway_mode(False)
        caps = json.loads(self.http('/v1/capabilities')[1])
        path = '/v1/admin/catalog/branches/' + branch
        status, body = self.http(path, token=token)
        assert status == 200
        state = json.loads(body)
        assert len(state['draft']['payload']['products']) == 24 and state['published']['version'] == 1
        state['draft']['payload']['products'][0]['description']['ru'] = 'Synthetic manager edit immediately before maintenance'
        save = {'expected_revision': state['draft']['revision'], 'request_id': str(uuid.uuid4()), 'payload': state['draft']['payload']}
        status, saved = self.http(path + '/draft', method='PUT', token=token, body=save)
        assert status == 200
        expected_state = json.loads(saved)
        self.steps.append('real_scoped_CMS_write_before_maintenance')
        # Use the production closed config: no route or spoofed header can reach a write handler.
        self.gateway_mode(True)
        self.run(['docker', 'exec', self.gateway, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8099/'])
        overlay_path = self.private / 'overlay.json'
        overlay_path.write_text(json.dumps(release.maintenance_overlay(str(self.private))))
        overlay_path.chmod(0o600)
        rendered = json.loads(self.run(['docker', 'compose', '-f', str(ROOT / 'infra/public-staging/compose.yaml'),
            '-f', str(overlay_path), 'config', '--format', 'json']))
        gateway = rendered['services']['gateway']
        assert gateway['image'] == release.CADDY and not gateway.get('ports')
        assert gateway['command'] == ['caddy', 'run', '--config', '/etc/caddy/maintenance.json']
        assert gateway['healthcheck']['test'][-1] == 'http://127.0.0.1:8099/'
        assert any(v['target'] == '/etc/caddy/maintenance.json' and v['read_only'] for v in gateway['volumes'])
        assert set(gateway['networks']) == {'front', 'api_ingress'}
        self.steps.append('production_compose_overlay_resolves_with_private_health_and_no_published_port')
        for route, method in [(path + '/draft', 'PUT'), ('/v1/test/orders', 'POST'),
                              ('/v1/auth/otp/request', 'POST'), ('/health/live', 'GET')]:
            assert self.http(route, method=method, token=token, body=save if method == 'PUT' else None)[0] == 503
        self.remove(self.api)
        before, ledger, acl = self.snapshot(), self.ledger(), self.acl()
        ledger_rows = release.TransportRelease.ledger_rows(self)
        assert len(ledger) == 13 and before['tables']['test_orders']['rows'] == 1
        assert before['tables']['catalog_draft_versions']['rows'] >= 3
        self.steps.append('all_routes_503_and_stopped_API_include_latest_CMS_edit')
        # Real pg_dump + age encryption/restore, entirely inside a random local helper container.
        self.start(self.tool, self.args.tool_image, volumes=[(self.private, '/evidence', 'rw')], command=['sleep', 'infinity'])
        self.run(['docker', 'exec', self.tool, 'age-keygen', '-o', '/evidence/identity.agekey'])
        recipient = self.run(['docker', 'exec', self.tool, 'age-keygen', '-y', '/evidence/identity.agekey']).decode().strip()
        dump = self.run(['docker', 'exec', self.db, 'pg_dump', '-U', 'postgres', '-d', market.DB, '--format=custom', '--no-owner', '--no-acl'])
        self.run(['docker', 'exec', '-i', self.tool, 'age', '-r', recipient, '-o', '/evidence/backup.dump.age'], input=dump)
        restored = self.run(['docker', 'exec', self.tool, 'age', '-d', '-i', '/evidence/identity.agekey', '/evidence/backup.dump.age'])
        assert restored == dump
        self.run(['docker', 'exec', self.db, 'createdb', '-U', 'postgres', 'transport_restore'])
        self.run(['docker', 'exec', '-i', self.db, 'pg_restore', '-U', 'postgres', '-d', 'transport_restore', '--exit-on-error', '--no-owner', '--no-acl'], input=restored)
        market.compare_existing(before, self.snapshot('transport_restore'))
        self.run(['docker', 'exec', self.db, 'dropdb', '-U', 'postgres', 'transport_restore'])
        self.steps.append('encrypted_backup_restored_and_all_rows_sequences_match')
        # Actual Linux kernel flock, not an in-memory boolean. Simulated cron cannot enter.
        coordination = self.private / 'coordination'; coordination.mkdir(mode=0o700)
        owner_id = str(uuid.uuid4())
        (coordination / 'owner.json').write_text(json.dumps({'id': owner_id}))
        (coordination / 'owner.json').chmod(0o600)
        coordinator = self.private / 'coordinator.py'
        coordinator.write_bytes((ROOT / 'infra/staging/release-maintenance-lock.py').read_bytes())
        # Docker Desktop host bind mounts may not provide Linux flock semantics.
        # Use native container storage, like the VPS's local Linux filesystem.
        self.run(['docker', 'exec', self.tool, 'mkdir', '-m', '700', '/tmp/coordination'])
        self.run(['docker', 'exec', self.tool, 'cp', '/evidence/coordination/owner.json', '/tmp/coordination/owner.json'])
        args = ['docker', 'exec', self.tool, 'python3', '/evidence/coordinator.py']
        lock_args = ['/tmp/coordination', '/tmp/identity-cleanup.lock', owner_id]
        self.run(args + ['acquire', *lock_args])
        blocked = subprocess.run(['docker', 'exec', self.tool, 'flock', '-n', '/tmp/identity-cleanup.lock', 'true'], capture_output=True)
        assert blocked.returncode == 1
        self.run(args + ['status', *lock_args])
        self.steps.append('Linux_cleanup_flock_held_after_launcher_exit')
        for _ in range(2):
            self.provision(self.args.new_image)
            after = self.snapshot()
            assert self.ledger()[:13] == ledger and len(self.ledger()) == 14
            market.compare_existing(before, after, additions=True, new_tables=market.TRANSPORT_TABLES, new_sequences=())
            assert self.acl() == acl
            assert release.TransportRelease.ledger_rows(self)[:13] == ledger_rows
        self.steps.append('014_twice_six_empty_tables_no_new_sequences_no_extra_grants')
        for image in [self.args.new_image, self.args.old_image, self.args.new_image]:
            self.start_api(image)
            assert self.http('/health/ready', public=False)[0] == 200
            assert json.loads(self.http('/v1/capabilities', public=False)[1]) == caps
            assert json.loads(self.http('/v1/auth/config', public=False)[1])['enabled'] is False
            for action in ['pull', 'ack', 'events']:
                assert self.http('/internal/v1/edge/fulfillment/' + action, public=False, method='POST')[0] == 404
            status, body = self.http(path, public=False, token=token)
            assert status == 200 and json.loads(body) == expected_state
            market.compare_existing(before, self.snapshot(), additions=True, new_tables=market.TRANSPORT_TABLES)
            assert self.acl() == acl
            assert release.TransportRelease.ledger_rows(self)[:13] == ledger_rows
            assert self.http(path, token=token)[0] == 503
        self.steps.append('new_old7cd_new_API_readiness_CMS_TEST_compatibility_behind_503')
        # Exercise the exact rollback ACL program against a deliberately extra column grant.
        self.psql(market.DB, 'GRANT UPDATE (active) ON fulfillment_transport_bindings TO pickchick_app')
        assert self.acl() != acl
        self.psql(market.DB, market.acl_restore_sql(acl, self.acl()))
        assert self.acl() == acl
        market.compare_existing(before, self.snapshot(), additions=True, new_tables=market.TRANSPORT_TABLES)
        self.steps.append('exact_column_ACL_rollback_without_migrate_provision_or_live_restore')
        self.gateway_mode(False)
        state = json.loads(self.http(path, token=token)[1])
        state['draft']['payload']['products'][0]['description']['ru'] = 'Synthetic legitimate edit after reopening'
        status, body = self.http(path + '/draft', method='PUT', token=token, body={
            'expected_revision': state['draft']['revision'], 'request_id': str(uuid.uuid4()), 'payload': state['draft']['payload']})
        assert status == 200
        assert json.loads(body)['draft']['revision'] == state['draft']['revision'] + 1
        # No baseline equality assertion after reopening. Verify valid writes are accepted and retained.
        assert json.loads(self.http(path, token=token)[1]) == json.loads(body)
        self.run(args + ['release', *lock_args])
        self.run(['docker', 'exec', self.tool, 'flock', '-n', '/tmp/identity-cleanup.lock', 'true'])
        self.steps.append('reopened_CMS_write_persists_and_cleanup_resumes')
        assert self.psql(market.DB, 'SELECT count(*) FROM identity_otp_challenges WHERE phone_cipher IS NOT NULL') == '1'
        self.run(['docker', 'run', '--rm', '--network', self.prefix, '--env-file', self.owner_env,
                  self.args.old_image, 'node', 'scripts/customer-identity-maintenance.mjs', 'cleanup'])
        assert self.psql(market.DB, 'SELECT count(*) FROM identity_otp_challenges WHERE phone_cipher IS NOT NULL OR code_hash IS NOT NULL') == '0'
        assert json.loads(self.http(path, token=token)[1]) == json.loads(body)
        self.steps.append('pinned_old7cd_cleanup_executes_real_retention_on_014_without_CMS_loss')
        self.save('result.json', {'scope': 'local_synthetic_Docker_rehearsal', 'old_image': old, 'new_image': new,
                  'tool_image': self.inspect(self.args.tool_image)['id'],
                  'postgres': self.psql(market.DB, 'SHOW server_version'),
                  'age': self.run(['docker', 'exec', self.tool, 'age', '--version']).decode().strip(),
                  'docker': self.run(['docker', 'version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}']).decode().strip(),
                  'steps': self.steps, 'baseline_table_count': len(before['tables']),
                  'cms_draft_rows': before['tables']['catalog_draft_versions']['rows'],
                  'test_order_rows': before['tables']['test_orders']['rows'],
                  'vps_called': False, 'production_data_used': False, 'checks': 'passed',
                  'limits': ['Public normal gateway is a local proxy fixture, not deployment routing acceptance',
                             'SSH command transport, pointer CAS and owner journal covered separately by offline tests',
                             'No real payments, SMS, fiscal or restaurant load acceptance']})

    def cleanup_all(self):
        errors = []
        for name in reversed(self.names[:]):
            try: self.remove(name)
            except Exception: errors.append(name)
        if self.network_created:
            result = subprocess.run(['docker', 'network', 'rm', self.prefix], capture_output=True)
            if result.returncode: errors.append('network')
        self.save('cleanup.json', {'removed_owned_containers': not errors, 'errors': errors})
        market.DB_CONTAINER = self.original_db
        if errors: raise RuntimeError('Owned local rehearsal cleanup incomplete')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old-image', required=True)
    parser.add_argument('--new-image', required=True)
    parser.add_argument('--new-sha', required=True)
    parser.add_argument('--tool-image', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    app = Rehearsal(args)
    try:
        app.main()
    except Exception as error:
        import traceback
        path = app.private / 'exception.log'
        path.write_text(''.join(traceback.format_exception(type(error), error, error.__traceback__)))
        path.chmod(0o600)
        raise
    finally:
        app.cleanup_all()
    print('Local synthetic transport release rehearsal passed; private evidence saved.')


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Local rehearsal stopped. Inspect private diagnostics; no VPS was contacted.')
        raise SystemExit(1) from None
