-- Sandbox observations are intentionally outside all commercial order/money/event tables.
CREATE TABLE commerce_tiptoppay_test_payments (
 id uuid PRIMARY KEY,
 quote_id uuid NOT NULL UNIQUE REFERENCES commerce_quotes(id),
 customer_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 public_id text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 method text NOT NULL CHECK(method IN ('card','apple_pay','google_pay')),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','paid','failed')),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,
 opened_at timestamptz,
 operation_id text CHECK(operation_id IS NULL OR operation_id ~ '^[1-9][0-9]{0,18}$'),
 paid_operation_id text CHECK(paid_operation_id IS NULL OR paid_operation_id ~ '^[1-9][0-9]{0,18}$'),
 reason_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id)
);
CREATE INDEX commerce_tiptoppay_test_customer_idx ON commerce_tiptoppay_test_payments(customer_id,created_at DESC);
