-- Cloud-owned commercial aggregates. No provider credentials or public API.
-- Deliberately independent of auth migration 007 and the synthetic TEST tables.
CREATE TABLE commerce_provider_accounts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('payment','fiscal')),
  provider text NOT NULL CHECK(length(provider) BETWEEN 1 AND 100),
  external_reference text NOT NULL CHECK(length(external_reference) BETWEEN 1 AND 160),
  enabled boolean NOT NULL DEFAULT false,
  FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
  FOREIGN KEY(legal_entity_id,organization_id) REFERENCES legal_entities(id,organization_id),
  UNIQUE(id,branch_id,organization_id),
  UNIQUE(provider,external_reference,kind)
);
CREATE TABLE commerce_quotes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  customer_id uuid,
  release_id uuid NOT NULL,
  total_minor bigint NOT NULL CHECK(total_minor>0),
  currency text NOT NULL CHECK(currency='KZT'),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK(expires_at>created_at),
  FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
  FOREIGN KEY(release_id,branch_id) REFERENCES menu_releases(id,branch_id),
  CHECK((snapshot->>'totalMinor'=total_minor::text AND snapshot->>'currency'=currency AND snapshot->>'channel'='mobile') IS TRUE),
  UNIQUE(id,branch_id,organization_id)
);
CREATE INDEX commerce_quotes_principal_idx ON commerce_quotes(organization_id,principal_id,created_at DESC);
CREATE TABLE commerce_orders (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  customer_id uuid,
  quote_id uuid NOT NULL UNIQUE,
  owner text NOT NULL DEFAULT 'cloud' CHECK(owner='cloud'),
  fiscal_account_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  total_minor bigint NOT NULL CHECK(total_minor>0),
  currency text NOT NULL CHECK(currency='KZT'),
  quote_digest text NOT NULL,
  state text NOT NULL DEFAULT 'awaiting_admission' CHECK(state IN ('awaiting_admission','awaiting_payment','paid_pending_acceptance','attention_required')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  admission_device_id uuid,
  admission_reservation_id uuid,
  attention_required boolean NOT NULL DEFAULT false,
  kitchen_effect_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(quote_id,branch_id,organization_id) REFERENCES commerce_quotes(id,branch_id,organization_id),
  FOREIGN KEY(fiscal_account_id,branch_id,organization_id) REFERENCES commerce_provider_accounts(id,branch_id,organization_id),
  FOREIGN KEY(admission_device_id,branch_id) REFERENCES devices(id,branch_id),
  CHECK((admission_device_id IS NULL)=(admission_reservation_id IS NULL)),
  UNIQUE(id,branch_id,organization_id)
);
CREATE UNIQUE INDEX commerce_admission_reservation_idx ON commerce_orders(admission_device_id,admission_reservation_id) WHERE admission_reservation_id IS NOT NULL;
CREATE INDEX commerce_orders_feed_idx ON commerce_orders(branch_id,created_at DESC,id);
CREATE INDEX commerce_orders_principal_idx ON commerce_orders(organization_id,principal_id,created_at DESC,id);
CREATE TABLE commerce_payment_intents (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES commerce_orders(id),
  intended_minor bigint NOT NULL CHECK(intended_minor>0),
  state text NOT NULL DEFAULT 'created' CHECK(state IN ('created','pending','unknown','failed','succeeded')),
  UNIQUE(id,order_id)
);
CREATE TABLE commerce_payment_attempts (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL,
  order_id uuid NOT NULL REFERENCES commerce_orders(id),
  account_id uuid NOT NULL REFERENCES commerce_provider_accounts(id),
  intended_minor bigint NOT NULL CHECK(intended_minor>0),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','unknown','failed','succeeded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(intent_id,order_id) REFERENCES commerce_payment_intents(id,order_id),
  UNIQUE(id,order_id,account_id)
);
CREATE UNIQUE INDEX commerce_one_active_attempt_idx ON commerce_payment_attempts(intent_id) WHERE state IN ('pending','unknown');
CREATE INDEX commerce_attempt_order_idx ON commerce_payment_attempts(order_id);
CREATE TABLE commerce_captures (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES commerce_orders(id),
  attempt_id uuid NOT NULL,
  account_id uuid NOT NULL,
  operation_id text NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 160),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(attempt_id,order_id,account_id) REFERENCES commerce_payment_attempts(id,order_id,account_id),
  UNIQUE(account_id,operation_id),
  UNIQUE(id,order_id,account_id)
);
CREATE INDEX commerce_capture_order_idx ON commerce_captures(order_id);
CREATE TABLE commerce_refunds (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  capture_id uuid NOT NULL,
  account_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
  fulfillment_policy text NOT NULL DEFAULT 'not_dispatched' CHECK(fulfillment_policy IN ('not_dispatched','manager_reviewed')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','unknown','failed','succeeded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(capture_id,order_id,account_id) REFERENCES commerce_captures(id,order_id,account_id),
  UNIQUE(id,order_id,account_id)
);
CREATE INDEX commerce_refund_capture_idx ON commerce_refunds(capture_id);
CREATE TABLE commerce_refund_effects (
  id uuid PRIMARY KEY,
  refund_id uuid NOT NULL,
  order_id uuid NOT NULL,
  account_id uuid NOT NULL,
  operation_id text NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 160),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(refund_id,order_id,account_id) REFERENCES commerce_refunds(id,order_id,account_id),
  UNIQUE(account_id,operation_id)
);
CREATE INDEX commerce_refund_effect_order_idx ON commerce_refund_effects(order_id);
CREATE INDEX commerce_refund_effect_refund_idx ON commerce_refund_effects(refund_id);
CREATE TABLE commerce_fiscal_documents (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES commerce_orders(id),
  account_id uuid NOT NULL REFERENCES commerce_provider_accounts(id),
  kind text NOT NULL CHECK(kind IN ('sale','refund')),
  business_operation_id uuid NOT NULL,
  original_sale_id uuid REFERENCES commerce_fiscal_documents(id),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  request jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','pending','unknown','failed','issued')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((kind='sale')=(original_sale_id IS NULL)),
  UNIQUE(kind,business_operation_id),
  UNIQUE(id,order_id,account_id)
);
CREATE INDEX commerce_fiscal_order_idx ON commerce_fiscal_documents(order_id);
CREATE INDEX commerce_fiscal_parent_idx ON commerce_fiscal_documents(original_sale_id);
CREATE TABLE commerce_fiscal_effects (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL,
  order_id uuid NOT NULL,
  account_id uuid NOT NULL,
  provider_document_id text NOT NULL,
  fiscal_mark text NOT NULL,
  receipt_url text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(document_id,order_id,account_id) REFERENCES commerce_fiscal_documents(id,order_id,account_id),
  UNIQUE(account_id,provider_document_id)
);
CREATE INDEX commerce_fiscal_effect_document_idx ON commerce_fiscal_effects(document_id);
CREATE TABLE commerce_commands (
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  operation text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(organization_id,branch_id,principal_id,operation,idempotency_key),
  FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id)
);
CREATE TABLE commerce_provider_inbox (
  account_id uuid NOT NULL REFERENCES commerce_provider_accounts(id),
  event_kind text NOT NULL CHECK(event_kind IN ('payment','refund','fiscal')),
  event_id text NOT NULL,
  request_digest text NOT NULL,
  observation jsonb NOT NULL,
  result jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,event_kind,event_id)
);
CREATE TABLE commerce_edge_inbox (
  device_id uuid NOT NULL REFERENCES devices(id),
  event_id text NOT NULL,
  request_digest text NOT NULL,
  result jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(device_id,event_id)
);
CREATE TABLE commerce_reconciliation_issues (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES commerce_orders(id),
  issue_key text NOT NULL,
  code text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(order_id,issue_key)
);
CREATE TABLE commerce_outbox (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  order_id uuid NOT NULL REFERENCES commerce_orders(id),
  effect_key text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  lease_worker uuid,
  lease_token uuid,
  lease_until timestamptz,
  acknowledged_at timestamptz,
  UNIQUE(order_id,effect_key)
);
CREATE INDEX commerce_outbox_pending_idx ON commerce_outbox(sequence) WHERE acknowledged_at IS NULL;
CREATE FUNCTION commerce_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Commerce ledger/snapshot is immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER commerce_quotes_immutable BEFORE UPDATE OR DELETE ON commerce_quotes FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER commerce_commands_immutable BEFORE UPDATE OR DELETE ON commerce_commands FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER commerce_provider_inbox_immutable BEFORE UPDATE OR DELETE ON commerce_provider_inbox FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER commerce_edge_inbox_immutable BEFORE UPDATE OR DELETE ON commerce_edge_inbox FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER commerce_capture_immutable BEFORE UPDATE OR DELETE ON commerce_captures FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER commerce_refund_effect_immutable BEFORE UPDATE OR DELETE ON commerce_refund_effects FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER commerce_fiscal_effect_immutable BEFORE UPDATE OR DELETE ON commerce_fiscal_effects FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER commerce_issue_immutable BEFORE UPDATE OR DELETE ON commerce_reconciliation_issues FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE FUNCTION commerce_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Commerce orders cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'awaiting_admission' OR NEW.version<>1 OR NEW.admission_device_id IS NOT NULL OR NEW.admission_reservation_id IS NOT NULL OR NEW.kitchen_effect_id IS NOT NULL OR NEW.attention_required
    THEN RAISE EXCEPTION 'Order must begin before admission and payment' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM commerce_quotes q WHERE q.id=NEW.quote_id AND q.branch_id=NEW.branch_id AND q.organization_id=NEW.organization_id AND q.principal_id=NEW.principal_id AND q.customer_id IS NOT DISTINCT FROM NEW.customer_id AND q.snapshot=NEW.snapshot AND q.total_minor=NEW.total_minor AND q.currency=NEW.currency AND q.digest=NEW.quote_digest)
    THEN RAISE EXCEPTION 'Order must copy its immutable quote' USING ERRCODE='23514'; END IF;
  ELSE
    IF (NEW.id,NEW.organization_id,NEW.branch_id,NEW.principal_id,NEW.customer_id,NEW.quote_id,NEW.owner,NEW.fiscal_account_id,NEW.snapshot,NEW.total_minor,NEW.currency,NEW.quote_digest,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id,OLD.principal_id,OLD.customer_id,OLD.quote_id,OLD.owner,OLD.fiscal_account_id,OLD.snapshot,OLD.total_minor,OLD.currency,OLD.quote_digest,OLD.created_at)
    THEN RAISE EXCEPTION 'Commercial snapshot and ownership are immutable' USING ERRCODE='23514'; END IF;
    IF OLD.admission_reservation_id IS NOT NULL AND (NEW.admission_device_id,NEW.admission_reservation_id) IS DISTINCT FROM (OLD.admission_device_id,OLD.admission_reservation_id)
    THEN RAISE EXCEPTION 'Admission ownership cannot change' USING ERRCODE='23514'; END IF;
    IF OLD.kitchen_effect_id IS NOT NULL AND NEW.kitchen_effect_id IS DISTINCT FROM OLD.kitchen_effect_id
    THEN RAISE EXCEPTION 'Kitchen effect cannot change' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER commerce_order_guard BEFORE INSERT OR UPDATE OR DELETE ON commerce_orders FOR EACH ROW EXECUTE FUNCTION commerce_order_guard();
