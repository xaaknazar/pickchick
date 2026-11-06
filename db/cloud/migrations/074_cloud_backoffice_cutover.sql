-- Cutover 19.11.2026, lane cloud (CC-5 roles, CC-6 stock v2; docs/architecture/
-- cutover-2026-11-contracts.md 2.1, 3.3, 5.10, 6.1). Additive only: one new table and two
-- nullable columns. No foreign key to cloud_pos_* (073). Enum lists copy
-- packages/contracts/src/cutover-enums.ts verbatim (BackofficeDesignation, StockWasteReason).
-- The runtime reads these only behind BACKOFFICE_ROLES_ENABLED / BACKOFFICE_STOCK_V2_ENABLED
-- (both off by default); rights come from infra/staging/backoffice-cutover-grants.mjs. A runtime
-- without this migration keeps working (to_regclass / column checks), and the previous runtime
-- never reads or writes anything below.

-- 1. Back-office role designations (A12, Б4). The operator designates a personal login that has
-- an analyst grant (bo_access_grants) as shift manager or accountant of one branch. A manager
-- grant always wins. Append-only: the latest row per actor/branch is in force; role NULL
-- withdraws the designation. Written only by the trusted local setup (scripts/backoffice-setup.mjs
-- --designation), never over HTTP.
CREATE TABLE bo_role_designations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 branch_id uuid NOT NULL REFERENCES branches(id),
 role text NULL CHECK(role IN ('shift_manager','accountant')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 source text NOT NULL DEFAULT 'trusted_local_setup' CHECK(source='trusted_local_setup'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX bo_role_designations_actor_idx ON bo_role_designations(actor_id,branch_id,id DESC);
CREATE TRIGGER bo_role_designations_immutable BEFORE UPDATE OR DELETE ON bo_role_designations FOR EACH ROW EXECUTE FUNCTION commerce_immutable();

-- 2. Stock documents v2 (Ск5, Ск1): waste reason code and receipt metadata (supplier kind and
-- name, document date). Old rows and the previous runtime leave both NULL. That a waste needs a
-- reason is checked by the stock command while BACKOFFICE_STOCK_V2_ENABLED is on, not by a
-- CHECK: documents written before the switch stay valid without a date in the DDL.
ALTER TABLE bo_stock_documents ADD COLUMN reason_code text NULL
 CHECK(reason_code IN ('hot_cabinet_expired','meat_expired','defect','prep_expired','damaged','returned_after_cooking','rework','other'));
ALTER TABLE bo_stock_documents ADD COLUMN meta jsonb NULL
 CHECK(meta IS NULL OR jsonb_typeof(meta)='object');
