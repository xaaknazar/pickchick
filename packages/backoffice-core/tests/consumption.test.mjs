import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import {
  BACKOFFICE_PERMISSIONS,
  Backoffice,
  BackofficeError,
  permissionsOf,
  runStockConsumption,
} from '../dist/index.js';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import { backofficeP1Grants } from '../../../infra/staging/backoffice-p1-grants.mjs';
import {
  balances,
  cloudOrder,
  consumptionDocuments,
  items,
  kitchen,
  linkFixture,
  people,
  posSale,
  publishMenuFixture,
  receipt,
  request,
  stockDocument,
  stockFixture,
} from './consumption-fixture.mjs';

/**
 * Automatic consumption by sales (lane bo-ui step 5; consumption.ts, consumption-store.ts;
 * design-bo-ui.md 3, 5.3, 5.5; design-backoffice.md 4). Synthetic data only.
 */
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const V2 = { stockV2Enabled: true, rolesEnabled: true };
const ON = { ...V2, stockAutoconsumeEnabled: true };
const ago = (minutes) => new Date(Date.now() - minutes * 60000);
const settings = (bo, token, c, mode, startAt, expected) =>
  bo.command(
    token,
    c.branch,
    request({
      type: 'stock_settings',
      autoconsume_mode: mode,
      start_at: startAt ? startAt.toISOString() : null,
      expected_revision: expected,
    }),
  );
const tick = (c, options = ON, now = () => new Date()) =>
  runStockConsumption(c.cloud.pool, options, now, (error) => {
    throw error;
  });
async function setup(c, options = ON) {
  const p = await people(c);
  const bo = new Backoffice(c.cloud.pool, true, options);
  const { release } = await publishMenuFixture(c);
  const s = await stockFixture(bo, p.manager.token, c);
  return { p, bo, release, s, token: p.manager.token };
}

test('flags off: no queue, unknown commands and views, the worker never reads a branch', () =>
  withSyncDatabases(async (c) => {
    const { p, release } = await setup(c, V2);
    const token = p.manager.token;
    // A settings row in `on` written by hand: without the flag nothing happens with it.
    await c.cloud.pool.query(
      "INSERT INTO bo_stock_settings(branch_id,autoconsume_mode,start_at,revision,updated_by) VALUES($1,'on',$2,1,$3)",
      [c.branch, ago(600), p.manager.actor_id],
    );
    const sale = await posSale(c, release, { at: ago(10), lines: [['fries', 1]] });
    await kitchen(c, sale, 'in_production');
    for (const options of [{}, V2, { rolesEnabled: true }]) {
      const off = new Backoffice(c.cloud.pool, true, options);
      for (const command of [
        { type: 'stock_settings', autoconsume_mode: 'off', start_at: null, expected_revision: 1 },
        { type: 'consumption_retry', source: 'pos', order_id: sale, expected_revision: 1 },
        { type: 'consumption_skip', source: 'pos', order_id: sale, expected_revision: 1 },
      ])
        await assert.rejects(
          off.command(token, c.branch, request(command)),
          is('INVALID_REQUEST', undefined),
        );
      await assert.rejects(off.ops(token, c.branch, 'consumption', {}), is('NOT_FOUND', undefined));
      const state = await off.read(token, c.branch);
      assert.equal('stock_autoconsume' in state.capabilities, false);
      assert.deepEqual(await tick(c, options), {
        ready: false,
        branches: 0,
        enqueued: 0,
        processed: 0,
        states: {},
        errors: 0,
      });
    }
    // Menu links stay a stock P1 feature: unknown command and view without stock v2.
    const none = new Backoffice(c.cloud.pool, true, {});
    await assert.rejects(
      none.command(
        token,
        c.branch,
        request({
          type: 'menu_link_save',
          catalog_ref: { product_id: 'fries' },
          effect: 'none',
          lines: [],
          expected_revision: 0,
        }),
      ),
      is('INVALID_REQUEST', undefined),
    );
    await assert.rejects(none.ops(token, c.branch, 'menu-links', {}), is('NOT_FOUND', undefined));
    assert.deepEqual(await items(c), []);
    assert.deepEqual(await consumptionDocuments(c), []);
  }));

