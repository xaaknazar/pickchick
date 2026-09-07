-- Only the trusted provisioner selects an edge/producer. Replacing an edge is a
-- separate recovery procedure, never an automatic ownership transfer.
CREATE TABLE fulfillment_transport_bindings (
 branch_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 device_id uuid NOT NULL UNIQUE,
 producer_id uuid NOT NULL UNIQUE,
 active boolean NOT NULL DEFAULT true,
 lock_anchor boolean NOT NULL DEFAULT true CHECK(lock_anchor),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
 FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id),
 UNIQUE(device_id,branch_id,organization_id)
);
CREATE FUNCTION fulfillment_transport_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Transport ownership cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['active','lock_anchor']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['active','lock_anchor'])
 THEN RAISE EXCEPTION 'Transport ownership is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fulfillment_transport_binding_guard BEFORE UPDATE OR DELETE ON fulfillment_transport_bindings
 FOR EACH ROW EXECUTE FUNCTION fulfillment_transport_binding_guard();

CREATE TABLE cloud_fulfillment_inbox (
 device_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 event_id uuid NOT NULL,
 source_sequence bigint NOT NULL CHECK(source_sequence>0),
 order_id uuid NOT NULL,
 aggregate_version integer NOT NULL CHECK(aggregate_version>0),
 event_type text NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(device_id,event_id),
 UNIQUE(device_id,source_sequence),
 FOREIGN KEY(device_id,branch_id,organization_id) REFERENCES fulfillment_transport_bindings(device_id,branch_id,organization_id),
 FOREIGN KEY(order_id,branch_id,organization_id) REFERENCES commerce_orders(id,branch_id,organization_id)
);
CREATE INDEX cloud_fulfillment_inbox_order_idx ON cloud_fulfillment_inbox(order_id,aggregate_version);
CREATE TABLE cloud_fulfillment_versions (
 order_id uuid NOT NULL REFERENCES commerce_orders(id),
 version integer NOT NULL CHECK(version>0),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(order_id,version)
);
CREATE TABLE cloud_fulfillment_projection (
 order_id uuid PRIMARY KEY REFERENCES commerce_orders(id),
 branch_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 device_id uuid NOT NULL,
 reservation_id uuid NOT NULL,
 quote_id uuid NOT NULL,
 quote_hash text NOT NULL CHECK(quote_hash ~ '^[a-f0-9]{64}$'),
 owner_hash text NOT NULL CHECK(owner_hash ~ '^[a-f0-9]{64}$'),
 version integer NOT NULL CHECK(version>0),
 state text NOT NULL CHECK(state IN ('held','accepted','in_production','ready','handed_over','cancel_requested','cancelled','released')),
 display_number bigint CHECK(display_number>0),
 routing_version integer NOT NULL CHECK(routing_version>0),
 assembly_station_id uuid,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(device_id,branch_id,organization_id) REFERENCES fulfillment_transport_bindings(device_id,branch_id,organization_id),
 FOREIGN KEY(order_id,branch_id,organization_id) REFERENCES commerce_orders(id,branch_id,organization_id),
 UNIQUE(device_id,reservation_id)
);
CREATE INDEX cloud_fulfillment_projection_branch_idx ON cloud_fulfillment_projection(branch_id,state,order_id);
-- These are observed task deltas, NOT a complete/current kitchen snapshot:
-- existing accepted and bulk-cancel events do not carry all task states.
CREATE TABLE cloud_fulfillment_observed_tasks (
 order_id uuid NOT NULL REFERENCES commerce_orders(id),
 task_id uuid NOT NULL,
 station_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 state text NOT NULL CHECK(state IN ('queued','in_progress','done','cancel_requested','cancelled')),
 aggregate_version integer NOT NULL CHECK(aggregate_version>0),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(order_id,task_id)
);
CREATE TABLE cloud_fulfillment_task_versions (
 order_id uuid NOT NULL REFERENCES commerce_orders(id),
 task_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(order_id,task_id,version)
);
CREATE TRIGGER cloud_fulfillment_inbox_immutable BEFORE UPDATE OR DELETE ON cloud_fulfillment_inbox
 FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER cloud_fulfillment_versions_immutable BEFORE UPDATE OR DELETE ON cloud_fulfillment_versions
 FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER cloud_fulfillment_task_versions_immutable BEFORE UPDATE OR DELETE ON cloud_fulfillment_task_versions
 FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
