-- Existing requests were SMS. Channel is part of immutable idempotency identity.
ALTER TABLE identity_otp_challenges
  ADD COLUMN delivery_channel text NOT NULL DEFAULT 'sms' CHECK (delivery_channel IN ('sms','telegram')),
  ADD COLUMN delivery_provider text,
  ADD COLUMN delivery_reference text;
-- The existing durable daily reservation budget covers ALL channels, not just SMS.
