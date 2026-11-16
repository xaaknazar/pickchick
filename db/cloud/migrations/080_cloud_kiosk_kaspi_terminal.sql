-- ADR-0018 (owner request 16.11.2026): an iPad kiosk paid on its own Kaspi Smart POS terminal.
-- The iPad drives the terminal over the LAN itself; the cloud only keeps which terminal is linked
-- to which kiosk device and receives the kiosk-key-attested outcome of each payment attempt.
-- Provider 'kaspi-pos' (method kaspi_terminal) is a separate rail from 'kaspi-qr'.
-- Additive: three new tables and the attempt guard below accepting 'kaspi-pos' next to 'kaspi-qr'.
-- Runtime access: infra/staging/kiosk-terminal-grants.mjs behind KIOSK_KASPI_TERMINAL_ENABLED.
-- The terminal tokens never reach the cloud.

-- Link of a kiosk device to a terminal. One active link per kiosk, one active kiosk per terminal.
-- A link is never deleted: unlinking stamps unlinked_at, a new terminal is a new row.
CREATE TABLE kiosk_terminal_links (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 device_id uuid NOT NULL,
 terminal_id text COLLATE "C" NOT NULL CHECK(terminal_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
 serial text COLLATE "C" NOT NULL CHECK(serial ~ '^[A-Za-z0-9._:-]{1,64}$'),
 host inet NOT NULL CHECK(family(host)=4 AND masklen(host)=32 AND
  (host<<'10.0.0.0/8'::inet OR host<<'172.16.0.0/12'::inet OR host<<'192.168.0.0/16'::inet)),
 linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 unlinked_at timestamptz,
 UNIQUE(id,device_id),
 FOREIGN KEY(device_id,organization_id,branch_id) REFERENCES kiosk_devices(id,organization_id,branch_id),
 CHECK(unlinked_at IS NULL OR unlinked_at>=linked_at)
);
CREATE UNIQUE INDEX kiosk_terminal_links_device_active ON kiosk_terminal_links(device_id)
 WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX kiosk_terminal_links_terminal_active ON kiosk_terminal_links(terminal_id)
 WHERE unlinked_at IS NULL;
CREATE FUNCTION kiosk_terminal_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Kiosk terminal links are never deleted' USING ERRCODE='23514'; END IF;
 IF (NEW.id,NEW.organization_id,NEW.branch_id,NEW.device_id,NEW.terminal_id,NEW.linked_at)
  IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id,OLD.device_id,OLD.terminal_id,OLD.linked_at)
  OR OLD.unlinked_at IS NOT NULL THEN
  RAISE EXCEPTION 'Immutable kiosk terminal link' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER kiosk_terminal_link_guard BEFORE UPDATE OR DELETE ON kiosk_terminal_links
 FOR EACH ROW EXECUTE FUNCTION kiosk_terminal_link_guard();

