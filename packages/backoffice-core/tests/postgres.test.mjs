import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import {
  provisionCatalogManager,
  revokeCatalogManager,
  CatalogAdmin,
} from '../../catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../dist/index.js';
async function setup(fn) {
  return withSyncDatabases(async (c) => {
    const manager = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Synthetic manager',
      branch_ids: [c.branch],
    });
    const bo = new Backoffice(c.cloud.pool, true);
    const command = (command, reason = 'Synthetic acceptance') => ({
      request_id: randomUUID(),
      reason,
      command,
    });
    await fn({ ...c, manager, bo, command });
  });
}
test('explicit scope, durable inventory, replay/conflicts, valuation, audit rollback and revoked access', () =>
  setup(async (c) => {
    const { bo, manager, branch, cloud, command } = c;
    await assert.rejects(bo.read(manager.token, branch), /FORBIDDEN/);
    await grantBackoffice(cloud.pool, manager.actor_id, branch, 'manager');
    const id = randomUUID();
    const ingredient = command({
      type: 'save',
      kind: 'ingredient',
      id,
      expected_revision: 0,
      payload: { name: 'Synthetic chicken', unit: 'g', minimum: '100', active: true },
    });
    const created = await bo.command(manager.token, branch, ingredient);
    assert.equal(created.revision, 1);
    assert.deepEqual(
      await bo.command(manager.token, branch, ingredient),
      JSON.parse(JSON.stringify(created)),
    );
    await assert.rejects(
      bo.command(manager.token, branch, { ...ingredient, reason: 'Different payload' }),
      /CONFLICT/,
    );
    const line = (quantity, rev, value_minor = '0') => ({
      ingredient_id: id,
      quantity,
      value_minor,
      expected_revision: rev,
    });
    const receipt = command({
      type: 'stock',
      kind: 'receipt',
      reference: 'SYN-1',
      lines: [line('1000', 0, '35000')],
    });
    await Promise.all([
      bo.command(manager.token, branch, receipt),
      bo.command(manager.token, branch, receipt),
    ]);
    let state = await bo.read(manager.token, branch);
    assert.equal(state.stock[0].quantity, '1000');
    assert.equal(state.documents.length, 1);
    await bo.command(
      manager.token,
      branch,
      command({ type: 'stock', kind: 'waste', reference: 'SYN-2', lines: [line('200', 1)] }),
    );
    state = await bo.read(manager.token, branch);
    assert.equal(state.stock[0].quantity, '800');
    assert.equal(state.stock[0].value_minor, '28000');
    await assert.rejects(
      bo.command(
        manager.token,
        branch,
        command({ type: 'stock', kind: 'waste', reference: 'SYN-3', lines: [line('801', 2)] }),
      ),
      /INSUFFICIENT_STOCK/,
    );
    assert.equal((await bo.read(manager.token, branch)).documents.length, 2);
    await assert.rejects(
      bo.command(
        manager.token,
        branch,
        command({ type: 'stock', kind: 'count', reference: 'SYN-4', lines: [line('600', 1)] }),
      ),
      /CONFLICT/,
    );
    await bo.command(
      manager.token,
      branch,
      command({ type: 'stock', kind: 'count', reference: 'SYN-5', lines: [line('600', 2)] }),
    );
    state = await bo.read(manager.token, branch);
    assert.equal(state.stock[0].value_minor, '21000');
    assert.equal(state.audit.length, 4);
    await assert.rejects(cloud.pool.query('DELETE FROM bo_stock_documents'), /immutable/);
    await assert.rejects(cloud.pool.query('DELETE FROM bo_audit'), /immutable/);
    await grantBackoffice(cloud.pool, manager.actor_id, branch, 'analyst');
    await bo.read(manager.token, branch);
    await assert.rejects(bo.command(manager.token, branch, ingredient), /FORBIDDEN/);
    await revokeCatalogManager(cloud.pool, manager.actor_id);
    await assert.rejects(bo.read(manager.token, branch), /UNAUTHORIZED/);
  }));
test('branch isolation and mandatory referenced records', () =>
  setup(async (c) => {
    await grantBackoffice(c.cloud.pool, c.manager.actor_id, c.branch, 'manager');
    await assert.rejects(c.bo.read(c.manager.token, randomUUID()), /FORBIDDEN/);
    await assert.rejects(
      c.bo.command(
        c.manager.token,
        c.branch,
        c.command({
          type: 'save',
          kind: 'ticket',
          id: randomUUID(),
          expected_revision: 0,
          payload: {
            name: 'Example',
            order_id: randomUUID(),
            category: 'question',
            priority: 'normal',
            assignee_id: null,
            due_at: null,
            status: 'new',
            description: 'Test',
            resolution: '',
          },
        }),
      ),
      /INVALID_REQUEST/,
    );
    const catalog = new CatalogAdmin(c.cloud.pool, { enabled: true });
    await catalog.seed(c.manager.token, c.branch, {
      request_id: randomUUID(),
      expected_revision: 0,
    });
    const state = await c.bo.read(c.manager.token, c.branch);
    assert.equal(state.catalog_audit.length, 1);
    assert.equal(state.metrics.captured_minor, '0');
    assert.equal(state.metrics.orders, 0);
  }));
