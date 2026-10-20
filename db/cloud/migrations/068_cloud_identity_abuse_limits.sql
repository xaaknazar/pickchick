-- Audit 19.10 (5.3/2.6, 5.4, 5.7). Additive only; older API builds ignore every new object.
-- Shared-address heuristics: keyed HMAC of the client's /24 (IPv6 /48). NULL on older rows.
ALTER TABLE identity_otp_challenges
  ADD COLUMN ip_net_hash text CHECK (ip_net_hash ~ '^[a-f0-9]{64}$');
CREATE INDEX identity_otp_ip_net_time_idx
  ON identity_otp_challenges(ip_net_hash, created_at DESC) WHERE ip_net_hash IS NOT NULL;
-- Returning customers keep a reserved share of the daily delivery budget.
ALTER TABLE identity_sms_daily_budget
  ADD COLUMN new_phone_reservations integer NOT NULL DEFAULT 0
  CHECK (new_phone_reservations >= 0);
-- Wrong codes per phone across challenges (challenges themselves are purged after 24 hours).
-- Keyed phone lookup only, hour buckets, removed after 31 days by the identity cleanup.
CREATE TABLE identity_otp_failures (
  phone_lookup text NOT NULL CHECK (phone_lookup ~ '^[a-f0-9]{64}$'),
  failure_hour timestamptz NOT NULL,
  failures integer NOT NULL CHECK (failures > 0),
  PRIMARY KEY (phone_lookup, failure_hour)
);
CREATE INDEX identity_otp_failures_hour_idx ON identity_otp_failures(failure_hour);
-- Refresh-token reuse detection: hashes of the latest rotated-away tokens of a live session.
ALTER TABLE identity_sessions
  ADD COLUMN retired_refresh_hashes text[] NOT NULL DEFAULT '{}';
CREATE INDEX identity_sessions_retired_refresh_idx
  ON identity_sessions USING gin (retired_refresh_hashes);
