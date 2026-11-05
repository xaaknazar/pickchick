-- Cutover 19.11.2026, lane pos (POS-1; docs/architecture/cutover-2026-11-contracts.md 00, 2.1,
-- 3.3, 5.1, 5.6): paid POS sales on the cashier edge. Additive only, and everything ships off:
-- branch_config.pos_service_mode keeps its value and every payment method starts disabled.
-- Old rows, the unpaid flow, its guards and the cashier report of every non-sales shift behave
-- byte for byte as before. The new tables are read only in 'pos_sale' branches of the guards
-- (nested IF, never planned otherwise), so a runtime role without the 026 grants keeps working.
-- Enum lists below copy packages/contracts/src/cutover-enums.ts verbatim.

-- 1. Service mode and order states --------------------------------------------------------
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='branch_config'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%pos_service_mode%'
  LOOP EXECUTE format('ALTER TABLE branch_config DROP CONSTRAINT %I',c.conname); END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='local_orders'::regclass AND contype='c'
    AND (pg_get_constraintdef(oid) LIKE '%execution_mode%' OR pg_get_constraintdef(oid) LIKE '%payment_state%'
      OR pg_get_constraintdef(oid) LIKE '%cancellation_reason%' OR pg_get_constraintdef(oid) LIKE 'CHECK ((state = ANY%')
  LOOP EXECUTE format('ALTER TABLE local_orders DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE branch_config ADD CONSTRAINT branch_config_pos_service_mode_check
  CHECK(pos_service_mode IN ('payment_required','unpaid_service','pos_sale'));
ALTER TABLE local_orders ADD CONSTRAINT local_orders_state_check
  CHECK(state IN ('awaiting_payment','cancelled','paid'));
ALTER TABLE local_orders ADD CONSTRAINT local_orders_payment_state_check
  CHECK(payment_state IN ('not_started','captured'));
ALTER TABLE local_orders ADD CONSTRAINT local_orders_execution_mode_check
  CHECK(execution_mode IN ('payment_required','unpaid_service','pos_sale'));
ALTER TABLE local_orders ADD CONSTRAINT local_orders_check CHECK((
  (state='cancelled' AND length(cancellation_reason) BETWEEN 1 AND 300)
  OR (state IN ('awaiting_payment','paid') AND cancellation_reason IS NULL)) IS TRUE);
-- A paid sale is captured from its first version; nothing else is ever captured or paid.
-- fiscal_state stays not_requested: receipts live in pos_fiscal_receipts.
ALTER TABLE local_orders ADD CONSTRAINT local_order_pos_sale_captured
  CHECK((execution_mode='pos_sale') = (payment_state='captured'));
ALTER TABLE local_orders ADD CONSTRAINT local_order_paid_is_pos_sale
  CHECK(state<>'paid' OR execution_mode='pos_sale');
ALTER TABLE local_orders ADD CONSTRAINT local_order_pos_sale_never_awaits
  CHECK(execution_mode<>'pos_sale' OR state<>'awaiting_payment');

-- INSERT: a pos_sale starts paid, everything else awaiting payment (as before). UPDATE: only
-- awaiting_payment|paid -> cancelled with version+1; payment_state never changes. Partial
-- refunds never touch the order row (versions stay 1/2, cloud016 invariant).
CREATE OR REPLACE FUNCTION guard_local_order_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Orders cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.state <>
      (CASE WHEN NEW.execution_mode = 'pos_sale' THEN 'paid' ELSE 'awaiting_payment' END) THEN
      RAISE EXCEPTION 'Invalid initial order state' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.branch_id <> OLD.branch_id OR NEW.quote_id <> OLD.quote_id
    OR NEW.total_minor <> OLD.total_minor OR NEW.created_at <> OLD.created_at
    OR OLD.state NOT IN ('awaiting_payment', 'paid') OR NEW.state <> 'cancelled'
    OR NEW.version <> OLD.version + 1 OR NEW.payment_state IS DISTINCT FROM OLD.payment_state THEN
    RAISE EXCEPTION 'Invalid local order transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

-- pos_sale only while the operator enabled it; in that mode nothing else is accepted (an older
-- runtime's payment_required order could never be paid).
CREATE OR REPLACE FUNCTION guard_local_execution_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.execution_mode IS DISTINCT FROM OLD.execution_mode THEN
    RAISE EXCEPTION 'Order execution mode is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.execution_mode='unpaid_service' AND NOT EXISTS(
    SELECT 1 FROM branch_config WHERE id=NEW.branch_id AND ordering_enabled
      AND pos_service_mode='unpaid_service' FOR SHARE) THEN
    RAISE EXCEPTION 'Unpaid service mode is not enabled' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.execution_mode='pos_sale' AND NOT EXISTS(
    SELECT 1 FROM branch_config WHERE id=NEW.branch_id AND ordering_enabled
      AND pos_service_mode='pos_sale' FOR SHARE) THEN
    RAISE EXCEPTION 'POS sale mode is not enabled' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.execution_mode='payment_required' AND EXISTS(
    SELECT 1 FROM branch_config WHERE id=NEW.branch_id AND pos_service_mode='pos_sale') THEN
    RAISE EXCEPTION 'Only paid POS sales are accepted in pos_sale mode' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

-- 2. Kitchen admission of a paid sale -------------------------------------------------------
ALTER TABLE fulfillment_reservations DROP CONSTRAINT fulfillment_admission_origin;
ALTER TABLE fulfillment_reservations ADD CONSTRAINT fulfillment_admission_origin CHECK((
  (commercial_owner='cloud' AND admission_kind='cloud_authorized' AND local_order_id IS NULL
    AND authorized_by_staff_id IS NULL AND snapshot->>'channel' IN ('mobile','kiosk')) OR
  (commercial_owner='edge_pos' AND admission_kind IN ('unpaid_service','pos_sale') AND local_order_id=order_id
    AND authorized_by_staff_id IS NOT NULL AND snapshot->>'channel'='pos'
    AND state IN ('accepted','in_production','ready','handed_over','cancelled')
    AND display_number IS NOT NULL AND authorized_event_id IS NOT NULL)) IS TRUE);

-- 3. Drawer sessions ---------------------------------------------------------------------------
-- A shift counts sales exactly when it opens in pos_sale mode; the flag never changes.
ALTER TABLE local_cash_shifts ADD COLUMN sales_mode boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION guard_local_cash_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cash shifts cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'open' THEN RAISE EXCEPTION 'Cash shifts must start open' USING ERRCODE='23514'; END IF;
    -- The branch row lock orders this against a concurrent mode switch (which needs no open shift).
    IF NEW.sales_mode IS DISTINCT FROM (SELECT pos_service_mode='pos_sale' FROM branch_config
        WHERE id=NEW.branch_id FOR SHARE) THEN
      RAISE EXCEPTION 'Cash shift sales mode must follow the POS service mode' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state<>'open' OR NEW.state<>'closed' OR
    ROW(NEW.id,NEW.branch_id,NEW.terminal_id,NEW.staff_id,NEW.opening_cash_minor,NEW.opened_at,NEW.sales_mode)
      IS DISTINCT FROM ROW(OLD.id,OLD.branch_id,OLD.terminal_id,OLD.staff_id,OLD.opening_cash_minor,OLD.opened_at,OLD.sales_mode) THEN
    RAISE EXCEPTION 'Invalid cash shift transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

-- 4. Operator settings: payment methods and their append-only audit -----------------------------
-- Changed only by scripts/pos-sales-setup.mjs (owner role); the runtime reads. A method row or
-- a pos_sale mode switch changes only together with an audit row whose before/after match it.
CREATE TABLE pos_sales_setting_changes (
  change_id uuid PRIMARY KEY,
  change_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  subject text NOT NULL CHECK(subject IN ('pos_service_mode','cash','kaspi_terminal',
    'aggregator_yandex_eda','aggregator_glovo','staff_meal','marketing','kaspi_manual','chocofood')),
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  actor text NOT NULL CHECK(actor IN ('operator','shift_manager')),
  staff_id uuid,
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 300),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  CHECK((actor='shift_manager') = (staff_id IS NOT NULL)),
  CHECK((CASE WHEN subject='pos_service_mode' THEN
      before-'pos_service_mode'='{}'::jsonb AND after-'pos_service_mode'='{}'::jsonb
      AND before->>'pos_service_mode' IN ('payment_required','unpaid_service','pos_sale')
      AND after->>'pos_service_mode' IN ('payment_required','unpaid_service','pos_sale')
    ELSE
      before-ARRAY['enabled','fiscal_policy']='{}'::jsonb AND after-ARRAY['enabled','fiscal_policy']='{}'::jsonb
      AND jsonb_typeof(before->'enabled')='boolean' AND jsonb_typeof(after->'enabled')='boolean'
      AND before->>'fiscal_policy' IN ('manual_webkassa','not_required')
      AND after->>'fiscal_policy' IN ('manual_webkassa','not_required')
    END) IS TRUE)
);
CREATE INDEX pos_sales_setting_changes_subject_idx
  ON pos_sales_setting_changes(branch_id,subject,change_sequence DESC);
