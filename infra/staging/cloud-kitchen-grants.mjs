/**
 * API runtime grants for cloud kitchen fulfillment (migration 054, ADR-0014 S2).
 * The runtime reads configuration (stations, routing, mode) but never writes it: stations and
 * routing are trusted owner provisioning, and the mode changes only through the audited
 * SECURITY DEFINER cloud_kitchen_set_mode. The aggregate tables get exactly the verbs the
 * repository uses: no DELETE or TRUNCATE anywhere, append-only journals get INSERT only.
 * The channel number functions come from channel-number-grants.mjs (053).
 * Not applied by provisioning yet; nothing in production uses these tables in S2.
 */
const READ_ONLY =
  'branch_channel_modes,branch_channel_mode_changes,cloud_kitchen_stations,cloud_kitchen_routing,cloud_kitchen_config';
const APPEND_ONLY = 'cloud_kitchen_admissions,cloud_kitchen_commands';
const MUTABLE = 'cloud_kitchen_orders,cloud_kitchen_tasks,cloud_kitchen_outbox';
const PRESENCE = 'cloud_kitchen_station_presence';
const FUNCTIONS = 'cloud_kitchen_set_mode(uuid,text,text,text)';
const ALL = [READ_ONLY, APPEND_ONLY, MUTABLE, PRESENCE].join(',');

export function cloudKitchenGrants(role, enabled) {
  if (
    typeof role !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(role) ||
    typeof enabled !== 'boolean'
  )
    throw new Error('Invalid cloud kitchen grant configuration');
  const statements = [
    `REVOKE ALL ON ${ALL} FROM ${role}`,
    `REVOKE ALL ON FUNCTION ${FUNCTIONS} FROM ${role}`,
  ];
  if (enabled)
    statements.push(
      `GRANT SELECT ON ${READ_ONLY} TO ${role}`,
      `GRANT SELECT,INSERT ON ${APPEND_ONLY} TO ${role}`,
      `GRANT SELECT,INSERT,UPDATE ON ${MUTABLE} TO ${role}`,
      `GRANT SELECT,INSERT,UPDATE ON ${PRESENCE} TO ${role}`,
      `GRANT EXECUTE ON FUNCTION ${FUNCTIONS} TO ${role}`,
    );
  return statements.map((s) => s + ';').join('\n');
}
