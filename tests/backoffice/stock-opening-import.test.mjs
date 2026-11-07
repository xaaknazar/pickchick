import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  CHUNK_LINES,
  UsageError,
  applyPlan,
  decimalUnits,
  parseArguments,
  parseCsv,
  planHash,
  planOpening,
  preflight,
  readOpeningCsv,
  verifyApplied,
} from '../../scripts/stock-opening-import.mjs';
import { stockEffect } from '../../packages/backoffice-core/dist/index.js';

/**
 * Cutover CC-8 without a database: CSV reading, exact decimals, matching, the plan with its
 * hash and chunks, the live-stock preflight and a replay after a lost answer against an
 * in-memory copy of the back-office count rule (stockEffect). Synthetic data only.
 */
const branch = randomUUID();
const csv = (...lines) => Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
const ingredient = (name, unit, balance = {}) => ({
  id: randomUUID(),
  payload: { name, unit, minimum: '0', active: balance.active ?? true },
  quantity: balance.quantity ?? '0',
  value_minor: balance.value ?? '0',
  revision: balance.revision ?? 0,
});
const snapshotOf = (stock, extra = {}) => ({
  schema_version: 1,
  branch_id: branch,
  role: 'manager',
  stock,
  ...extra,
});

test('CSV: quotes, CRLF, BOM, delimiters and aliases; not UTF-8 is refused', () => {
  assert.deepEqual(
    parseCsv('a;"b;c";"d ""x"""\n1;"2\n3";4', ';').map((r) => [r.line, r.cells]),
    [
      [1, ['a', 'b;c', 'd "x"']],
      [2, ['1', '2\n3', '4']],
    ],
  );
  const semicolon = readOpeningCsv(
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      csv('Наименование;Количество;Ед;Сумма;Группа', 'Синтетическое филе;1,5;кг;3 000,50;Мясо'),
    ]),
  );
  assert.equal(semicolon.delimiter, ';');
  assert.deepEqual(semicolon.ignored, ['Группа']);
  assert.deepEqual(semicolon.rows, [
    {
      line: 2,
      ingredient_id: '',
      name: 'Синтетическое филе',
      quantity: '1,5',
      unit: 'кг',
      total_value_tenge: '3 000,50',
    },
  ]);
  assert.equal(
    readOpeningCsv(csv('name\tquantity\tunit\ttotal_value_tenge', 'x\t1\tшт\t1')).delimiter,
    '\t',
  );
  assert.equal(
    readOpeningCsv(csv('name,quantity,unit,total_value_tenge', 'x,1,шт.,1')).rows[0].unit,
    'шт',
  );
  // «Синтетика» in Windows-1251 is not UTF-8.
  assert.throws(
    () =>
      readOpeningCsv(
        Buffer.concat([csv('name;quantity;unit;total_value_tenge'), Buffer.from([0xd1, 0xe8])]),
      ),
    { code: 'CSV_ENCODING' },
  );
  for (const header of [
    'name;quantity;unit',
    'quantity;unit;total_value_tenge',
    'name;name;quantity;unit;total_value_tenge',
  ])
    assert.throws(() => readOpeningCsv(csv(header, 'x;1;шт;1')), { code: 'CSV_HEADER' });
  assert.throws(() => readOpeningCsv(csv('name;quantity;unit;total_value_tenge')), {
    code: 'CSV_INVALID',
  });
});

test('exact decimals: kilograms to grams, tenge to tiyn, never rounded', () => {
  assert.equal(decimalUnits('1,5', 3), 1500n);
  assert.equal(decimalUnits('1 234,567', 3), 1234567n);
  assert.equal(decimalUnits('1 234', 0), 1234n);
  assert.equal(decimalUnits('0.250', 3), 250n);
  assert.equal(decimalUnits('-2', 3), -2000n);
  assert.equal(decimalUnits('12,5', 2), 1250n);
  assert.equal(decimalUnits('12,50', 2), 1250n);
  for (const [value, scale] of [
    ['0,0005', 3],
    ['1,5', 0],
    ['12,345', 2],
    ['1e3', 0],
    ['', 0],
    ['abc', 0],
    ['1000000000000', 3],
  ])
    assert.throws(() => decimalUnits(value, scale), Error, `${value}/${scale}`);
});

