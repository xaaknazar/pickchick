-- Only the synthetic namespace gains an explicitly unpaid dispatch mode.
-- Existing orders retain their original payment simulator requirements.
ALTER TABLE test_orders ADD COLUMN execution_mode text NOT NULL DEFAULT 'simulated_payment'
  CHECK(execution_mode IN ('simulated_payment','unpaid_test'));
DO $$
DECLARE constraint_name text; matches integer;
BEGIN
  SELECT count(*), min(conname) INTO matches, constraint_name
  FROM pg_constraint
  WHERE conrelid='test_orders'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%state <> ALL%'
    AND pg_get_constraintdef(oid) LIKE '%simulated_approved%';
  IF matches<>1 THEN RAISE EXCEPTION 'expected original TEST dispatch constraint'; END IF;
  EXECUTE format('ALTER TABLE test_orders DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE test_orders ADD CONSTRAINT test_order_dispatch_mode CHECK(
  (execution_mode='unpaid_test' AND payment_state='not_started' AND payment_attempt_id IS NULL)
  OR (execution_mode='simulated_payment' AND
    (state NOT IN ('preparing','ready','fulfilled') OR payment_state='simulated_approved'))
);
CREATE FUNCTION test_execution_mode_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_mode IS DISTINCT FROM OLD.execution_mode
  THEN RAISE EXCEPTION 'test execution mode is immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER test_execution_mode_guard BEFORE UPDATE ON test_orders
FOR EACH ROW EXECUTE FUNCTION test_execution_mode_immutable();
