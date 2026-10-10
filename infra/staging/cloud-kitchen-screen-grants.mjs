/**
 * Grants for cloud 056 (ADR-0014 S4). Not applied by provisioning yet.
 *
 * cloudKitchenScreenGrants (API runtime of /v1/kitchen and the back-office screen routes):
 * screens and pairing codes get INSERT and UPDATE only of the columns the module changes (the
 * 056 triggers own identity, single use and generation order); the journal is append-only;
 * cloud channel orders are read for the catch-up admission. No DELETE or TRUNCATE anywhere.
 *
 * cloudChannelOrderGrants (kiosk/mobile commerce runtime and payment workers): registers cloud
 * channel orders and reads them, the branch mode and the number ranges. Without these grants
 * every order is an edge order (the reads are privilege-guarded). The admission itself also
 * needs cloud-kitchen-grants.mjs (054) and channel-number-grants.mjs (053).
 *
 * Disabled, both revoke only what they grant on the 056 tables.
 */
const SCREENS = 'cloud_kitchen_screens,cloud_kitchen_pairing_codes,cloud_kitchen_screen_events';
const SCREEN_COLUMNS =
  'generation,key_hash,key_issued_at,revoked_at,revoked_by,revoked_reason,last_seen_at';
const CODE_COLUMNS = 'failed_attempts,used_at,burned_at';
const NUMBERS = 'channel_number_ranges,channel_number_holds';

function check(role, enabled, name) {
  if (
    typeof role !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(role) ||
    typeof enabled !== 'boolean'
  )
    throw new Error(`Invalid ${name} grant configuration`);
}
const join = (statements) => statements.map((s) => s + ';').join('\n');

export function cloudKitchenScreenGrants(role, enabled) {
  check(role, enabled, 'cloud kitchen screen');
  const statements = [`REVOKE ALL ON ${SCREENS} FROM ${role}`];
  if (enabled)
    statements.push(
      `GRANT SELECT,INSERT ON ${SCREENS} TO ${role}`,
      `GRANT UPDATE(${SCREEN_COLUMNS}) ON cloud_kitchen_screens TO ${role}`,
      `GRANT UPDATE(${CODE_COLUMNS}) ON cloud_kitchen_pairing_codes TO ${role}`,
      `GRANT SELECT ON cloud_channel_orders TO ${role}`,
    );
  return join(statements);
}

export function cloudChannelOrderGrants(role, enabled) {
  check(role, enabled, 'cloud channel order');
  const statements = [`REVOKE ALL ON cloud_channel_orders FROM ${role}`];
  if (enabled)
    statements.push(
      `GRANT SELECT,INSERT ON cloud_channel_orders TO ${role}`,
      `GRANT SELECT ON branch_channel_modes,${NUMBERS} TO ${role}`,
    );
  return join(statements);
}
