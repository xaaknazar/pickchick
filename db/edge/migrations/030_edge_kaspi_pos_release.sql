-- A sale the guest already paid on the Kaspi terminal is made even when the branch stopped taking
-- orders or the kaspi_terminal method was switched off meanwhile (owner decision 28.11.2026), and a
-- payment that cannot be turned into a sale is released by hand with the shift manager's PIN
-- (the refund is made on the terminal). Additive: schema026 guards keep every other sale exactly
-- as before; the Kaspi tables are read only in the nested branches below (closed branch, switched-off
-- method), never by an ordinary sale. Whole tenge, whole tiyn: amounts stay multiples of 100.

-- 1. The manager approval of a release --------------------------------------------------------
-- 026 pinned the list of actions in an unnamed CHECK; it is recreated with the same name and the
-- same ten actions plus terminal_release (packages/contracts ManagerApprovalActionSchema).
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='local_manager_approvals'::regclass
    AND contype='c' AND pg_get_constraintdef(oid) LIKE '%courier_incident_update%'
  LOOP EXECUTE format('ALTER TABLE local_manager_approvals DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE local_manager_approvals ADD CONSTRAINT local_manager_approvals_action_check
  CHECK(action IN ('void','refund','staff_meal','marketing','fiscal_correct',
    'shift_close_pending_fiscal','discount','cash_movement','kds_mode','courier_incident_update',
    'terminal_release'));

-- 2. Release of a paid attempt without an order (append-only) ---------------------------------
-- A separate table, not a new attempt state: the checks of 029 and the forward-only guard of an
-- attempt stay as they are, and a desk that reads `state` from a closed list never meets a new value.
CREATE TABLE kaspi_pos_attempt_releases (
  attempt_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  -- The desk of the paid attempt, and (terminal_id, shift_id) the desk and its open sales shift
  -- where the shift manager typed the PIN: a broken or retired desk is released from another one.
  attempt_terminal_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor%100=0),
  transaction_id text NOT NULL CHECK(length(trim(transaction_id)) BETWEEN 1 AND 40),
  attempt_staff_id uuid NOT NULL,
  released_by_staff_id uuid NOT NULL,
  manager_staff_id uuid NOT NULL,
  approval_id uuid NOT NULL UNIQUE,
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 300),
  released_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(attempt_id,branch_id) REFERENCES kaspi_pos_attempts(id,branch_id),
  FOREIGN KEY(attempt_terminal_id,branch_id) REFERENCES local_terminals(id,branch_id),
  FOREIGN KEY(terminal_id,branch_id) REFERENCES local_terminals(id,branch_id),
  FOREIGN KEY(shift_id,branch_id) REFERENCES local_cash_shifts(id,branch_id),
  FOREIGN KEY(attempt_staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  FOREIGN KEY(released_by_staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  FOREIGN KEY(manager_staff_id,branch_id) REFERENCES local_staff(id,branch_id),
  FOREIGN KEY(approval_id,branch_id) REFERENCES local_manager_approvals(id,branch_id)
);
CREATE INDEX kaspi_pos_attempt_releases_shift_idx
  ON kaspi_pos_attempt_releases(branch_id,shift_id,released_at);
-- Paid and not yet sold: the open list (no age limit), the shift close check and the releases.
CREATE INDEX kaspi_pos_attempts_unsold_idx ON kaspi_pos_attempts(branch_id,terminal_id,created_at)
  WHERE state='success' AND order_id IS NULL;

-- Insert only (TRUNCATE too is refused). The attempt is locked and must be paid, without an order,
-- of the desk named as its own and with the very amount, operation number and cashier recorded
-- here; the release is made at an open sales shift of the RELEASING desk with that desk's consumed
-- terminal_release approval of the manager it names, whose subject is this attempt's quote and
-- amount (compared as the jsonb the approval stored, like the code that issued and spent it).
CREATE FUNCTION guard_kaspi_pos_attempt_release() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt kaspi_pos_attempts%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Kaspi payment releases are append-only' USING ERRCODE='23514';
  END IF;
  SELECT * INTO attempt FROM kaspi_pos_attempts WHERE id=NEW.attempt_id AND branch_id=NEW.branch_id FOR UPDATE;
  IF NOT FOUND OR attempt.state<>'success' OR attempt.order_id IS NOT NULL
    OR ROW(attempt.terminal_id,attempt.amount_minor,attempt.transaction_id,attempt.staff_id)
      IS DISTINCT FROM ROW(NEW.attempt_terminal_id,NEW.amount_minor,NEW.transaction_id,NEW.attempt_staff_id) THEN
    RAISE EXCEPTION 'Only a paid Kaspi attempt without an order is released' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM local_cash_shifts WHERE id=NEW.shift_id AND branch_id=NEW.branch_id
      AND terminal_id=NEW.terminal_id AND state='open' AND sales_mode) THEN
    RAISE EXCEPTION 'A Kaspi release requires an open sales shift of its cash desk' USING ERRCODE='23514';
  END IF;
  IF NOT pos_approval_consumed(NEW.approval_id,NEW.branch_id,NEW.terminal_id,'terminal_release')
    OR NOT EXISTS(SELECT 1 FROM local_manager_approvals WHERE id=NEW.approval_id
      AND branch_id=NEW.branch_id AND manager_staff_id=NEW.manager_staff_id
      AND subject=jsonb_build_object('quote_id',attempt.quote_id::text,'amount_minor',attempt.amount_minor::text)) THEN
    RAISE EXCEPTION 'A Kaspi release requires its manager approval' USING ERRCODE='23514';
  END IF;
  NEW.released_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER kaspi_pos_attempt_release_guard BEFORE INSERT OR UPDATE OR DELETE ON kaspi_pos_attempt_releases
