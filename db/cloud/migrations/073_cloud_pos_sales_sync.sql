-- Cutover 19.11.2026, lane pos (POS-1; docs/architecture/cutover-2026-11-contracts.md 00, 2.1,
-- 3.3, 5.6, 5.7): cloud projection of paid POS sales made on the cashier edge. Additive only.
-- The edge owns sales, tenders, refunds, receipts and Z reports; the cloud stores what the
-- posSales stream delivers (CLOUD_POS_SALES_SYNC_ENABLED, off by default) and never changes it
-- except by a newer event of the same device. Money is bigint whole tiyn. Enum lists copy
-- packages/contracts/src/cutover-enums.ts verbatim.

-- 1. The old observational projections accept pos_sale (contracts 5.6). Every existing row and
-- every event of today's unpaid flow is accepted exactly as before (NULL execution_mode too).
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='pos_order_sync_projection'::regclass AND contype='c'
    AND (pg_get_constraintdef(oid) LIKE '%execution_mode%' OR pg_get_constraintdef(oid) LIKE '%payment_state%'
      OR pg_get_constraintdef(oid) LIKE 'CHECK ((state = ANY%' OR pg_get_constraintdef(oid) LIKE 'CHECK ((((version = 1)%')
  LOOP EXECUTE format('ALTER TABLE pos_order_sync_projection DROP CONSTRAINT %I',c.conname); END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='pos_kitchen_sync_projection'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%execution_mode%'
  LOOP EXECUTE format('ALTER TABLE pos_kitchen_sync_projection DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE pos_order_sync_projection ADD CONSTRAINT pos_order_sync_projection_execution_mode_check
  CHECK(execution_mode IN ('unpaid_service','pos_sale'));
ALTER TABLE pos_order_sync_projection ADD CONSTRAINT pos_order_sync_projection_payment_state_check
  CHECK(payment_state IN ('not_started','captured'));
ALTER TABLE pos_order_sync_projection ADD CONSTRAINT pos_order_sync_projection_state_check
  CHECK(state IN ('awaiting_payment','cancelled','paid'));
ALTER TABLE pos_order_sync_projection ADD CONSTRAINT pos_order_sync_projection_check
  CHECK((version=1 AND state IN ('awaiting_payment','paid')) OR (version=2 AND state='cancelled'));
ALTER TABLE pos_order_sync_projection ADD CONSTRAINT pos_order_sync_pos_sale_captured
  CHECK((execution_mode IS NOT DISTINCT FROM 'pos_sale') = (payment_state='captured'));
ALTER TABLE pos_order_sync_projection ADD CONSTRAINT pos_order_sync_paid_is_pos_sale
  CHECK(state<>'paid' OR execution_mode='pos_sale');
ALTER TABLE pos_order_sync_projection ADD CONSTRAINT pos_order_sync_pos_sale_never_awaits
  CHECK(execution_mode IS DISTINCT FROM 'pos_sale' OR state<>'awaiting_payment');
ALTER TABLE pos_kitchen_sync_projection ADD CONSTRAINT pos_kitchen_sync_projection_execution_mode_check
  CHECK(execution_mode IN ('unpaid_service','pos_sale'));

-- Kitchen observations follow the commercial projection of the same execution mode; for
-- unpaid_service this is exactly the 018 rule and message.
CREATE OR REPLACE FUNCTION guard_pos_kitchen_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Kitchen projection cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.state<>'accepted' OR NOT EXISTS(
      SELECT 1 FROM pos_order_sync_projection p WHERE p.order_id=NEW.order_id
      AND p.branch_id=NEW.branch_id AND p.device_id=NEW.device_id AND p.producer_id=NEW.producer_id
      AND p.quote_id=NEW.quote_id AND p.snapshot_hash=NEW.quote_digest AND p.execution_mode=NEW.execution_mode
    ) THEN RAISE EXCEPTION 'Unpaid POS commercial observation must precede kitchen admission' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at OR
    (to_jsonb(NEW)-ARRAY['version','state','last_event_id','updated_at','observed_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['version','state','last_event_id','updated_at','observed_at']) OR NOT (
      (OLD.state='accepted' AND NEW.state IN('in_production','ready','cancelled')) OR
      (OLD.state='in_production' AND NEW.state IN('in_production','ready')) OR
      (OLD.state='ready' AND NEW.state='handed_over')
    ) THEN RAISE EXCEPTION 'Invalid observed kitchen transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;

-- 2. posSales receipts: deduplication by event and by (device, sequence) -----------------------
CREATE TABLE cloud_pos_sale_inbox (
  event_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id),
  device_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK(sequence>0),
  kind text NOT NULL CHECK(kind IN ('sale','void','refund','fiscal','shift_report')),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id),
  UNIQUE(device_id,sequence)
);
CREATE FUNCTION reject_cloud_pos_sales_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'POS sales projection history is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER cloud_pos_sale_inbox_immutable BEFORE UPDATE OR DELETE ON cloud_pos_sale_inbox
FOR EACH ROW EXECUTE FUNCTION reject_cloud_pos_sales_mutation();

