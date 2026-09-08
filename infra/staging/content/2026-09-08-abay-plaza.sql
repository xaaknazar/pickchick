-- Presentation-only change for the existing synthetic TEST branch.
-- Run with psql -X -v ON_ERROR_STOP=1. This is not a schema migration or a
-- restaurant activation: identifiers, finance, orders and flags stay unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Keep the singleton assertion valid through COMMIT, including concurrent
-- inserts or scope changes. Normal readers can continue while this lock is held.
LOCK TABLE public.branches IN SHARE ROW EXCLUSIVE MODE;

DO $content_update$
DECLARE
  updated_rows integer;
BEGIN
  IF (SELECT count(*) FROM public.branches) <> 1 THEN
    RAISE EXCEPTION 'Abay Plaza content update requires exactly one branch'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id = '10000000-0000-4000-8000-000000000003'::uuid
      AND code = 'TEST-ALMATY-01'
      AND ordering_enabled = false
      AND name IN ('Тестовая точка — не ресторан', 'ТЦ Abay Plaza')
  ) THEN
    RAISE EXCEPTION 'Abay Plaza content update branch scope or previous name mismatch'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.branches
  SET name = 'ТЦ Abay Plaza'
  WHERE id = '10000000-0000-4000-8000-000000000003'::uuid
    AND code = 'TEST-ALMATY-01'
    AND ordering_enabled = false
    AND name = 'Тестовая точка — не ресторан';
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  IF NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id = '10000000-0000-4000-8000-000000000003'::uuid
      AND code = 'TEST-ALMATY-01' AND ordering_enabled = false AND name = 'ТЦ Abay Plaza'
  ) THEN
    RAISE EXCEPTION 'Abay Plaza content update did not reach the expected result'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE NOTICE 'Abay Plaza content update: % row(s) renamed', updated_rows;
END;
$content_update$;
COMMIT;
