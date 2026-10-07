-- Operator aliases only bootstrap existing randomly provisioned kiosk credentials.
CREATE TABLE kiosk_enrollment_aliases (
 login text COLLATE "C" PRIMARY KEY CHECK(login ~ '^[A-Za-z0-9_.-]{3,64}$'),
 device_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 password_salt bytea NOT NULL CHECK(octet_length(password_salt)=16),
 password_verifier bytea NOT NULL CHECK(octet_length(password_verifier)=32),
 token_ciphertext bytea NOT NULL CHECK(octet_length(token_ciphertext)=64),
 token_nonce bytea NOT NULL CHECK(octet_length(token_nonce)=12),
 token_tag bytea NOT NULL CHECK(octet_length(token_tag)=16),
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours'),
 request_id uuid,
 failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 4),
 locked_until timestamptz,
 FOREIGN KEY(device_id,organization_id,branch_id) REFERENCES kiosk_devices(id,organization_id,branch_id),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id)
);
