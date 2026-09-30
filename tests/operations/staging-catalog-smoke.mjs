/** Run inside the isolated staging provision container; never loads a private host .env. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { provisionCatalogManager, revokeCatalogManager } from '@pickchick/catalog-admin';

let check = 'configuration';
const phase = process.env.PICKCHICK_SMOKE_PHASE;
const ids = Object.fromEntries(
  ['ORG', 'LEGAL', 'BRANCH', 'OTHER'].map((k) => [
    k.toLowerCase(),
    process.env['PICKCHICK_SMOKE_' + k],
  ]),
);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const result = { event: 'staging_catalog_smoke', phase, checks: [] };
function passed(name) {
  result.checks.push(name);
}
async function main() {
  assert.equal(process.env.PICKCHICK_ISOLATED_REHEARSAL, 'true');
  assert.ok(['setup', 'flow', 'verify', 'grants', 'grants-on', 'grants-rollback'].includes(phase));
  assert.ok(Object.values(ids).every((id) => uuid.test(id ?? '')));
  const config = loadConfig('api');
  assert.equal(config.environment, 'staging');
  assert.equal(config.catalogAdminEnabled, true);
  assert.equal(config.customerAuthEnabled === true, false);
  assert.equal(config.testOrderFlowEnabled, false);
  const url = new URL(config.databaseUrl);
  assert.equal(url.hostname, 'cloud-db');
  assert.equal(url.username, 'pickchick_owner');
  const owner = createPool(url.href, 2);
  url.username = 'pickchick_app';
  url.password = process.env.DB_APP_PASSWORD;
  const runtime = createPool(url.href, 2);
  const request = async (path, { method = 'GET', body, token, gateway = false } = {}) => {
    const response = await fetch((gateway ? 'http://gateway:8080' : 'http://api:3100') + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    return { status: response.status, data, headers: response.headers, raw };
  };
  let manager;
  try {
    if (phase === 'setup') {
      check = 'seed-owned-records';
      await owner.query(
        "INSERT INTO organizations(id,name) VALUES($1,'Isolated deployment rehearsal')",
        [ids.org],
      );
      await owner.query(
        "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
        [ids.legal, ids.org],
      );
      for (const [id, code] of [
        [ids.branch, 'REHEARSAL'],
        [ids.other, 'UNASSIGNED'],
      ])
        await owner.query(
          "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,$4,'Synthetic rehearsal')",
          [id, ids.org, ids.legal, code],
        );
      const hash = createHash('sha256').update(ids.org).digest('hex');
      for (const hours of [2, 25])
        await owner.query(
          "INSERT INTO identity_otp_challenges(id,request_id,phone_lookup,phone_cipher,device_hash,ip_hash,code_hash,state,created_at,expires_at,response_cipher,verify_input_hash,initial_refresh_hash,receipt_expires_at) VALUES($1,$2,$3,'synthetic-private-fixture',$3,$3,$3,'expired',clock_timestamp()-$4*interval '1 hour',clock_timestamp()-interval '1 hour','synthetic-receipt',$3,$3,clock_timestamp()-interval '1 minute')",
          [randomUUID(), randomUUID(), hash, hours],
        );
      passed('owned_synthetic_seed');
    } else if (phase === 'grants-rollback') {
      check = 'existing-test-grants';
      const snapshot = async () => ({
        tables: (
          await owner.query(`SELECT relname, relacl::text FROM pg_class
            WHERE relnamespace='public'::regnamespace AND relname LIKE 'test_%'
            AND relkind IN ('r','S') ORDER BY relname`)
        ).rows,
        columns: (
          await owner.query(`SELECT c.relname,a.attname,a.attacl::text FROM pg_attribute a
            JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace
            AND c.relname LIKE 'test_%' AND a.attnum>0 AND NOT a.attisdropped
            ORDER BY c.relname,a.attnum`)
        ).rows,
      });
      const baseline = await snapshot();
      assert.equal((await runtime.query('SELECT count(*) AS n FROM test_orders')).rows[0].n, '0');
      const provision = () =>
        promisify(execFile)(process.execPath, ['infra/staging/provision.mjs'], {
          cwd: '/app',
          env: process.env,
          timeout: 60000,
          maxBuffer: 16384,
        });
      let renamed = false;
      try {
        check = 'inject-missing-catalog-lock-column';
        await owner.query(
          'ALTER TABLE catalog_managers RENAME COLUMN lock_anchor TO rehearsal_missing_lock_anchor',
        );
        renamed = true;
        check = 'failed-provision-keeps-old-test-grants';
        await assert.rejects(provision(), (error) => {
          assert.equal(error.code, 1);
          assert.equal(error.stdout, '');
          assert.deepEqual(JSON.parse(error.stderr), { event: 'staging_provision_failed' });
          return true;
        });
        assert.deepEqual(await snapshot(), baseline);
        assert.equal((await runtime.query('SELECT count(*) AS n FROM test_orders')).rows[0].n, '0');
        passed('failed_optional_catalog_grant_rolls_back_all_test_acls');
      } finally {
        if (renamed)
          await owner.query(
            'ALTER TABLE catalog_managers RENAME COLUMN rehearsal_missing_lock_anchor TO lock_anchor',
          );
      }
      check = 'provision-retry-after-schema-restored';
      const retry = await provision();
      assert.equal(retry.stderr, '');
      assert.deepEqual(JSON.parse(retry.stdout), { event: 'staging_provisioned', applied: [] });
      await assert.rejects(runtime.query('SELECT * FROM test_orders'), { code: '42501' });
      assert.equal(
        (
          await owner.query(
            "SELECT has_sequence_privilege('pickchick_app','test_orders_sequence_seq','USAGE') AS allowed",
          )
        ).rows[0].allowed,
        false,
      );
      passed('restored_schema_retry_applies_test_disable');
    } else if (phase === 'grants' || phase === 'grants-on') {
      check = 'test-column-privileges-after-disable';
      const columns = [
        ['test_flow_lock', 'id'],
        ['test_actors', 'expires_at'],
        ...[
          'version',
          'state',
          'payment_state',
          'payment_attempt_id',
          'cancellation_reason',
          'updated_at',
        ].map((c) => ['test_orders', c]),
        ['test_kitchen_tasks', 'state'],
      ];
      const residual = [];
      for (const [table, column] of columns) {
        const allowed = (
          await owner.query(
            "SELECT has_column_privilege('pickchick_app',$1,$2,'UPDATE') AS allowed",
            [table, column],
          )
        ).rows[0].allowed;
        if (allowed) residual.push(table + '.' + column);
      }
      if (phase === 'grants-on') {
        assert.deepEqual(
          residual,
          columns.map(([t, c]) => t + '.' + c),
        );
        passed('test_columns_granted');
      } else {
        if (residual.length)
          console.log(JSON.stringify({ event: 'staging_privilege_residual', columns: residual }));
        assert.deepEqual(residual, []);
        passed('test_columns_revoked');
      }
    } else {
      check = 'readiness';
      const ready = await request('/health/ready');
      assert.equal(ready.status, 200);
      assert.equal(ready.data.degraded, false);
      passed('api_database_schema_redis_ready');
      check = 'feature_gates';
      const caps = (await request('/v1/capabilities')).data;
      assert.equal(caps.ordering_enabled, false);
      for (const flag of [
        'phone_auth',
        'checkout',
        'payments',
        'fiscal',
        'loyalty',
        'test_order_flow',
      ])
        assert.equal(caps.features[flag], false);
      for (const gateway of [false, true]) {
        assert.equal((await request('/v1/admin/catalog/branches', { gateway })).status, 401);
        for (const path of [
          '/v1/quotes',
          '/v1/orders',
          '/v1/admin/catalog/managers',
          '/v1/admin/catalog/credential',
        ])
          assert.equal((await request(path, { method: 'POST', body: {}, gateway })).status, 404);
      }
      assert.equal(
        (await request('/v1/auth/otp/request', { method: 'POST', body: {}, gateway: true })).status,
        404,
      );
      passed('no_public_credential_or_real_checkout_issuance');
      check = 'runtime_sql_denials';
      for (const sql of [
        'CREATE TABLE unauthorized(id int)',
        'DELETE FROM schema_migrations',
        'SELECT phone_cipher FROM identity_customers',
        'SELECT token_hash FROM test_actors',
        "UPDATE catalog_managers SET token_hash=repeat('a',64)",
        'UPDATE catalog_manager_branches SET actor_id=actor_id',
        'DELETE FROM catalog_publications',
        'UPDATE branches SET ordering_enabled=true',
        'SELECT * FROM commerce_orders',
        'SELECT * FROM loyalty_wallets',
      ])
        await assert.rejects(runtime.query(sql), { code: '42501' });
      passed('restricted_runtime_sql');
      check = 'provision_manager_owner_only';
      manager = await provisionCatalogManager(owner, {
        organization_id: ids.org,
        name: 'Synthetic rehearsal manager',
        branch_ids: [ids.branch],
      });
      await assert.rejects(
        runtime.query('UPDATE catalog_managers SET lock_anchor=false'),
        (error) => error.code === '23514',
      );
      for (const gateway of [false, true]) {
        const list = await request('/v1/admin/catalog/branches', { token: manager.token, gateway });
        assert.equal(list.status, 200);
        assert.deepEqual(
          list.data.branches.map((b) => b.id),
          [ids.branch],
        );
        assert.equal(
          (
            await request('/v1/admin/catalog/branches/' + ids.other, {
              token: manager.token,
              gateway,
            })
          ).status,
          403,
        );
      }
      const path = '/v1/admin/catalog/branches/' + ids.branch;
      const send = async (suffix, body, method = 'POST') => {
        const response = await request(path + suffix, {
          token: manager.token,
          method,
          body,
          gateway: true,
        });
        assert.equal(response.status, 200);
        return response.data;
      };
      if (phase === 'flow') {
        check = 'catalog_draft_and_publication';
        assert.equal(
          (await request('/v1/catalog/branches/' + ids.branch, { gateway: true })).status,
          404,
        );
        let state = await send('/draft/seed', { expected_revision: 0, request_id: randomUUID() });
        assert.equal(state.draft.payload.products.length, 24);
        assert.equal(
          (
            await request(path + '/publish', {
              gateway: true,
              token: manager.token,
              method: 'POST',
              body: {
                expected_revision: state.draft.revision,
                expected_published_version: 0,
                request_id: randomUUID(),
                confirmation: 'publish_catalog',
              },
            })
          ).status,
          409,
        );
        const payload = globalThis.structuredClone(state.draft.payload);
        payload.content_reviewed = true;
        payload.products[0].price_minor = '500000';
        state = await send(
          '/draft',
          { expected_revision: state.draft.revision, request_id: randomUUID(), payload },
          'PUT',
        );
        const command = {
          expected_revision: state.draft.revision,
          expected_published_version: 0,
          request_id: randomUUID(),
          confirmation: 'publish_catalog',
        };
        state = await send('/publish', command);
        assert.deepEqual(await send('/publish', command), state);
        assert.equal(state.published.version, 1);
        const edited = globalThis.structuredClone(state.draft.payload);
        edited.products[0].price_minor = '501000';
        state = await send(
          '/draft',
          { expected_revision: state.draft.revision, request_id: randomUUID(), payload: edited },
          'PUT',
        );
        assert.equal(state.draft.payload.products[0].price_minor, '501000');
        passed('real_controller_seed_edit_publish_replay');
      }
      check = 'persisted_catalog_and_public_gateway';
      for (const gateway of [false, true]) {
        const pub = await request('/v1/catalog/branches/' + ids.branch, { gateway });
        assert.equal(pub.status, 200);
        assert.equal(pub.data.payload.products[0].price_minor, '500000');
        assert.equal(pub.data.version, 1);
        if (gateway) assert.equal(pub.headers.get('x-pickchick-data'), 'catalog');
      }
      const current = await request(path, { gateway: true, token: manager.token });
      assert.equal(current.data.draft.payload.products[0].price_minor, '501000');
      assert.equal(current.data.published.payload.products[0].price_minor, '500000');
      assert.equal((await request('/backoffice', { gateway: true })).status, 308);
      const editor = await request('/backoffice/', { gateway: true });
      assert.equal(editor.status, 200);
      assert.match(editor.raw, /<html/i);
      assert.equal(editor.headers.get('x-pickchick-data'), 'catalog');
      for (const asset of ['/backoffice/app.js', '/backoffice/styles.css'])
        assert.equal((await request(asset, { gateway: true })).status, 200);
      passed('gateway_editor_and_published_snapshot');
      assert.equal(
        (await owner.query('SELECT ordering_enabled FROM branches WHERE id=$1', [ids.branch]))
          .rows[0].ordering_enabled,
        false,
      );
      check = 'no_test_or_financial_side_effects';
      for (const table of [
        'test_actors',
        'test_orders',
        'commerce_orders',
        'commerce_captures',
        'loyalty_ledger',
      ])
        assert.equal((await owner.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n, '0');
      passed('no_test_or_money_effects');
      if (phase === 'verify') {
        check = 'owner_cleanup';
        const hash = createHash('sha256').update(ids.org).digest('hex');
        const rows = (
          await owner.query(
            'SELECT phone_cipher,code_hash,response_cipher,verify_input_hash,initial_refresh_hash FROM identity_otp_challenges WHERE phone_lookup=$1',
            [hash],
          )
        ).rows;
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0], {
          phone_cipher: null,
          code_hash: null,
          response_cipher: null,
          verify_input_hash: null,
          initial_refresh_hash: null,
        });
        assert.equal(
          (await owner.query('SELECT count(*) AS n FROM identity_otp_request_tombstones')).rows[0]
            .n,
          '1',
        );
        passed('owner_cleanup_secret_scrub_and_tombstone');
        passed('restart_persistence');
      }
      check = 'manager_revocation';
      await revokeCatalogManager(owner, manager.actor_id);
      assert.equal((await request(path, { gateway: true, token: manager.token })).status, 401);
      manager = null;
      passed('manager_revoked');
    }
    console.log(JSON.stringify({ ...result, status: 'passed' }));
  } finally {
    if (manager) await revokeCatalogManager(owner, manager.actor_id);
    await owner.end();
    await runtime.end();
  }
}
main().catch(() => {
  console.error(JSON.stringify({ ...result, status: 'failed', check }));
  process.exitCode = 1;
});
