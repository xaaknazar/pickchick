-- Additive registry for edge-owned screens. Existing edge and kiosk identities stay untouched.
CREATE TABLE device_terminal_registry (
  device_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  edge_device_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('prep','assembly','display')),
  generation integer NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 2147483646),
  paired_at timestamptz,
  FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id),
  FOREIGN KEY(edge_device_id,branch_id) REFERENCES devices(id,branch_id)
);
CREATE TABLE cloud_device_commands (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES device_terminal_registry(device_id),
  branch_id uuid NOT NULL,
  edge_device_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 2147483646),
  action text NOT NULL CHECK (action IN ('pair','revoke')),
  code_hash text UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  actor_id uuid NOT NULL REFERENCES catalog_managers(id),
  request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','applied','paired','expired','rejected')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz,
  resolved_at timestamptz,
  CHECK ((action='pair') = (code_hash IS NOT NULL)),
  CHECK (expires_at > created_at AND expires_at <= created_at+interval '10 minutes'),
  FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id),
  FOREIGN KEY(edge_device_id,branch_id) REFERENCES devices(id,branch_id),
  UNIQUE(actor_id,request_id),
  UNIQUE(device_id,generation)
);
CREATE INDEX cloud_device_commands_delivery ON cloud_device_commands(edge_device_id,created_at)
  WHERE state IN ('pending','delivered','applied');
CREATE TABLE device_events (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('backoffice','edge')),
  actor_id uuid NOT NULL,
  command_id uuid REFERENCES cloud_device_commands(id),
  action text NOT NULL CHECK (action IN ('code_issued','revoke_requested','delivered','applied','paired','expired','rejected')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id)
);
CREATE INDEX device_events_history ON device_events(branch_id,device_id,at DESC);
CREATE FUNCTION device_access_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Device access records are immutable'; END IF;
  IF TG_TABLE_NAME='device_events' THEN RAISE EXCEPTION 'Device audit is immutable'; END IF;
  IF TG_TABLE_NAME='cloud_device_commands' AND
    (to_jsonb(NEW)-ARRAY['state','delivered_at','resolved_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','delivered_at','resolved_at'])
    THEN RAISE EXCEPTION 'Device command identity is immutable'; END IF;
  IF TG_TABLE_NAME='device_terminal_registry' AND
    (to_jsonb(NEW)-ARRAY['generation','paired_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['generation','paired_at'])
    THEN RAISE EXCEPTION 'Device scope is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER device_events_immutable BEFORE UPDATE OR DELETE ON device_events
  FOR EACH ROW EXECUTE FUNCTION device_access_immutable();
CREATE TRIGGER cloud_device_commands_immutable BEFORE UPDATE OR DELETE ON cloud_device_commands
  FOR EACH ROW EXECUTE FUNCTION device_access_immutable();
CREATE TRIGGER device_terminal_registry_immutable BEFORE UPDATE OR DELETE ON device_terminal_registry
  FOR EACH ROW EXECUTE FUNCTION device_access_immutable();

-- A reset authorizes only an existing kitchen password. It carries no password or verifier.
CREATE TABLE cloud_kitchen_password_resets (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  edge_device_id uuid NOT NULL,
  login text NOT NULL CHECK (login='kitchen'),
  code_hash text UNIQUE NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  actor_id uuid NOT NULL REFERENCES catalog_managers(id),
  request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','applied','used','expired','rejected')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz,
  resolved_at timestamptz,
  FOREIGN KEY(edge_device_id,branch_id) REFERENCES devices(id,branch_id),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
  UNIQUE(actor_id,request_id)
);
CREATE INDEX cloud_kitchen_password_resets_delivery ON cloud_kitchen_password_resets(edge_device_id,created_at)
  WHERE state IN ('pending','delivered');
CREATE TABLE kitchen_password_reset_events (
  id uuid PRIMARY KEY,
  command_id uuid NOT NULL REFERENCES cloud_kitchen_password_resets(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  actor_kind text NOT NULL CHECK(actor_kind IN ('backoffice','edge')),
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('issued','delivered','applied','used','expired','rejected')),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION kitchen_password_reset_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR TG_TABLE_NAME='kitchen_password_reset_events'
    THEN RAISE EXCEPTION 'Password reset audit is immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','delivered_at','resolved_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','delivered_at','resolved_at'])
    THEN RAISE EXCEPTION 'Password reset identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kitchen_password_reset_identity BEFORE UPDATE OR DELETE ON cloud_kitchen_password_resets
  FOR EACH ROW EXECUTE FUNCTION kitchen_password_reset_immutable();
CREATE TRIGGER kitchen_password_reset_audit BEFORE UPDATE OR DELETE ON kitchen_password_reset_events
  FOR EACH ROW EXECUTE FUNCTION kitchen_password_reset_immutable();
