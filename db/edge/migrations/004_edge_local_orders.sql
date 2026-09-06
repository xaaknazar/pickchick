ALTER TABLE branch_config ADD COLUMN ordering_version integer NOT NULL DEFAULT 1 CHECK (ordering_version > 0);

CREATE TABLE local_staff (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  role text NOT NULL CHECK (role IN ('cashier', 'shift_manager', 'kitchen')),
  active boolean NOT NULL DEFAULT true,
  access_expires_at timestamptz NOT NULL,
  UNIQUE(id, branch_id)
);
CREATE TABLE local_terminals (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  active boolean NOT NULL DEFAULT true,
  UNIQUE(id, branch_id)
);
CREATE TABLE staff_sessions (
  id uuid PRIMARY KEY,
  staff_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  FOREIGN KEY(staff_id, branch_id) REFERENCES local_staff(id, branch_id),
  FOREIGN KEY(terminal_id, branch_id) REFERENCES local_terminals(id, branch_id)
);
CREATE INDEX staff_sessions_actor_idx ON staff_sessions(staff_id, terminal_id);

CREATE TABLE local_stops (
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  variant_id uuid NOT NULL,
  stopped boolean NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  PRIMARY KEY(branch_id, variant_id)
);
CREATE TABLE checkout_quotes (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  staff_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  release_id uuid NOT NULL,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  FOREIGN KEY(staff_id, branch_id) REFERENCES local_staff(id, branch_id),
  FOREIGN KEY(terminal_id, branch_id) REFERENCES local_terminals(id, branch_id),
  FOREIGN KEY(release_id, branch_id) REFERENCES menu_snapshots(id, branch_id),
  UNIQUE(id, branch_id, total_minor),
  CHECK ((jsonb_typeof(snapshot) = 'object' AND snapshot->>'quote_id' = id::text
    AND snapshot->>'branch_id' = branch_id::text AND snapshot->>'release_id' = release_id::text
    AND snapshot->>'total_minor' = total_minor::text AND snapshot->>'currency' = 'KZT'
    AND jsonb_typeof(snapshot->'lines') = 'array') IS TRUE)
);
CREATE TRIGGER checkout_quotes_immutable BEFORE UPDATE OR DELETE ON checkout_quotes
FOR EACH ROW EXECUTE FUNCTION reject_menu_snapshot_mutation();

CREATE TABLE local_orders (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  quote_id uuid NOT NULL UNIQUE,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  state text NOT NULL DEFAULT 'awaiting_payment' CHECK (state IN ('awaiting_payment', 'cancelled')),
  payment_state text NOT NULL DEFAULT 'not_started' CHECK (payment_state = 'not_started'),
  fiscal_state text NOT NULL DEFAULT 'not_requested' CHECK (fiscal_state = 'not_requested'),
  fulfillment_state text NOT NULL DEFAULT 'blocked' CHECK (fulfillment_state = 'blocked'),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancellation_reason text,
  FOREIGN KEY(quote_id, branch_id, total_minor) REFERENCES checkout_quotes(id, branch_id, total_minor),
  CHECK (((state = 'cancelled' AND length(cancellation_reason) BETWEEN 1 AND 300)
    OR (state = 'awaiting_payment' AND cancellation_reason IS NULL)) IS TRUE)
);
CREATE INDEX local_orders_branch_time_idx ON local_orders(branch_id, created_at DESC, id);
CREATE FUNCTION guard_local_order_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Orders cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'awaiting_payment' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'Invalid initial order state' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.branch_id <> OLD.branch_id OR NEW.quote_id <> OLD.quote_id
    OR NEW.total_minor <> OLD.total_minor OR NEW.created_at <> OLD.created_at
    OR OLD.state <> 'awaiting_payment' OR NEW.state <> 'cancelled' OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Invalid local order transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER local_orders_guard BEFORE INSERT OR UPDATE OR DELETE ON local_orders
FOR EACH ROW EXECUTE FUNCTION guard_local_order_update();

CREATE TABLE local_command_results (
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  staff_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  command_type text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(staff_id, branch_id) REFERENCES local_staff(id, branch_id),
  FOREIGN KEY(terminal_id, branch_id) REFERENCES local_terminals(id, branch_id),
  PRIMARY KEY(branch_id, staff_id, terminal_id, command_type, idempotency_key)
);
CREATE TABLE local_order_streams (
  branch_id uuid PRIMARY KEY REFERENCES branch_config(id),
  producer_id uuid NOT NULL UNIQUE,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);
CREATE TABLE local_audit (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  staff_id uuid NOT NULL,
  action text NOT NULL,
  resource_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(staff_id, branch_id) REFERENCES local_staff(id, branch_id)
);
