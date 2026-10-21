-- Automatic edge identity renewal (docs/operations/edge-identity-rotation.md). Additive only.
-- A device-initiated rotation keeps the replaced credential valid until the device confirms the
-- new one (never past its own expiry), then for at most 24 hours so every edge process can reload
-- the file. Manual provisioning clears the overlap and otherwise keeps its old semantics.
ALTER TABLE device_credentials
  ADD COLUMN previous_token_hash text CHECK (previous_token_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN previous_expires_at timestamptz;
ALTER TABLE device_credentials ADD CONSTRAINT device_credentials_previous_pair CHECK (
  (previous_token_hash IS NULL) = (previous_expires_at IS NULL)
  AND previous_token_hash IS DISTINCT FROM token_hash
);

-- Append-only audit and idempotency ledger. A credential can be rotated at most once
-- (from_token_hash is unique), so a replayed or concurrent request can never fork it.
-- The derivation salt lets the cloud recompute the same new token for a replay that
-- presents the old token; the database alone (hashes and salt) cannot derive any token.
CREATE TABLE device_identity_rotations (
  rotation_id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id),
  from_token_hash text NOT NULL UNIQUE CHECK (from_token_hash ~ '^[a-f0-9]{64}$'),
  to_token_hash text NOT NULL UNIQUE CHECK (to_token_hash ~ '^[a-f0-9]{64}$'),
  derivation_salt text NOT NULL CHECK (derivation_salt ~ '^[a-f0-9]{64}$'),
  from_expires_at timestamptz NOT NULL,
  overlap_until timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  actor text NOT NULL CHECK (actor = 'device'),
  rotated_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  CHECK (from_token_hash <> to_token_hash),
  CHECK (overlap_until > rotated_at AND overlap_until <= from_expires_at),
  CHECK (expires_at > rotated_at),
  CHECK (confirmed_at IS NULL OR confirmed_at >= rotated_at)
);
CREATE INDEX device_identity_rotations_device_idx ON device_identity_rotations(device_id, rotated_at);

CREATE FUNCTION guard_device_identity_rotation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
    (to_jsonb(NEW) - ARRAY['confirmed_at', 'replay_count']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['confirmed_at', 'replay_count']) OR
    (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at) OR
    NEW.replay_count < OLD.replay_count
  THEN RAISE EXCEPTION 'Edge identity rotation audit is append-only' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER device_identity_rotation_guard BEFORE UPDATE OR DELETE ON device_identity_rotations
FOR EACH ROW EXECUTE FUNCTION guard_device_identity_rotation();
