-- Durable read-only reporting stream. It never settles payments or changes shift ownership.
CREATE TABLE cashier_report_outbox (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 sequence bigserial UNIQUE,
 branch_id uuid NOT NULL REFERENCES branch_config(id),
 kind text NOT NULL CHECK(kind IN ('shift','order')),
 entity_id uuid NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 acknowledged_at timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 last_error text
);
CREATE INDEX cashier_report_pending_idx ON cashier_report_outbox(branch_id,sequence) WHERE acknowledged_at IS NULL;
CREATE FUNCTION append_cashier_shift_report(target uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO cashier_report_outbox(branch_id,kind,entity_id,payload)
 SELECT s.branch_id,'shift',s.id,jsonb_build_object(
 'shift_id',s.id,'terminal_id',s.terminal_id,'staff_id',s.staff_id,'state',s.state,
 'opened_at',s.opened_at,'closed_at',s.closed_at,'opening_cash_minor',s.opening_cash_minor::text,
 'cash_in_minor',coalesce(m.cash_in,0)::text,'cash_out_minor',coalesce(m.cash_out,0)::text,
 'expected_cash_minor',(s.opening_cash_minor+coalesce(m.cash_in,0)-coalesce(m.cash_out,0))::text,
 'counted_cash_minor',s.counted_cash_minor::text,'discrepancy_minor',s.discrepancy_minor::text)
 FROM local_cash_shifts s LEFT JOIN LATERAL (
 SELECT sum(amount_minor::numeric) FILTER(WHERE direction='in') cash_in,
 sum(amount_minor::numeric) FILTER(WHERE direction='out') cash_out
 FROM local_cash_movements WHERE shift_id=s.id AND branch_id=s.branch_id) m ON true WHERE s.id=target;
END $$;
CREATE FUNCTION append_cashier_order_report(target uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO cashier_report_outbox(branch_id,kind,entity_id,payload)
 SELECT o.branch_id,'order',o.id,jsonb_build_object(
 'order_id',o.id,'cash_shift_id',o.cash_shift_id,'created_at',o.created_at,'total_minor',o.total_minor::text,
 'state',o.state,'version',o.version,'execution_mode',o.execution_mode,
 'kitchen_state',r.state,'display_number',r.display_number::text,
 'lines',(SELECT jsonb_agg(jsonb_build_object('variant_id',l->'variant_id','name',l->'name','quantity',l->'quantity','unit_price_minor',l->'unit_price_minor','total_minor',l->'total_minor')) FROM jsonb_array_elements(q.snapshot->'lines') l))
 FROM local_orders o JOIN checkout_quotes q ON q.id=o.quote_id AND q.branch_id=o.branch_id
 LEFT JOIN fulfillment_reservations r ON r.local_order_id=o.id AND r.branch_id=o.branch_id WHERE o.id=target;
END $$;
CREATE FUNCTION cashier_report_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='local_cash_shifts' THEN PERFORM append_cashier_shift_report(NEW.id);
 ELSIF TG_TABLE_NAME='local_cash_movements' THEN PERFORM append_cashier_shift_report(NEW.shift_id);
 ELSIF TG_TABLE_NAME='local_orders' THEN PERFORM append_cashier_order_report(NEW.id);
 ELSIF NEW.local_order_id IS NOT NULL THEN PERFORM append_cashier_order_report(NEW.local_order_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cashier_shift_report AFTER INSERT OR UPDATE ON local_cash_shifts FOR EACH ROW EXECUTE FUNCTION cashier_report_source_changed();
CREATE TRIGGER cashier_movement_report AFTER INSERT ON local_cash_movements FOR EACH ROW EXECUTE FUNCTION cashier_report_source_changed();
CREATE TRIGGER cashier_order_report AFTER INSERT OR UPDATE ON local_orders FOR EACH ROW EXECUTE FUNCTION cashier_report_source_changed();
CREATE TRIGGER cashier_kitchen_report AFTER INSERT OR UPDATE ON fulfillment_reservations FOR EACH ROW EXECUTE FUNCTION cashier_report_source_changed();
-- Existing rows become durable snapshots exactly once with the migration.
SELECT append_cashier_shift_report(id) FROM local_cash_shifts ORDER BY opened_at,id;
SELECT append_cashier_order_report(id) FROM local_orders ORDER BY created_at,id;
CREATE FUNCTION guard_cashier_report_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.event_id,NEW.sequence,NEW.branch_id,NEW.kind,NEW.entity_id,NEW.payload)
 IS DISTINCT FROM ROW(OLD.event_id,OLD.sequence,OLD.branch_id,OLD.kind,OLD.entity_id,OLD.payload)
 THEN RAISE EXCEPTION 'Cashier report identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cashier_report_immutable BEFORE UPDATE OR DELETE ON cashier_report_outbox FOR EACH ROW EXECUTE FUNCTION guard_cashier_report_outbox();