CREATE FUNCTION commerce_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Commerce requests cannot be deleted' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state')
  THEN RAISE EXCEPTION 'Request identity and amount are immutable' USING ERRCODE='23514'; END IF;
  IF OLD.state IN ('succeeded','issued') AND NEW.state<>OLD.state
  THEN RAISE EXCEPTION 'Successful external effect cannot be undone' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER commerce_intent_guard BEFORE UPDATE OR DELETE ON commerce_payment_intents FOR EACH ROW EXECUTE FUNCTION commerce_request_guard();
CREATE TRIGGER commerce_attempt_guard BEFORE UPDATE OR DELETE ON commerce_payment_attempts FOR EACH ROW EXECUTE FUNCTION commerce_request_guard();
CREATE TRIGGER commerce_refund_guard BEFORE UPDATE OR DELETE ON commerce_refunds FOR EACH ROW EXECUTE FUNCTION commerce_request_guard();
CREATE TRIGGER commerce_fiscal_guard BEFORE UPDATE OR DELETE ON commerce_fiscal_documents FOR EACH ROW EXECUTE FUNCTION commerce_request_guard();
CREATE FUNCTION commerce_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Outbox cannot be deleted' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['attempts','lease_worker','lease_token','lease_until','acknowledged_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['attempts','lease_worker','lease_token','lease_until','acknowledged_at'])
  THEN RAISE EXCEPTION 'Outbox effect is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER commerce_outbox_guard BEFORE UPDATE OR DELETE ON commerce_outbox FOR EACH ROW EXECUTE FUNCTION commerce_outbox_guard();
