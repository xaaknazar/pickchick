-- Cancellation is a separate aggregate. Never erase payment history or pinned admission.
CREATE TABLE commerce_cancellation_intents (
 id uuid PRIMARY KEY,
 order_id uuid NOT NULL UNIQUE,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 requested_by uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 state text NOT NULL CHECK(state IN ('waiting_admission','release_pending','cancelled','needs_review')),
 release_event_id uuid UNIQUE REFERENCES commerce_outbox(id),
 expected_edge_version integer CHECK(expected_edge_version>0),
 reservation_id uuid,
 result_event_id uuid UNIQUE,
 resolution_code text CHECK(resolution_code IN ('ADMISSION_UNCONFIRMED','EDGE_NOT_HELD','PAYMENT_HISTORY','VERSION_CONFLICT','NOT_HELD')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(order_id,branch_id,organization_id) REFERENCES commerce_orders(id,branch_id,organization_id),
 CHECK((release_event_id IS NULL AND expected_edge_version IS NULL AND reservation_id IS NULL) OR (release_event_id IS NOT NULL AND expected_edge_version IS NOT NULL AND reservation_id IS NOT NULL)),
 CHECK(state<>'cancelled' OR result_event_id IS NOT NULL),
 CHECK(state<>'release_pending' OR release_event_id IS NOT NULL)
);
CREATE TABLE commerce_cancellation_results (
 event_id uuid PRIMARY KEY,
 device_id uuid NOT NULL REFERENCES fulfillment_transport_bindings(device_id),
 request_event_id uuid NOT NULL UNIQUE REFERENCES commerce_outbox(id),
 cancellation_id uuid NOT NULL UNIQUE REFERENCES commerce_cancellation_intents(id),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 result_digest text NOT NULL CHECK(result_digest ~ '^[a-f0-9]{64}$'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(device_id,event_id) REFERENCES cloud_fulfillment_inbox(device_id,event_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE commerce_cancellation_intents ADD CONSTRAINT commerce_cancellation_result_fk FOREIGN KEY(result_event_id) REFERENCES commerce_cancellation_results(event_id);
CREATE FUNCTION guard_unpaid_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['state','release_event_id','expected_edge_version','reservation_id','result_event_id','resolution_code','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','release_event_id','expected_edge_version','reservation_id','result_event_id','resolution_code','updated_at'])
 OR (OLD.release_event_id IS NOT NULL AND (NEW.release_event_id IS DISTINCT FROM OLD.release_event_id OR NEW.expected_edge_version IS DISTINCT FROM OLD.expected_edge_version OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id))
 OR (OLD.result_event_id IS NOT NULL AND NEW.result_event_id IS DISTINCT FROM OLD.result_event_id)
 OR NOT ((OLD.state='waiting_admission' AND NEW.state IN ('release_pending','needs_review')) OR (OLD.state='release_pending' AND NEW.state IN ('cancelled','needs_review')))
 THEN RAISE EXCEPTION 'Cancellation intent is immutable or terminal' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_cancellation_guard BEFORE UPDATE OR DELETE ON commerce_cancellation_intents FOR EACH ROW EXECUTE FUNCTION guard_unpaid_cancellation();
CREATE TRIGGER commerce_cancellation_results_immutable BEFORE UPDATE OR DELETE ON commerce_cancellation_results FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
-- Independent database fence: every payment attempt (even failed/queued history) is retained.
CREATE FUNCTION unpaid_cancellation_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM commerce_orders WHERE id=NEW.order_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM commerce_cancellation_intents WHERE order_id=NEW.order_id)
 THEN RAISE EXCEPTION 'Order has a durable cancellation intent' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER unpaid_cancellation_attempt_guard BEFORE INSERT ON commerce_payment_attempts FOR EACH ROW EXECUTE FUNCTION unpaid_cancellation_attempt_guard();
CREATE FUNCTION unpaid_cancellation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM commerce_orders WHERE id=NEW.order_id FOR UPDATE;
 IF NEW.state<>'waiting_admission' OR EXISTS(SELECT 1 FROM commerce_payment_attempts WHERE order_id=NEW.order_id) OR EXISTS(SELECT 1 FROM commerce_captures WHERE order_id=NEW.order_id) OR EXISTS(SELECT 1 FROM commerce_refunds WHERE order_id=NEW.order_id) OR EXISTS(SELECT 1 FROM commerce_orders WHERE id=NEW.order_id AND (kitchen_effect_id IS NOT NULL OR attention_required))
 THEN RAISE EXCEPTION 'Cancellation requires zero commercial payment history' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER unpaid_cancellation_insert_guard BEFORE INSERT ON commerce_cancellation_intents FOR EACH ROW EXECUTE FUNCTION unpaid_cancellation_insert_guard();