test('menu links: table, combos by components, draft and approval revisions, roles, replay', () =>
  withSyncDatabases(async (c) => {
    const { p, bo, s, token } = await setup(c, V2);
    let view = await bo.ops(token, c.branch, 'menu-links', {});
    assert.equal(view.catalog.version, 1);
    const item = (key) => view.items.find((i) => i.catalog_key === key);
    assert.deepEqual(
      view.items.map((i) => i.catalog_key),
      [
        'burger',
        'burger:extra:sauce',
        'burger:extra:cheese',
        'sauce',
        'fries',
        'nuggets',
        'cola',
        'combo',
        'combo:drink:cola',
        'duo',
        'family',
      ],
    );
    assert.equal(item('combo').kind, 'combo');
    assert.equal(item('combo').from_combo, true);
    assert.equal(item('family').kind, 'set');
    assert.equal(item('burger:extra:sauce').linked_product_id, 'sauce');
    // The cola option of the combo is the cola product (same slug, menu-sync stop rule).
    assert.equal(item('combo:drink:cola').linked_product_id, 'cola');
    assert.equal(item('burger:extra:cheese').covered_without_link, false);
    assert.deepEqual(view.coverage, { items: 11, linked: 0, approved: 0, without_link: 6 });
    // Roles: only the manager edits and approves.
    const save = (who, command) => bo.command(who, c.branch, request(command));
    const fries = {
      type: 'menu_link_save',
      catalog_ref: { product_id: 'fries' },
      effect: 'consume',
      lines: [{ ingredient_id: s.potato, quantity: '150' }],
      expected_revision: 0,
    };
    for (const who of [p.shift.token, p.accountant.token])
      await assert.rejects(save(who, fries), is('FORBIDDEN', 'ROLE_FORBIDDEN'));
    await assert.rejects(save(p.analyst.token, fries), is('FORBIDDEN', undefined));
    // Validation: unknown catalog item, unknown stock item, an output without one recipe.
    await assert.rejects(
      save(token, { ...fries, catalog_ref: { product_id: 'nope' } }),
      is('NOT_FOUND', 'CATALOG_ITEM_NOT_FOUND'),
    );
    await assert.rejects(
      save(token, { ...fries, lines: [{ ingredient_id: randomUUID(), quantity: '1' }] }),
      is('INVALID_REQUEST', undefined),
    );
    await assert.rejects(
      save(token, { ...fries, lines: [{ recipe_output_id: s.potato, quantity: '1' }] }),
      is('INVALID_REQUEST', undefined),
    );
    for (const bad of [
      { ...fries, effect: 'none' },
      { ...fries, lines: [] },
      { ...fries, lines: [{ ingredient_id: s.potato, quantity: '0' }] },
      { ...fries, lines: [{ ingredient_id: s.potato, quantity: '1.5' }] },
      {
        ...fries,
        lines: [
          { ingredient_id: s.potato, quantity: '1' },
          { ingredient_id: s.potato, quantity: '2' },
        ],
      },
    ])
      await assert.rejects(save(token, bad), is('INVALID_REQUEST', undefined));
    // Save: a draft at revision 1, exact replay, a changed body with the same id conflicts.
    const first = request(fries);
    const saved = await bo.command(token, c.branch, first);
    assert.equal(saved.status, 'draft');
    assert.equal(saved.revision, 1);
    assert.deepEqual(await bo.command(token, c.branch, first), saved);
    await assert.rejects(
      bo.command(token, c.branch, { ...first, reason: 'Другая причина' }),
      is('CONFLICT', undefined),
    );
    await assert.rejects(save(token, fries), is('CONFLICT', undefined));
    // Approve at the shown revision; a stale revision conflicts.
    await assert.rejects(
      save(token, {
        type: 'menu_links_approve',
        keys: ['fries'],
        expected_revisions: { fries: 0 },
      }),
      is('CONFLICT', undefined),
    );
    await assert.rejects(
      save(p.shift.token, {
        type: 'menu_links_approve',
        keys: ['fries'],
        expected_revisions: { fries: 1 },
      }),
      is('FORBIDDEN', 'ROLE_FORBIDDEN'),
    );
    const approved = await save(token, {
      type: 'menu_links_approve',
      keys: ['fries'],
      expected_revisions: { fries: 1 },
    });
    assert.equal(approved.approved[0].status, 'approved');
    assert.equal(approved.approved[0].revision, 2);
    // A save that changes nothing keeps the approval; a change returns to draft.
    const same = await save(token, { ...fries, expected_revision: 2 });
    assert.equal(same.status, 'approved');
    const changed = await save(token, {
      ...fries,
      lines: [{ ingredient_id: s.potato, quantity: '120' }],
      expected_revision: 3,
    });
    assert.equal(changed.status, 'draft');
    assert.equal(changed.approved_by, null);
    // effect none: sold without a write-off (the cheese option here).
    await save(token, {
      type: 'menu_link_save',
      catalog_ref: { product_id: 'burger', group_id: 'extra', option_id: 'cheese' },
      effect: 'none',
      lines: [],
      expected_revision: 0,
    });
    view = await bo.ops(token, c.branch, 'menu-links', {});
    assert.deepEqual(item('fries').link.lines, [
      { ingredient_id: s.potato, quantity: '120', name: 'Синтетический картофель', unit: 'g' },
    ]);
    assert.equal(item('fries').link.updated_by_name, 'Синтетический управляющий');
    assert.equal(item('burger:extra:cheese').link.effect, 'none');
    assert.deepEqual(view.coverage, { items: 11, linked: 2, approved: 0, without_link: 4 });
    // Every command left its audit row; the strict view takes no query keys.
    const audit = (
      await c.cloud.pool.query(
        "SELECT action,count(*)::int n FROM bo_audit WHERE branch_id=$1 AND action LIKE 'menu_link%' GROUP BY action ORDER BY action",
        [c.branch],
      )
    ).rows;
    assert.deepEqual(audit, [
      { action: 'menu_link_save', n: 4 },
      { action: 'menu_links_approve', n: 1 },
    ]);
    await assert.rejects(
      bo.ops(token, c.branch, 'menu-links', { all: '1' }),
      is('INVALID_REQUEST', undefined),
    );
    // permissions[]: the link rights come with stock P1, the queue rights with autoconsume.
    assert.deepEqual((await bo.read(token, c.branch)).permissions, [
      ...BACKOFFICE_PERMISSIONS,
      'stock.reverse',
      'menu_links.write',
      'menu_links.approve',
    ]);
    const on = new Backoffice(c.cloud.pool, true, ON);
    assert.deepEqual((await on.read(token, c.branch)).permissions, [
      ...BACKOFFICE_PERMISSIONS,
      'stock.reverse',
      'menu_links.write',
      'menu_links.approve',
      'stock.settings',
      'consumption.write',
    ]);
    assert.deepEqual((await on.read(p.shift.token, c.branch)).permissions, [
      ...permissionsOf('shift_manager'),
      'consumption.write',
    ]);
    assert.equal((await on.read(token, c.branch)).capabilities.stock_autoconsume, true);
  }));

