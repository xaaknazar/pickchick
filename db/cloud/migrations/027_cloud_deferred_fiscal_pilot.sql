-- An explicit, immutable per-order pilot policy. Ordinary orders still require
-- an enabled fiscal account and an issued sale receipt before kitchen admission.
ALTER TABLE commerce_orders ALTER COLUMN fiscal_account_id DROP NOT NULL;
ALTER TABLE commerce_orders ADD COLUMN fiscal_policy text NOT NULL DEFAULT 'required';
ALTER TABLE commerce_orders ADD COLUMN fiscal_deferral_reference text;
ALTER TABLE commerce_orders ADD CONSTRAINT commerce_orders_fiscal_policy_check CHECK (
  (fiscal_policy='required' AND fiscal_account_id IS NOT NULL AND fiscal_deferral_reference IS NULL)
  OR (fiscal_policy='deferred_pilot' AND fiscal_account_id IS NULL
      AND fiscal_deferral_reference IS NOT NULL
      AND length(fiscal_deferral_reference) BETWEEN 3 AND 250)
);
CREATE FUNCTION commerce_fiscal_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.fiscal_policy, NEW.fiscal_deferral_reference) IS DISTINCT FROM
     (OLD.fiscal_policy, OLD.fiscal_deferral_reference)
  THEN RAISE EXCEPTION 'Fiscal policy cannot change after order creation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER commerce_fiscal_policy_guard BEFORE UPDATE ON commerce_orders
  FOR EACH ROW EXECUTE FUNCTION commerce_fiscal_policy_guard();
