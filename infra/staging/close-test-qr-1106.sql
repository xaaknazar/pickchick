-- One-time administrative closure of three owner-confirmed unpaid kiosk tests.
-- This is NOT a bank cancellation or a provider observation. No history is deleted.
-- psql inputs: targets (private JSON), backup_sha256 (verified encrypted before-image),
-- owner_confirmed (literal yes), apply (yes or no). Default caller must use no.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
CREATE TEMP TABLE closure_context ON COMMIT DROP AS
 SELECT :'owner_confirmed'::text AS owner_confirmed, :'backup_sha256'::text AS backup_sha256;
CREATE TEMP TABLE closure_targets ON COMMIT DROP AS
 SELECT * FROM jsonb_to_recordset(:'targets'::jsonb)
 AS x(attempt_id uuid,order_id uuid,intent_id uuid,amount_minor bigint,issue_started_at timestamptz);
DO $close$
DECLARE n integer; already integer;
BEGIN
 IF (SELECT owner_confirmed FROM closure_context)<>'yes'
    OR (SELECT backup_sha256 FROM closure_context)!~'^[a-f0-9]{64}$'
    OR (SELECT count(*) FROM closure_targets)<>3
    OR (SELECT count(DISTINCT attempt_id) FROM closure_targets)<>3
    OR (SELECT count(DISTINCT order_id) FROM closure_targets)<>3
    OR (SELECT count(DISTINCT intent_id) FROM closure_targets)<>3
 THEN RAISE EXCEPTION 'STOP: exact targets, owner confirmation and backup required'; END IF;
 IF EXISTS(SELECT 1 FROM closure_targets WHERE
   NOT ((issue_started_at AT TIME ZONE 'Asia/Almaty')::date='2026-10-08' AND amount_minor=10000
     OR (issue_started_at AT TIME ZONE 'Asia/Almaty')::date='2026-10-13' AND amount_minor=151300
     OR (issue_started_at AT TIME ZONE 'Asia/Almaty')::date='2026-10-14' AND amount_minor=10000))
    OR (SELECT count(DISTINCT (issue_started_at AT TIME ZONE 'Asia/Almaty')::date) FROM closure_targets)<>3
 THEN RAISE EXCEPTION 'STOP: owner-approved dates/amounts differ'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('owner-test-qr-close-1106',0));
 PERFORM 1 FROM commerce_orders o JOIN closure_targets t ON t.order_id=o.id ORDER BY o.id FOR UPDATE OF o;
 PERFORM 1 FROM commerce_kiosk_kaspi_qr q JOIN closure_targets t ON t.attempt_id=q.attempt_id ORDER BY q.attempt_id FOR UPDATE OF q;
 PERFORM 1 FROM commerce_payment_attempts a JOIN closure_targets t ON t.attempt_id=a.id ORDER BY a.id FOR UPDATE OF a;
 PERFORM 1 FROM commerce_payment_intents i JOIN closure_targets t ON t.intent_id=i.id ORDER BY i.id FOR UPDATE OF i;
 PERFORM 1 FROM commerce_outbox e JOIN closure_targets t ON t.order_id=e.order_id ORDER BY e.id FOR UPDATE OF e;
 SELECT count(*) INTO already FROM commerce_reconciliation_issues h JOIN closure_targets t ON t.order_id=h.order_id
 WHERE h.issue_key='owner-test-qr-close-1106' AND h.code='OWNER_CONFIRMED_UNPAID_TEST_CLOSED';
 IF already<>0 THEN RAISE EXCEPTION 'STOP: closure already recorded; inspect, do not replay'; END IF;
 SELECT count(*) INTO n FROM closure_targets t
 JOIN commerce_orders o ON o.id=t.order_id
 JOIN commerce_payment_attempts a ON a.id=t.attempt_id AND a.order_id=o.id AND a.intent_id=t.intent_id
 JOIN commerce_payment_intents i ON i.id=t.intent_id AND i.order_id=o.id
 JOIN commerce_kiosk_kaspi_qr q ON q.attempt_id=a.id AND q.order_id=o.id AND q.account_id=a.account_id
 WHERE o.customer_id IS NULL AND o.snapshot->>'channel'='kiosk' AND o.state='awaiting_payment'
 AND q.amount_minor=t.amount_minor AND a.intended_minor=t.amount_minor AND i.intended_minor=t.amount_minor
 AND q.issue_started_at=t.issue_started_at AND q.expires_at<clock_timestamp()-interval '7 days'
 AND a.state='unknown' AND i.state='unknown' AND q.state='unknown'
 AND (q.lease_until IS NULL OR q.lease_until<clock_timestamp())
 AND NOT EXISTS(SELECT 1 FROM commerce_captures c WHERE c.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM commerce_refunds r WHERE r.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM commerce_fiscal_documents f WHERE f.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM commerce_payment_attempts x WHERE x.order_id=o.id AND x.id<>a.id)
 AND NOT EXISTS(SELECT 1 FROM commerce_outbox e WHERE e.order_id=o.id AND e.acknowledged_at IS NULL
   AND (e.event_type<>'payment.reconcile_requested' OR e.payload->>'attemptId' IS DISTINCT FROM a.id::text
      OR e.lease_until>clock_timestamp()));
 IF n<>3 THEN RAISE EXCEPTION 'STOP: target changed, leased, paid, fiscalized or has another effect'; END IF;
 INSERT INTO commerce_reconciliation_issues(id,order_id,issue_key,code,details)
 SELECT gen_random_uuid(),t.order_id,'owner-test-qr-close-1106','OWNER_CONFIRMED_UNPAID_TEST_CLOSED',
 jsonb_build_object('source','owner_instruction_2026-11-06','owner_confirmed_test',true,
 'owner_reported_no_charge',true,'bank_result_verified',false,'bank_cancelled',false,
 'operation','administrative_test_closure','before_state','unknown','after_state','failed',
 'attempt_id',t.attempt_id,'amount_minor',t.amount_minor,'backup_sha256',c.backup_sha256,
 'history_retained',true,'provider_observation_created',false)
 FROM closure_targets t CROSS JOIN closure_context c;
 UPDATE commerce_payment_attempts a SET state='failed' FROM closure_targets t WHERE a.id=t.attempt_id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>3 THEN RAISE EXCEPTION 'STOP: attempt count differs'; END IF;
 UPDATE commerce_payment_intents i SET state='failed' FROM closure_targets t WHERE i.id=t.intent_id;
 UPDATE commerce_kiosk_kaspi_qr q SET state='failed',state_changed_at=clock_timestamp(),
  delivered_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
 FROM closure_targets t WHERE q.attempt_id=t.attempt_id;
 -- These reconciliation requests are handled administratively, not delivered to a bank.
 UPDATE commerce_outbox e SET acknowledged_at=clock_timestamp(),lease_worker=NULL,lease_token=NULL,lease_until=NULL
 FROM closure_targets t WHERE e.order_id=t.order_id AND e.event_type='payment.reconcile_requested'
 AND e.payload->>'attemptId'=t.attempt_id::text AND e.acknowledged_at IS NULL;
 IF (SELECT count(*) FROM commerce_kiosk_kaspi_qr q JOIN closure_targets t ON t.attempt_id=q.attempt_id
     WHERE q.state='failed' AND q.delivered_at IS NOT NULL)<>3
 THEN RAISE EXCEPTION 'STOP: postcondition failed'; END IF;
END $close$;
SELECT json_build_object('closed_test_attempts',3,'history_deleted',false,'bank_cancelled',false,'provider_events_created',0);
\if :apply
COMMIT;
\else
ROLLBACK;
\endif