test('exactly once: concurrent ticks and replays, combo explosion, recipes, one rounding per order', () =>
  withSyncDatabases(async (c) => {
    const { p, bo, release, s, token } = await setup(c);
    await linkFixture(bo, token, c, s);
    await settings(bo, token, c, 'on', ago(120), 0);
    const before = await balances(c);
    // burger x2 with cheese and sauce; combo with cola; a family set (two duo combos and a cola).
    const burger = await posSale(c, release, {
      at: ago(30),
      number: 11,
      lines: [
        [
          'burger',
          2,
          [
            ['extra', 'cheese'],
            ['extra', 'sauce'],
          ],
        ],
      ],
    });
    const combo = await posSale(c, release, {
      at: ago(25),
      number: 12,
      lines: [['combo', 1, [['drink', 'cola']]]],
    });
    const family = await posSale(c, release, { at: ago(20), number: 13, lines: [['family', 1]] });
    const waiting = await posSale(c, release, { at: ago(15), number: 14, lines: [['fries', 1]] });
    for (const order of [burger, combo, family]) await kitchen(c, order, 'in_production');
    await kitchen(c, waiting, 'accepted');
    // Three workers at once: one document per order, the others find the items final.
    const ticks = await Promise.all([tick(c), tick(c), tick(c)]);
    assert.equal(
      ticks.reduce((n, t) => n + t.enqueued, 0),
      3,
    );
    assert.equal(
      ticks.reduce((n, t) => n + (t.states.applied ?? 0), 0),
      3,
    );
    const docs = await consumptionDocuments(c);
    assert.deepEqual(
      docs.map((d) => d.source_ref),
      [`pos:${burger}`, `pos:${combo}`, `pos:${family}`],
    );
    assert.ok(docs.every((d) => d.order_id === null && d.actor_id === p.manager.actor_id));
    assert.deepEqual(
      docs.map((d) => d.reference),
      ['Продажа кассы №11', 'Продажа кассы №12', 'Продажа кассы №13'],
    );
    // burger x2: bun 2, patty explodes to meat 2 x 120, cheese 2, sauce option -> sauce product
    // -> 2 x 30 g of the sauce output kept as stock (stock_policy stock).
    assert.deepEqual(docs[0].moves, {
      [s.bun]: '2',
      [s.meat]: '240',
      [s.cheese]: '2',
      [s.sauce]: '60',
    });
    // combo: fries 150 + 2 nuggets (100 g / 3 each = 200/3 -> 67, one rounding) + cola 1.
    assert.deepEqual(docs[1].moves, { [s.potato]: '150', [s.chicken]: '67', [s.can]: '1' });
    // family: 2 duo (fries + nugget each) + cola: potato 300, chicken 200/3 -> 67, cola 1.
    assert.deepEqual(docs[2].moves, { [s.potato]: '300', [s.chicken]: '67', [s.can]: '1' });
    const after = await balances(c);
    assert.equal(after[s.bun].quantity, String(Number(before[s.bun].quantity) - 2));
    assert.equal(after[s.chicken].quantity, String(Number(before[s.chicken].quantity) - 134));
    assert.equal(after[s.potato].quantity, String(Number(before[s.potato].quantity) - 450));
    // The value follows the average cost: 2 buns of 5000 tiyn each.
    assert.equal(after[s.bun].value_minor, String(Number(before[s.bun].value_minor) - 10000));
    // Replays: more ticks, the kitchen moving on, change nothing.
    for (const order of [burger, combo]) await kitchen(c, order, 'ready');
    const again = await tick(c);
    assert.equal(again.processed, 0);
    assert.equal((await consumptionDocuments(c)).length, 3);
    assert.deepEqual(await balances(c), after);
    const queue = await items(c);
    assert.deepEqual(
      queue.map((i) => [i.order_id, i.state, i.trigger_kind]),
      [
        [burger, 'applied', 'kitchen_started'],
        [combo, 'applied', 'kitchen_started'],
        [family, 'applied', 'kitchen_started'],
      ],
    );
    // The snapshot names the link and recipe revisions it used.
    assert.deepEqual(Object.keys(queue[0].detail.links).sort(), [
      'burger',
      'burger:extra:cheese',
      'sauce',
    ]);
    assert.deepEqual(
      Object.keys(queue[0].detail.recipes).sort(),
      [s.recipes.patty, s.recipes.sauce].sort(),
    );
    // The database refuses a second consumption document of the same order.
    await assert.rejects(
      c.cloud.pool.query(
        "INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason,source_ref) VALUES($1,$2,$3,'consumption','x','xxx',$4)",
        [randomUUID(), c.branch, p.manager.actor_id, `pos:${burger}`],
      ),
      (e) => e.code === '23505',
    );
  }));

