import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../dist/index.js';

/**
 * cloud075 (lane bo-ui, design-bo-ui.md section 3): upgrade from 074 with existing data, every
 * CHECK, index and trigger of the new schema, and the cloud lane runtime on top of it.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
const P1 = '075_cloud_backoffice_ops.sql';
const fails = (code) => (error) => error?.code === code;
const CHECK = fails('23514');
const UNIQUE = fails('23505');
const FK = fails('23503');
const withoutClock = (value) => ({ ...value, as_of: null });
/** The cloud migrations migrate() applies from `first` on (later lanes add files, e.g. 076). */
async function migrationsFrom(first) {
  const names = (await readdir(MIGRATIONS))
    .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name) && name >= first)
    .sort();
  assert.equal(names[0], first);
  return names;
}
/** The storno and source keys stock P1 appends to a document row (stock-p1.ts). */
const P1_LINK_KEYS = [
  'source_ref',
  'reverses_document_id',
  'reversed_by',
  'reversed_at',
  'reverses',
];
/**
 * A snapshot of 075 with stock v2 on, without what stock P1 adds to it (design-bo-ui 2: the
 * existing stock v2 flag carries stock P1 once 075 and its rights are there): capabilities.stock_p1
 * last, counted_at per stock row, and per document reason_code and meta (GET branches/:id) and the
 * storno links. On old rows every added value is the stored one or null.
 */
function withoutStockP1(snapshot, rows) {
  const stored = new Map(rows.map((r) => [r.id, r]));
  const strip = (document, keys) => {
    const copy = { ...document };
    for (const key of keys) {
      if (key === 'reason_code' || key === 'meta')
        assert.deepEqual(copy[key], stored.get(copy.id)[key], key);
      else assert.equal(copy[key], null, key);
      delete copy[key];
    }
    return copy;
  };
  const readV2 = { ...snapshot.readV2, capabilities: { ...snapshot.readV2.capabilities } };
  assert.equal(Object.keys(readV2.capabilities).at(-1), 'stock_p1');
  assert.equal(readV2.capabilities.stock_p1, true);
  delete readV2.capabilities.stock_p1;
  readV2.stock = readV2.stock.map((row) => {
    assert.equal(Object.keys(row).at(-1), 'counted_at');
    assert.equal(row.counted_at, null);
    const copy = { ...row };
    delete copy.counted_at;
    return copy;
  });
  readV2.documents = readV2.documents.map((d) =>
    strip(d, ['reason_code', 'meta', ...P1_LINK_KEYS]),
  );
  const ops = {
    ...snapshot.ops,
    documents: snapshot.ops.documents.map((d) => strip(d, P1_LINK_KEYS)),
  };
  return { ...snapshot, readV2, ops };
}