CREATE FUNCTION commerce_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Disable a provider account instead of deleting history' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-'enabled') IS DISTINCT FROM (to_jsonb(OLD)-'enabled')
  THEN RAISE EXCEPTION 'Provider/register identity cannot change' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER commerce_account_guard BEFORE UPDATE OR DELETE ON commerce_provider_accounts FOR EACH ROW EXECUTE FUNCTION commerce_account_guard();
CREATE FUNCTION commerce_intent_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state<>'created' OR NOT EXISTS(SELECT 1 FROM commerce_orders WHERE id=NEW.order_id AND total_minor=NEW.intended_minor)
  THEN RAISE EXCEPTION 'Intent must match order amount' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER commerce_intent_insert_guard BEFORE INSERT ON commerce_payment_intents FOR EACH ROW EXECUTE FUNCTION commerce_intent_insert_guard();
CREATE FUNCTION commerce_attempt_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM commerce_orders WHERE id=NEW.order_id FOR UPDATE;
  IF NEW.state<>'pending' OR EXISTS(SELECT 1 FROM commerce_captures WHERE order_id=NEW.order_id) OR NOT EXISTS(SELECT 1 FROM commerce_orders o JOIN commerce_provider_accounts a ON a.id=NEW.account_id JOIN commerce_payment_intents i ON i.id=NEW.intent_id
    WHERE o.id=NEW.order_id AND o.admission_reservation_id IS NOT NULL AND NOT o.attention_required AND a.branch_id=o.branch_id AND a.organization_id=o.organization_id AND a.legal_entity_id::text=o.snapshot->>'legalEntityId' AND a.kind='payment' AND a.enabled AND i.order_id=o.id AND NEW.intended_minor=i.intended_minor)
  THEN RAISE EXCEPTION 'Attempt account/scope/amount mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER commerce_attempt_insert_guard BEFORE INSERT ON commerce_payment_attempts FOR EACH ROW EXECUTE FUNCTION commerce_attempt_insert_guard();