test('a missing link blocks only that order; shortages; retry after the fix; skip with a reason', () =>
  withSyncDatabases(async (c) => {
    const { p, bo, release, s, token } = await setup(c);
    await linkFixture(bo, token, c, s);
    await settings(bo, token, c, 'on', ago(300), 0);
    // duo has no link of its own and its components are linked: fine. A draft link blocks.
    await bo.command(
      token,
      c.branch,
      request({
        type: 'menu_link_save',
        catalog_ref: { product_id: 'duo' },
        effect: 'consume',
        lines: [{ ingredient_id: s.potato, quantity: '200' }],
        expected_revision: 0,
      }),
    );
    // The sauce product link removed from use by a new draft revision: the sauce option blocks.
    const ok = await posSale(c, release, { at: ago(40), number: 21, lines: [['fries', 1]] });
    const draft = await posSale(c, release, { at: ago(35), number: 22, lines: [['duo', 1]] });
    const unlinked = await posSale(c, release, {
      at: ago(30),
      number: 23,
      lines: [
        ['burger', 1, [['extra', 'cheese']]],
        ['fries', 1],
      ],
    });
    for (const order of [ok, draft, unlinked]) await kitchen(c, order, 'in_production');
    // burger:extra:cheese loses its approval (changed lines): only that order waits.
    await bo.command(
      token,
      c.branch,
      request({
        type: 'menu_link_save',
        catalog_ref: { product_id: 'burger', group_id: 'extra', option_id: 'cheese' },
        effect: 'consume',
        lines: [{ ingredient_id: s.cheese, quantity: '2' }],
        expected_revision: 2,
      }),
    );
    await tick(c);
    let queue = Object.fromEntries((await items(c)).map((i) => [i.order_id, i]));
    assert.equal(queue[ok].state, 'applied');
    assert.equal(queue[draft].state, 'blocked');
    assert.equal(queue[draft].reason, 'LINK_NOT_APPROVED');
    assert.deepEqual(queue[draft].detail.problems, [
      {
        code: 'LINK_NOT_APPROVED',
        catalog_key: 'duo',
        name: 'Синтетическое дуо',
        ingredient_id: null,
      },
    ]);
    assert.equal(queue[unlinked].state, 'blocked');
    assert.equal(queue[unlinked].detail.problems[0].catalog_key, 'burger:extra:cheese');
    assert.equal((await consumptionDocuments(c)).length, 1);
    // Not due again before its retry time when nothing changed.
    assert.equal((await tick(c)).processed, 0);
    // The manager approves the cheese link: the next tick retries and applies that order.
    const view = await bo.ops(token, c.branch, 'menu-links', {});
    const cheese = view.items.find((i) => i.catalog_key === 'burger:extra:cheese').link;
    await bo.command(
      token,
      c.branch,
      request({
        type: 'menu_links_approve',
        keys: ['burger:extra:cheese'],
        expected_revisions: { 'burger:extra:cheese': cheese.revision },
      }),
    );
    await tick(c);
    queue = Object.fromEntries((await items(c)).map((i) => [i.order_id, i]));
    assert.equal(queue[unlinked].state, 'applied');
    assert.equal(queue[unlinked].attempts, 2);
    // The duo order: skipped with a reason by the shift manager; the analyst may not.
    const skip = {
      type: 'consumption_skip',
      source: 'pos',
      order_id: draft,
      expected_revision: queue[draft].revision,
    };
    await assert.rejects(
      bo.command(p.analyst.token, c.branch, request(skip)),
      is('FORBIDDEN', undefined),
    );
    await assert.rejects(
      bo.command(p.accountant.token, c.branch, request(skip)),
      is('FORBIDDEN', 'ROLE_FORBIDDEN'),
    );
    await assert.rejects(
      bo.command(p.shift.token, c.branch, request({ ...skip, expected_revision: 99 })),
      is('CONFLICT', undefined),
    );
    const skipped = await bo.command(
      p.shift.token,
      c.branch,
      request(skip, 'Дуо отдали как замену, списали вручную'),
    );
    assert.equal(skipped.state, 'skipped');
    assert.equal(skipped.reason, 'Дуо отдали как замену, списали вручную');
    await assert.rejects(
      bo.command(
        p.shift.token,
        c.branch,
        request({ ...skip, expected_revision: skipped.revision }),
      ),
      is('CONFLICT', undefined),
    );
    // A shortage blocks with what is missing; a receipt makes it due again.
    const empty = (await balances(c))[s.can];
    await stockDocument(bo, token, c, 'waste', [[s.can, empty.quantity]], {
      reason_code: 'damaged',
    });
    const thirsty = await posSale(c, release, { at: ago(5), number: 24, lines: [['cola', 2]] });
    await kitchen(c, thirsty, 'in_production');
    await tick(c);
    queue = Object.fromEntries((await items(c)).map((i) => [i.order_id, i]));
    assert.equal(queue[thirsty].state, 'blocked');
    assert.equal(queue[thirsty].reason, 'INSUFFICIENT_STOCK');
    assert.deepEqual(queue[thirsty].detail.shortages, [
      {
        ingredient_id: s.can,
        name: 'Синтетическая банка колы',
        unit: 'pcs',
        need: '2',
        have: '0',
      },
    ]);
    // «Повторить» by the manager runs the attempt inside the command: still short.
    const retry = {
      type: 'consumption_retry',
      source: 'pos',
      order_id: thirsty,
      expected_revision: queue[thirsty].revision,
    };
    const retried = await bo.command(token, c.branch, request(retry));
    assert.equal(retried.state, 'blocked');
    await receipt(bo, token, c, [[s.can, '24', '480000']]);
    await tick(c);
    assert.equal((await items(c)).find((i) => i.order_id === thirsty).state, 'applied');
    const audit = (
      await c.cloud.pool.query(
        "SELECT action,entity_id FROM bo_audit WHERE branch_id=$1 AND action LIKE 'consumption%' ORDER BY created_at",
        [c.branch],
      )
    ).rows;
    assert.deepEqual(audit, [
      { action: 'consumption_skip', entity_id: draft },
      { action: 'consumption_retry', entity_id: thirsty },
    ]);
    // The mode is the manager's; every role reads the queue and the links.
    const mode = {
      type: 'stock_settings',
      autoconsume_mode: 'off',
      start_at: null,
      expected_revision: 1,
    };
    for (const who of [p.shift, p.accountant])
      await assert.rejects(
        bo.command(who.token, c.branch, request(mode)),
        is('FORBIDDEN', 'ROLE_FORBIDDEN'),
      );
    await assert.rejects(
      bo.command(p.analyst.token, c.branch, request(mode)),
      is('FORBIDDEN', undefined),
    );
    for (const who of [p.shift, p.accountant, p.analyst]) {
      assert.equal((await bo.ops(who.token, c.branch, 'consumption', {})).counts.skipped, 1);
      assert.equal((await bo.ops(who.token, c.branch, 'menu-links', {})).catalog.version, 1);
    }
    // A retry while the mode is off is not run: the item stays as it was.
    const late = await posSale(c, release, { at: ago(2), number: 25, lines: [['duo', 1]] });
    await kitchen(c, late, 'in_production');
    await tick(c);
    const waiting = (await items(c)).find((i) => i.order_id === late);
    assert.equal(waiting.state, 'blocked');
    await bo.command(token, c.branch, request(mode));
    await assert.rejects(
      bo.command(
        token,
        c.branch,
        request({
          type: 'consumption_retry',
          source: 'pos',
          order_id: late,
          expected_revision: waiting.revision,
        }),
      ),
      is('NOT_READY', undefined),
    );
    assert.equal((await items(c)).find((i) => i.order_id === late).revision, waiting.revision);
  }));

