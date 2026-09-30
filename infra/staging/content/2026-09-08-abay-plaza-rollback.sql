-- Exact inverse of 2026-09-08-abay-plaza.sql, only within the same TEST scope.
-- Run with psql -X -v ON_ERROR_STOP=1. A later operator rename is never overwritten.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
LOCK TABLE public.branches IN SHARE ROW EXCLUSIVE MODE;

DO $content_rollback$
DECLARE
  updated_rows integer;
BEGIN
  IF (SELECT count(*) FROM public.branches) <> 1 THEN
    RAISE EXCEPTION 'Abay Plaza rollback requires exactly one branch'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id = '10000000-0000-4000-8000-000000000003'::uuid
      AND code = 'TEST-ALMATY-01'
      AND ordering_enabled = false
      AND name IN ('Тестовая точка — не ресторан', 'ТЦ Abay Plaza')
  ) THEN
    RAISE EXCEPTION 'Abay Plaza rollback branch scope or current name mismatch'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.branches
  SET name = 'Тестовая точка — не ресторан'
  WHERE id = '10000000-0000-4000-8000-000000000003'::uuid
    AND code = 'TEST-ALMATY-01'
    AND ordering_enabled = false
    AND name = 'ТЦ Abay Plaza';
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  IF NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id = '10000000-0000-4000-8000-000000000003'::uuid
      AND code = 'TEST-ALMATY-01' AND ordering_enabled = false
      AND name = 'Тестовая точка — не ресторан'
  ) THEN
    RAISE EXCEPTION 'Abay Plaza rollback did not reach the expected result'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE NOTICE 'Abay Plaza rollback: % row(s) renamed', updated_rows;
END;
$content_rollback$;
COMMIT;
