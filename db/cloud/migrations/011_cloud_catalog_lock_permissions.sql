-- PostgreSQL row locks require an UPDATE privilege. Give the application a
-- constrained no-op column instead of permission to change credentials/scopes.
ALTER TABLE catalog_managers ADD COLUMN lock_anchor boolean NOT NULL DEFAULT true CHECK(lock_anchor IS TRUE);
ALTER TABLE catalog_manager_branches ADD COLUMN lock_anchor boolean NOT NULL DEFAULT true CHECK(lock_anchor IS TRUE);
