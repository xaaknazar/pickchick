import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { allowed } from '../../apps/backoffice/server.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { designateBackoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';

/**
 * Cutover CC-5/CC-6 over HTTP: the API routes, the operator proxy allowlist and the flags.
 * GET .../ops/<view> is the only new read path (contracts 5.10); writes stay POST .../commands.
 */
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date());
const opsPath = (branch, query) =>
  `/v1/admin/backoffice/branches/${branch}/ops/stock?${new URLSearchParams(query)}`;

test('operator proxy allowlist: only ops/stock with view and a date window', () => {
  const branch = randomUUID();
  const base = `/v1/admin/backoffice/branches/${branch}/ops`;
  const ok = (q) => allowed('GET', `${base}/stock?${q}`);
  assert.equal(ok('view=waste&start_date=2026-11-19&end_date=2026-11-19'), true);
  assert.equal(ok('view=movement&start_date=2026-11-01&end_date=2026-11-30'), true);
  for (const q of [
    'view=consumption&start_date=2026-11-19&end_date=2026-11-19',
    'view=waste&start_date=2026-11-19',
    'view=waste&start_date=2026-11-19&end_date=2026-11-19&token=x',
    'view=waste&view=waste&start_date=2026-11-19&end_date=2026-11-19',
    'view=waste&start_date=19.11.2026&end_date=2026-11-19',
  ])
    assert.equal(ok(q), false, q);
  assert.equal(allowed('GET', `${base}/stock`), false);
  assert.equal(allowed('POST', `${base}/stock`), false);
  assert.equal(allowed('GET', `${base}/sales?start_date=2026-11-19&end_date=2026-11-19`), true);
  assert.equal(allowed('GET', `${base}/stock/extra?view=waste`), false);
  // The routes of today are unchanged.
  assert.equal(allowed('GET', `/v1/admin/backoffice/branches/${branch}?period=day`), true);
  assert.equal(allowed('POST', `/v1/admin/backoffice/branches/${branch}/commands`), true);
});

test('operator proxy allowlist: ops/sales takes exactly a start and an end date', () => {
  const branch = randomUUID();
  const ok = (q) => allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/sales?${q}`);
  assert.equal(ok('start_date=2026-11-19&end_date=2026-11-19'), true);
  assert.equal(ok('end_date=2026-11-30&start_date=2026-11-01'), true);
  for (const q of [
    'start_date=2026-11-19',
    'start_date=2026-11-19&end_date=2026-11-19&view=sales',
    'start_date=2026-11-19&start_date=2026-11-19&end_date=2026-11-19',
    'start_date=19.11.2026&end_date=2026-11-19',
    'start_date=2026-11-19&end_date=2026-11-19&format=csv',
  ])
    assert.equal(ok(q), false, q);
  assert.equal(allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/sales`), false);
  assert.equal(allowed('POST', `/v1/admin/backoffice/branches/${branch}/ops/sales`), false);
});

test('flags off: ops/stock answers 404 STOCK_V2_DISABLED, v2 fields 409, read keeps its keys', () =>
  withCatalog(async (c) => {
    const headers = {
      Authorization: 'Bearer ' + c.manager.token,
      'Content-Type': 'application/json',
    };
    const query = { view: 'waste', start_date: today(), end_date: today() };
    assert.equal((await fetch(c.url + opsPath(c.branch, query))).status, 401);
    const disabled = await fetch(c.url + opsPath(c.branch, query), { headers });
    assert.equal(disabled.status, 404);
    const body = await disabled.json();
    assert.equal(body.code, 'NOT_FOUND');
    assert.deepEqual(body.error, { code: 'STOCK_V2_DISABLED' });
    // The proxy refuses what it does not know before the API sees it.
    const blocked = await fetch(c.url + opsPath(c.branch, { ...query, view: 'consumption' }), {
      headers,
    });
    assert.equal(blocked.status, 404);
    assert.equal((await blocked.json()).error, undefined);
    // The API itself: an unknown view is a plain 404.
    const unknown = await fetch(
      `${c.upstream}/v1/admin/backoffice/branches/${c.branch}/ops/sales?start_date=2026-11-01`,
      { headers },
    );
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, undefined);
    const state = await (
      await fetch(`${c.url}/v1/admin/backoffice/branches/${c.branch}?period=day`, { headers })
    ).json();
    assert.equal(state.role, 'manager');
    assert.equal('effective_role' in state, false);
    assert.equal('permissions' in state, false);
    assert.equal('roles' in state.capabilities, false);
    assert.equal('stock_v2' in state.capabilities, false);
    const id = randomUUID();
    const command = (command) =>
      fetch(`${c.url}/v1/admin/backoffice/branches/${c.branch}/commands`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ request_id: randomUUID(), reason: 'Synthetic HTTP', command }),
      });
    assert.equal(
      (
        await command({
          type: 'save',
          kind: 'ingredient',
          id,
          expected_revision: 0,
          payload: { name: 'Synthetic bun', unit: 'pcs', minimum: '0', active: true },
        })
      ).status,
      200,
    );
    const v2 = await command({
      type: 'stock',
      kind: 'receipt',
      reference: 'NAK-1',
      meta: { supplier_kind: 'bakery', document_date: today() },
      lines: [{ ingredient_id: id, quantity: '10', value_minor: '1000', expected_revision: 0 }],
    });
    assert.equal(v2.status, 409);
    assert.deepEqual((await v2.json()).error, { code: 'STOCK_V2_DISABLED' });
  }));

