-- TipTopPay LIVE checkout of the mobile app (owner 23.11.2026, tiptoppay-checkout.ts).
-- A declined attempt may be followed by a new attempt on the same order: one session per
-- attempt, several per order. The method and the reconciliation schedule live on the session.
ALTER TABLE commerce_tiptoppay_sessions DROP CONSTRAINT commerce_tiptoppay_sessions_order_id_key;
CREATE INDEX commerce_tiptoppay_sessions_order_idx ON commerce_tiptoppay_sessions(order_id);
ALTER TABLE commerce_tiptoppay_sessions ADD COLUMN method text
  CHECK(method IS NULL OR method IN ('card','apple_pay','google_pay'));
ALTER TABLE commerce_tiptoppay_sessions ADD COLUMN next_check_at timestamptz;
CREATE INDEX commerce_tiptoppay_sessions_due_idx ON commerce_tiptoppay_sessions(next_check_at)
  WHERE opened_at IS NOT NULL;
CREATE INDEX commerce_tiptoppay_sessions_operation_idx ON commerce_tiptoppay_sessions(authorized_operation_id)
  WHERE authorized_operation_id IS NOT NULL;
