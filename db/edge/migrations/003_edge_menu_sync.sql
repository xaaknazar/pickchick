CREATE TABLE menu_sync_state (
  branch_id uuid PRIMARY KEY REFERENCES branch_config(id),
  producer_id uuid NOT NULL UNIQUE,
  ack_producer_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  last_sequence bigint NOT NULL CHECK (last_sequence >= 0)
);
CREATE INDEX outbox_menu_ack_idx ON outbox_events(branch_id, producer_sequence)
WHERE event_type = 'menu.applied' AND acknowledged_at IS NULL;