-- One kiosk terminal payment attempt per commerce payment attempt of provider 'kaspi-pos'.
-- amount is whole tenge (minor % 100 = 0). terminal_id is the linked terminal at creation.
-- state: pending (no result yet), paid, failed, unknown (needs reconciliation, never kitchen).
CREATE TABLE commerce_kiosk_terminal_attempts (
 attempt_id uuid PRIMARY KEY,
 order_id uuid NOT NULL,
 account_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 device_id uuid NOT NULL,
 session_id uuid NOT NULL REFERENCES kiosk_sessions(id),
 link_id uuid NOT NULL,
 terminal_id text COLLATE "C" NOT NULL CHECK(terminal_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
 request_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor%100=0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','paid','failed','unknown')),
 process_id text COLLATE "C" CHECK(process_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
 transaction_id text COLLATE "C" CHECK(transaction_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
 incident text CHECK(incident IN ('result_unknown','result_overdue','result_mismatch')),
 -- One timestamp for both defaults: two clock_timestamp() calls could differ and break the 15-minute CHECK.
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '15 minutes',
 resolved_at timestamptz,
 UNIQUE(order_id,request_id),
 FOREIGN KEY(attempt_id,order_id,account_id) REFERENCES commerce_payment_attempts(id,order_id,account_id),
 FOREIGN KEY(link_id,device_id) REFERENCES kiosk_terminal_links(id,device_id),
 FOREIGN KEY(device_id,organization_id,branch_id) REFERENCES kiosk_devices(id,organization_id,branch_id),
 CHECK(expires_at<=created_at+interval '15 minutes'),
 CHECK((state='pending')=(resolved_at IS NULL)),
 CHECK(state<>'paid' OR transaction_id IS NOT NULL),
 -- An overdue attempt keeps its incident even when a late result settles it.
 CHECK(state<>'unknown' OR incident IS NOT NULL)
);
CREATE INDEX commerce_kiosk_terminal_attempts_order ON commerce_kiosk_terminal_attempts(order_id,created_at);
CREATE INDEX commerce_kiosk_terminal_attempts_due ON commerce_kiosk_terminal_attempts(branch_id,expires_at)
 WHERE state='pending';
CREATE FUNCTION commerce_kiosk_terminal_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Kiosk terminal attempts are never deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'pending' OR NOT EXISTS(SELECT 1 FROM commerce_payment_attempts a
   JOIN commerce_orders o ON o.id=a.order_id
   JOIN commerce_provider_accounts p ON p.id=a.account_id
   JOIN kiosk_sessions s ON s.id=o.principal_id
   JOIN kiosk_terminal_links l ON l.id=NEW.link_id
   WHERE a.id=NEW.attempt_id AND a.order_id=NEW.order_id AND a.account_id=NEW.account_id
    AND a.intended_minor=NEW.amount_minor AND a.state='pending'
    AND p.provider='kaspi-pos' AND p.kind='payment'
    AND o.customer_id IS NULL AND o.snapshot->>'channel'='kiosk'
    AND o.organization_id=NEW.organization_id AND o.branch_id=NEW.branch_id
    AND s.id=NEW.session_id AND s.device_id=NEW.device_id
    AND l.device_id=NEW.device_id AND l.terminal_id=NEW.terminal_id AND l.unlinked_at IS NULL) THEN
   RAISE EXCEPTION 'Kiosk terminal attempt boundary required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.attempt_id,NEW.order_id,NEW.account_id,NEW.organization_id,NEW.branch_id,NEW.device_id,
     NEW.session_id,NEW.link_id,NEW.terminal_id,NEW.request_id,NEW.amount_minor,NEW.created_at,NEW.expires_at)
  IS DISTINCT FROM (OLD.attempt_id,OLD.order_id,OLD.account_id,OLD.organization_id,OLD.branch_id,OLD.device_id,
     OLD.session_id,OLD.link_id,OLD.terminal_id,OLD.request_id,OLD.amount_minor,OLD.created_at,OLD.expires_at) THEN
  RAISE EXCEPTION 'Immutable kiosk terminal attempt' USING ERRCODE='23514';
 END IF;
 -- A result is final; an identity once recorded never changes. An overdue pending attempt may
 -- still learn its result: unknown -> paid/failed keeps the reconciliation incident.
 IF OLD.state IN ('paid','failed') AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Final kiosk terminal attempt' USING ERRCODE='23514';
 END IF;
 IF (OLD.process_id IS NOT NULL AND NEW.process_id IS DISTINCT FROM OLD.process_id)
  OR (OLD.transaction_id IS NOT NULL AND NEW.transaction_id IS DISTINCT FROM OLD.transaction_id)
  OR (OLD.incident IS NOT NULL AND NEW.incident IS DISTINCT FROM OLD.incident) THEN
  RAISE EXCEPTION 'Immutable kiosk terminal identity' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_kiosk_terminal_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON commerce_kiosk_terminal_attempts
 FOR EACH ROW EXECUTE FUNCTION commerce_kiosk_terminal_attempt_guard();

-- Append-only events the kiosk reported (kiosk-key attested). Idempotent per
-- (attempt_id, kind, process_id); at most one result per attempt. decision records what the
-- cloud did with it: counted money, closed the attempt, or turned it into an incident.
CREATE TABLE commerce_kiosk_terminal_events (
 id uuid PRIMARY KEY,
 attempt_id uuid NOT NULL REFERENCES commerce_kiosk_terminal_attempts(attempt_id),
 kind text NOT NULL CHECK(kind IN ('started','result')),
 process_id text COLLATE "C" NOT NULL CHECK(process_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
 terminal_id text COLLATE "C" NOT NULL CHECK(terminal_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
 status text CHECK(status IN ('success','fail','unknown')),
 sub_status text CHECK(length(sub_status) BETWEEN 1 AND 200),
 transaction_id text COLLATE "C" CHECK(transaction_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
 method text CHECK(method IN ('qr','card','alaqan')),
 amount_minor bigint CHECK(amount_minor>0 AND amount_minor%100=0),
 message text CHECK(length(message) BETWEEN 1 AND 200),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 decision text NOT NULL CHECK(decision IN ('started','paid','failed','unknown','mismatch')),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(attempt_id,kind,process_id),
 CHECK((kind='result')=(status IS NOT NULL)),
 CHECK(kind='result' OR (decision='started' AND transaction_id IS NULL AND amount_minor IS NULL))
);
CREATE UNIQUE INDEX commerce_kiosk_terminal_events_one_result ON commerce_kiosk_terminal_events(attempt_id)
 WHERE kind='result';
CREATE UNIQUE INDEX commerce_kiosk_terminal_events_one_start ON commerce_kiosk_terminal_events(attempt_id)
 WHERE kind='started';
CREATE TRIGGER commerce_kiosk_terminal_events_immutable BEFORE UPDATE OR DELETE ON commerce_kiosk_terminal_events
 FOR EACH ROW EXECUTE FUNCTION commerce_immutable();

-- 056 guard with one addition: a kiosk order without an edge reservation may start payment on
-- provider 'kaspi-pos' exactly as on 'kaspi-qr' (same original non-ended guest requirement).
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
      WHERE o.id=NEW.order_id AND o.customer_id IS NULL AND o.snapshot->>'channel'='kiosk' AND a.provider IN ('kaspi-qr','kaspi-pos'))
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