async function people(c) {
  const manager = await provisionCatalogManager(c.cloud.pool, {
    organization_id: c.org,
    name: 'Синтетический управляющий',
    branch_ids: [c.branch],
  });
  await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
  return { manager };
}
const request = (command, reason = 'Синтетическая проверка 075') => ({
  request_id: randomUUID(),
  reason,
  command,
});
async function ingredient(bo, token, branch, name) {
  const id = randomUUID();
  await bo.command(
    token,
    branch,
    request({
      type: 'save',
      kind: 'ingredient',
      id,
      expected_revision: 0,
      payload: { name, unit: 'g', minimum: '0', active: true },
    }),
  );
  return id;
}
async function revision(c, id) {
  return (
    await c.cloud.pool.query(
      'SELECT revision FROM bo_stock_balances WHERE branch_id=$1 AND ingredient_id=$2',
      [c.branch, id],
    )
  ).rows[0].revision;
}
async function stock(bo, c, token, kind, id, extra = {}, quantity = '100', value = '1000') {
  return bo.command(
    token,
    c.branch,
    request({
      type: 'stock',
      kind,
      reference: 'SYN-' + kind,
      lines: [
        {
          ingredient_id: id,
          quantity,
          value_minor: value,
          expected_revision: await revision(c, id),
        },
      ],
      ...extra,
    }),
  );
}
/** A raw stock document row (the DDL is tested, not the command). */
async function doc(c, actor, fields) {
  const id = fields.id ?? randomUUID();
  await c.cloud.pool.query(
    `INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason,order_id,reason_code,
       source_ref,reverses_document_id) VALUES($1,$2,$3,$4,'SYN-P1','Синтетический документ',$5,$6,$7,$8)`,
    [
      id,
      fields.branch ?? c.branch,
      actor,
      fields.kind,
      fields.order_id ?? null,
      fields.reason_code ?? null,
      fields.source_ref ?? null,
      fields.reverses ?? null,
    ],
  );
  return id;
}
async function olderSchema(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-cloud-074-'));
  try {
    for (const file of await readdir(MIGRATIONS))
      if (/^\d{3}_[a-z_]+\.sql$/.test(file) && file < '075')
        await cp(join(MIGRATIONS, file), join(directory, file));
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
/** A second branch of the same organization (cross-branch references must fail). */
async function otherBranch(c) {
  const id = randomUUID();
  await c.cloud.pool.query(
    "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'SYN2','Synthetic 2')",
    [id, c.org, c.legal],
  );
  return id;
}
/** A cloud order row without the commercial flow (triggers off on one owner connection). */
async function cloudOrder(c) {
  const db = await c.cloud.pool.connect();
  const id = randomUUID();
  try {
    await db.query('SET session_replication_role = replica');
    await db.query(
      `INSERT INTO commerce_orders(id,organization_id,branch_id,principal_id,quote_id,fiscal_account_id,
        snapshot,total_minor,currency,quote_digest) VALUES($1,$2,$3,$4,$5,$6,$7,1000,'KZT',$8)`,
      [id, c.org, c.branch, randomUUID(), randomUUID(), randomUUID(), '{}', 'a'.repeat(64)],
    );
  } finally {
    await db.query('RESET session_replication_role');
    db.release();
  }
  return id;
}

test('075 is applied by migrate(): no digit after the prefix, additive only, no grants', async () => {
  const files = (await readdir(MIGRATIONS)).filter((name) => name.startsWith('075'));
  assert.deepEqual(files, [P1]);
  // packages/database migrate() silently skips any other name (contracts R11).
  assert.match(P1, /^\d{3}_[a-z_]+\.sql$/);
  const sql = await readFile(join(MIGRATIONS, P1), 'utf8');
  assert.doesNotMatch(
    sql,
    /DROP\s+(COLUMN|TABLE|INDEX|TRIGGER|FUNCTION)|DELETE\s+FROM|TRUNCATE|UPDATE\s+bo_/i,
  );
  assert.doesNotMatch(sql, /REFERENCES\s+cloud_pos_/i);
  assert.doesNotMatch(sql, /\bGRANT\b/);
  assert.doesNotMatch(sql, /[—–]/);
});

test('upgrade from 074 with data: documents stay valid, the cloud lane runtime and its payloads are unchanged', () =>
  olderSchema((directory) =>
    withSyncDatabases(
      async (c) => {
        const { manager } = await people(c);
        const token = manager.token;
        const off = new Backoffice(c.cloud.pool, true, {});
        const v2 = new Backoffice(c.cloud.pool, true, { stockV2Enabled: true });
        const flour = await ingredient(off, token, c.branch, 'Синтетическая мука');
        const oil = await ingredient(off, token, c.branch, 'Синтетическое масло');
        await stock(off, c, token, 'receipt', flour);
        await stock(off, c, token, 'receipt', oil);
        // A waste of the cloud lane before stock v2: no reason code.
        await stock(off, c, token, 'waste', flour, {}, '5', '0');
        await stock(v2, c, token, 'waste', flour, { reason_code: 'defect' }, '3', '0');
        await stock(v2, c, token, 'receipt', oil, {
          meta: { supplier_kind: 'bakery', document_date: '2026-11-18' },
        });
        await stock(off, c, token, 'count', oil, {}, '150', '0');
        // Every other kind the 017 CHECK knows, written as raw 074 rows.
        for (const kind of ['production', 'consumption', 'transfer'])
          await c.cloud.pool.query(
            `INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason)
             VALUES($1,$2,$3,$4,'SYN-074','Синтетический документ 074')`,
            [randomUUID(), c.branch, manager.actor_id, kind],
          );
        const window = { view: 'movement', start_date: '2026-11-01', end_date: '2026-12-31' };
        const snapshot = async () => ({
          read: withoutClock(await off.read(token, c.branch)),
          readV2: withoutClock(await v2.read(token, c.branch)),
          ops: withoutClock(await v2.ops(token, c.branch, 'stock', window)),
          documents: (
            await c.cloud.pool.query(
              'SELECT id,branch_id,actor_id,kind,reference,reason,order_id,recipe_snapshot,created_at,reason_code,meta FROM bo_stock_documents ORDER BY id',
            )
          ).rows,
          balances: (
            await c.cloud.pool.query(
              'SELECT branch_id,ingredient_id,ingredient_kind,quantity,value_minor,revision FROM bo_stock_balances ORDER BY ingredient_id',
            )
          ).rows,
        });
        const before = await snapshot();
        assert.equal(before.documents.length, 9);

        // 075 and every later file (lane bo-ui2: 076, which creates new tables only).
        assert.deepEqual(
          await migrate(c.cloud.pool, MIGRATIONS, 'cloud'),
          await migrationsFrom(P1),
        );
        const after = await snapshot();
        // GET branches/:id, GET ops/stock and every old row are byte-identical after 075, except
        // for what stock P1 adds under stock v2 (all of it null or the stored values on old rows).
        assert.deepEqual(after.read, before.read);
        assert.deepEqual(withoutStockP1(after, after.documents), before);
        const fresh = (
          await c.cloud.pool.query(
            'SELECT count(*) FILTER(WHERE source_ref IS NULL AND reverses_document_id IS NULL)::int n, count(*)::int total FROM bo_stock_documents',
          )
        ).rows[0];
        assert.deepEqual(fresh, { n: 9, total: 9 });
        assert.equal(
          (
            await c.cloud.pool.query(
              "SELECT count(*)::int n FROM bo_stock_documents WHERE kind='waste' AND reason_code IS NULL",
            )
          ).rows[0].n,
          1,
          'the old waste without a reason stays',
        );
        assert.equal(
          (
            await c.cloud.pool.query(
              'SELECT count(*)::int n FROM bo_stock_balances WHERE counted_at IS NOT NULL',
            )
          ).rows[0].n,
          0,
        );
        // Every constraint of the widened table is validated against the old rows.
        const invalid = (
          await c.cloud.pool.query(
            "SELECT conname FROM pg_constraint WHERE conrelid IN ('bo_stock_documents'::regclass,'bo_stock_balances'::regclass) AND NOT convalidated",
          )
        ).rows;
        assert.deepEqual(invalid, []);

        // The cloud lane runtime keeps writing on 075: the same commands, the same results.
        await stock(off, c, token, 'waste', flour, {}, '2', '0');
        await stock(off, c, token, 'receipt', flour);
        await stock(off, c, token, 'count', flour, {}, '120', '0');
        await stock(v2, c, token, 'waste', oil, { reason_code: 'meat_expired' }, '1', '0');
        await assert.rejects(stock(v2, c, token, 'waste', oil, {}, '1', '0'), {
          code: 'INVALID_REQUEST',
          reason: 'REASON_REQUIRED',
        });
        const state = await off.read(token, c.branch);
        assert.deepEqual(Object.keys(state), Object.keys(before.read));
        assert.deepEqual(Object.keys(state.capabilities), Object.keys(before.read.capabilities));
        assert.deepEqual(Object.keys(state.documents[0]), Object.keys(before.read.documents[0]));
        assert.equal(state.documents.length, 13);
        // Applying the directory again is a no-op.
        assert.deepEqual(await migrate(c.cloud.pool, MIGRATIONS, 'cloud'), []);
      },
      { cloudMigrationDirectory: directory },
    ),
  ));

test('stock documents: reversal once per document, never of a reversal, same branch; consumption once per order', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const actor = manager.actor_id;
    const bo = new Backoffice(c.cloud.pool, true, {});
    const flour = await ingredient(bo, manager.token, c.branch, 'Синтетическая мука');
    const receipt = (await stock(bo, c, manager.token, 'receipt', flour)).id;
    // Old kinds and the new one; an unknown kind is refused.
    for (const kind of ['receipt', 'waste', 'count', 'production', 'consumption', 'transfer'])
      await doc(c, actor, { kind });
    await assert.rejects(doc(c, actor, { kind: 'bogus' }), CHECK);
    // A reversal names the document it reverses, and only a reversal does.
    await assert.rejects(doc(c, actor, { kind: 'reversal' }), CHECK);
    await assert.rejects(doc(c, actor, { kind: 'waste', reverses: receipt }), CHECK);
    await assert.rejects(doc(c, actor, { kind: 'reversal', reverses: randomUUID() }), FK);
    await assert.rejects(
      doc(c, actor, { kind: 'reversal', reverses: receipt, reason_code: 'defect' }),
      CHECK,
    );
    const order = await cloudOrder(c);
    await assert.rejects(
      doc(c, actor, { kind: 'reversal', reverses: receipt, order_id: order }),
      CHECK,
    );
    const reversal = await doc(c, actor, { kind: 'reversal', reverses: receipt });
    await assert.rejects(doc(c, actor, { kind: 'reversal', reverses: receipt }), UNIQUE);
    await assert.rejects(doc(c, actor, { kind: 'reversal', reverses: reversal }), CHECK);
    // A document of another branch is never reversed here.
    const second = await otherBranch(c);
    const untouched = await doc(c, actor, { kind: 'receipt' });
    await assert.rejects(
      doc(c, actor, { kind: 'reversal', reverses: untouched, branch: second }),
      FK,
    );
    // source_ref: only on consumption, canonical lower-case uuid, pos without order, cloud = order.
    const sale = randomUUID();
    const automatic = await doc(c, actor, { kind: 'consumption', source_ref: `pos:${sale}` });
    await assert.rejects(doc(c, actor, { kind: 'consumption', source_ref: `pos:${sale}` }), UNIQUE);
    await assert.rejects(
      doc(c, actor, { kind: 'waste', source_ref: `pos:${randomUUID()}` }),
      CHECK,
    );
    for (const bad of [
      'pos:abc',
      `pos:${randomUUID().toUpperCase()}`,
      `kiosk:${randomUUID()}`,
      `pos:${randomUUID()}x`,
    ])
      await assert.rejects(doc(c, actor, { kind: 'consumption', source_ref: bad }), CHECK);
    await assert.rejects(
      doc(c, actor, { kind: 'consumption', source_ref: `pos:${randomUUID()}`, order_id: order }),
      CHECK,
    );
    await assert.rejects(
      doc(c, actor, { kind: 'consumption', source_ref: `cloud:${randomUUID()}` }),
      CHECK,
    );
    await assert.rejects(
      doc(c, actor, { kind: 'consumption', source_ref: `cloud:${randomUUID()}`, order_id: order }),
      CHECK,
    );
    await doc(c, actor, { kind: 'consumption', source_ref: `cloud:${order}`, order_id: order });
    // The 017 index still holds: a manual consume of the same cloud order is refused.
    await assert.rejects(doc(c, actor, { kind: 'consumption', order_id: order }), UNIQUE);
    // A consumption may be reversed once like any document; documents stay immutable.
    await doc(c, actor, { kind: 'reversal', reverses: automatic });
    await assert.rejects(
      c.cloud.pool.query("UPDATE bo_stock_documents SET reason='Другая' WHERE id=$1", [receipt]),
      CHECK,
    );
    await assert.rejects(
      c.cloud.pool.query('DELETE FROM bo_stock_documents WHERE id=$1', [reversal]),
      CHECK,
    );
  }));

