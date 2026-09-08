-- 015 is reserved by the independent cancellation stage. Merge it before deploy.
-- This is an observational projection, never an authority for payment or cooking.
CREATE TABLE pos_order_sync_bindings (
  branch_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  device_id uuid NOT NULL UNIQUE,
  producer_id uuid NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  lock_anchor boolean NOT NULL DEFAULT true CHECK(lock_anchor),
  FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
  FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id),
  UNIQUE(branch_id,device_id,producer_id)
);
CREATE FUNCTION guard_pos_sync_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR ROW(NEW.branch_id,NEW.organization_id,NEW.device_id,NEW.producer_id)
    IS DISTINCT FROM ROW(OLD.branch_id,OLD.organization_id,OLD.device_id,OLD.producer_id) THEN
    RAISE EXCEPTION 'POS producer ownership is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER pos_sync_binding_guard BEFORE UPDATE OR DELETE ON pos_order_sync_bindings
FOR EACH ROW EXECUTE FUNCTION guard_pos_sync_binding();

CREATE TABLE pos_order_sync_inbox (
  event_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  producer_id uuid NOT NULL,
  producer_sequence bigint NOT NULL CHECK(producer_sequence>0),
  order_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK(aggregate_version IN(1,2)),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(branch_id,device_id,producer_id) REFERENCES pos_order_sync_bindings(branch_id,device_id,producer_id),
  UNIQUE(producer_id,producer_sequence),
  UNIQUE(order_id,aggregate_version)
);
CREATE FUNCTION reject_pos_sync_inbox_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'POS sync receipts are immutable' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER pos_sync_inbox_guard BEFORE UPDATE OR DELETE ON pos_order_sync_inbox
FOR EACH ROW EXECUTE FUNCTION reject_pos_sync_inbox_mutation();

CREATE TABLE pos_order_sync_projection (
  order_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  producer_id uuid NOT NULL,
  quote_id uuid NOT NULL UNIQUE,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  total_minor bigint NOT NULL CHECK(total_minor>=0),
  currency text NOT NULL DEFAULT 'KZT' CHECK(currency='KZT'),
  commercial_owner text NOT NULL DEFAULT 'edge' CHECK(commercial_owner='edge'),
  payment_state text NOT NULL DEFAULT 'not_started' CHECK(payment_state='not_started'),
  fiscal_state text NOT NULL DEFAULT 'not_requested' CHECK(fiscal_state='not_requested'),
  fulfillment_state text NOT NULL DEFAULT 'blocked' CHECK(fulfillment_state='blocked'),
  version integer NOT NULL CHECK(version IN(1,2)),
  state text NOT NULL CHECK(state IN('awaiting_payment','cancelled')),
  last_event_id uuid NOT NULL REFERENCES pos_order_sync_inbox(event_id),
  first_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(branch_id,device_id,producer_id) REFERENCES pos_order_sync_bindings(branch_id,device_id,producer_id),
  CHECK((version=1 AND state='awaiting_payment') OR (version=2 AND state='cancelled'))
);
CREATE INDEX pos_order_sync_projection_branch_idx ON pos_order_sync_projection(branch_id,first_observed_at,order_id);
CREATE FUNCTION guard_pos_sync_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'POS projections cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 THEN RAISE EXCEPTION 'POS create must precede cancel' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.version<>1 OR NEW.version<>2 OR
    (to_jsonb(NEW)-ARRAY['version','state','last_event_id','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['version','state','last_event_id','updated_at']) THEN
    RAISE EXCEPTION 'Invalid POS projection transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER pos_sync_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_order_sync_projection
FOR EACH ROW EXECUTE FUNCTION guard_pos_sync_projection();
