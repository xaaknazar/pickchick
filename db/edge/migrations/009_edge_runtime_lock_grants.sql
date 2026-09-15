-- Runtime row locks must not confer the ability to change staff authority.
-- PostgreSQL requires UPDATE on at least one column for SELECT FOR SHARE/UPDATE.
ALTER TABLE local_staff ADD COLUMN lock_anchor boolean NOT NULL DEFAULT false CHECK (NOT lock_anchor);
ALTER TABLE local_terminals ADD COLUMN lock_anchor boolean NOT NULL DEFAULT false CHECK (NOT lock_anchor);
ALTER TABLE staff_sessions ADD COLUMN lock_anchor boolean NOT NULL DEFAULT false CHECK (NOT lock_anchor);
ALTER TABLE fulfillment_config ADD COLUMN lock_anchor boolean NOT NULL DEFAULT false CHECK (NOT lock_anchor);
ALTER TABLE fulfillment_stations ADD COLUMN lock_anchor boolean NOT NULL DEFAULT false CHECK (NOT lock_anchor);
ALTER TABLE fulfillment_station_grants ADD COLUMN lock_anchor boolean NOT NULL DEFAULT false CHECK (NOT lock_anchor);