test('dry_run writes no documents; switched on later it catches up in sale order from start_at', () =>
  withSyncDatabases(async (c) => {
    const { bo, release, s, token } = await setup(c);
    await linkFixture(bo, token, c, s);
    const day = 24 * 60;
    const start = ago(3 * day);
    // Day-closed sales (no kitchen data at all) on three days, one before start_at.
    const early = await posSale(c, release, { at: ago(4 * day), number: 1, lines: [['fries', 1]] });
    const first = await posSale(c, release, {
      at: ago(2 * day + 60),
      number: 2,
      lines: [['fries', 1]],
    });
    const second = await posSale(c, release, { at: ago(2 * day), number: 3, lines: [['cola', 1]] });
    const third = await posSale(c, release, {
      at: ago(day + 200),
      number: 4,
      lines: [['nuggets', 3]],
    });
    // Today's sale without a kitchen start waits for the day-close pass.
    const today = await posSale(c, release, { at: ago(10), number: 5, lines: [['fries', 1]] });
    const before = await balances(c);
    await settings(bo, token, c, 'dry_run', start, 0);
    // GET branches/:id carries the branch mode for the stock page notice.
    assert.deepEqual((await bo.read(token, c.branch)).stock_settings, {
      autoconsume_mode: 'dry_run',
      start_at: start.toISOString(),
      revision: 1,
    });
    assert.equal(
      'stock_settings' in (await new Backoffice(c.cloud.pool, true, V2).read(token, c.branch)),
      false,
    );
    const preview = await tick(c);
    assert.equal(preview.states.previewed, 3);
    assert.deepEqual(await consumptionDocuments(c), []);
    assert.deepEqual(await balances(c), before);
    let queue = await items(c);
    assert.deepEqual(
      queue.map((i) => [i.order_id, i.state, i.trigger_kind]),
      [
        [first, 'previewed', 'day_close'],
        [second, 'previewed', 'day_close'],
        [third, 'previewed', 'day_close'],
      ],
    );
    // The preview shows the need: 3 nuggets = 100 g x 3 / 3 = 100 g of fillet.
    assert.deepEqual(
      queue[2].detail.needs.map((n) => [n.ingredient_id, n.quantity, n.exact]),
      [[s.chicken, '100', '100/1']],
    );
    // The view in dry_run: counts, coverage of the week, the mode.
    const read = await bo.ops(token, c.branch, 'consumption', {});
    assert.equal(read.settings.autoconsume_mode, 'dry_run');
    assert.equal(read.counts.previewed, 3);
    assert.equal(read.coverage.sold_lines, 5);
    assert.equal(read.coverage.linked_lines, 5);
    assert.equal(read.coverage.share_bp, 10000);
    // Switched on: the previews are applied, oldest sale first; the early one is never taken.
    await settings(bo, token, c, 'on', start, 1);
    await tick(c);
    const docs = await consumptionDocuments(c);
    assert.deepEqual(
      docs.map((d) => d.source_ref),
      [`pos:${first}`, `pos:${second}`, `pos:${third}`],
    );
    for (let i = 1; i < docs.length; i++) assert.ok(docs[i].created_at >= docs[i - 1].created_at);
    queue = await items(c);
    assert.ok(!queue.some((i) => i.order_id === early || i.order_id === today));
    // The day-close pass of tomorrow (03:00 Almaty of the next day) takes today's sale. One day
    // and three hours later is past that pass whatever the time of the run (between 00:00 and
    // 03:00 Almaty one day later is still before it).
    const tomorrow = () => new Date(Date.now() + (day + 3 * 60) * 60000);
    await tick(c, ON, tomorrow);
    assert.equal((await items(c)).find((i) => i.order_id === today).state, 'applied');
    // Back to off: nothing is read, the documents stay.
    await settings(bo, token, c, 'off', null, 2);
    assert.equal((await tick(c)).branches, 0);
    assert.equal((await consumptionDocuments(c)).length, 4);
  }));