test('plan: matching, units, required cost, negatives and every row error', () => {
  const fillet = ingredient('Синтетическое филе', 'g');
  const bun = ingredient('Синтетическая булка', 'pcs');
  const oil = ingredient('Синтетическое масло', 'ml');
  const twinA = ingredient('Синтетический соус', 'g');
  const twinB = ingredient('Синтетический  СОУС', 'g');
  const archived = ingredient('Синтетическая ёмкость', 'pcs', { active: false });
  const salt = ingredient('Синтетическая соль', 'g');
  const plan = planOpening({
    csvBytes: csv(
      'ingredient_id;name;quantity;unit;total_value_tenge',
      `;  синтетическое   ФИЛЕ ;12,5;кг;25 000,00`,
      `${bun.id};Синтетическая булка;40;шт;4000`,
      `;Синтетическое масло;-3;л;-900`,
      `;Синтетический соус;1;кг;100`,
      `;Синтетическая емкость;1;шт;1`,
      `;Синтетическая соль;1;шт;1`,
      `;Синтетический перец;1;г;1`,
      `${fillet.id};Синтетическая булка;1;кг;1`,
      `;Синтетическая булка;1;шт;1`,
      `${salt.id};;2;кг;`,
      `${salt.id};;2;кг;0`,
      `${salt.id};;0;кг;5`,
      `${salt.id};;2,0001;кг;5`,
      `${salt.id};;2;кг;5,555`,
      `${salt.id};;2;пачка;5`,
      `not-a-uuid;;2;кг;5`,
    ),
    csvName: 'inventory-18-11.csv',
    snapshot: snapshotOf([fillet, bun, oil, twinA, twinB, archived, salt]),
    branch,
  });
  assert.deepEqual(
    plan.errors.map((e) => [e.line, e.code]),
    [
      [5, 'NAME_AMBIGUOUS'],
      [6, 'INGREDIENT_INACTIVE'],
      [7, 'UNIT_MISMATCH'],
      [8, 'NOT_FOUND'],
      [9, 'NAME_MISMATCH'],
      [10, 'DUPLICATE'],
      [11, 'DUPLICATE'],
      [12, 'DUPLICATE'],
      [13, 'DUPLICATE'],
      [14, 'DUPLICATE'],
      [15, 'DUPLICATE'],
      [16, 'DUPLICATE'],
      [17, 'ID_INVALID'],
    ],
  );
  assert.equal(plan.plan_sha256, null, 'a plan with errors is never applied');
  assert.deepEqual(
    plan.lines.map((l) => [l.name, l.quantity, l.value_minor, l.action, l.negative_source]),
    [
      ['Синтетическое филе', '12500', '2500000', 'set', false],
      ['Синтетическая булка', '40', '400000', 'set', false],
      ['Синтетическое масло', '0', '0', 'unchanged', true],
    ],
  );
  assert.deepEqual(
    plan.issues.map((i) => [i.line, i.code]),
    [[4, 'NEGATIVE_NOT_TRANSFERRED']],
  );
  assert.match(plan.errors[0].message, /укажите ingredient_id/);
  // Each value rule on its own (one row per file, so no duplicates hide them).
  const one = (row) =>
    planOpening({
      csvBytes: csv('ingredient_id;quantity;unit;total_value_tenge', `${salt.id};${row}`),
      snapshot: snapshotOf([salt]),
      branch,
    }).errors.map((e) => e.code);
  assert.deepEqual(one('2;кг;'), ['COST_REQUIRED']);
  assert.deepEqual(one('2;кг;0'), ['COST_REQUIRED']);
  assert.deepEqual(one('0;кг;5'), ['VALUE_WITHOUT_QUANTITY']);
  assert.deepEqual(one('2,0001;кг;5'), ['QUANTITY_INVALID']);
  assert.deepEqual(one('2;кг;5,555'), ['VALUE_INVALID']);
  assert.deepEqual(one('2;кг;-5'), ['VALUE_INVALID']);
  assert.deepEqual(one('2;пачка;5'), ['UNIT_INVALID']);
  assert.deepEqual(one('2;г;5'), []);
  assert.deepEqual(one('0;кг;0'), [], 'an empty balance that stays empty');
});

