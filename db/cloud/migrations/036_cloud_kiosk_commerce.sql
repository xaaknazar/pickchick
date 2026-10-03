-- Kiosk is a device-bound guest, never a phone-number-backed customer account.
ALTER TABLE commerce_quotes DROP CONSTRAINT commerce_quotes_check1;
ALTER TABLE commerce_quotes ADD CONSTRAINT commerce_quotes_amount_channel CHECK (
 (snapshot->>'totalMinor'=total_minor::text AND snapshot->>'currency'=currency
  AND snapshot->>'channel' IN ('mobile','kiosk')) IS TRUE
);
ALTER TABLE commerce_quotes ADD CONSTRAINT commerce_kiosk_published_guest CHECK (
 snapshot->>'channel'<>'kiosk' OR (catalog_version IS NOT NULL AND customer_id IS NULL)
);
CREATE FUNCTION commerce_check_kiosk_guest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.snapshot->>'channel'='kiosk' AND NOT EXISTS (
  SELECT 1 FROM kiosk_sessions s WHERE s.id=NEW.principal_id
  AND s.organization_id=NEW.organization_id AND s.branch_id=NEW.branch_id
 ) THEN RAISE EXCEPTION 'Kiosk session boundary required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_kiosk_quote_guest BEFORE INSERT ON commerce_quotes
 FOR EACH ROW EXECUTE FUNCTION commerce_check_kiosk_guest();
CREATE UNIQUE INDEX commerce_one_order_per_kiosk_session ON commerce_orders(principal_id)
 WHERE snapshot->>'channel'='kiosk';
