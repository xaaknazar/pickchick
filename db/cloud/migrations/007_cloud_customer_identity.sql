-- Real customer identity is deliberately separate from anonymous TEST actors.
-- No plaintext phone, birthday, OTP, bearer token or reusable credential is stored.
CREATE TABLE identity_customers (
  id uuid PRIMARY KEY,
  phone_lookup text UNIQUE CHECK (phone_lookup ~ '^[a-f0-9]{64}$'),
  phone_cipher text,
  profile_cipher text,
  profile_completed_at timestamptz,
  created_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CHECK ((deleted_at IS NULL AND phone_lookup IS NOT NULL AND phone_cipher IS NOT NULL AND profile_cipher IS NOT NULL)
      OR (deleted_at IS NOT NULL AND phone_lookup IS NULL AND phone_cipher IS NULL AND profile_cipher IS NULL AND profile_completed_at IS NULL))
);
CREATE TABLE identity_sessions (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES identity_customers(id),
  device_hash text NOT NULL CHECK (device_hash ~ '^[a-f0-9]{64}$'),
  access_hash text UNIQUE CHECK (access_hash ~ '^[a-f0-9]{64}$'),
  access_expires_at timestamptz NOT NULL,
  refresh_hash text UNIQUE CHECK (refresh_hash ~ '^[a-f0-9]{64}$'),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  created_at timestamptz NOT NULL,
  refreshed_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (revoked_at IS NULL OR (access_hash IS NULL AND refresh_hash IS NULL))
);
CREATE UNIQUE INDEX identity_sessions_current_device_idx ON identity_sessions(customer_id, device_hash) WHERE revoked_at IS NULL;
CREATE INDEX identity_sessions_customer_idx ON identity_sessions(customer_id);
-- Exactly one recovery receipt per session; replaced by the next rotation.
CREATE TABLE identity_refresh_receipts (
  session_id uuid PRIMARY KEY REFERENCES identity_sessions(id),
  previous_hash text NOT NULL UNIQUE CHECK (previous_hash ~ '^[a-f0-9]{64}$'),
  request_id uuid NOT NULL,
  successor_hash text NOT NULL CHECK (successor_hash ~ '^[a-f0-9]{64}$'),
  response_cipher text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE identity_otp_challenges (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  phone_lookup text NOT NULL CHECK (phone_lookup ~ '^[a-f0-9]{64}$'),
  phone_cipher text,
  device_hash text NOT NULL CHECK (device_hash ~ '^[a-f0-9]{64}$'),
  ip_hash text NOT NULL CHECK (ip_hash ~ '^[a-f0-9]{64}$'),
  code_hash text CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  state text NOT NULL CHECK (state IN ('reserved','submitted','unknown','rejected','consumed','superseded','expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  verify_request_id uuid,
  verify_input_hash text CHECK (verify_input_hash ~ '^[a-f0-9]{64}$'),
  session_id uuid REFERENCES identity_sessions(id),
  initial_refresh_hash text CHECK (initial_refresh_hash ~ '^[a-f0-9]{64}$'),
  response_cipher text,
  receipt_expires_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (state <> 'consumed' OR consumed_at IS NOT NULL)
);
CREATE INDEX identity_otp_phone_time_idx ON identity_otp_challenges(phone_lookup, created_at DESC);
CREATE INDEX identity_otp_device_time_idx ON identity_otp_challenges(device_hash, created_at DESC);
CREATE INDEX identity_otp_ip_time_idx ON identity_otp_challenges(ip_hash, created_at DESC);
CREATE INDEX identity_otp_receipt_expiry_idx ON identity_otp_challenges(receipt_expires_at) WHERE response_cipher IS NOT NULL;
CREATE INDEX identity_otp_session_idx ON identity_otp_challenges(session_id) WHERE session_id IS NOT NULL;
-- Once the private challenge is purged, its random request key still cannot dispatch again.
CREATE TABLE identity_otp_request_tombstones (
  request_id uuid PRIMARY KEY,
  purged_at timestamptz NOT NULL
);
CREATE TABLE identity_sms_daily_budget (
  budget_day date PRIMARY KEY,
  reservations integer NOT NULL CHECK (reservations > 0)
);
CREATE TABLE identity_consents (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES identity_customers(id),
  kind text NOT NULL CHECK (kind IN ('terms','privacy','marketing')),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 100),
  accepted boolean NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX identity_consents_customer_idx ON identity_consents(customer_id, recorded_at DESC);
-- Minimal deletion evidence: the random customer ID and timestamp contain no phone lookup.
CREATE TABLE identity_deletions (
  customer_id uuid PRIMARY KEY REFERENCES identity_customers(id),
  deleted_at timestamptz NOT NULL
);