CREATE FUNCTION reject_pos_sales_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'POS sales history is append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER pos_sales_setting_changes_immutable BEFORE UPDATE OR DELETE ON pos_sales_setting_changes
FOR EACH ROW EXECUTE FUNCTION reject_pos_sales_history_mutation();

-- Policy of contracts section 00: approval only for staff meal and marketing, mixed payment only
-- from cash/kaspi_terminal/kaspi_manual (pinned here, a code decision); enabled and
-- fiscal_policy are the operator's.
CREATE TABLE pos_payment_methods (
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  code text NOT NULL CHECK(code IN ('cash','kaspi_terminal','aggregator_yandex_eda',
    'aggregator_glovo','staff_meal','marketing','kaspi_manual','chocofood')),
  enabled boolean NOT NULL DEFAULT false,
  requires_approval boolean NOT NULL,
  allow_in_mix boolean NOT NULL,
  fiscal_policy text NOT NULL CHECK(fiscal_policy IN ('manual_webkassa','not_required')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(branch_id,code),
  CHECK(requires_approval = (code IN ('staff_meal','marketing'))),
  CHECK(allow_in_mix = (code IN ('cash','kaspi_terminal','kaspi_manual')))
);
CREATE FUNCTION guard_pos_payment_method() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest pos_sales_setting_changes%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'POS payment methods cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.enabled THEN RAISE EXCEPTION 'A POS payment method starts disabled' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.branch_id,NEW.code,NEW.requires_approval,NEW.allow_in_mix)
    IS DISTINCT FROM ROW(OLD.branch_id,OLD.code,OLD.requires_approval,OLD.allow_in_mix) THEN
    RAISE EXCEPTION 'POS payment method identity is immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO latest FROM pos_sales_setting_changes WHERE branch_id=NEW.branch_id AND subject=NEW.code
    ORDER BY change_sequence DESC LIMIT 1;
  IF NOT FOUND
    OR latest.before IS DISTINCT FROM jsonb_build_object('enabled',OLD.enabled,'fiscal_policy',OLD.fiscal_policy)
    OR latest.after IS DISTINCT FROM jsonb_build_object('enabled',NEW.enabled,'fiscal_policy',NEW.fiscal_policy) THEN
    RAISE EXCEPTION 'POS payment method changes require a matching audit record' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER pos_payment_method_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_payment_methods
FOR EACH ROW EXECUTE FUNCTION guard_pos_payment_method();

-- All eight methods of contracts section 00 for a branch, disabled, with the default fiscal
-- policy (receipt required for cash, kaspi_terminal and kaspi_manual).
CREATE FUNCTION pos_payment_method_seed(p_branch uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pos_payment_methods(branch_id,code,requires_approval,allow_in_mix,fiscal_policy)
  SELECT p_branch,m.code,m.code IN ('staff_meal','marketing'),m.code IN ('cash','kaspi_terminal','kaspi_manual'),
    CASE WHEN m.code IN ('cash','kaspi_terminal','kaspi_manual') THEN 'manual_webkassa' ELSE 'not_required' END
  FROM unnest(ARRAY['cash','kaspi_terminal','aggregator_yandex_eda','aggregator_glovo','staff_meal',
    'marketing','kaspi_manual','chocofood']) m(code)
  ON CONFLICT DO NOTHING;
END $$;
CREATE FUNCTION seed_branch_pos_payment_methods() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pos_payment_method_seed(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER pos_payment_methods_seed AFTER INSERT ON branch_config
FOR EACH ROW EXECUTE FUNCTION seed_branch_pos_payment_methods();
SELECT pos_payment_method_seed(id) FROM branch_config ORDER BY id;

-- Switching into or out of pos_sale needs every drawer closed (no shift may straddle the
-- modes) and an operator audit record; payment_required <-> unpaid_service stays as before.
CREATE FUNCTION guard_pos_service_mode_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest pos_sales_setting_changes%ROWTYPE;
BEGIN
  IF NEW.pos_service_mode IS NOT DISTINCT FROM OLD.pos_service_mode
    OR 'pos_sale' NOT IN (NEW.pos_service_mode, OLD.pos_service_mode) THEN
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM local_cash_shifts WHERE branch_id=NEW.id AND state='open') THEN
    RAISE EXCEPTION 'Close every cash shift before switching pos_sale mode' USING ERRCODE='23514';
  END IF;
  SELECT * INTO latest FROM pos_sales_setting_changes WHERE branch_id=NEW.id AND subject='pos_service_mode'
    ORDER BY change_sequence DESC LIMIT 1;
  IF NOT FOUND
    OR latest.before IS DISTINCT FROM jsonb_build_object('pos_service_mode',OLD.pos_service_mode)
    OR latest.after IS DISTINCT FROM jsonb_build_object('pos_service_mode',NEW.pos_service_mode) THEN
    RAISE EXCEPTION 'pos_sale mode switches require a matching audit record' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_service_mode_change_guard BEFORE UPDATE OF pos_service_mode ON branch_config
FOR EACH ROW EXECUTE FUNCTION guard_pos_service_mode_change();

-- Last GET pos/config of each cash desk (client build when it sends one), so the operator
-- enables pos_sale only after every desk runs the new client.
CREATE TABLE pos_config_fetches (
  terminal_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  client_version text CHECK(client_version ~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$'),
  first_fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(terminal_id,branch_id) REFERENCES local_terminals(id,branch_id),
  FOREIGN KEY(staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  CHECK(last_fetched_at>=first_fetched_at)
);
CREATE FUNCTION guard_pos_config_fetch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.terminal_id,NEW.branch_id,NEW.first_fetched_at) IS DISTINCT FROM ROW(OLD.terminal_id,OLD.branch_id,OLD.first_fetched_at)
    OR NEW.last_fetched_at<OLD.last_fetched_at THEN
    RAISE EXCEPTION 'POS config fetch identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_config_fetch_guard BEFORE UPDATE ON pos_config_fetches
FOR EACH ROW EXECUTE FUNCTION guard_pos_config_fetch();

-- 5. One-time manager approvals (staff/approvals, TTL 120 s) -----------------------------------
CREATE TABLE local_manager_approvals (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  terminal_id uuid NOT NULL,
  manager_staff_id uuid NOT NULL,
  requested_by_staff_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('void','refund','staff_meal','marketing','fiscal_correct',
    'shift_close_pending_fiscal','discount','cash_movement','kds_mode','courier_incident_update')),
  subject jsonb NOT NULL CHECK(jsonb_typeof(subject)='object'),
  subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_command_key uuid,
  FOREIGN KEY(terminal_id,branch_id) REFERENCES local_terminals(id,branch_id),
  FOREIGN KEY(manager_staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  FOREIGN KEY(requested_by_staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  UNIQUE(id,branch_id),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '120 seconds'),
  CHECK((consumed_at IS NULL) = (consumed_command_key IS NULL)),
  CHECK(consumed_at IS NULL OR (consumed_at>=created_at AND consumed_at<=expires_at))
);
CREATE INDEX local_manager_approvals_expiry_idx ON local_manager_approvals(branch_id,expires_at);
CREATE FUNCTION guard_local_manager_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Manager approvals are append-only' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    NEW.created_at := clock_timestamp();
    IF NEW.consumed_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM local_staff WHERE id=NEW.manager_staff_id
        AND branch_id=NEW.branch_id AND role='shift_manager' AND active) THEN
      RAISE EXCEPTION 'Approval requires an active shift manager' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['consumed_at','consumed_command_key']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['consumed_at','consumed_command_key'])
    OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'A manager approval is consumed once' USING ERRCODE='23514';
  END IF;
  NEW.consumed_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER local_manager_approval_guard BEFORE INSERT OR UPDATE OR DELETE ON local_manager_approvals
FOR EACH ROW EXECUTE FUNCTION guard_local_manager_approval();
-- A consumed approval of this action, branch and cash desk.
CREATE FUNCTION pos_approval_consumed(p_approval uuid, p_branch uuid, p_terminal uuid, p_action text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM local_manager_approvals WHERE id=p_approval AND branch_id=p_branch
    AND terminal_id=p_terminal AND action=p_action AND consumed_at IS NOT NULL)
$$;

-- 6. Sales, tenders, refunds and receipts (append-only) ----------------------------------------
CREATE TABLE pos_sales (
  order_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  execution_mode text NOT NULL DEFAULT 'pos_sale' CHECK(execution_mode='pos_sale'),
  shift_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  cashier_staff_id uuid NOT NULL,
  sales_channel text NOT NULL CHECK(sales_channel IN ('hall','yandex_eda','glovo')),
  -- Aggregator or ChocoFood order number, stored upper-case (ExternalOrderRefSchema).
  external_order_ref text CHECK(external_order_ref ~ '^[A-Z0-9-]{3,40}$'),
  revenue_kind text NOT NULL CHECK(revenue_kind IN ('revenue','staff_meal','marketing')),
  total_minor bigint NOT NULL CHECK(total_minor>0),
  cash_tendered_minor bigint CHECK(cash_tendered_minor>0),
  change_minor bigint CHECK(change_minor>=0),
  beneficiary text CHECK(length(trim(beneficiary)) BETWEEN 1 AND 100),
  reason text CHECK(length(trim(reason)) BETWEEN 3 AND 300),
  approval_id uuid UNIQUE,
  -- The cashier confirmed the service mode and repeated the order to the guest (KS8).
  review_confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(order_id,branch_id,quote_id,execution_mode)
    REFERENCES local_orders(id,branch_id,quote_id,execution_mode),
  FOREIGN KEY(shift_id,branch_id) REFERENCES local_cash_shifts(id,branch_id),
  FOREIGN KEY(terminal_id,branch_id) REFERENCES local_terminals(id,branch_id),
  FOREIGN KEY(cashier_staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  FOREIGN KEY(approval_id,branch_id) REFERENCES local_manager_approvals(id,branch_id),
  UNIQUE(order_id,branch_id),
  CHECK((cash_tendered_minor IS NULL) = (change_minor IS NULL)),
  CHECK(sales_channel='hall' OR (external_order_ref IS NOT NULL AND revenue_kind='revenue'))
);
-- Protection against entering one aggregator (or ChocoFood) order twice.
CREATE UNIQUE INDEX pos_sales_external_order_ref_idx ON pos_sales(branch_id,sales_channel,external_order_ref)
  WHERE external_order_ref IS NOT NULL;
CREATE INDEX pos_sales_shift_idx ON pos_sales(branch_id,shift_id,created_at,order_id);
CREATE FUNCTION guard_pos_sale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'POS sales are immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM local_orders o
      JOIN checkout_quotes q ON q.id=o.quote_id AND q.branch_id=o.branch_id
      JOIN local_cash_shifts c ON c.id=o.cash_shift_id AND c.branch_id=o.branch_id
      WHERE o.id=NEW.order_id AND o.branch_id=NEW.branch_id AND o.cash_shift_id=NEW.shift_id
        AND q.terminal_id=NEW.terminal_id AND q.staff_id=NEW.cashier_staff_id
        AND c.terminal_id=NEW.terminal_id AND c.state='open' AND c.sales_mode) THEN
    RAISE EXCEPTION 'POS sale requires its order and an open sales shift of its cash desk' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_sale_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_sales
FOR EACH ROW EXECUTE FUNCTION guard_pos_sale();

CREATE TABLE pos_sale_tenders (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  method text NOT NULL CHECK(method IN ('cash','kaspi_terminal','aggregator_yandex_eda',
    'aggregator_glovo','staff_meal','marketing','kaspi_manual','chocofood')),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  confirmation text NOT NULL CHECK(confirmation IN ('drawer','cashier_attested','aggregator_attested',
    'manager_approved')),
  reference text CHECK(length(trim(reference)) BETWEEN 1 AND 40),
  -- PaymentTerminalPort attempt of a future adapter; always NULL in P0 (manual marking).
  attempt_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(order_id,branch_id) REFERENCES pos_sales(order_id,branch_id),
  UNIQUE(id,order_id,branch_id,method),
  CHECK(confirmation = CASE WHEN method='cash' THEN 'drawer'
    WHEN method IN ('kaspi_terminal','kaspi_manual') THEN 'cashier_attested'
    WHEN method IN ('aggregator_yandex_eda','aggregator_glovo','chocofood') THEN 'aggregator_attested'
    ELSE 'manager_approved' END),
  -- Kaspi Smart POS takes whole tenge only.
  CHECK(method<>'kaspi_terminal' OR amount_minor%100=0)
);
CREATE INDEX pos_sale_tenders_order_idx ON pos_sale_tenders(branch_id,order_id);
CREATE TRIGGER pos_sale_tenders_immutable BEFORE UPDATE OR DELETE ON pos_sale_tenders
FOR EACH ROW EXECUTE FUNCTION reject_pos_sales_history_mutation();

CREATE TABLE pos_refunds (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('void','refund')),
  shift_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  approved_by_staff_id uuid NOT NULL,
  approval_id uuid NOT NULL UNIQUE,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  reason_code text NOT NULL CHECK(reason_code IN ('guest_changed_mind','wrong_order','quality',
    'aggregator_cancelled','cashier_error','other')),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 300),
  -- Refund by order lines (P1); NULL in P0.
  lines jsonb CHECK(jsonb_typeof(lines)='array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(order_id,branch_id) REFERENCES pos_sales(order_id,branch_id),
  FOREIGN KEY(shift_id,branch_id) REFERENCES local_cash_shifts(id,branch_id),
  FOREIGN KEY(terminal_id,branch_id) REFERENCES local_terminals(id,branch_id),
  FOREIGN KEY(staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  FOREIGN KEY(approved_by_staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  FOREIGN KEY(approval_id,branch_id) REFERENCES local_manager_approvals(id,branch_id),
  UNIQUE(id,order_id,branch_id)
);
CREATE INDEX pos_refunds_order_idx ON pos_refunds(branch_id,order_id);
CREATE INDEX pos_refunds_shift_idx ON pos_refunds(branch_id,shift_id,created_at,id);
-- Made at an open sales shift of the refunding cash desk, with that desk's consumed approval
-- of the same action (void|refund) by the manager it names.
CREATE FUNCTION guard_pos_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'POS refunds are immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM local_cash_shifts WHERE id=NEW.shift_id AND branch_id=NEW.branch_id
      AND terminal_id=NEW.terminal_id AND state='open' AND sales_mode) THEN
    RAISE EXCEPTION 'POS refund requires an open sales shift of its cash desk' USING ERRCODE='23514';
  END IF;
  IF NOT pos_approval_consumed(NEW.approval_id,NEW.branch_id,NEW.terminal_id,NEW.kind) OR NOT EXISTS(
      SELECT 1 FROM local_manager_approvals WHERE id=NEW.approval_id AND manager_staff_id=NEW.approved_by_staff_id) THEN
    RAISE EXCEPTION 'POS refund requires its manager approval' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_refund_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_refunds
FOR EACH ROW EXECUTE FUNCTION guard_pos_refund();

CREATE TABLE pos_refund_tenders (
  refund_id uuid NOT NULL,
  tender_id uuid NOT NULL,
  order_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  method text NOT NULL CHECK(method IN ('cash','kaspi_terminal','aggregator_yandex_eda',
    'aggregator_glovo','staff_meal','marketing','kaspi_manual','chocofood')),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  reference text CHECK(length(trim(reference)) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(refund_id,tender_id),
  FOREIGN KEY(refund_id,order_id,branch_id) REFERENCES pos_refunds(id,order_id,branch_id),
  FOREIGN KEY(tender_id,order_id,branch_id,method) REFERENCES pos_sale_tenders(id,order_id,branch_id,method)
);
CREATE INDEX pos_refund_tenders_tender_idx ON pos_refund_tenders(branch_id,tender_id);

-- Cash sales (tendered cash minus change, i.e. the cash tender) of the sales made in this
-- shift and cash refunds paid out of this shift's drawer. Ordinary shifts have none.
CREATE FUNCTION pos_shift_cash(p_shift uuid, OUT cash_sales_minor bigint, OUT cash_refunds_minor bigint)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  SELECT coalesce(sum(t.amount_minor),0) INTO cash_sales_minor FROM pos_sale_tenders t
    JOIN pos_sales s ON s.order_id=t.order_id AND s.branch_id=t.branch_id
    WHERE s.shift_id=p_shift AND t.method='cash';
  SELECT coalesce(sum(r.amount_minor),0) INTO cash_refunds_minor FROM pos_refund_tenders r
    JOIN pos_refunds f ON f.id=r.refund_id AND f.branch_id=r.branch_id
    WHERE f.shift_id=p_shift AND r.method='cash';
END $$;

-- Per refunded tender: never more than it paid; cash only while the drawer holds it.
CREATE FUNCTION guard_pos_refund_tender() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE refund pos_refunds%ROWTYPE; shift local_cash_shifts%ROWTYPE; drawer numeric;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'POS refunds are immutable' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pickchick-pos-refund:'||NEW.order_id::text,0));
  IF (SELECT amount_minor::numeric FROM pos_sale_tenders WHERE id=NEW.tender_id) <
      (SELECT coalesce(sum(amount_minor::numeric),0) FROM pos_refund_tenders WHERE tender_id=NEW.tender_id)
        + NEW.amount_minor THEN
    RAISE EXCEPTION 'POS refund exceeds its tender' USING ERRCODE='23514';
  END IF;
  IF NEW.method='cash' THEN
    SELECT * INTO refund FROM pos_refunds WHERE id=NEW.refund_id;
    SELECT * INTO shift FROM local_cash_shifts WHERE id=refund.shift_id AND branch_id=refund.branch_id FOR UPDATE;
    SELECT shift.opening_cash_minor
        + coalesce(sum(CASE WHEN direction='in' THEN amount_minor::numeric ELSE -amount_minor::numeric END),0)
      INTO drawer FROM local_cash_movements WHERE shift_id=shift.id;
    SELECT drawer+c.cash_sales_minor-c.cash_refunds_minor INTO drawer FROM pos_shift_cash(shift.id) c;
    IF drawer<NEW.amount_minor THEN
      RAISE EXCEPTION 'POS cash refund exceeds the drawer' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_refund_tender_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_refund_tenders
FOR EACH ROW EXECUTE FUNCTION guard_pos_refund_tender();

-- Manual Webkassa (FiscalPort mode manual): one sale receipt per sale and one per refund. Only
-- state, number, version and the recording fields change: pending -> recorded, pending ->
-- not_required (the sale was voided before its receipt), recorded -> recorded (correction with
-- a fiscal_correct approval). The number is not unique: Webkassa numbering is UNCONFIRMED.
CREATE TABLE pos_fiscal_receipts (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  refund_id uuid,
  kind text NOT NULL CHECK(kind IN ('sale','refund')),
  mode text NOT NULL DEFAULT 'manual_webkassa' CHECK(mode IN ('manual_webkassa')),
  state text NOT NULL CHECK(state IN ('pending','recorded','not_required')),
  receipt_number text CHECK(length(trim(receipt_number)) BETWEEN 1 AND 40),
  version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  recorded_by_staff_id uuid,
  recorded_at timestamptz,
  approval_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(order_id,branch_id) REFERENCES pos_sales(order_id,branch_id),
  FOREIGN KEY(refund_id,order_id,branch_id) REFERENCES pos_refunds(id,order_id,branch_id),
  FOREIGN KEY(recorded_by_staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  FOREIGN KEY(approval_id,branch_id) REFERENCES local_manager_approvals(id,branch_id),
  CHECK((kind='refund') = (refund_id IS NOT NULL)),
  CHECK((state='recorded') = (receipt_number IS NOT NULL)),
  CHECK((state='recorded') = (recorded_by_staff_id IS NOT NULL AND recorded_at IS NOT NULL))
);
CREATE UNIQUE INDEX pos_fiscal_sale_receipt_idx ON pos_fiscal_receipts(order_id) WHERE kind='sale';
CREATE UNIQUE INDEX pos_fiscal_refund_receipt_idx ON pos_fiscal_receipts(refund_id) WHERE refund_id IS NOT NULL;
CREATE INDEX pos_fiscal_pending_idx ON pos_fiscal_receipts(branch_id,created_at,id) WHERE state='pending';
CREATE FUNCTION guard_pos_fiscal_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE terminal uuid;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'POS fiscal receipts cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.approval_id IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid initial POS fiscal receipt' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','receipt_number','version','recorded_by_staff_id','recorded_at','approval_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','receipt_number','version','recorded_by_staff_id','recorded_at','approval_id'])
    OR NEW.version<>OLD.version+1
    OR NOT ((OLD.state='pending' AND NEW.state='recorded' AND NEW.approval_id IS NOT DISTINCT FROM OLD.approval_id)
      OR (OLD.state='pending' AND NEW.state='not_required' AND NEW.approval_id IS NOT DISTINCT FROM OLD.approval_id
        AND EXISTS(SELECT 1 FROM pos_refunds WHERE order_id=NEW.order_id AND branch_id=NEW.branch_id AND kind='void'))
      OR (OLD.state='recorded' AND NEW.state='recorded' AND NEW.approval_id IS NOT NULL
        AND NEW.approval_id IS DISTINCT FROM OLD.approval_id)) THEN
    RAISE EXCEPTION 'Invalid POS fiscal receipt transition' USING ERRCODE='23514';
  END IF;
  IF OLD.state='recorded' THEN
    SELECT terminal_id INTO terminal FROM local_manager_approvals WHERE id=NEW.approval_id;
    IF terminal IS NULL OR NOT pos_approval_consumed(NEW.approval_id,NEW.branch_id,terminal,'fiscal_correct') THEN
      RAISE EXCEPTION 'Correcting a recorded receipt requires a fiscal_correct approval' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_fiscal_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_fiscal_receipts
FOR EACH ROW EXECUTE FUNCTION guard_pos_fiscal_receipt();

-- 7. Completeness of a sale and of a refund, checked at COMMIT ---------------------------------
-- Contracts 2.2: tenders sum to the order total; at most one cash part with tendered >= cash
-- and change from cash only; a mix is exactly two parts of cash/kaspi_terminal/kaspi_manual;
-- aggregators, ChocoFood, staff meal and marketing pay alone; an aggregator channel takes only
-- its own aggregator method, an order number and takeaway; ChocoFood (hall) needs its number;
-- staff meal and marketing need the matching approval (and a beneficiary or a reason); every
-- method is enabled; the sale has its fiscal record.
CREATE FUNCTION pos_sale_assert_complete(p_order uuid, p_branch uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s pos_sales%ROWTYPE; o local_orders%ROWTYPE; quote jsonb; parts integer; paid numeric;
  cash numeric; cash_parts integer; methods text[];
BEGIN
  SELECT * INTO s FROM pos_sales WHERE order_id=p_order AND branch_id=p_branch;
  SELECT * INTO o FROM local_orders WHERE id=p_order AND branch_id=p_branch;
  IF s.order_id IS NULL OR o.id IS NULL OR o.execution_mode<>'pos_sale' THEN
    RAISE EXCEPTION 'POS sale requires its sale record' USING ERRCODE='23514';
  END IF;
  SELECT snapshot INTO quote FROM checkout_quotes WHERE id=o.quote_id AND branch_id=p_branch;
  SELECT count(*),coalesce(sum(amount_minor::numeric),0),
      coalesce(sum(amount_minor::numeric) FILTER(WHERE method='cash'),0),
      count(*) FILTER(WHERE method='cash'),coalesce(array_agg(method ORDER BY method),ARRAY[]::text[])
    INTO parts,paid,cash,cash_parts,methods FROM pos_sale_tenders WHERE order_id=p_order AND branch_id=p_branch;
  IF parts NOT BETWEEN 1 AND 2 OR paid<>s.total_minor OR s.total_minor<>o.total_minor THEN
    RAISE EXCEPTION 'POS sale tenders must equal the order total' USING ERRCODE='23514';
  END IF;
  IF parts=2 AND (cash_parts>1 OR NOT methods<@ARRAY['cash','kaspi_terminal','kaspi_manual']) THEN
    RAISE EXCEPTION 'Invalid mixed POS payment' USING ERRCODE='23514';
  END IF;
  IF s.sales_channel IS DISTINCT FROM coalesce(quote->>'sales_channel','hall')
    OR (s.sales_channel<>'hall' AND (methods<>ARRAY['aggregator_'||s.sales_channel]
      OR quote->>'service_mode'<>'takeaway'))
    OR (s.sales_channel='hall' AND methods&&ARRAY['aggregator_yandex_eda','aggregator_glovo'])
    OR (s.external_order_ref IS NOT NULL) <> (s.sales_channel<>'hall' OR 'chocofood'=ANY(methods)) THEN
    RAISE EXCEPTION 'Invalid POS sale channel, method or order number' USING ERRCODE='23514';
  END IF;
  IF s.revenue_kind <> (CASE WHEN methods=ARRAY['staff_meal'] THEN 'staff_meal'
      WHEN methods=ARRAY['marketing'] THEN 'marketing' ELSE 'revenue' END)
    OR (s.revenue_kind<>'revenue' AND (s.approval_id IS NULL
      OR NOT pos_approval_consumed(s.approval_id,p_branch,s.terminal_id,s.revenue_kind)))
    OR (s.revenue_kind='staff_meal' AND s.beneficiary IS NULL)
    OR (s.revenue_kind='marketing' AND s.reason IS NULL) THEN
    RAISE EXCEPTION 'Staff meal and marketing require their approval and details' USING ERRCODE='23514';
  END IF;
  IF (cash_parts=1) <> (s.cash_tendered_minor IS NOT NULL)
    OR (cash_parts=1 AND (s.cash_tendered_minor<cash OR s.change_minor<>s.cash_tendered_minor-cash)) THEN
    RAISE EXCEPTION 'Invalid cash tender or change' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(methods) m(code) WHERE NOT EXISTS(SELECT 1 FROM pos_payment_methods p
      WHERE p.branch_id=p_branch AND p.code=m.code AND p.enabled)) THEN
    RAISE EXCEPTION 'POS payment method is disabled' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pos_fiscal_receipts WHERE order_id=p_order AND branch_id=p_branch AND kind='sale') THEN
    RAISE EXCEPTION 'POS sale requires its fiscal record' USING ERRCODE='23514';
  END IF;
END $$;

-- Refund tenders sum to the refund; refunds of an order never exceed its total; a void returns
-- the whole sale, is the only refund of the order, cancels the order and its kitchen admission
-- (only possible before the kitchen started); a refund keeps the order paid; each refund has its
-- fiscal record.
CREATE FUNCTION pos_refund_assert_complete(p_refund uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r pos_refunds%ROWTYPE; sale_total bigint; parts integer; refunded numeric; order_state text;
BEGIN
  SELECT * INTO r FROM pos_refunds WHERE id=p_refund;
  SELECT count(*),coalesce(sum(amount_minor::numeric),0) INTO parts,refunded
    FROM pos_refund_tenders WHERE refund_id=p_refund;
  SELECT total_minor INTO sale_total FROM pos_sales WHERE order_id=r.order_id AND branch_id=r.branch_id;
  SELECT o.state INTO order_state FROM local_orders o WHERE o.id=r.order_id AND o.branch_id=r.branch_id;
  IF parts<1 OR refunded<>r.amount_minor OR (SELECT coalesce(sum(amount_minor::numeric),0) FROM pos_refunds
      WHERE order_id=r.order_id AND branch_id=r.branch_id)>sale_total THEN
    RAISE EXCEPTION 'POS refund tenders must equal the refund within the sale total' USING ERRCODE='23514';
  END IF;
  IF (r.kind='void' AND (r.amount_minor<>sale_total OR order_state<>'cancelled'
      OR (SELECT count(*) FROM pos_refunds WHERE order_id=r.order_id AND branch_id=r.branch_id)<>1
      OR NOT EXISTS(SELECT 1 FROM fulfillment_reservations f WHERE f.local_order_id=r.order_id
        AND f.branch_id=r.branch_id AND f.admission_kind='pos_sale' AND f.state='cancelled')))
    OR (r.kind='refund' AND order_state<>'paid') THEN
    RAISE EXCEPTION 'A void returns the whole sale before cooking; a refund keeps it paid' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pos_fiscal_receipts WHERE refund_id=p_refund AND kind='refund') THEN
    RAISE EXCEPTION 'POS refund requires its fiscal record' USING ERRCODE='23514';
  END IF;
END $$;

-- Order, admission and sale are one transaction: a paid sale cannot persist without its kitchen
-- admission (admission_kind='pos_sale') and a complete pos_sales record. Unpaid as before.
CREATE OR REPLACE FUNCTION guard_local_execution_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_mode='unpaid_service' AND NOT EXISTS(
    SELECT 1 FROM fulfillment_reservations WHERE local_order_id=NEW.id
      AND branch_id=NEW.branch_id AND commercial_owner='edge_pos'
      AND admission_kind='unpaid_service') THEN
    RAISE EXCEPTION 'Unpaid service order requires kitchen admission' USING ERRCODE='23514';
  END IF;
  IF NEW.execution_mode='pos_sale' THEN
    IF NOT EXISTS(SELECT 1 FROM fulfillment_reservations WHERE local_order_id=NEW.id
        AND branch_id=NEW.branch_id AND commercial_owner='edge_pos' AND admission_kind='pos_sale') THEN
      RAISE EXCEPTION 'POS sale requires kitchen admission' USING ERRCODE='23514';
    END IF;
    PERFORM pos_sale_assert_complete(NEW.id,NEW.branch_id);
  END IF;
  RETURN NEW;
END; $$;
-- A tender added after the sale committed breaks the total and is refused the same way.
CREATE FUNCTION check_pos_sale_tender() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pos_sale_assert_complete(NEW.order_id,NEW.branch_id); RETURN NEW; END $$;
CREATE CONSTRAINT TRIGGER pos_sale_tender_complete AFTER INSERT ON pos_sale_tenders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_pos_sale_tender();
CREATE FUNCTION check_pos_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='pos_refunds' THEN PERFORM pos_refund_assert_complete(NEW.id);
  ELSE PERFORM pos_refund_assert_complete(NEW.refund_id);
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER pos_refund_complete AFTER INSERT ON pos_refunds
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_pos_refund();
CREATE CONSTRAINT TRIGGER pos_refund_tender_complete AFTER INSERT ON pos_refund_tenders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_pos_refund();
-- A paid sale is cancelled only together with its void.
CREATE FUNCTION check_pos_sale_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='cancelled' AND NOT EXISTS(SELECT 1 FROM pos_refunds WHERE order_id=NEW.id
      AND branch_id=NEW.branch_id AND kind='void') THEN
    RAISE EXCEPTION 'A paid POS sale is cancelled only by its void' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER local_order_pos_sale_voided AFTER UPDATE ON local_orders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.execution_mode='pos_sale')
EXECUTE FUNCTION check_pos_sale_cancellation();

-- 8. Drawer money of a sales shift ---------------------------------------------------------------
-- A cash withdrawal may also take the shift's cash sales (minus cash refunds). Unchanged for
-- every ordinary shift.
CREATE OR REPLACE FUNCTION guard_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target local_cash_shifts%ROWTYPE; balance numeric; sales numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Cash movements are append only' USING ERRCODE='23514'; END IF;
 SELECT * INTO target FROM local_cash_shifts WHERE id=NEW.shift_id AND branch_id=NEW.branch_id FOR UPDATE;
 IF NOT FOUND OR target.state<>'open' OR NOT EXISTS(SELECT 1 FROM local_staff WHERE id=NEW.staff_id AND branch_id=NEW.branch_id AND role='shift_manager' AND active) THEN
  RAISE EXCEPTION 'Cash movement requires an open shift and active manager' USING ERRCODE='23514';
 END IF;
 SELECT target.opening_cash_minor+coalesce(sum(CASE WHEN direction='in' THEN amount_minor::numeric ELSE -amount_minor::numeric END),0) INTO balance FROM local_cash_movements WHERE shift_id=target.id;
 balance:=balance+CASE WHEN NEW.direction='in' THEN NEW.amount_minor::numeric ELSE -NEW.amount_minor::numeric END;
 IF target.sales_mode THEN
  SELECT c.cash_sales_minor::numeric-c.cash_refunds_minor::numeric INTO sales FROM pos_shift_cash(target.id) c;
  balance:=balance+sales;
 END IF;
 IF balance<0 OR balance>9223372036854775807::numeric THEN RAISE EXCEPTION 'Invalid drawer balance' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;

-- Cashier report (016): a sales shift adds cash_sales_minor and cash_refunds_minor and counts
-- them in expected_cash_minor (opening+in-out+sales-refunds, contracts 5.6). Every other shift
-- keeps its pre-026 payload byte for byte (|| of an empty object is the identity).
CREATE OR REPLACE FUNCTION append_cashier_shift_report(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE sales jsonb := '{}'::jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM local_cash_shifts WHERE id=target AND sales_mode) THEN
  SELECT jsonb_build_object('cash_sales_minor',c.cash_sales_minor::text,
    'cash_refunds_minor',c.cash_refunds_minor::text,
    'expected_cash_minor',(s.opening_cash_minor+coalesce(m.cash_in,0)-coalesce(m.cash_out,0)
      +c.cash_sales_minor-c.cash_refunds_minor)::text)
  INTO sales FROM local_cash_shifts s CROSS JOIN LATERAL pos_shift_cash(s.id) c LEFT JOIN LATERAL (
  SELECT sum(amount_minor::numeric) FILTER(WHERE direction='in') cash_in,
  sum(amount_minor::numeric) FILTER(WHERE direction='out') cash_out
  FROM local_cash_movements WHERE shift_id=s.id AND branch_id=s.branch_id) m ON true WHERE s.id=target;
 END IF;
 INSERT INTO cashier_report_outbox(branch_id,kind,entity_id,payload)
 SELECT s.branch_id,'shift',s.id,jsonb_build_object(
 'shift_id',s.id,'terminal_id',s.terminal_id,'staff_id',s.staff_id,'state',s.state,
 'opened_at',s.opened_at,'closed_at',s.closed_at,'opening_cash_minor',s.opening_cash_minor::text,
 'cash_in_minor',coalesce(m.cash_in,0)::text,'cash_out_minor',coalesce(m.cash_out,0)::text,
 'expected_cash_minor',(s.opening_cash_minor+coalesce(m.cash_in,0)-coalesce(m.cash_out,0))::text,
 'counted_cash_minor',s.counted_cash_minor::text,'discrepancy_minor',s.discrepancy_minor::text) || sales
 FROM local_cash_shifts s LEFT JOIN LATERAL (
 SELECT sum(amount_minor::numeric) FILTER(WHERE direction='in') cash_in,
 sum(amount_minor::numeric) FILTER(WHERE direction='out') cash_out
 FROM local_cash_movements WHERE shift_id=s.id AND branch_id=s.branch_id) m ON true WHERE s.id=target;
END $$;

-- Frozen PickChick Z report of a closed sales shift (not fiscal): the ShiftReport of kind z,
-- the Kaspi terminal total typed at closing and, when receipts were still pending, the
-- shift_close_pending_fiscal approval of that cash desk.
CREATE TABLE pos_shift_reports (
  shift_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  report jsonb NOT NULL CHECK(jsonb_typeof(report)='object' AND report->>'kind'='z'),
  terminal_reported_minor bigint CHECK(terminal_reported_minor>=0),
  pending_fiscal_count integer NOT NULL CHECK(pending_fiscal_count>=0),
  approval_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(shift_id,branch_id) REFERENCES local_cash_shifts(id,branch_id),
  FOREIGN KEY(terminal_id,branch_id) REFERENCES local_terminals(id,branch_id),
  FOREIGN KEY(approval_id,branch_id) REFERENCES local_manager_approvals(id,branch_id),
  CHECK(report->>'shift_id'=shift_id::text AND report->>'terminal_id'=terminal_id::text),
  CHECK(pending_fiscal_count=0 OR approval_id IS NOT NULL)
);
-- Receipts still pending for the sales and refunds of one shift.
CREATE FUNCTION pos_shift_pending_fiscal(p_shift uuid) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM pos_fiscal_receipts f
  WHERE f.state='pending' AND (
    (f.kind='sale' AND EXISTS(SELECT 1 FROM pos_sales s WHERE s.order_id=f.order_id AND s.shift_id=p_shift))
    OR (f.kind='refund' AND EXISTS(SELECT 1 FROM pos_refunds r WHERE r.id=f.refund_id AND r.shift_id=p_shift)))
$$;
CREATE FUNCTION guard_pos_shift_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'POS shift reports are immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM local_cash_shifts WHERE id=NEW.shift_id AND branch_id=NEW.branch_id
      AND terminal_id=NEW.terminal_id AND state='closed' AND sales_mode) THEN
    RAISE EXCEPTION 'POS shift report requires its closed sales shift' USING ERRCODE='23514';
  END IF;
  IF NEW.pending_fiscal_count<>pos_shift_pending_fiscal(NEW.shift_id) OR (NEW.approval_id IS NOT NULL
      AND NOT pos_approval_consumed(NEW.approval_id,NEW.branch_id,NEW.terminal_id,'shift_close_pending_fiscal')) THEN
    RAISE EXCEPTION 'Closing with pending receipts requires its approval' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_shift_report_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_shift_reports
