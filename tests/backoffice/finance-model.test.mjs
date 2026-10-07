import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FinanceModel, minor, money, csv } from '../../apps/backoffice/dist/finance-model.js';
import { ApiError } from '../../apps/backoffice/dist/api.js';
import {
  reportData,
  timeSeries,
  percent,
  chartWidth,
} from '../../apps/backoffice/dist/finance-report.js';
const store = () => {
  const m = new Map();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
};
const snapshot = (branch) => ({
  schema_version: 1,
  branch_id: branch,
  role: 'manager',
  as_of: new Date().toISOString(),
  categories: [],
  centers: {},
  groups: {},
  accounts: [],
  summaries: [],
  journal: [],
  total: 0,
  periods: [],
});
test('report totals, shares and dated series stay exact and do not use paginated journal', () => {
  const d = {
    ...snapshot(randomUUID()),
    categories: [
      { id: 'sales', group: 'revenue', direction: 'in', cashflow: 'operating' },
      { id: 'rent', group: 'rent', direction: 'out', cashflow: 'operating' },
      { id: 'equipment', group: 'none', direction: 'out', cashflow: 'investing' },
    ],
    summaries: [
      {
        category_id: 'sales',
        center: 'restaurant',
        cash_minor: '900719925474099301',
        pnl_minor: '900719925474099301',
      },
      { category_id: 'rent', center: 'restaurant', cash_minor: '201', pnl_minor: '100' },
      { category_id: 'equipment', center: 'restaurant', cash_minor: '500', pnl_minor: '0' },
    ],
    timeline: [
      { date: '2026-09-30', basis: 'pnl', in_minor: '0', out_minor: '100' },
      { date: '2026-10-01', basis: 'cash', in_minor: '900719925474099301', out_minor: '201' },
      { date: '2026-10-02', basis: 'cash', in_minor: '0', out_minor: '500' },
    ],
  };
  assert.equal(reportData(d, 'cash').net, 900719925474098600n);
  assert.equal(reportData(d, 'pnl').net, 900719925474099201n);
  assert.equal(percent(1n, 0n), '-');
  assert.equal(percent(-1n, 8n), '-12,5%');
  assert.equal(percent(900719925474099301n, 900719925474099301n), '100,0%');
  assert.equal(chartWidth(1n, 2n), 50);
  const daily = timeSeries(d, 'cash', '2026-10-01', '2026-10-03');
  assert.equal(daily.points.length, 3);
  assert.equal(daily.points[2].incoming, 0n);
  const monthly = timeSeries(d, 'cash', '2026-09-01', '2026-10-31');
  assert.equal(monthly.monthly, true);
  assert.equal(monthly.points[1].outgoing, 701n);
  assert.equal(timeSeries(d, 'pnl', '2026-09-01', '2026-09-30').points[29].outgoing, 100n);
  assert.equal(timeSeries(snapshot('x'), 'cash', '2026-10-01', '2026-10-03'), null);
});
test('exact KZT input and formula-safe CSV', () => {
  assert.equal(minor('1 234,56'), '123456');
  assert.equal(minor('0.01'), '1');
  assert.equal(money('-101'), '-1,01 ₸');
  for (const v of ['0', '-1', '1.001', '1e3', 'Infinity', '1.2.3']) assert.throws(() => minor(v));
  assert.match(csv([['=SUM(A1)', '+text', '@name', 'a"b']]), /"'=SUM\(A1\)"/);
  assert.match(csv([['a"b']]), /"a""b"/);
});
test('lost reply persists exact request, reload and retry do not create a new command', async () => {
  const actor = randomUUID(),
    branch = randomUUID(),
    storage = store(),
    requests = [];
  let fail = true;
  const api = async (path, r) => {
    if (!r) return snapshot(branch);
    requests.push(JSON.parse(JSON.stringify(r.body)));
    if (fail) throw new ApiError('NETWORK');
    return { id: r.body.command.entry.id };
  };
  const model = new FinanceModel(api, storage, () => {});
  await model.scope(actor, branch);
  const e = { id: randomUUID() };
  assert.equal(await model.send({ type: 'entry', entry: e }, 'Synthetic'), false);
  assert.ok(model.pending);
  const reloaded = new FinanceModel(api, storage, () => {});
  await reloaded.scope(actor, branch);
  assert.ok(reloaded.pending);
  assert.equal(reloaded.writable, false);
  fail = false;
  assert.equal(await reloaded.recover(), true);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(reloaded.pending, null);
});
test('expired access after a lost reply preserves the original command through reauthentication', async () => {
  const actor = randomUUID(),
    branch = randomUUID(),
    storage = store(),
    requests = [];
  let failure = new ApiError('NETWORK');
  const api = async (_path, r) => {
    if (!r) return snapshot(branch);
    requests.push(JSON.parse(JSON.stringify(r.body)));
    if (failure) throw failure;
    return { id: r.body.command.entry.id };
  };
  const m = new FinanceModel(api, storage, () => {});
  await m.scope(actor, branch);
  await m.send({ type: 'entry', entry: { id: randomUUID() } }, 'Synthetic');
  for (const [code, status] of [
    ['UNAUTHORIZED', 401],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
  ]) {
    failure = new ApiError(code, status);
    await m.recover();
    assert.ok(m.pending);
    assert.equal(m.writable, false);
  }
  m.clear();
  failure = null;
  await m.scope(actor, branch);
  assert.ok(m.pending);
  assert.equal(await m.recover(), true);
  assert.ok(requests.every((r) => JSON.stringify(r) === JSON.stringify(requests[0])));
});
test('storage failure prevents write, other actors never recover private commands', async () => {
  const actor = randomUUID(),
    branch = randomUUID();
  let writes = 0;
  const api = async (_p, r) => {
    if (r) writes++;
    return snapshot(branch);
  };
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw Error('Quota');
    },
    removeItem: () => {},
  };
  const m = new FinanceModel(api, broken, () => {});
  await m.scope(actor, branch);
  await m.send({ type: 'void', id: randomUUID() }, 'Synthetic');
  assert.equal(writes, 0);
  assert.equal(m.writable, false);
  const storage = store();
  storage.setItem(
    'pickchick.finance.v1:' + actor,
    JSON.stringify({
      actor,
      branch,
      body: {
        request_id: randomUUID(),
        reason: 'Synthetic',
        command: { type: 'void', id: randomUUID() },
      },
    }),
  );
  const n = new FinanceModel(api, storage, () => {});
  await n.scope(randomUUID(), branch);
  assert.equal(n.pending, null);
});
test('late responses cannot restore a logged-out accounting session', async () => {
  const actor = randomUUID(),
    branch = randomUUID();
  let resolve;
  const waiting = new Promise((r) => (resolve = r));
  const m = new FinanceModel(
    async () => waiting,
    store(),
    () => {},
  );
  const p = m.scope(actor, branch);
  m.clear();
  resolve(snapshot(branch));
  await p;
  assert.equal(m.data, null);
  assert.equal(m.actor, '');
});
