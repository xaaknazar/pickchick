-- Cutover 19.11.2026, lane pos (lead decision 07.11 (1), CR client-5 3.2, CR pos-7): the number of
-- a cash desk ("Касса 1", "Касса 2"), the one source the cashier screens show. Additive only, and
-- off: every existing terminal keeps NULL, which is today's screen without a number. The previous
-- runtime never names the column; the new runtime reads it with its table-level SELECT on
-- local_terminals (no new grant) and answers NULL on an edge without this file. Only the owner tool
-- scripts/pos-sales-setup.mjs writes it, each change after its pos_sales_setting_changes row.

-- 1. The number of a desk ---------------------------------------------------------------------
ALTER TABLE local_terminals ADD COLUMN desk_number smallint
  CONSTRAINT local_terminals_desk_number_check CHECK(desk_number BETWEEN 1 AND 99);
-- Two active desks of one branch never share a number; a deactivated desk frees its number.
CREATE UNIQUE INDEX local_terminals_active_desk_number ON local_terminals(branch_id,desk_number)
  WHERE desk_number IS NOT NULL AND active;

-- 2. Its audit: one more subject of the schema026 operator history ------------------------------
-- Both CHECKs naming the subject are recreated with their names; every older row and subject keeps
-- its rule byte for byte, 'desk_number' rows carry {terminal_id, desk_number} before and after.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='pos_sales_setting_changes'::regclass
    AND contype='c' AND pg_get_constraintdef(oid) LIKE '%subject%'
  LOOP EXECUTE format('ALTER TABLE pos_sales_setting_changes DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE pos_sales_setting_changes ADD CONSTRAINT pos_sales_setting_changes_subject_check
  CHECK(subject IN ('pos_service_mode','cash','kaspi_terminal','aggregator_yandex_eda',
    'aggregator_glovo','staff_meal','marketing','kaspi_manual','chocofood','desk_number'));
ALTER TABLE pos_sales_setting_changes ADD CONSTRAINT pos_sales_setting_changes_check1
  CHECK((CASE WHEN subject='pos_service_mode' THEN
      before-'pos_service_mode'='{}'::jsonb AND after-'pos_service_mode'='{}'::jsonb
      AND before->>'pos_service_mode' IN ('payment_required','unpaid_service','pos_sale')
      AND after->>'pos_service_mode' IN ('payment_required','unpaid_service','pos_sale')
    WHEN subject='desk_number' THEN
      before-ARRAY['terminal_id','desk_number']='{}'::jsonb AND after-ARRAY['terminal_id','desk_number']='{}'::jsonb
      AND before ?& ARRAY['terminal_id','desk_number'] AND after ?& ARRAY['terminal_id','desk_number']
      AND jsonb_typeof(before->'terminal_id')='string' AND before->'terminal_id'=after->'terminal_id'
      AND before->>'terminal_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND (jsonb_typeof(before->'desk_number')='null'
        OR (jsonb_typeof(before->'desk_number')='number' AND before->>'desk_number' ~ '^[1-9][0-9]?$'))
      AND (jsonb_typeof(after->'desk_number')='null'
        OR (jsonb_typeof(after->'desk_number')='number' AND after->>'desk_number' ~ '^[1-9][0-9]?$'))
      AND before->'desk_number' IS DISTINCT FROM after->'desk_number'
    ELSE
      before-ARRAY['enabled','fiscal_policy']='{}'::jsonb AND after-ARRAY['enabled','fiscal_policy']='{}'::jsonb
      AND jsonb_typeof(before->'enabled')='boolean' AND jsonb_typeof(after->'enabled')='boolean'
      AND before->>'fiscal_policy' IN ('manual_webkassa','not_required')
      AND after->>'fiscal_policy' IN ('manual_webkassa','not_required')
    END) IS TRUE);

-- 3. A desk starts without a number; a number changes only together with its audit row ----------
-- Fires only when desk_number is written (INSERT, or UPDATE naming the column): row locks, the
-- terminal access worker's UPDATE(active) and every older statement never reach it.
CREATE FUNCTION guard_local_terminal_desk_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest pos_sales_setting_changes%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.desk_number IS NOT NULL THEN
      RAISE EXCEPTION 'A cash desk starts without a number' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.desk_number IS NOT DISTINCT FROM OLD.desk_number THEN RETURN NEW; END IF;
  SELECT * INTO latest FROM pos_sales_setting_changes WHERE branch_id=NEW.branch_id AND subject='desk_number'
    ORDER BY change_sequence DESC LIMIT 1;
  IF NOT FOUND
    OR latest.before IS DISTINCT FROM jsonb_build_object('terminal_id',OLD.id,'desk_number',OLD.desk_number)
    OR latest.after IS DISTINCT FROM jsonb_build_object('terminal_id',NEW.id,'desk_number',NEW.desk_number) THEN
    RAISE EXCEPTION 'Desk number changes require a matching audit record' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER local_terminal_desk_number_guard BEFORE INSERT OR UPDATE OF desk_number ON local_terminals
FOR EACH ROW EXECUTE FUNCTION guard_local_terminal_desk_number();
