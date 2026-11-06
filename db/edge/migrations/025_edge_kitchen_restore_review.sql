-- Install only after the cloud restore receiver. Existing outbox bytes remain immutable.
CREATE TABLE fulfillment_restore_epochs (
 epoch integer PRIMARY KEY REFERENCES edge_database_epochs(epoch),
 restore_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 sequence_floor bigint NOT NULL CHECK(sequence_floor >= 1000000000)
);
CREATE TABLE fulfillment_restore_reviews (
 epoch integer NOT NULL REFERENCES fulfillment_restore_epochs(epoch),
 order_id uuid NOT NULL REFERENCES fulfillment_reservations(order_id),
 branch_id uuid NOT NULL REFERENCES branch_config(id),
 state_at_restore text NOT NULL,
 version_at_restore integer NOT NULL,
 PRIMARY KEY(epoch,order_id)
);
CREATE TABLE fulfillment_restore_decisions (
 epoch integer NOT NULL,
 order_id uuid NOT NULL,
 command_id uuid NOT NULL UNIQUE,
 expected_version integer NOT NULL CHECK(expected_version > 0),
 staff_id uuid NOT NULL REFERENCES local_staff(id),
 decision text NOT NULL CHECK(decision IN ('resume','retire')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(epoch,order_id),
 FOREIGN KEY(epoch,order_id) REFERENCES fulfillment_restore_reviews(epoch,order_id)
);
CREATE FUNCTION mark_restored_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.reason IN ('restore','operator') THEN
  INSERT INTO fulfillment_restore_epochs(epoch,sequence_floor)
   VALUES(NEW.epoch,pg_sequence_last_value(pg_get_serial_sequence('fulfillment_outbox','sequence')::regclass));
  INSERT INTO fulfillment_restore_reviews(epoch,order_id,branch_id,state_at_restore,version_at_restore)
   SELECT NEW.epoch,order_id,branch_id,state,version FROM fulfillment_reservations
   WHERE state IN ('held','accepted','in_production','ready','cancel_requested');
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER edge_restore_review AFTER INSERT ON edge_database_epochs
 FOR EACH ROW EXECUTE FUNCTION mark_restored_fulfillment();
-- New POS observations carry a durable provenance marker. Never recompute it during retry.
CREATE FUNCTION stamp_restored_fulfillment_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE marker jsonb;
BEGIN
 IF NEW.payload->>'commercialOwner'='edge_pos' THEN
  SELECT jsonb_build_object('id',e.restore_id,'epoch',e.epoch,'sequenceFloor',e.sequence_floor::text)
   INTO marker FROM fulfillment_restore_reviews r JOIN fulfillment_restore_epochs e USING(epoch)
   WHERE r.order_id=NEW.order_id AND r.branch_id=NEW.branch_id AND NEW.sequence>e.sequence_floor
   ORDER BY e.epoch DESC LIMIT 1;
  IF marker IS NOT NULL THEN NEW.payload := NEW.payload || jsonb_build_object('restoreContext',marker); END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER fulfillment_restore_event BEFORE INSERT ON fulfillment_outbox
 FOR EACH ROW EXECUTE FUNCTION stamp_restored_fulfillment_event();
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.stamp_restored_fulfillment_event() SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
END $$;
REVOKE EXECUTE ON FUNCTION stamp_restored_fulfillment_event() FROM PUBLIC;
CREATE FUNCTION guard_fulfillment_restore_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Restore review history is append-only' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER fulfillment_restore_epochs_guard BEFORE UPDATE OR DELETE ON fulfillment_restore_epochs
 FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_restore_history();
CREATE TRIGGER fulfillment_restore_reviews_guard BEFORE UPDATE OR DELETE ON fulfillment_restore_reviews
 FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_restore_history();
CREATE TRIGGER fulfillment_restore_decisions_guard BEFORE UPDATE OR DELETE ON fulfillment_restore_decisions
 FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_restore_history();
