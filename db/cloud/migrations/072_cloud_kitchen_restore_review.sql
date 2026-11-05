-- Observations from a restored POS timeline. Never overwrite canonical order/payment state.
CREATE TABLE pos_kitchen_restore_conflicts (
 event_id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 device_id uuid NOT NULL REFERENCES devices(id),
 producer_id uuid NOT NULL,
 producer_sequence bigint NOT NULL CHECK(producer_sequence > 0),
 order_id uuid NOT NULL REFERENCES pos_order_sync_projection(order_id),
 aggregate_version integer NOT NULL CHECK(aggregate_version > 0),
 restore_id uuid NOT NULL,
 canonical_version integer NOT NULL,
 reason text NOT NULL CHECK(reason IN ('version_collision','restore_timeline')),
 payload_hash text NOT NULL CHECK(length(payload_hash)=64),
 envelope jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(producer_id,producer_sequence)
);
CREATE INDEX pos_kitchen_restore_pending ON pos_kitchen_restore_conflicts(branch_id,received_at,event_id);
CREATE TABLE pos_kitchen_restore_decisions (
 event_id uuid PRIMARY KEY REFERENCES pos_kitchen_restore_conflicts(event_id),
 command_id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_pos_kitchen_restore_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Restore review history is append-only' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER pos_kitchen_restore_conflicts_guard BEFORE UPDATE OR DELETE ON pos_kitchen_restore_conflicts
 FOR EACH ROW EXECUTE FUNCTION guard_pos_kitchen_restore_history();
CREATE TRIGGER pos_kitchen_restore_decisions_guard BEFORE UPDATE OR DELETE ON pos_kitchen_restore_decisions
 FOR EACH ROW EXECUTE FUNCTION guard_pos_kitchen_restore_history();
