-- Local operator enrollment only: the edge runtime cannot create/reset verifiers.
CREATE TABLE local_staff_pins (
  staff_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  login text NOT NULL CHECK (login ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  algorithm text NOT NULL DEFAULT 'scrypt-v1' CHECK (algorithm = 'scrypt-v1'),
  salt text NOT NULL CHECK (salt ~ '^[a-f0-9]{64}$'),
  verifier text NOT NULL CHECK (verifier ~ '^[a-f0-9]{64}$'),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (branch_id, login),
  FOREIGN KEY (staff_id, branch_id) REFERENCES local_staff(id, branch_id)
);


CREATE TABLE local_pin_lookup_keys (
  branch_id uuid PRIMARY KEY REFERENCES branch_config(id),
  secret text NOT NULL CHECK (secret ~ '^[a-f0-9]{64}$')
);

ALTER TABLE local_stops ADD COLUMN expires_at timestamptz;
ALTER TABLE local_stops ADD COLUMN expires_shift_id uuid REFERENCES local_cash_shifts(id);
ALTER TABLE local_stops ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE local_stops ADD COLUMN updated_by uuid REFERENCES local_staff(id);

-- The register shift survives cashier changes; quotes retain the actual operator.
CREATE OR REPLACE FUNCTION guard_order_cash_shift() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target local_cash_shifts%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.cash_shift_id IS DISTINCT FROM OLD.cash_shift_id THEN
      RAISE EXCEPTION 'Order cash shift is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO target FROM local_cash_shifts WHERE id=NEW.cash_shift_id AND branch_id=NEW.branch_id FOR UPDATE;
  IF NOT FOUND OR target.state<>'open' OR NOT EXISTS(
    SELECT 1 FROM checkout_quotes WHERE id=NEW.quote_id AND branch_id=NEW.branch_id
    AND terminal_id=target.terminal_id) THEN
    RAISE EXCEPTION 'Order requires matching open cashier shift' USING ERRCODE='23514';
  END IF;
  IF (SELECT coalesce(sum(total_minor),0) FROM local_orders WHERE cash_shift_id=target.id AND branch_id=target.branch_id)
      + NEW.total_minor > 9223372036854775807::numeric THEN
    RAISE EXCEPTION 'Cash shift order aggregate exceeds bigint' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

-- Operational drawer movements only. They never settle an order or issue a receipt.
CREATE TABLE local_cash_movements (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL,
 shift_id uuid NOT NULL,
 staff_id uuid NOT NULL,
 direction text NOT NULL CHECK(direction IN ('in','out')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 300),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(shift_id,branch_id) REFERENCES local_cash_shifts(id,branch_id),
 FOREIGN KEY(staff_id,branch_id) REFERENCES local_staff(id,branch_id)
);
CREATE FUNCTION guard_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target local_cash_shifts%ROWTYPE; balance numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Cash movements are append only' USING ERRCODE='23514'; END IF;
 SELECT * INTO target FROM local_cash_shifts WHERE id=NEW.shift_id AND branch_id=NEW.branch_id FOR UPDATE;
 IF NOT FOUND OR target.state<>'open' OR NOT EXISTS(SELECT 1 FROM local_staff WHERE id=NEW.staff_id AND branch_id=NEW.branch_id AND role='shift_manager' AND active) THEN
  RAISE EXCEPTION 'Cash movement requires an open shift and active manager' USING ERRCODE='23514';
 END IF;
 SELECT target.opening_cash_minor+coalesce(sum(CASE WHEN direction='in' THEN amount_minor::numeric ELSE -amount_minor::numeric END),0) INTO balance FROM local_cash_movements WHERE shift_id=target.id;
 balance:=balance+CASE WHEN NEW.direction='in' THEN NEW.amount_minor::numeric ELSE -NEW.amount_minor::numeric END;
 IF balance<0 OR balance>9223372036854775807::numeric THEN RAISE EXCEPTION 'Invalid drawer balance' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER local_cash_movement_guard BEFORE INSERT OR UPDATE OR DELETE ON local_cash_movements FOR EACH ROW EXECUTE FUNCTION guard_cash_movement();
-- Keep the existing closure invariant but compare against the frozen drawer report.
DO $$ DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='local_cash_shifts'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%discrepancy_minor%' LOOP
  EXECUTE format('ALTER TABLE local_cash_shifts DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE local_cash_shifts ADD CONSTRAINT local_cash_shift_closure CHECK(((state='open' AND version=1 AND closed_at IS NULL AND closed_by_staff_id IS NULL
 AND counted_cash_minor IS NULL AND discrepancy_minor IS NULL AND closing_reason IS NULL AND closed_report IS NULL)
 OR (state='closed' AND version=2 AND closed_at>=opened_at AND closed_by_staff_id IS NOT NULL
 AND counted_cash_minor IS NOT NULL AND discrepancy_minor=counted_cash_minor-coalesce((closed_report->>'expected_cash_minor')::bigint,opening_cash_minor)
 AND length(trim(closing_reason)) BETWEEN 1 AND 300 AND jsonb_typeof(closed_report)='object')) IS TRUE);