test('bo_stock_balances.counted_at only moves forward and never blocks the old balance updates', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, {});
    const flour = await ingredient(bo, manager.token, c.branch, 'Синтетическая мука');
    await stock(bo, c, manager.token, 'receipt', flour);
    const set = (value) =>
      c.cloud.pool.query(
        'UPDATE bo_stock_balances SET counted_at=$3 WHERE branch_id=$1 AND ingredient_id=$2',
        [c.branch, flour, value],
      );
    await set('2026-11-18T22:00:00+05:00');
    await set('2026-11-18T22:00:00+05:00');
    await assert.rejects(set('2026-11-18T21:59:59+05:00'), CHECK);
    await assert.rejects(set(null), CHECK);
    await set('2026-11-19T02:00:00+05:00');
    // The cloud lane runtime updates quantity and value without touching counted_at.
    await stock(bo, c, manager.token, 'waste', flour, {}, '10', '0');
    const row = (
      await c.cloud.pool.query(
        'SELECT quantity::text,counted_at FROM bo_stock_balances WHERE branch_id=$1 AND ingredient_id=$2',
        [c.branch, flour],
      )
    ).rows[0];
    assert.equal(row.quantity, '90');
    assert.equal(row.counted_at.toISOString(), '2026-11-18T21:00:00.000Z');
  }));

