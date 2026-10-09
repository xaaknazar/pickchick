-- Back-office stop commands received by the fulfillment worker (protocol 4). The worker may only
-- insert them and mark a verdict as reported; the edge service applies them to local_stops.
CREATE TABLE remote_stop_commands (
  command_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  variant_id uuid NOT NULL,
  stopped boolean NOT NULL,
  duration text NOT NULL CHECK (duration IN ('manual','hour','shift')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  actor_label text NOT NULL CHECK (length(actor_label) BETWEEN 1 AND 100),
  issued_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL DEFAULT 'received'
    CHECK (state IN ('received','applied','conflict','not_found','no_open_shift','expired')),
  result_version integer CHECK (result_version >= 0),
  -- Time of the verdict, whatever it is (not only 'applied').
  applied_at timestamptz,
  reported_at timestamptz,
  CHECK ((state = 'received') = (applied_at IS NULL)),
  CHECK (result_version IS NULL OR state IN ('applied','conflict')),
  CHECK (reported_at IS NULL OR state <> 'received')
);
CREATE INDEX remote_stop_commands_received_idx ON remote_stop_commands(branch_id,received_at,command_id)
  WHERE state = 'received';
CREATE INDEX remote_stop_commands_unreported_idx ON remote_stop_commands(branch_id,applied_at,command_id)
  WHERE state <> 'received' AND reported_at IS NULL;

CREATE FUNCTION guard_remote_stop_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Remote stop commands cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'received' OR NEW.applied_at IS NOT NULL OR NEW.reported_at IS NOT NULL OR NEW.result_version IS NOT NULL THEN
      RAISE EXCEPTION 'Remote stop commands must start received' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.command_id,NEW.branch_id,NEW.variant_id,NEW.stopped,NEW.duration,NEW.reason,NEW.expected_version,
      NEW.actor_label,NEW.issued_at,NEW.received_at)
    IS DISTINCT FROM
     (OLD.command_id,OLD.branch_id,OLD.variant_id,OLD.stopped,OLD.duration,OLD.reason,OLD.expected_version,
      OLD.actor_label,OLD.issued_at,OLD.received_at) THEN
    RAISE EXCEPTION 'Remote stop command is immutable' USING ERRCODE='23514';
  END IF;
  -- One verdict per command, then at most one report of it.
  IF OLD.state<>'received' AND (NEW.state,NEW.result_version,NEW.applied_at) IS DISTINCT FROM (OLD.state,OLD.result_version,OLD.applied_at) THEN
    RAISE EXCEPTION 'Remote stop verdict is final' USING ERRCODE='23514';
  END IF;
  IF OLD.reported_at IS NOT NULL AND NEW.reported_at IS DISTINCT FROM OLD.reported_at THEN
    RAISE EXCEPTION 'Remote stop report is final' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER remote_stop_command_guard BEFORE INSERT OR UPDATE OR DELETE ON remote_stop_commands
FOR EACH ROW EXECUTE FUNCTION guard_remote_stop_command();

-- Full stop history: value, reason, duration and who (cashier or back-office actor) changed it.
CREATE TABLE local_stop_events (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  variant_id uuid NOT NULL,
  stopped boolean NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  source text NOT NULL CHECK (source IN ('pos','backoffice')),
  staff_id uuid REFERENCES local_staff(id),
  command_id uuid REFERENCES remote_stop_commands(command_id),
  actor_label text CHECK (length(actor_label) BETWEEN 1 AND 100),
  duration text NOT NULL CHECK (duration IN ('manual','hour','shift')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((source = 'pos' AND staff_id IS NOT NULL AND command_id IS NULL)
    OR (source = 'backoffice' AND staff_id IS NULL AND command_id IS NOT NULL AND actor_label IS NOT NULL)),
  UNIQUE (branch_id, variant_id, version)
);
CREATE INDEX local_stop_events_time_idx ON local_stop_events(branch_id,occurred_at DESC,id);
CREATE FUNCTION guard_local_stop_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Stop events are append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER local_stop_event_guard BEFORE UPDATE OR DELETE ON local_stop_events
FOR EACH ROW EXECUTE FUNCTION guard_local_stop_event();

ALTER TABLE local_stops ADD COLUMN source text NOT NULL DEFAULT 'pos' CHECK (source IN ('pos','backoffice'));
