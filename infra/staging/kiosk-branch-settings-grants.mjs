/**
 * Cloud schema081 (ADR-0019, kiosks on more points): rights of the shared API role, with
 * KIOSK_MULTI_BRANCH_ENABLED=true.
 *
 * - kiosk_branch_settings: SELECT (the kiosk API reads which points are switched on).
 * - With the back office on as well (BACKOFFICE_ENABLED, «Киоски на этой точке» in «Устройства»):
 *   INSERT and UPDATE of the setting columns (the trigger refuses DELETE, an identity change and
 *   a version that does not grow by one), and EXECUTE of kiosk_branch_terminal_account, which
 *   creates only the point's 'kaspi-pos' payment account. INSERT on commerce_provider_accounts
 *   itself is never granted.
 *
 * The audit of the switch (bo_audit, bo_commands) uses the existing back-office rights. The SQL
 * is a reset of only the rights listed above (revoke, then grant the enabled set); with the flag
 * off it only revokes, so the kiosk API serves the env point alone. On a database without 081 it
 * is a no-op (to_regclass guard). Apply after the kiosk terminal grants (kiosk-terminal-grants.mjs):
 * other points pay only on the terminal.
 */
export const MIGRATION = '081_cloud_kiosk_branch_settings.sql';
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const SETTING_COLUMNS =
  'organization_id,branch_id,enabled,terminal_payment_account_id,updated_by,updated_at,version';
const UPDATE_COLUMNS = 'enabled,terminal_payment_account_id,updated_by,updated_at,version';
export const ACCOUNT_FUNCTION = 'kiosk_branch_terminal_account(uuid,uuid)';

/** Exact rights for the module comment; empty when the multi-point flag is off. */
export function kioskBranchSettingsPrivileges(input) {
  if (!input || typeof input.multiBranch !== 'boolean' || typeof input.backoffice !== 'boolean')
    throw new Error('Invalid kiosk branch settings grants');
  if (!input.multiBranch) return Object.freeze({});
  return Object.freeze({
    kiosk_branch_settings: input.backoffice
      ? ['SELECT', `INSERT(${SETTING_COLUMNS})`, `UPDATE(${UPDATE_COLUMNS})`]
      : ['SELECT'],
    ...(input.backoffice ? { [ACCOUNT_FUNCTION]: ['EXECUTE'] } : {}),
  });
}

/** Reset SQL for `role` (module comment). */
export function kioskBranchSettingsGrants(role, input, schema = 'public') {
  if (typeof role !== 'string' || !NAME.test(role) || !NAME.test(schema))
    throw new Error('Invalid kiosk branch settings grants');
  const privileges = kioskBranchSettingsPrivileges(input);
  const r = `"${role}"`,
    t = (name) => `"${schema}"."${name}"`,
    fn = `"${schema}".kiosk_branch_terminal_account(uuid,uuid)`;
  const grant = Object.entries(privileges)
    .map(([name, list]) =>
      name === ACCOUNT_FUNCTION
        ? `GRANT EXECUTE ON FUNCTION ${fn} TO ${r};`
        : `GRANT ${list.join(', ')} ON ${t(name)} TO ${r};`,
    )
    .join(' ');
  return (
    `DO $kiosk_branch$ BEGIN IF to_regclass('${schema}.kiosk_branch_settings') IS NOT NULL THEN ` +
    `REVOKE ALL ON ${t('kiosk_branch_settings')} FROM ${r}; ` +
    `REVOKE ALL ON FUNCTION ${fn} FROM ${r};` +
    (grant ? ' ' + grant : '') +
    ` END IF; END $kiosk_branch$;`
  );
}
