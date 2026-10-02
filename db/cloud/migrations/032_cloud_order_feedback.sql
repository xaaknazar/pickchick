-- Customer feedback is independent of money, kitchen state and fiscal documents.
-- One editable review per commercial order; retries preserve its original timestamps.
CREATE TABLE commerce_order_feedback (
 order_id uuid PRIMARY KEY REFERENCES commerce_orders(id),
 rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5),
 comment text CHECK(comment IS NULL OR (length(comment) BETWEEN 1 AND 500 AND comment=btrim(comment))),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(updated_at>=created_at)
);