test('plan: chunks of 100 lines, deterministic ids and hash, existing balances', () => {
  const stock = Array.from({ length: 250 }, (_, i) =>
    ingredient(`Синтетическая позиция ${String(i).padStart(3, '0')}`, 'pcs'),
  );
  const full = ingredient('Синтетическая булка', 'pcs', {
    quantity: '7',
    value: '7000',
    revision: 4,
  });
  const rows = [
    'name;quantity;unit;total_value_tenge',
    ...stock.map((s, i) => `${s.payload.name};${i + 1};шт;${i + 1}0`),
    'Синтетическая булка;20;шт;2500',
  ];
  const snapshot = snapshotOf([...stock, full]);
  const args = { csvBytes: csv(...rows), csvName: 'inventory.csv', snapshot, branch };
  const refused = planOpening(args);
  assert.deepEqual(
    refused.errors.map((e) => [e.line, e.code]),
    [[252, 'EXISTING_BALANCE']],
  );
  assert.match(refused.errors[0].message, /--zero-existing/);
  const plan = planOpening({ ...args, zeroExisting: true });
  assert.deepEqual(plan.errors, []);
  assert.match(plan.plan_sha256, /^[0-9a-f]{64}$/);
  assert.equal(plan.plan_sha256, planHash(plan));
  assert.deepEqual(
    plan.chunks.map((c) => [c.phase, c.index, c.body.command.lines.length]),
    [
      ['zero', 1, 1],
      ['set', 1, CHUNK_LINES],
      ['set', 2, CHUNK_LINES],
      ['set', 3, 51],
    ],
  );
  const [zero, first, , last] = plan.chunks;
  assert.deepEqual(zero.body.command.lines, [
    { ingredient_id: full.id, quantity: '0', value_minor: '0', expected_revision: 4 },
  ]);
  assert.deepEqual(last.body.command.lines.at(-1), {
    ingredient_id: full.id,
    quantity: '20',
    value_minor: '250000',
    expected_revision: 5,
  });
  assert.deepEqual(first.body.command.lines[0], {
    ingredient_id: stock[0].id,
    quantity: '1',
    value_minor: '1000',
    expected_revision: 0,
  });
  for (const c of plan.chunks) {
    assert.equal(c.body.command.type, 'stock');
    assert.equal(c.body.command.kind, 'count');
    assert.equal(c.body.request_id, c.request_id);
    assert.ok(c.body.reason.length >= 3 && c.body.reason.length <= 500, c.body.reason);
    assert.ok(c.body.command.reference.length <= 200);
    assert.match(c.body.reason, new RegExp(plan.plan_core_sha256));
  }
  assert.equal(new Set(plan.chunks.map((c) => c.request_id)).size, 4);
  assert.match(first.body.command.reference, /^Начальные остатки [0-9a-f]{12} 1\/3$/);
  assert.match(zero.body.command.reference, /^Обнуление перед начальными остатками/);
  assert.deepEqual(first.lines.slice(0, 2), [2, 3]);
  assert.equal(plan.summary.total_value_minor, (BigInt(31375 * 1000) + 250000n).toString());
  assert.deepEqual(
    [plan.summary.set, plan.summary.zero_then_set, plan.summary.documents],
    [250, 1, 4],
  );
  // Same inputs, same plan; any input change, another plan.
  assert.equal(planOpening({ ...args, zeroExisting: true }).plan_sha256, plan.plan_sha256);
  for (const other of [
    { ...args, csvBytes: csv(...rows.slice(0, -1), 'Синтетическая булка;20;шт;2500,01') },
    { ...args, zeroExisting: true, snapshot: snapshotOf([...stock, { ...full, revision: 5 }]) },
    { ...args, zeroExisting: true, csvName: 'other.csv' },
  ])
    assert.notEqual(planOpening({ zeroExisting: true, ...other }).plan_sha256, plan.plan_sha256);
  // Ingredients not in the file keep their balance and are listed.
  const extra = ingredient('Синтетический лук', 'g', {
    quantity: '500',
    value: '100',
    revision: 1,
  });
  const listed = planOpening({
    ...args,
    zeroExisting: true,
    snapshot: snapshotOf([...stock, full, extra]),
  });
  assert.deepEqual(
    listed.not_in_file.map((i) => i.name),
    ['Синтетический лук'],
  );
  // A role without the count right never gets a plan.
  assert.throws(() => planOpening({ ...args, snapshot: snapshotOf(stock, { role: 'analyst' }) }), {
    code: 'FORBIDDEN',
  });
  assert.throws(
    () =>
      planOpening({
        ...args,
        snapshot: snapshotOf(stock, { role: 'analyst', permissions: ['reports.read'] }),
      }),
    { code: 'FORBIDDEN' },
  );
  assert.doesNotThrow(() =>
    planOpening({
      ...args,
      snapshot: snapshotOf(stock, { role: 'analyst', permissions: ['stock.count'] }),
    }),
  );
});

