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
      ivory: 24,
      taupe: 0,
      orange: 24,
      rose: 0,
      wine: 24,
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
  }
  assert.ok(fourColorLevels > 0);
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

test('published version1 fixture resumes, resets and undoes without seed reinterpretation', () => {
  const initial = {
    version: 1,
    seed: 42,
    bottles: [
      ['yellow', 'yellow', 'orange', 'rose'],
      ['ivory', 'ivory', 'wine', 'ivory'],
      ['orange', 'orange', 'rose', 'yellow'],
      ['ivory', 'ivory', 'taupe', 'yellow'],
      ['orange', 'orange', 'ivory', 'taupe'],
      ['ivory', 'ivory', 'orange', 'yellow'],
      [],
      ['yellow', 'yellow', 'yellow', 'taupe'],
      ['rose', 'rose', 'wine', 'yellow'],
      ['wine', 'wine', 'rose', 'wine'],
      ['orange', 'orange', 'taupe', 'ivory'],
      ['taupe', 'taupe', 'orange', 'wine'],
      ['wine', 'wine', 'rose', 'yellow'],
      ['taupe', 'taupe', 'ivory', 'yellow'],
      ['yellow', 'ivory', 'rose', 'wine'],
      ['wine', 'wine', 'ivory', 'wine'],
      ['yellow', 'yellow', 'yellow', 'ivory'],
      ['wine', 'wine', 'ivory', 'rose'],
      ['rose', 'rose', 'orange'],
      ['rose', 'rose', 'orange'],
      ['orange', 'orange', 'rose', 'orange'],
      ['ivory', 'ivory', 'wine', 'rose'],
      ['rose', 'rose', 'wine', 'orange'],
      ['yellow', 'orange'],
    ],
    collector: [],
    history: [],
    witness: [
      { from: 23, to: 6 },
      { from: 6, to: 18 },
      { from: 18, to: 19 },
      { from: 23, to: 6 },
      { from: 20, to: 18 },
      { from: 21, to: 20 },
      { from: 9, to: 21 },
      { from: 17, to: 9 },
      { from: 8, to: 6 },
      { from: 10, to: 17 },
      { from: 7, to: 10 },
      { from: 7, to: 6 },
      { from: 4, to: 23 },
      { from: 15, to: 8 },
      { from: 16, to: 15 },
      { from: 1, to: 4 },
      { from: 6, to: 16 },
      { from: 11, to: 1 },
      { from: 3, to: 6 },
      { from: 22, to: 11 },
      { from: 12, to: 7 },
      { from: 9, to: 12 },
      { from: 1, to: 22 },
      { from: 0, to: 9 },
      { from: 23, to: 3 },
      { from: 14, to: 1 },
      { from: 2, to: 7 },
      { from: 20, to: 2 },
      { from: 5, to: 7 },
      { from: 0, to: 5 },
      { from: 14, to: 20 },
      { from: 13, to: 0 },
      { from: 14, to: 13 },
      { from: 14, to: 0 },
      { from: 0, to: 24 },
      { from: 7, to: 24 },
      { from: 16, to: 24 },
      { from: 6, to: 24 },
      { from: 13, to: 14 },
      { from: 3, to: 13 },
      { from: 3, to: 14 },
      { from: 10, to: 3 },
      { from: 11, to: 10 },
      { from: 11, to: 3 },
      { from: 20, to: 11 },
      { from: 18, to: 20 },
      { from: 18, to: 11 },
      { from: 9, to: 18 },
      { from: 22, to: 9 },
      { from: 22, to: 18 },
      { from: 1, to: 22 },
      { from: 17, to: 1 },
      { from: 17, to: 22 },
      { from: 4, to: 17 },
      { from: 5, to: 4 },
      { from: 5, to: 17 },
      { from: 19, to: 5 },
      { from: 2, to: 19 },
      { from: 2, to: 5 },
      { from: 12, to: 2 },
      { from: 8, to: 12 },
      { from: 8, to: 2 },
      { from: 15, to: 8 },
      { from: 21, to: 15 },
      { from: 21, to: 8 },
    ],
  };
  const prior = {
    version: 1,
    seed: 42,
    bottles: [
      ['yellow', 'yellow', 'orange', 'rose'],
      ['ivory', 'ivory', 'wine', 'ivory'],
      ['orange', 'orange', 'rose', 'yellow'],
      ['ivory', 'ivory', 'taupe', 'yellow'],
      ['orange', 'orange', 'ivory', 'taupe'],
      ['ivory', 'ivory', 'orange', 'yellow'],
      ['yellow'],
      ['yellow', 'yellow', 'yellow', 'taupe'],
      ['rose', 'rose', 'wine', 'yellow'],
      ['wine', 'wine', 'rose'],
      ['orange', 'orange', 'taupe', 'ivory'],
      ['taupe', 'taupe', 'orange', 'wine'],
      ['wine', 'wine', 'rose', 'yellow'],
      ['taupe', 'taupe', 'ivory', 'yellow'],
      ['yellow', 'ivory', 'rose', 'wine'],
      ['wine', 'wine', 'ivory', 'wine'],
      ['yellow', 'yellow', 'yellow', 'ivory'],
      ['wine', 'wine', 'ivory', 'rose'],
      ['rose', 'rose', 'orange', 'orange'],
      ['rose', 'rose', 'orange', 'orange'],
      ['orange', 'orange', 'rose', 'rose'],
      ['ivory', 'ivory', 'wine', 'wine'],
      ['rose', 'rose', 'wine', 'orange'],
      [],
    ],
    collector: [],
    history: [
      { from: 23, to: 6 },
      { from: 6, to: 18 },
      { from: 18, to: 19 },
      { from: 23, to: 6 },
      { from: 20, to: 18 },
      { from: 21, to: 20 },
      { from: 9, to: 21 },
    ],
    witness: [
      { from: 23, to: 6 },
      { from: 6, to: 18 },
      { from: 18, to: 19 },
      { from: 23, to: 6 },
      { from: 20, to: 18 },
      { from: 21, to: 20 },
      { from: 9, to: 21 },
      { from: 17, to: 9 },
      { from: 8, to: 6 },
      { from: 10, to: 17 },
      { from: 7, to: 10 },
      { from: 7, to: 6 },
      { from: 4, to: 23 },
      { from: 15, to: 8 },
      { from: 16, to: 15 },
      { from: 1, to: 4 },
      { from: 6, to: 16 },
      { from: 11, to: 1 },
      { from: 3, to: 6 },
      { from: 22, to: 11 },
      { from: 12, to: 7 },
      { from: 9, to: 12 },
      { from: 1, to: 22 },
      { from: 0, to: 9 },
      { from: 23, to: 3 },
      { from: 14, to: 1 },
      { from: 2, to: 7 },
      { from: 20, to: 2 },
      { from: 5, to: 7 },
      { from: 0, to: 5 },
      { from: 14, to: 20 },
      { from: 13, to: 0 },
      { from: 14, to: 13 },
      { from: 14, to: 0 },
      { from: 0, to: 24 },
      { from: 7, to: 24 },
      { from: 16, to: 24 },
      { from: 6, to: 24 },
      { from: 13, to: 14 },
      { from: 3, to: 13 },
      { from: 3, to: 14 },
      { from: 10, to: 3 },
      { from: 11, to: 10 },
      { from: 11, to: 3 },
      { from: 20, to: 11 },
      { from: 18, to: 20 },
      { from: 18, to: 11 },
      { from: 9, to: 18 },
      { from: 22, to: 9 },
      { from: 22, to: 18 },
      { from: 1, to: 22 },
      { from: 17, to: 1 },
      { from: 17, to: 22 },
      { from: 4, to: 17 },
      { from: 5, to: 4 },
      { from: 5, to: 17 },
      { from: 19, to: 5 },
      { from: 2, to: 19 },
      { from: 2, to: 5 },
      { from: 12, to: 2 },
      { from: 8, to: 12 },
      { from: 8, to: 2 },
      { from: 15, to: 8 },
      { from: 21, to: 15 },
      { from: 21, to: 8 },
    ],
  };
  const saved = {
    version: 1,
    seed: 42,
    bottles: [
      ['yellow', 'yellow', 'orange', 'rose'],
      ['ivory', 'ivory', 'wine', 'ivory'],
      ['orange', 'orange', 'rose', 'yellow'],
      ['ivory', 'ivory', 'taupe', 'yellow'],
      ['orange', 'orange', 'ivory', 'taupe'],
      ['ivory', 'ivory', 'orange', 'yellow'],
      ['yellow'],
      ['yellow', 'yellow', 'yellow', 'taupe'],
      ['rose', 'rose', 'wine', 'yellow'],
      ['wine', 'wine', 'rose', 'rose'],
      ['orange', 'orange', 'taupe', 'ivory'],
      ['taupe', 'taupe', 'orange', 'wine'],
      ['wine', 'wine', 'rose', 'yellow'],
      ['taupe', 'taupe', 'ivory', 'yellow'],
      ['yellow', 'ivory', 'rose', 'wine'],
      ['wine', 'wine', 'ivory', 'wine'],
      ['yellow', 'yellow', 'yellow', 'ivory'],
      ['wine', 'wine', 'ivory'],
      ['rose', 'rose', 'orange', 'orange'],
      ['rose', 'rose', 'orange', 'orange'],
      ['orange', 'orange', 'rose', 'rose'],
      ['ivory', 'ivory', 'wine', 'wine'],
      ['rose', 'rose', 'wine', 'orange'],
      [],
    ],
    collector: [],
    history: [
      { from: 23, to: 6 },
      { from: 6, to: 18 },
      { from: 18, to: 19 },
      { from: 23, to: 6 },
      { from: 20, to: 18 },
      { from: 21, to: 20 },
      { from: 9, to: 21 },
      { from: 17, to: 9 },
    ],
    witness: [
      { from: 23, to: 6 },
      { from: 6, to: 18 },
      { from: 18, to: 19 },
      { from: 23, to: 6 },
      { from: 20, to: 18 },
      { from: 21, to: 20 },
      { from: 9, to: 21 },
      { from: 17, to: 9 },
      { from: 8, to: 6 },
      { from: 10, to: 17 },
      { from: 7, to: 10 },
      { from: 7, to: 6 },
      { from: 4, to: 23 },
      { from: 15, to: 8 },
      { from: 16, to: 15 },
      { from: 1, to: 4 },
      { from: 6, to: 16 },
      { from: 11, to: 1 },
      { from: 3, to: 6 },
      { from: 22, to: 11 },
      { from: 12, to: 7 },
      { from: 9, to: 12 },
      { from: 1, to: 22 },
      { from: 0, to: 9 },
      { from: 23, to: 3 },
      { from: 14, to: 1 },
      { from: 2, to: 7 },
      { from: 20, to: 2 },
      { from: 5, to: 7 },
      { from: 0, to: 5 },
      { from: 14, to: 20 },
      { from: 13, to: 0 },
      { from: 14, to: 13 },
      { from: 14, to: 0 },
      { from: 0, to: 24 },
      { from: 7, to: 24 },
      { from: 16, to: 24 },
      { from: 6, to: 24 },
      { from: 13, to: 14 },
      { from: 3, to: 13 },
      { from: 3, to: 14 },
      { from: 10, to: 3 },
      { from: 11, to: 10 },
      { from: 11, to: 3 },
      { from: 20, to: 11 },
      { from: 18, to: 20 },
      { from: 18, to: 11 },
      { from: 9, to: 18 },
      { from: 22, to: 9 },
      { from: 22, to: 18 },
      { from: 1, to: 22 },
      { from: 17, to: 1 },
      { from: 17, to: 22 },
      { from: 4, to: 17 },
      { from: 5, to: 4 },
      { from: 5, to: 17 },
      { from: 19, to: 5 },
      { from: 2, to: 19 },
      { from: 2, to: 5 },
      { from: 12, to: 2 },
      { from: 8, to: 12 },
      { from: 8, to: 2 },
      { from: 15, to: 8 },
      { from: 21, to: 15 },
      { from: 21, to: 8 },
    ],
  };
  const resumed = storage.deserializeGame(JSON.stringify(saved));
  assert.deepEqual(resumed, saved);
  assert.deepEqual(e.resetLevel(resumed), initial);
  assert.deepEqual(e.undo(resumed), prior);
  assert.equal(e.isPuzzle(resumed), false);
  assert.equal(e.createPuzzle().version, 2);
  assert.equal(e.createLevel(42).version, 2);
  assert.notDeepEqual(e.createLevel(42).bottles, initial.bottles);
});

