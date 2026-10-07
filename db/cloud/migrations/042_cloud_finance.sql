-- Management accounting only. Never creates bank captures or fiscal receipts.
CREATE TABLE bo_finance_accounts (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 kind text NOT NULL CHECK(kind IN ('cash','bank','wallet')),
 opening_date date NOT NULL,
 opening_minor bigint NOT NULL,
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(branch_id,id), UNIQUE(branch_id,name)
);
CREATE TABLE bo_finance_entries (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 cash_date date,
 recognition_date date,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(branch_id,id),
 CHECK(cash_date IS NOT NULL OR recognition_date IS NOT NULL)
);
CREATE INDEX bo_finance_cash_idx ON bo_finance_entries(branch_id,cash_date);
CREATE INDEX bo_finance_recognition_idx ON bo_finance_entries(branch_id,recognition_date);
CREATE TABLE bo_finance_voids (
 entry_id uuid PRIMARY KEY,
 branch_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,entry_id) REFERENCES bo_finance_entries(branch_id,id)
);
CREATE TABLE bo_finance_periods (
 branch_id uuid NOT NULL REFERENCES branches(id),
 month date NOT NULL CHECK(extract(day FROM month)=1),
 closed boolean NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 PRIMARY KEY(branch_id,month)
);
CREATE TABLE bo_finance_commands (
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 request_id uuid NOT NULL,
 branch_id uuid NOT NULL REFERENCES branches(id),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_id)
);
CREATE TRIGGER bo_finance_accounts_immutable BEFORE UPDATE OR DELETE ON bo_finance_accounts FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_finance_entries_immutable BEFORE UPDATE OR DELETE ON bo_finance_entries FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_finance_voids_immutable BEFORE UPDATE OR DELETE ON bo_finance_voids FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_finance_commands_immutable BEFORE UPDATE OR DELETE ON bo_finance_commands FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
