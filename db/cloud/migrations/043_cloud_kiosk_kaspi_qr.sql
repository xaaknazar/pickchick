-- Separate guest QR rail: never consumes mobile phone invoice attempts.
CREATE TABLE commerce_kiosk_kaspi_qr (
 attempt_id uuid PRIMARY KEY,
 order_id uuid NOT NULL,
 account_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor%100=0),
 state text NOT NULL CHECK(state IN ('issuing','issued','unknown','paid','failed')),
 state_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 operation_id text CHECK(operation_id ~ '^[1-9][0-9]{0,19}$'),
 qr_payload text CHECK(length(qr_payload) BETWEEN 1 AND 4096),
 issue_started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '180 seconds',
 next_check_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '20 seconds',
 lease_token uuid,
 lease_until timestamptz,
 delivered_at timestamptz,
 FOREIGN KEY(attempt_id,order_id,account_id) REFERENCES commerce_payment_attempts(id,order_id,account_id),
 UNIQUE(account_id,operation_id),
 CHECK(state NOT IN ('issued','paid') OR (operation_id IS NOT NULL AND qr_payload IS NOT NULL)),
 CHECK((operation_id IS NULL)=(qr_payload IS NULL)),
 CHECK(expires_at<=issue_started_at+interval '180 seconds')
);
CREATE INDEX commerce_kiosk_kaspi_qr_due ON commerce_kiosk_kaspi_qr(account_id,next_check_at)
 WHERE state IN ('issuing','issued','unknown') OR delivered_at IS NULL;
CREATE INDEX commerce_kiosk_kaspi_qr_order ON commerce_kiosk_kaspi_qr(order_id);
CREATE FUNCTION commerce_kiosk_qr_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM commerce_payment_attempts a JOIN commerce_orders o ON o.id=a.order_id
  JOIN commerce_provider_accounts p ON p.id=a.account_id
  WHERE a.id=NEW.attempt_id AND a.account_id=NEW.account_id AND a.order_id=NEW.order_id
   AND a.intended_minor=NEW.amount_minor AND p.provider='kaspi-qr' AND p.kind='payment'
   AND o.customer_id IS NULL AND o.snapshot->>'channel'='kiosk') THEN
  RAISE EXCEPTION 'Kiosk QR boundary required' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.attempt_id,NEW.order_id,NEW.account_id,NEW.amount_minor,NEW.issue_started_at)
  IS DISTINCT FROM (OLD.attempt_id,OLD.order_id,OLD.account_id,OLD.amount_minor,OLD.issue_started_at) THEN
  RAISE EXCEPTION 'Immutable kiosk QR intent' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.expires_at>OLD.expires_at OR
  (OLD.operation_id IS NOT NULL AND (NEW.operation_id,NEW.qr_payload) IS DISTINCT FROM (OLD.operation_id,OLD.qr_payload))) THEN
  RAISE EXCEPTION 'Immutable kiosk QR identity/deadline' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_kiosk_qr_guard BEFORE INSERT OR UPDATE ON commerce_kiosk_kaspi_qr
 FOR EACH ROW EXECUTE FUNCTION commerce_kiosk_qr_boundary();
