-- Catalog publication is distinct from installation on the restaurant edge.
CREATE TABLE catalog_menu_deliveries (
 branch_id uuid NOT NULL,
 catalog_version integer NOT NULL,
 release_id uuid NOT NULL UNIQUE,
 device_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,catalog_version),
 FOREIGN KEY(branch_id,catalog_version) REFERENCES catalog_publications(branch_id,version),
 FOREIGN KEY(release_id,branch_id) REFERENCES menu_releases(id,branch_id),
 FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id)
);
CREATE TRIGGER catalog_menu_delivery_immutable BEFORE UPDATE OR DELETE ON catalog_menu_deliveries
 FOR EACH ROW EXECUTE FUNCTION catalog_reject_mutation();
