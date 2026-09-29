import { orderRecipeGrants } from './backoffice-grants.mjs';

/**
 * API runtime privileges for the mobile Kaspi checkout (quote, order, invoice request,
 * read). No capture, refund, fiscal-result or provider-account write authority: money
 * is recorded only by the Kaspi worker through the provider inbox.
 */
export function customerCheckoutGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid customer checkout grants');
  const read =
    'branches, catalog_branch_heads, catalog_publications, commerce_provider_accounts, commerce_commands, commerce_quotes, commerce_orders, commerce_payment_intents, commerce_payment_attempts, commerce_captures, commerce_refunds, commerce_refund_effects, commerce_fiscal_documents, commerce_reconciliation_issues, commerce_cancellation_intents, commerce_outbox, commerce_kaspi_invoices, fulfillment_transport_bindings, cloud_fulfillment_projection';
  const insert =
    'commerce_commands, commerce_quotes, commerce_orders, commerce_payment_intents, commerce_payment_attempts, commerce_outbox';
  const orderColumns = 'state,version,updated_at,kitchen_effect_id';
  // Only checkout-exclusive privileges are revoked when disabled: the same runtime role
  // may hold shared commerce privileges from the transport and backoffice helpers.
  const exclusive =
    'commerce_quotes, commerce_orders, commerce_payment_intents, commerce_payment_attempts';
  return (
    `REVOKE INSERT ON ${exclusive} FROM ${role};` +
    (enabled
      ? `
    GRANT SELECT ON ${read} TO ${role};
    GRANT INSERT ON ${insert} TO ${role};
    -- FOR UPDATE/SHARE row locks and reconcile(); not admission, capture or refund columns.
    GRANT UPDATE(${orderColumns}) ON commerce_orders TO ${role};
    GRANT UPDATE(state) ON commerce_payment_intents TO ${role};
    GRANT UPDATE(lock_anchor) ON catalog_branch_heads TO ${role};
    GRANT UPDATE(lock_anchor) ON fulfillment_transport_bindings TO ${role};
    GRANT USAGE ON SEQUENCE commerce_outbox_sequence_seq TO ${role};
    ${orderRecipeGrants(role)}`
      : '')
  );
}
