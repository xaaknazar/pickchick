-- Recovery has a separate guessing budget: a fresh OTP may legitimately succeed
-- on its fifth attempt and must still allow an exact lost-response replay.
ALTER TABLE identity_otp_challenges
  ADD COLUMN receipt_failed_attempts integer NOT NULL DEFAULT 0
  CHECK (receipt_failed_attempts BETWEEN 0 AND 5);
