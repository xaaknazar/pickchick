"""API-only release guards. Synthetic fixtures; no SSH, bank calls or live mutation."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from urllib.parse import urlparse
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('live_menu_release_test', ROOT/'infra/staging/release-live-menu.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)
SHA, PUBLIC = 'a'*40, 'b'*40
IMAGE = 'sha256:'+'c'*64
COMPOSE = '''services:
  api:
    image: pickchick-api:${RELEASE_SHA}
    environment:
      APP_ENV: staging
      CLOUD_DATABASE_URL: postgresql://synthetic
      KIOSK_CHECKOUT_ENABLED: "true"
  provision:
    environment:
      APP_ENV: staging
      KIOSK_CHECKOUT_ENABLED: "true"
'''


def args(**overrides):
    values = dict(sha=SHA, branch='codex/mobile-live-menu', action='prepare', apply=False, owner_id=None,
        expected_api_sha=r.BASELINE, expected_public_sha=PUBLIC, expected_api_image=IMAGE,
        expected_compose_sha256=r.digest(COMPOSE.encode()), expected_gateway_sha256='d'*64,
        ssh_key=Path('/nonexistent'), ci_run='1', ci_proof=None, backup_identity=None)
    return SimpleNamespace(**{**values, **overrides})


class Guards(unittest.TestCase):
    def test_exact_cf25_and_reviewed_pins(self):
        r.check_pins(args())
        for field, value in [('expected_api_sha','e'*40), ('expected_public_sha','main'),
            ('expected_api_image','pickchick-api:latest'), ('expected_compose_sha256','d'*63),
            ('expected_gateway_sha256',''), ('expected_gateway_sha256','d'*64+'\n')]:
            with self.assertRaises(r.GuardFailure, msg=field):
                r.check_pins(args(**{field:value}))

    def test_only_api_flag_added_and_roundtrip(self):
        candidate = r.compose_candidate(COMPOSE,r.digest(COMPOSE.encode()))
        self.assertEqual(candidate.replace('      '+r.FLAG+': "false"\n',''),COMPOSE)
        self.assertNotIn(r.FLAG,candidate.split('  provision:\n')[1])
        enabled = r.compose_flag(candidate,True)
        self.assertEqual(r.compose_flag(enabled,False),candidate)
        self.assertIn('KIOSK_CHECKOUT_ENABLED: "true"',enabled)
        for text in [COMPOSE,candidate+candidate,enabled]:
            with self.assertRaises(r.GuardFailure):r.compose_flag(text,True)
        with self.assertRaises(r.GuardFailure):r.compose_candidate(COMPOSE,'0'*64)
        with self.assertRaises(r.GuardFailure):r.compose_candidate(candidate,r.digest(candidate.encode()))
        bad=COMPOSE.replace('      APP_ENV: staging','      APP_ENV: other')
        with self.assertRaises(r.GuardFailure):r.compose_candidate(bad,r.digest(bad.encode()))

    def test_generated_release_env_keeps_actual_newlines_and_policy(self):
        profile=r.market.ReleaseProfile('test',r.BASELINE,PUBLIC,49,(),frozenset(),frozenset(),'test',())
        with tempfile.TemporaryDirectory() as tmp:
            old,new=Path(tmp)/'old',Path(tmp)/'new'
            old.write_text('RELEASE_SHA='+r.BASELINE+'\nKIOSK_CHECKOUT_ENABLED=true\n')
            subprocess.run([sys.executable,'-c',r.market.release_env_script(profile),str(old),str(new),SHA,r.BASELINE],check=True)
            self.assertEqual(new.read_text().splitlines(),['KIOSK_CHECKOUT_ENABLED=true','RELEASE_SHA='+SHA])
            self.assertEqual(new.stat().st_mode & 0o777,0o600)

    def test_schema050_exact_and_no_new_migration(self):
        obj=r.Release.__new__(r.Release)
        names=[p.name for p in sorted((ROOT/'db/cloud/migrations').glob('*.sql')) if int(p.name[:3]) <= 50]
        obj.git=Mock(return_value='\n'.join('db/cloud/migrations/'+n for n in names))
        self.assertEqual(len(obj.baseline_migrations()),49)
        obj.git.return_value+='\ndb/cloud/migrations/051_unreviewed.sql'
        with self.assertRaises(r.GuardFailure):obj.baseline_migrations()

    def test_real_runtime_acl_is_readonly_and_requires_release_and_head_locks(self):
        sql=r.acl_sql()
        self.assertIn("'catalog_branch_heads','lock_anchor','UPDATE'",sql)
        self.assertIn("'fulfillment_transport_bindings','lock_anchor','UPDATE'",sql)
        self.assertIn("'commerce_cancellation_intents','INSERT'",sql)
        for column in ['release_event_id','expected_edge_version','reservation_id','state','resolution_code','updated_at']:
            self.assertIn("'commerce_cancellation_intents','"+column+"','UPDATE'",sql)
        self.assertIn("'commerce_outbox','INSERT'",sql)
        self.assertIn("'commerce_outbox_sequence_seq','USAGE'",sql)
        self.assertIn("NOT has_table_privilege(current_user,'commerce_captures','INSERT')",sql)
        self.assertIn('BEGIN READ ONLY',r.acl_program())
        self.assertNotIn('SET ROLE',r.acl_program())
        obj=r.Release.__new__(r.Release);obj.role_restricted=Mock();obj.remote=Mock();obj.save=Mock()
        obj.remote.return_value=json.dumps({'role':'pickchick_app','missing':[]})
        self.assertEqual(obj.runtime_acl()['missing'],[])
        for value in [{'role':'postgres','missing':[]},{'role':'pickchick_app','missing':['commerce_outbox:INSERT']}]:
            obj.remote.return_value=json.dumps(value)
            with self.assertRaises(r.GuardFailure):obj.runtime_acl()

    def test_every_bank_worker_and_gateway_fingerprint_preserved(self):
        obj=r.Release.__new__(r.Release)
        containers={name:f'id-{index} {IMAGE} 2026-10-09T11:00:00Z running 0' for index,name in enumerate(r.BANKS)}
        obj.fingerprint=Mock(side_effect=lambda:{'containers':copy.deepcopy(containers)})
        obj.remote=Mock(return_value='gateway '+IMAGE+' timestamp running 0')
        self.assertIn(r.market.GATEWAY,obj.neighbors()['containers'])
        for name in r.BANKS:
            old=containers.pop(name)
            with self.assertRaises(r.GuardFailure):obj.neighbors()
            containers[name]=old.replace(' running ',' exited ')
            with self.assertRaises(r.GuardFailure):obj.neighbors()
            containers[name]=old

    def test_default_prepare_performs_no_remote_mutation(self):
        obj=r.Release.__new__(r.Release);obj.args=args();obj.source_checks=Mock();obj.ci=Mock()
        obj.baseline=Mock(return_value={});obj.remote=Mock()
        with contextlib.redirect_stdout(io.StringIO()) as output:obj.run()
        obj.source_checks.assert_called_once();obj.ci.assert_called_once();obj.remote.assert_not_called()
        self.assertFalse(json.loads(output.getvalue())['applied'])

    def test_apply_backup_restore_before_api_switch_and_no_provision(self):
        with tempfile.TemporaryDirectory() as tmp:
            key=Path(tmp)/'identity';key.write_text('synthetic');key.chmod(0o600)
            obj=r.Release.__new__(r.Release);obj.args=args(action='apply',apply=True,backup_identity=key);obj.sha=SHA
            before={'candidate':r.compose_candidate(COMPOSE,r.digest(COMPOSE.encode()))}
            proof={'sha':SHA,'baseline':r.BASELINE,'before':before,'artifacts':{'image':IMAGE}}
            obj.prepared=Mock(return_value=proof);obj.baseline=Mock(return_value=before);obj.artifacts=Mock(return_value=proof['artifacts'])
            calls=[]
            obj.snapshot=Mock(return_value={'tables':{},'sequences':[]})
            obj.save=Mock(side_effect=lambda name,value:calls.append(('save',name)))
            obj.backup_restore=Mock(side_effect=lambda:calls.append(('backup',None)) or {'restore':'passed'})
            obj.remote=Mock(side_effect=lambda command,**kwargs:calls.append(('remote',command)))
            obj.ready=Mock();obj.api_image=Mock(return_value=IMAGE);obj.switch=Mock();obj.current=Mock()
            obj.apply()
            remote=[c for kind,c in calls if kind=='remote']
            self.assertEqual(len(remote),1)
            self.assertIn('--no-deps --wait --wait-timeout 120 api',remote[0])
            self.assertLess(calls.index(('backup',None)),next(i for i,v in enumerate(calls) if v[0]=='remote'))
            self.assertFalse(any('provision' in c or 'gateway' in c or 'worker' in c for c in remote))
            obj.current.assert_called_once_with(proof,False)
            obj.backup_restore=Mock(side_effect=r.GuardFailure('restore failed'));obj.remote.reset_mock()
            with self.assertRaises(r.GuardFailure):obj.apply()
            obj.remote.assert_not_called()

    def test_enable_refuses_without_completed_off_deploy(self):
        with tempfile.TemporaryDirectory() as tmp:
            obj=r.Release.__new__(r.Release);obj.private=Path(tmp);obj.sha=SHA;obj.args=args(action='enable',apply=True)
            obj.prepared=Mock(return_value={});obj.current=Mock();obj.remote=Mock()
            with self.assertRaisesRegex(r.GuardFailure,'Completed API-off'):obj.switch_flag(True)
            obj.remote.assert_not_called()

    def test_owned_recovery_cannot_take_foreign_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            owner='11111111-1111-4111-8111-111111111111'
            obj=r.Release.__new__(r.Release);obj.private=Path(tmp);obj.sha=SHA;obj.args=args(action='rollback',apply=True,owner_id=owner)
            expected={'id':owner,'sha':SHA,'action':'apply'}
            (obj.private/('lock-owner-'+owner+'.json')).write_text(json.dumps(expected))
            obj.remote=Mock(return_value=json.dumps({**expected,'sha':'f'*40}))
            with self.assertRaisesRegex(r.GuardFailure,'Foreign live'):
                with obj.owned_lock():self.fail('Entered foreign lock')
            self.assertEqual(obj.remote.call_count,1)

    def test_owner_recovery_failure_keeps_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            owner='11111111-1111-4111-8111-111111111111'
            obj=r.Release.__new__(r.Release);obj.private=Path(tmp);obj.sha=SHA;obj.args=args(action='rollback',apply=True,owner_id=owner)
            expected={'id':owner,'sha':SHA,'action':'apply'}
            (obj.private/('lock-owner-'+owner+'.json')).write_text(json.dumps(expected))
            obj.remote=Mock(return_value=json.dumps(expected))
            with self.assertRaisesRegex(r.GuardFailure,'blocked'):
                with obj.owned_lock():raise r.GuardFailure('blocked')
            self.assertEqual(obj.remote.call_count,1)


@unittest.skipUnless(os.environ.get('LIVE_MENU_TEST_DATABASE_URL'), 'Set explicit local PostgreSQL fixture URL')
class PostgresACL(unittest.TestCase):
    def test_restricted_runtime_role_and_each_cancellation_grant(self):
        url=os.environ['LIVE_MENU_TEST_DATABASE_URL'];parsed=urlparse(url)
        self.assertIn(parsed.hostname,['127.0.0.1','localhost'])
        self.assertEqual(parsed.path,'/pickchick_cloud')
        suffix=uuid.uuid4().hex
        schema,role='live_menu_acl_'+suffix,'live_menu_role_'+suffix
        columns='id integer,lock_anchor integer,total_minor bigint,state text,resolution_code text,updated_at text,release_event_id text,expected_edge_version text,reservation_id text'
        statements=['BEGIN',f'CREATE SCHEMA {schema}',f'CREATE ROLE {role} NOLOGIN',
                    f'GRANT USAGE ON SCHEMA {schema} TO {role}',f'SET LOCAL search_path TO {schema}']
        statements += [f'CREATE TABLE {table}({columns})' for table in r.SELECT_TABLES]
        statements += ['CREATE SEQUENCE commerce_outbox_sequence_seq']
        statements += [f'GRANT SELECT ON {table} TO {role}' for table in r.SELECT_TABLES]
        statements += [f'GRANT INSERT ON {table} TO {role}' for table in r.INSERT_TABLES]
        statements += [f'GRANT UPDATE({",".join(columns)}) ON {table} TO {role}' for table,columns in r.UPDATE_COLUMNS.items()]
        statements += [f'GRANT USAGE ON SEQUENCE commerce_outbox_sequence_seq TO {role}',f'SET LOCAL ROLE {role}',
                       'SELECT row_to_json(t) FROM ('+r.acl_sql()+') t']
        missing=[]
        for table,column in [('catalog_branch_heads','lock_anchor'),('commerce_cancellation_intents','release_event_id'),
                             ('commerce_cancellation_intents','state')]:
            statements += ['RESET ROLE',f'REVOKE UPDATE({column}) ON {table} FROM {role}',f'SET LOCAL ROLE {role}',
                           'SELECT row_to_json(t) FROM ('+r.acl_sql()+') t']
            missing.append(table+'.'+column+':UPDATE')
        statements += ['RESET ROLE',f'REVOKE INSERT ON commerce_cancellation_intents FROM {role}',f'SET LOCAL ROLE {role}',
                       'SELECT row_to_json(t) FROM ('+r.acl_sql()+') t',
                       'RESET ROLE',f'REVOKE INSERT ON commerce_outbox FROM {role}',f'SET LOCAL ROLE {role}',
                       'SELECT row_to_json(t) FROM ('+r.acl_sql()+') t',
                       'RESET ROLE',f'REVOKE USAGE ON SEQUENCE commerce_outbox_sequence_seq FROM {role}',f'SET LOCAL ROLE {role}',
                       'SELECT row_to_json(t) FROM ('+r.acl_sql()+') t',
                       'RESET ROLE',f'GRANT INSERT ON commerce_captures TO {role}',f'SET LOCAL ROLE {role}',
                       'SELECT row_to_json(t) FROM ('+r.acl_sql()+') t',
                       'RESET ROLE',f'GRANT UPDATE(total_minor) ON commerce_orders TO {role}',f'SET LOCAL ROLE {role}',
                       'SELECT row_to_json(t) FROM ('+r.acl_sql()+') t','ROLLBACK']
        missing += ['commerce_cancellation_intents:INSERT','commerce_outbox:INSERT','commerce_outbox_sequence_seq:USAGE',
                    'no_capture_insert','no_order_price_update']
        result=subprocess.run(['psql',url,'-X','-A','-t','-q','-v','ON_ERROR_STOP=1'],input=';\n'.join(statements)+';\n',
                              text=True,capture_output=True,check=True)
        rows=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
        self.assertEqual(rows[0],{'role':role,'missing':[]})
        self.assertEqual(len(rows),len(missing)+1)
        for index,name in enumerate(missing,1):self.assertIn(name,rows[index]['missing'])


if __name__=='__main__':unittest.main()