/** In-memory back office: count documents with the real stockEffect and request_id replay. */
function fakeBackoffice(stock) {
  const balances = new Map(
    stock.map((s) => [
      s.id,
      { quantity: s.quantity, value_minor: s.value_minor, revision: s.revision },
    ]),
  );
  const commands = new Map();
  let documents = 0;
  return {
    balances,
    documents: () => documents,
    snapshot: () =>
      snapshotOf(
        stock.map((s) => ({
          ...s,
          quantity: balances.get(s.id).quantity,
          value_minor: balances.get(s.id).value_minor,
          revision: balances.get(s.id).revision,
        })),
      ),
    async request(path, body) {
      if (body === undefined) return this.snapshot();
      const previous = commands.get(body.request_id);
      if (previous) {
        if (previous.digest !== JSON.stringify(body)) throw new Error('CONFLICT');
        return previous.result;
      }
      for (const line of body.command.lines)
        if (balances.get(line.ingredient_id).revision !== line.expected_revision)
          throw new Error('CONFLICT');
      for (const line of body.command.lines) {
        const b = balances.get(line.ingredient_id);
        const e = stockEffect('count', b, line);
        balances.set(line.ingredient_id, {
          quantity: e.quantity,
          value_minor: e.value_minor,
          revision: b.revision + 1,
        });
      }
      documents++;
      const result = { id: randomUUID(), kind: 'count', reference: body.command.reference };
      commands.set(body.request_id, { digest: JSON.stringify(body), result });
      return result;
    },
  };
}

