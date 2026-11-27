/**
 * Cloud schema082 (TipTopPay LIVE checkout, tiptoppay-checkout.ts): rights for
 * TIPTOPPAY_CHECKOUT_ENABLED=true. Apply after checkout-grants.mjs (customerCheckoutGrants).
 *
 * The bank's answer arrives in the API itself (the charge / post3ds answer and the signed
 * Pay / Fail notifications), so the API role gets the same bank observation rights the Kaspi
 * worker role has (kaspiWorkerGrants: inbox, captures, attempt state, outbox), plus the
 * TipTopPay session rows. The TipTopPay worker role (tiptoppay-worker.ts) gets the same and the
 * refund observation rights (refund effects, refund state). Card data is never stored anywhere.
 *
 * With `enabled` false the API SQL revokes only the TipTopPay table rights (the shared money rights
 * belong to other grant modules too); the worker SQL revokes everything it granted.
 */
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const OBSERVE_INSERT =
  'commerce_captures,commerce_provider_inbox,commerce_reconciliation_issues,commerce_outbox';
const SESSIONS = 'commerce_tiptoppay_sessions';
const SESSION_UPDATE = 'authorized_operation_id,next_check_at,reconcile_attempts,last_reconcile_at';
const READ = `branches,commerce_quotes,commerce_orders,commerce_provider_accounts,
  commerce_payment_intents,commerce_payment_attempts,commerce_captures,commerce_refunds,
  commerce_refund_effects,commerce_fiscal_documents,commerce_fiscal_effects,
  commerce_provider_inbox,commerce_reconciliation_issues,commerce_outbox,
  commerce_cancellation_intents,cloud_fulfillment_projection,cloud_branch_availability,
  fulfillment_transport_bindings,devices,commerce_checkout_payment_methods,${SESSIONS}`;

function check(role, enabled) {
  if (typeof role !== 'string' || !NAME.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid TipTopPay grants');
}
function common(role) {
  return `
    GRANT SELECT ON ${READ} TO ${role};
    GRANT INSERT ON ${OBSERVE_INSERT} TO ${role};
    GRANT UPDATE(state,version,updated_at,attention_required,kitchen_effect_id) ON commerce_orders TO ${role};
    GRANT UPDATE(state) ON commerce_payment_intents,commerce_payment_attempts TO ${role};
    GRANT UPDATE(lease_worker,lease_token,lease_until,attempts,acknowledged_at) ON commerce_outbox TO ${role};
    GRANT UPDATE(${SESSION_UPDATE}) ON ${SESSIONS} TO ${role};
    GRANT USAGE ON SEQUENCE commerce_outbox_sequence_seq TO ${role};`;
}

/** The API role: charge, 3-D Secure and the signed notifications (module comment). */
export function tipTopPayApiGrants(role, enabled) {
  check(role, enabled);
  return (
    // Only the TipTopPay tables are revoked: the shared money rights also serve the kiosk
    // terminal and the cloud kitchen transport (their own grant modules own them).
    `REVOKE INSERT,UPDATE ON ${SESSIONS},commerce_checkout_payment_methods FROM ${role};` +
    (enabled
      ? common(role) +
        `
    GRANT INSERT(attempt_id,order_id,token_hash,expires_at,opened_at,method,next_check_at) ON ${SESSIONS} TO ${role};
    GRANT INSERT(order_id,method,locked_at),UPDATE(method,locked_at,updated_at) ON commerce_checkout_payment_methods TO ${role};`
      : '')
  );
}

/** The dedicated worker role: reconciliation and refunds (module comment). */
export function tipTopPayWorkerGrants(role, enabled) {
  check(role, enabled);
  return (
    `REVOKE ALL ON ${READ.replace(/\s+/g, '')} FROM ${role};
    REVOKE UPDATE(state,version,updated_at,attention_required,kitchen_effect_id) ON commerce_orders FROM ${role};
    REVOKE UPDATE(state) ON commerce_payment_intents,commerce_payment_attempts,commerce_refunds FROM ${role};
    REVOKE UPDATE(lease_worker,lease_token,lease_until,attempts,acknowledged_at) ON commerce_outbox FROM ${role};
    REVOKE UPDATE(${SESSION_UPDATE}) ON ${SESSIONS} FROM ${role};
    REVOKE ALL ON SEQUENCE commerce_outbox_sequence_seq FROM ${role};` +
    (enabled
      ? common(role) +
        `
    GRANT INSERT ON commerce_refund_effects TO ${role};
    GRANT UPDATE(state) ON commerce_refunds TO ${role};`
      : '')
  );
}
