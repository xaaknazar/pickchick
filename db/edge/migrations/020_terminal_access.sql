-- Isolated device mailbox. No order, payment, staff role or legacy terminal access is changed.
ALTER TABLE local_terminals ADD COLUMN device_access_managed boolean NOT NULL DEFAULT false;
CREATE TABLE terminal_access_commands (
  command_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  edge_device_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 2147483646),
  payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('applied','paired','expired','rejected')),
  reported_state text CHECK (reported_state IN ('applied','paired','expired','rejected')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(terminal_id,generation)
);
CREATE INDEX terminal_access_unreported ON terminal_access_commands(branch_id,received_at,command_id)
  WHERE state IS DISTINCT FROM reported_state;
CREATE FUNCTION guard_terminal_access_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Device mailbox is append-only' USING ERRCODE='23514'; END IF;
  IF (NEW.command_id,NEW.branch_id,NEW.edge_device_id,NEW.terminal_id,NEW.generation,NEW.payload,NEW.received_at)
      IS DISTINCT FROM
     (OLD.command_id,OLD.branch_id,OLD.edge_device_id,OLD.terminal_id,OLD.generation,OLD.payload,OLD.received_at)
    OR (NEW.state<>OLD.state AND NOT (OLD.state='applied' AND NEW.state IN ('paired','expired'))) THEN
    RAISE EXCEPTION 'Device command is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER terminal_access_command_guard BEFORE UPDATE OR DELETE ON terminal_access_commands
  FOR EACH ROW EXECUTE FUNCTION guard_terminal_access_command();
CREATE TABLE terminal_access_registry (
  terminal_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  edge_device_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('prep','assembly','display')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 2147483646),
  command_id uuid NOT NULL REFERENCES terminal_access_commands(command_id),
  state text NOT NULL CHECK (state IN ('pending','paired','revoked','expired')),
  code_hash text CHECK(code_hash ~ '^[a-f0-9]{64}$'),
  key_hash text CHECK(key_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY(terminal_id,branch_id) REFERENCES local_terminals(id,branch_id),
  CHECK ((state='pending')=(code_hash IS NOT NULL)),
  CHECK ((state='paired')=(key_hash IS NOT NULL))
);
CREATE UNIQUE INDEX terminal_access_pending_code ON terminal_access_registry(code_hash) WHERE code_hash IS NOT NULL;
-- One bounded, durable counter per known branch, never one row per arbitrary code or IP.
CREATE TABLE terminal_pair_limits (
  branch_id uuid PRIMARY KEY REFERENCES branch_config(id),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 30)
);

-- Owner-issued password-reset tickets are a separate mailbox, never a staff enrollment path.
CREATE TABLE kitchen_password_reset_commands (
  command_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  edge_device_id uuid NOT NULL,
  staff_id uuid REFERENCES local_staff(id),
  code_hash text NOT NULL UNIQUE CHECK(code_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '10 minutes'),
  state text NOT NULL CHECK(state IN ('applied','used','expired','rejected')),
  reported_state text CHECK(reported_state IN ('applied','used','expired','rejected')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX kitchen_password_reset_unreported ON kitchen_password_reset_commands(branch_id,received_at,command_id)
  WHERE state IS DISTINCT FROM reported_state;
CREATE FUNCTION guard_kitchen_password_reset_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reset mailbox is append-only' USING ERRCODE='23514'; END IF;
  IF (NEW.command_id,NEW.branch_id,NEW.edge_device_id,NEW.staff_id,NEW.code_hash,NEW.payload,NEW.issued_at,NEW.expires_at,NEW.received_at)
      IS DISTINCT FROM
     (OLD.command_id,OLD.branch_id,OLD.edge_device_id,OLD.staff_id,OLD.code_hash,OLD.payload,OLD.issued_at,OLD.expires_at,OLD.received_at)
    OR (NEW.state<>OLD.state AND NOT (OLD.state='applied' AND NEW.state IN ('used','expired'))) THEN
    RAISE EXCEPTION 'Reset command is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kitchen_password_reset_guard BEFORE UPDATE OR DELETE ON kitchen_password_reset_commands
  FOR EACH ROW EXECUTE FUNCTION guard_kitchen_password_reset_command();
