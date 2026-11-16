/**
 * Cloud schema080 (ADR-0018, kiosk paid on its own Kaspi Smart POS terminal): rights of the
 * shared API role, with KIOSK_KASPI_TERMINAL_ENABLED=true. Apply after the checkout and kiosk
 * grant helpers (customerCheckoutGrants, kioskCheckoutGrants), whose SELECT/INSERT on orders,
 * attempts and the outbox the terminal flow also uses.
 *
 * 080 tables:
 * - kiosk_terminal_links: SELECT, INSERT, UPDATE(serial,host,updated_at,unlinked_at)
 *   (the trigger refuses any other change and every DELETE).
 * - commerce_kiosk_terminal_attempts: SELECT, INSERT, UPDATE(state,process_id,transaction_id,
 *   incident,resolved_at) (amount, terminal, order and account are immutable by trigger).
 * - commerce_kiosk_terminal_events: SELECT, INSERT (append-only by trigger).
 *
 * Kiosk-attested observation (ADR-0018 decision 2: the API records the terminal outcome the way
 * the QR worker records a bank outcome, through CommerceRepository.observePayment):
 * - commerce_provider_inbox: SELECT, INSERT; commerce_captures, commerce_reconciliation_issues,
 *   commerce_fiscal_documents: INSERT; commerce_payment_attempts: UPDATE(state);
 *   commerce_outbox: UPDATE(acknowledged_at) (the terminal submit request has no worker).
 *
 * The SQL is a reset of the 080 tables (revoke, then grant the enabled set); with the flag off it
 * only revokes them, which closes every terminal route at the database. The observation rights
 * on shared tables are only granted, never revoked here: the same role may hold them from
 * kaspiWorkerGrants/kioskQrWorkerGrants, and revoking would stop the QR rail. On a database
 * without 080 it is a no-op (to_regclass guard).
 */
export const MIGRATION = '080_cloud_kiosk_kaspi_terminal.sql';
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
export const TERMINAL_TABLES = Object.freeze([
  'kiosk_terminal_links',
  'commerce_kiosk_terminal_attempts',
  'commerce_kiosk_terminal_events',
]);

/** Exact rights for the module comment; empty when the flag is off. */
export function kioskTerminalPrivileges(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Invalid kiosk terminal grants');
  if (!enabled) return Object.freeze({});
  return Object.freeze({
    kiosk_terminal_links: ['SELECT', 'INSERT', 'UPDATE(serial,host,updated_at,unlinked_at)'],
    commerce_kiosk_terminal_attempts: [
      'SELECT',
      'INSERT',
      'UPDATE(state,process_id,transaction_id,incident,resolved_at)',
    ],
    commerce_kiosk_terminal_events: ['SELECT', 'INSERT'],
    commerce_provider_inbox: ['SELECT', 'INSERT'],
    commerce_captures: ['INSERT'],
    commerce_reconciliation_issues: ['INSERT'],
    commerce_fiscal_documents: ['INSERT'],
    commerce_payment_attempts: ['UPDATE(state)'],
    commerce_outbox: ['UPDATE(acknowledged_at)'],
  });
}

/** Reset SQL for `role` (module comment). */
export function kioskTerminalGrants(role, enabled, schema = 'public') {
  if (typeof role !== 'string' || !NAME.test(role) || !NAME.test(schema))
    throw new Error('Invalid kiosk terminal grants');
  const privileges = kioskTerminalPrivileges(enabled);
  const r = `"${role}"`,
    t = (name) => `"${schema}"."${name}"`;
  const revoke = TERMINAL_TABLES.map((name) => `REVOKE ALL ON ${t(name)} FROM ${r};`).join(' ');
  const grant = Object.entries(privileges)
    .map(([name, list]) => `GRANT ${list.join(', ')} ON ${t(name)} TO ${r};`)
    .join(' ');
  return (
    `DO $kiosk_terminal$ BEGIN IF to_regclass('${schema}.commerce_kiosk_terminal_events') IS NOT NULL THEN ` +
    revoke +
    (grant ? ' ' + grant : '') +
    ` END IF; END $kiosk_terminal$;`
  );
}
