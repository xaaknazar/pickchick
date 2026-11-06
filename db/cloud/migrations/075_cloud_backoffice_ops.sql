-- Cutover 19.11.2026, lane bo-ui (owner decision 05.11: the back-office P1 screens are built now
-- behind API flags that default to off; docs/architecture/cutover-2026-11/design-bo-ui.md section 3,
-- design-backoffice.md section 3). Additive only and compatible both ways:
-- - the cloud lane runtime (074) inserts and updates exactly as before: the new columns default to
--   NULL, the widened kind CHECK accepts every old kind, the new triggers fire only for new values;
-- - the bo-ui runtime works on 074 without this file (to_regclass / privilege checks).
-- The file name has no digit after the prefix: packages/database migrate() only applies
-- ^\d{3}_[a-z_]+\.sql$ (contracts R11). No foreign key to cloud_pos_* (073). Rights come only from
-- infra/staging/backoffice-p1-grants.mjs. Money is bigint whole tiyn.

-- 0. Shared guard of revisioned rows: never deleted, the first row has revision 1, every update
-- raises the revision by exactly one and keeps the identity columns named in the trigger arguments.
CREATE FUNCTION guard_bo_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 THEN
      RAISE EXCEPTION '% starts at revision 1', TG_TABLE_NAME USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION '% revision must grow by one', TG_TABLE_NAME USING ERRCODE='23514';
  END IF;
  FOREACH k IN ARRAY TG_ARGV LOOP
    IF to_jsonb(NEW)->k IS DISTINCT FROM to_jsonb(OLD)->k THEN
      RAISE EXCEPTION '%.% is immutable', TG_TABLE_NAME, k USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- 1. Stock documents (Ск1 storno, Ск2 consumption by sales). The kind list gains 'reversal'
