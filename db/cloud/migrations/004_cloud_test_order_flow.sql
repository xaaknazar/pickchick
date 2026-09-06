-- Isolated synthetic namespace. These tables never represent sales, KKM or loyalty.
CREATE TABLE test_flow_lock (id boolean PRIMARY KEY DEFAULT true CHECK(id));
INSERT INTO test_flow_lock VALUES (true);
CREATE TABLE test_actors (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id) CHECK(branch_id='10000000-0000-4000-8000-000000000003'),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  role text NOT NULL CHECK(role IN ('customer','prep','assembly','display','manager')),
  channel text CHECK(channel IN ('mobile','kiosk')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK((role='customer')=(channel IS NOT NULL)),
  CHECK(expires_at > created_at)
);
CREATE INDEX test_actors_expiry_idx ON test_actors(expires_at);
CREATE INDEX test_actors_created_idx ON test_actors(created_at);
CREATE TABLE test_quotes (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES test_actors(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) CHECK(branch_id='10000000-0000-4000-8000-000000000003'),
  snapshot jsonb NOT NULL,
  total_minor bigint NOT NULL CHECK(total_minor>0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at>created_at),
  CHECK((snapshot->>'quote_id'=id::text AND snapshot->>'branch_id'=branch_id::text) IS TRUE),
  CHECK((snapshot->>'synthetic'='true' AND snapshot->>'namespace'='pickchick-test') IS TRUE),
  CHECK(snapshot ?& ARRAY['synthetic','namespace','quote_id','branch_id','total_minor','lines','created_at','expires_at']),
  CHECK(((snapshot->>'total_minor')::bigint=total_minor) IS TRUE),
  UNIQUE(id, actor_id)
);
CREATE INDEX test_quotes_actor_idx ON test_quotes(actor_id);
CREATE TABLE test_orders (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  actor_id uuid NOT NULL REFERENCES test_actors(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) CHECK(branch_id='10000000-0000-4000-8000-000000000003'),
  quote_id uuid NOT NULL UNIQUE,
  snapshot jsonb NOT NULL,
  total_minor bigint NOT NULL CHECK(total_minor>0),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  state text NOT NULL DEFAULT 'awaiting_test_payment' CHECK(state IN ('awaiting_test_payment','preparing','ready','fulfilled','cancelled')),
  payment_state text NOT NULL DEFAULT 'not_started' CHECK(payment_state IN ('not_started','simulated_unknown','simulated_approved','simulated_declined')),
  payment_attempt_id uuid,
  cancellation_reason text CHECK(length(cancellation_reason) BETWEEN 3 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(quote_id,actor_id) REFERENCES test_quotes(id,actor_id) ON DELETE CASCADE,
  CHECK((snapshot->>'synthetic'='true' AND snapshot->>'namespace'='pickchick-test') IS TRUE),
  CHECK((snapshot->>'quote_id'=quote_id::text AND snapshot->>'branch_id'=branch_id::text) IS TRUE),
  CHECK(((snapshot->>'total_minor')::bigint=total_minor) IS TRUE),
  CHECK((payment_state='not_started')=(payment_attempt_id IS NULL)),
  CHECK(state NOT IN ('preparing','ready','fulfilled') OR payment_state='simulated_approved'),
  CHECK((state='cancelled')=(cancellation_reason IS NOT NULL)),
  CHECK(state<>'cancelled' OR payment_state<>'simulated_unknown')
);
CREATE INDEX test_orders_actor_idx ON test_orders(actor_id);
CREATE INDEX test_orders_queue_idx ON test_orders(branch_id,state,created_at);
CREATE TABLE test_kitchen_tasks (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES test_orders(id) ON DELETE CASCADE,
  task_key text NOT NULL,
  station text NOT NULL CHECK(station IN ('prep','assembly')),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')),
  mandatory boolean NOT NULL DEFAULT true CHECK(mandatory),
  UNIQUE(order_id,task_key)
);
CREATE TABLE test_command_results (
  actor_id uuid NOT NULL REFERENCES test_actors(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_id,idempotency_key)
);
CREATE TABLE test_outbox (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES test_orders(id) ON DELETE CASCADE,
  aggregate_version integer NOT NULL CHECK(aggregate_version>0),
  event_type text NOT NULL CHECK(event_type LIKE 'test.%'),
  payload jsonb NOT NULL CHECK((payload->>'synthetic'='true' AND payload->>'namespace'='pickchick-test') IS TRUE),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(order_id,aggregate_version)
);
CREATE FUNCTION test_quote_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'test quote is immutable'; END; $$;
CREATE TRIGGER test_quote_update_guard BEFORE UPDATE ON test_quotes FOR EACH ROW EXECUTE FUNCTION test_quote_immutable();
CREATE TRIGGER test_command_update_guard BEFORE UPDATE ON test_command_results FOR EACH ROW EXECUTE FUNCTION test_quote_immutable();
CREATE TRIGGER test_outbox_update_guard BEFORE UPDATE ON test_outbox FOR EACH ROW EXECUTE FUNCTION test_quote_immutable();
CREATE FUNCTION test_order_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM test_quotes q WHERE q.id=NEW.quote_id AND q.actor_id=NEW.actor_id
    AND q.branch_id=NEW.branch_id AND q.snapshot=NEW.snapshot AND q.total_minor=NEW.total_minor)
    OR NEW.version<>1 OR NEW.state<>'awaiting_test_payment' OR NEW.payment_state<>'not_started'
  THEN RAISE EXCEPTION 'test order must match immutable quote'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER test_order_insert_check BEFORE INSERT ON test_orders FOR EACH ROW EXECUTE FUNCTION test_order_insert_guard();
CREATE FUNCTION test_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.sequence,NEW.actor_id,NEW.branch_id,NEW.quote_id,NEW.snapshot,NEW.total_minor,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.sequence,OLD.actor_id,OLD.branch_id,OLD.quote_id,OLD.snapshot,OLD.total_minor,OLD.created_at)
    OR NEW.version <> OLD.version+1 OR OLD.state IN ('fulfilled','cancelled')
  THEN RAISE EXCEPTION 'invalid test order mutation'; END IF;
  IF NEW.state='ready' AND (NOT EXISTS(SELECT 1 FROM test_kitchen_tasks WHERE order_id=OLD.id AND station='assembly' AND state='done')
    OR EXISTS(SELECT 1 FROM test_kitchen_tasks WHERE order_id=OLD.id AND mandatory AND state<>'done'))
  THEN RAISE EXCEPTION 'test order tasks incomplete'; END IF;
  IF NEW.state='fulfilled' AND OLD.state<>'ready' THEN RAISE EXCEPTION 'test order not ready'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER test_order_update_guard BEFORE UPDATE ON test_orders FOR EACH ROW EXECUTE FUNCTION test_order_guard();