test('flags on: permissions in read, waste reasons over HTTP, ops/stock report, ROLE_FORBIDDEN', () =>
  withCatalog(
    async (c) => {
      const headers = (token) => ({
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      });
      const command = (token, command) =>
        fetch(`${c.url}/v1/admin/backoffice/branches/${c.branch}/commands`, {
          method: 'POST',
          headers: headers(token),
          body: JSON.stringify({ request_id: randomUUID(), reason: 'Synthetic HTTP', command }),
        });
      const state = await (
        await fetch(`${c.url}/v1/admin/backoffice/branches/${c.branch}?period=day`, {
          headers: headers(c.manager.token),
        })
      ).json();
      assert.equal(state.role, 'manager');
      assert.equal(state.effective_role, 'manager');
      assert.ok(state.permissions.includes('stock.waste'));
      assert.equal(state.capabilities.roles, true);
      assert.equal(state.capabilities.stock_v2, true);
      const id = randomUUID();
      await command(c.manager.token, {
        type: 'save',
        kind: 'ingredient',
        id,
        expected_revision: 0,
        payload: { name: 'Synthetic bun', unit: 'pcs', minimum: '0', active: true },
      });
      const receipt = await command(c.manager.token, {
        type: 'stock',
        kind: 'receipt',
        reference: 'NAK-1',
        meta: {
          supplier_kind: 'bakery',
          supplier_name: 'Синтетическая пекарня',
          document_date: today(),
        },
        lines: [{ ingredient_id: id, quantity: '10', value_minor: '1000', expected_revision: 0 }],
      });
      assert.equal(receipt.status, 200);
      const line = { ingredient_id: id, quantity: '2', value_minor: '0', expected_revision: 1 };
      const missing = await command(c.manager.token, {
        type: 'stock',
        kind: 'waste',
        reference: 'W-1',
        lines: [line],
      });
      assert.equal(missing.status, 400);
      assert.deepEqual((await missing.json()).error, { code: 'REASON_REQUIRED' });
      assert.equal(
        (
          await command(c.manager.token, {
            type: 'stock',
            kind: 'waste',
            reference: 'W-1',
            reason_code: 'hot_cabinet_expired',
            lines: [line],
          })
        ).status,
        200,
      );
      const report = await fetch(
        c.url + opsPath(c.branch, { view: 'waste', start_date: today(), end_date: today() }),
        { headers: headers(c.manager.token) },
      );
      assert.equal(report.status, 200);
      const data = await report.json();
      // On 075 stock v2 carries lane bo-ui's stock P1: each waste row counts its storno too.
      assert.equal(state.capabilities.stock_p1, true);
      assert.deepEqual(data.summary.by_reason, [
        { reason_code: 'hot_cabinet_expired', documents: 1, reversals: 0, value_minor: '200' },
      ]);
      const movement = await (
        await fetch(
          c.url + opsPath(c.branch, { view: 'movement', start_date: today(), end_date: today() }),
          { headers: headers(c.manager.token) },
        )
      ).json();
      assert.equal(
        movement.documents.find((d) => d.kind === 'receipt').meta.supplier_name,
        'Синтетическая пекарня',
      );

      // A designated shift manager: stock yes, finance no (403 ROLE_FORBIDDEN through the proxy).
      const shift = await provisionCatalogManager(c.cloud.pool, {
        organization_id: c.org,
        name: 'Синтетический начальник смены',
        branch_ids: [c.branch],
      });
      await grantBackoffice(c.cloud.pool, shift.actor_id, c.branch, 'analyst');
      await designateBackoffice(
        c.cloud.pool,
        shift.actor_id,
        c.branch,
        'shift_manager',
        'Т7: смена',
      );
      const shiftState = await (
        await fetch(`${c.url}/v1/admin/backoffice/branches/${c.branch}?period=day`, {
          headers: headers(shift.token),
        })
      ).json();
      assert.equal(shiftState.role, 'analyst');
      assert.equal(shiftState.effective_role, 'shift_manager');
      const waste = await command(shift.token, {
        type: 'stock',
        kind: 'waste',
        reference: 'W-2',
        reason_code: 'defect',
        lines: [{ ...line, expected_revision: 2 }],
      });
      assert.equal(waste.status, 200);
      const save = await command(shift.token, {
        type: 'save',
        kind: 'ingredient',
        id: randomUUID(),
        expected_revision: 0,
        payload: { name: 'Synthetic', unit: 'pcs', minimum: '0', active: true },
      });
      assert.equal(save.status, 403);
      assert.deepEqual((await save.json()).error, { code: 'ROLE_FORBIDDEN' });
      const finance = await fetch(
        `${c.url}/v1/admin/backoffice/branches/${c.branch}/finance?start_date=2026-11-01&end_date=2026-11-30`,
        { headers: headers(shift.token) },
      );
      assert.equal(finance.status, 403);
      const financeBody = await finance.json();
      assert.equal(financeBody.code, 'FORBIDDEN');
      assert.deepEqual(financeBody.error, { code: 'ROLE_FORBIDDEN' });

      // Stock P1 storno through the proxy: the shift manager may not, the manager may once.
      const wasteId = data.documents[0].id;
      const balances = async () =>
        Object.fromEntries(
          (
            await (
              await fetch(`${c.url}/v1/admin/backoffice/branches/${c.branch}?period=day`, {
                headers: headers(c.manager.token),
              })
            ).json()
          ).stock.map((r) => [r.id, r.revision]),
        );
      const storno = async (token) =>
        command(token, {
          type: 'stock_reverse',
          document_id: wasteId,
          expected_balances: await balances(),
        });
      const denied = await storno(shift.token);
      assert.equal(denied.status, 403);
      assert.deepEqual((await denied.json()).error, { code: 'ROLE_FORBIDDEN' });
      const reversed = await storno(c.manager.token);
      assert.equal(reversed.status, 200);
      assert.equal((await reversed.json()).reverses_document_id, wasteId);
      const again = await storno(c.manager.token);
      assert.equal(again.status, 409);
      const body = await again.json();
      assert.equal(body.code, 'CONFLICT');
      assert.deepEqual(body.error, { code: 'ALREADY_REVERSED' });
      const after = await (
        await fetch(
          c.url + opsPath(c.branch, { view: 'waste', start_date: today(), end_date: today() }),
          { headers: headers(c.manager.token) },
        )
      ).json();
      assert.deepEqual(
        after.summary.by_reason.find((r) => r.reason_code === 'hot_cabinet_expired'),
        { reason_code: 'hot_cabinet_expired', documents: 1, reversals: 1, value_minor: '0' },
      );
    },
    { roles: true, stockV2: true },
  ));