-- 3. Projections (contracts 3.3 and 5.7: the sales report reads sales, tenders and refunds) -----
CREATE TABLE cloud_pos_sales (
  order_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id),
  device_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  cashier_staff_id uuid NOT NULL,
  display_number integer NOT NULL CHECK(display_number>0),
  sold_at timestamptz NOT NULL,
  -- Asia/Almaty calendar date of sold_at.
  business_date date NOT NULL,
  sales_channel text NOT NULL CHECK(sales_channel IN ('hall','yandex_eda','glovo')),
  service_mode text NOT NULL CHECK(service_mode IN ('dine_in','takeaway')),
  revenue_kind text NOT NULL CHECK(revenue_kind IN ('revenue','staff_meal','marketing')),
  external_order_ref text CHECK(external_order_ref ~ '^[A-Z0-9-]{3,40}$'),
  subtotal_minor bigint NOT NULL CHECK(subtotal_minor>=0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK(discount_minor>=0),
  total_minor bigint NOT NULL CHECK(total_minor>0),
  cash_tendered_minor bigint CHECK(cash_tendered_minor>0),
  change_minor bigint CHECK(change_minor>=0),
  beneficiary text CHECK(length(trim(beneficiary)) BETWEEN 1 AND 100),
  reason text CHECK(length(trim(reason)) BETWEEN 3 AND 300),
  approval_id uuid,
  approval_manager_staff_id uuid,
  release_id uuid NOT NULL,
  menu_version integer NOT NULL CHECK(menu_version>0),
  -- QuoteLine[] exactly as priced in the edge quote (stock write-off by release, P1).
  lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array'),
  state text NOT NULL DEFAULT 'paid' CHECK(state IN ('paid','voided')),
  voided_at timestamptz,
  last_sequence bigint NOT NULL CHECK(last_sequence>0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id),
  UNIQUE(order_id,branch_id),
  CHECK(total_minor=subtotal_minor-discount_minor),
  CHECK((state='voided') = (voided_at IS NOT NULL)),
  CHECK((cash_tendered_minor IS NULL) = (change_minor IS NULL)),
  CHECK((approval_id IS NULL) = (approval_manager_staff_id IS NULL)),
  CHECK(sales_channel='hall' OR (external_order_ref IS NOT NULL AND service_mode='takeaway'
    AND revenue_kind='revenue'))
);
CREATE INDEX cloud_pos_sales_report_idx ON cloud_pos_sales(branch_id,business_date,sold_at,order_id);
-- Only a later event of the same device moves a sale: paid -> voided once, last_sequence up.
CREATE FUNCTION guard_cloud_pos_sale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['state','voided_at','last_sequence'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','voided_at','last_sequence'])
    OR NEW.last_sequence<=OLD.last_sequence
    OR (OLD.state='voided' AND (NEW.state<>'voided' OR NEW.voided_at IS DISTINCT FROM OLD.voided_at)) THEN
    RAISE EXCEPTION 'Invalid POS sale projection change' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_pos_sale_guard BEFORE UPDATE OR DELETE ON cloud_pos_sales
FOR EACH ROW EXECUTE FUNCTION guard_cloud_pos_sale();

CREATE TABLE cloud_pos_tenders (
  tender_id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id),
  method text NOT NULL CHECK(method IN ('cash','kaspi_terminal','aggregator_yandex_eda',
    'aggregator_glovo','staff_meal','marketing','kaspi_manual','chocofood')),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  confirmation text NOT NULL CHECK(confirmation IN ('drawer','cashier_attested','aggregator_attested',
    'manager_approved')),
  reference text CHECK(length(trim(reference)) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL,
  FOREIGN KEY(order_id,branch_id) REFERENCES cloud_pos_sales(order_id,branch_id),
  UNIQUE(tender_id,order_id,branch_id,method)
);
CREATE INDEX cloud_pos_tenders_order_idx ON cloud_pos_tenders(branch_id,order_id);
CREATE TRIGGER cloud_pos_tenders_immutable BEFORE UPDATE OR DELETE ON cloud_pos_tenders
FOR EACH ROW EXECUTE FUNCTION reject_cloud_pos_sales_mutation();

CREATE TABLE cloud_pos_refunds (
  refund_id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id),
  kind text NOT NULL CHECK(kind IN ('void','refund')),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  reason_code text NOT NULL CHECK(reason_code IN ('guest_changed_mind','wrong_order','quality',
    'aggregator_cancelled','cashier_error','other')),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 300),
  staff_id uuid NOT NULL,
  approved_by_staff_id uuid NOT NULL,
  approval_id uuid,
  terminal_id uuid,
  shift_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY(order_id,branch_id) REFERENCES cloud_pos_sales(order_id,branch_id),
  UNIQUE(refund_id,order_id,branch_id)
);
CREATE INDEX cloud_pos_refunds_report_idx ON cloud_pos_refunds(branch_id,created_at,refund_id);
CREATE INDEX cloud_pos_refunds_order_idx ON cloud_pos_refunds(branch_id,order_id);
CREATE TRIGGER cloud_pos_refunds_immutable BEFORE UPDATE OR DELETE ON cloud_pos_refunds
FOR EACH ROW EXECUTE FUNCTION reject_cloud_pos_sales_mutation();

