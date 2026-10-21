/**
 * API runtime grants for cloud channel display numbers (migration 053, ADR-0014 S2).
 * The runtime never writes the tables directly: it reads them and calls the owner-defined
 * SECURITY DEFINER functions (allocate, release, open shift), which keep the counter lock,
 * wrap-around, active-number skip and shift idempotency in one place. Disabling revokes all.
 * Not applied by provisioning yet; nothing in production calls these functions in S1.
 */
const TABLES =
  'channel_number_ranges,channel_number_shifts,channel_number_counters,channel_number_holds';
const FUNCTIONS =
  'channel_number_allocate(uuid,text,uuid),channel_number_release(uuid),channel_number_open_shift(uuid,text)';
export function channelNumberGrants(role, enabled) {
  if (
    typeof role !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(role) ||
    typeof enabled !== 'boolean'
  )
    throw new Error('Invalid channel number grant configuration');
  const statements = [
    `REVOKE ALL ON ${TABLES} FROM ${role}`,
    `REVOKE ALL ON FUNCTION ${FUNCTIONS} FROM ${role}`,
  ];
  if (enabled)
    statements.push(
      `GRANT SELECT ON ${TABLES} TO ${role}`,
      `GRANT EXECUTE ON FUNCTION ${FUNCTIONS} TO ${role}`,
    );
  return statements.map((s) => s + ';').join('\n');
}
