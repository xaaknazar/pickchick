-- Kaspi Smart POS adapter on the edge (ADR-0017, owner decision 15.11.2026). Additive and off:
-- without a kaspi_pos_devices row a cash desk sells exactly as in 026 (cashier marks the terminal
-- payment). The previous runtime never names these relations. Money is whole tiyn; the terminal
-- takes whole tenge, so every amount here is a multiple of 100.

-- 1. The terminal of a cash desk ----------------------------------------------------------------
-- Written by the owner tool scripts/kaspi-terminal-setup.mjs (register, unlink); the runtime reads
-- it and renews only the token columns (/v2/revoke).
CREATE TABLE kaspi_pos_devices (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  terminal_id uuid NOT NULL,
  host inet NOT NULL CHECK(family(host)=4 AND masklen(host)=32 AND (host << '10.0.0.0/8'::inet
    OR host << '172.16.0.0/12'::inet OR host << '192.168.0.0/16'::inet)),
  port integer NOT NULL DEFAULT 8080 CHECK(port=8080),
  certificate_sha256 text NOT NULL CHECK(certificate_sha256 ~ '^[a-f0-9]{64}$'),
  integration_name text NOT NULL CHECK(integration_name ~ '^[A-Za-z0-9_-]{3,40}$'),
  access_token text NOT NULL CHECK(length(access_token) BETWEEN 8 AND 512),
  refresh_token text NOT NULL CHECK(length(refresh_token) BETWEEN 8 AND 512),
  token_expires_at timestamptz NOT NULL,
  kaspi_terminal_id text CHECK(length(kaspi_terminal_id) BETWEEN 1 AND 64),
  serial_number text CHECK(length(serial_number) BETWEEN 1 AND 64),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(terminal_id,branch_id) REFERENCES local_terminals(id,branch_id),
  UNIQUE(id,branch_id)
);
-- One active terminal per cash desk.
CREATE UNIQUE INDEX kaspi_pos_devices_active_desk ON kaspi_pos_devices(branch_id,terminal_id)
  WHERE active;

-- 2. One payment attempt on that terminal -------------------------------------------------------
CREATE TABLE kaspi_pos_attempts (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'sale' CHECK(kind='sale'),
  amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor%100=0),
  state text NOT NULL DEFAULT 'created' CHECK(state IN ('created','sending','send_failed','wait',
    'success','fail','unknown','lost')),
  sub_status text CHECK(sub_status ~ '^[A-Za-z]{1,40}$'),
  process_id text CHECK(process_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  transaction_id text CHECK(length(trim(transaction_id)) BETWEEN 1 AND 40),
  payment_method text CHECK(payment_method IN ('qr','card','alaqan')),
  message text CHECK(length(message) BETWEEN 1 AND 300),
  cheque jsonb CHECK(cheque IS NULL OR (jsonb_typeof(cheque)='object' AND length(cheque::text)<=4000)),
  order_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  actualized_at timestamptz,
  FOREIGN KEY(device_id,branch_id) REFERENCES kaspi_pos_devices(id,branch_id),
  FOREIGN KEY(terminal_id,branch_id) REFERENCES local_terminals(id,branch_id),
  UNIQUE(id,branch_id),
  CHECK((state IN ('wait','success','fail','unknown')) <= (process_id IS NOT NULL)),
  CHECK((state='success') = (transaction_id IS NOT NULL)),
  CHECK(order_id IS NULL OR state='success'),
  CHECK((state IN ('send_failed','success','fail','lost')) = (finished_at IS NOT NULL))
);
-- One unfinished operation per terminal (Kaspi error 107).
CREATE UNIQUE INDEX kaspi_pos_attempts_one_open ON kaspi_pos_attempts(device_id)
  WHERE state IN ('created','sending','wait','unknown');
CREATE INDEX kaspi_pos_attempts_desk_idx ON kaspi_pos_attempts(branch_id,terminal_id,created_at);

