-- Daily payment reconciliation, draft for the accountant (stage 2, lane rec, 24.10.2026).
-- Management control only: nothing here creates, confirms or changes captures, refunds,
-- fiscal documents, orders or bank state. External facts (statement lines, manual totals) are
-- kept apart from PickChick money facts; matching is recomputed from both on every read.
-- Additive: new tables only. Runtime access is granted by infra/staging/reconciliation-grants.mjs.

-- Analysts are read-only everywhere. The operator may designate an analyst of a branch as its
-- accountant for reconciliation writes only; bo_access_grants and every other section keep the
-- existing manager/analyst roles. Append-only: the latest row per actor/branch is in force.
CREATE TABLE bo_rec_accountants (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 branch_id uuid NOT NULL REFERENCES branches(id),
 enabled boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX bo_rec_accountants_actor_idx ON bo_rec_accountants(actor_id,branch_id,id DESC);

-- Column-mapping profiles for statement CSV files. The bank format is not confirmed, so the
-- mapping is data, edited by the accountant; every import keeps its own copy of the mapping.
CREATE TABLE bo_rec_profiles (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 revision integer NOT NULL CHECK(revision>0),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 mapping jsonb NOT NULL CHECK(jsonb_typeof(mapping)='object'),
 archived boolean NOT NULL DEFAULT false,
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(branch_id,id),
 UNIQUE(branch_id,name)
);

CREATE TABLE bo_rec_imports (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 profile_id uuid,
 mapping jsonb NOT NULL CHECK(jsonb_typeof(mapping)='object'),
 source text NOT NULL CHECK(source IN ('kaspi','tiptoppay','cash','other')),
 file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 200),
 file_digest text NOT NULL CHECK(file_digest ~ '^[a-f0-9]{64}$'),
 line_count integer NOT NULL CHECK(line_count>=0),
 skipped_count integer NOT NULL CHECK(skipped_count>=0),
 duplicate_count integer NOT NULL CHECK(duplicate_count>=0),
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(branch_id,id)
);
CREATE INDEX bo_rec_imports_digest_idx ON bo_rec_imports(branch_id,file_digest);
CREATE TABLE bo_rec_import_voids (
 import_id uuid PRIMARY KEY,
 branch_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,import_id) REFERENCES bo_rec_imports(branch_id,id)
);

-- One statement line = one external fact. Signed integer minor units: positive is money in,
-- negative is a refund/outgoing operation. business_day is the Asia/Almaty calendar day.
CREATE TABLE bo_rec_lines (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL,
 import_id uuid NOT NULL,
 row_number integer NOT NULL CHECK(row_number>0),
 source text NOT NULL CHECK(source IN ('kaspi','tiptoppay','cash','other')),
 method text CHECK(method IN ('kaspi_remote','kaspi_qr','kaspi_pos','kaspi_other','manual_refund','tiptoppay','cash','other')),
 business_day date NOT NULL,
 occurred_at timestamptz NOT NULL,
 time_precision text NOT NULL CHECK(time_precision IN ('second','minute','day')),
 amount_minor bigint NOT NULL CHECK(amount_minor<>0),
 fee_minor bigint NOT NULL DEFAULT 0 CHECK(fee_minor>=0),
 operation_id text CHECK(length(operation_id) BETWEEN 1 AND 160),
 reference text CHECK(length(reference) BETWEEN 1 AND 160),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=300),
 window_seconds integer NOT NULL CHECK(window_seconds BETWEEN 60 AND 7200),
 FOREIGN KEY(branch_id,import_id) REFERENCES bo_rec_imports(branch_id,id),
 UNIQUE(import_id,row_number)
);
CREATE INDEX bo_rec_lines_day_idx ON bo_rec_lines(branch_id,business_day);
CREATE INDEX bo_rec_lines_operation_idx ON bo_rec_lines(branch_id,operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX bo_rec_lines_reference_idx ON bo_rec_lines(branch_id,reference) WHERE reference IS NOT NULL;

-- Manual bank/ККМ total for a method and day, with a mandatory comment. Corrections void the
-- old row and add a new one; nothing is rewritten.
CREATE TABLE bo_rec_totals (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 business_day date NOT NULL,
 method text NOT NULL CHECK(method IN ('kaspi_remote','kaspi_qr','kaspi_pos','kaspi_other','manual_refund','tiptoppay','cash','other')),
 source text NOT NULL CHECK(source IN ('bank','kkm')),
 amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN -99999999999999 AND 99999999999999),
 comment text NOT NULL CHECK(length(comment) BETWEEN 3 AND 500),
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(branch_id,id)
);
CREATE INDEX bo_rec_totals_day_idx ON bo_rec_totals(branch_id,business_day);
CREATE TABLE bo_rec_total_voids (
 total_id uuid PRIMARY KEY,
 branch_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,total_id) REFERENCES bo_rec_totals(branch_id,id)
);

-- Owner, status and comment of one difference. The resolution is bound to the exact state and
-- amount it was made for: if the computed difference changes, it is open again.
-- History lives in bo_audit (before/after of every change).
CREATE TABLE bo_rec_items (
 branch_id uuid NOT NULL REFERENCES branches(id),
 business_day date NOT NULL,
 item_key text NOT NULL CHECK(item_key ~ '^[a-z]+:[a-z0-9:_-]{1,200}$'),
 revision integer NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('late','amount_differs','missing_in_bank','missing_in_pickchick','duplicate')),
 amount_minor bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('open','in_progress','resolved','accepted')),
 assignee_id uuid REFERENCES catalog_managers(id),
 comment text NOT NULL DEFAULT '' CHECK(length(comment)<=1000),
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,business_day,item_key),
 CHECK(status NOT IN ('resolved','accepted') OR length(btrim(comment))>=3)
);

-- Day closing is an append-only event chain per branch/day: revision n+1 follows n, so two
-- concurrent close/reopen attempts cannot both succeed. A close event freezes the report.
CREATE TABLE bo_rec_days (
 branch_id uuid NOT NULL REFERENCES branches(id),
 business_day date NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 kind text NOT NULL CHECK(kind IN ('close','reopen')),
 snapshot jsonb,
 fingerprint text CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,business_day,revision),
 CHECK((kind='close')=(snapshot IS NOT NULL AND fingerprint IS NOT NULL)),
 CHECK(jsonb_typeof(snapshot)='object' OR snapshot IS NULL),
 CHECK((kind='close')=(revision%2=1))
);

CREATE TABLE bo_rec_commands (
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 request_id uuid NOT NULL,
 branch_id uuid NOT NULL REFERENCES branches(id),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_id)
);

CREATE TRIGGER bo_rec_accountants_immutable BEFORE UPDATE OR DELETE ON bo_rec_accountants FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_rec_imports_immutable BEFORE UPDATE OR DELETE ON bo_rec_imports FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_rec_import_voids_immutable BEFORE UPDATE OR DELETE ON bo_rec_import_voids FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_rec_lines_immutable BEFORE UPDATE OR DELETE ON bo_rec_lines FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_rec_totals_immutable BEFORE UPDATE OR DELETE ON bo_rec_totals FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_rec_total_voids_immutable BEFORE UPDATE OR DELETE ON bo_rec_total_voids FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_rec_days_immutable BEFORE UPDATE OR DELETE ON bo_rec_days FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER bo_rec_commands_immutable BEFORE UPDATE OR DELETE ON bo_rec_commands FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