test('bo_stock_settings: off by default, dry_run and on need start_at, revisions grow by one, never deleted', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const actor = manager.actor_id;
    const insert = (branch, mode, start, revision = 1) =>
      c.cloud.pool.query(
        'INSERT INTO bo_stock_settings(branch_id,autoconsume_mode,start_at,revision,updated_by) VALUES($1,$2,$3,$4,$5)',
        [branch, mode, start, revision, actor],
      );
    await assert.rejects(insert(c.branch, 'dry_run', null), CHECK);
    await assert.rejects(insert(c.branch, 'auto', null), CHECK);
    await assert.rejects(insert(c.branch, 'off', null, 2), CHECK);
    await c.cloud.pool.query(
      'INSERT INTO bo_stock_settings(branch_id,revision,updated_by) VALUES($1,1,$2)',
      [c.branch, actor],
    );
    const row = (await c.cloud.pool.query('SELECT * FROM bo_stock_settings')).rows[0];
    assert.equal(row.autoconsume_mode, 'off');
    assert.equal(row.start_at, null);
    const update = (mode, start, revision) =>
      c.cloud.pool.query(
        'UPDATE bo_stock_settings SET autoconsume_mode=$2,start_at=$3,revision=$4 WHERE branch_id=$1',
        [c.branch, mode, start, revision],
      );
    await assert.rejects(update('on', null, 2), CHECK);
    await assert.rejects(update('dry_run', '2026-11-19T00:00:00+05:00', 1), CHECK);
    await assert.rejects(update('dry_run', '2026-11-19T00:00:00+05:00', 3), CHECK);
    await update('dry_run', '2026-11-19T00:00:00+05:00', 2);
    await update('on', '2026-11-19T00:00:00+05:00', 3);
    await assert.rejects(
      c.cloud.pool.query(
        'UPDATE bo_stock_settings SET branch_id=$2,revision=4 WHERE branch_id=$1',
        [c.branch, await otherBranch(c)],
      ),
      CHECK,
    );
    await assert.rejects(c.cloud.pool.query('DELETE FROM bo_stock_settings'), CHECK);
    await assert.rejects(insert(randomUUID(), 'off', null), FK);
  }));

