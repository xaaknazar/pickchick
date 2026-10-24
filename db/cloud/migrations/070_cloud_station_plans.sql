-- Station plan delivery to the cashier edge (stage 2, lane cfg). Additive only: nothing here
-- changes bo_publications or bo_delivery_outbox, and nothing is written while
-- BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED is off.
--
-- A plan is the branch's set of published back-office stations at one moment. Versions are
-- allocated under the back-office branch lock and only grow. The edge pulls the newest plan,
-- applies it or rejects it with a reason, and answers with an immutable receipt. A publication
-- in the cloud is never presented as a plan the edge applied.
CREATE TABLE bo_station_plans (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
 schema_version integer NOT NULL CHECK(schema_version=1),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
 -- Station publication that produced the plan; NULL for an explicit "send the plan again".
 publication_id uuid UNIQUE REFERENCES bo_publications(id),
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
 UNIQUE(branch_id,version),
 UNIQUE(id,branch_id),
 CHECK(payload->>'plan_id'=id::text AND payload->>'branch_id'=branch_id::text
  AND (payload->>'version')::integer=version AND (payload->>'schema_version')::integer=schema_version)
);
CREATE TRIGGER bo_station_plans_immutable BEFORE UPDATE OR DELETE ON bo_station_plans
 FOR EACH ROW EXECUTE FUNCTION commerce_immutable();

-- Hand-over of a plan to the authenticated edge (first and latest pull). Delivery is not
-- application: only a receipt says what the edge did.
CREATE TABLE bo_station_plan_deliveries (
 plan_id uuid PRIMARY KEY,
 branch_id uuid NOT NULL,
 device_id uuid NOT NULL,
 first_delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 deliveries integer NOT NULL DEFAULT 1 CHECK(deliveries BETWEEN 1 AND 2147483647),
 FOREIGN KEY(plan_id,branch_id) REFERENCES bo_station_plans(id,branch_id),
 FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id),
 CHECK(last_delivered_at >= first_delivered_at)
);
CREATE FUNCTION bo_station_plan_delivery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Station plan deliveries cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (NEW.plan_id,NEW.branch_id,NEW.first_delivered_at) IS DISTINCT FROM (OLD.plan_id,OLD.branch_id,OLD.first_delivered_at)
   OR NEW.deliveries < OLD.deliveries OR NEW.last_delivered_at < OLD.last_delivered_at THEN
  RAISE EXCEPTION 'Station plan delivery only moves forward' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bo_station_plan_delivery_guard BEFORE UPDATE OR DELETE ON bo_station_plan_deliveries
 FOR EACH ROW EXECUTE FUNCTION bo_station_plan_delivery_guard();

-- The edge verdict, one per plan. A rejected plan leaves the previous plan active on the edge.
CREATE TABLE bo_station_plan_receipts (
 plan_id uuid PRIMARY KEY,
 branch_id uuid NOT NULL,
 device_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
 checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
 result text NOT NULL CHECK(result IN ('applied','rejected')),
 reason text CHECK(reason ~ '^[A-Z][A-Z_]{0,63}$'),
 station_id uuid,
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(plan_id,branch_id) REFERENCES bo_station_plans(id,branch_id),
 FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id),
 CHECK((result='rejected')=(reason IS NOT NULL)),
 CHECK(station_id IS NULL OR result='rejected')
);
CREATE INDEX bo_station_plan_receipts_branch_idx ON bo_station_plan_receipts(branch_id,recorded_at DESC);
CREATE TRIGGER bo_station_plan_receipts_immutable BEFORE UPDATE OR DELETE ON bo_station_plan_receipts
 FOR EACH ROW EXECUTE FUNCTION commerce_immutable();

-- What the edge reports on every pull: the plan it serves now and its local kitchen stations
-- (for binding plan stations in the cabinet). Observation only, never a command.
CREATE TABLE bo_station_plan_edge_state (
 branch_id uuid PRIMARY KEY REFERENCES branches(id),
 device_id uuid NOT NULL,
 active_plan_id uuid,
 active_version integer CHECK(active_version BETWEEN 1 AND 2147483647),
 stations jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK(jsonb_typeof(stations)='array' AND jsonb_array_length(stations)<=50),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id),
 CHECK((active_plan_id IS NULL)=(active_version IS NULL))
);