-- ('consumption' and 'transfer' stay). A reversal names the document it reverses (same branch) and
-- exists at most once per document; an automatic consumption names its order in source_ref
-- ('pos:<order uuid>' with no order_id, or 'cloud:<order uuid>' equal to order_id) and exists at
-- most once per order. Manual consumption documents of cloud017 keep source_ref NULL.
ALTER TABLE bo_stock_documents ADD COLUMN source_ref text NULL
 CHECK(source_ref ~ '^(pos|cloud):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE bo_stock_documents ADD COLUMN reverses_document_id uuid NULL;
ALTER TABLE bo_stock_documents ADD CONSTRAINT bo_stock_documents_reverses_fk
 FOREIGN KEY(reverses_document_id,branch_id) REFERENCES bo_stock_documents(id,branch_id);
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='bo_stock_documents'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE 'CHECK ((kind = ANY%'
  LOOP EXECUTE format('ALTER TABLE bo_stock_documents DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE bo_stock_documents ADD CONSTRAINT bo_stock_documents_kind_check
 CHECK(kind IN ('receipt','waste','count','production','consumption','transfer','reversal'));
ALTER TABLE bo_stock_documents ADD CONSTRAINT bo_stock_documents_reversal_check
 CHECK((kind='reversal') = (reverses_document_id IS NOT NULL)
   AND (kind<>'reversal' OR (order_id IS NULL AND reason_code IS NULL)));
ALTER TABLE bo_stock_documents ADD CONSTRAINT bo_stock_documents_consumption_source_check
 CHECK(source_ref IS NULL OR (kind='consumption' AND (
   (left(source_ref,4)='pos:' AND order_id IS NULL) OR
   (left(source_ref,6)='cloud:' AND order_id IS NOT NULL AND substr(source_ref,7)=order_id::text))));
CREATE UNIQUE INDEX bo_stock_consumption_source_idx ON bo_stock_documents(source_ref)
 WHERE kind='consumption';
CREATE UNIQUE INDEX bo_stock_reversal_once_idx ON bo_stock_documents(reverses_document_id)
 WHERE kind='reversal';
-- A reversal is never reversed itself (a document is reversed once and the history stays linear).
CREATE FUNCTION guard_bo_stock_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM bo_stock_documents d WHERE d.id=NEW.reverses_document_id AND d.kind='reversal') THEN
    RAISE EXCEPTION 'A stock reversal cannot be reversed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bo_stock_reversal_guard BEFORE INSERT ON bo_stock_documents
FOR EACH ROW WHEN (NEW.kind='reversal') EXECUTE FUNCTION guard_bo_stock_reversal();

-- 2. Time of the last count of an ingredient (Ск2 absorption: a sale sold before the count is not
-- written off again). Set by a count, never cleared and never moved back. The cloud lane runtime
-- never touches it, so its balance updates do not fire the guard.
ALTER TABLE bo_stock_balances ADD COLUMN counted_at timestamptz NULL;
CREATE FUNCTION guard_bo_stock_counted_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.counted_at IS NULL OR NEW.counted_at < OLD.counted_at THEN
    RAISE EXCEPTION 'counted_at only moves forward' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bo_stock_counted_at_guard BEFORE UPDATE ON bo_stock_balances
FOR EACH ROW WHEN (NEW.counted_at IS DISTINCT FROM OLD.counted_at)
EXECUTE FUNCTION guard_bo_stock_counted_at();

-- 3. Automatic consumption settings per branch (BACKOFFICE_STOCK_AUTOCONSUME_ENABLED). No row
-- means 'off'. dry_run and on need start_at: sales sold before it are never written off.
CREATE TABLE bo_stock_settings (
 branch_id uuid PRIMARY KEY REFERENCES branches(id),
 autoconsume_mode text NOT NULL DEFAULT 'off' CHECK(autoconsume_mode IN ('off','dry_run','on')),
 start_at timestamptz NULL,
 revision integer NOT NULL CHECK(revision>0),
 updated_by uuid NOT NULL REFERENCES catalog_managers(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(autoconsume_mode='off' OR start_at IS NOT NULL)
);
CREATE TRIGGER bo_stock_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON bo_stock_settings
FOR EACH ROW EXECUTE FUNCTION guard_bo_revision('branch_id');

-- 4. Menu to stock links (Ск2, BACKOFFICE_STOCK_V2_ENABLED): one row per catalog product or option,
-- identified by published catalog slugs. effect 'none' = sold without a write-off (no lines);
-- 'consume' = 1..50 lines {ingredient_id | recipe_output_id, quantity} checked by the command.
-- Only the chef's approval (through the manager) makes a link usable; changing effect or lines
-- always returns it to draft, and an approval never changes them.
CREATE TABLE bo_menu_stock_links (
 branch_id uuid NOT NULL REFERENCES branches(id),
 catalog_key text NOT NULL,
 product_slug text NOT NULL CHECK(product_slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
 group_slug text NULL CHECK(group_slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
 option_slug text NULL CHECK(option_slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
 effect text NOT NULL CHECK(effect IN ('consume','none')),
 lines jsonb NOT NULL DEFAULT '[]'::jsonb,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved')),
 revision integer NOT NULL CHECK(revision>0),
 updated_by uuid NOT NULL REFERENCES catalog_managers(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 approved_by uuid NULL REFERENCES catalog_managers(id),
 approved_at timestamptz NULL,
 PRIMARY KEY(branch_id,catalog_key),
 CHECK((group_slug IS NULL) = (option_slug IS NULL)),
 CHECK(catalog_key = product_slug || coalesce(':' || group_slug || ':' || option_slug, '')),
 CHECK(CASE WHEN jsonb_typeof(lines)='array'
   THEN jsonb_array_length(lines)<=50 AND (effect='none') = (jsonb_array_length(lines)=0)
   ELSE false END),
 CHECK((status='approved') = (approved_by IS NOT NULL) AND (status='approved') = (approved_at IS NOT NULL))
);
CREATE TRIGGER bo_menu_stock_links_revision BEFORE INSERT OR UPDATE OR DELETE ON bo_menu_stock_links
FOR EACH ROW EXECUTE FUNCTION guard_bo_revision('branch_id','catalog_key','product_slug','group_slug','option_slug');
CREATE FUNCTION guard_bo_menu_stock_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.effect,NEW.lines) IS DISTINCT FROM (OLD.effect,OLD.lines) AND NEW.status<>'draft' THEN
    RAISE EXCEPTION 'A changed menu stock link must be approved again' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bo_menu_stock_links_approval BEFORE UPDATE ON bo_menu_stock_links
FOR EACH ROW EXECUTE FUNCTION guard_bo_menu_stock_link();

-- 5. Automatic consumption queue (Ск2): one item per sold order (cashier pos_sale or cloud order).
-- applied, skipped and not_required are final; applied <=> its one consumption document, so the
-- document is set once (NULL -> id) and is the consumption of exactly this order (source_ref).
-- blocked, skipped and not_required carry a reason (a code or the manager's text).
CREATE TABLE bo_consumption_items (
 branch_id uuid NOT NULL REFERENCES branches(id),
 source text NOT NULL CHECK(source IN ('pos','cloud')),
 order_id uuid NOT NULL,
 sold_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending'
   CHECK(state IN ('pending','previewed','applied','blocked','skipped','not_required')),
 reason text NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(detail)='object'),
 document_id uuid NULL UNIQUE,
 trigger_kind text NOT NULL CHECK(trigger_kind IN ('kitchen_started','day_close')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz NULL,
 revision integer NOT NULL CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,source,order_id),
 FOREIGN KEY(document_id,branch_id) REFERENCES bo_stock_documents(id,branch_id),
 CHECK((state='applied') = (document_id IS NOT NULL)),
 CHECK(state NOT IN ('blocked','skipped','not_required') OR reason IS NOT NULL)
);
CREATE INDEX bo_consumption_items_queue_idx ON bo_consumption_items(branch_id,state,next_attempt_at);
CREATE INDEX bo_consumption_items_sold_idx ON bo_consumption_items(branch_id,sold_at);
CREATE FUNCTION guard_bo_consumption_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Consumption items are never deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.state IN ('applied','skipped','not_required') THEN
      RAISE EXCEPTION 'A final consumption item never changes' USING ERRCODE='23514';
    END IF;
    IF NEW.revision<>OLD.revision+1 OR (NEW.branch_id,NEW.source,NEW.order_id,NEW.sold_at,NEW.trigger_kind)
        IS DISTINCT FROM (OLD.branch_id,OLD.source,OLD.order_id,OLD.sold_at,OLD.trigger_kind) THEN
      RAISE EXCEPTION 'Invalid consumption item change' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.revision<>1 THEN
    RAISE EXCEPTION 'A consumption item starts at revision 1' USING ERRCODE='23514';
  END IF;
  IF NEW.document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bo_stock_documents d
      WHERE d.id=NEW.document_id AND d.branch_id=NEW.branch_id AND d.kind='consumption'
        AND d.source_ref=NEW.source || ':' || NEW.order_id::text) THEN
    RAISE EXCEPTION 'The document is not the consumption of this order' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bo_consumption_items_guard BEFORE INSERT OR UPDATE OR DELETE ON bo_consumption_items
FOR EACH ROW EXECUTE FUNCTION guard_bo_consumption_item();

-- 6. Manager shifts (А10/А11/Ск7, BACKOFFICE_MANAGER_SHIFTS_ENABLED). At most one open shift per
-- branch. The business day is the Almaty calendar day of the opening: a shift that closes after
-- midnight belongs to the day it was opened. A closed shift has its closing checklist with a
-- handover text and is immutable. Checklist templates are versioned code (template_version), not
-- rows. The old journal kind 'shift' of bo_records is untouched.
CREATE TABLE bo_manager_shifts (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 business_date date NOT NULL,
 manager_employee_id uuid NULL,
 employee_kind text NOT NULL DEFAULT 'employee' CHECK(employee_kind='employee'),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
 opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 closed_at timestamptz NULL,
 opening jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(opening)='object'),
 closing jsonb NULL CHECK(jsonb_typeof(closing)='object'),
 template_version integer NOT NULL CHECK(template_version>0),
 revision integer NOT NULL CHECK(revision>0),
 opened_by uuid NOT NULL REFERENCES catalog_managers(id),
 closed_by uuid NULL REFERENCES catalog_managers(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,branch_id),
 FOREIGN KEY(branch_id,employee_kind,manager_employee_id) REFERENCES bo_records(branch_id,kind,id),
 CHECK(business_date = (opened_at AT TIME ZONE 'Asia/Almaty')::date),
 CHECK((state='closed') = (closed_at IS NOT NULL) AND (state='closed') = (closed_by IS NOT NULL)),
 CHECK(state<>'closed' OR (closing IS NOT NULL AND closed_at>=opened_at
   AND length(btrim(coalesce(closing->>'handover','')))>=3))
);
CREATE UNIQUE INDEX bo_manager_shifts_one_open_idx ON bo_manager_shifts(branch_id) WHERE state='open';
CREATE INDEX bo_manager_shifts_day_idx ON bo_manager_shifts(branch_id,business_date,opened_at);
CREATE FUNCTION guard_bo_manager_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.state='closed' THEN
    RAISE EXCEPTION 'A closed manager shift is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bo_manager_shifts_closed BEFORE UPDATE ON bo_manager_shifts
FOR EACH ROW EXECUTE FUNCTION guard_bo_manager_shift();
CREATE TRIGGER bo_manager_shifts_revision BEFORE INSERT OR UPDATE OR DELETE ON bo_manager_shifts
FOR EACH ROW EXECUTE FUNCTION guard_bo_revision('id','branch_id','business_date','opened_at','opened_by','template_version','employee_kind');

-- 7. Discounts (КС7 data, BACKOFFICE_DISCOUNTS_ENABLED). Created and edited only in the back office;
-- the POS does not apply them yet and nothing here is published to the edge. A discount is either
-- an amount in tiyn or a percent in basis points (10000 = 100 %). scope {categories, products,
-- channels} and schedule {start_at, end_at, weekdays, hours} are validated by the command.
-- archived is final. Every inserted or changed revision is copied to bo_discount_revisions by a
-- trigger, so the history cannot be skipped or forged by the API role.
CREATE TABLE bo_discounts (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 name text NOT NULL CHECK(name=btrim(name) AND length(name) BETWEEN 1 AND 80),
 kind text NOT NULL CHECK(kind IN ('percent','amount')),
 value_minor bigint NULL CHECK(value_minor>0),
 percent_bp integer NULL CHECK(percent_bp BETWEEN 1 AND 10000),
 scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(scope)='object'),
 schedule jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(schedule)='object'),
 requires_manager_pin boolean NOT NULL DEFAULT true,
 combinable boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','active','archived')),
 revision integer NOT NULL CHECK(revision>0),
 created_by uuid NOT NULL REFERENCES catalog_managers(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_by uuid NOT NULL REFERENCES catalog_managers(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,branch_id),
 CHECK((kind='amount') = (value_minor IS NOT NULL) AND (kind='percent') = (percent_bp IS NOT NULL))
);
-- Two live discounts of a branch never share a name (the cashier picks by name, P1).
CREATE UNIQUE INDEX bo_discounts_live_name_idx ON bo_discounts(branch_id,lower(name))
 WHERE state<>'archived';
CREATE FUNCTION guard_bo_discount() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.state='archived' THEN
    RAISE EXCEPTION 'An archived discount is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bo_discounts_archived BEFORE UPDATE ON bo_discounts
FOR EACH ROW EXECUTE FUNCTION guard_bo_discount();
CREATE TRIGGER bo_discounts_revision BEFORE INSERT OR UPDATE OR DELETE ON bo_discounts
FOR EACH ROW EXECUTE FUNCTION guard_bo_revision('id','branch_id','created_by','created_at');
CREATE TABLE bo_discount_revisions (
 discount_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 changed_by uuid NOT NULL REFERENCES catalog_managers(id),
 changed_at timestamptz NOT NULL,
 PRIMARY KEY(discount_id,revision),
 FOREIGN KEY(discount_id,branch_id) REFERENCES bo_discounts(id,branch_id)
);
CREATE TRIGGER bo_discount_revisions_immutable BEFORE UPDATE OR DELETE ON bo_discount_revisions
FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
-- Runs as the migration owner (pattern of cloud056): the API role reads the history and never
-- writes it directly.
CREATE FUNCTION bo_discount_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO bo_discount_revisions(discount_id,branch_id,revision,snapshot,changed_by,changed_at)
  VALUES(NEW.id,NEW.branch_id,NEW.revision,to_jsonb(NEW),NEW.updated_by,NEW.updated_at);
  RETURN NULL;
END $$;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION %I.bo_discount_history() SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
END $$;
REVOKE ALL ON FUNCTION bo_discount_history() FROM PUBLIC;
CREATE TRIGGER bo_discounts_history AFTER INSERT OR UPDATE ON bo_discounts
FOR EACH ROW EXECUTE FUNCTION bo_discount_history();

-- 8. Lists a branch manager edits (lane bo-ui step 6, А10/А11 checklist template, А8/Д3 positions;
-- added before the 10.11 freeze because an editable, versioned checklist and an editable list of
-- positions need storage). The built-in checklist of section 6 and the built-in eleven positions
-- stay code and are version 1; a branch's own versions are rows here from version 2 on, never
-- changed or deleted. kind 'manager_shift' = {opening: [item], closing: [item]}, kind
-- 'staff_positions' = {positions: [position]}; the body is validated by the command. A manager
-- shift keeps the version it was opened with (bo_manager_shifts.template_version), which must
-- then exist.
CREATE TABLE bo_branch_templates (
 branch_id uuid NOT NULL REFERENCES branches(id),
 kind text NOT NULL CHECK(kind IN ('manager_shift','staff_positions')),
 version integer NOT NULL CHECK(version>=2),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 created_by uuid NOT NULL REFERENCES catalog_managers(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,kind,version)
);
CREATE TRIGGER bo_branch_templates_immutable BEFORE UPDATE OR DELETE ON bo_branch_templates
FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE FUNCTION guard_bo_manager_shift_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.template_version>1 AND NOT EXISTS(SELECT 1 FROM bo_branch_templates t
      WHERE t.branch_id=NEW.branch_id AND t.kind='manager_shift' AND t.version=NEW.template_version) THEN
    RAISE EXCEPTION 'Unknown manager shift template version' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bo_manager_shifts_template BEFORE INSERT ON bo_manager_shifts
FOR EACH ROW EXECUTE FUNCTION guard_bo_manager_shift_template();
