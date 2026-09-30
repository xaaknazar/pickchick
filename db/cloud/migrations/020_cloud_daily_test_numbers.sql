-- Display numbers are separate from immutable order IDs, global sequences and receipts.
CREATE TABLE test_order_day_counters (
  branch_id uuid NOT NULL REFERENCES branches(id),
  business_date date NOT NULL,
  last_number integer NOT NULL CHECK(last_number > 0),
  PRIMARY KEY(branch_id,business_date)
);
CREATE TABLE test_order_numbers (
  order_id uuid PRIMARY KEY REFERENCES test_orders(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  business_date date NOT NULL,
  number integer NOT NULL CHECK(number > 0),
  UNIQUE(branch_id,business_date,number)
);
-- Migration owns the write lock: historical orders receive a stable number once.
LOCK TABLE test_orders IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO test_order_numbers(order_id,branch_id,business_date,number)
SELECT id,branch_id,business_date,
  row_number() OVER(PARTITION BY branch_id,business_date ORDER BY sequence)::integer
FROM (SELECT o.id,o.branch_id,o.sequence,
  (o.created_at AT TIME ZONE b.timezone)::date AS business_date
  FROM test_orders o JOIN branches b ON b.id=o.branch_id) historical;
INSERT INTO test_order_day_counters(branch_id,business_date,last_number)
SELECT branch_id,business_date,max(number) FROM test_order_numbers GROUP BY branch_id,business_date;

CREATE FUNCTION test_assign_order_number() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE day date; assigned integer;
BEGIN
  SELECT (NEW.created_at AT TIME ZONE timezone)::date INTO STRICT day FROM branches WHERE id=NEW.branch_id;
  INSERT INTO test_order_day_counters(branch_id,business_date,last_number)
    VALUES(NEW.branch_id,day,1)
    ON CONFLICT(branch_id,business_date) DO UPDATE
    SET last_number=test_order_day_counters.last_number+1
    RETURNING last_number INTO assigned;
  INSERT INTO test_order_numbers(order_id,branch_id,business_date,number)
    VALUES(NEW.id,NEW.branch_id,day,assigned);
  RETURN NEW;
END; $$;
-- Pin the owner-controlled schema, including in isolated integration-test schemas.
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION %I.test_assign_order_number() SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
END; $$;
REVOKE ALL ON FUNCTION test_assign_order_number() FROM PUBLIC;
CREATE TRIGGER test_assign_order_number AFTER INSERT ON test_orders
FOR EACH ROW EXECUTE FUNCTION test_assign_order_number();
-- Counters survive retention cleanup, so a cancelled/deleted number is never reused.
