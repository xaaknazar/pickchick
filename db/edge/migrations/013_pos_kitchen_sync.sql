-- Delivery state for edge-owned kitchen observations uses a separate stream/lease.
CREATE TABLE pos_kitchen_sync_state (
  branch_id uuid PRIMARY KEY REFERENCES pos_order_sync_state(branch_id),
  lease_token uuid,
  lease_until timestamptz,
  pending_event_id uuid REFERENCES fulfillment_outbox(event_id),
  pending_envelope jsonb,
  pending_hash text,
  failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 1000000),
  retry_after timestamptz,
  last_error text CHECK(last_error IN('NETWORK_UNKNOWN','HTTP_REJECTED','INVALID_RESPONSE','CONFLICT')),
  dead_lettered_at timestamptz,
  CHECK((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK((pending_event_id IS NULL AND pending_envelope IS NULL AND pending_hash IS NULL)
    OR (pending_event_id IS NOT NULL AND pending_envelope IS NOT NULL AND pending_hash IS NOT NULL
      AND jsonb_typeof(pending_envelope)='object' AND pending_hash ~ '^[a-f0-9]{64}$')),
  CHECK(dead_lettered_at IS NULL OR pending_event_id IS NOT NULL)
);
CREATE FUNCTION guard_pos_kitchen_sync_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
    RAISE EXCEPTION 'Kitchen sync scope cannot change' USING ERRCODE='23514';
  END IF;
  IF OLD.pending_event_id IS NOT NULL AND NEW.pending_event_id IS NOT NULL
    AND ROW(NEW.pending_event_id,NEW.pending_envelope,NEW.pending_hash)
      IS DISTINCT FROM ROW(OLD.pending_event_id,OLD.pending_envelope,OLD.pending_hash) THEN
    RAISE EXCEPTION 'Pending kitchen delivery is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER pos_kitchen_sync_state_guard BEFORE UPDATE OR DELETE ON pos_kitchen_sync_state
FOR EACH ROW EXECUTE FUNCTION guard_pos_kitchen_sync_state();
INSERT INTO pos_kitchen_sync_state(branch_id) SELECT branch_id FROM pos_order_sync_state;
CREATE INDEX pos_kitchen_sync_pending_idx ON fulfillment_outbox(branch_id,sequence)
WHERE acknowledged_at IS NULL AND payload->>'commercialOwner'='edge_pos';