test('bo_menu_stock_links: slugs, key, effect and lines, approval of exactly the saved lines', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const actor = manager.actor_id;
    const line = [{ ingredient_id: randomUUID(), quantity: '120' }];
    const insert = (fields) =>
      c.cloud.pool.query(
        `INSERT INTO bo_menu_stock_links(branch_id,catalog_key,product_slug,group_slug,option_slug,effect,lines,
           status,revision,updated_by,approved_by,approved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          c.branch,
          fields.key,
          fields.product,
          fields.group ?? null,
          fields.option ?? null,
          fields.effect ?? 'consume',
          JSON.stringify(fields.lines ?? line),
          fields.status ?? 'draft',
          fields.revision ?? 1,
          actor,
          fields.approved_by ?? null,
          fields.approved_at ?? null,
        ],
      );
    await insert({ key: 'pick-burger', product: 'pick-burger' });
    await insert({
      key: 'pick-combo:drink:cola',
      product: 'pick-combo',
      group: 'drink',
      option: 'cola',
    });
    await insert({ key: 'pick-water', product: 'pick-water', effect: 'none', lines: [] });
    await assert.rejects(insert({ key: 'pick-burger', product: 'pick-burger' }), UNIQUE);
    for (const bad of [
      { key: 'other', product: 'pick-fries' },
      { key: 'pick-fries:drink', product: 'pick-fries', group: 'drink' },
      { key: 'Pick-Fries', product: 'Pick-Fries' },
      { key: 'pick-fries', product: 'pick-fries', effect: 'none' },
      { key: 'pick-fries', product: 'pick-fries', lines: [] },
      { key: 'pick-fries', product: 'pick-fries', lines: { ingredient_id: 'x' } },
      {
        key: 'pick-fries',
        product: 'pick-fries',
        lines: Array.from({ length: 51 }, () => line[0]),
      },
      { key: 'pick-fries', product: 'pick-fries', effect: 'skip' },
      { key: 'pick-fries', product: 'pick-fries', status: 'approved' },
      { key: 'pick-fries', product: 'pick-fries', approved_by: actor, approved_at: new Date() },
      { key: 'pick-fries', product: 'pick-fries', revision: 2 },
    ])
      await assert.rejects(insert(bad), CHECK, JSON.stringify(bad));
    await insert({
      key: 'pick-fries',
      product: 'pick-fries',
      lines: Array.from({ length: 50 }, () => line[0]),
    });
    const q = (sql, args = []) => c.cloud.pool.query(sql, [c.branch, ...args]);
    // Approve exactly the saved lines.
    await q(
      "UPDATE bo_menu_stock_links SET status='approved',approved_by=$2,approved_at=now(),revision=2 WHERE branch_id=$1 AND catalog_key='pick-burger'",
      [actor],
    );
    // A content change of an approved link without going back to draft, or an approval that
    // changes the lines, is refused.
    await assert.rejects(
      q(
        'UPDATE bo_menu_stock_links SET lines=\'[{"ingredient_id":"x","quantity":"1"}]\',revision=3 WHERE branch_id=$1 AND catalog_key=\'pick-burger\'',
      ),
      CHECK,
    );
    await assert.rejects(
      q(
        "UPDATE bo_menu_stock_links SET status='approved',approved_by=$2,approved_at=now(),effect='none',lines='[]',revision=2 WHERE branch_id=$1 AND catalog_key='pick-combo:drink:cola'",
        [actor],
      ),
      CHECK,
    );
    await q(
      "UPDATE bo_menu_stock_links SET status='draft',approved_by=NULL,approved_at=NULL,effect='none',lines='[]',revision=3 WHERE branch_id=$1 AND catalog_key='pick-burger'",
    );
    await assert.rejects(
      q(
        "UPDATE bo_menu_stock_links SET revision=5 WHERE branch_id=$1 AND catalog_key='pick-burger'",
      ),
      CHECK,
    );
    await assert.rejects(
      q(
        "UPDATE bo_menu_stock_links SET catalog_key='pick-burger2',product_slug='pick-burger2',revision=4 WHERE branch_id=$1 AND catalog_key='pick-burger'",
      ),
      CHECK,
    );
    await assert.rejects(q('DELETE FROM bo_menu_stock_links WHERE branch_id=$1'), CHECK);
  }));

test('bo_consumption_items: transitions, final states and the one consumption document of the order', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const actor = manager.actor_id;
    const insert = (order, fields = {}) =>
      c.cloud.pool.query(
        `INSERT INTO bo_consumption_items(branch_id,source,order_id,sold_at,state,reason,document_id,trigger_kind,revision)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          c.branch,
          fields.source ?? 'pos',
          order,
          '2026-11-19T12:00:00+05:00',
          fields.state ?? 'pending',
          fields.reason ?? null,
          fields.document ?? null,
          fields.trigger ?? 'kitchen_started',
          fields.revision ?? 1,
        ],
      );
    const update = (order, set, args = []) =>
      c.cloud.pool.query(
        `UPDATE bo_consumption_items SET ${set},revision=revision+1 WHERE branch_id=$1 AND order_id=$2`,
        [c.branch, order, ...args],
      );
    const sale = randomUUID();
    await insert(sale);
    await assert.rejects(insert(sale), UNIQUE);
    await assert.rejects(insert(randomUUID(), { revision: 2 }), CHECK);
    await assert.rejects(insert(randomUUID(), { source: 'kiosk' }), CHECK);
    await assert.rejects(insert(randomUUID(), { trigger: 'manual' }), CHECK);
    await assert.rejects(insert(randomUUID(), { state: 'blocked' }), CHECK);
    await assert.rejects(insert(randomUUID(), { state: 'applied' }), CHECK);
    // Non-final states move freely; blocked needs a reason.
    await update(sale, "state='previewed',detail='{\"need\":[]}'");
    await assert.rejects(update(sale, "state='blocked'"), CHECK);
    await update(
      sale,
      "state='blocked',reason='INSUFFICIENT_STOCK',attempts=1,next_attempt_at=now()",
    );
    await update(sale, "state='pending',reason=NULL");
    await assert.rejects(
      c.cloud.pool.query(
        "UPDATE bo_consumption_items SET state='previewed' WHERE branch_id=$1 AND order_id=$2",
        [c.branch, sale],
      ),
      CHECK,
      'the revision grows by one',
    );
    await assert.rejects(update(sale, "sold_at='2026-11-19T13:00:00+05:00'"), CHECK);
    await assert.rejects(update(sale, "trigger_kind='day_close'"), CHECK);
    // applied only with the consumption document of exactly this order.
    const waste = await doc(c, actor, { kind: 'waste' });
    const otherSale = await doc(c, actor, {
      kind: 'consumption',
      source_ref: `pos:${randomUUID()}`,
    });
    const own = await doc(c, actor, { kind: 'consumption', source_ref: `pos:${sale}` });
    await assert.rejects(update(sale, "state='applied'"), CHECK);
    await assert.rejects(update(sale, "state='applied',document_id=$3", [waste]), CHECK);
    await assert.rejects(update(sale, "state='applied',document_id=$3", [otherSale]), CHECK);
    await assert.rejects(update(sale, "state='pending',document_id=$3", [own]), CHECK);
    await assert.rejects(update(sale, "state='applied',document_id=$3", [randomUUID()]), CHECK);
    await update(sale, "state='applied',document_id=$3", [own]);
    // Final: no change at all, not even the revision; never deleted.
    await assert.rejects(update(sale, "state='pending',document_id=NULL"), CHECK);
    await assert.rejects(update(sale, 'attempts=attempts+1'), CHECK);
    await assert.rejects(
      c.cloud.pool.query('DELETE FROM bo_consumption_items WHERE order_id=$1', [sale]),
      CHECK,
    );
    // skipped and not_required are final and carry a reason.
    for (const final of ['skipped', 'not_required']) {
      const order = randomUUID();
      await insert(order);
      await assert.rejects(update(order, `state='${final}'`), CHECK);
      await update(order, `state='${final}',reason='Синтетическая причина'`);
      await assert.rejects(update(order, "state='pending'"), CHECK);
    }
    const counts = (
      await c.cloud.pool.query(
        'SELECT state,count(*)::int n FROM bo_consumption_items GROUP BY state ORDER BY state',
      )
    ).rows;
    assert.deepEqual(counts, [
      { state: 'applied', n: 1 },
      { state: 'not_required', n: 1 },
      { state: 'skipped', n: 1 },
    ]);
    // The same order id from the other source is another item (and another document).
    await insert(sale, { source: 'cloud', trigger: 'day_close' });
  }));

