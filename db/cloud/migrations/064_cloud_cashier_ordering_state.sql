-- Release fixes 2026-10-19 (audit 1.0/1.1). The cashier reports in its heartbeat when ordering is
-- closed on the POS: such a cashier refuses every new admission, so kiosk and mobile must not
-- take money for it. An edge that never reports the field stays "accepting", as before.
-- Additive and idempotent; the existing table-level grants already cover the new column.
ALTER TABLE cloud_branch_availability ADD COLUMN IF NOT EXISTS ordering_closed boolean NOT NULL DEFAULT false;
