-- Exactly one active edge per branch. Device replacement/fencing is a later protocol.
CREATE UNIQUE INDEX devices_one_active_edge_idx ON devices(branch_id)
WHERE kind = 'edge' AND status = 'active';

CREATE TABLE device_credentials (
  device_id uuid PRIMARY KEY REFERENCES devices(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at)
);

CREATE TABLE device_audit (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id),
  action text NOT NULL CHECK (action IN ('provisioned', 'rotated', 'revoked')),
  actor text NOT NULL CHECK (actor = 'local_setup'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE menu_streams (
  branch_id uuid PRIMARY KEY REFERENCES branches(id),
  producer_id uuid NOT NULL UNIQUE,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);
CREATE INDEX outbox_menu_delivery_idx ON outbox_events(branch_id, producer_sequence)
WHERE event_type = 'menu.published' AND acknowledged_at IS NULL;
