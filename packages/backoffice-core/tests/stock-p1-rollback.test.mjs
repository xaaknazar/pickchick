import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import {
  Backoffice,
  BackofficeError,
  P1_PAYLOAD_RESTORE_SQL,
  P1_PAYLOAD_STASH_SQL,
  Schemas,
  keepStoredFields,
  stripKeptFields,
} from '../dist/index.js';
import { people, receipt, request } from './consumption-fixture.mjs';

/**
 * Review BOUI-R3: a stock P1 rollback leaves cards that can still be saved.
 * - In place (BACKOFFICE_STOCK_V2_ENABLED off, the helper with stockV2 false, or cloud075 rights
 *   missing): the P1 fields of an ingredient (quick_waste, count_daily, group) and of a recipe
 *   (stock_policy) sent back unchanged are not refused, left out they are not wiped, changed they
 *   are refused as before (the employee pattern of positions.ts).
 * - The API image rolled back to the cloud lane build: the owner's stash SQL moves every P1 card
 *   field into a side table, so the cloud lane's strict schemas accept every card again, and the
 *   restore SQL puts them back. The runbook quotes both statements verbatim.
 * Synthetic data only.
 */
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const P1 = { stockV2Enabled: true, rolesEnabled: true, staffPositionsEnabled: true };
const save = (bo, token, c, kind, id, expected_revision, payload) =>
  bo.command(token, c.branch, request({ type: 'save', kind, id, expected_revision, payload }));
const record = async (c, kind, id) =>
  (
    await c.cloud.pool.query(
      'SELECT revision,payload FROM bo_records WHERE branch_id=$1 AND kind=$2 AND id=$3',
      [c.branch, kind, id],
    )
  ).rows[0];

test('keep and strip: only the stored P1 values are dropped, the rest is returned as is', () => {
  const keys = ['quick_waste', 'count_daily', 'group'];
  const old = { name: 'Фри', count_daily: true, group: 'semi' };
  assert.deepEqual(
    stripKeptFields({ name: 'Фри 2', count_daily: true, group: 'semi' }, old, keys),
    {
      name: 'Фри 2',
    },
  );
  // A changed value stays (and the strict schema refuses it); no old card: unchanged input.
  assert.deepEqual(stripKeptFields({ name: 'Фри', group: 'raw' }, old, keys), {
    name: 'Фри',
    group: 'raw',
  });
  const input = { name: 'Фри', group: 'raw' };
  assert.equal(stripKeptFields(input, undefined, keys), input);
  assert.deepEqual(keepStoredFields({ name: 'Фри 3' }, old, keys), {
    name: 'Фри 3',
    count_daily: true,
    group: 'semi',
  });
  const plain = { name: 'Фри' };
  assert.equal(keepStoredFields(plain, { name: 'Фри' }, keys), plain);
});