FOR EACH ROW EXECUTE FUNCTION guard_kaspi_pos_attempt_release();
CREATE TRIGGER kaspi_pos_attempt_release_no_truncate BEFORE TRUNCATE ON kaspi_pos_attempt_releases
FOR EACH STATEMENT EXECUTE FUNCTION guard_kaspi_pos_attempt_release();

-- A released attempt never pays an order (the update runs only when an order is being set). Owner
-- rights (SECURITY DEFINER, as 023 and 025): every terminal sale runs this guard, and the runtime
-- must not need a grant on the releases table for it. It only reads; the search_path is pinned below.
CREATE FUNCTION guard_kaspi_pos_attempt_released() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM kaspi_pos_attempt_releases WHERE attempt_id=NEW.id AND branch_id=NEW.branch_id) THEN
    RAISE EXCEPTION 'A released Kaspi attempt cannot pay an order' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kaspi_pos_attempt_released_guard BEFORE UPDATE OF order_id ON kaspi_pos_attempts
FOR EACH ROW WHEN (OLD.order_id IS NULL AND NEW.order_id IS NOT NULL)
EXECUTE FUNCTION guard_kaspi_pos_attempt_released();
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.guard_kaspi_pos_attempt_released() SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
END $$;
REVOKE EXECUTE ON FUNCTION guard_kaspi_pos_attempt_released() FROM PUBLIC;

-- 3. A paid sale at a closed branch ------------------------------------------------------------
-- Body of 026 verbatim except the pos_sale branch: with the branch closed the order is still
-- inserted when its quote has a paid, unused, unreleased attempt of the quote's own desk for the
-- WHOLE total. pos_service_mode<>'pos_sale' stays a refusal. The Kaspi tables are read only there.
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
    IF NOT EXISTS(SELECT 1 FROM branch_config WHERE id=NEW.branch_id AND pos_service_mode='pos_sale' FOR SHARE)
      OR NOT EXISTS(SELECT 1 FROM kaspi_pos_attempts a
        JOIN checkout_quotes q ON q.id=a.quote_id AND q.branch_id=a.branch_id AND q.terminal_id=a.terminal_id
        WHERE a.branch_id=NEW.branch_id AND a.quote_id=NEW.quote_id AND a.state='success'
          AND a.order_id IS NULL AND a.amount_minor=NEW.total_minor
          AND NOT EXISTS(SELECT 1 FROM kaspi_pos_attempt_releases r WHERE r.attempt_id=a.id)) THEN
      RAISE EXCEPTION 'POS sale mode is not enabled' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='INSERT' AND NEW.execution_mode='payment_required' AND EXISTS(
    SELECT 1 FROM branch_config WHERE id=NEW.branch_id AND pos_service_mode='pos_sale') THEN
    RAISE EXCEPTION 'Only paid POS sales are accepted in pos_sale mode' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

-- Completeness of a sale at COMMIT: body of 026 verbatim except the check of the methods, which
-- also looks at the branch: 026 did not check ordering_enabled here (only when the order was
-- inserted), this does, because a closed branch takes only a sale paid on the terminal. A closed
-- branch or a switched-off method refuses the sale unless it has exactly ONE part and that part is
-- a kaspi_terminal part of a paid attempt of this very order for the same amount (the order's own
-- attempt, which a released one can never become). The extra variable on_terminal is the only
-- other difference.
CREATE OR REPLACE FUNCTION pos_sale_assert_complete(p_order uuid, p_branch uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s pos_sales%ROWTYPE; o local_orders%ROWTYPE; quote jsonb; parts integer; paid numeric;
  cash numeric; cash_parts integer; methods text[]; on_terminal boolean;
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
  IF NOT EXISTS(SELECT 1 FROM branch_config WHERE id=p_branch AND ordering_enabled)
    OR EXISTS(SELECT 1 FROM unnest(methods) m(code) WHERE NOT EXISTS(SELECT 1 FROM pos_payment_methods p
      WHERE p.branch_id=p_branch AND p.code=m.code AND p.enabled)) THEN
    SELECT parts=1 AND NOT EXISTS(SELECT 1 FROM pos_sale_tenders t WHERE t.order_id=p_order AND t.branch_id=p_branch
      AND NOT (t.method='kaspi_terminal' AND t.attempt_id IS NOT NULL AND EXISTS(
        SELECT 1 FROM kaspi_pos_attempts a WHERE a.id=t.attempt_id AND a.branch_id=t.branch_id
          AND a.state='success' AND a.order_id=p_order AND a.amount_minor=t.amount_minor)))
    INTO on_terminal;
    IF NOT on_terminal THEN
      IF EXISTS(SELECT 1 FROM unnest(methods) m(code) WHERE NOT EXISTS(SELECT 1 FROM pos_payment_methods p
          WHERE p.branch_id=p_branch AND p.code=m.code AND p.enabled)) THEN
        RAISE EXCEPTION 'POS payment method is disabled' USING ERRCODE='23514';
      END IF;
      RAISE EXCEPTION 'POS sale mode is not enabled' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pos_fiscal_receipts WHERE order_id=p_order AND branch_id=p_branch AND kind='sale') THEN
    RAISE EXCEPTION 'POS sale requires its fiscal record' USING ERRCODE='23514';
  END IF;
END $$;
