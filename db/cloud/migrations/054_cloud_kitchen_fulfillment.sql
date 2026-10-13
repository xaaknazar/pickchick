-- Cloud kitchen fulfillment for kiosk/mobile (ADR-0014, docs/architecture/cloud-kitchen-channel.md
-- sections 2 and 4, stage S2). Nothing in production writes these tables yet: every branch stays
-- in mode 'edge' (no row = 'edge'), the payment capture path does not call admission, and the
-- /v1/kitchen/* controller is behind a disabled feature flag.

-- Per-branch owner of kiosk/mobile fulfillment. A missing row means 'edge'. Changes only through
-- cloud_kitchen_set_mode (audited, epoch +1); the owner of an order is fixed at payment in
-- cloud_kitchen_admissions and a later mode change never touches it.
CREATE TABLE branch_channel_modes (
 branch_id uuid PRIMARY KEY REFERENCES branches(id),
 cloud_channels_owner text NOT NULL DEFAULT 'edge' CHECK(cloud_channels_owner IN ('edge','cloud')),
 epoch bigint NOT NULL CHECK(epoch > 0),
 changed_by text NOT NULL CHECK(length(changed_by) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE branch_channel_mode_changes (
 branch_id uuid NOT NULL REFERENCES branches(id),
 epoch bigint NOT NULL CHECK(epoch > 0),
 cloud_channels_owner text NOT NULL CHECK(cloud_channels_owner IN ('edge','cloud')),
 changed_by text NOT NULL CHECK(length(changed_by) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,epoch)
);

-- Kitchen stations and routing known to the cloud for cloud-owned orders. Trusted provisioning
-- only (owner role); the API runtime reads them. Same shape and rules as edge 005 routing.
CREATE TABLE cloud_kitchen_stations (
 branch_id uuid NOT NULL REFERENCES branches(id),
 id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('prep','assembly')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 PRIMARY KEY(branch_id,id)
);
CREATE TABLE cloud_kitchen_routing (
 branch_id uuid NOT NULL REFERENCES branches(id),
 version integer NOT NULL CHECK(version > 0),
 assembly_station_id uuid NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,version),
 FOREIGN KEY(branch_id,assembly_station_id) REFERENCES cloud_kitchen_stations(branch_id,id)
);
CREATE TABLE cloud_kitchen_config (
 branch_id uuid PRIMARY KEY REFERENCES branches(id),
 active_routing_version integer NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,active_routing_version) REFERENCES cloud_kitchen_routing(branch_id,version)
);

-- Fulfillment owner decision, recorded once per paid kiosk/mobile order. Immutable.
CREATE TABLE cloud_kitchen_admissions (
 order_id uuid PRIMARY KEY REFERENCES commerce_orders(id),
 branch_id uuid NOT NULL REFERENCES branches(id),
 channel text NOT NULL CHECK(channel IN ('kiosk','mobile')),
 fulfillment_owner text NOT NULL CHECK(fulfillment_owner IN ('edge','cloud')),
 owner_epoch bigint NOT NULL CHECK(owner_epoch >= 0),
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(order_id,fulfillment_owner,owner_epoch)
);

-- Cloud-owned kitchen aggregate. Same order states as edge minus held/released: a cloud order is
-- created only after payment, directly in 'accepted'. The display number is the channel hold
-- (053) of the same order.
CREATE TABLE cloud_kitchen_orders (
 order_id uuid PRIMARY KEY REFERENCES channel_number_holds(order_id),
 branch_id uuid NOT NULL REFERENCES branches(id),
 channel text NOT NULL CHECK(channel IN ('kiosk','mobile')),
 fulfillment_owner text NOT NULL DEFAULT 'cloud' CHECK(fulfillment_owner='cloud'),
 owner_epoch bigint NOT NULL CHECK(owner_epoch >= 0),
 quote_digest text NOT NULL CHECK(quote_digest ~ '^[a-f0-9]{64}$'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 routing_version integer NOT NULL,
 assembly_station_id uuid NOT NULL,
 task_plan jsonb NOT NULL CHECK(jsonb_typeof(task_plan)='array'),
 display_number integer NOT NULL CHECK(display_number BETWEEN 300 AND 899),
 number_shift_epoch bigint NOT NULL CHECK(number_shift_epoch >= 0),
 state text NOT NULL CHECK(state IN ('accepted','in_production','ready','handed_over','cancel_requested','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 cancellation_reason text CHECK(length(cancellation_reason) BETWEEN 1 AND 500),
 inventory_disposition text CHECK(inventory_disposition IN ('requires_inventory_review','recorded_elsewhere')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(branch_id,order_id),
 FOREIGN KEY(order_id,fulfillment_owner,owner_epoch) REFERENCES cloud_kitchen_admissions(order_id,fulfillment_owner,owner_epoch),
 FOREIGN KEY(branch_id,routing_version) REFERENCES cloud_kitchen_routing(branch_id,version),
 FOREIGN KEY(branch_id,assembly_station_id) REFERENCES cloud_kitchen_stations(branch_id,id)
);
CREATE INDEX cloud_kitchen_orders_active_idx ON cloud_kitchen_orders(branch_id,order_id)
 WHERE state IN ('accepted','in_production','ready','cancel_requested');
CREATE INDEX cloud_kitchen_orders_display_idx ON cloud_kitchen_orders(branch_id,display_number)
 WHERE state IN ('accepted','in_production','ready');

CREATE TABLE cloud_kitchen_tasks (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL,
 order_id uuid NOT NULL,
 component_key text NOT NULL CHECK(length(component_key) BETWEEN 1 AND 400),
 station_id uuid NOT NULL,
 routing_version integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('prep','assembly_item')),
 details jsonb NOT NULL CHECK(jsonb_typeof(details)='object'),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','in_progress','done','cancel_requested','cancelled')),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,order_id) REFERENCES cloud_kitchen_orders(branch_id,order_id),
 FOREIGN KEY(branch_id,station_id) REFERENCES cloud_kitchen_stations(branch_id,id),
 FOREIGN KEY(branch_id,routing_version) REFERENCES cloud_kitchen_routing(branch_id,version),
 UNIQUE(order_id,component_key,station_id,kind,routing_version)
);
CREATE INDEX cloud_kitchen_tasks_order_idx ON cloud_kitchen_tasks(branch_id,order_id);
CREATE INDEX cloud_kitchen_tasks_station_idx ON cloud_kitchen_tasks(branch_id,station_id,order_id)
 WHERE state IN ('queued','in_progress','cancel_requested');

-- Durable command journal: one row per (branch, device, Idempotency-Key). Same key and body
-- replays the stored result; another body is a conflict. Immutable.
CREATE TABLE cloud_kitchen_commands (
 branch_id uuid NOT NULL REFERENCES branches(id),
 device_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
 order_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('start_task','complete_task','complete_station','confirm_stop','ready','handoff','confirm_cancel')),
 station_id uuid,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,device_id,idempotency_key),
 FOREIGN KEY(branch_id,order_id) REFERENCES cloud_kitchen_orders(branch_id,order_id)
);

-- Transactional outbox of the cloud kitchen aggregate: exactly one event per order version.
CREATE TABLE cloud_kitchen_outbox (
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 event_id uuid PRIMARY KEY,
 branch_id uuid NOT NULL,
 order_id uuid NOT NULL,
 aggregate_version integer NOT NULL CHECK(aggregate_version > 0),
 event_type text NOT NULL CHECK(event_type ~ '^cloud_kitchen\.[a-z_]+$'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 lease_worker uuid,
 lease_token uuid,
 lease_until timestamptz,
 acknowledged_at timestamptz,
 UNIQUE(order_id,aggregate_version),
 FOREIGN KEY(branch_id,order_id) REFERENCES cloud_kitchen_orders(branch_id,order_id)
);
CREATE INDEX cloud_kitchen_outbox_pending_idx ON cloud_kitchen_outbox(sequence) WHERE acknowledged_at IS NULL;

-- Last poll per kitchen device and station: input for the future KITCHEN_OFFLINE gate (S4).
CREATE TABLE cloud_kitchen_station_presence (
 branch_id uuid NOT NULL,
 device_id uuid NOT NULL,
 station_id uuid NOT NULL,
 seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,device_id,station_id),
 FOREIGN KEY(branch_id,station_id) REFERENCES cloud_kitchen_stations(branch_id,id)
);
CREATE INDEX cloud_kitchen_station_presence_seen_idx ON cloud_kitchen_station_presence(branch_id,seen_at DESC);

CREATE FUNCTION cloud_kitchen_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Cloud kitchen record is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER cloud_kitchen_admissions_immutable BEFORE UPDATE OR DELETE ON cloud_kitchen_admissions
 FOR EACH ROW EXECUTE FUNCTION cloud_kitchen_immutable();
CREATE TRIGGER cloud_kitchen_commands_immutable BEFORE UPDATE OR DELETE ON cloud_kitchen_commands
 FOR EACH ROW EXECUTE FUNCTION cloud_kitchen_immutable();
CREATE TRIGGER branch_channel_mode_changes_immutable BEFORE UPDATE OR DELETE ON branch_channel_mode_changes
 FOR EACH ROW EXECUTE FUNCTION cloud_kitchen_immutable();
CREATE TRIGGER cloud_kitchen_routing_immutable BEFORE UPDATE OR DELETE ON cloud_kitchen_routing
 FOR EACH ROW EXECUTE FUNCTION cloud_kitchen_immutable();

-- Identity, ownership, number and snapshot never change; every update advances the version by
-- exactly one (one event each); terminal states are final. Transition rules themselves live in
-- @pickchick/fulfillment-state and are applied by the repository.
CREATE FUNCTION cloud_kitchen_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cloud kitchen orders cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'accepted' OR NEW.version<>1 THEN
   RAISE EXCEPTION 'Cloud kitchen order starts accepted at version 1' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM channel_number_holds h WHERE h.order_id=NEW.order_id
     AND h.branch_id=NEW.branch_id AND h.channel=NEW.channel AND h.display_number=NEW.display_number
     AND h.shift_epoch=NEW.number_shift_epoch AND h.released_at IS NULL) THEN
   RAISE EXCEPTION 'Cloud kitchen order must hold its active channel number' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.order_id,NEW.branch_id,NEW.channel,NEW.fulfillment_owner,NEW.owner_epoch,NEW.quote_digest,NEW.snapshot,NEW.routing_version,NEW.assembly_station_id,NEW.task_plan,NEW.display_number,NEW.number_shift_epoch,NEW.created_at)
    IS DISTINCT FROM (OLD.order_id,OLD.branch_id,OLD.channel,OLD.fulfillment_owner,OLD.owner_epoch,OLD.quote_digest,OLD.snapshot,OLD.routing_version,OLD.assembly_station_id,OLD.task_plan,OLD.display_number,OLD.number_shift_epoch,OLD.created_at)
 THEN RAISE EXCEPTION 'Cloud kitchen order identity is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.state IN ('handed_over','cancelled') OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'Cloud kitchen order version must advance by one from a live state' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_kitchen_order_guard BEFORE INSERT OR UPDATE OR DELETE ON cloud_kitchen_orders
 FOR EACH ROW EXECUTE FUNCTION cloud_kitchen_order_guard();

CREATE FUNCTION cloud_kitchen_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cloud kitchen tasks cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'queued' OR NEW.version<>1 THEN
   RAISE EXCEPTION 'Cloud kitchen task starts queued at version 1' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.branch_id,NEW.order_id,NEW.component_key,NEW.station_id,NEW.routing_version,NEW.kind,NEW.details)
    IS DISTINCT FROM (OLD.id,OLD.branch_id,OLD.order_id,OLD.component_key,OLD.station_id,OLD.routing_version,OLD.kind,OLD.details)
 THEN RAISE EXCEPTION 'Cloud kitchen task identity is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.state IN ('done','cancelled') OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'Cloud kitchen task version must advance by one from a live state' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_kitchen_task_guard BEFORE INSERT OR UPDATE OR DELETE ON cloud_kitchen_tasks
 FOR EACH ROW EXECUTE FUNCTION cloud_kitchen_task_guard();

CREATE FUNCTION cloud_kitchen_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cloud kitchen outbox rows cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (NEW.sequence,NEW.event_id,NEW.branch_id,NEW.order_id,NEW.aggregate_version,NEW.event_type,NEW.payload,NEW.created_at)
    IS DISTINCT FROM (OLD.sequence,OLD.event_id,OLD.branch_id,OLD.order_id,OLD.aggregate_version,OLD.event_type,OLD.payload,OLD.created_at)
    OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)
 THEN RAISE EXCEPTION 'Cloud kitchen event is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_kitchen_outbox_guard BEFORE UPDATE OR DELETE ON cloud_kitchen_outbox
 FOR EACH ROW EXECUTE FUNCTION cloud_kitchen_outbox_guard();

-- Audited mode switch. Each call advances the branch epoch by one; no-op switches are refused so
-- the history stays meaningful. Only new admissions read the mode.
CREATE FUNCTION cloud_kitchen_set_mode(p_branch_id uuid, p_owner text, p_actor text, p_reason text)
RETURNS TABLE(cloud_channels_owner text, epoch bigint)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE current branch_channel_modes%ROWTYPE; next_epoch bigint;
BEGIN
 IF p_branch_id IS NULL OR p_owner IS NULL OR p_owner NOT IN ('edge','cloud') THEN
  RAISE EXCEPTION 'Invalid channel mode request' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('channel_mode:'||p_branch_id::text,0));
 SELECT * INTO current FROM branch_channel_modes m WHERE m.branch_id=p_branch_id FOR UPDATE;
 IF coalesce(current.cloud_channels_owner,'edge')=p_owner THEN
  RAISE EXCEPTION 'Channel mode is already %', p_owner USING ERRCODE='55000';
 END IF;
 next_epoch := coalesce(current.epoch,0)+1;
 INSERT INTO branch_channel_mode_changes(branch_id,epoch,cloud_channels_owner,changed_by,reason)
  VALUES(p_branch_id,next_epoch,p_owner,p_actor,p_reason);
 INSERT INTO branch_channel_modes AS m(branch_id,cloud_channels_owner,epoch,changed_by,reason)
  VALUES(p_branch_id,p_owner,next_epoch,p_actor,p_reason)
  ON CONFLICT (branch_id) DO UPDATE SET cloud_channels_owner=EXCLUDED.cloud_channels_owner,
   epoch=EXCLUDED.epoch,changed_by=EXCLUDED.changed_by,reason=EXCLUDED.reason,changed_at=clock_timestamp();
 RETURN QUERY SELECT p_owner,next_epoch;
END $$;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.cloud_kitchen_set_mode(uuid,text,text,text) SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
END $$;
REVOKE ALL ON FUNCTION cloud_kitchen_set_mode(uuid,text,text,text) FROM PUBLIC;
