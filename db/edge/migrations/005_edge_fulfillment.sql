-- Commercial orders remain cloud-owned. All FKs below stay in this edge DB.
CREATE TABLE fulfillment_config (
  branch_id uuid PRIMARY KEY REFERENCES branch_config(id),
  organization_id uuid NOT NULL,
  device_id uuid NOT NULL UNIQUE,
  cloud_producer_id uuid NOT NULL,
  active_routing_version integer NOT NULL CHECK (active_routing_version > 0)
);
CREATE TABLE fulfillment_stations (
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('prep','assembly')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  PRIMARY KEY(branch_id,id)
);
CREATE TABLE fulfillment_routing (
  branch_id uuid NOT NULL REFERENCES fulfillment_config(branch_id),
  version integer NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(branch_id,version)
);
ALTER TABLE fulfillment_config ADD CONSTRAINT fulfillment_active_routing_fk
FOREIGN KEY(branch_id,active_routing_version) REFERENCES fulfillment_routing(branch_id,version)
DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER fulfillment_routing_immutable BEFORE UPDATE OR DELETE ON fulfillment_routing
FOR EACH ROW EXECUTE FUNCTION reject_menu_snapshot_mutation();
CREATE TABLE fulfillment_station_grants (
  branch_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  station_id uuid NOT NULL,
  PRIMARY KEY(branch_id,staff_id,station_id),
  FOREIGN KEY(staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  FOREIGN KEY(branch_id,station_id) REFERENCES fulfillment_stations(branch_id,id)
);
CREATE SEQUENCE fulfillment_display_sequence;
CREATE TABLE fulfillment_reservations (
  order_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES fulfillment_config(branch_id),
  reservation_id uuid NOT NULL UNIQUE,
  quote_id uuid NOT NULL,
  quote_hash text NOT NULL CHECK (quote_hash ~ '^[a-f0-9]{64}$'),
  owner_hash text NOT NULL CHECK (owner_hash ~ '^[a-f0-9]{64}$'),
  commercial_owner text NOT NULL CHECK (commercial_owner='cloud'),
  fulfillment_owner text NOT NULL CHECK (fulfillment_owner='edge'),
  device_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  routing_version integer NOT NULL,
  task_plan jsonb NOT NULL CHECK (jsonb_typeof(task_plan)='array'),
  assembly_station_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('held','accepted','in_production','ready','handed_over','cancel_requested','cancelled','released')),
  display_number bigint UNIQUE CHECK (display_number > 0),
  business_day date,
  authorized_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancellation_reason text CHECK (length(cancellation_reason) BETWEEN 1 AND 500),
  inventory_disposition text CHECK (inventory_disposition IN ('requires_inventory_review','recorded_elsewhere')),
  UNIQUE(branch_id,order_id),
  UNIQUE(branch_id,quote_id),
  UNIQUE(branch_id,business_day,display_number),
  FOREIGN KEY(branch_id,routing_version) REFERENCES fulfillment_routing(branch_id,version),
  FOREIGN KEY(branch_id,assembly_station_id) REFERENCES fulfillment_stations(branch_id,id),
  CHECK ((display_number IS NULL) = (business_day IS NULL)),
  CHECK ((authorized_event_id IS NULL) = (display_number IS NULL))
);
CREATE INDEX fulfillment_active_idx ON fulfillment_reservations(branch_id,order_id)
WHERE state IN ('accepted','in_production','ready','cancel_requested');
CREATE INDEX fulfillment_display_active_idx ON fulfillment_reservations(branch_id,display_number)
WHERE state IN ('accepted','in_production','ready');
CREATE TABLE fulfillment_tasks (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  component_key text NOT NULL,
  station_id uuid NOT NULL,
  routing_version integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('prep','assembly_item')),
  details jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','in_progress','done','cancel_requested','cancelled')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(branch_id,order_id) REFERENCES fulfillment_reservations(branch_id,order_id),
  FOREIGN KEY(branch_id,station_id) REFERENCES fulfillment_stations(branch_id,id),
  FOREIGN KEY(branch_id,routing_version) REFERENCES fulfillment_routing(branch_id,version),
  UNIQUE(order_id,component_key,station_id,kind,routing_version)
);
CREATE INDEX fulfillment_tasks_station_idx ON fulfillment_tasks(branch_id,station_id,order_id)
WHERE state IN ('queued','in_progress','cancel_requested');
CREATE TABLE fulfillment_inbox (
  branch_id uuid NOT NULL REFERENCES fulfillment_config(branch_id),
  producer_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(producer_id,event_id)
);
CREATE TRIGGER fulfillment_inbox_immutable BEFORE UPDATE OR DELETE ON fulfillment_inbox
FOR EACH ROW EXECUTE FUNCTION reject_menu_snapshot_mutation();
CREATE TABLE fulfillment_commands (
  branch_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  command_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(branch_id,staff_id,command_id),
  FOREIGN KEY(staff_id,branch_id) REFERENCES local_staff(id,branch_id)
);
CREATE TRIGGER fulfillment_commands_immutable BEFORE UPDATE OR DELETE ON fulfillment_commands
FOR EACH ROW EXECUTE FUNCTION reject_menu_snapshot_mutation();
CREATE TABLE fulfillment_outbox (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  event_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  aggregate_type text NOT NULL DEFAULT 'order_fulfillment' CHECK (aggregate_type='order_fulfillment'),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_worker uuid,
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  acknowledged_at timestamptz,
  FOREIGN KEY(branch_id,order_id) REFERENCES fulfillment_reservations(branch_id,order_id),
  UNIQUE(order_id,aggregate_version)
);
CREATE INDEX fulfillment_outbox_pending_idx ON fulfillment_outbox(branch_id,sequence)
WHERE acknowledged_at IS NULL;
CREATE FUNCTION guard_fulfillment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Fulfillment records cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='fulfillment_reservations' THEN
    IF (to_jsonb(NEW)-ARRAY['version','state','display_number','business_day','authorized_event_id','updated_at','cancellation_reason','inventory_disposition'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','state','display_number','business_day','authorized_event_id','updated_at','cancellation_reason','inventory_disposition'])
       OR NEW.version<>OLD.version+1
       OR NOT ((OLD.state='held' AND NEW.state IN ('accepted','cancelled','released'))
           OR (OLD.state='accepted' AND NEW.state IN ('in_production','ready','cancelled','cancel_requested'))
           OR (OLD.state='in_production' AND NEW.state IN ('in_production','ready','cancel_requested'))
           OR (OLD.state='cancel_requested' AND NEW.state IN ('cancel_requested','cancelled'))
           OR (OLD.state='ready' AND NEW.state='handed_over'))
       OR (OLD.authorized_event_id IS NOT NULL AND (NEW.authorized_event_id IS DISTINCT FROM OLD.authorized_event_id OR NEW.display_number IS DISTINCT FROM OLD.display_number OR NEW.business_day IS DISTINCT FROM OLD.business_day))
    THEN RAISE EXCEPTION 'Immutable fulfillment identity/version' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='fulfillment_tasks' THEN
    IF (to_jsonb(NEW)-ARRAY['version','state','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','state','updated_at'])
       OR NEW.version<>OLD.version+1
       OR NOT ((OLD.state='queued' AND NEW.state IN ('in_progress','cancelled'))
          OR (OLD.state='in_progress' AND NEW.state IN ('done','cancel_requested'))
          OR (OLD.state='cancel_requested' AND NEW.state='cancelled'))
    THEN RAISE EXCEPTION 'Immutable task/version' USING ERRCODE='23514'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['lease_worker','lease_token','lease_until','attempts','acknowledged_at'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['lease_worker','lease_token','lease_until','attempts','acknowledged_at'])
    THEN RAISE EXCEPTION 'Immutable fulfillment event' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER fulfillment_reservation_guard BEFORE UPDATE OR DELETE ON fulfillment_reservations
FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_immutable();
CREATE TRIGGER fulfillment_task_guard BEFORE UPDATE OR DELETE ON fulfillment_tasks
FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_immutable();
CREATE TRIGGER fulfillment_outbox_guard BEFORE UPDATE OR DELETE ON fulfillment_outbox
FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_immutable();
