import test from 'node:test';
import { serialize, deserialize } from 'node:v8';
const clone = (value) => deserialize(serialize(value));
import assert from 'node:assert/strict';
import * as e from '../../apps/mobile/src/games/magic-sort/engine.ts';
import * as storage from '../../apps/mobile/src/games/magic-sort/storage.ts';
const counts = (state) => {
  const result = Object.fromEntries(e.COLORS.map((c) => [c, 0]));
  for (const c of [...state.bottles.flat(), ...state.collector]) result[c]++;
  return result;
};
test('100 deterministic constructive levels replay their full witness and conserve all88 units', () => {
  let fourColorLevels = 0;
  for (let seed = 0; seed < 100; seed++) {
    let state = e.createLevel(seed);
    assert.deepEqual(state, e.createLevel(seed));
    assert.equal(state.bottles.length, 24);
    assert.ok(state.bottles.some((b) => new Set(b).size >= 3));
    if (state.bottles.some((b) => new Set(b).size === 4)) fourColorLevels++;
    assert.ok(state.bottles.some((b) => b.includes('yellow') && b.at(-1) !== 'yellow'));
    assert.equal(state.collector.length, 0);
    assert.deepEqual(counts(state), {
      yellow: 16,
      ivory: 16,
      taupe: 8,
      orange: 16,
      rose: 16,
      wine: 16,
    });
    const initial = clone(state);
    for (const move of state.witness) {
      assert.deepEqual(e.getHint(state), { move, source: 'witness' });
      state = e.pour(state, move.from, move.to);
      assert.ok(state);
      assert.deepEqual(counts(state), counts(initial));
      assert.ok(state.bottles.every((b) => b.length <= 4));
    }
    assert.ok(e.isWon(state));
    assert.equal(e.getHint(state), null);
    assert.deepEqual(e.resetLevel(state), initial);
    assert.notEqual(e.newLevel(state).seed, state.seed);
  }
  assert.ok(fourColorLevels >= 50);
});
test('pour is maximal within remaining capacity, checks topcolor and keeps source immutable', () => {
  const state = e.createLevel(1);
  state.bottles[0] = ['ivory', 'orange', 'orange', 'orange'];
  state.bottles[1] = ['rose', 'orange', 'orange'];
  const before = clone(state);
  const next = e.pour(state, 0, 1);
  assert.deepEqual(next.bottles[0], ['ivory', 'orange', 'orange']);
  assert.deepEqual(next.bottles[1], ['rose', 'orange', 'orange', 'orange']);
  assert.deepEqual(state, before);
  for (const [a, b] of [
    [0, 0],
    [24, 0],
    [-1, 0],
    [0, 25],
    [0, 0.5],
  ])
    assert.equal(e.pour(state, a, b), null);
  state.bottles[1] = ['rose'];
  assert.equal(e.pour(state, 0, 1), null);
});
test('collector only accepts yellow and never pours out; small yellow is never sealed', () => {
  const state = e.createLevel(1);
  const yellow = 0;
  state.bottles[yellow] = Array(4).fill('yellow');
  assert.equal(e.isSealed(state.bottles[yellow]), false);
  const next = e.pour(state, yellow, 24);
  assert.equal(next.collector.length, 4);
  assert.equal(e.pour(next, 24, yellow), null);
  const other = state.bottles.findIndex((b) => b.at(-1) !== 'yellow' && b.length);
  assert.equal(e.pour(state, other, 24), null);
  state.collector = Array(15).fill('yellow');
  const partial = e.pour(state, yellow, 24);
  assert.equal(partial.collector.length, 16);
  assert.equal(partial.bottles[yellow].length, 3);
  assert.equal(e.pour(partial, yellow, 24), null);
});
test('sealing locks bottles and undo restores complete previous state including unsealing', () => {
  let state = e.createLevel(99);
  let before, move;
  for (const m of state.witness) {
    const candidate = e.pour(state, m.from, m.to);
    if (m.to !== 24 && !e.isSealed(state.bottles[m.to]) && e.isSealed(candidate.bottles[m.to])) {
      before = clone(state);
      move = m;
      state = candidate;
      break;
    }
    state = candidate;
  }
  assert.ok(e.isSealed(state.bottles[move.to]));
  assert.equal(e.pour(state, move.to, move.from), null);
  assert.deepEqual(e.undo(state), before);
  assert.deepEqual(e.undo(e.createLevel(99)), e.createLevel(99));
});
test('off-witness hints clearly marked suggestions; closed board detects no legal moves', () => {
  const state = e.createLevel(3);
  const first = state.witness[0];
  const move = e.legalMoves(state).find((m) => m.from !== first.from || m.to !== first.to);
  const changed = e.pour(state, move.from, move.to);
  assert.equal(e.getHint(changed).source, 'suggestion');
  const locked = {
    ...state,
    bottles: Array.from({ length: 24 }, () => Array(4).fill('ivory')),
    collector: [],
  };
  assert.equal(e.hasMoves(locked), false);
  assert.equal(e.getHint(locked), null);
});
test('save validation checks reachability, conservation, witness and corruption', () => {
  let state = e.createLevel(4);
  for (const m of state.witness.slice(0, 7)) state = e.pour(state, m.from, m.to);
  assert.deepEqual(storage.deserializeGame(storage.serializeGame(state)), state);
  const edits = [
    (s) => s.bottles[0].push('yellow'),
    (s) => s.collector.push('orange'),
    (s) => s.witness.pop(),
    (s) => s.history.push({ from: 24, to: 0 }),
    (s) => (s.extra = 1),
    (s) => (s.seed = -1),
  ];
  for (const edit of edits) {
    const bad = clone(state);
    edit(bad);
    assert.equal(storage.deserializeGame(JSON.stringify(bad)), null);
  }
  for (const raw of [null, 'no json', '[]', 'x'.repeat(100001)])
    assert.equal(storage.deserializeGame(raw), null);
});
test('account scoped queued persistence orders writes/clear/load and recovers after rejection', async () => {
  const values = new Map();
  let reject = true;
  const store = storage.createGameStorage({
    async getItem(k) {
      return values.get(k) ?? null;
    },
    async setItem(k, v) {
      await new Promise((r) => setTimeout(r, 5));
      if (reject) {
        reject = false;
        throw Error('offline');
      }
      values.set(k, v);
    },
    async removeItem(k) {
      values.delete(k);
    },
  });
  await assert.rejects(store.save('a', e.createLevel(1)));
  const first = store.save('a', e.createLevel(2)),
    second = store.save('a', e.createLevel(3));
  await Promise.all([first, second]);
  assert.equal((await store.load('a')).seed, 3);
  assert.equal(await store.load('b'), null);
  const save = store.save('a', e.createLevel(4)),
    clear = store.clear('a'),
    load = store.load('a');
  await Promise.all([save, clear]);
  assert.equal(await load, null);
  assert.throws(() => store.load(''));
});