-- Only forward transitions; identity and money never change; order_id is set once.
CREATE FUNCTION guard_kaspi_pos_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Kaspi attempts are never deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'created' OR NEW.order_id IS NOT NULL OR NEW.process_id IS NOT NULL THEN
      RAISE EXCEPTION 'A Kaspi attempt starts as created' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM kaspi_pos_devices d WHERE d.id=NEW.device_id
        AND d.branch_id=NEW.branch_id AND d.terminal_id=NEW.terminal_id AND d.active) THEN
      RAISE EXCEPTION 'A Kaspi attempt needs the active terminal of its cash desk' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.branch_id,NEW.device_id,NEW.terminal_id,NEW.staff_id,NEW.quote_id,NEW.kind,
      NEW.amount_minor,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.branch_id,OLD.device_id,
      OLD.terminal_id,OLD.staff_id,OLD.quote_id,OLD.kind,OLD.amount_minor,OLD.created_at) THEN
    RAISE EXCEPTION 'A Kaspi attempt keeps its identity and amount' USING ERRCODE='23514';
  END IF;
  IF OLD.process_id IS NOT NULL AND NEW.process_id IS DISTINCT FROM OLD.process_id THEN
    RAISE EXCEPTION 'A Kaspi process id never changes' USING ERRCODE='23514';
  END IF;
  IF OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'A Kaspi attempt pays one order' USING ERRCODE='23514';
  END IF;
  IF OLD.state IN ('send_failed','fail','lost') AND (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN
    RAISE EXCEPTION 'A finished Kaspi attempt does not change' USING ERRCODE='23514';
  END IF;
  IF OLD.state='success' AND ((to_jsonb(NEW)-ARRAY['updated_at','order_id']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['updated_at','order_id'])) THEN
    RAISE EXCEPTION 'A paid Kaspi attempt only gets its order' USING ERRCODE='23514';
  END IF;
  IF NEW.state<>OLD.state AND NOT (
       (OLD.state='created' AND NEW.state IN ('sending','send_failed'))
    OR (OLD.state='sending' AND NEW.state IN ('wait','send_failed','lost'))
    OR (OLD.state='wait' AND NEW.state IN ('success','fail','unknown'))
    OR (OLD.state='unknown' AND NEW.state IN ('success','fail'))) THEN
    RAISE EXCEPTION 'Kaspi attempt % cannot become %',OLD.state,NEW.state USING ERRCODE='23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER kaspi_pos_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON kaspi_pos_attempts
FOR EACH ROW EXECUTE FUNCTION guard_kaspi_pos_attempt();

-- The runtime renews tokens only; everything else of a device is the owner tool's.
CREATE FUNCTION guard_kaspi_pos_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Kaspi terminals are unlinked, never deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.branch_id,NEW.terminal_id,NEW.created_at) IS DISTINCT FROM
       (OLD.id,OLD.branch_id,OLD.terminal_id,OLD.created_at) THEN
      RAISE EXCEPTION 'A Kaspi terminal keeps its cash desk' USING ERRCODE='23514';
    END IF;
    IF NOT OLD.active AND NEW.active THEN
      RAISE EXCEPTION 'An unlinked Kaspi terminal is registered again as a new row' USING ERRCODE='23514';
    END IF;
    NEW.updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kaspi_pos_device_guard BEFORE INSERT OR UPDATE OR DELETE ON kaspi_pos_devices
FOR EACH ROW EXECUTE FUNCTION guard_kaspi_pos_device();

-- 3. A terminal tender paid by an attempt --------------------------------------------------------
-- pos_sale_tenders.attempt_id (NULL in 026) now names the paid attempt: a kaspi_terminal part of
-- this branch, the same amount, the attempt of the sale's cash desk and quote, used once.
ALTER TABLE pos_sale_tenders ADD CONSTRAINT pos_sale_tenders_attempt_fk
  FOREIGN KEY(attempt_id,branch_id) REFERENCES kaspi_pos_attempts(id,branch_id);
CREATE UNIQUE INDEX pos_sale_tenders_attempt_once ON pos_sale_tenders(attempt_id)
  WHERE attempt_id IS NOT NULL;
CREATE FUNCTION guard_pos_sale_tender_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.attempt_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.method<>'kaspi_terminal' OR NOT EXISTS (
      SELECT 1 FROM kaspi_pos_attempts a JOIN pos_sales s ON s.order_id=NEW.order_id
        AND s.branch_id=NEW.branch_id
      WHERE a.id=NEW.attempt_id AND a.branch_id=NEW.branch_id AND a.state='success'
        AND a.order_id=NEW.order_id AND a.amount_minor=NEW.amount_minor
        AND a.terminal_id=s.terminal_id AND a.quote_id=s.quote_id) THEN
    RAISE EXCEPTION 'A terminal tender needs its paid Kaspi attempt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_sale_tender_attempt_guard BEFORE INSERT ON pos_sale_tenders
FOR EACH ROW EXECUTE FUNCTION guard_pos_sale_tender_attempt();
