-- ADR-0019 (owner request 16.11.2026): an iPad kiosk on any point of the chain. Until now the kiosk
-- API served one point (KIOSK_CHECKOUT_BRANCH_ID). A branch manager now switches «Киоски на этой
-- точке» on in «Устройства»; with KIOSK_MULTI_BRANCH_ENABLED=true the kiosk API then serves that
-- point too, with payment on the kiosk's own Kaspi Smart POS terminal only (ADR-0018). The env
-- point keeps its configuration and is not stored here.
-- Additive: one new table and one function. Runtime access is granted by
-- infra/staging/kiosk-branch-settings-grants.mjs behind KIOSK_MULTI_BRANCH_ENABLED (default off).

-- One row per point that ever had kiosks switched on. Never deleted: switching off keeps the row
-- (enabled=false). version grows by one with every change (optimistic concurrency of the back
-- office). terminal_payment_account_id: the point's 'kaspi-pos' payment account of its own legal
-- entity; NULL means the env KIOSK_KASPI_TERMINAL_ACCOUNT_ID.
CREATE TABLE kiosk_branch_settings (
 organization_id uuid NOT NULL,
 branch_id uuid PRIMARY KEY,
 enabled boolean NOT NULL DEFAULT false,
 terminal_payment_account_id uuid,
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
 FOREIGN KEY(terminal_payment_account_id,branch_id,organization_id)
  REFERENCES commerce_provider_accounts(id,branch_id,organization_id),
 FOREIGN KEY(updated_by,organization_id) REFERENCES catalog_managers(id,organization_id)
);
CREATE FUNCTION kiosk_branch_settings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Kiosk branch settings are never deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND NEW.version<>1 THEN
  RAISE EXCEPTION 'Kiosk branch settings start at version 1' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND ((NEW.organization_id,NEW.branch_id) IS DISTINCT FROM (OLD.organization_id,OLD.branch_id)
  OR NEW.version<>OLD.version+1) THEN
  RAISE EXCEPTION 'Kiosk branch settings: identity is immutable and version grows by one' USING ERRCODE='23514';
 END IF;
 -- The terminal rail only: a 'kaspi-pos' payment account of the point's own legal entity.
 IF NEW.terminal_payment_account_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM commerce_provider_accounts a JOIN branches b ON b.id=a.branch_id
  WHERE a.id=NEW.terminal_payment_account_id AND a.branch_id=NEW.branch_id
   AND a.organization_id=NEW.organization_id AND a.legal_entity_id=b.legal_entity_id
   AND a.kind='payment' AND a.provider='kaspi-pos') THEN
  RAISE EXCEPTION 'Kiosk branch settings require a kaspi-pos payment account of the point' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER kiosk_branch_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON kiosk_branch_settings
 FOR EACH ROW EXECUTE FUNCTION kiosk_branch_settings_guard();

-- The point's 'kaspi-pos' payment account, created on first use. The terminal is driven by the
-- iPad (ADR-0018), so the account holds no credentials: it only labels the point's terminal
-- payments. Runs as the migration owner (pattern of cloud056/075): the API role never gets INSERT
-- on commerce_provider_accounts and can create nothing but this one account kind. An account the
-- operator disabled stays disabled: the function then answers NULL (terminal not ready).
CREATE FUNCTION kiosk_branch_terminal_account(p_organization uuid, p_branch uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
 v_legal uuid;
 v_account uuid;
BEGIN
 SELECT legal_entity_id INTO v_legal FROM branches WHERE id=p_branch AND organization_id=p_organization;
 IF v_legal IS NULL THEN RAISE EXCEPTION 'Unknown point' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('kiosk-branch-account:' || p_branch::text, 0));
 SELECT id INTO v_account FROM commerce_provider_accounts
  WHERE organization_id=p_organization AND branch_id=p_branch AND legal_entity_id=v_legal
   AND kind='payment' AND provider='kaspi-pos' AND enabled
  ORDER BY id LIMIT 1;
 IF v_account IS NOT NULL THEN RETURN v_account; END IF;
 IF EXISTS(SELECT 1 FROM commerce_provider_accounts
  WHERE provider='kaspi-pos' AND kind='payment' AND external_reference='kiosk-terminal:' || p_branch::text) THEN
  RETURN NULL;
 END IF;
 v_account := gen_random_uuid();
 INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id)
 VALUES(v_account,p_organization,p_branch,'payment','kaspi-pos','kiosk-terminal:' || p_branch::text,true,v_legal);
 RETURN v_account;
END $$;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION %I.kiosk_branch_terminal_account(uuid,uuid) SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
END $$;
REVOKE ALL ON FUNCTION kiosk_branch_terminal_account(uuid,uuid) FROM PUBLIC;
