import { pathToFileURL } from 'node:url';
import { createPool } from '@pickchick/database';
import { createCustomerIdentityOptions } from '@pickchick/customer-identity';
import { createPhoneCodeDelivery, phoneDeliveryChannels } from '@pickchick/phone-verification';
import { customerCheckoutOptions, CustomerCheckout } from '../packages/commerce-core/dist/index.js';

/** Trusted operator diagnostic. Read-only SQL; no bank/OTP calls and no PII in the report. */
export async function customerCommerceReadiness(pool, env) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN READ ONLY');
    await db.query("SET LOCAL statement_timeout='10s'");
    const identity = createCustomerIdentityOptions(env);
    const channels = phoneDeliveryChannels(createPhoneCodeDelivery(env));
    const options = customerCheckoutOptions(env);
    const {
      rows: [counts],
    } = await db.query(`SELECT
      (SELECT count(*)::int FROM identity_customers WHERE deleted_at IS NULL) customers,
      (SELECT count(*)::int FROM identity_sessions WHERE revoked_at IS NULL) sessions,
      (SELECT count(*)::int FROM catalog_publications) catalog_publications,
      (SELECT count(*)::int FROM commerce_provider_accounts WHERE kind='payment' AND provider='kaspi-remote' AND enabled) kaspi_accounts,
      (SELECT count(*)::int FROM fulfillment_transport_bindings WHERE active) edge_bindings,
      (SELECT count(*)::int FROM commerce_orders) orders,
      (SELECT count(*)::int FROM commerce_kaspi_invoices) invoices,
      (SELECT count(*)::int FROM commerce_kaspi_invoices WHERE state='unknown' AND issue_started_at<clock_timestamp()-interval '5 minutes') overdue_unknown_invoices`);
    let scopedConfiguration = false,
      registeredPilotCustomers = false;
    if (options) {
      const result = await db.query(
        'SELECT count(*)::int n FROM identity_customers WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL',
        [options.customerIds],
      );
      registeredPilotCustomers = result.rows[0].n === new Set(options.customerIds).size;
      // Use the same merchant/catalog/device admission predicate as checkout, on this read-only connection.
      const checkout = new CustomerCheckout({ query: (...args) => db.query(...args) }, options);
      scopedConfiguration = (await checkout.config(options.customerIds[0])).enabled;
    }
    const checks = {
      identity_enabled: identity.enabled,
      telegram_configured: channels.includes('telegram'),
      pilot_configured: options !== null,
      pilot_customers_registered: registeredPilotCustomers,
      merchant_catalog_device_configured: scopedConfiguration,
      no_overdue_unknown_invoices: counts.overdue_unknown_invoices === 0,
    };
    await db.query('COMMIT');
    return {
      checkedAt: new Date().toISOString(),
      checks,
      counts,
      blockers: Object.keys(checks).filter((key) => !checks[key]),
      configurationReady: Object.values(checks).every(Boolean),
      // A configured database is not evidence that a bank or physical kitchen is reachable.
      bankSessionVerified: false,
      kitchenReachabilityVerified: false,
      realPaymentVerified: false,
      invoicesIssuedByCheck: 0,
      otpSentByCheck: 0,
    };
  } finally {
    await db.query('ROLLBACK').catch(() => undefined);
    db.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool;
  try {
    if (!process.env.CLOUD_DATABASE_URL) throw new Error('Missing operator database configuration');
    pool = createPool(process.env.CLOUD_DATABASE_URL, 1);
    const report = await customerCommerceReadiness(pool, process.env);
    console.log(JSON.stringify(report));
    process.exitCode = report.configurationReady ? 0 : 2;
  } catch {
    console.error(
      JSON.stringify({ event: 'customer_commerce_readiness_failed', detailsRedacted: true }),
    );
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
