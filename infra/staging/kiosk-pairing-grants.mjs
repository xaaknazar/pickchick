/**
 * Cloud schema079 («Подключить киоск», owner request 16.11.2026): rights of the shared API role
 * for issuing a kiosk iPad registration from the back office, with BACKOFFICE_ENABLED and
 * BACKOFFICE_KIOSK_PAIRING_ENABLED on.
 *
 * - kiosk_devices: INSERT of the four columns of a new device (never UPDATE of token/active).
 * - kiosk_enrollment_aliases: INSERT of a new alias (verifier + ciphertext, never the password).
 * - kiosk_pairing_issues: SELECT, INSERT (append-only, refused by its trigger).
 *
 * SELECT on kiosk_devices and kiosk_enrollment_aliases stays with the commercial channel and
 * kiosk enrollment profiles and is not touched here. The SQL is a reset of only the rights listed
 * above (revoke, then grant the enabled set); with a flag off it only revokes; on a database
 * without 079 it is a no-op (to_regclass guard). infra/staging/commercial-channel-grants.mjs
 * revokes ALL on kiosk_devices: run this script again after it.
 */
export const MIGRATION = '079_cloud_kiosk_pairing.sql';
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const DEVICE_COLUMNS = 'id,organization_id,branch_id,token_hash';
const ALIAS_COLUMNS =
  'login,device_id,organization_id,branch_id,password_salt,password_verifier,token_ciphertext,token_nonce,token_tag,expires_at';

/** Exact rights for the module comment; empty when either flag is off. */
export function kioskPairingPrivileges(input) {
  if (!input || typeof input.backoffice !== 'boolean' || typeof input.pairing !== 'boolean')
    throw new Error('Invalid kiosk pairing grants');
  if (!input.backoffice || !input.pairing) return Object.freeze({});
  return Object.freeze({
    kiosk_devices: [`INSERT(${DEVICE_COLUMNS})`],
    kiosk_enrollment_aliases: [`INSERT(${ALIAS_COLUMNS})`],
    kiosk_pairing_issues: ['SELECT', 'INSERT'],
  });
}

/** Reset SQL for `role` (module comment). */
export function kioskPairingGrants(role, input, schema = 'public') {
  if (!NAME.test(role ?? '') || !NAME.test(schema)) throw new Error('Invalid kiosk pairing grants');
  const privileges = kioskPairingPrivileges(input);
  const r = `"${role}"`,
    t = (name) => `"${schema}"."${name}"`;
  const grant = Object.entries(privileges)
    .map(([name, list]) => `GRANT ${list.join(', ')} ON ${t(name)} TO ${r};`)
    .join(' ');
  return (
    `DO $kiosk_pairing$ BEGIN IF to_regclass('${schema}.kiosk_pairing_issues') IS NOT NULL THEN ` +
    `REVOKE INSERT ON ${t('kiosk_devices')} FROM ${r}; ` +
    `REVOKE INSERT ON ${t('kiosk_enrollment_aliases')} FROM ${r}; ` +
    `REVOKE ALL ON ${t('kiosk_pairing_issues')} FROM ${r}; ` +
    grant +
    ` END IF; END $kiosk_pairing$;`
  );
}
