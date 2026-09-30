CREATE TABLE fulfillment_release_results (
 producer_id uuid NOT NULL,
 event_id uuid NOT NULL,
 branch_id uuid NOT NULL REFERENCES fulfillment_config(branch_id),
 order_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 result_event_id uuid NOT NULL UNIQUE REFERENCES fulfillment_outbox(event_id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(producer_id,event_id),
 FOREIGN KEY(branch_id,order_id) REFERENCES fulfillment_reservations(branch_id,order_id)
);
CREATE TRIGGER fulfillment_release_results_immutable BEFORE UPDATE OR DELETE ON fulfillment_release_results FOR EACH ROW EXECUTE FUNCTION reject_menu_snapshot_mutation();
-- Result is a decision about a command, not an additional aggregate state version.
ALTER TABLE fulfillment_outbox DROP CONSTRAINT fulfillment_outbox_order_id_aggregate_version_key;
CREATE UNIQUE INDEX fulfillment_outbox_state_version_unique ON fulfillment_outbox(order_id,aggregate_version) WHERE event_type<>'edge.admission_release_result';