FOR EACH ROW EXECUTE FUNCTION guard_pos_shift_report();
CREATE FUNCTION check_pos_shift_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='closed' AND NOT EXISTS(SELECT 1 FROM pos_shift_reports WHERE shift_id=NEW.id
      AND branch_id=NEW.branch_id) THEN
    RAISE EXCEPTION 'A sales shift closes with its Z report' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER local_cash_shift_sales_closed AFTER UPDATE ON local_cash_shifts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.sales_mode)
EXECUTE FUNCTION check_pos_shift_closed();

-- 9. Durable posSales stream to the cloud (contracts 5.6) ---------------------------------------
-- Written in the transaction of the sale, void, refund, receipt or shift close. The POS sync
-- worker sends in sequence order and records only acknowledgement, attempts and the last error.
CREATE TABLE pos_sale_outbox (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigserial UNIQUE,
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  kind text NOT NULL CHECK(kind IN ('sale','void','refund','fiscal','shift_report')),
  entity_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  last_error text CHECK(length(last_error) BETWEEN 1 AND 500)
);
CREATE INDEX pos_sale_outbox_pending_idx ON pos_sale_outbox(branch_id,sequence) WHERE acknowledged_at IS NULL;
CREATE FUNCTION guard_pos_sale_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.event_id,NEW.sequence,NEW.branch_id,NEW.kind,NEW.entity_id,NEW.payload,NEW.payload_hash,NEW.occurred_at)
   IS DISTINCT FROM ROW(OLD.event_id,OLD.sequence,OLD.branch_id,OLD.kind,OLD.entity_id,OLD.payload,OLD.payload_hash,OLD.occurred_at)
   OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)
 THEN RAISE EXCEPTION 'POS sale event identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pos_sale_outbox_immutable BEFORE UPDATE OR DELETE ON pos_sale_outbox
FOR EACH ROW EXECUTE FUNCTION guard_pos_sale_outbox();
-- Written only by the sender: last answered probe or batch (any 200), for pos-sales-setup status.
CREATE TABLE pos_sale_sync_state (
  branch_id uuid PRIMARY KEY REFERENCES branch_config(id),
  last_supported_at timestamptz,
  last_error text CHECK(length(last_error) BETWEEN 1 AND 500),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