test('stock P1 rolled back in place: P1 cards are saved, their fields kept, changes refused', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const token = manager.token;
    const on = new Backoffice(c.cloud.pool, true, P1);
    const flour = randomUUID();
    const dough = randomUUID();
    const tiles = {
      quick_waste: { label: 'Мука из мешка', quantity: '500' },
      count_daily: true,
      group: 'raw',
    };
    const flourCard = { name: 'Синтетическая мука', unit: 'g', minimum: '0', active: true };
    await save(on, token, c, 'ingredient', flour, 0, { ...flourCard, ...tiles });
    await save(on, token, c, 'ingredient', dough, 0, {
      name: 'Синтетическое тесто',
      unit: 'g',
      minimum: '0',
      active: true,
    });
    const recipeId = randomUUID();
    const recipe = {
      name: 'Синтетическое тесто',
      product_id: 'ttk:syn-dough',
      output_ingredient_id: dough,
      yield_quantity: '500',
      lines: [{ ingredient_id: flour, quantity: '400' }],
    };
    await save(on, token, c, 'recipe', recipeId, 0, { ...recipe, stock_policy: 'stock' });
    // stock_policy belongs to a production recipe: a menu recipe never carries it.
    await assert.rejects(
      save(on, token, c, 'recipe', randomUUID(), 0, {
        ...recipe,
        product_id: 'ttk:syn-menu',
        output_ingredient_id: null,
        yield_quantity: '1',
        stock_policy: 'explode',
      }),
      is('INVALID_REQUEST', undefined),
    );
    await receipt(on, token, c, [[flour, '10000', '100000']]);

    // Rollback: the flag off (the same holds with stock v2 on and the 075 rights taken away,
    // which is how stockP1Ready decides; that case is covered for reads in stock-p1.test.mjs).
    for (const options of [{}, { rolesEnabled: true }]) {
      const off = new Backoffice(c.cloud.pool, true, options);
      const ingredient = await record(c, 'ingredient', flour);
      // The cabinet sends the stored card back with a new name: accepted, the fields stay.
      const renamed = await save(off, token, c, 'ingredient', flour, ingredient.revision, {
        ...ingredient.payload,
        name: 'Синтетическая мука высшего сорта',
      });
      assert.deepEqual(renamed.payload, {
        ...ingredient.payload,
        name: 'Синтетическая мука высшего сорта',
      });
      for (const [k, v] of Object.entries(tiles)) assert.deepEqual(renamed.payload[k], v, k);
      // An editor that does not know the fields leaves them out: they are not wiped.
      const plain = await save(off, token, c, 'ingredient', flour, renamed.revision, {
        ...flourCard,
        minimum: '1000',
      });
      assert.deepEqual(plain.payload, { ...flourCard, ...tiles, minimum: '1000' });
      // A changed or new P1 value is still refused while stock P1 is off; nothing is written.
      await assert.rejects(
        save(off, token, c, 'ingredient', flour, plain.revision, {
          ...plain.payload,
          group: 'semi',
        }),
        is('INVALID_REQUEST', undefined),
      );
      await assert.rejects(
        save(off, token, c, 'ingredient', randomUUID(), 0, { ...flourCard, count_daily: true }),
        is('INVALID_REQUEST', undefined),
      );
      assert.equal((await record(c, 'ingredient', flour)).revision, plain.revision);
      // The recipe likewise.
      const stored = await record(c, 'recipe', recipeId);
      const recipeSaved = await save(off, token, c, 'recipe', recipeId, stored.revision, {
        ...stored.payload,
        name: 'Синтетическое тесто дрожжевое',
      });
      assert.equal(recipeSaved.payload.stock_policy, 'stock');
      const withoutPolicy = await save(off, token, c, 'recipe', recipeId, recipeSaved.revision, {
        ...recipe,
      });
      assert.equal(withoutPolicy.payload.stock_policy, 'stock');
      await assert.rejects(
        save(off, token, c, 'recipe', recipeId, withoutPolicy.revision, {
          ...recipe,
          stock_policy: 'explode',
        }),
        is('INVALID_REQUEST', undefined),
      );
      // «Производство» of the recipe works while stock P1 is off.
      const b = Object.fromEntries(
        (
          await c.cloud.pool.query(
            'SELECT ingredient_id,revision FROM bo_stock_balances WHERE branch_id=$1',
            [c.branch],
          )
        ).rows.map((r) => [r.ingredient_id, r.revision]),
      );
      const produced = await off.command(
        token,
        c.branch,
        request({
          type: 'produce',
          recipe_id: recipeId,
          recipe_revision: withoutPolicy.revision,
          batches: 1,
          expected_balances: b,
          reference: 'PR-ROLLBACK',
        }),
      );
      assert.equal(produced.kind, 'production');
    }
    // Stock P1 back on: the card is edited as usual, the fields were never lost.
    const back = await record(c, 'ingredient', flour);
    assert.deepEqual(
      Object.fromEntries(Object.keys(tiles).map((k) => [k, back.payload[k]])),
      tiles,
    );
  }));

