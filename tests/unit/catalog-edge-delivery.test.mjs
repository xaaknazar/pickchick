/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  catalogAdminOptions,
  CatalogAdminError,
  CatalogErrorReasonSchema,
  assertCatalogPublishable,
} from '../../packages/catalog-admin/dist/index.js';
import {
  catalogAccessGrants,
  edgeMenuStateGrants,
} from '../../infra/staging/catalog-edge-grants.mjs';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';

const branch = '10000000-0000-4000-a000-000000000002';

test('role enforcement and kiosk support are opt-in and strictly parsed', () => {
  assert.equal(catalogAdminOptions({}).enforceRoles, undefined);
  assert.equal(catalogAdminOptions({}).kioskBranchId, undefined);
  assert.equal(catalogAdminOptions({ CATALOG_ACCESS_ROLES_ENABLED: 'true' }).enforceRoles, true);
  assert.equal(
    catalogAdminOptions({ CATALOG_ACCESS_ROLES_ENABLED: 'false' }).enforceRoles,
    undefined,
  );
  for (const value of ['1', 'TRUE', 'yes', ''])
    assert.throws(
      () => catalogAdminOptions({ CATALOG_ACCESS_ROLES_ENABLED: value }),
      /CATALOG_ACCESS_ROLES_CONFIGURATION_INVALID/,
    );
  assert.equal(
    catalogAdminOptions({ KIOSK_CHECKOUT_ENABLED: 'true', KIOSK_CHECKOUT_BRANCH_ID: branch })
      .kioskBranchId,
    branch,
  );
  for (const env of [
    { KIOSK_CHECKOUT_BRANCH_ID: branch },
    { KIOSK_CHECKOUT_ENABLED: 'false', KIOSK_CHECKOUT_BRANCH_ID: branch },
    { KIOSK_CHECKOUT_ENABLED: 'true', KIOSK_CHECKOUT_BRANCH_ID: 'not-a-uuid' },
  ])
    assert.equal(catalogAdminOptions(env).kioskBranchId, undefined);
});

test('channel price refusal carries a precise reason and keeps the CONFLICT status class', () => {
  const payload = structuredClone(mockupCatalogDraft);
  payload.products[0].channel_prices_minor = { pos: '100' };
  assert.throws(
    () => assertCatalogPublishable(payload),
    (e) =>
      e instanceof CatalogAdminError &&
      e.code === 'CONFLICT' &&
      e.reason === 'CHANNEL_PRICES_NOT_SUPPORTED' &&
      e.message === 'CONFLICT',
  );
  assert.equal(new CatalogAdminError('FORBIDDEN').reason, undefined);
  assert.deepEqual(CatalogErrorReasonSchema.options, [
    'CHANNEL_PRICES_NOT_SUPPORTED',
    'UNAVAILABLE_LINKED_PRODUCT',
    'EDGE_DEVICE_INACTIVE',
    'EDGE_MENU_STATE_UNKNOWN',
    'ASSET_MISSING',
    'ASSET_UNSUPPORTED_TYPE',
    'ASSET_TOO_LARGE',
    'ASSET_INVALID_IMAGE',
    'ASSET_RATE_LIMITED',
  ]);
});

test('edge state grants never allow rewriting identity, deleting or rewriting verdicts', () => {
  const sql = edgeMenuStateGrants('api_runtime');
  assert.match(
    sql,
    /GRANT SELECT,INSERT ON edge_menu_state,catalog_menu_delivery_results TO api_runtime;/,
  );
  assert.match(
    sql,
    /GRANT UPDATE\(active_release_id,active_version,observed_at\) ON edge_menu_state TO api_runtime;/,
  );
  assert.doesNotMatch(
    sql,
    /UPDATE ON|UPDATE\([^)]*(device_id|branch_id)|DELETE|TRUNCATE|REFERENCES|GRANT ALL|WITH GRANT OPTION|catalog_menu_delivery_results TO[^;]*UPDATE/,
  );
  assert.equal(catalogAccessGrants('api_runtime', false), '');
  const access = catalogAccessGrants('api_runtime', true);
  assert.match(access, /GRANT SELECT ON bo_access_grants TO api_runtime;/);
  assert.match(access, /GRANT UPDATE\(lock_anchor\) ON bo_access_grants TO api_runtime;/);
  assert.doesNotMatch(access, /INSERT|DELETE|UPDATE ON|UPDATE\(role|REVOKE/);
  for (const role of ['', 'Role', 'x;DROP ROLE api', 'a'.repeat(64), null, '1api']) {
    assert.throws(() => edgeMenuStateGrants(role));
    assert.throws(() => catalogAccessGrants(role, true));
  }
  for (const enabled of [undefined, null, 'true', 1])
    assert.throws(() => catalogAccessGrants('runtime', enabled));
  const provision = readFileSync(
    new URL('../../infra/staging/provision.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(
    provision.indexOf('catalogAccessGrants(') > provision.indexOf('backofficeGrants('),
    'catalog access must be granted after the back-office revoke',
  );
  assert.ok(provision.includes("edgeMenuStateGrants('pickchick_app')"));
});

test('migration 047 keeps edge verdicts append-only and edge state device-bound', () => {
  const sql = readFileSync(
    new URL('../../db/cloud/migrations/047_cloud_edge_menu_state.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /FOREIGN KEY\(device_id,branch_id\) REFERENCES devices\(id,branch_id\)/);
  assert.match(sql, /active_version integer NOT NULL CHECK\(active_version > 0\)/);
  assert.match(sql, /CHECK\(\(result = 'rejected'\) = \(reason IS NOT NULL\)\)/);
  assert.match(
    sql,
    /BEFORE UPDATE OR DELETE ON catalog_menu_delivery_results\s+FOR EACH ROW EXECUTE FUNCTION catalog_reject_mutation\(\)/,
  );
});
