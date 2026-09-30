-- Explicit ownership for the free pilot; never adopt anonymous historical actors.
CREATE TABLE identity_customer_test_actors (
  customer_id uuid PRIMARY KEY REFERENCES identity_customers(id),
  actor_id uuid NOT NULL UNIQUE REFERENCES test_actors(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