test('API image rolled back: the owner stashes the P1 fields, the cloud lane schemas accept every card, restore puts them back', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const token = manager.token;
    const on = new Backoffice(c.cloud.pool, true, P1);
    const flour = randomUUID();
    const sugar = randomUUID();
    const dough = randomUUID();
    const recipeId = randomUUID();
    const employee = randomUUID();
    const item = (name, extra = {}) => ({ name, unit: 'g', minimum: '0', active: true, ...extra });
    await save(on, token, c, 'ingredient', flour, 0, item('Синтетическая мука', { group: 'raw' }));
    await save(on, token, c, 'ingredient', sugar, 0, item('Синтетический сахар'));
    await save(
      on,
      token,
      c,
      'ingredient',
      dough,
      0,
      item('Синтетическое тесто', {
        quick_waste: { label: 'Тесто в лотке', quantity: '250' },
        count_daily: true,
      }),
    );
    await save(on, token, c, 'recipe', recipeId, 0, {
      name: 'Синтетическое тесто',
      product_id: 'ttk:syn-dough',
      output_ingredient_id: dough,
      yield_quantity: '500',
      lines: [{ ingredient_id: flour, quantity: '400' }],
      stock_policy: 'stock',
    });
    await save(on, token, c, 'employee', employee, 0, {
      name: 'Синтетическая кассир',
      role: 'cashier',
      active: true,
      note: '',
      position_code: 'cashier',
      pos_access: 'cashier',
    });
    const all = async () =>
      Object.fromEntries(
        (
          await c.cloud.pool.query(
            'SELECT id,kind,revision,payload FROM bo_records WHERE branch_id=$1 ORDER BY id',
            [c.branch],
          )
        ).rows.map((r) => [r.id, r]),
      );
    const before = await all();
    // The cloud lane refuses the P1 cards (its strict schemas, the save and produce parse).
    for (const id of [flour, dough, recipeId, employee])
      assert.equal(
        Schemas[before[id].kind].safeParse(before[id].payload).success,
        false,
        before[id].kind,
      );

    // The schema owner runs the stash in one transaction right before the rollback.
    await c.cloud.pool.query(`BEGIN;\n${P1_PAYLOAD_STASH_SQL}COMMIT;`);
    const stashed = await all();
    for (const [id, row] of Object.entries(stashed)) {
      assert.equal(Schemas[row.kind].safeParse(row.payload).success, true, row.kind);
      // Only the cards with P1 fields changed, each by exactly one revision.
      const moved = [flour, dough, recipeId, employee].includes(id);
      assert.equal(row.revision, before[id].revision + (moved ? 1 : 0), row.kind);
    }
    assert.deepEqual(stashed[sugar], before[sugar]);
    const side = (
      await c.cloud.pool.query(
        'SELECT kind,record_id,stashed_revision,fields,restored_at FROM bo_p1_payload_stash ORDER BY kind,record_id',
      )
    ).rows;
    assert.deepEqual(
      side.map((r) => [r.kind, r.record_id, r.fields, r.restored_at]),
      [
        ['employee', employee, { position_code: 'cashier', pos_access: 'cashier' }, null],
        ...[
          ['ingredient', flour, { group: 'raw' }, null],
          [
            'ingredient',
            dough,
            { quick_waste: { label: 'Тесто в лотке', quantity: '250' }, count_daily: true },
            null,
          ],
        ].sort((a, b) => (a[1] < b[1] ? -1 : 1)),
        ['recipe', recipeId, { stock_policy: 'stock' }, null],
      ],
    );
    // The API role has no right on the side table.
    const grants = (
      await c.cloud.pool.query(
        "SELECT count(*)::int n FROM information_schema.role_table_grants WHERE table_schema=current_schema() AND table_name='bo_p1_payload_stash' AND grantee<>current_user",
      )
    ).rows[0].n;
    assert.equal(grants, 0);
    // Run twice: nothing more to move.
    await c.cloud.pool.query(`BEGIN;\n${P1_PAYLOAD_STASH_SQL}COMMIT;`);
    assert.deepEqual(await all(), stashed);

    // While the cloud lane runs, a card is edited (no P1 field can be set there).
    const off = new Backoffice(c.cloud.pool, true, {});
    await save(off, token, c, 'ingredient', dough, stashed[dough].revision, {
      ...stashed[dough].payload,
      minimum: '2000',
    });

    // The bo-ui build runs again: the owner restores the newest stashed fields.
    await c.cloud.pool.query(`BEGIN;\n${P1_PAYLOAD_RESTORE_SQL}COMMIT;`);
    const restored = await all();
    assert.deepEqual(restored[flour].payload, before[flour].payload);
    assert.deepEqual(restored[recipeId].payload, before[recipeId].payload);
    assert.deepEqual(restored[employee].payload, before[employee].payload);
    assert.deepEqual(restored[dough].payload, { ...before[dough].payload, minimum: '2000' });
    assert.equal(restored[dough].revision, stashed[dough].revision + 2);
    assert.deepEqual(restored[sugar], before[sugar]);
    assert.equal(
      (
        await c.cloud.pool.query(
          'SELECT count(*)::int n FROM bo_p1_payload_stash WHERE restored_at IS NULL',
        )
      ).rows[0].n,
      0,
    );
    // Run twice: nothing changes.
    await c.cloud.pool.query(`BEGIN;\n${P1_PAYLOAD_RESTORE_SQL}COMMIT;`);
    assert.deepEqual(await all(), restored);
    // The bo-ui build edits the card as before.
    const again = await save(on, token, c, 'ingredient', dough, restored[dough].revision, {
      ...restored[dough].payload,
      count_daily: false,
    });
    assert.equal(again.payload.count_daily, false);
  }));

test('the runbook quotes the stash and restore SQL verbatim', async () => {
  const runbook = await readFile(
    new URL('../../../docs/operations/backoffice-p1-cutover.md', import.meta.url),
    'utf8',
  );
  for (const sql of [P1_PAYLOAD_STASH_SQL, P1_PAYLOAD_RESTORE_SQL])
    assert.ok(runbook.includes('```sql\nBEGIN;\n' + sql + 'COMMIT;\n```'), sql.slice(0, 60));
});
