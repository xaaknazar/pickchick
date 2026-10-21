/**
 * Device-initiated identity renewal (cloud066, CLOUD_EDGE_IDENTITY_ROTATION_ENABLED).
 * Enabled, the API role may replace a credential's secret/expiry and keep the previous one for the
 * overlap, append rotation audit rows and mark them confirmed/replayed. It never gains device
 * status, branch, kind or audit deletion: provisioning and revocation stay operator-only.
 * Disabled (the default), every privilege this helper grants is revoked again; the always-on
 * SELECT on device_credentials (provision.mjs) is untouched.
 */
export function edgeIdentityRotationGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid edge identity rotation grants');
  const columns = 'token_hash,expires_at,issued_at,previous_token_hash,previous_expires_at';
  return (
    `REVOKE ALL ON device_identity_rotations FROM ${role};
REVOKE UPDATE(${columns}) ON device_credentials FROM ${role};` +
    (enabled
      ? `
GRANT SELECT, INSERT ON device_identity_rotations TO ${role};
GRANT UPDATE(confirmed_at, replay_count) ON device_identity_rotations TO ${role};
GRANT UPDATE(${columns}) ON device_credentials TO ${role};`
      : '')
  );
}
