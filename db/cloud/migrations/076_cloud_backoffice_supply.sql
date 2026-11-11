-- Cutover 19.11.2026, lane bo-ui2 (owner decision 06.11: the second wave of the back office -
-- suppliers and their prices, supply requests, stock reports, staff assignment - is built now
-- behind API flags that default to off; docs/architecture/cutover-2026-11/design-bo-ui.md
-- «Вторая волна», design-backoffice.md sections 2 (Ск6, А9) and 3). Additive only and compatible
-- both ways:
-- - nothing that exists is altered: only new tables with their own functions, triggers and
--   indexes, so the bo-ui runtime (075) reads and writes exactly as before;
-- - the bo-ui2 runtime works on 075 without this file (to_regclass / privilege checks).
-- No foreign key to cloud_pos_* (073). Rights come only from
-- infra/staging/backoffice-supply-grants.mjs. Money is bigint whole tiyn (inside jsonb lines a
-- string of whole tiyn). Quantities are whole accounting units of the ingredient (g, ml, pcs), as
-- in bo_stock_balances. Revisioned rows use guard_bo_revision() of 075: never deleted, revision 1
-- first, +1 on every change, identity columns immutable.

-- 1. Suppliers of a branch (Ск1, Ск6): the central kitchen, the bakery and outside suppliers. The
-- real list comes from the owner's iiko export through scripts/supplier-prices-import.mjs. A name
-- is unique in the branch regardless of case (the import matches suppliers by name); the kind
-- never changes, because requests and prices of a supplier depend on it.
CREATE TABLE bo_suppliers (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 name text NOT NULL CHECK(name=btrim(name) AND length(name) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
 kind text NOT NULL CHECK(kind IN ('supplier','central_kitchen','bakery')),
 active boolean NOT NULL DEFAULT true,
 revision integer NOT NULL CHECK(revision>0),
 created_by uuid NOT NULL REFERENCES catalog_managers(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_by uuid NOT NULL REFERENCES catalog_managers(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,branch_id)
);
CREATE UNIQUE INDEX bo_suppliers_name_idx ON bo_suppliers(branch_id,lower(name));
CREATE TRIGGER bo_suppliers_revision BEFORE INSERT OR UPDATE OR DELETE ON bo_suppliers
FOR EACH ROW EXECUTE FUNCTION guard_bo_revision('id','branch_id','kind','created_by','created_at');

-- 2. One applied price import (scripts/supplier-prices-import.mjs: plan, its SHA-256, then
-- --apply --expected-plan). A plan is applied at most once per branch; the batch never changes.
CREATE TABLE bo_supplier_price_imports (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 source text NOT NULL CHECK(source IN ('iiko_export','csv')),
 file_sha256 text NOT NULL CHECK(file_sha256 ~ '^[0-9a-f]{64}$'),
 plan_sha256 text NOT NULL CHECK(plan_sha256 ~ '^[0-9a-f]{64}$'),
 row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 5000),
 summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object'),
 actor_id uuid NOT NULL REFERENCES catalog_managers(id),
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,branch_id),
 UNIQUE(branch_id,plan_sha256)
);
CREATE TRIGGER bo_supplier_price_imports_immutable BEFORE UPDATE OR DELETE ON bo_supplier_price_imports
FOR EACH ROW EXECUTE FUNCTION commerce_immutable();

