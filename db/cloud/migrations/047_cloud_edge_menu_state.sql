-- The edge menu worker reports the menu it is actually serving on every pull. Publication
-- uses it to pick a version the edge accepts (its local snapshots may predate cloud sync).
CREATE TABLE edge_menu_state (
 branch_id uuid PRIMARY KEY REFERENCES branches(id),
 device_id uuid NOT NULL,
 active_release_id uuid NOT NULL,
 active_version integer NOT NULL CHECK(active_version > 0),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id)
);
-- Append-only edge verdict per delivered release. A rejected release is acknowledged so it
-- no longer blocks later publications, but it never moves branch_menu_activations.
CREATE TABLE catalog_menu_delivery_results (
 branch_id uuid NOT NULL REFERENCES branches(id),
 release_id uuid PRIMARY KEY,
 result text NOT NULL CHECK(result IN ('applied','rejected')),
 reason text CHECK(reason ~ '^[A-Z][A-Z_]{0,63}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((result = 'rejected') = (reason IS NOT NULL)),
 FOREIGN KEY(release_id,branch_id) REFERENCES menu_releases(id,branch_id)
);
CREATE TRIGGER catalog_menu_delivery_results_immutable BEFORE UPDATE OR DELETE ON catalog_menu_delivery_results
 FOR EACH ROW EXECUTE FUNCTION catalog_reject_mutation();