test('bo_manager_shifts: one open per branch, Almaty business day of the opening, closed is immutable', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const actor = manager.actor_id;
    const employee = randomUUID();
    await c.cloud.pool.query(
      `INSERT INTO bo_records(id,branch_id,organization_id,kind,revision,payload)
       VALUES($1,$2,$3,'employee',1,'{"name":"Синтетический менеджер","role":"manager","active":true,"note":""}')`,
      [employee, c.branch, c.org],
    );
    const open = (fields = {}) =>
      c.cloud.pool.query(
        `INSERT INTO bo_manager_shifts(id,branch_id,business_date,manager_employee_id,opened_at,opening,
           template_version,revision,opened_by) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8)`,
        [
          fields.id ?? randomUUID(),
          fields.branch ?? c.branch,
          fields.day ?? '2026-11-18',
          fields.employee === undefined ? employee : fields.employee,
          fields.at ?? '2026-11-18T23:00:00+05:00',
          JSON.stringify(fields.opening ?? { items: [] }),
          fields.revision ?? 1,
          actor,
        ],
      );
    // The business day is the Almaty date of the opening.
    await assert.rejects(open({ day: '2026-11-19' }), CHECK);
    await assert.rejects(open({ at: '2026-11-18T19:30:00Z' }), CHECK, '00:30 in Almaty is 19.11');
    await assert.rejects(open({ employee: randomUUID() }), FK);
    await assert.rejects(open({ opening: ['not', 'an', 'object'] }), CHECK);
    await assert.rejects(open({ revision: 2 }), CHECK);
    const shift = randomUUID();
    await open({ id: shift });
    // At most one open shift per branch; another branch has its own.
    await assert.rejects(open(), UNIQUE);
    await open({ branch: await otherBranch(c), employee: null });
    const update = (set, args = []) =>
      c.cloud.pool.query(
        `UPDATE bo_manager_shifts SET ${set},revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,
        [shift, ...args],
      );
    await update(`closing='{"items":[],"handover":""}'`);
    await assert.rejects(update("business_date='2026-11-17'"), CHECK);
    await assert.rejects(update("opened_at='2026-11-18T22:00:00+05:00'"), CHECK);
    await assert.rejects(update("state='closed'"), CHECK);
    await assert.rejects(update("state='closed',closed_at='2026-11-19T01:30:00+05:00'"), CHECK);
    const close = (handover, at = '2026-11-19T01:30:00+05:00') =>
      update(`state='closed',closed_at=$2,closed_by=$3,closing=$4`, [
        at,
        actor,
        JSON.stringify({ items: [{ code: 'cash_handed', status: 'done' }], handover }),
      ]);
    await assert.rejects(close('  '), CHECK, 'a handover text is required');
    await assert.rejects(close('Смена сдана', '2026-11-18T22:59:00+05:00'), CHECK);
    // Closed after midnight: still the business day of the opening.
    await close('Смена сдана, касса закрыта');
    const row = (
      await c.cloud.pool.query(
        'SELECT business_date::text,state,revision FROM bo_manager_shifts WHERE id=$1',
        [shift],
      )
    ).rows[0];
    assert.deepEqual(row, { business_date: '2026-11-18', state: 'closed', revision: 3 });
    await assert.rejects(update(`closing='{"handover":"Исправлено задним числом"}'`), CHECK);
    await assert.rejects(update('manager_employee_id=NULL'), CHECK);
    await assert.rejects(
      c.cloud.pool.query('DELETE FROM bo_manager_shifts WHERE id=$1', [shift]),
      CHECK,
    );
    // After the close the next shift may open.
    await open({ at: '2026-11-19T09:00:00+05:00', day: '2026-11-19' });
  }));

test('bo_discounts: amount or percent, live names, archived is final, every revision in the history', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const actor = manager.actor_id;
    const insert = (fields = {}) =>
      c.cloud.pool.query(
        `INSERT INTO bo_discounts(id,branch_id,name,kind,value_minor,percent_bp,scope,schedule,state,revision,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [
          fields.id ?? randomUUID(),
          c.branch,
          fields.name ?? 'Синтетическая скидка',
          fields.kind ?? 'percent',
          fields.value ?? null,
          fields.percent === undefined ? 1000 : fields.percent,
          JSON.stringify(fields.scope ?? { categories: [], products: [], channels: ['hall'] }),
          JSON.stringify(fields.schedule ?? { weekdays: [1, 2, 3, 4, 5], hours: [] }),
          fields.state ?? 'draft',
          fields.revision ?? 1,
          actor,
        ],
      );
    for (const bad of [
      { kind: 'amount' },
      { kind: 'amount', value: 50000 },
      { kind: 'percent', percent: null },
      { percent: 0 },
      { percent: 10001 },
      { kind: 'amount', value: 0, percent: null },
      { kind: 'gift', percent: null, value: 100 },
      { name: '' },
      { name: ' Скидка' },
      { name: 'я'.repeat(81) },
      { scope: ['hall'] },
      { schedule: 'always' },
      { state: 'published' },
      { revision: 2 },
    ])
      await assert.rejects(insert({ ...bad }), CHECK, JSON.stringify(bad));
    const id = randomUUID();
    await insert({ id, name: 'Студенческая' });
    await insert({
      kind: 'amount',
      value: 50000,
      percent: null,
      name: 'Минус 500',
      state: 'active',
    });
    await insert({ name: 'я'.repeat(80) });
    // Two live discounts of a branch never share a name, whatever the case.
    await assert.rejects(insert({ name: 'студенческая' }), UNIQUE);
    const update = (set, args = []) =>
      c.cloud.pool.query(
        `UPDATE bo_discounts SET ${set},revision=revision+1,updated_by=$2,updated_at=clock_timestamp() WHERE id=$1`,
        [id, actor, ...args],
      );
    await update("percent_bp=1500,state='active'");
    await assert.rejects(update("kind='amount'"), CHECK);
    await assert.rejects(update('created_by=$3', [randomUUID()]), CHECK);
    await assert.rejects(update("created_at='2026-01-01T00:00:00Z'"), CHECK);
    await assert.rejects(
      c.cloud.pool.query('UPDATE bo_discounts SET percent_bp=1600 WHERE id=$1', [id]),
      CHECK,
      'the revision grows by one',
    );
    await update("state='archived'");
    await assert.rejects(update("state='active'"), CHECK);
    await assert.rejects(update("name='Студенческая 2'"), CHECK);
    await assert.rejects(c.cloud.pool.query('DELETE FROM bo_discounts WHERE id=$1', [id]), CHECK);
    // The archived name is free again.
    await insert({ name: 'Студенческая' });
    // The trigger kept every revision: snapshot, author, time.
    const history = (
      await c.cloud.pool.query(
        `SELECT revision,snapshot->>'state' state,snapshot->>'percent_bp' percent,changed_by=$2 by_actor,
           (snapshot->>'revision')::int=revision same_revision
         FROM bo_discount_revisions WHERE discount_id=$1 ORDER BY revision`,
        [id, actor],
      )
    ).rows;
    assert.deepEqual(history, [
      { revision: 1, state: 'draft', percent: '1000', by_actor: true, same_revision: true },
      { revision: 2, state: 'active', percent: '1500', by_actor: true, same_revision: true },
      { revision: 3, state: 'archived', percent: '1500', by_actor: true, same_revision: true },
    ]);
    assert.equal(
      (await c.cloud.pool.query('SELECT count(*)::int n FROM bo_discount_revisions')).rows[0].n,
      6,
    );
    await assert.rejects(
      c.cloud.pool.query("UPDATE bo_discount_revisions SET snapshot='{}'"),
      CHECK,
    );
    await assert.rejects(c.cloud.pool.query('DELETE FROM bo_discount_revisions'), CHECK);
  }));