test('bottle taps switch source on incompatible or full bottles without a move', () => {
  const state = e.createLevel(1);
  state.bottles[0] = ['yellow', 'orange'];
  state.bottles[1] = ['yellow', 'wine'];
  state.bottles[2] = ['wine', 'orange', 'orange', 'orange'];
  const before = clone(state);
  assert.deepEqual(e.resolveBottleTap(state, null, 0), { kind: 'select', index: 0 });
  assert.deepEqual(e.resolveBottleTap(state, 0, 1), { kind: 'select', index: 1 });
  assert.deepEqual(e.resolveBottleTap(state, 0, 2), { kind: 'select', index: 2 });
  assert.deepEqual(e.resolveBottleTap(state, 1, 1), { kind: 'deselect' });
  assert.deepEqual(state, before);
});
test('bottle taps pour to compatible targets and collector, but never select empty or sealed bottles', () => {
  const state = e.createLevel(1);
  state.bottles[0] = ['wine', 'orange'];
  state.bottles[1] = ['orange'];
  state.bottles[2] = [];
  state.bottles[3] = ['yellow'];
  state.bottles[4] = Array(4).fill('ivory');
  for (const [from, to] of [
    [0, 1],
    [0, 2],
    [3, 24],
  ]) {
    const action = e.resolveBottleTap(state, from, to);
    assert.equal(action.kind, 'pour');
    assert.deepEqual(action.next, e.pour(state, from, to));
    assert.equal(action.from, from);
    assert.equal(action.to, to);
  }
  for (const [from, to] of [
    [null, 2],
    [null, 4],
    [0, 4],
    [0, 24],
    [null, 24],
  ])
    assert.deepEqual(e.resolveBottleTap(state, from, to), { kind: 'blocked' });
});