CREATE FUNCTION commerce_refund_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE captured numeric; refunded numeric; reserved numeric; kitchen uuid;
BEGIN
  IF NEW.state<>'pending' THEN RAISE EXCEPTION 'Refund must begin pending' USING ERRCODE='23514'; END IF;
  SELECT kitchen_effect_id INTO kitchen FROM commerce_orders WHERE id=NEW.order_id FOR UPDATE;
  IF kitchen IS NOT NULL AND NEW.fulfillment_policy<>'manager_reviewed'
  THEN RAISE EXCEPTION 'Refund requires explicit fulfillment review' USING ERRCODE='23514'; END IF;
  SELECT amount_minor INTO captured FROM commerce_captures WHERE id=NEW.capture_id AND order_id=NEW.order_id AND account_id=NEW.account_id;
  SELECT COALESCE(SUM(e.amount_minor),0) INTO refunded FROM commerce_refund_effects e JOIN commerce_refunds r ON r.id=e.refund_id WHERE r.capture_id=NEW.capture_id;
  SELECT COALESCE(SUM(amount_minor),0) INTO reserved FROM commerce_refunds WHERE capture_id=NEW.capture_id AND state IN ('pending','unknown');
  IF captured IS NULL OR NEW.amount_minor+refunded+reserved>captured
  THEN RAISE EXCEPTION 'Refund exceeds unreserved captured funds' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER commerce_refund_insert_guard BEFORE INSERT ON commerce_refunds FOR EACH ROW EXECUTE FUNCTION commerce_refund_insert_guard();
CREATE FUNCTION commerce_fiscal_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state<>'queued' THEN RAISE EXCEPTION 'Fiscal request must begin queued' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM commerce_orders o JOIN commerce_provider_accounts a ON a.id=o.fiscal_account_id
    WHERE o.id=NEW.order_id AND o.fiscal_account_id=NEW.account_id AND a.kind='fiscal' AND a.branch_id=o.branch_id AND a.organization_id=o.organization_id AND a.legal_entity_id::text=o.snapshot->>'legalEntityId')
  THEN RAISE EXCEPTION 'Fiscal executor mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.kind='sale' AND NOT EXISTS(SELECT 1 FROM commerce_orders WHERE id=NEW.order_id AND id=NEW.business_operation_id AND total_minor=NEW.amount_minor)
  THEN RAISE EXCEPTION 'Sale must match commercial order' USING ERRCODE='23514'; END IF;
  IF NEW.kind='refund' AND NOT EXISTS(SELECT 1 FROM commerce_refund_effects e JOIN commerce_fiscal_documents s ON s.id=NEW.original_sale_id
    WHERE e.id=NEW.business_operation_id AND e.order_id=NEW.order_id AND e.amount_minor=NEW.amount_minor AND s.kind='sale' AND s.order_id=NEW.order_id)
  THEN RAISE EXCEPTION 'Refund fiscal document must match original sale and actual refund' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER commerce_fiscal_insert_guard BEFORE INSERT ON commerce_fiscal_documents FOR EACH ROW EXECUTE FUNCTION commerce_fiscal_insert_guard();
