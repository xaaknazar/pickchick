-- Back-office stop/unstop intents for the edge. The edge stays the single writer of stops:
-- the cloud only queues a command, the fulfillment transport (protocol 4) delivers it, the edge
-- applies it with an expected_version check and reports a receipt in a later pull.
CREATE TABLE cloud_stop_commands (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 variant_id uuid NOT NULL,
 catalog_ref text NOT NULL CHECK(length(catalog_ref) BETWEEN 1 AND 200),
 stopped boolean NOT NULL,
 duration text NOT NULL CHECK(duration IN ('manual','hour','shift')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 300),
 expected_version integer NOT NULL CHECK(expected_version >= 0),
 actor_id uuid NOT NULL,
 actor_label text NOT NULL CHECK(length(actor_label) BETWEEN 1 AND 100),
 state text NOT NULL DEFAULT 'pending'
  CHECK(state IN ('pending','delivered','applied','conflict','not_found','no_open_shift','expired')),
 result_version integer CHECK(result_version >= 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 delivered_at timestamptz,
 resolved_at timestamptz,
 CHECK(expires_at = created_at + interval '120 seconds'),
 CHECK((state IN ('pending','delivered')) = (resolved_at IS NULL)),
 CHECK(state <> 'delivered' OR delivered_at IS NOT NULL),
 CHECK(result_version IS NULL OR state IN ('applied','conflict')),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
 FOREIGN KEY(actor_id,organization_id) REFERENCES catalog_managers(id,organization_id)
);
-- One open command per variant: a second stop/unstop waits for the edge verdict or expiry.
CREATE UNIQUE INDEX cloud_stop_commands_open_idx ON cloud_stop_commands(branch_id,variant_id)
 WHERE state IN ('pending','delivered');
CREATE INDEX cloud_stop_commands_branch_time_idx ON cloud_stop_commands(branch_id,created_at DESC,id);

-- Server clock owns the 120 s lifetime. Identity and intent are immutable; only the delivery
-- and verdict move forward. A late edge verdict may replace a cloud-side expiry of a command
-- that was already delivered, because the edge is the source of truth for stops.
CREATE FUNCTION cloud_stop_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Stop commands cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'pending' OR NEW.delivered_at IS NOT NULL OR NEW.resolved_at IS NOT NULL OR NEW.result_version IS NOT NULL THEN
   RAISE EXCEPTION 'Stop commands must start pending' USING ERRCODE='23514';
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.expires_at := NEW.created_at + interval '120 seconds';
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.organization_id,NEW.branch_id,NEW.variant_id,NEW.catalog_ref,NEW.stopped,NEW.duration,
     NEW.reason,NEW.expected_version,NEW.actor_id,NEW.actor_label,NEW.created_at,NEW.expires_at)
   IS DISTINCT FROM
    (OLD.id,OLD.organization_id,OLD.branch_id,OLD.variant_id,OLD.catalog_ref,OLD.stopped,OLD.duration,
     OLD.reason,OLD.expected_version,OLD.actor_id,OLD.actor_label,OLD.created_at,OLD.expires_at) THEN
  RAISE EXCEPTION 'Stop command intent is immutable' USING ERRCODE='23514';
 END IF;
 IF NOT (
   (OLD.state IN ('pending','delivered') AND NEW.state IN ('delivered','applied','conflict','not_found','no_open_shift','expired'))
   OR (OLD.state='expired' AND OLD.delivered_at IS NOT NULL AND NEW.state IN ('applied','conflict','not_found','no_open_shift','expired'))
 ) THEN
  RAISE EXCEPTION 'Invalid stop command transition' USING ERRCODE='23514';
 END IF;
 IF NEW.state='pending' OR (OLD.state NOT IN ('pending','delivered') AND OLD.delivered_at IS DISTINCT FROM NEW.delivered_at) THEN
  RAISE EXCEPTION 'Invalid stop command delivery' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_stop_command_guard BEFORE INSERT OR UPDATE OR DELETE ON cloud_stop_commands
 FOR EACH ROW EXECUTE FUNCTION cloud_stop_command_guard();

-- Per-variant edge stop state (version, source, expiry) from protocol-4 heartbeats. NULL means
-- the edge has not reported it yet; it follows the same device/revision guard as stopped_ids.
ALTER TABLE cloud_branch_availability ADD COLUMN stop_states jsonb
 CHECK(stop_states IS NULL OR (jsonb_typeof(stop_states)='array' AND jsonb_array_length(stop_states)<=5000));
