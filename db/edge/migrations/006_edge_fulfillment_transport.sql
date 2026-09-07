-- Transport owns only delivery progress; fulfillment inbox/outbox and reservations remain durable.
CREATE TABLE fulfillment_transport_state (
  branch_id uuid PRIMARY KEY REFERENCES fulfillment_config(branch_id),
  worker_id uuid,
  lease_token uuid,
  lease_until timestamptz,
  pending_cloud jsonb,
  last_error text CHECK (last_error IN ('NETWORK_UNKNOWN','HTTP_REJECTED','INVALID_RESPONSE','LOCAL_CONFLICT','LOCAL_NOT_READY','LOCAL_ROUTING_MISSING','LOCAL_STORAGE_UNKNOWN','SCOPE_MISMATCH')),
  last_success_at timestamptz,
  attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((worker_id IS NULL AND lease_token IS NULL AND lease_until IS NULL) OR (worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (pending_cloud IS NULL OR (jsonb_typeof(pending_cloud)='object' AND octet_length(pending_cloud::text)<=1300000))
);

-- Only a confirmed deterministic domain rollback may be parked. Unknown network
-- or COMMIT outcomes remain pending; neither path acknowledges the cloud row.
CREATE TABLE fulfillment_transport_failures (
  event_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES fulfillment_config(branch_id),
  scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object'),
  command jsonb NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=1300000),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK(reason='LOCAL_ROUTING_MISSING'),
  attempts bigint NOT NULL DEFAULT 1 CHECK(attempts>0),
  first_failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz
);
CREATE INDEX fulfillment_transport_failures_unresolved_idx ON fulfillment_transport_failures(branch_id,event_id) WHERE resolved_at IS NULL;
CREATE FUNCTION guard_fulfillment_transport_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['attempts','last_failed_at','resolved_at','retry_after','last_error']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['attempts','last_failed_at','resolved_at','retry_after','last_error'])
 THEN RAISE EXCEPTION 'Delivery failure identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fulfillment_transport_failure_guard BEFORE UPDATE OR DELETE ON fulfillment_transport_failures FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_transport_failure();

CREATE TABLE fulfillment_transport_reverse_failures (
 event_id uuid PRIMARY KEY REFERENCES fulfillment_outbox(event_id),
 branch_id uuid NOT NULL REFERENCES fulfillment_config(branch_id),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 last_error text NOT NULL CHECK(last_error IN ('NETWORK_UNKNOWN','HTTP_REJECTED','INVALID_RESPONSE','LOCAL_CONFLICT','LOCAL_NOT_READY','LOCAL_ROUTING_MISSING','LOCAL_STORAGE_UNKNOWN','SCOPE_MISMATCH')),
 attempts integer NOT NULL DEFAULT 1 CHECK(attempts>0),
 retry_after timestamptz NOT NULL,
 first_failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 resolved_at timestamptz
);
CREATE INDEX fulfillment_transport_reverse_retry_idx ON fulfillment_transport_reverse_failures(branch_id,retry_after) WHERE resolved_at IS NULL;
CREATE TRIGGER fulfillment_transport_reverse_guard BEFORE UPDATE OR DELETE ON fulfillment_transport_reverse_failures FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_transport_failure();