test('voids before the kitchen are free, after it they stay written off; counts absorb; manual consume refused', () =>
  withSyncDatabases(async (c) => {
    const { bo, release, s, token } = await setup(c);
    await linkFixture(bo, token, c, s);
    await settings(bo, token, c, 'on', ago(3 * 1440), 0);
    const day = 24 * 60;
    const voidedEarly = await posSale(c, release, {
      at: ago(2 * day),
      number: 31,
      lines: [['fries', 1]],
      voided: ago(2 * day - 5),
    });
    await kitchen(c, voidedEarly, 'cancelled');
    const voidedLate = await posSale(c, release, {
      at: ago(50),
      number: 32,
      lines: [['fries', 1]],
      voided: ago(40),
    });
    await kitchen(c, voidedLate, 'in_production');
    // A count of the buns after the sale: the count already holds what was used.
    const counted = await posSale(c, release, { at: ago(30), number: 33, lines: [['burger', 1]] });
    await stockDocument(bo, token, c, 'count', [[s.bun, '90']]);
    await kitchen(c, counted, 'in_production');
    await tick(c);
    const queue = Object.fromEntries((await items(c)).map((i) => [i.order_id, i]));
    assert.equal(queue[voidedEarly].state, 'not_required');
    assert.equal(queue[voidedEarly].reason, 'CANCELLED_BEFORE_KITCHEN');
    assert.equal(queue[voidedLate].state, 'applied');
    assert.equal(queue[counted].state, 'applied');
    const absorbed = queue[counted].detail.needs.find((n) => n.ingredient_id === s.bun);
    assert.equal(absorbed.absorbed_by_count, true);
    const doc = (await consumptionDocuments(c)).find((d) => d.source_ref === `pos:${counted}`);
    assert.deepEqual(doc.moves, { [s.meat]: '120' });
    assert.equal((await balances(c))[s.bun].quantity, '90');
    // The queue shows the void after the kitchen started: it is not reversed automatically.
    const read = await bo.ops(token, c.branch, 'consumption', { state: 'applied' });
    const late = read.items.find((i) => i.order_id === voidedLate);
    assert.equal(late.refunded, true);
    assert.equal(late.display_number, '32');
    assert.equal(late.reversed, false);
    assert.equal(
      read.items.every((i) => i.state === 'applied'),
      true,
    );
    // A storno of the automatic document is allowed; the item stays applied.
    const lateDoc = (await consumptionDocuments(c)).find(
      (d) => d.source_ref === `pos:${voidedLate}`,
    );
    const rev = Object.fromEntries(
      Object.entries(await balances(c)).map(([k, v]) => [k, v.revision]),
    );
    await bo.command(
      token,
      c.branch,
      request({ type: 'stock_reverse', document_id: lateDoc.id, expected_balances: rev }),
    );
    const after = await bo.ops(token, c.branch, 'consumption', { state: 'applied' });
    assert.equal(after.items.find((i) => i.order_id === voidedLate).reversed, true);
    // A manual consume while the branch writes off automatically.
    await assert.rejects(
      bo.command(
        token,
        c.branch,
        request({ type: 'consume', order_id: randomUUID(), expected_balances: {} }),
      ),
      is('CONFLICT', 'AUTOCONSUME_ACTIVE'),
    );
  }));

