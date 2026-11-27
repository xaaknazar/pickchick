/**
 * Cloud Webkassa worker (services/api/src/webkassa-worker.ts, commerce-core webkassa-cloud.ts):
 * rights of its dedicated role, audit 26.11 P0-1. The worker reads the fiscal queue, leases and
 * acknowledges its outbox events, records a fiscal observation (provider inbox, fiscal effect,
 * document state, the fiscal.issued event that lets the kitchen admit the order) and keeps the data
 * of each issued sale receipt that a refund receipt must name (cloud 083). The order recompute of
 * an observation re-states the payment intent state and re-inserts (ON CONFLICT, guarded by
 * commerce_fiscal_insert_guard) the sale document, so those two rights are needed as well. It
 * never writes captures, refunds or prices.
 *
 * With `enabled` false the SQL revokes everything it granted.
 */
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const READ = `branches,commerce_quotes,commerce_orders,commerce_provider_accounts,
  commerce_payment_intents,commerce_payment_attempts,commerce_captures,commerce_refunds,
  commerce_refund_effects,commerce_fiscal_documents,commerce_fiscal_effects,
  commerce_provider_inbox,commerce_reconciliation_issues,commerce_outbox,
  commerce_cancellation_intents,cloud_fulfillment_projection,cloud_branch_availability,
  fulfillment_transport_bindings,devices,commerce_webkassa_receipts`;
const INSERT = `commerce_provider_inbox,commerce_fiscal_documents,commerce_fiscal_effects,commerce_reconciliation_issues,
  commerce_outbox,commerce_webkassa_receipts`;
const ORDER_UPDATE = 'state,version,updated_at,attention_required,kitchen_effect_id';
const LEASE = 'lease_worker,lease_token,lease_until,attempts,acknowledged_at';

export function webkassaWorkerGrants(role, enabled) {
  if (typeof role !== 'string' || !NAME.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid Webkassa grants');
  return (
    `REVOKE ALL ON ${READ.replace(/\s+/g, '')} FROM ${role};
    REVOKE UPDATE(${ORDER_UPDATE}) ON commerce_orders FROM ${role};
    REVOKE UPDATE(state) ON commerce_fiscal_documents,commerce_payment_intents FROM ${role};
    REVOKE UPDATE(${LEASE}) ON commerce_outbox FROM ${role};
    REVOKE ALL ON SEQUENCE commerce_outbox_sequence_seq FROM ${role};` +
    (enabled
      ? `
    GRANT SELECT ON ${READ} TO ${role};
    GRANT INSERT ON ${INSERT} TO ${role};
    GRANT UPDATE(${ORDER_UPDATE}) ON commerce_orders TO ${role};
    GRANT UPDATE(state) ON commerce_fiscal_documents,commerce_payment_intents TO ${role};
    GRANT UPDATE(${LEASE}) ON commerce_outbox TO ${role};
    GRANT USAGE ON SEQUENCE commerce_outbox_sequence_seq TO ${role};`
      : '')
  );
}
