-- ADR-0014 S3: stops of the cloud channels (kiosk/mobile in branch mode 'cloud').
-- 1. cloud_channel_stops: back-office owned stop state per published product/option (the same
--    hashed variant id as the POS menu), versioned, every change in an append-only event log.
-- 2. cloud_stale_stop_overrides: a manager lifts a last-known cashier stop for the cloud
--    channels only, while the cashier is stale; it lapses on the next cashier observation.
-- 3. cloud_stop_commands (048) gains delivery_policy 'until_reconnect' for a back-office UNSTOP
--    of a cashier stop: it stays pending while the cashier is offline instead of the 120 s
--    lapse and is applied by the edge (019) with the usual expected_version check.
-- Cashier stops stay edge-written: nothing here writes cloud_branch_availability.

CREATE TABLE cloud_channel_stops (
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 variant_id uuid NOT NULL,
 catalog_ref text NOT NULL CHECK(length(catalog_ref) BETWEEN 1 AND 200),
 stopped boolean NOT NULL,
 duration text NOT NULL CHECK(duration IN ('manual','hour')),
 expires_at timestamptz,
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 300),
 version integer NOT NULL CHECK(version > 0),
 actor_id uuid NOT NULL,
 actor_label text NOT NULL CHECK(length(actor_label) BETWEEN 1 AND 100),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,variant_id),
 CHECK(stopped OR duration='manual'),
 CHECK((stopped AND duration='hour') = (expires_at IS NOT NULL)),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
 FOREIGN KEY(actor_id,organization_id) REFERENCES catalog_managers(id,organization_id)
);

CREATE TABLE cloud_channel_stop_events (
 branch_id uuid NOT NULL,
 variant_id uuid NOT NULL,
 version integer NOT NULL CHECK(version > 0),
 organization_id uuid NOT NULL,
 catalog_ref text NOT NULL,
 stopped boolean NOT NULL,
 duration text NOT NULL CHECK(duration IN ('manual','hour')),
 expires_at timestamptz,
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 300),
 actor_id uuid NOT NULL,
 actor_label text NOT NULL,
 occurred_at timestamptz NOT NULL,
 PRIMARY KEY(branch_id,variant_id,version)
);
CREATE INDEX cloud_channel_stop_events_time_idx ON cloud_channel_stop_events(branch_id,occurred_at DESC);

-- Server clock owns updated_at/expires_at; versions move by exactly one; identity is fixed.
CREATE FUNCTION cloud_channel_stop_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cloud channel stops cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 THEN RAISE EXCEPTION 'Cloud channel stop starts at version 1' USING ERRCODE='23514'; END IF;
 ELSE
  IF (NEW.organization_id,NEW.branch_id,NEW.variant_id,NEW.catalog_ref)
    IS DISTINCT FROM (OLD.organization_id,OLD.branch_id,OLD.variant_id,OLD.catalog_ref) THEN
   RAISE EXCEPTION 'Cloud channel stop identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.version<>OLD.version+1 THEN
   RAISE EXCEPTION 'Cloud channel stop version must advance by one' USING ERRCODE='23514';
  END IF;
 END IF;
 NEW.updated_at := clock_timestamp();
 NEW.expires_at := CASE WHEN NEW.stopped AND NEW.duration='hour' THEN NEW.updated_at+interval '1 hour' END;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_channel_stop_guard BEFORE INSERT OR UPDATE OR DELETE ON cloud_channel_stops
 FOR EACH ROW EXECUTE FUNCTION cloud_channel_stop_guard();
CREATE FUNCTION cloud_channel_stop_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO cloud_channel_stop_events(branch_id,variant_id,version,organization_id,catalog_ref,stopped,duration,expires_at,reason,actor_id,actor_label,occurred_at)
 VALUES(NEW.branch_id,NEW.variant_id,NEW.version,NEW.organization_id,NEW.catalog_ref,NEW.stopped,NEW.duration,NEW.expires_at,NEW.reason,NEW.actor_id,NEW.actor_label,NEW.updated_at);
 RETURN NULL;
END $$;
CREATE TRIGGER cloud_channel_stop_event AFTER INSERT OR UPDATE ON cloud_channel_stops
 FOR EACH ROW EXECUTE FUNCTION cloud_channel_stop_event();
