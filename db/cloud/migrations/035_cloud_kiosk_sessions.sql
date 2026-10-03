-- Kiosk identity is independent of edge device and customer account identity.
CREATE TABLE kiosk_devices (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 branch_id uuid NOT NULL REFERENCES branches(id),
 token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 active boolean NOT NULL DEFAULT true,
 lock_anchor boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id,branch_id)
);
CREATE FUNCTION kiosk_device_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM branches WHERE id=NEW.branch_id AND organization_id=NEW.organization_id)
 THEN RAISE EXCEPTION 'Kiosk branch scope mismatch' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW.organization_id,NEW.branch_id) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id)
 THEN RAISE EXCEPTION 'Immutable kiosk device scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER kiosk_device_scope_guard BEFORE INSERT OR UPDATE ON kiosk_devices
 FOR EACH ROW EXECUTE FUNCTION kiosk_device_scope_guard();
CREATE TABLE kiosk_sessions (
 id uuid PRIMARY KEY,
 device_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 ended_at timestamptz,
 phone_ciphertext bytea,
 phone_nonce bytea,
 phone_tag bytea,
 phone_expires_at timestamptz,
 FOREIGN KEY(device_id,organization_id,branch_id) REFERENCES kiosk_devices(id,organization_id,branch_id),
 CHECK(expires_at>created_at),
 CHECK((phone_ciphertext IS NULL AND phone_nonce IS NULL AND phone_tag IS NULL)
  OR (phone_ciphertext IS NOT NULL AND phone_nonce IS NOT NULL AND phone_tag IS NOT NULL AND octet_length(phone_nonce)=12 AND octet_length(phone_tag)=16 AND phone_expires_at IS NOT NULL))
);
CREATE INDEX kiosk_sessions_device_idx ON kiosk_sessions(device_id,expires_at);
CREATE INDEX kiosk_sessions_phone_expiry_idx ON kiosk_sessions(phone_expires_at) WHERE phone_ciphertext IS NOT NULL;
