/** Shared by provisioning and a real restricted-role PostgreSQL acceptance test. */
export function customerAuthGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid identity grant configuration');
  const tables = `identity_customers, identity_sessions, identity_refresh_receipts,
    identity_otp_challenges, identity_otp_request_tombstones, identity_sms_daily_budget,
    identity_consents, identity_deletions`;
  return (
    `REVOKE ALL ON ${tables} FROM ${role};` +
    (enabled
      ? `
    GRANT SELECT ON ${tables} TO ${role};
    GRANT INSERT, UPDATE ON identity_customers TO ${role};
    GRANT INSERT, UPDATE, DELETE ON identity_sessions, identity_refresh_receipts,
      identity_otp_challenges, identity_sms_daily_budget TO ${role};
    GRANT INSERT ON identity_otp_request_tombstones, identity_deletions TO ${role};
    GRANT INSERT, DELETE ON identity_consents TO ${role};`
      : '')
  );
}