-- 3. Supplier prices: the price of one unit of an ingredient from a supplier, in force from an
-- Almaty calendar day until the next valid_from of the same supplier, ingredient and unit. The
-- unit is the purchase unit and must measure the ingredient (kg and g for grams, l and ml for
-- millilitres, pcs for pieces). A correction raises the revision (audit: the command's before
-- and after values); an imported price names its batch.
CREATE TABLE bo_supplier_prices (
 branch_id uuid NOT NULL,
 supplier_id uuid NOT NULL,
 ingredient_id uuid NOT NULL,
 ingredient_kind text NOT NULL DEFAULT 'ingredient' CHECK(ingredient_kind='ingredient'),
 unit text NOT NULL CHECK(unit IN ('g','kg','ml','l','pcs')),
 price_minor bigint NOT NULL CHECK(price_minor>0),
 valid_from date NOT NULL CHECK(valid_from BETWEEN DATE '2024-01-01' AND DATE '2099-12-31'),
 source text NOT NULL CHECK(source IN ('manual','import')),
 import_batch_id uuid NULL,
 revision integer NOT NULL CHECK(revision>0),
 updated_by uuid NOT NULL REFERENCES catalog_managers(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(supplier_id,ingredient_id,unit,valid_from),
 FOREIGN KEY(supplier_id,branch_id) REFERENCES bo_suppliers(id,branch_id),
 FOREIGN KEY(branch_id,ingredient_kind,ingredient_id) REFERENCES bo_records(branch_id,kind,id),
 FOREIGN KEY(import_batch_id,branch_id) REFERENCES bo_supplier_price_imports(id,branch_id),
 CHECK((source='import') = (import_batch_id IS NOT NULL))
);
CREATE INDEX bo_supplier_prices_ingredient_idx ON bo_supplier_prices(branch_id,ingredient_id,valid_from);
CREATE TRIGGER bo_supplier_prices_revision BEFORE INSERT OR UPDATE OR DELETE ON bo_supplier_prices
FOR EACH ROW EXECUTE FUNCTION guard_bo_revision('branch_id','supplier_id','ingredient_id','ingredient_kind','unit','valid_from');
CREATE FUNCTION guard_bo_supplier_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE measured text;
BEGIN
  SELECT r.payload->>'unit' INTO measured FROM bo_records r
   WHERE r.branch_id=NEW.branch_id AND r.kind='ingredient' AND r.id=NEW.ingredient_id;
  IF measured IS NOT NULL
      AND measured <> (CASE NEW.unit WHEN 'kg' THEN 'g' WHEN 'l' THEN 'ml' ELSE NEW.unit END) THEN
    RAISE EXCEPTION 'The price unit does not measure the ingredient' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bo_supplier_prices_unit BEFORE INSERT OR UPDATE ON bo_supplier_prices
FOR EACH ROW EXECUTE FUNCTION guard_bo_supplier_price();

-- 4. Supply requests (Ск6): to the central kitchen, the bakery, for household goods or to a
-- supplier. Nothing is sent anywhere: the request is printed or copied as text. A request starts
-- as a draft and is numbered per branch; its lines are frozen once submitted. received and
-- cancelled are final. Receiving opens the stock receipt at once: received <=> the receipt
-- document (a stock document of kind receipt of the same branch), set once (NULL -> id).
-- A line is {ingredient_id, unit (the ingredient's, g|ml|pcs), qty, balance_at_request, hint?,
-- price_minor?}: qty and balance in whole accounting units, hint = minimum - balance (null without
-- a minimum), price_minor = the expected amount of the line in whole tiyn, only with a supplier.
CREATE TABLE bo_supply_requests (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 number integer NOT NULL CHECK(number>0),
 kind text NOT NULL CHECK(kind IN ('central_kitchen','bakery','household','supplier')),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','submitted','received','cancelled')),
 supplier_id uuid NULL,
 needed_by date NULL CHECK(needed_by BETWEEN DATE '2024-01-01' AND DATE '2099-12-31'),
 note text NULL CHECK(note=btrim(note) AND length(note) BETWEEN 1 AND 500),
 lines jsonb NOT NULL DEFAULT '[]'::jsonb,
 receipt_document_id uuid NULL UNIQUE,
 revision integer NOT NULL CHECK(revision>0),
 created_by uuid NOT NULL REFERENCES catalog_managers(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_by uuid NOT NULL REFERENCES catalog_managers(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 submitted_by uuid NULL REFERENCES catalog_managers(id),
 submitted_at timestamptz NULL,
 closed_by uuid NULL REFERENCES catalog_managers(id),
 closed_at timestamptz NULL,
 UNIQUE(id,branch_id),
 UNIQUE(branch_id,number),
 FOREIGN KEY(supplier_id,branch_id) REFERENCES bo_suppliers(id,branch_id),
 FOREIGN KEY(receipt_document_id,branch_id) REFERENCES bo_stock_documents(id,branch_id),
 CHECK((state='received') = (receipt_document_id IS NOT NULL)),
 CHECK((submitted_at IS NULL) = (submitted_by IS NULL)),
 CHECK(state<>'draft' OR submitted_at IS NULL),
 CHECK(state NOT IN ('submitted','received') OR submitted_at IS NOT NULL),
 CHECK((state IN ('received','cancelled')) = (closed_at IS NOT NULL)),
 CHECK((closed_at IS NULL) = (closed_by IS NULL)),
 CHECK(state IN ('draft','cancelled') OR needed_by IS NOT NULL),
 CHECK(kind<>'supplier' OR state IN ('draft','cancelled') OR supplier_id IS NOT NULL),
 CHECK(CASE WHEN jsonb_typeof(lines)='array'
   THEN jsonb_array_length(lines)<=100 AND (state IN ('draft','cancelled') OR jsonb_array_length(lines)>=1)
   ELSE false END),
 -- strict: every element itself is an object (lax mode would unwrap a nested array).
 CHECK(NOT jsonb_path_exists(lines, 'strict $[*] ? (@.type() != "object")')),
 CHECK(NOT jsonb_path_exists(lines, '$[*] ? (!(@.type() == "object"
   && @.ingredient_id.type() == "string"
   && @.ingredient_id like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
   && @.unit.type() == "string" && (@.unit == "g" || @.unit == "ml" || @.unit == "pcs")
   && @.qty.type() == "string" && @.qty like_regex "^[1-9][0-9]{0,14}$"
   && @.balance_at_request.type() == "string"
   && @.balance_at_request like_regex "^(0|[1-9][0-9]{0,14})$"
   && (!exists(@.hint) || @.hint.type() == "null"
     || (@.hint.type() == "string" && @.hint like_regex "^(0|[1-9][0-9]{0,14})$"))
   && (!exists(@.price_minor)
     || (@.price_minor.type() == "string" && @.price_minor like_regex "^[1-9][0-9]{0,14}$"))))')),
 CHECK(supplier_id IS NOT NULL OR NOT jsonb_path_exists(lines, '$[*].price_minor'))
);
CREATE INDEX bo_supply_requests_state_idx ON bo_supply_requests(branch_id,state,created_at);
CREATE TRIGGER bo_supply_requests_revision BEFORE INSERT OR UPDATE OR DELETE ON bo_supply_requests
FOR EACH ROW EXECUTE FUNCTION guard_bo_revision('id','branch_id','number','kind','created_by','created_at');
CREATE FUNCTION guard_bo_supply_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delivers text;
BEGIN
  IF TG_OP='INSERT' AND NEW.state<>'draft' THEN
    RAISE EXCEPTION 'A supply request starts as a draft' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.state IN ('received','cancelled') THEN
      RAISE EXCEPTION 'A received or cancelled supply request is final' USING ERRCODE='23514';
    END IF;
    IF OLD.state='submitted' AND NEW.state='draft' THEN
      RAISE EXCEPTION 'A submitted supply request does not return to draft' USING ERRCODE='23514';
    END IF;
    IF NEW.state='received' AND OLD.state<>'submitted' THEN
      RAISE EXCEPTION 'Only a submitted supply request is received' USING ERRCODE='23514';
    END IF;
    IF OLD.state<>'draft' AND (NEW.supplier_id,NEW.needed_by,NEW.note,NEW.lines)
        IS DISTINCT FROM (OLD.supplier_id,OLD.needed_by,OLD.note,OLD.lines) THEN
      RAISE EXCEPTION 'A submitted supply request keeps its lines' USING ERRCODE='23514';
    END IF;
    IF OLD.submitted_at IS NOT NULL AND (NEW.submitted_at,NEW.submitted_by)
        IS DISTINCT FROM (OLD.submitted_at,OLD.submitted_by) THEN
      RAISE EXCEPTION 'The submission of a supply request is kept' USING ERRCODE='23514';
    END IF;
    IF OLD.receipt_document_id IS NOT NULL
        AND NEW.receipt_document_id IS DISTINCT FROM OLD.receipt_document_id THEN
      RAISE EXCEPTION 'The receipt of a supply request is set once' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.receipt_document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bo_stock_documents d
      WHERE d.id=NEW.receipt_document_id AND d.branch_id=NEW.branch_id AND d.kind='receipt') THEN
    RAISE EXCEPTION 'The receipt of a supply request is a stock receipt' USING ERRCODE='23514';
  END IF;
  -- The central kitchen and the bakery deliver their own requests, suppliers the others.
  IF NEW.supplier_id IS NOT NULL THEN
    SELECT s.kind INTO delivers FROM bo_suppliers s WHERE s.id=NEW.supplier_id AND s.branch_id=NEW.branch_id;
    IF delivers IS NOT NULL AND delivers <> (CASE WHEN NEW.kind IN ('central_kitchen','bakery')
        THEN NEW.kind ELSE 'supplier' END) THEN
      RAISE EXCEPTION 'The supplier does not deliver this kind of request' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- INSERT and UPDATE only: a BEFORE DELETE trigger returning NULL would skip a delete silently;
-- deletes are refused by guard_bo_revision.
CREATE TRIGGER bo_supply_requests_guard BEFORE INSERT OR UPDATE ON bo_supply_requests
FOR EACH ROW EXECUTE FUNCTION guard_bo_supply_request();

-- 5. Staff assignment (А9): «employee X at station S from HH:MM». A separate table, not a kind of
-- bo_workforce_records (design-bo-ui.md «Вторая волна»: the time sheet loads every workforce
-- record of a branch at once and refuses payroll above 10000 rows, a shift manager may not open
-- the time sheet, and these invariants need columns). station_code is a position code of the
-- branch list (positions.ts). At most one open interval per employee and no overlapping
-- intervals; a reassignment closes the open one at the start of the new one (the command). The
-- business day is the Almaty day of the start, or the day before for a start after midnight in a
-- shift opened the evening before. A closed interval is immutable; an update only closes.
CREATE TABLE bo_staff_assignments (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 business_date date NOT NULL,
 employee_id uuid NOT NULL,
 employee_kind text NOT NULL DEFAULT 'employee' CHECK(employee_kind='employee'),
 station_code text NOT NULL CHECK(station_code ~ '^[a-z][a-z0-9_]{1,39}$'),
 started_at timestamptz NOT NULL,
 ended_at timestamptz NULL,
 set_by uuid NOT NULL REFERENCES catalog_managers(id),
 set_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ended_by uuid NULL REFERENCES catalog_managers(id),
 revision integer NOT NULL CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,branch_id),
 FOREIGN KEY(branch_id,employee_kind,employee_id) REFERENCES bo_records(branch_id,kind,id),
 CHECK(ended_at IS NULL OR ended_at>=started_at),
 CHECK((ended_at IS NULL) = (ended_by IS NULL)),
 CHECK(business_date BETWEEN (started_at AT TIME ZONE 'Asia/Almaty')::date - 1
   AND (started_at AT TIME ZONE 'Asia/Almaty')::date)
);
CREATE UNIQUE INDEX bo_staff_assignments_open_idx ON bo_staff_assignments(branch_id,employee_id)
 WHERE ended_at IS NULL;
CREATE INDEX bo_staff_assignments_day_idx ON bo_staff_assignments(branch_id,business_date,started_at);
CREATE INDEX bo_staff_assignments_employee_idx ON bo_staff_assignments(branch_id,employee_id,started_at);
CREATE TRIGGER bo_staff_assignments_revision BEFORE INSERT OR UPDATE OR DELETE ON bo_staff_assignments
FOR EACH ROW EXECUTE FUNCTION guard_bo_revision('id','branch_id','business_date','employee_id','employee_kind','station_code','started_at','set_by','set_at');
CREATE FUNCTION guard_bo_staff_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'A closed staff assignment is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.ended_at IS NULL THEN
      RAISE EXCEPTION 'A staff assignment changes only by closing it' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Checked here too: the range below cannot be built from an interval that ends first.
  IF NEW.ended_at < NEW.started_at THEN
    RAISE EXCEPTION 'A staff assignment ends before it starts' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM bo_staff_assignments a
      WHERE a.branch_id=NEW.branch_id AND a.employee_id=NEW.employee_id AND a.id<>NEW.id
        AND tstzrange(a.started_at,a.ended_at,'[)') && tstzrange(NEW.started_at,NEW.ended_at,'[)')) THEN
    RAISE EXCEPTION 'Staff assignments of an employee do not overlap' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
-- INSERT and UPDATE only (see section 4); deletes are refused by guard_bo_revision.
CREATE TRIGGER bo_staff_assignments_guard BEFORE INSERT OR UPDATE ON bo_staff_assignments
FOR EACH ROW EXECUTE FUNCTION guard_bo_staff_assignment();