test('fixed puzzle is identical for every attempt and solvable through its witness', () => {
  const puzzle = e.createPuzzle();
  assert.equal(puzzle.version, e.PUZZLE_VERSION);
  assert.equal(puzzle.seed, e.PUZZLE_SEED);
  assert.deepEqual(puzzle, e.createLevel(e.PUZZLE_SEED, e.PUZZLE_VERSION));
  assert.deepEqual(e.createPuzzle(), puzzle);
  assert.ok(e.isPuzzle(puzzle));
  assert.equal(e.isPuzzle(e.createLevel(e.PUZZLE_SEED + 1)), false);
  assert.equal(e.isPuzzle(e.createLevel(e.PUZZLE_SEED, 1)), false);
  assert.equal(e.moveCount(puzzle), 0);
  let state = puzzle;
  for (const move of puzzle.witness) state = e.pour(state, move.from, move.to);
  assert.ok(e.isWon(state));
  assert.equal(e.moveCount(state), puzzle.witness.length);
  assert.deepEqual(e.resetLevel(state), puzzle);
  assert.equal(e.moveCount(e.resetLevel(state)), 0);
  assert.equal('newLevel' in e, false, 'No next-level flow exists');
});

test('move count is committed pours: selection is free and undo removes a move', () => {
  let state = e.createPuzzle();
  const [a, b, c] = state.witness;
  assert.equal(e.resolveBottleTap(state, null, a.from).kind, 'select');
  assert.equal(e.moveCount(state), 0);
  state = e.pour(state, a.from, a.to);
  state = e.pour(state, b.from, b.to);
  assert.equal(e.moveCount(state), 2);
  state = e.undo(state);
  assert.equal(e.moveCount(state), 1);
  state = e.pour(state, b.from, b.to);
  state = e.pour(state, c.from, c.to);
  assert.equal(e.moveCount(state), 3);
  assert.equal(e.moveCount(e.undo(e.undo(e.undo(state)))), 0);
});