test('cloud orders: their catalog version, once per order, kitchen start or day close', () =>
  withSyncDatabases(async (c) => {
    const { bo, s, token } = await setup(c);
    await linkFixture(bo, token, c, s);
    await settings(bo, token, c, 'on', ago(600), 0);
    const app = await cloudOrder(c, {
      at: ago(20),
      lines: [
        ['burger', 1, [['extra', 'sauce']]],
        ['cola', 1],
      ],
      display: 41,
    });
    const waiting = await cloudOrder(c, { at: ago(15), lines: [['fries', 1]], state: 'accepted' });
    await tick(c);
    const docs = await consumptionDocuments(c);
    assert.deepEqual(
      docs.map((d) => [d.source_ref, d.order_id, d.reference]),
      [[`cloud:${app}`, app, 'Заказ №41']],
    );
    assert.deepEqual(docs[0].moves, {
      [s.bun]: '1',
      [s.meat]: '120',
      [s.sauce]: '30',
      [s.can]: '1',
    });
    assert.deepEqual(
      (await items(c)).map((i) => [i.order_id, i.state]),
      [[app, 'applied']],
    );
    await tick(c, ON, () => new Date(Date.now() + 2 * 86400000));
    assert.deepEqual(
      (await items(c)).map((i) => [i.order_id, i.state, i.trigger_kind]),
      [
        [app, 'applied', 'kitchen_started'],
        [waiting, 'applied', 'day_close'],
      ],
    );
  }));