CREATE FUNCTION cloud_channel_stop_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Cloud channel stop events are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER cloud_channel_stop_event_guard BEFORE UPDATE OR DELETE ON cloud_channel_stop_events
 FOR EACH ROW EXECUTE FUNCTION cloud_channel_stop_event_guard();

-- Durable back-office UNSTOP for the cashier (owner decision 2026-10-10).
ALTER TABLE cloud_stop_commands ADD COLUMN delivery_policy text NOT NULL DEFAULT 'ttl'
 CHECK(delivery_policy IN ('ttl','until_reconnect'));
ALTER TABLE cloud_stop_commands ADD CONSTRAINT cloud_stop_commands_durable_unstop
 CHECK(delivery_policy='ttl' OR (NOT stopped AND duration='manual'));
-- The 048 guard still owns intent/transitions; this one adds: the policy is immutable and a
-- durable command is never lapsed by the cloud before the cashier received it. Its only
-- verdicts come from the edge (applied/conflict/not_found/no_open_shift/expired after receipt).
CREATE FUNCTION cloud_stop_command_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.delivery_policy IS DISTINCT FROM OLD.delivery_policy THEN
  RAISE EXCEPTION 'Stop command delivery policy is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.delivery_policy='until_reconnect' AND OLD.delivered_at IS NULL AND NEW.state='expired' THEN
  RAISE EXCEPTION 'A durable unstop waits for the cashier' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_stop_command_policy_guard BEFORE UPDATE ON cloud_stop_commands
 FOR EACH ROW EXECUTE FUNCTION cloud_stop_command_policy_guard();

CREATE TABLE cloud_stale_stop_overrides (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 variant_id uuid NOT NULL,
 catalog_ref text NOT NULL CHECK(length(catalog_ref) BETWEEN 1 AND 200),
 -- The cashier observation this override answers: device, its stop version and observed_at.
 edge_device_id uuid NOT NULL,
 edge_version integer NOT NULL CHECK(edge_version > 0),
 edge_observed_at timestamptz NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 300),
 actor_id uuid NOT NULL,
 actor_label text NOT NULL CHECK(length(actor_label) BETWEEN 1 AND 100),
 command_id uuid UNIQUE REFERENCES cloud_stop_commands(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
 FOREIGN KEY(actor_id,organization_id) REFERENCES catalog_managers(id,organization_id)
);
CREATE INDEX cloud_stale_stop_overrides_lookup_idx
 ON cloud_stale_stop_overrides(branch_id,variant_id,edge_observed_at DESC);

-- Immutable. Created only against the current, stale (>= 30 s) cashier observation that
-- still lists the variant as stopped at edge_version; a linked command must be this variant's durable unstop.
CREATE FUNCTION cloud_stale_stop_override_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Stop overrides are immutable' USING ERRCODE='23514'; END IF;
 NEW.created_at := clock_timestamp();
 IF NOT EXISTS (
   SELECT 1 FROM cloud_branch_availability a
   WHERE a.branch_id=NEW.branch_id AND a.device_id=NEW.edge_device_id
   AND a.observed_at=NEW.edge_observed_at AND a.observed_at<=clock_timestamp()-interval '30 seconds'
   AND NEW.variant_id=ANY(a.stopped_ids) AND jsonb_typeof(a.stop_states)='array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.stop_states) s
    WHERE s->>'id'=NEW.variant_id::text AND s->>'version'=NEW.edge_version::text)) THEN
  RAISE EXCEPTION 'Only a stale cashier stop can be overridden' USING ERRCODE='23514';
 END IF;
 IF NEW.command_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM cloud_stop_commands c WHERE c.id=NEW.command_id AND c.branch_id=NEW.branch_id
   AND c.variant_id=NEW.variant_id AND NOT c.stopped AND c.delivery_policy='until_reconnect'
   AND c.expected_version=NEW.edge_version) THEN
  RAISE EXCEPTION 'Override command must be the durable unstop of this stop' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_stale_stop_override_guard BEFORE INSERT OR UPDATE OR DELETE ON cloud_stale_stop_overrides
 FOR EACH ROW EXECUTE FUNCTION cloud_stale_stop_override_guard();
