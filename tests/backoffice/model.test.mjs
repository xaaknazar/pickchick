/* global structuredClone */
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CatalogModel } from '../../apps/backoffice/dist/model.js';
import { ApiError } from '../../apps/backoffice/dist/api.js';
import {
  toMinor,
  toMajor,
  money,
  parsePayload,
  productIssues,
  payloadIssues,
  assetKeys,
} from '../../apps/backoffice/dist/domain.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import {
  CatalogPayloadSchema,
  CATALOG_ASSET_KEYS,
} from '../../packages/catalog-admin/dist/contracts.js';
import {
  provisionCatalogManager,
  revokeCatalogManager,
} from '../../packages/catalog-admin/dist/index.js';
import { withCatalog, storage } from './helpers.mjs';
test('money stays exact beyond Number safe range; client accepts canonical 24-SKU seed and rejects broken dependencies', () => {
  assert.equal(toMinor(' 52 900,17 '), '5290017');
  assert.equal(toMajor('9999999999999999'), '99999999999999,99');
  assert.equal(toMinor(toMajor('9999999999999999')), '9999999999999999');
  assert.equal(money('9999999999999999'), '99 999 999 999 999,99 ₸');
  for (const invalid of ['-1', '1e3', '1.999', 'Infinity', '100000000000000'])
    assert.throws(() => toMinor(invalid));
  const payload = structuredClone(mockupCatalogDraft);
  assert.equal(parsePayload(payload).products.length, 24);
  assert.deepEqual(new Set(assetKeys), new Set(CATALOG_ASSET_KEYS));
  const p = structuredClone(payload.products[0]);
  p.modifier_groups[0].options[0].linked_product_id = 'absent';
  assert.ok(productIssues(p, payload).length);
  payload.products[0] = p;
  assert.ok(payloadIssues(payload).length);
  assert.equal(CatalogPayloadSchema.safeParse(payload).success, false);
});
test('real scoped manager draft/save/publish lifecycle keeps active content separate and recovers committed timeout once', async () =>
  withCatalog(async (ctx) => {
    const store = storage(),
      model = new CatalogModel(ctx.transport, store);
    assert.equal(await model.login(JSON.stringify({ token: 'f'.repeat(64) })), false);
    assert.equal(model.actor, null);
    assert.equal(await model.login(JSON.stringify(ctx.manager)), true);
    assert.equal(model.payload, null);
    assert.equal(await model.seed(), true);
    assert.equal(model.payload.products.length, 24);
    const p = structuredClone(model.payload.products[0]);
    p.price_minor = toMinor('5250,17');
    p.name.kk = 'Сынақ комбо';
    model.updateProduct(p);
    model.reviewContent(true);
    assert.equal(model.dirty, true);
    assert.equal(await model.publish(), false);
    assert.equal(await model.save(), true);
    assert.equal(model.state.draft.revision, 2);
    assert.equal(await model.publish(), true);
    assert.equal(model.state.draft.revision, 3);
    assert.equal(model.state.published.version, 1);
    let lose = true;
    const requests = [];
    const dropping = async (path, token, options) => {
      const value = await ctx.transport(path, token, options);
      if (options?.method === 'PUT') {
        requests.push(structuredClone(options.body));
        if (lose) {
          lose = false;
          throw new ApiError('NETWORK');
        }
      }
      return value;
    };
    const next = new CatalogModel(dropping, store);
    await next.boot();
    const edit = structuredClone(next.payload.products[0]);
    edit.price_minor = '625000';
    next.updateProduct(edit);
    assert.equal(await next.save(), false);
    assert.equal(next.pending.kind, 'save');
    assert.equal(
      (await ctx.service.publicCatalog(ctx.branch)).payload.products[0].price_minor,
      '525017',
    );
    const reloaded = new CatalogModel(dropping, store);
    await reloaded.boot();
    assert.equal(reloaded.pending.kind, 'save');
    assert.equal(await reloaded.recover(), true);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(reloaded.state.draft.revision, 4);
    assert.equal(reloaded.pending, null);
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) FROM catalog_draft_versions')).rows[0].count,
      '4',
    );
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) FROM catalog_publications')).rows[0].count,
      '1',
    );
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) FROM test_orders')).rows[0].count,
      '0',
    );
    assert.equal(
      [...store.map.entries()]
        .filter(([k]) => k.includes('.work.'))
        .some(([, v]) => v.includes(ctx.manager.token)),
      false,
    );
  }));
test('two real managers cannot overwrite revisions; stale clean journal refreshes but local conflict remains intact', async () =>
  withCatalog(async (ctx) => {
    const manager2 = await provisionCatalogManager(ctx.cloud.pool, {
      organization_id: ctx.org,
      name: 'Синтетический второй',
      branch_ids: [ctx.branch],
    });
    const s = storage(),
      first = new CatalogModel(ctx.transport, s),
      other = new CatalogModel(ctx.transport, storage());
    await first.login(JSON.stringify(ctx.manager));
    await first.seed();
    await other.login(JSON.stringify(manager2));
    const a = structuredClone(first.payload.products[0]),
      b = structuredClone(other.payload.products[0]);
    a.name.ru = 'Локальная правка первого';
    b.name.ru = 'Сохранённая правка второго';
    first.updateProduct(a);
    other.updateProduct(b);
    assert.equal(await other.save(), true);
    assert.equal(await first.save(), false);
    assert.equal(first.conflict, true);
    assert.equal(first.payload.products[0].name.ru, a.name.ru);
    assert.equal(first.pending, null);
    const restart = new CatalogModel(ctx.transport, s);
    await restart.boot();
    assert.equal(restart.conflict, true);
    assert.equal(restart.payload.products[0].name.ru, a.name.ru);
    assert.equal(await restart.reload(true), true);
    assert.equal(restart.payload.products[0].name.ru, b.name.ru);
    const c = structuredClone(other.payload.products[0]);
    c.name.ru = 'Следующая версия';
    other.updateProduct(c);
    await other.save();
    const clean = new CatalogModel(ctx.transport, s);
    await clean.boot();
    assert.equal(clean.payload.products[0].name.ru, c.name.ru);
  }));
