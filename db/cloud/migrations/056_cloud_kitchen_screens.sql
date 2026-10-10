-- Cloud kitchen screens and cloud-channel orders (ADR-0014, stage S4). Additive only.
-- Screens authenticate the /v1/kitchen/* feed by their own long random key; nothing here reads
-- or writes the device registry (051) or the cashier. Nothing in production uses these tables
-- until a branch is switched to mode 'cloud' and CLOUD_KITCHEN_API_ENABLED is set.

-- A kitchen screen of one branch: prep/assembly screens act on their stations, a display screen
-- only reads the customer display. Only the hash of the current key is stored; a new pairing
-- advances the generation and replaces the hash, so the previous key stops working at once.
CREATE TABLE cloud_kitchen_screens (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 role text NOT NULL CHECK(role IN ('prep','assembly','display')),
 station_ids uuid[] NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 generation integer NOT NULL DEFAULT 0 CHECK(generation >= 0),
 key_hash text UNIQUE CHECK(key_hash ~ '^[a-f0-9]{64}$'),
 key_issued_at timestamptz,
 created_by text NOT NULL CHECK(length(created_by) BETWEEN 1 AND 200),
 created_reason text NOT NULL CHECK(length(created_reason) BETWEEN 3 AND 500),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz,
 revoked_by text CHECK(length(revoked_by) BETWEEN 1 AND 200),
 revoked_reason text CHECK(length(revoked_reason) BETWEEN 3 AND 500),
 last_seen_at timestamptz,
 CHECK((role='display') = (cardinality(station_ids)=0)),
 CHECK(cardinality(station_ids) <= 20),
 CHECK((key_hash IS NULL) = (key_issued_at IS NULL)),
 CHECK((key_hash IS NULL) = (generation = 0)),
 CHECK((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoked_reason IS NULL)),
 UNIQUE(branch_id,id)
);
CREATE INDEX cloud_kitchen_screens_branch_idx ON cloud_kitchen_screens(branch_id,created_at);

CREATE FUNCTION cloud_kitchen_screen_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Kitchen screens cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.generation<>0 OR NEW.key_hash IS NOT NULL OR NEW.revoked_at IS NOT NULL
     OR NEW.last_seen_at IS NOT NULL THEN
   RAISE EXCEPTION 'Kitchen screen starts unpaired' USING ERRCODE='23514';
  END IF;
  -- Every station exists in the branch, is of the screen's kind and is listed once.
  IF (SELECT count(DISTINCT s) FROM unnest(NEW.station_ids) s) <> cardinality(NEW.station_ids)
     OR EXISTS(SELECT 1 FROM unnest(NEW.station_ids) s WHERE NOT EXISTS(
      SELECT 1 FROM cloud_kitchen_stations k WHERE k.branch_id=NEW.branch_id AND k.id=s AND k.kind=NEW.role)) THEN
   RAISE EXCEPTION 'Kitchen screen stations must belong to the branch and match its role' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.branch_id,NEW.role,NEW.station_ids,NEW.name,NEW.created_by,NEW.created_reason,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.branch_id,OLD.role,OLD.station_ids,OLD.name,OLD.created_by,OLD.created_reason,OLD.created_at)
 THEN RAISE EXCEPTION 'Kitchen screen identity is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.revoked_at IS NOT NULL THEN
  RAISE EXCEPTION 'Revoked kitchen screen is final' USING ERRCODE='23514';
 END IF;
 IF NEW.generation<>OLD.generation THEN
  IF NEW.generation<>OLD.generation+1 OR NEW.key_hash IS NOT DISTINCT FROM OLD.key_hash THEN
   RAISE EXCEPTION 'Kitchen screen key changes advance the generation by one' USING ERRCODE='23514';
  END IF;
 ELSIF (NEW.key_hash,NEW.key_issued_at) IS DISTINCT FROM (OLD.key_hash,OLD.key_issued_at) THEN
  RAISE EXCEPTION 'Kitchen screen key changes advance the generation by one' USING ERRCODE='23514';
 END IF;
 IF NEW.last_seen_at < OLD.last_seen_at THEN
  RAISE EXCEPTION 'Kitchen screen heartbeat only moves forward' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_kitchen_screen_guard BEFORE INSERT OR UPDATE OR DELETE ON cloud_kitchen_screens
 FOR EACH ROW EXECUTE FUNCTION cloud_kitchen_screen_guard();

-- One-time pairing codes. The code is shown once to the manager/owner; only a salted hash is
-- stored next to a short public selector. Valid at most 10 minutes, single use, burned after
-- 5 wrong secrets for the same selector. At most one open code per screen.
CREATE TABLE cloud_kitchen_pairing_codes (
 id uuid PRIMARY KEY,
 screen_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 selector text NOT NULL CHECK(selector ~ '^[0-9A-HJKMNP-TV-Z]{4}$'),
 salt text NOT NULL CHECK(salt ~ '^[a-f0-9]{32}$'),
 code_hash text NOT NULL CHECK(code_hash ~ '^[a-f0-9]{64}$'),
 issued_by text NOT NULL CHECK(length(issued_by) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
 used_at timestamptz,
 burned_at timestamptz,
 CHECK(expires_at > issued_at AND expires_at <= issued_at + interval '10 minutes'),
 CHECK(used_at IS NULL OR burned_at IS NULL),
 CHECK(failed_attempts < 5 OR burned_at IS NOT NULL),
 FOREIGN KEY(branch_id,screen_id) REFERENCES cloud_kitchen_screens(branch_id,id)
);
CREATE UNIQUE INDEX cloud_kitchen_pairing_open_selector_idx ON cloud_kitchen_pairing_codes(selector)
 WHERE used_at IS NULL AND burned_at IS NULL;
CREATE UNIQUE INDEX cloud_kitchen_pairing_open_screen_idx ON cloud_kitchen_pairing_codes(screen_id)
 WHERE used_at IS NULL AND burned_at IS NULL;

CREATE FUNCTION cloud_kitchen_pairing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Pairing codes cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.failed_attempts<>0 OR NEW.used_at IS NOT NULL OR NEW.burned_at IS NOT NULL
     OR EXISTS(SELECT 1 FROM cloud_kitchen_screens s WHERE s.id=NEW.screen_id AND s.revoked_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Pairing code starts open for a live screen' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.screen_id,NEW.branch_id,NEW.selector,NEW.salt,NEW.code_hash,NEW.issued_by,NEW.reason,NEW.issued_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.id,OLD.screen_id,OLD.branch_id,OLD.selector,OLD.salt,OLD.code_hash,OLD.issued_by,OLD.reason,OLD.issued_at,OLD.expires_at)
    OR OLD.used_at IS NOT NULL OR OLD.burned_at IS NOT NULL
    OR NEW.failed_attempts NOT IN (OLD.failed_attempts,OLD.failed_attempts+1)
    OR (NEW.used_at IS NOT NULL AND (NEW.used_at > OLD.expires_at OR NEW.failed_attempts<>OLD.failed_attempts))
 THEN RAISE EXCEPTION 'Pairing code is single use' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_kitchen_pairing_guard BEFORE INSERT OR UPDATE OR DELETE ON cloud_kitchen_pairing_codes
 FOR EACH ROW EXECUTE FUNCTION cloud_kitchen_pairing_guard();

-- Append-only lifecycle journal of every screen (back-office manager or owner operator).
CREATE TABLE cloud_kitchen_screen_events (
 id uuid PRIMARY KEY,
 screen_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('created','code_issued','paired','code_burned','revoked')),
 actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 200),
 reason text CHECK(length(reason) BETWEEN 3 AND 500),
 generation integer NOT NULL CHECK(generation >= 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,screen_id) REFERENCES cloud_kitchen_screens(branch_id,id)
);
CREATE INDEX cloud_kitchen_screen_events_idx ON cloud_kitchen_screen_events(branch_id,screen_id,created_at);
CREATE TRIGGER cloud_kitchen_screen_events_immutable BEFORE UPDATE OR DELETE ON cloud_kitchen_screen_events
 FOR EACH ROW EXECUTE FUNCTION cloud_kitchen_immutable();

-- Kiosk/mobile orders created while their branch was in mode 'cloud'. Such an order never asks
-- the cashier for admission; after full trusted capture it is admitted into the cloud kitchen.
-- Owner decision 2026-10-10: no fiscal receipt is issued for these orders yet; they are marked
-- 'deferred_no_receipt' for a later reconciliation, which may only move them to 'reconciled'.
CREATE TABLE cloud_channel_orders (
 order_id uuid PRIMARY KEY REFERENCES commerce_orders(id),
 branch_id uuid NOT NULL REFERENCES branches(id),
 channel text NOT NULL CHECK(channel IN ('kiosk','mobile')),
 mode_epoch bigint NOT NULL CHECK(mode_epoch > 0),
 fiscal_status text NOT NULL DEFAULT 'deferred_no_receipt'
  CHECK(fiscal_status IN ('deferred_no_receipt','reconciled')),
 fiscal_reconciled_at timestamptz,
 fiscal_reconciled_by text CHECK(length(fiscal_reconciled_by) BETWEEN 1 AND 200),
 fiscal_reconciliation_reference text CHECK(length(fiscal_reconciliation_reference) BETWEEN 3 AND 250),
 registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((fiscal_status='reconciled') = (fiscal_reconciled_at IS NOT NULL)
  AND (fiscal_reconciled_at IS NULL) = (fiscal_reconciled_by IS NULL)
  AND (fiscal_reconciled_at IS NULL) = (fiscal_reconciliation_reference IS NULL))
);
CREATE INDEX cloud_channel_orders_branch_idx ON cloud_channel_orders(branch_id,registered_at);
CREATE INDEX cloud_channel_orders_fiscal_idx ON cloud_channel_orders(branch_id,registered_at)
 WHERE fiscal_status='deferred_no_receipt';

CREATE FUNCTION cloud_channel_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cloud channel orders cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.fiscal_status<>'deferred_no_receipt' OR NOT EXISTS(
     SELECT 1 FROM commerce_orders o JOIN branch_channel_modes m ON m.branch_id=o.branch_id
     WHERE o.id=NEW.order_id AND o.branch_id=NEW.branch_id AND o.snapshot->>'channel'=NEW.channel
      AND o.admission_reservation_id IS NULL
      AND m.cloud_channels_owner='cloud' AND m.epoch=NEW.mode_epoch) THEN
   RAISE EXCEPTION 'Cloud channel order needs a kiosk/mobile order of a branch in mode cloud' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.order_id,NEW.branch_id,NEW.channel,NEW.mode_epoch,NEW.registered_at)
    IS DISTINCT FROM (OLD.order_id,OLD.branch_id,OLD.channel,OLD.mode_epoch,OLD.registered_at)
    OR OLD.fiscal_status='reconciled'
 THEN RAISE EXCEPTION 'Cloud channel order is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_channel_order_guard BEFORE INSERT OR UPDATE OR DELETE ON cloud_channel_orders
 FOR EACH ROW EXECUTE FUNCTION cloud_channel_order_guard();

-- Narrow read used by the payment-attempt guard and workers under any role: only whether the
-- order is cloud-owned, never its contents.
CREATE FUNCTION cloud_channel_order_registered(p_order_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM cloud_channel_orders c WHERE c.order_id=p_order_id)
$$;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.cloud_channel_order_registered(uuid) SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
END $$;

-- 046 guard with one addition: an order without an edge reservation may also start payment when
-- it is a cloud channel order. Edge orders and kiosk QR are checked exactly as before, first,
-- so their roles never need the cloud function.
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
    THEN
      IF NOT cloud_channel_order_registered(NEW.order_id) THEN
        RAISE EXCEPTION 'Admission required' USING ERRCODE='23514';
      END IF;
    ELSIF NOT EXISTS(SELECT 1 FROM commerce_orders o JOIN kiosk_sessions s ON s.id=o.principal_id
      JOIN kiosk_devices d ON d.id=s.device_id
      WHERE o.id=NEW.order_id AND s.organization_id=o.organization_id AND s.branch_id=o.branch_id
        AND d.active AND s.ended_at IS NULL AND s.created_at<=o.created_at AND s.expires_at>o.created_at)
    THEN RAISE EXCEPTION 'Original non-ended kiosk guest required' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END; $$;
