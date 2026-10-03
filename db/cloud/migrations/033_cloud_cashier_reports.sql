-- Trusted edge operational observations, separate from cloud financial effects.
CREATE TABLE cloud_cashier_report_inbox (
 event_id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 device_id uuid NOT NULL REFERENCES devices(id),
 sequence bigint NOT NULL CHECK(sequence>0),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(device_id,sequence)
);
CREATE TABLE cloud_cashier_shifts (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 device_id uuid NOT NULL REFERENCES devices(id),
 sequence bigint NOT NULL CHECK(sequence>0),
 payload jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,branch_id,device_id)
);
CREATE TABLE cloud_cashier_orders (
 id uuid PRIMARY KEY,
 branch_id uuid NOT NULL REFERENCES branches(id),
 device_id uuid NOT NULL REFERENCES devices(id),
 cash_shift_id uuid,
 created_at timestamptz NOT NULL,
 sequence bigint NOT NULL CHECK(sequence>0),
 payload jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(cash_shift_id,branch_id,device_id) REFERENCES cloud_cashier_shifts(id,branch_id,device_id)
);
CREATE INDEX cloud_cashier_orders_report_idx ON cloud_cashier_orders(branch_id,device_id,cash_shift_id,created_at DESC,id);
CREATE INDEX cloud_cashier_shifts_report_idx ON cloud_cashier_shifts(branch_id,device_id,observed_at DESC,id);
