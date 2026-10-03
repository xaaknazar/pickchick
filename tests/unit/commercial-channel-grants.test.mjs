import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  catalogEdgePublicationGrants,
  kioskCheckoutGrants,
  kioskWorkerGrants,
} from '../../infra/staging/commercial-channel-grants.mjs';
import { customerCheckoutGrants } from '../../infra/staging/checkout-grants.mjs';
import { orderRecipeGrants } from '../../infra/staging/backoffice-grants.mjs';
const helpers = [catalogEdgePublicationGrants, kioskCheckoutGrants, kioskWorkerGrants];
test('commercial helpers require explicit boolean and safe exact role identifiers', () => {
  for (const helper of helpers) {
    for (const role of ['api_runtime', 'a'.repeat(63)])
      assert.match(helper(role, true), new RegExp(`TO ${role};`));
    for (const role of [
      '',
      null,
      undefined,
      {},
      'Role',
      'x;DROP ROLE api',
      'x y',
      'x"',
      'a'.repeat(64),
      '1api',
    ])
      assert.throws(() => helper(role, true));
    for (const enabled of [undefined, null, 'true', 0, 1])
      assert.throws(() => helper('runtime', enabled));
  }
});
test('catalog publication adds only menu transport writes and inert branch lock', () => {
  const sql = catalogEdgePublicationGrants('runtime', true);
  assert.match(
    sql,
    /SELECT,INSERT ON catalog_menu_deliveries,menu_releases,menu_streams,outbox_events/,
  );
  assert.match(sql, /UPDATE\(last_sequence\) ON menu_streams/);
  assert.match(sql, /UPDATE\(menu_publication_lock_anchor\) ON branches/);
  assert.doesNotMatch(
    sql,
    /UPDATE ON|DELETE|TRUNCATE|REFERENCES|GRANT ALL|WITH GRANT OPTION|commerce_|device_credentials/,
  );
  const migration = readFileSync(
    new URL('../../db/cloud/migrations/034_cloud_catalog_menu_delivery.sql', import.meta.url),
    'utf8',
  );
  assert.match(
    migration,
    /menu_publication_lock_anchor boolean NOT NULL DEFAULT false\s+CHECK\(NOT menu_publication_lock_anchor\)/,
  );
});
test('kiosk checkout reuses guarded sales permissions without bank observation or device provisioning', () => {
  const sql = kioskCheckoutGrants('runtime', true);
  assert.ok(sql.includes(customerCheckoutGrants('runtime', true)));
  assert.ok(sql.includes(orderRecipeGrants('runtime')));
  assert.match(sql, /INSERT ON kiosk_sessions/);
  assert.match(sql, /UPDATE\(lock_anchor\) ON kiosk_devices/);
  assert.doesNotMatch(
    sql,
    /GRANT INSERT ON kiosk_devices|GRANT UPDATE\(active|GRANT UPDATE ON|GRANT INSERT[^;]*commerce_captures|GRANT INSERT[^;]*commerce_provider_inbox/,
  );
});
test('worker can read scoped recovery inputs and erase ciphertext, cannot create or end guest sessions', () => {
  const sql = kioskWorkerGrants('worker', true);
  assert.match(
    sql,
    /SELECT ON kiosk_sessions,commerce_orders,commerce_payment_attempts,commerce_kaspi_invoices/,
  );
  assert.match(sql, /GRANT UPDATE\(phone_ciphertext,phone_nonce,phone_tag\) ON kiosk_sessions/);
  assert.doesNotMatch(
    sql,
    /GRANT INSERT|ended_at|phone_expires_at|token_hash|kiosk_devices|GRANT UPDATE ON|commerce_captures/,
  );
});
test('disabled helpers revoke only dedicated new tables and their column privileges', () => {
  for (const helper of helpers) {
    const sql = helper('runtime', false);
    assert.doesNotMatch(sql, /GRANT /);
    const statements = sql
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean);
    for (const statement of statements)
      assert.match(
        statement,
        /^REVOKE (ALL|UPDATE\([a-z_,]+\)) ON (catalog_menu_deliveries|kiosk_devices(?:,kiosk_sessions)?|kiosk_sessions) FROM runtime$/,
      );
    assert.doesNotMatch(sql, /commerce_|menu_releases|menu_streams|outbox_events|branches/);
  }
});

test('both enabled channel helpers explicitly grant every delivery status join read', () => {
  const required = [
    'catalog_menu_deliveries',
    'menu_releases',
    'devices',
    'fulfillment_transport_bindings',
    'branch_menu_activations',
    'outbox_events',
    'inbox_messages',
  ];
  for (const helper of [catalogEdgePublicationGrants, kioskCheckoutGrants]) {
    const grants = [
      ...helper('runtime', true).matchAll(/GRANT SELECT(?:,INSERT)? ON ([^;]+?) TO runtime;/g),
    ]
      .map((match) => match[1].split(',').map((x) => x.trim()))
      .flat();
    for (const table of required)
      assert.ok(grants.includes(table), `${helper.name} lacks SELECT ${table}`);
  }
});
