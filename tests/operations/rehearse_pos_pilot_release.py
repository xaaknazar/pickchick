#!/usr/bin/env python3
"""Disposable local Docker rehearsal for exact API93b/schema014 -> full BO/POS018.

No SSH/live data; reuse proven local maintenance/backup machinery, with the new
profile's inert column normalization, explicit ACL changes and BO scope checks.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import uuid
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
base = load('pilot_rehearsal_base', ROOT/'tests/operations/rehearse_transport_release.py')
pilot = load('pilot_profile', ROOT/'infra/staging/release-pos-pilot.py')
market, release, PG, REDIS = base.market, base.release, base.PG, base.REDIS
SEED = "import {provisionDevice} from './packages/menu-sync/dist/index.js';\n" + base.SEED.replace("console.log(JSON.stringify", """const device=randomUUID();await pool.query("INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES($1,$2,$3,'edge','Synthetic old device')",[device,branch,org]);await provisionDevice(pool,device);
 console.log(JSON.stringify""")
BO_GRANT = """import {createPool} from '@pickchick/database';
import {grantBackoffice} from '@pickchick/backoffice-core';
const pool=createPool(process.env.CLOUD_DATABASE_URL);
try {const {rows}=await pool.query('SELECT actor_id FROM catalog_manager_branches WHERE branch_id=$1',['BRANCH_ID']);
 if(rows.length!==1)throw new Error();await grantBackoffice(pool,rows[0].actor_id,'BRANCH_ID','manager');}
finally {await pool.end();}"""


class Rehearsal(base.Rehearsal):
    def start_api(self, image):
        original = self.app_env
        if image == self.args.new_image: self.app_env = self.new_app_env
        try: return super().start_api(image)
        finally: self.app_env = original

    def provision(self, image):
        original = self.owner_env
        if image == self.args.new_image: self.owner_env = self.new_owner_env
        try: return super().provision(image)
        finally: self.owner_env = original

    def snapshot(self, database=market.DB):
        tables = json.loads(self.psql(database,"SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public'"))
        pieces=[]
        for table in tables:
            expression=pilot.snapshot_expression(table)
            pieces.append(f"SELECT '{table}' AS name,count(*) AS rows,encode(sha256(convert_to("
                "coalesce(string_agg(row_hash,'' ORDER BY row_hash),''),'UTF8')),'hex') AS sha256 "
                f"FROM (SELECT encode(sha256(convert_to(({expression})::text,'UTF8')),'hex') row_hash "
                f'FROM public.{market.identifier(table)} t) hashed')
        return json.loads(self.psql(database,"SELECT json_build_object('tables',(SELECT json_object_agg(name,"
            "json_build_object('rows',rows,'sha256',sha256)) FROM ("+' UNION ALL '.join(pieces)+
            ") h),'sequences',(SELECT coalesce(json_agg(row_to_json(s) ORDER BY sequencename),'[]') FROM "
            "(SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value "
            "FROM pg_sequences WHERE schemaname='public') s))"))

    def columns(self):
        return json.loads(self.psql(market.DB,"SELECT json_object_agg(table_name,columns) FROM "
            "(SELECT table_name,json_agg(json_build_object('name',column_name,'type',data_type,"
            "'nullable',is_nullable,'default',column_default) ORDER BY ordinal_position) columns "
            "FROM information_schema.columns WHERE table_schema='public' GROUP BY table_name) c"))

    def verify_columns(self, before):
        after=self.columns()
        assert set(after)-set(before)==pilot.NEW_TABLES
        for table, columns in before.items():
            expected=columns+[{'name':key,'type':'boolean','nullable':'NO','default':'false'}
                for key in pilot.OLD_TABLE_ADDITIONS.get(table,{})]
            assert after[table]==expected, 'Unexpected old column definition change: '+table

    def verify_acl(self):
        # Actual shared API login must never gain device issuance, verifier rewrite,
        # financial effects, owner grants or DDL through the additive receiver.
        forbidden = {'device_credentials':['INSERT','DELETE'], 'devices':['INSERT','DELETE'],
            'pos_order_sync_bindings':['INSERT','DELETE'], 'commerce_captures':['INSERT','UPDATE','DELETE'],
            'commerce_refund_effects':['INSERT','UPDATE','DELETE'], 'commerce_fiscal_effects':['INSERT','UPDATE','DELETE'],
            'catalog_managers':['INSERT','DELETE'], 'bo_access_grants':['INSERT','DELETE']}
        for table, permissions in forbidden.items():
            for permission in permissions:
                assert self.psql(market.DB,f"SELECT has_table_privilege('pickchick_app','{table}','{permission}')")=='f'
        for table, column in [('device_credentials','token_hash'),('pos_order_sync_bindings','active'),
                               ('catalog_managers','token_hash'),('bo_access_grants','role')]:
            assert self.psql(market.DB,f"SELECT has_column_privilege('pickchick_app','{table}','{column}','UPDATE')")=='f'
        for table in ['pos_order_sync_inbox','pos_kitchen_sync_inbox','pos_kitchen_sync_projection']:
            assert self.psql(market.DB,f"SELECT has_table_privilege('pickchick_app','{table}','INSERT')")=='t'
        for table in pilot.OLD_TABLE_ADDITIONS:
            assert self.psql(market.DB,f'SELECT count(*) FROM {table} WHERE pos_sync_lock_anchor IS DISTINCT FROM false')=='0'

    def main(self):
        host = json.loads(self.run(['docker', 'context', 'inspect']))[0]['Endpoints']['docker']['Host']
        assert host.startswith('unix://'), 'Only a local Unix Docker socket is allowed'
        old, new = self.inspect(self.args.old_image), self.inspect(self.args.new_image)
        assert old['revision'] == pilot.BASELINE_API and new['revision'] == self.sha
        cleanup = self.inspect(self.args.cleanup_image)
        assert cleanup['revision'] == market.TRANSPORT_BASELINE
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
        self.new_app_env = self.env_file('new-app.env', {**common, 'BACKOFFICE_ENABLED': 'true',
            'CLOUD_POS_ORDER_SYNC_ENABLED': 'true', 'CLOUD_DATABASE_URL': f'postgresql://pickchick_app:{app}@cloud-db:5432/{market.DB}'})
        self.new_owner_env = self.env_file('new-owner.env', {**common, 'BACKOFFICE_ENABLED': 'true',
            'CLOUD_POS_ORDER_SYNC_ENABLED': 'true', 'CLOUD_DATABASE_URL': f'postgresql://pickchick_owner:{owner}@cloud-db:5432/{market.DB}',
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
        baseline_columns = self.columns()
        ledger_rows = release.TransportRelease.ledger_rows(self)
        assert len(ledger) == 14 and before['tables']['test_orders']['rows'] == 1
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
        new_acl = None
        for _ in range(2):
            self.provision(self.args.new_image)
            after = self.snapshot()
            assert self.ledger()[:14] == ledger and len(self.ledger()) == 18
            market.compare_existing(before, after, additions=True, new_tables=pilot.NEW_TABLES, new_sequences=())
            self.verify_columns(baseline_columns)
            self.verify_acl()
            if new_acl is None: new_acl = self.acl()
            assert self.acl() == new_acl
            assert release.TransportRelease.ledger_rows(self)[:14] == ledger_rows
        self.steps.append('015_018_twice_18_empty_tables_no_new_sequences_reviewed_API_grants')
        original_new_owner = self.new_owner_env
        self.new_owner_env = self.owner_env
        try: self.provision(self.args.new_image)
        finally: self.new_owner_env = original_new_owner
        for table in ['pos_order_sync_inbox','pos_kitchen_sync_inbox','pos_kitchen_sync_projection']:
            assert self.psql(market.DB,f"SELECT has_table_privilege('pickchick_app','{table}','INSERT')")=='f'
        assert self.psql(market.DB,"SELECT has_column_privilege('pickchick_app','devices','pos_sync_lock_anchor','UPDATE')")=='f'
        self.provision(self.args.new_image)
        assert self.acl()==new_acl
        market.compare_existing(before,self.snapshot(),additions=True,new_tables=pilot.NEW_TABLES)
        self.steps.append('disabled_receiver_revokes_write_authority_and_reenable_restores_exact_ACL')
        for image in [self.args.new_image, self.args.old_image, self.args.new_image]:
            self.start_api(image)
            assert self.http('/health/ready', public=False)[0] == 200
            assert json.loads(self.http('/v1/capabilities', public=False)[1]) == caps
            assert json.loads(self.http('/v1/auth/config', public=False)[1])['enabled'] is False
            for action in ['pull', 'ack', 'events']:
                assert self.http('/internal/v1/edge/fulfillment/' + action, public=False, method='POST')[0] == 404
            status, body = self.http(path, public=False, token=token)
            assert status == 200 and json.loads(body) == expected_state
            market.compare_existing(before, self.snapshot(), additions=True, new_tables=pilot.NEW_TABLES)
            self.verify_columns(baseline_columns)
            self.verify_acl()
            if new_acl is None: new_acl = self.acl()
            assert self.acl() == new_acl
            assert release.TransportRelease.ledger_rows(self)[:14] == ledger_rows
            assert self.http(path, token=token)[0] == 503
            expected_sync_status = 400 if image == self.args.new_image else 404
            assert self.http('/internal/v1/edge/pos-orders/events', public=False, method='POST', body={})[0] == expected_sync_status
        self.steps.append('new_old93b_new_API_readiness_CMS_TEST_compatibility_behind_503')
        # Exercise the exact rollback ACL program against a deliberately extra column grant.
        self.psql(market.DB, 'GRANT UPDATE (active) ON fulfillment_transport_bindings TO pickchick_app')
        assert self.acl() != acl
        self.psql(market.DB, market.acl_restore_sql(acl, self.acl()))
        assert self.acl() == acl
        market.compare_existing(before, self.snapshot(), additions=True, new_tables=pilot.NEW_TABLES)
        self.provision(self.args.new_image)
        assert self.acl() == new_acl
        self.verify_acl()
        self.steps.append('exact_column_ACL_rollback_then_reviewed_reapply_without_live_restore')
        self.gateway_mode(False)
        self.run(['docker','run','--rm','-i','--network',self.prefix,'--env-file',self.new_owner_env,
            self.args.new_image,'node','--input-type=module'], input=BO_GRANT.replace('BRANCH_ID',branch))
        assert self.http('/v1/admin/backoffice/branches/'+branch,token=token)[0] == 200
        assert self.http('/v1/admin/backoffice/branches/'+str(uuid.uuid4()),token=token)[0] == 403
        assert self.http('/v1/admin/backoffice/branches/'+branch)[0] == 401
        self.steps.append('explicit_BO_role_after_reopen_scoped_authenticated_read')
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
                  self.args.cleanup_image, 'node', 'scripts/customer-identity-maintenance.mjs', 'cleanup'])
        assert self.psql(market.DB, 'SELECT count(*) FROM identity_otp_challenges WHERE phone_cipher IS NOT NULL OR code_hash IS NOT NULL') == '0'
        assert json.loads(self.http(path, token=token)[1]) == json.loads(body)
        self.steps.append('pinned_old7cd_cleanup_executes_real_retention_on_018_without_CMS_loss')
        self.save('result.json', {'scope': 'local_synthetic_Docker_rehearsal', 'old_image': old, 'new_image': new, 'cleanup_image': cleanup, 'profile': pilot.PROFILE.name,
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old-image', required=True)
    parser.add_argument('--new-image', required=True)
    parser.add_argument('--new-sha', required=True)
    parser.add_argument('--tool-image', required=True)
    parser.add_argument('--cleanup-image', required=True)
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
    print('Local synthetic POS pilot release rehearsal passed; private evidence saved.')


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Local rehearsal stopped. Inspect private diagnostics; no VPS was contacted.')
        raise SystemExit(1) from None
