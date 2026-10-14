-- Owner-approved 7 paid combos -> Pick Combo, 2026-10-14. No automatic activation/backfill.
CREATE TABLE combo_reward_programs (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 version text NOT NULL CHECK(version='seven-paid-combos-v1'),
 gift_product_id text NOT NULL CHECK(gift_product_id='pick-combo'),
 starts_at timestamptz NOT NULL,
 approval_reference text NOT NULL CHECK(length(approval_reference) BETWEEN 3 AND 250),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
 UNIQUE(organization_id,branch_id,version)
);
CREATE TABLE combo_reward_accruals (
 program_id uuid NOT NULL REFERENCES combo_reward_programs(id),
 order_id uuid NOT NULL REFERENCES commerce_orders(id),
 customer_id uuid NOT NULL,
 units integer NOT NULL CHECK(units>=0),
 refund_review boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(program_id,order_id)
);
CREATE INDEX combo_reward_customer ON combo_reward_accruals(program_id,customer_id);
CREATE TABLE combo_reward_redemptions (
 order_id uuid PRIMARY KEY REFERENCES commerce_orders(id),
 program_id uuid NOT NULL REFERENCES combo_reward_programs(id),
 customer_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('held','consumed','released')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX combo_reward_holds ON combo_reward_redemptions(program_id,customer_id,state);
CREATE TABLE combo_reward_events (
 id uuid PRIMARY KEY,
 program_id uuid NOT NULL REFERENCES combo_reward_programs(id),
 customer_id uuid NOT NULL,
 order_id uuid NOT NULL REFERENCES commerce_orders(id),
 kind text NOT NULL CHECK(kind IN ('accrual','hold','consume','release','review')),
 units_delta integer NOT NULL DEFAULT 0,
 detail jsonb NOT NULL CHECK(jsonb_typeof(detail)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX combo_reward_audit ON combo_reward_events(program_id,customer_id,created_at);
CREATE TABLE commerce_refund_lines (
 refund_id uuid NOT NULL REFERENCES commerce_refunds(id),
 line_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(refund_id,line_id)
);
CREATE TRIGGER combo_program_immutable BEFORE UPDATE OR DELETE ON combo_reward_programs
 FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER combo_events_immutable BEFORE UPDATE OR DELETE ON combo_reward_events
 FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
CREATE TRIGGER commerce_refund_lines_immutable BEFORE UPDATE OR DELETE ON commerce_refund_lines
 FOR EACH ROW EXECUTE FUNCTION commerce_immutable();

-- Only the trusted gift pricing path can issue a zero-total quote/order.
ALTER TABLE commerce_quotes DROP CONSTRAINT commerce_quotes_total_minor_check;
ALTER TABLE commerce_quotes ADD CONSTRAINT commerce_quotes_total_minor_check CHECK (
 total_minor>0 OR (total_minor=0 AND snapshot->'comboGift'->>'productId'='pick-combo'
 AND snapshot->>'channel'='mobile') IS TRUE);
ALTER TABLE commerce_orders DROP CONSTRAINT commerce_orders_total_minor_check;
ALTER TABLE commerce_orders ADD CONSTRAINT commerce_orders_total_minor_check CHECK (
 total_minor>0 OR (total_minor=0 AND snapshot->'comboGift'->>'productId'='pick-combo'
 AND snapshot->>'channel'='mobile') IS TRUE);
ALTER TABLE commerce_payment_intents DROP CONSTRAINT commerce_payment_intents_intended_minor_check;
ALTER TABLE commerce_payment_intents ADD CONSTRAINT commerce_payment_intents_intended_minor_check CHECK(intended_minor>=0);
