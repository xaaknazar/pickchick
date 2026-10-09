-- Branch device registry for the back office. Additive only: kiosk_devices, device_credentials,
-- the one-active-edge index and the local_setup-only device_audit invariant stay unchanged.
-- Pairing codes never store plaintext: code_hash is HMAC-SHA256 with a pepper held outside
-- the database (DEVICE_PAIRING_PEPPER); sealed_secret is AES-256-GCM like cloud044.
ALTER TABLE devices
 ADD COLUMN role text CHECK(role IN ('edge','pos','kiosk','kitchen_prep','kitchen_assembly','board')),
 ADD COLUMN kiosk_device_id uuid UNIQUE,
 ADD COLUMN edge_terminal_id uuid UNIQUE,
 ADD COLUMN last_seen_at timestamptz,
 ADD COLUMN app_version text CHECK(length(app_version) BETWEEN 1 AND 64),
 ADD COLUMN revoked_at timestamptz,
 ADD COLUMN revoked_by uuid,
 ADD COLUMN created_by uuid,
 ADD CONSTRAINT devices_kiosk_scope_fk FOREIGN KEY(kiosk_device_id,organization_id,branch_id)
  REFERENCES kiosk_devices(id,organization_id,branch_id),
 ADD CONSTRAINT devices_revoked_by_fk FOREIGN KEY(revoked_by,organization_id)
  REFERENCES catalog_managers(id,organization_id),
 ADD CONSTRAINT devices_created_by_fk FOREIGN KEY(created_by,organization_id)
  REFERENCES catalog_managers(id,organization_id),
 ADD CONSTRAINT devices_role_matches_kind CHECK(role IS NULL OR (kind,role) IN (
  ('edge','edge'),('pos','pos'),('kiosk','kiosk'),('kitchen','kitchen_prep'),
  ('kitchen','kitchen_assembly'),('display','board'))),
 ADD CONSTRAINT devices_kiosk_link_kind CHECK(kiosk_device_id IS NULL OR kind='kiosk'),
 ADD CONSTRAINT devices_terminal_link_kind CHECK(edge_terminal_id IS NULL OR kind IN ('pos','kitchen','display')),
 ADD CONSTRAINT devices_revocation_state CHECK(revoked_at IS NULL OR status='revoked'),
 ADD CONSTRAINT devices_revoked_by_needs_time CHECK(revoked_by IS NULL OR revoked_at IS NOT NULL);
UPDATE devices SET role=CASE kind WHEN 'edge' THEN 'edge' WHEN 'pos' THEN 'pos' WHEN 'kiosk' THEN 'kiosk'
 WHEN 'kitchen' THEN 'kitchen_prep' WHEN 'display' THEN 'board' END;
-- Existing writers (device:setup, seed) insert kind only; derive the role the same way.
CREATE FUNCTION devices_default_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.role IS NULL THEN
  NEW.role := CASE NEW.kind WHEN 'edge' THEN 'edge' WHEN 'pos' THEN 'pos' WHEN 'kiosk' THEN 'kiosk'
   WHEN 'kitchen' THEN 'kitchen_prep' WHEN 'display' THEN 'board' END;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER devices_default_role BEFORE INSERT ON devices
 FOR EACH ROW EXECUTE FUNCTION devices_default_role();

CREATE TABLE device_pairing_codes (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 device_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('kiosk','edge_terminal','edge_replace')),
 code_hash bytea NOT NULL UNIQUE CHECK(octet_length(code_hash)=32),
 sealed_secret bytea CHECK(sealed_secret IS NULL OR octet_length(sealed_secret) BETWEEN 29 AND 1024),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','consumed','cancelled','expired','burned')),
 consumed_at timestamptz,
 consumed_request_id uuid,
 request_id uuid NOT NULL,
 FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
 FOREIGN KEY(created_by,organization_id) REFERENCES catalog_managers(id,organization_id),
 UNIQUE(created_by,request_id),
 -- Short codes live 15 minutes at most; the MVP kiosk alias (login + password) 30 minutes.
 CHECK(expires_at>created_at AND expires_at<=created_at+CASE WHEN purpose='kiosk'
  THEN interval '30 minutes' ELSE interval '15 minutes' END),
 CHECK((state='consumed')=(consumed_at IS NOT NULL)),
 CHECK(consumed_request_id IS NULL OR state='consumed'),
 CHECK(state<>'burned' OR failed_attempts=5)
);
CREATE UNIQUE INDEX device_pairing_codes_one_open_idx ON device_pairing_codes(device_id) WHERE state='open';
CREATE INDEX device_pairing_codes_branch_idx ON device_pairing_codes(branch_id,state,created_at DESC);
CREATE INDEX device_pairing_codes_actor_idx ON device_pairing_codes(created_by,created_at DESC);
-- Only the open -> terminal transition and the attempt counter may change; rows are never deleted.
CREATE FUNCTION device_pairing_codes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Device pairing codes cannot be deleted' USING ERRCODE='23514';
 END IF;
 IF (NEW.id,NEW.organization_id,NEW.branch_id,NEW.device_id,NEW.purpose,NEW.code_hash,NEW.sealed_secret,
     NEW.created_by,NEW.created_at,NEW.expires_at,NEW.request_id)
  IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.branch_id,OLD.device_id,OLD.purpose,OLD.code_hash,
     OLD.sealed_secret,OLD.created_by,OLD.created_at,OLD.expires_at,OLD.request_id)
  OR NEW.failed_attempts<OLD.failed_attempts
  OR (OLD.state<>'open' AND (NEW.state,NEW.failed_attempts,NEW.consumed_at,NEW.consumed_request_id)
      IS DISTINCT FROM (OLD.state,OLD.failed_attempts,OLD.consumed_at,OLD.consumed_request_id)) THEN
  RAISE EXCEPTION 'Device pairing code is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER device_pairing_codes_guard BEFORE UPDATE OR DELETE ON device_pairing_codes
 FOR EACH ROW EXECUTE FUNCTION device_pairing_codes_guard();

CREATE TABLE device_events (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 device_id uuid NOT NULL,
 actor_kind text NOT NULL CHECK(actor_kind IN ('backoffice','local_setup','device','edge')),
 actor_id uuid,
 action text NOT NULL CHECK(action IN ('created','code_issued','code_cancelled','paired','pair_failed_burned',
  'renamed','revoked','credential_rotated','staff_reset_requested','staff_reset_applied','terminal_mirrored')),
 reason text CHECK(reason IS NULL OR length(reason) BETWEEN 3 AND 500),
 request_id uuid,
 at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(device_id,branch_id) REFERENCES devices(id,branch_id),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
 CHECK(actor_kind<>'backoffice' OR (actor_id IS NOT NULL AND reason IS NOT NULL AND request_id IS NOT NULL))
);
CREATE INDEX device_events_device_idx ON device_events(device_id,at DESC,id);
CREATE INDEX device_events_branch_idx ON device_events(branch_id,at DESC,id);
CREATE TRIGGER device_events_immutable BEFORE UPDATE OR DELETE ON device_events
 FOR EACH ROW EXECUTE FUNCTION commerce_immutable();
