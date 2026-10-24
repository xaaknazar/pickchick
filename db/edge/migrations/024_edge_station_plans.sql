-- Station plans from the back-office (stage 2, lane cfg). Additive only. The menu-sync worker
-- applies them while EDGE_STATION_PLAN_SYNC_MODE=apply; nothing in order admission, kitchen
-- routing or the POS reads these tables, so an installed runtime is unaffected by them.

-- Every applied plan, exactly as delivered (checksum over the canonical JSON).
CREATE TABLE station_plan_snapshots (
  plan_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (branch_id, version),
  UNIQUE (plan_id, branch_id, version)
);
CREATE TRIGGER station_plan_snapshots_immutable BEFORE UPDATE OR DELETE ON station_plan_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_menu_snapshot_mutation();

-- The plan the kitchen configuration currently follows. Only a strictly newer plan replaces it.
CREATE TABLE station_plan_active (
  branch_id uuid PRIMARY KEY REFERENCES branch_config(id),
  plan_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (plan_id, branch_id, version) REFERENCES station_plan_snapshots(plan_id, branch_id, version)
);
CREATE FUNCTION guard_station_plan_active() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'The active station plan cannot be removed' USING ERRCODE = '23514';
  END IF;
  IF NEW.branch_id <> OLD.branch_id OR NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'Only a newer station plan may become active' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER station_plan_active_guard BEFORE UPDATE OR DELETE ON station_plan_active
FOR EACH ROW EXECUTE FUNCTION guard_station_plan_active();

-- Inbox and durable outbox in one: one verdict per delivered plan, reported to the cloud once.
CREATE TABLE station_plan_receipts (
  plan_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  result text NOT NULL CHECK (result IN ('applied', 'rejected')),
  reason text CHECK (
    reason IN ('SCHEMA_UNSUPPORTED', 'INVALID_PLAN', 'VERSION_NOT_NEWER', 'UNKNOWN_STATION',
      'STATION_KIND_MISMATCH')
  ),
  station_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reported_at timestamptz,
  CHECK ((result = 'rejected') = (reason IS NOT NULL)),
  CHECK (station_id IS NULL OR result = 'rejected')
);
CREATE INDEX station_plan_receipts_unreported_idx ON station_plan_receipts(branch_id, recorded_at, plan_id)
  WHERE reported_at IS NULL;
CREATE FUNCTION guard_station_plan_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Station plan receipts cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.plan_id, NEW.branch_id, NEW.version, NEW.checksum, NEW.result, NEW.reason, NEW.station_id,
      NEW.recorded_at)
    IS DISTINCT FROM
     (OLD.plan_id, OLD.branch_id, OLD.version, OLD.checksum, OLD.result, OLD.reason, OLD.station_id,
      OLD.recorded_at)
    OR OLD.reported_at IS NOT NULL OR NEW.reported_at IS NULL THEN
    RAISE EXCEPTION 'A station plan receipt is final; it is reported once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER station_plan_receipt_guard BEFORE UPDATE OR DELETE ON station_plan_receipts
FOR EACH ROW EXECUTE FUNCTION guard_station_plan_receipt();
