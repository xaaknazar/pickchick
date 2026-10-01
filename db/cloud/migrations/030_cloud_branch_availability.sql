-- Edge owns stops. Device binding and strictly increasing transport revision prevent stale replay.
CREATE TABLE cloud_branch_availability (
 branch_id uuid PRIMARY KEY REFERENCES branches(id),
 device_id uuid NOT NULL REFERENCES devices(id),
 revision bigint NOT NULL CHECK(revision>0),
 stopped_ids uuid[] NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(cardinality(stopped_ids)<=5000)
);
