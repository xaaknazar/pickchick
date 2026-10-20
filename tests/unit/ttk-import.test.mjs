import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planImport, prepare, quantity, runImport } from '../../scripts/ttk-import.mjs';
const branch = '01946abd-c422-7100-8000-000000000001';
const sha256 = 'a'.repeat(64);
const card = (code, name, unit, lines, extra = {}) => ({
  file: 'fixture.xls',
  sha256,
  sheet: 'Page 1',
  row: 2,
  date: '01.10.2026',
  code,
  name,
  batch: `1,000 ${unit}`,
  output: { value: unit === 'кг' ? 1 : 0, unit: 'кг', row: 20 },
  lines: lines.map(([name, unit, quantity], i) => ({ name, unit, quantity, row: 10 + i })),
  ...extra,
});
const input = (...recipes) => ({ version: 1, sources: [{ file: 'fixture.xls', sha256 }], recipes });
const snapshot = () => ({
  branch_id: branch,
  role: 'manager',
  records: [],
  limits: { records: 2000 },
});
const simple = () => input(card('1', 'Test preparation', 'кг', [['Raw', 'кг', 1.2]]));
test('converts exact accounting quantities without using net weight or density', () => {
  assert.equal(quantity(0.015, 'кг'), '15');
  assert.equal(quantity('0,125', 'л'), '125');
  assert.equal(quantity(50, 'шт'), '50');
  assert.throws(() => quantity(0.0005, 'кг'), /Fractional/);
  assert.throws(() => quantity(1.5, 'шт'), /Fractional/);
  assert.throws(() => quantity(-1, 'кг'));
  assert.throws(() => quantity(Infinity, 'кг'));
  assert.throws(() => quantity(1, 'cup'));
  const plan = planImport(simple(), snapshot(), branch);
  assert.equal(plan.operations.at(-1).body.command.payload.lines[0].quantity, '1200');
  assert.equal(plan.operations.at(-1).body.command.payload.yield_quantity, '1000');
});
test('links nested output by original unit; packaged piece and portion remain distinct', () => {
  const source = input(
    card('1', 'Water', 'порц', [['WATER', 'шт', 1]]),
    card('2', 'Meal', 'порц', [
      ['Water', 'порц', 1],
      ['Box', 'шт', 1],
    ]),
  );
  const plan = planImport(source, snapshot(), branch);
  const recipes = plan.operations.filter((o) => o.body.command.kind === 'recipe');
  const water = recipes[0].body.command.payload;
  const meal = recipes[1].body.command.payload;
  assert.notEqual(water.lines[0].ingredient_id, water.output_ingredient_id);
  assert.equal(meal.lines[0].ingredient_id, water.output_ingredient_id);
  assert.equal(meal.lines[1].quantity, '1');
  assert.ok(recipes.every((o) => o.body.command.payload.product_id.startsWith('ttk:')));
});
test('withholds mismatched yields and empty cards; records explicit zero lines', () => {
  const source = input(
    card('1', 'Ambiguous', 'кг', [['Raw', 'кг', 1.2]], { output: { value: 1.1, unit: 'кг' } }),
    card('2', 'Empty', 'порц', []),
    card('3', 'Valid', 'шт', [
      ['Raw', 'кг', 0.1],
      ['Box', 'шт', 0],
    ]),
  );
  const plan = planImport(source, snapshot(), branch);
  assert.deepEqual(plan.summary.held, ['1']);
  assert.equal(plan.summary.recipes, 1);
  assert.equal(plan.issues.length, 3);
  assert.equal(
    plan.operations.find((o) => o.body.command.payload.name === 'ТТК 1: Ambiguous').body.command
      .payload.active,
    false,
  );
});
test('rejects cycles, unknown portions and duplicate identities', () => {
  assert.throws(() => prepare(input(card('1', 'A', 'порц', [['B', 'порц', 1]]))), /Missing/);
  assert.throws(
    () =>
      prepare(
        input(
          card('1', 'A', 'порц', [['B', 'порц', 1]]),
          card('2', 'B', 'порц', [['A', 'порц', 1]]),
        ),
      ),
    /cycle/,
  );
  assert.throws(() => prepare(input(...simple().recipes, ...simple().recipes)), /Duplicate/);
  const invalid = simple();
  invalid.recipes[0].sha256 = 'b'.repeat(64);
  assert.throws(() => prepare(invalid), /source mismatch/);
});
test('rejects unauthorized/truncated scope and existing ambiguous names', () => {
  assert.throws(() => planImport(simple(), { ...snapshot(), role: 'viewer' }, branch), /Scope/);
  assert.throws(
    () => planImport(simple(), { ...snapshot(), limits: { records: 0 } }, branch),
    /Incomplete/,
  );
  const s = snapshot();
  s.records.push({ id: 'other', kind: 'ingredient', payload: { name: 'Raw' } });
  assert.throws(() => planImport(simple(), s, branch), /mapping/);
});
test('resumes after lost command response, verifies and does not duplicate records', async () => {
  const state = snapshot();
  let loseResponse = true;
  let writes = 0;
  const request = async (_path, body) => {
    if (!body) return globalThis.structuredClone(state);
    const c = body.command;
    assert.equal(c.type, 'save');
    assert.equal(c.expected_revision, 0);
    assert.ok(!state.records.some((r) => r.id === c.id));
    state.records.push({ id: c.id, kind: c.kind, revision: 1, payload: c.payload });
    writes++;
    if (loseResponse) {
      loseResponse = false;
      throw Error('lost response');
    }
    return state.records.at(-1);
  };
  const args = { input: simple(), branch, request };
  const preview = await runImport(args);
  assert.equal(writes, 0);
  await assert.rejects(runImport({ ...args, apply: true, expectedPlan: 'wrong' }), /Plan changed/);
  assert.equal(writes, 0);
  await assert.rejects(
    runImport({ ...args, apply: true, expectedPlan: preview.plan }),
    /lost response/,
  );
  const result = await runImport({ ...args, apply: true, expectedPlan: preview.plan });
  assert.equal(result.verified, true);
  assert.equal(result.pending, 0);
  assert.equal(writes, preview.pending);
  assert.equal((await runImport({ ...args, apply: true, expectedPlan: preview.plan })).saved, 0);
  state.records[0].revision = 2;
  assert.throws(() => planImport(simple(), state, branch), /record changed/);
});