test('published content uses explicit versions, schedule and channel; edits stay private and disabled games are propagated', () =>
  setup(async (c) => {
    await grantBackoffice(c.cloud.pool, c.manager.actor_id, c.branch, 'manager');
    const id = randomUUID(),
      schedule = {
        starts_at: new Date(Date.now() - 60000).toISOString(),
        ends_at: new Date(Date.now() + 600000).toISOString(),
      };
    const payload = {
      name: 'Synthetic promo',
      title: { ru: 'Синтетическая акция', kk: '' },
      body: { ru: 'Описание', kk: '' },
      image_asset_key: 'logo',
      channels: ['mobile'],
      schedule,
      status: 'active',
    };
    const save = (kind, id, payload, expected_revision = 0) =>
      c.bo.command(
        c.manager.token,
        c.branch,
        c.command({ type: 'save', kind, id, payload, expected_revision }),
      );
    const publish = (kind, id, expected_revision) =>
      c.bo.command(
        c.manager.token,
        c.branch,
        c.command({ type: 'publish', kind, id, expected_revision }),
      );
    await save('promo', id, payload);
    assert.equal((await c.bo.content(c.branch, 'mobile')).promos.length, 0);
    await publish('promo', id, 1);
    assert.equal((await c.bo.content(c.branch, 'mobile')).promos[0].title.ru, payload.title.ru);
    assert.equal((await c.bo.content(c.branch, 'kiosk')).promos.length, 0);
    await save('promo', id, { ...payload, title: { ru: 'Не опубликовано', kk: '' } }, 1);
    assert.equal((await c.bo.content(c.branch, 'mobile')).promos[0].title.ru, payload.title.ru);
    await assert.rejects(publish('promo', id, 1), /CONFLICT/);
    await save('promo', id, { ...payload, status: 'archived' }, 2);
    await publish('promo', id, 3);
    assert.equal((await c.bo.content(c.branch, 'mobile')).promos.length, 0);
    const game = randomUUID(),
      gp = {
        name: 'Synthetic game',
        template: 'pick-man',
        enabled: false,
        daily_attempts: 10,
        reward_chiki: '0',
        schedule,
      };
    await save('game', game, gp);
    await publish('game', game, 1);
    assert.deepEqual((await c.bo.content(c.branch, 'mobile')).games, [
      { template: 'pick-man', enabled: false, revision: 1 },
    ]);
    await assert.rejects(save('game', randomUUID(), gp), /CONFLICT/);
    await assert.rejects(save('game', game, { ...gp, template: 'pick-run' }, 1), /CONFLICT/);
    await assert.rejects(save('game', game, { ...gp, reward_chiki: '100' }, 1), /INVALID_REQUEST/);
    assert.equal(
      (await new Backoffice(c.cloud.pool, false).content(c.branch, 'mobile')).games.length,
      0,
    );
  }));
test('production atomically transfers ingredient value into a semi-finished product with revision and stock fences', () =>
  setup(async (c) => {
    await grantBackoffice(c.cloud.pool, c.manager.actor_id, c.branch, 'manager');
    const a = randomUUID(),
      b = randomUUID(),
      recipe = randomUUID();
    for (const id of [a, b])
      await c.bo.command(
        c.manager.token,
        c.branch,
        c.command({
          type: 'save',
          kind: 'ingredient',
          id,
          expected_revision: 0,
          payload: { name: 'Synthetic ' + id.slice(0, 4), unit: 'g', minimum: '0', active: true },
        }),
      );
    await c.bo.command(
      c.manager.token,
      c.branch,
      c.command({
        type: 'stock',
        kind: 'receipt',
        reference: 'SYN-RAW',
        lines: [{ ingredient_id: a, quantity: '1000', value_minor: '30000', expected_revision: 0 }],
      }),
    );
    await c.bo.command(
      c.manager.token,
      c.branch,
      c.command({
        type: 'save',
        kind: 'recipe',
        id: recipe,
        expected_revision: 0,
        payload: {
          name: 'Synthetic semi',
          product_id: 'semi',
          output_ingredient_id: b,
          yield_quantity: '80',
          lines: [{ ingredient_id: a, quantity: '100' }],
        },
      }),
    );
    const req = c.command({
      type: 'produce',
      recipe_id: recipe,
      recipe_revision: 1,
      batches: 2,
      reference: 'SYN-PROD',
      expected_balances: { [a]: 1, [b]: 0 },
    });
    await c.bo.command(c.manager.token, c.branch, req);
    await c.bo.command(c.manager.token, c.branch, req);
    const state = await c.bo.read(c.manager.token, c.branch),
      raw = state.stock.find((v) => v.id === a),
      semi = state.stock.find((v) => v.id === b);
    assert.equal(raw.quantity, '800');
    assert.equal(raw.value_minor, '24000');
    assert.equal(semi.quantity, '160');
    assert.equal(semi.value_minor, '6000');
    assert.equal(state.documents.length, 2);
    await assert.rejects(
      c.bo.command(c.manager.token, c.branch, c.command(req.command)),
      /CONFLICT/,
    );
    await assert.rejects(
      c.bo.command(
        c.manager.token,
        c.branch,
        c.command({ ...req.command, batches: 999, expected_balances: { [a]: 2, [b]: 1 } }),
      ),
      /INSUFFICIENT_STOCK/,
    );
    assert.equal((await c.bo.read(c.manager.token, c.branch)).documents.length, 2);
  }));
