-- Owner decision 2026-10-08: a registered kiosk may start Kaspi QR before
-- the edge's per-order reservation. Mobile/invoice/POS admission is unchanged.
-- The original durable admission outbox remains; bank capture never invents a
-- reservation or kitchen acceptance. Account, amount and cancellation fences stay.
CREATE OR REPLACE FUNCTION commerce_attempt_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM commerce_orders WHERE id=NEW.order_id FOR UPDATE;
  IF NEW.state<>'pending' OR EXISTS(SELECT 1 FROM commerce_captures WHERE order_id=NEW.order_id) OR NOT EXISTS(
    SELECT 1 FROM commerce_orders o JOIN commerce_provider_accounts a ON a.id=NEW.account_id
    JOIN commerce_payment_intents i ON i.id=NEW.intent_id
    WHERE o.id=NEW.order_id AND NOT o.attention_required
      AND a.branch_id=o.branch_id AND a.organization_id=o.organization_id
      AND a.legal_entity_id::text=o.snapshot->>'legalEntityId' AND a.kind='payment' AND a.enabled
      AND i.order_id=o.id AND NEW.intended_minor=i.intended_minor)
  THEN RAISE EXCEPTION 'Attempt account/scope/amount mismatch' USING ERRCODE='23514'; END IF;
  -- Separate statements preserve the existing restricted mobile/POS role:
  -- an admitted order never reads kiosk identities or needs extra privileges.
  IF NOT EXISTS(SELECT 1 FROM commerce_orders WHERE id=NEW.order_id AND admission_reservation_id IS NOT NULL) THEN
    IF NOT EXISTS(SELECT 1 FROM commerce_orders o JOIN commerce_provider_accounts a ON a.id=NEW.account_id
      WHERE o.id=NEW.order_id AND o.customer_id IS NULL AND o.snapshot->>'channel'='kiosk' AND a.provider='kaspi-qr')
    THEN RAISE EXCEPTION 'Admission required' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM commerce_orders o JOIN kiosk_sessions s ON s.id=o.principal_id
      JOIN kiosk_devices d ON d.id=s.device_id
      WHERE o.id=NEW.order_id AND s.organization_id=o.organization_id AND s.branch_id=o.branch_id
        AND d.active AND s.ended_at IS NULL AND s.expires_at>clock_timestamp())
    THEN RAISE EXCEPTION 'Active kiosk guest required' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END; $$;