test('expired actor journal is immutable until same actor reauth; another scoped manager never receives it; storage failure sends no save', async () =>
  withCatalog(async (ctx) => {
    const store = storage();
    let drop = true;
    const t = async (...args) => {
      const result = await ctx.transport(...args);
      if (args[2]?.method === 'PUT' && drop) {
        drop = false;
        throw new ApiError('NETWORK');
      }
      return result;
    };
    const a = new CatalogModel(t, store);
    await a.login(JSON.stringify(ctx.manager));
    await a.seed();
    a.reviewContent(true);
    await a.save();
    const pending = structuredClone(a.pending);
    const manager2 = await provisionCatalogManager(ctx.cloud.pool, {
      organization_id: ctx.org,
      name: 'Другой управляющий',
      branch_ids: [ctx.branch],
    });
    a.logout();
    await a.login(JSON.stringify(manager2));
    assert.equal(a.pending, null);
    assert.equal(
      store
        .getItem(`pickchick.backoffice.work.v1.${ctx.manager.actor_id}`)
        .includes(pending.body.request_id),
      true,
    );
    a.logout();
    await a.login(JSON.stringify(ctx.manager));
    assert.deepEqual(a.pending, pending);
    await a.recover();
    await revokeCatalogManager(ctx.cloud.pool, ctx.manager.actor_id);
    assert.equal(await a.reload(), false);
    assert.equal(a.actor, null);
    assert.equal(store.getItem('pickchick.backoffice.credential.v1'), null);
    let calls = 0;
    const broken = {
      getItem: () => null,
      removeItem() {},
      setItem() {
        throw new Error('quota');
      },
    };
    const noStore = new CatalogModel(async (...args) => {
      calls++;
      return ctx.transport(...args);
    }, broken);
    assert.equal(await noStore.login(JSON.stringify(manager2)), false);
    assert.equal(calls, 1);
    assert.equal(noStore.actor, null);
    let blocked = false,
      requests = 0;
    const originalSet = store.setItem;
    store.setItem = (k, v) => {
      if (blocked) throw new Error('quota');
      return originalSet(k, v);
    };
    const beforeSave = new CatalogModel(async (...args) => {
      requests++;
      return ctx.transport(...args);
    }, store);
    await beforeSave.login(JSON.stringify(manager2));
    beforeSave.reviewContent(true);
    const count = requests;
    blocked = true;
    assert.equal(await beforeSave.save(), false);
    assert.equal(requests, count);
    assert.equal(beforeSave.pending, null);
    assert.equal(beforeSave.dirty, true);
    blocked = false;
    const foreignReadFails = new CatalogModel(async (path, ...args) => {
      if (path === `branches/${ctx.branch}`) throw new ApiError('NETWORK');
      return ctx.transport(path, ...args);
    }, store);
    foreignReadFails.payload = structuredClone(beforeSave.payload);
    foreignReadFails.state = beforeSave.state;
    assert.equal(await foreignReadFails.login(JSON.stringify(manager2)), false);
    assert.equal(foreignReadFails.state, null);
    assert.equal(foreignReadFails.payload, null);
  }));
test('loopback proxy forbids CSRF, foreign hosts, public routes and credential query URLs', async () =>
  withCatalog(async (ctx) => {
    const routes = [
      '/v1/admin/catalog/branches?token=redacted',
      '/v1/catalog/branches/' + ctx.branch,
      '/v1/admin/catalog/issue',
      '/../../.env',
    ];
    for (const path of routes) assert.equal((await fetch(ctx.url + path)).status, 404);
    assert.equal(
      (
        await fetch(ctx.url + '/v1/admin/catalog/branches', {
          headers: {
            Origin: 'https://foreign.example',
            Authorization: 'Bearer ' + ctx.manager.token,
          },
        })
      ).status,
      403,
    );
    assert.equal(
      await new Promise((resolve, reject) => {
        const request = httpRequest(
          ctx.url + '/',
          { headers: { Host: 'foreign.example' } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on('error', reject);
        request.end();
      }),
      403,
    );
    const response = await fetch(ctx.url + '/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await response.text()).includes(ctx.manager.token), false);
    assert.equal(
      (
        await fetch(ctx.url + '/v1/admin/catalog/branches', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + ctx.manager.token },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(ctx.url + '/v1/admin/catalog/branches/' + randomUUID(), {
          headers: { Authorization: 'Bearer ' + ctx.manager.token },
        })
      ).status,
      403,
    );
  }));