test('record keeps the minimum and flags only strictly better results', () => {
  assert.deepEqual(e.applyRecord(null, 70), { moves: 70, previous: null, best: 70, isNew: true });
  assert.deepEqual(e.applyRecord(70, 63), { moves: 63, previous: 70, best: 63, isNew: true });
  assert.deepEqual(e.applyRecord(63, 63), { moves: 63, previous: 63, best: 63, isNew: false });
  assert.deepEqual(e.applyRecord(63, 90), { moves: 90, previous: 63, best: 63, isNew: false });
  for (const bad of [0, -1, 1.5, e.MAX_MOVES + 1, NaN])
    assert.throws(() => e.applyRecord(null, bad));
});

function memoryAdapter(values = new Map()) {
  return {
    values,
    async getItem(k) {
      return values.get(k) ?? null;
    },
    async setItem(k, v) {
      await new Promise((r) => setTimeout(r, 2));
      values.set(k, v);
    },
    async removeItem(k) {
      values.delete(k);
    },
  };
}

test('personal record storage is per account, queued and keeps the minimum', async () => {
  const adapter = memoryAdapter();
  const store = storage.createGameStorage(adapter);
  assert.equal(await store.loadRecord('a'), null);
  const results = await Promise.all([
    store.saveRecord('a', 80),
    store.saveRecord('a', 63),
    store.saveRecord('a', 70),
  ]);
  assert.deepEqual(
    results.map((r) => [r.previous, r.best, r.isNew]),
    [
      [null, 80, true],
      [80, 63, true],
      [63, 63, false],
    ],
  );
  assert.equal(await store.loadRecord('a'), 63);
  assert.equal((await store.saveRecord('a', 63)).isNew, false, 'Repeated win is idempotent');
  assert.equal(await store.loadRecord('b'), null, 'Other account has no record');
  await store.saveRecord('b', 100);
  assert.equal(await store.loadRecord('a'), 63);
  assert.equal(await store.loadRecord('b'), 100);
  assert.deepEqual([...adapter.values.keys()].sort(), [
    'pickchick.magic-sort.record.v1:a',
    'pickchick.magic-sort.record.v1:b',
  ]);
  await store.save('a', e.createPuzzle());
  assert.equal(await store.loadRecord('a'), 63, 'Game save does not touch the record');
  assert.throws(() => store.loadRecord(''));
  assert.throws(() => store.saveRecord('a', 0));
});

