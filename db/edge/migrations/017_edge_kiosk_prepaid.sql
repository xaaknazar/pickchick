-- Kiosk is admitted through the authenticated cloud-authorized prepaid path.
-- POS unpaid_service keeps its existing staff/order evidence requirements.
ALTER TABLE fulfillment_reservations DROP CONSTRAINT fulfillment_admission_origin;
ALTER TABLE fulfillment_reservations ADD CONSTRAINT fulfillment_admission_origin CHECK((
  (commercial_owner='cloud' AND admission_kind='cloud_authorized' AND local_order_id IS NULL
    AND authorized_by_staff_id IS NULL AND snapshot->>'channel' IN ('mobile','kiosk')) OR
  (commercial_owner='edge_pos' AND admission_kind='unpaid_service' AND local_order_id=order_id
    AND authorized_by_staff_id IS NOT NULL AND snapshot->>'channel'='pos'
    AND state IN ('accepted','in_production','ready','handed_over','cancelled')
    AND display_number IS NOT NULL AND authorized_event_id IS NOT NULL)) IS TRUE);
