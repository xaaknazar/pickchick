-- Virtual farm progress only: no commerce, loyalty or restaurant effects.
CREATE TABLE customer_farms (
 customer_id uuid PRIMARY KEY REFERENCES identity_customers(id) ON DELETE CASCADE,
 state jsonb NOT NULL CHECK (jsonb_typeof(state)='object' AND octet_length(state::text)<=65536)
);
CREATE TABLE customer_farm_commands (
 customer_id uuid NOT NULL REFERENCES customer_farms(customer_id) ON DELETE CASCADE,
 command_id uuid NOT NULL,
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revision bigint NOT NULL CHECK (revision >= 0),
 PRIMARY KEY(customer_id, command_id)
);
-- Receipts remain durable for the lifetime of the farm. Application caps commands
-- at 100000 per customer; never prune receipts while accepting old command IDs.
CREATE INDEX customer_farm_commands_time ON customer_farm_commands(customer_id, created_at);
