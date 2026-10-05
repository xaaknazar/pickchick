-- A payment method belongs to the order. A started attempt freezes the selection.
CREATE TABLE commerce_checkout_payment_methods (
 order_id uuid PRIMARY KEY REFERENCES commerce_orders(id),
 method text NOT NULL CHECK(method IN ('kaspi','card','apple_pay','google_pay')),
 locked_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Only a hash of the bearer capability is durable. Tokens travel in URL fragments/POST bodies.
CREATE TABLE commerce_tiptoppay_sessions (
 attempt_id uuid PRIMARY KEY REFERENCES commerce_payment_attempts(id),
 order_id uuid NOT NULL UNIQUE REFERENCES commerce_orders(id),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,
 opened_at timestamptz,
 authorized_operation_id text CHECK(authorized_operation_id IS NULL OR authorized_operation_id ~ '^[1-9][0-9]{0,18}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Worker scheduling is durable; absence of a result preserves ambiguity.
ALTER TABLE commerce_tiptoppay_sessions ADD COLUMN reconcile_attempts integer NOT NULL DEFAULT 0 CHECK(reconcile_attempts BETWEEN 0 AND 20);
ALTER TABLE commerce_tiptoppay_sessions ADD COLUMN last_reconcile_at timestamptz;