test('corrupted or foreign records are ignored and replaced by the next win', async () => {
  const key = 'pickchick.magic-sort.record.v1:a';
  const valid = storage.serializeRecord(63);
  assert.equal(storage.deserializeRecord(valid), 63);
  const bad = [
    null,
    'no json',
    '63',
    '[]',
    'null',
    JSON.stringify({ version: 2, seed: e.PUZZLE_SEED }),
    JSON.stringify({ version: 2, seed: e.PUZZLE_SEED, moves: 0 }),
    JSON.stringify({ version: 2, seed: e.PUZZLE_SEED, moves: -5 }),
    JSON.stringify({ version: 2, seed: e.PUZZLE_SEED, moves: 12.5 }),
    JSON.stringify({ version: 2, seed: e.PUZZLE_SEED, moves: '12' }),
    JSON.stringify({ version: 2, seed: e.PUZZLE_SEED, moves: e.MAX_MOVES + 1 }),
    JSON.stringify({ version: 1, seed: e.PUZZLE_SEED, moves: 12 }),
    JSON.stringify({ version: 2, seed: e.PUZZLE_SEED + 1, moves: 12 }),
    JSON.stringify({ version: 2, seed: e.PUZZLE_SEED, moves: 12, extra: 1 }),
    ' '.repeat(201),
  ];
  for (const raw of bad) assert.equal(storage.deserializeRecord(raw), null, String(raw));
  const adapter = memoryAdapter(new Map([[key, JSON.stringify({ moves: 1 })]]));
  const store = storage.createGameStorage(adapter);
  assert.equal(await store.loadRecord('a'), null);
  const result = await store.saveRecord('a', 75);
  assert.deepEqual([result.previous, result.best, result.isNew], [null, 75, true]);
  assert.equal(adapter.values.get(key), storage.serializeRecord(75));
});

test('earlier random-layout saves stay readable but are not the fixed puzzle', () => {
  let old = e.createLevel(123456);
  old = e.pour(old, old.witness[0].from, old.witness[0].to);
  const resumed = storage.deserializeGame(storage.serializeGame(old));
  assert.deepEqual(resumed, old);
  assert.equal(e.isPuzzle(resumed), false);
  assert.ok(e.isPuzzle(storage.deserializeGame(storage.serializeGame(e.createPuzzle()))));
});
