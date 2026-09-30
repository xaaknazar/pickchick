-- Practice only. No commercial rewards, coupons or retrospective adoption.
-- Keep the journal after synthetic orders are pruned; never use it as a paid entitlement.
CREATE TABLE test_combo_stamps (
  order_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES identity_customers(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  program_version text NOT NULL CHECK(program_version='practice-single-combo-v1'),
  units integer NOT NULL CHECK(units BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX test_combo_stamps_customer_idx ON test_combo_stamps(customer_id);
CREATE TRIGGER test_combo_stamps_update_guard BEFORE UPDATE ON test_combo_stamps
  FOR EACH ROW EXECUTE FUNCTION test_quote_immutable();
