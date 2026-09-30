-- Operational numbering periods. Calendar rollover must never open a new shift.
CREATE TABLE test_service_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigserial UNIQUE NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id),
  state text NOT NULL CHECK (state IN ('open','closed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  CHECK ((state='open' AND closed_at IS NULL) OR (state='closed' AND closed_at IS NOT NULL)),
  UNIQUE(id,branch_id)
);
CREATE UNIQUE INDEX test_one_open_service_shift ON test_service_shifts(branch_id) WHERE state='open';
LOCK TABLE test_orders IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE test_order_numbers ADD COLUMN shift_id uuid;

-- Preserve every already-issued number. Imported historical periods stay closed;
-- the current period continues its existing counter instead of renumbering orders.
DO $$
DECLARE period record; sid uuid;
BEGIN
  FOR period IN SELECT c.*, b.timezone FROM test_order_day_counters c JOIN branches b ON b.id=c.branch_id LOOP
    INSERT INTO test_service_shifts(branch_id,state,opened_at,closed_at,last_number)
    VALUES(period.branch_id,
      'closed',
      period.business_date::timestamp AT TIME ZONE period.timezone,
      (period.business_date+1)::timestamp AT TIME ZONE period.timezone,
      period.last_number) RETURNING id INTO sid;
    UPDATE test_order_numbers SET shift_id=sid WHERE branch_id=period.branch_id AND business_date=period.business_date;
  END LOOP;
  -- One bootstrap shift for the already-running synthetic restaurant only.
  INSERT INTO test_service_shifts(branch_id,state,last_number)
  SELECT id,'open',coalesce((SELECT last_number FROM test_order_day_counters c WHERE c.branch_id=b.id AND c.business_date=(clock_timestamp() AT TIME ZONE b.timezone)::date),0) FROM branches b WHERE code='TEST-ALMATY-01'
    AND NOT EXISTS(SELECT 1 FROM test_service_shifts s WHERE s.branch_id=b.id AND s.state='open');
END $$;
ALTER TABLE test_order_numbers ALTER COLUMN shift_id SET NOT NULL;
ALTER TABLE test_order_numbers ADD FOREIGN KEY(shift_id,branch_id) REFERENCES test_service_shifts(id,branch_id);
ALTER TABLE test_order_numbers DROP CONSTRAINT test_order_numbers_branch_id_business_date_number_key;
ALTER TABLE test_order_numbers ADD UNIQUE(shift_id,number);

CREATE OR REPLACE FUNCTION test_assign_order_number() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE active test_service_shifts%ROWTYPE; day date; assigned integer;
BEGIN
  -- Serialize bootstrap, explicit transitions and issuance for one branch.
  SELECT (NEW.created_at AT TIME ZONE timezone)::date INTO STRICT day FROM branches WHERE id=NEW.branch_id FOR UPDATE;
  SELECT * INTO active FROM test_service_shifts WHERE branch_id=NEW.branch_id AND state='open' FOR UPDATE;
  IF NOT FOUND THEN
    -- A newly provisioned synthetic namespace has one initial shift. A closed
    -- shift is never reopened implicitly, including by old clients or retries.
    IF EXISTS(SELECT 1 FROM test_service_shifts WHERE branch_id=NEW.branch_id) THEN
      RAISE EXCEPTION 'Service shift is closed' USING ERRCODE='55000';
    END IF;
    INSERT INTO test_service_shifts(branch_id,state) VALUES(NEW.branch_id,'open') RETURNING * INTO active;
  END IF;
  UPDATE test_service_shifts SET last_number=last_number+1 WHERE id=active.id RETURNING last_number INTO assigned;
  INSERT INTO test_order_numbers(order_id,branch_id,business_date,number,shift_id)
    VALUES(NEW.id,NEW.branch_id,day,assigned,active.id);
  RETURN NEW;
END; $$;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION %I.test_assign_order_number() SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
END $$;
REVOKE ALL ON FUNCTION test_assign_order_number() FROM PUBLIC;
