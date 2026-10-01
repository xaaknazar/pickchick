-- Keep the immutable caller policy separate from the actual attempted transport.
ALTER TABLE identity_otp_challenges
  ADD COLUMN requested_channel text NOT NULL DEFAULT 'sms';
UPDATE identity_otp_challenges SET requested_channel=delivery_channel;
ALTER TABLE identity_otp_challenges
  ADD CONSTRAINT identity_otp_requested_channel_check
  CHECK (requested_channel IN ('sms','telegram','auto'));
ALTER TABLE identity_otp_challenges
  DROP CONSTRAINT identity_otp_challenges_delivery_channel_check;
ALTER TABLE identity_otp_challenges
  ADD CONSTRAINT identity_otp_challenges_delivery_channel_check
  CHECK (delivery_channel IN ('sms','telegram','whatsapp'));
