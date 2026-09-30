-- Existing challenges retain their original six-digit contract, including retry receipts.
ALTER TABLE identity_otp_challenges
  ADD COLUMN code_length smallint NOT NULL DEFAULT 6
  CHECK (code_length IN (4, 6));
