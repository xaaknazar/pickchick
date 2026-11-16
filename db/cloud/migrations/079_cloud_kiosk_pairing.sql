-- «Подключить киоск» in the back office (owner request 16.11.2026). Until now a kiosk iPad was
-- registered only offline (scripts/provision-kiosk.mjs + provision-kiosk-enrollment.mjs, run by
-- the operator on the cloud server). A branch manager now issues the same pair of a kiosk device
-- and a short-lived enrollment alias from «Устройства»; the iPad enters the ID and password in
-- its existing «Настройка киоска» form (/v1/kiosk-checkout/enrollment/exchange is unchanged).
-- Additive: one new append-only table. Runtime access is granted by
-- infra/staging/kiosk-pairing-grants.mjs behind BACKOFFICE_KIOSK_PAIRING_ENABLED (default off).
-- The plaintext password and device key are never stored: the alias keeps the scrypt verifier
-- and the AES-GCM ciphertext exactly as the offline procedure does.
CREATE TABLE kiosk_pairing_issues (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 device_id uuid NOT NULL,
 login text COLLATE "C" NOT NULL UNIQUE REFERENCES kiosk_enrollment_aliases(login),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 actor_id uuid NOT NULL,
 request_id uuid NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id, request_id),
 FOREIGN KEY(device_id, organization_id, branch_id) REFERENCES kiosk_devices(id, organization_id, branch_id),
 FOREIGN KEY(branch_id, organization_id) REFERENCES branches(id, organization_id),
 FOREIGN KEY(actor_id, organization_id) REFERENCES catalog_managers(id, organization_id)
);
CREATE INDEX kiosk_pairing_issues_branch_idx ON kiosk_pairing_issues(branch_id, created_at DESC);
CREATE FUNCTION kiosk_pairing_issues_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'kiosk_pairing_issues is append-only';
END $$;
CREATE TRIGGER kiosk_pairing_issues_append_only BEFORE UPDATE OR DELETE ON kiosk_pairing_issues
  FOR EACH ROW EXECUTE FUNCTION kiosk_pairing_issues_append_only();
