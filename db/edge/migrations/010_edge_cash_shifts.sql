-- Operational cashier drawer session, not a fiscal register shift or payment adapter.
CREATE TABLE local_cash_shifts (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  terminal_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK(state IN('open','closed')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  opening_cash_minor bigint NOT NULL CHECK(opening_cash_minor>=0),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  closed_by_staff_id uuid,
  counted_cash_minor bigint CHECK(counted_cash_minor>=0),
  discrepancy_minor bigint,
  closing_reason text,
  closed_report jsonb,
  FOREIGN KEY(terminal_id,branch_id) REFERENCES local_terminals(id,branch_id),
  FOREIGN KEY(staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  FOREIGN KEY(closed_by_staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  UNIQUE(id,branch_id),
  CHECK(((state='open' AND version=1 AND closed_at IS NULL AND closed_by_staff_id IS NULL
    AND counted_cash_minor IS NULL AND discrepancy_minor IS NULL AND closing_reason IS NULL AND closed_report IS NULL)
    OR (state='closed' AND version=2 AND closed_at>=opened_at AND closed_by_staff_id IS NOT NULL
      AND counted_cash_minor IS NOT NULL AND discrepancy_minor=counted_cash_minor-opening_cash_minor
      AND length(trim(closing_reason)) BETWEEN 1 AND 300 AND jsonb_typeof(closed_report)='object')) IS TRUE)
);
CREATE UNIQUE INDEX local_cash_shifts_open_terminal_idx ON local_cash_shifts(branch_id,terminal_id) WHERE state='open';
CREATE INDEX local_cash_shifts_actor_time_idx ON local_cash_shifts(branch_id,staff_id,terminal_id,opened_at DESC,id);
CREATE FUNCTION guard_local_cash_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cash shifts cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'open' THEN RAISE EXCEPTION 'Cash shifts must start open' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state<>'open' OR NEW.state<>'closed' OR
    ROW(NEW.id,NEW.branch_id,NEW.terminal_id,NEW.staff_id,NEW.opening_cash_minor,NEW.opened_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.branch_id,OLD.terminal_id,OLD.staff_id,OLD.opening_cash_minor,OLD.opened_at) THEN
    RAISE EXCEPTION 'Invalid cash shift transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER local_cash_shift_guard BEFORE INSERT OR UPDATE OR DELETE ON local_cash_shifts
FOR EACH ROW EXECUTE FUNCTION guard_local_cash_shift();

-- Preserve historical unassociated orders. Every new order must match the quote's
-- staff and terminal and a currently open shift at the same branch.
ALTER TABLE local_orders ADD COLUMN cash_shift_id uuid;
ALTER TABLE local_orders ADD CONSTRAINT local_orders_cash_shift_fk
  FOREIGN KEY(cash_shift_id,branch_id) REFERENCES local_cash_shifts(id,branch_id);
CREATE INDEX local_orders_cash_shift_idx ON local_orders(branch_id,cash_shift_id,created_at DESC,id);
CREATE FUNCTION guard_order_cash_shift() RETURNS trigger LANGUAGE plpgsql AS $$
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
    AND staff_id=target.staff_id AND terminal_id=target.terminal_id) THEN
    RAISE EXCEPTION 'Order requires matching open cashier shift' USING ERRCODE='23514';
  END IF;
  IF (SELECT coalesce(sum(total_minor),0) FROM local_orders WHERE cash_shift_id=target.id AND branch_id=target.branch_id)
      + NEW.total_minor > 9223372036854775807::numeric THEN
    RAISE EXCEPTION 'Cash shift order aggregate exceeds bigint' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER local_order_cash_shift_guard BEFORE INSERT OR UPDATE ON local_orders
FOR EACH ROW EXECUTE FUNCTION guard_order_cash_shift();