test('least privilege: the worker runs as the API role only with the P1 helper for autoconsume', () =>
  withSyncDatabases(async (c) => {
    const { bo, release, s, token } = await setup(c);
    await linkFixture(bo, token, c, s);
    await settings(bo, token, c, 'on', ago(120), 0);
    const sale = await posSale(c, release, { at: ago(10), number: 51, lines: [['fries', 2]] });
    await kitchen(c, sale, 'in_production');
    const schema = c.cloud.schema;
    const role = 'bo_ac_' + randomUUID().replaceAll('-', '');
    let pool;
    await c.cloud.admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      await c.cloud.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await c.cloud.pool.query(backofficeGrants(role, true));
      const url = new URL(c.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
      pool = createPool(url.toString());
      const P1 = {
        backoffice: true,
        posDay: false,
        stockV2: true,
        autoconsume: false,
        managerShifts: false,
        discounts: false,
      };
      // Stock P1 only: the worker is not ready and reads nothing.
      await c.cloud.pool.query(backofficeP1Grants(role, P1, schema));
      assert.equal((await runStockConsumption(pool, ON)).ready, false);
      await c.cloud.pool.query(backofficeP1Grants(role, { ...P1, autoconsume: true }, schema));
      const done = await runStockConsumption(pool, ON);
      assert.equal(done.ready, true);
      assert.equal(done.errors, 0);
      assert.equal(done.states.applied, 1);
      const caps = (await new Backoffice(pool, true, ON).read(token, c.branch)).capabilities;
      assert.equal(caps.stock_autoconsume, true);
      assert.equal(caps.stock_p1, true);
      const view = await new Backoffice(pool, true, ON).ops(token, c.branch, 'consumption', {});
      assert.equal(view.items[0].display_number, '51');
      // The role cannot delete queue items or forge the settings history.
      await assert.rejects(
        pool.query('DELETE FROM bo_consumption_items'),
        (e) => e.code === '42501',
      );
    } finally {
      await pool?.end();
      await c.cloud.admin.query(`DROP OWNED BY ${role}`);
      await c.cloud.admin.query(`DROP ROLE ${role}`);
    }
    assert.equal((await consumptionDocuments(c)).length, 1);
  }));
