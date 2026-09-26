-- Existing rows have no evidence of pre-send consent; never backfill consent.
ALTER TABLE identity_otp_challenges ADD COLUMN delivery_consent_version text;
-- created_at records the durable acceptance/reservation time, before provider dispatch.
