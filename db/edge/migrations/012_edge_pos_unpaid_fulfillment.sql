-- Explicit owner-authorized operational mode. Runtime staff cannot change this
-- setting, and no payment/fiscal/loyalty effect is implied by kitchen admission.
ALTER TABLE branch_config ADD COLUMN pos_service_mode text NOT NULL DEFAULT 'payment_required'
  CHECK(pos_service_mode IN ('payment_required','unpaid_service'));
ALTER TABLE local_orders ADD COLUMN execution_mode text NOT NULL DEFAULT 'payment_required'
  CHECK(execution_mode IN ('payment_required','unpaid_service'));
ALTER TABLE local_orders ADD CONSTRAINT local_order_execution_identity
  UNIQUE(id,branch_id,quote_id,execution_mode);

ALTER TABLE fulfillment_reservations DROP CONSTRAINT fulfillment_reservations_commercial_owner_check;
ALTER TABLE fulfillment_reservations ADD CONSTRAINT fulfillment_reservation_owner
  CHECK(commercial_owner IN ('cloud','edge_pos'));
ALTER TABLE fulfillment_reservations ADD COLUMN admission_kind text NOT NULL DEFAULT 'cloud_authorized';
ALTER TABLE fulfillment_reservations ADD COLUMN local_order_id uuid;
ALTER TABLE fulfillment_reservations ADD COLUMN authorized_by_staff_id uuid;
ALTER TABLE fulfillment_reservations ADD CONSTRAINT fulfillment_local_order_fk
  FOREIGN KEY(local_order_id,branch_id,quote_id,admission_kind)
  REFERENCES local_orders(id,branch_id,quote_id,execution_mode);
ALTER TABLE fulfillment_reservations ADD CONSTRAINT fulfillment_local_actor_fk
  FOREIGN KEY(authorized_by_staff_id,branch_id) REFERENCES local_staff(id,branch_id);
ALTER TABLE fulfillment_reservations ADD CONSTRAINT fulfillment_admission_origin CHECK((
  (commercial_owner='cloud' AND admission_kind='cloud_authorized' AND local_order_id IS NULL
    AND authorized_by_staff_id IS NULL AND snapshot->>'channel'='mobile') OR
  (commercial_owner='edge_pos' AND admission_kind='unpaid_service' AND local_order_id=order_id
    AND authorized_by_staff_id IS NOT NULL AND snapshot->>'channel'='pos'
    AND state IN ('accepted','in_production','ready','handed_over','cancelled')
    AND display_number IS NOT NULL AND authorized_event_id IS NOT NULL)) IS TRUE);

CREATE FUNCTION guard_local_execution_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.execution_mode IS DISTINCT FROM OLD.execution_mode THEN
    RAISE EXCEPTION 'Order execution mode is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.execution_mode='unpaid_service' AND NOT EXISTS(
    SELECT 1 FROM branch_config WHERE id=NEW.branch_id AND ordering_enabled
      AND pos_service_mode='unpaid_service' FOR SHARE) THEN
    RAISE EXCEPTION 'Unpaid service mode is not enabled' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER local_order_execution_guard BEFORE INSERT OR UPDATE ON local_orders
FOR EACH ROW EXECUTE FUNCTION guard_local_execution_mode();

-- Admission and order are one transaction. A caller cannot persist an unpaid
-- service order without its matching actual kitchen reservation.
CREATE FUNCTION guard_local_execution_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_mode='unpaid_service' AND NOT EXISTS(
    SELECT 1 FROM fulfillment_reservations WHERE local_order_id=NEW.id
      AND branch_id=NEW.branch_id AND commercial_owner='edge_pos'
      AND admission_kind='unpaid_service') THEN
    RAISE EXCEPTION 'Unpaid service order requires kitchen admission' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER local_order_execution_admitted AFTER INSERT ON local_orders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_local_execution_admission();

-- One reviewed local preparation anchors the first explicit mode activation.
-- No runtime INSERT/UPDATE permission is granted on this operator record.
CREATE TABLE local_pos_service_setup (
  branch_id uuid PRIMARY KEY REFERENCES branch_config(id),
  setup_hash text NOT NULL CHECK(setup_hash ~ '^[a-f0-9]{64}$'),
  menu_release_id uuid NOT NULL,
  routing_version integer NOT NULL,
  expected_ordering_version integer NOT NULL CHECK(expected_ordering_version>0),
  operator_staff_id uuid NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  enabled_at timestamptz,
  FOREIGN KEY(menu_release_id,branch_id) REFERENCES menu_snapshots(id,branch_id),
  FOREIGN KEY(branch_id,routing_version) REFERENCES fulfillment_routing(branch_id,version),
  FOREIGN KEY(operator_staff_id,branch_id) REFERENCES local_staff(id,branch_id)
);