CREATE TABLE cloud_pos_refund_tenders (
  refund_id uuid NOT NULL,
  tender_id uuid NOT NULL,
  order_id uuid NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id),
  method text NOT NULL CHECK(method IN ('cash','kaspi_terminal','aggregator_yandex_eda',
    'aggregator_glovo','staff_meal','marketing','kaspi_manual','chocofood')),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  PRIMARY KEY(refund_id,tender_id),
  FOREIGN KEY(refund_id,order_id,branch_id) REFERENCES cloud_pos_refunds(refund_id,order_id,branch_id),
  FOREIGN KEY(tender_id,order_id,branch_id,method)
    REFERENCES cloud_pos_tenders(tender_id,order_id,branch_id,method)
);
CREATE TRIGGER cloud_pos_refund_tenders_immutable BEFORE UPDATE OR DELETE ON cloud_pos_refund_tenders
FOR EACH ROW EXECUTE FUNCTION reject_cloud_pos_sales_mutation();

CREATE TABLE cloud_pos_fiscal_receipts (
  receipt_id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id),
  refund_id uuid,
  kind text NOT NULL CHECK(kind IN ('sale','refund')),
  mode text NOT NULL CHECK(mode IN ('manual_webkassa')),
  state text NOT NULL CHECK(state IN ('pending','recorded','not_required')),
  receipt_number text CHECK(length(trim(receipt_number)) BETWEEN 1 AND 40),
  version integer NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  recorded_by_staff_id uuid,
  recorded_at timestamptz,
  FOREIGN KEY(order_id,branch_id) REFERENCES cloud_pos_sales(order_id,branch_id),
  FOREIGN KEY(refund_id,order_id,branch_id) REFERENCES cloud_pos_refunds(refund_id,order_id,branch_id),
  CHECK((kind='refund') = (refund_id IS NOT NULL)),
  CHECK((state='recorded') = (receipt_number IS NOT NULL)),
  CHECK((state='recorded') = (recorded_by_staff_id IS NOT NULL AND recorded_at IS NOT NULL))
);
CREATE INDEX cloud_pos_fiscal_receipts_order_idx ON cloud_pos_fiscal_receipts(branch_id,order_id);
-- Only a newer version of the same receipt replaces it (state, number, recording fields).
CREATE FUNCTION guard_cloud_pos_fiscal_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['state','receipt_number','version','recorded_by_staff_id','recorded_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','receipt_number','version','recorded_by_staff_id','recorded_at'])
    OR NEW.version<=OLD.version OR OLD.state='not_required'
    OR (OLD.state='recorded' AND NEW.state<>'recorded') THEN
    RAISE EXCEPTION 'Invalid POS fiscal receipt projection change' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_pos_fiscal_receipt_guard BEFORE UPDATE OR DELETE ON cloud_pos_fiscal_receipts
FOR EACH ROW EXECUTE FUNCTION guard_cloud_pos_fiscal_receipt();

-- Frozen PickChick Z report of a closed edge sales shift (ShiftReport of kind z, not fiscal).
CREATE TABLE cloud_pos_shift_reports (
  shift_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id),
  device_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz NOT NULL,
  report jsonb NOT NULL CHECK(jsonb_typeof(report)='object' AND report->>'kind'='z'),
  expected_cash_minor bigint NOT NULL CHECK(expected_cash_minor>=0),
  counted_cash_minor bigint NOT NULL CHECK(counted_cash_minor>=0),
  discrepancy_minor bigint NOT NULL,
  terminal_reported_minor bigint CHECK(terminal_reported_minor>=0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id),
  CHECK(closed_at>=opened_at),
  CHECK(discrepancy_minor=counted_cash_minor-expected_cash_minor),
  CHECK(report->>'shift_id'=shift_id::text AND report->>'terminal_id'=terminal_id::text)
);
CREATE INDEX cloud_pos_shift_reports_report_idx ON cloud_pos_shift_reports(branch_id,closed_at,shift_id);
CREATE TRIGGER cloud_pos_shift_reports_immutable BEFORE UPDATE OR DELETE ON cloud_pos_shift_reports
FOR EACH ROW EXECUTE FUNCTION reject_cloud_pos_sales_mutation();
