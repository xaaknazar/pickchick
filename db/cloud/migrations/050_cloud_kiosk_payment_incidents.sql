-- A responsible manager hands an unresolved kiosk QR payment to staff so the device may start
-- a new guest. Nothing here changes the attempt, the QR row or the order: the payment stays on
-- reconciliation and a late bank result still attaches only to the original order.
CREATE TABLE commerce_kiosk_payment_incidents (
 attempt_id uuid PRIMARY KEY REFERENCES commerce_kiosk_kaspi_qr(attempt_id),
 order_id uuid NOT NULL UNIQUE,
 account_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 session_id uuid NOT NULL REFERENCES kiosk_sessions(id),
 accepted_by uuid NOT NULL,
 request_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('bank_identity_lost','bank_result_unknown')),
 note text NOT NULL CHECK(length(note) BETWEEN 3 AND 500),
 observed jsonb NOT NULL CHECK(jsonb_typeof(observed)='object'),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(attempt_id,order_id,account_id) REFERENCES commerce_payment_attempts(id,order_id,account_id),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
 FOREIGN KEY(accepted_by,organization_id) REFERENCES catalog_managers(id,organization_id),
 UNIQUE(accepted_by,request_id)
);
CREATE FUNCTION commerce_kiosk_payment_incident_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM commerce_payment_attempts a
  JOIN commerce_orders o ON o.id=a.order_id
  JOIN commerce_provider_accounts p ON p.id=a.account_id
  JOIN commerce_kiosk_kaspi_qr q ON q.attempt_id=a.id
  WHERE a.id=NEW.attempt_id AND a.order_id=NEW.order_id AND a.account_id=NEW.account_id
   AND a.state IN ('pending','unknown') AND p.provider='kaspi-qr' AND p.kind='payment'
   AND q.state IN ('issuing','unknown') AND q.issue_started_at<=clock_timestamp()-interval '15 minutes'
   AND o.customer_id IS NULL AND o.snapshot->>'channel'='kiosk'
   AND o.principal_id=NEW.session_id AND o.organization_id=NEW.organization_id AND o.branch_id=NEW.branch_id
   AND NOT EXISTS(SELECT 1 FROM commerce_captures c WHERE c.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM commerce_refunds r WHERE r.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM commerce_payment_attempts x WHERE x.order_id=o.id AND x.id<>a.id AND x.state IN ('pending','unknown'))
   AND NOT EXISTS(SELECT 1 FROM commerce_kaspi_invoices i WHERE i.order_id=o.id AND i.state IN ('issuing','issued','unknown'))) THEN
  RAISE EXCEPTION 'Kiosk payment incident boundary required' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_kiosk_payment_incident_guard BEFORE INSERT ON commerce_kiosk_payment_incidents
 FOR EACH ROW EXECUTE FUNCTION commerce_kiosk_payment_incident_boundary();
CREATE TRIGGER commerce_kiosk_payment_incidents_immutable BEFORE UPDATE OR DELETE ON commerce_kiosk_payment_incidents
 FOR EACH ROW EXECUTE FUNCTION catalog_reject_mutation();