test('apply: preflight, a lost answer, repeats without duplicates, stale plans refused', async () => {
  const a = ingredient('Синтетическое филе', 'g');
  const b = ingredient('Синтетическая булка', 'pcs', { quantity: '3', value: '999', revision: 2 });
  const office = fakeBackoffice([a, b]);
  const bytes = csv(
    'name;quantity;unit;total_value_tenge',
    'Синтетическое филе;2;кг;4000',
    'Синтетическая булка;10;шт;1500',
  );
  const plan = planOpening({
    csvBytes: bytes,
    snapshot: office.snapshot(),
    branch,
    zeroExisting: true,
  });
  assert.equal(preflight(plan, office.snapshot()).remaining.length, 2);
  await assert.rejects(
    applyPlan({ plan, expectedPlan: '0'.repeat(64), request: (p, x) => office.request(p, x) }),
    { code: 'PLAN_MISMATCH' },
  );
  await assert.rejects(
    applyPlan({
      plan: { ...plan, zero_existing: false },
      expectedPlan: plan.plan_sha256,
      request: (p, x) => office.request(p, x),
    }),
    { code: 'PLAN_INVALID' },
  );
  assert.equal(office.documents(), 0);
  // The zero document is applied, then its answer is lost.
  let lose = true;
  const flaky = async (path, body) => {
    const result = await office.request(path, body);
    if (body && lose) {
      lose = false;
      throw new Error('API_UNREACHABLE');
    }
    return result;
  };
  await assert.rejects(
    applyPlan({ plan, expectedPlan: plan.plan_sha256, request: flaky }),
    /API_UNREACHABLE/,
  );
  assert.equal(office.documents(), 1);
  assert.equal(preflight(plan, office.snapshot()).state.get(b.id), 'zeroed');
  const done = await applyPlan({
    plan,
    expectedPlan: plan.plan_sha256,
    request: (p, x) => office.request(p, x),
  });
  assert.deepEqual(done, {
    plan_sha256: plan.plan_sha256,
    sent: 1,
    skipped: 1,
    documents: 2,
    verified: true,
  });
  assert.equal(office.documents(), 2);
  assert.deepEqual(office.balances.get(a.id), {
    quantity: '2000',
    value_minor: '400000',
    revision: 1,
  });
  assert.deepEqual(office.balances.get(b.id), {
    quantity: '10',
    value_minor: '150000',
    revision: 4,
  });
  // A repeat sends nothing; a new plan of the same file has nothing to do.
  assert.equal(
    (
      await applyPlan({
        plan,
        expectedPlan: plan.plan_sha256,
        request: (p, x) => office.request(p, x),
      })
    ).sent,
    0,
  );
  const again = planOpening({ csvBytes: bytes, snapshot: office.snapshot(), branch });
  assert.deepEqual([again.errors, again.chunks, again.summary.unchanged], [[], [], 2]);
  // Somebody wastes after the plan: nothing is sent.
  const fresh = fakeBackoffice([ingredient('Синтетическое филе', 'g')]);
  const freshPlan = planOpening({
    csvBytes: csv('name;quantity;unit;total_value_tenge', 'Синтетическое филе;2;кг;4000'),
    snapshot: fresh.snapshot(),
    branch,
  });
  const id = freshPlan.lines[0].ingredient_id;
  fresh.balances.set(id, { quantity: '5', value_minor: '5', revision: 1 });
  await assert.rejects(
    applyPlan({
      plan: freshPlan,
      expectedPlan: freshPlan.plan_sha256,
      request: (p, x) => fresh.request(p, x),
    }),
    { code: 'STALE_PLAN' },
  );
  assert.equal(fresh.documents(), 0);
  assert.throws(() => verifyApplied(freshPlan, fresh.snapshot()), { code: 'VERIFY_FAILED' });
});

test('command line: dry run by default, --apply needs the reviewed plan hash', () => {
  const base = ['--csv', 'x.csv', '--branch', branch, '--token-file', 'c.json'];
  assert.deepEqual(parseArguments(base), {
    '--csv': 'x.csv',
    '--branch': branch,
    '--token-file': 'c.json',
  });
  assert.equal(parseArguments([...base, '--zero-existing'])['--zero-existing'], true);
  assert.equal(
    parseArguments([...base, '--apply', '--expected-plan', 'a'.repeat(64)])['--apply'],
    true,
  );
  for (const argv of [
    base.slice(2),
    [...base, '--apply'],
    [...base, '--apply', '--expected-plan', 'abc'],
    [...base, '--expected-plan', 'a'.repeat(64)],
    [...base, '--apply', '--expected-plan', 'a'.repeat(64), '--zero-existing'],
    [...base, '--force'],
    [...base, '--csv', 'y.csv'],
    ['--csv', 'x.csv', '--branch', 'branch-1', '--token-file', 'c.json'],
  ])
    assert.throws(() => parseArguments(argv), UsageError, argv.join(' '));
});
