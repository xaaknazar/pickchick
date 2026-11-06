"""Local PostgreSQL tests for the scoped administrative test-QR closure."""
import json
import os
from pathlib import Path
import subprocess
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
SQL = (ROOT / 'infra/staging/close-test-qr-1106.sql').read_text()
IDS = [dict(attempt_id=str(uuid.UUID(int=10+i)), order_id=str(uuid.UUID(int=20+i)),
 intent_id=str(uuid.UUID(int=30+i)), amount_minor=amount, issue_started_at=date+'T09:00:00Z')
 for i,(date,amount) in enumerate([('2026-10-08',10000),('2026-10-13',151300),('2026-10-14',10000)])]
FIXTURE = """
CREATE TEMP TABLE commerce_orders(id uuid PRIMARY KEY,customer_id uuid,snapshot jsonb,state text);
CREATE TEMP TABLE commerce_payment_attempts(id uuid PRIMARY KEY,order_id uuid,intent_id uuid,account_id uuid,intended_minor bigint,state text);
CREATE TEMP TABLE commerce_payment_intents(id uuid PRIMARY KEY,order_id uuid,intended_minor bigint,state text);
CREATE TEMP TABLE commerce_kiosk_kaspi_qr(attempt_id uuid PRIMARY KEY,order_id uuid,account_id uuid,amount_minor bigint,issue_started_at timestamptz,expires_at timestamptz,state text,lease_until timestamptz,lease_token uuid,delivered_at timestamptz,state_changed_at timestamptz);
CREATE TEMP TABLE commerce_outbox(id uuid,order_id uuid,event_type text,payload jsonb,acknowledged_at timestamptz,lease_until timestamptz,lease_worker uuid,lease_token uuid);
CREATE TEMP TABLE commerce_captures(order_id uuid);
CREATE TEMP TABLE commerce_refunds(order_id uuid);
CREATE TEMP TABLE commerce_fiscal_documents(order_id uuid);
CREATE TEMP TABLE commerce_reconciliation_issues(id uuid,order_id uuid,issue_key text,code text,details jsonb, UNIQUE(order_id,issue_key));
CREATE TEMP TABLE commerce_provider_inbox(sentinel text);
INSERT INTO commerce_provider_inbox VALUES('unchanged');
CREATE FUNCTION pg_temp.no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'No history deletion'; END $$;
CREATE TRIGGER no_delete BEFORE DELETE ON commerce_payment_attempts FOR EACH ROW EXECUTE FUNCTION pg_temp.no_delete();
"""
for row in IDS:
    a,o,i,amount,stamp=[row[k] for k in ['attempt_id','order_id','intent_id','amount_minor','issue_started_at']]
    account=str(uuid.UUID(int=100))
    FIXTURE += f"""
INSERT INTO commerce_orders VALUES('{o}',NULL,'{{"channel":"kiosk"}}','awaiting_payment');
INSERT INTO commerce_payment_attempts VALUES('{a}','{o}','{i}','{account}',{amount},'unknown');
INSERT INTO commerce_payment_intents VALUES('{i}','{o}',{amount},'unknown');
INSERT INTO commerce_kiosk_kaspi_qr VALUES('{a}','{o}','{account}',{amount},'{stamp}','{stamp}'::timestamptz+interval '180 seconds','unknown',NULL,NULL,NULL,'{stamp}');
INSERT INTO commerce_outbox VALUES(gen_random_uuid(),'{o}','payment.reconcile_requested','{{"attemptId":"{a}"}}',NULL,NULL,NULL,NULL);
"""
AFTER = """SELECT json_build_object(
 'attempts',(SELECT json_agg(state ORDER BY id) FROM commerce_payment_attempts),
 'intents',(SELECT json_agg(state ORDER BY id) FROM commerce_payment_intents),
 'qr',(SELECT json_agg(state ORDER BY attempt_id) FROM commerce_kiosk_kaspi_qr),
 'orders',(SELECT json_agg(state ORDER BY id) FROM commerce_orders),
 'audits',(SELECT count(*) FROM commerce_reconciliation_issues),
 'acknowledged',(SELECT count(*) FROM commerce_outbox WHERE acknowledged_at IS NOT NULL),
 'captures',(SELECT count(*) FROM commerce_captures),
 'provider_inbox',(SELECT json_agg(sentinel) FROM commerce_provider_inbox));"""
