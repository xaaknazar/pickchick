-- Harmless row-lock columns for a dedicated transport receiver role.
ALTER TABLE devices ADD COLUMN pos_sync_lock_anchor boolean NOT NULL DEFAULT false CHECK(NOT pos_sync_lock_anchor);
ALTER TABLE device_credentials ADD COLUMN pos_sync_lock_anchor boolean NOT NULL DEFAULT false CHECK(NOT pos_sync_lock_anchor);

-- Preserve absent execution_mode for every historical commercial event/projection.
ALTER TABLE pos_order_sync_projection ADD COLUMN execution_mode text CHECK(execution_mode='unpaid_service');

CREATE TABLE pos_kitchen_sync_inbox (
  event_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  producer_id uuid NOT NULL,
  producer_sequence bigint NOT NULL CHECK(producer_sequence>0),
  order_id uuid NOT NULL REFERENCES pos_order_sync_projection(order_id),
  aggregate_version integer NOT NULL CHECK(aggregate_version>0),
  event_type text NOT NULL,
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(branch_id,device_id,producer_id) REFERENCES pos_order_sync_bindings(branch_id,device_id,producer_id),
  UNIQUE(producer_id,producer_sequence),
  UNIQUE(order_id,aggregate_version)
);
CREATE TRIGGER pos_kitchen_sync_inbox_guard BEFORE UPDATE OR DELETE ON pos_kitchen_sync_inbox
FOR EACH ROW EXECUTE FUNCTION reject_pos_sync_inbox_mutation();

CREATE TABLE pos_kitchen_sync_projection (
  order_id uuid PRIMARY KEY REFERENCES pos_order_sync_projection(order_id),
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  producer_id uuid NOT NULL,
  reservation_id uuid NOT NULL UNIQUE,
  quote_id uuid NOT NULL UNIQUE,
  quote_digest text NOT NULL CHECK(quote_digest ~ '^[a-f0-9]{64}$'),
  owner_hash text NOT NULL CHECK(owner_hash ~ '^[a-f0-9]{64}$'),
  execution_mode text NOT NULL CHECK(execution_mode='unpaid_service'),
  display_number bigint NOT NULL CHECK(display_number>0),
  routing_version integer NOT NULL CHECK(routing_version>0),
  assembly_station_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  state text NOT NULL CHECK(state IN('accepted','in_production','ready','handed_over','cancelled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_event_id uuid NOT NULL REFERENCES pos_kitchen_sync_inbox(event_id),
  FOREIGN KEY(branch_id,device_id,producer_id) REFERENCES pos_order_sync_bindings(branch_id,device_id,producer_id)
);
CREATE INDEX pos_kitchen_sync_projection_branch_idx ON pos_kitchen_sync_projection(branch_id,observed_at,order_id);
CREATE FUNCTION guard_pos_kitchen_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Kitchen projection cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.state<>'accepted' OR NOT EXISTS(
      SELECT 1 FROM pos_order_sync_projection p WHERE p.order_id=NEW.order_id
      AND p.branch_id=NEW.branch_id AND p.device_id=NEW.device_id AND p.producer_id=NEW.producer_id
      AND p.quote_id=NEW.quote_id AND p.snapshot_hash=NEW.quote_digest AND p.execution_mode='unpaid_service'
    ) THEN RAISE EXCEPTION 'Unpaid POS commercial observation must precede kitchen admission' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at OR
    (to_jsonb(NEW)-ARRAY['version','state','last_event_id','updated_at','observed_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['version','state','last_event_id','updated_at','observed_at']) OR NOT (
      (OLD.state='accepted' AND NEW.state IN('in_production','ready','cancelled')) OR
      (OLD.state='in_production' AND NEW.state IN('in_production','ready')) OR
      (OLD.state='ready' AND NEW.state='handed_over')
    ) THEN RAISE EXCEPTION 'Invalid observed kitchen transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER pos_kitchen_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_kitchen_sync_projection
FOR EACH ROW EXECUTE FUNCTION guard_pos_kitchen_projection();
