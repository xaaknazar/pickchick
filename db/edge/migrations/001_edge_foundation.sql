-- The edge holds only its assigned branch and immutable local menu snapshots.
CREATE TABLE branch_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  id uuid NOT NULL UNIQUE,
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  timezone text NOT NULL CHECK (timezone = 'Asia/Almaty'),
  ordering_enabled boolean NOT NULL DEFAULT false
);

CREATE TABLE menu_snapshots (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  version integer NOT NULL CHECK (version > 0),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  published_at timestamptz NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payload ?& ARRAY['release_id', 'branch_id', 'schema_version', 'version', 'items']),
  CHECK (payload->>'release_id' = id::text AND payload->>'branch_id' = branch_id::text),
  CHECK ((payload->>'version')::integer = version),
  CHECK ((payload->>'schema_version')::integer = schema_version),
  CHECK (jsonb_typeof(payload->'items') = 'array'),
  UNIQUE (id, branch_id),
  UNIQUE (branch_id, version)
);

CREATE TABLE active_menu (
  branch_id uuid PRIMARY KEY REFERENCES branch_config(id),
  release_id uuid NOT NULL,
  FOREIGN KEY (release_id, branch_id) REFERENCES menu_snapshots(id, branch_id)
);

CREATE FUNCTION reject_menu_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Applied menu snapshots are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER menu_snapshots_immutable BEFORE UPDATE OR DELETE ON menu_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_menu_snapshot_mutation();

CREATE TABLE outbox_events (
  event_id uuid PRIMARY KEY,
  producer_id uuid NOT NULL,
  producer_sequence bigint NOT NULL CHECK (producer_sequence > 0),
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  UNIQUE (producer_id, producer_sequence),
  UNIQUE (aggregate_type, aggregate_id, aggregate_version)
);
CREATE INDEX outbox_pending_idx ON outbox_events(next_attempt_at) WHERE acknowledged_at IS NULL;

CREATE TABLE inbox_messages (
  producer_id uuid NOT NULL,
  event_id uuid NOT NULL,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (producer_id, event_id)
);
