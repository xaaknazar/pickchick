-- 007 is reserved by the independent cancellation stage. Merge it before deploy.
CREATE TABLE pos_order_sync_state (
  branch_id uuid PRIMARY KEY REFERENCES branch_config(id),
  organization_id uuid NOT NULL,
  device_id uuid NOT NULL,
  producer_id uuid NOT NULL UNIQUE REFERENCES local_order_streams(producer_id),
  active boolean NOT NULL DEFAULT true,
  lease_token uuid,
  lease_until timestamptz,
  pending_event_id uuid REFERENCES outbox_events(event_id),
  pending_envelope jsonb,
  pending_hash text,
  failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
  retry_after timestamptz,
  last_error text CHECK(last_error IN('NETWORK_UNKNOWN','HTTP_REJECTED','INVALID_RESPONSE','CONFLICT')),
  CHECK((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK((pending_event_id IS NULL AND pending_envelope IS NULL AND pending_hash IS NULL)
    OR (pending_event_id IS NOT NULL AND pending_envelope IS NOT NULL AND pending_hash IS NOT NULL
      AND jsonb_typeof(pending_envelope)='object' AND pending_hash ~ '^[a-f0-9]{64}$'))
);
CREATE FUNCTION guard_pos_sync_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR ROW(NEW.branch_id,NEW.organization_id,NEW.device_id,NEW.producer_id)
    IS DISTINCT FROM ROW(OLD.branch_id,OLD.organization_id,OLD.device_id,OLD.producer_id) THEN
    RAISE EXCEPTION 'POS producer ownership is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.pending_event_id IS NOT NULL AND NEW.pending_event_id IS NOT NULL
    AND ROW(NEW.pending_event_id,NEW.pending_envelope,NEW.pending_hash)
      IS DISTINCT FROM ROW(OLD.pending_event_id,OLD.pending_envelope,OLD.pending_hash) THEN
    RAISE EXCEPTION 'Pending POS delivery is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER pos_sync_state_guard BEFORE UPDATE OR DELETE ON pos_order_sync_state
FOR EACH ROW EXECUTE FUNCTION guard_pos_sync_state();

-- Preserve exactly the historical POS source bytes; only delivery bookkeeping may change.
CREATE FUNCTION guard_pos_sync_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.event_type IN('order.created','order.cancelled') AND OLD.aggregate_type='order_commercial' THEN
    IF TG_OP='DELETE' OR
      (to_jsonb(NEW)-ARRAY['attempts','next_attempt_at','acknowledged_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['attempts','next_attempt_at','acknowledged_at']) THEN
      RAISE EXCEPTION 'POS outbox source is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER pos_sync_source_guard BEFORE UPDATE OR DELETE ON outbox_events
FOR EACH ROW EXECUTE FUNCTION guard_pos_sync_source();
CREATE INDEX pos_order_sync_pending_idx ON outbox_events(branch_id,producer_id,producer_sequence)
WHERE acknowledged_at IS NULL AND aggregate_type='order_commercial' AND event_type IN('order.created','order.cancelled');
