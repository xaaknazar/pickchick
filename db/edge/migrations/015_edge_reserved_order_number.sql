-- Reserve the kitchen/customer number before payment; a number never authorizes preparation.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='fulfillment_reservations'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%authorized_event_id%'
      AND pg_get_constraintdef(oid) LIKE '%display_number%'
      AND pg_get_constraintdef(oid) NOT LIKE '%admission_kind%'
  LOOP EXECUTE format('ALTER TABLE fulfillment_reservations DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE fulfillment_reservations ADD CONSTRAINT fulfillment_execution_authorized CHECK(
  (authorized_event_id IS NULL AND state IN ('held','released','cancelled'))
  OR (authorized_event_id IS NOT NULL AND display_number IS NOT NULL)
);
-- Legacy unnumbered holds keep working; only new reservations allocate early.
CREATE FUNCTION guard_reserved_order_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.display_number IS NOT NULL AND
     ROW(NEW.display_number,NEW.business_day) IS DISTINCT FROM ROW(OLD.display_number,OLD.business_day)
  THEN RAISE EXCEPTION 'Reserved order number is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reserved_order_number_guard BEFORE UPDATE ON fulfillment_reservations
FOR EACH ROW EXECUTE FUNCTION guard_reserved_order_number();