test('sales report flag: off is the 404 of an unknown view, on answers through the proxy', async () => {
  const path = (branch) =>
    `/v1/admin/backoffice/branches/${branch}/ops/sales?start_date=${today()}&end_date=${today()}`;
  await withCatalog(async (c) => {
    const headers = { Authorization: 'Bearer ' + c.manager.token };
    const off = await fetch(c.url + path(c.branch), { headers });
    assert.equal(off.status, 404);
    const body = await off.json();
    assert.equal(body.code, 'NOT_FOUND');
    assert.equal(body.error, undefined);
    const state = await (
      await fetch(`${c.url}/v1/admin/backoffice/branches/${c.branch}?period=day`, { headers })
    ).json();
    assert.equal('sales_report' in state.capabilities, false);
  });
  await withCatalog(
    async (c) => {
      const headers = { Authorization: 'Bearer ' + c.manager.token };
      assert.equal((await fetch(c.url + path(c.branch))).status, 401);
      const state = await (
        await fetch(`${c.url}/v1/admin/backoffice/branches/${c.branch}?period=day`, { headers })
      ).json();
      assert.equal(state.capabilities.sales_report, true);
      assert.equal('effective_role' in state, false);
      const response = await fetch(c.url + path(c.branch), { headers });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^application\/json/);
      const report = await response.json();
      assert.equal(report.view, 'sales');
      assert.equal(report.coverage.pos, true);
      assert.deepEqual(
        report.channels.map((v) => v.channel),
        ['hall_dine_in', 'hall_takeaway', 'yandex_eda', 'glovo', 'mobile', 'kiosk'],
      );
      assert.equal(report.methods.length, 9);
      const tooLong = await fetch(
        `${c.url}/v1/admin/backoffice/branches/${c.branch}/ops/sales?start_date=2026-01-01&end_date=2026-11-19`,
        { headers },
      );
      assert.equal(tooLong.status, 400);
    },
    { salesReport: true },
  );
});