def run(extra='', apply='yes', owner='yes', targets=None, backup='a'*64):
    command=['docker','exec','-i',os.environ['CLOSURE_TEST_DB_CONTAINER'],'sh','-c',
      'exec psql -XqAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" --set=targets="$1" --set=backup_sha256="$2" --set=owner_confirmed="$3" --set=apply="$4"',
      'psql',json.dumps(IDS if targets is None else targets),backup,owner,apply]
    return subprocess.run(command,input=FIXTURE+extra+SQL+AFTER,text=True,capture_output=True,timeout=15)

@unittest.skipUnless(os.environ.get('CLOSURE_TEST_DB_CONTAINER'), 'Requires explicit disposable PostgreSQL container')
class Closure(unittest.TestCase):
    def test_dry_run_rolls_back_all_changes(self):
        p=run(apply='no');self.assertEqual(p.returncode,0,p.stderr)
        result=json.loads(p.stdout.splitlines()[-1])
        self.assertEqual(result['attempts'],['unknown']*3)
        self.assertEqual(result['qr'],['unknown']*3)
        self.assertEqual(result['audits'],0);self.assertEqual(result['acknowledged'],0)

    def test_apply_records_manual_source_without_bank_event_or_delete(self):
        p=run();self.assertEqual(p.returncode,0,p.stderr)
        result=json.loads(p.stdout.splitlines()[-1])
        for key in ['attempts','intents','qr']:self.assertEqual(result[key],['failed']*3)
        self.assertEqual(result['orders'],['awaiting_payment']*3)
        self.assertEqual(result['audits'],3);self.assertEqual(result['acknowledged'],3)
        self.assertEqual(result['captures'],0);self.assertEqual(result['provider_inbox'],['unchanged'])

    def test_capture_refund_fiscal_new_effect_lease_and_retry_refused(self):
        target=IDS[0]['order_id']
        cases=[
          f"INSERT INTO {table} VALUES('{target}');" for table in
          ['commerce_captures','commerce_refunds','commerce_fiscal_documents']
        ] + [
          "UPDATE commerce_kiosk_kaspi_qr SET lease_until=clock_timestamp()+interval '1 minute';",
          "UPDATE commerce_outbox SET event_type='payment.submit_requested';",
          "UPDATE commerce_payment_attempts SET state='succeeded';",
          "UPDATE commerce_payment_intents SET intended_minor=intended_minor+100;",
          "UPDATE commerce_orders SET snapshot='{\"channel\":\"mobile\"}';",
          "UPDATE commerce_kiosk_kaspi_qr SET expires_at=clock_timestamp()+interval '1 minute';",
          f"INSERT INTO commerce_reconciliation_issues VALUES(gen_random_uuid(),'{target}','owner-test-qr-close-1106','OWNER_CONFIRMED_UNPAID_TEST_CLOSED','{{}}');",
        ]
        for extra in cases:
            with self.subTest(extra=extra):
                p=run(extra);self.assertNotEqual(p.returncode,0);self.assertIn('STOP:',p.stderr)

    def test_wrong_scope_owner_or_backup_refused(self):
        wrong=[dict(r) for r in IDS];wrong[0]['amount_minor']=20000
        for kw in [dict(owner='no'),dict(backup=''),dict(targets=IDS[:2]),dict(targets=wrong),dict(targets=[IDS[0]]*3)]:
            with self.subTest(kw=kw):
                p=run(**kw);self.assertNotEqual(p.returncode,0);self.assertIn('STOP:',p.stderr)

if __name__=='__main__':unittest.main()
