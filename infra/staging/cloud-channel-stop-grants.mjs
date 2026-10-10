/**
 * Grants for cloud channel stops (migration 055, ADR-0014 S3). Not applied by provisioning yet.
 *
 * cloudChannelStopGrants (back-office runtime): cloud stops are written only with the verbs the
 * module uses (the version guard and event trigger own the rest), events and overrides are
 * append-only, the 054 mode/stations/presence are read only. Apply after backofficeGrants and
 * backofficeStopGrants (the durable unstop reuses their cloud_stop_commands INSERT grant).
 *
 * cloudChannelAvailabilityGrants (kiosk/mobile sales runtime): read-only inputs of the cloud
 * sales gate in @pickchick/commerce-core availability.ts. Without them a branch in mode 'cloud'
 * keeps the gate closed; without branch_channel_modes the branch is treated as mode 'edge'.
 *
 * Disabled, both revoke only the 055 tables: the 054 tables belong to cloud-kitchen-grants.mjs.
 */
const OWN = 'cloud_channel_stops,cloud_channel_stop_events,cloud_stale_stop_overrides';
const KITCHEN = 'branch_channel_modes,cloud_kitchen_stations,cloud_kitchen_station_presence';
const STOP_COLUMNS = 'stopped,duration,reason,version,actor_id,actor_label';

function check(role, enabled, name) {
  if (
    typeof role !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(role) ||
    typeof enabled !== 'boolean'
  )
    throw new Error(`Invalid ${name} grant configuration`);
}
const join = (statements) => statements.map((s) => s + ';').join('\n');

export function cloudChannelStopGrants(role, enabled) {
  check(role, enabled, 'cloud channel stop');
  const statements = [`REVOKE ALL ON ${OWN} FROM ${role}`];
  if (enabled)
    statements.push(
      `GRANT SELECT,INSERT ON ${OWN} TO ${role}`,
      `GRANT UPDATE(${STOP_COLUMNS}) ON cloud_channel_stops TO ${role}`,
      `GRANT SELECT ON ${KITCHEN} TO ${role}`,
    );
  return join(statements);
}

export function cloudChannelAvailabilityGrants(role, enabled) {
  check(role, enabled, 'cloud channel availability');
  const statements = [`REVOKE ALL ON ${OWN} FROM ${role}`];
  if (enabled)
    statements.push(
      `GRANT SELECT ON cloud_channel_stops,cloud_stale_stop_overrides TO ${role}`,
      `GRANT SELECT ON ${KITCHEN} TO ${role}`,
    );
  return join(statements);
}
