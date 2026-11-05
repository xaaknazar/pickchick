-- Cutover 19.11.2026, lane kds (docs/architecture/cutover-2026-11-contracts.md, section 3.3).
-- Additive only and independent of 026: the KDS layout switch, its audit, immutable layouts and
-- the courier handover journal. Nothing an installed runtime runs reads these tables; the new
-- runtime finds them with to_regclass and keeps today's kitchen flow while layout_enabled is
-- false (the default). Rows are insert-only, except the one-time reported_at of the journals and
-- the kds_settings row, which only moves to its next audited version. Stations and their grants
-- are data (provisionKdsStations), not DDL. Grants: infra/windows/kds-grants.mjs.

CREATE FUNCTION reject_kds_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KDS history is append-only' USING ERRCODE = '23514';
END $$;

-- A journal row is final; only reported_at may be set, once (cloud report, P1).
CREATE FUNCTION guard_kds_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'KDS journal rows cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'reported_at') IS DISTINCT FROM (to_jsonb(OLD) - 'reported_at')
    OR OLD.reported_at IS NOT NULL OR NEW.reported_at IS NULL THEN
    RAISE EXCEPTION 'A KDS journal row is final; it is reported once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Audit of every settings version: operator tool (kds-switch.mjs) or, P1, a shift manager.
CREATE TABLE kds_setting_changes (
  command_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
  field text NOT NULL CHECK (field IN ('provisioned', 'active_layout_version', 'layout_enabled', 'shift_mode')),
  value text CHECK (length(value) BETWEEN 1 AND 40),
  actor text NOT NULL CHECK (actor IN ('operator', 'shift_manager')),
  staff_id uuid,
  terminal_id uuid,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reported_at timestamptz,
  UNIQUE (branch_id, version),
  FOREIGN KEY (staff_id, branch_id) REFERENCES local_staff(id, branch_id),
  FOREIGN KEY (terminal_id, branch_id) REFERENCES local_terminals(id, branch_id),
  CHECK ((actor = 'shift_manager') = (staff_id IS NOT NULL)),
  CHECK ((actor = 'shift_manager') = (terminal_id IS NOT NULL)),
  CHECK ((field = 'provisioned') = (value IS NULL))
);
CREATE INDEX kds_setting_changes_unreported_idx ON kds_setting_changes(branch_id, recorded_at, command_id)
  WHERE reported_at IS NULL;
CREATE TRIGGER kds_setting_changes_guard BEFORE UPDATE OR DELETE ON kds_setting_changes
FOR EACH ROW EXECUTE FUNCTION guard_kds_journal();

-- Every applied layout version, exactly as validated (KdsLayoutSchema); never changed.
CREATE TABLE kds_layouts (
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
  layout jsonb NOT NULL CHECK (jsonb_typeof(layout) = 'object'),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  source text NOT NULL CHECK (source IN ('operator', 'station_plan')),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  PRIMARY KEY (branch_id, version),
  CHECK (layout->'schema_version' = '1'::jsonb),
  CHECK (layout->>'branch_id' = branch_id::text),
  CHECK (layout->'version' = to_jsonb(version)),
  CHECK (jsonb_typeof(layout->'stations') = 'array')
);
CREATE TRIGGER kds_layouts_immutable BEFORE UPDATE OR DELETE ON kds_layouts
FOR EACH ROW EXECUTE FUNCTION reject_kds_history_mutation();

-- One row per branch: the instant switch on the point (works without WAN). Each change is a new
-- version that must have its audit row in the same transaction (deferred foreign key).
CREATE TABLE kds_settings (
  branch_id uuid PRIMARY KEY REFERENCES branch_config(id),
  layout_enabled boolean NOT NULL DEFAULT false,
  active_layout_version integer,
  shift_mode text NOT NULL DEFAULT 'normal' CHECK (shift_mode IN ('morning', 'normal', 'peak')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (branch_id, active_layout_version) REFERENCES kds_layouts(branch_id, version),
  FOREIGN KEY (branch_id, version) REFERENCES kds_setting_changes(branch_id, version)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (NOT layout_enabled OR active_layout_version IS NOT NULL)
);
CREATE FUNCTION guard_kds_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'KDS settings cannot be removed' USING ERRCODE = '23514';
  END IF;
  IF NEW.branch_id <> OLD.branch_id OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'A KDS settings change is the next audited version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kds_settings_guard BEFORE UPDATE OR DELETE ON kds_settings
FOR EACH ROW EXECUTE FUNCTION guard_kds_settings();

-- Courier handover of a delivery order with the three protocol marks (Аг9), written in the same
-- transaction as its handoff.
CREATE TABLE delivery_handovers (
  order_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  provider text NOT NULL CHECK (provider IN ('yandex_eda', 'glovo')),
  external_number text NOT NULL CHECK (external_number ~ '^[A-Z0-9-]{3,40}$'),
  number_matched boolean NOT NULL CHECK (number_matched),
  courier_accepted boolean NOT NULL CHECK (courier_accepted),
  photo_taken boolean NOT NULL CHECK (photo_taken),
  station_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  handed_over_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reported_at timestamptz,
  FOREIGN KEY (branch_id, order_id) REFERENCES fulfillment_reservations(branch_id, order_id),
  FOREIGN KEY (branch_id, station_id) REFERENCES fulfillment_stations(branch_id, id),
  FOREIGN KEY (staff_id, branch_id) REFERENCES local_staff(id, branch_id),
  FOREIGN KEY (terminal_id, branch_id) REFERENCES local_terminals(id, branch_id)
);
CREATE INDEX delivery_handovers_recent_idx ON delivery_handovers(branch_id, handed_over_at DESC);
CREATE INDEX delivery_handovers_unreported_idx ON delivery_handovers(branch_id, handed_over_at, order_id)
  WHERE reported_at IS NULL;
CREATE TRIGGER delivery_handovers_guard BEFORE UPDATE OR DELETE ON delivery_handovers
FOR EACH ROW EXECUTE FUNCTION guard_kds_journal();

-- Courier protocol refusals; incident_id is the client's Idempotency-Key.
CREATE TABLE courier_incidents (
  incident_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  order_id uuid,
  provider text NOT NULL CHECK (provider IN ('yandex_eda', 'glovo', 'other')),
  claimed_number text CHECK (claimed_number ~ '^[A-Za-z0-9-]{1,40}$'),
  kind text NOT NULL CHECK (kind IN ('number_mismatch', 'not_accepted_in_app', 'no_photo', 'courier_refused', 'other')),
  description text NOT NULL CHECK (length(description) BETWEEN 3 AND 500),
  station_id uuid,
  staff_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reported_at timestamptz,
  FOREIGN KEY (branch_id, order_id) REFERENCES fulfillment_reservations(branch_id, order_id),
  FOREIGN KEY (branch_id, station_id) REFERENCES fulfillment_stations(branch_id, id),
  FOREIGN KEY (staff_id, branch_id) REFERENCES local_staff(id, branch_id),
  FOREIGN KEY (terminal_id, branch_id) REFERENCES local_terminals(id, branch_id)
);
CREATE INDEX courier_incidents_recent_idx ON courier_incidents(branch_id, recorded_at DESC);
CREATE INDEX courier_incidents_unreported_idx ON courier_incidents(branch_id, recorded_at, incident_id)
  WHERE reported_at IS NULL;
CREATE TRIGGER courier_incidents_guard BEFORE UPDATE OR DELETE ON courier_incidents
FOR EACH ROW EXECUTE FUNCTION guard_kds_journal();
