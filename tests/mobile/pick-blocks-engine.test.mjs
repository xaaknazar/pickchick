import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_WIDTH,
  BOARD_HEIGHT,
  LOCK_DELAY_MS,
  MAX_LOCK_RESETS,
  createGame,
  cells,
  ghostPiece,
  move,
  rotate,
  softDrop,
  hardDrop,
  tick,
  gravityIntervalMs,
  parseGame,
} from '../../apps/mobile/src/games/pick-blocks/engine.ts';

const emptyBoard = () => Array.from({ length: BOARD_HEIGHT }, () => Array(BOARD_WIDTH).fill(null));
const clone = (value) => JSON.parse(JSON.stringify(value));
const withPiece = (kind, rotation = 0, x = 3, y = 0) => ({
  ...createGame(42),
  active: { kind, rotation, x, y },
});

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

function invariant(state) {
  assert.equal(state.board.length, BOARD_HEIGHT);
  assert(state.board.every((row) => row.length === BOARD_WIDTH));
  assert(state.next.length === 3);
  assert.equal(state.level, 1 + Math.floor(state.lines / 10));
  assert.deepEqual(parseGame(clone(state)), state);
  if (state.active) {
    const points = cells(state.active);
    assert.equal(new Set(points.map(({ x, y }) => `${x},${y}`)).size, 4);
    assert(points.every(({ x, y }) => x >= 0 && x < BOARD_WIDTH && y >= -2 && y < BOARD_HEIGHT));
    assert(points.every(({ x, y }) => y < 0 || state.board[y][x] === null));
    const ghost = ghostPiece(state);
    assert(ghost.y >= state.active.y);
    assert(cells(ghost).every(({ x, y }) => y < 0 || state.board[y][x] === null));
    assert(
      cells({ ...ghost, y: ghost.y + 1 }).some(
        ({ x, y }) => y >= BOARD_HEIGHT || (y >= 0 && state.board[y][x] !== null),
      ),
    );
  } else {
    assert.equal(state.over, true);
  }
}

test('seeded seven-bag contains each shape once and can replay many bags', () => {
  for (const seed of [0, 1, -1, 42, 0xffffffff, Infinity, NaN]) {
    let state = createGame(seed);
    assert.deepEqual(createGame(seed), state);
    const sequence = [];
    for (let index = 0; index < 70; index += 1) {
      sequence.push(state.active.kind);
      state = hardDrop({ ...state, board: emptyBoard() });
    }
    for (let index = 0; index < sequence.length; index += 7) {
      assert.equal(new Set(sequence.slice(index, index + 7)).size, 7);
    }
  }
  assert.notDeepEqual(createGame(1).next, createGame(42).next);
});

test('each orientation contains four unique cells; four turns restore shape on clear board', () => {
  for (const kind of ['I', 'O', 'T', 'S', 'Z', 'J', 'L']) {
    let state = withPiece(kind, 0, 3, 5);
    const original = cells(state.active);
    for (let turn = 0; turn < 4; turn += 1) {
      invariant(state);
      state = rotate(state);
    }
    assert.deepEqual(cells(state.active), original);
  }
});

test('lateral moves stop at walls and settled cells without mutating their input', () => {
  let state = freeze(withPiece('O', 0, 0, 5));
  assert.strictEqual(move(state, -1), state);
  state = freeze(move(state, 1));
  assert.equal(state.active.x, 1);
  const blocked = { ...state, board: emptyBoard() };
  blocked.board[5][3] = 'J';
  freeze(blocked);
  assert.strictEqual(move(blocked, 1), blocked);
  assert.strictEqual(move(blocked, 2), blocked);
  assert.equal(state.board[5][3], null);
});

test('SRS clockwise kicks recover T and I wall turns and a floor turn', () => {
  const wallT = rotate(withPiece('T', 1, -1, 5));
  assert.deepEqual(wallT.active, { kind: 'T', rotation: 2, x: 0, y: 5 });
  const wallI = rotate(withPiece('I', 1, -2, 5));
  assert.deepEqual(wallI.active, { kind: 'I', rotation: 2, x: 0, y: 5 });
  const floor = rotate(withPiece('T', 0, 3, 18));
  assert.equal(floor.active.rotation, 1);
  assert.equal(floor.active.y, 17);
  invariant(wallT);
  invariant(wallI);
  invariant(floor);
});

test('rotation cannot tunnel into a filled surrounding stack', () => {
  const state = withPiece('T', 0, 3, 5);
  state.board = Array.from({ length: BOARD_HEIGHT }, () => Array(BOARD_WIDTH).fill('J'));
  for (const { x, y } of cells(state.active)) state.board[y][x] = null;
  assert.strictEqual(rotate(freeze(state)), state);
});

test('ghost and hard drop stop above obstacles, score distance, lock once and spawn', () => {
  const original = withPiece('O', 0, 4, 0);
  original.board[15][4] = 'J';
  freeze(original);
  assert.equal(ghostPiece(original).y, 13);
  const dropped = hardDrop(original);
  assert.equal(dropped.score, 26);
  assert.equal(dropped.piecesPlaced, 1);
  assert.equal(dropped.board[13][4], 'O');
  assert.equal(dropped.board[14][5], 'O');
  assert.equal(dropped.board[15][4], 'J');
  assert.equal(dropped.active.kind, original.next[0]);
  assert.equal(original.board[13][4], null);
  invariant(dropped);
});

test('soft drop scores one per successful cell and cannot force an early ground lock', () => {
  let state = withPiece('O', 0, 4, 17);
  state = softDrop(state);
  assert.equal(state.active.y, 18);
  assert.equal(state.score, 1);
  assert.strictEqual(softDrop(state), state);
  assert.equal(tick(state, LOCK_DELAY_MS - 1).piecesPlaced, 0);
  assert.equal(tick(state, LOCK_DELAY_MS).piecesPlaced, 1);
});

for (const count of [1, 2, 3, 4]) {
  test(`clears ${count} full row(s), shifts surviving cells and scores the line event`, () => {
    const state = withPiece('I', 1, 3, 16);
    for (let row = BOARD_HEIGHT - count; row < BOARD_HEIGHT; row += 1) {
      state.board[row] = Array(BOARD_WIDTH).fill('J');
      state.board[row][5] = null;
    }
    state.board[10][0] = 'Z';
    const result = hardDrop(freeze(state));
    assert.equal(result.lines, count);
    assert.equal(result.score, [0, 100, 300, 500, 800][count]);
    assert.equal(result.board[10 + count][0], 'Z');
    assert.equal(result.board[10][0], null);
    assert.equal(result.piecesPlaced, 1);
    assert.deepEqual(result.lastClear, {
      id: 1,
      count,
      rows: Array.from({ length: count }, (_, index) => BOARD_HEIGHT - count + index),
    });
    assert(result.board.every((row) => row.some((cell) => cell === null)));
    invariant(result);
  });
}

test('ten cleared rows advance the level and gravity, with scoring at the level before clear', () => {
  const state = { ...withPiece('I', 1, 3, 16), lines: 9, piecesPlaced: 9 };
  state.board[19] = Array(BOARD_WIDTH).fill('L');
  state.board[19][5] = null;
  const result = hardDrop(state);
  assert.equal(result.lines, 10);
  assert.equal(result.level, 2);
  assert.equal(result.score, 100);
  assert(gravityIntervalMs(2) < gravityIntervalMs(1));
  assert.equal(gravityIntervalMs(1000), 90);
  invariant(result);
});

test('blocked spawn ends the game, and actions after game over are inert', () => {
  const state = withPiece('O', 0, 4, 18);
  const next = { kind: state.next[0], rotation: 0, x: state.next[0] === 'O' ? 4 : 3, y: 0 };
  for (const { x, y } of cells(next)) state.board[y][x] = 'S';
  const result = hardDrop(state);
  assert.equal(result.over, true);
  assert.equal(result.active, null);
  assert.equal(result.piecesPlaced, 1);
  assert.equal(ghostPiece(result), null);
  for (const action of [(s) => move(s, 1), rotate, softDrop, hardDrop, (s) => tick(s, 1000)]) {
    assert.strictEqual(action(result), result);
  }
  invariant(result);
});

test('locking a kicked piece above the ceiling tops out without writing partial cells', () => {
  const state = withPiece('I', 0, 3, -2);
  state.board[0] = Array(BOARD_WIDTH).fill('S');
  const result = hardDrop(state);
  assert.equal(result.over, true);
  assert.equal(result.active, null);
  assert.strictEqual(result.board, state.board);
  assert.equal(result.piecesPlaced, 0);
});

test('gravity advances by elapsed time, preserves rendering references and segments equivalently', () => {
  const state = withPiece('O', 0, 4, 0);
  const partial = tick(state, 100);
  assert.strictEqual(partial.active, state.active);
  assert.strictEqual(partial.board, state.board);
  assert.strictEqual(partial.next, state.next);
  assert.equal(partial.gravityMs, 100);
  assert.equal(tick(state, 850).active.y, 1);
  const single = tick(state, 1000);
  let chunks = state;
  for (let index = 0; index < 10; index += 1) chunks = tick(chunks, 100);
  assert.deepEqual(chunks, single);
  assert.deepEqual(tick(state, 100_000), single);
  for (const delta of [NaN, Infinity, -1, 0]) assert.strictEqual(tick(state, delta), state);
});

test('landing starts the 500 ms delay after contact and settles without input', () => {
  const state = withPiece('O', 0, 4, 17);
  const landed = tick(state, 1000);
  assert.equal(landed.active.y, 18);
  assert.equal(landed.lockMs, 150);
  assert.equal(landed.piecesPlaced, 0);
  assert.equal(tick(landed, 349).piecesPlaced, 0);
  assert.equal(tick(landed, 350).piecesPlaced, 1);
});

test('ground movement resets lock delay at most 15 times; blocked inputs never reset it', () => {
  let state = withPiece('O', 0, 4, 18);
  for (let index = 0; index < MAX_LOCK_RESETS; index += 1) {
    state = tick(state, 400);
    state = move(state, index % 2 === 0 ? 1 : -1);
    assert.equal(state.piecesPlaced, 0);
    assert.equal(state.lockMs, 0);
    assert.equal(state.lockResets, index + 1);
  }
  state = tick(state, 400);
  state = move(state, -1);
  assert.equal(state.lockMs, 400);
  assert.equal(state.lockResets, MAX_LOCK_RESETS);
  assert.equal(tick(state, 100).piecesPlaced, 1);
  const wall = tick(withPiece('O', 0, 0, 18), 450);
  assert.strictEqual(move(wall, -1), wall);
  assert.equal(tick(move(wall, -1), 50).piecesPlaced, 1);
});

test('round-trip snapshots are independent copies and retain the exact future random sequence', () => {
  let original = createGame(123456);
  original = move(tick(rotate(original), 417.25), 1);
  let restored = parseGame(clone(original));
  assert.deepEqual(restored, original);
  assert.notStrictEqual(restored.board, original.board);
  assert.notStrictEqual(restored.active, original.active);
  assert.notStrictEqual(restored.next, original.next);
  for (let index = 0; index < 8; index += 1) {
    original = hardDrop(original);
    restored = hardDrop(restored);
    assert.deepEqual(restored, original);
  }
});

test('corrupt snapshots, unexpected properties, prototypes and accessors are rejected safely', () => {
  const mutations = [
    (s) => {
      s.version = 2;
    },
    (s) => {
      s.extra = true;
    },
    (s) => {
      s.board.pop();
    },
    (s) => {
      s.board[1].pop();
    },
    (s) => {
      s.board[1][1] = 'X';
    },
    (s) => {
      delete s.board[1][1];
    },
    (s) => {
      s.score = -1;
    },
    (s) => {
      s.score = Infinity;
    },
    (s) => {
      s.score = Number.MAX_SAFE_INTEGER;
    },
    (s) => {
      s.board[19] = Array(BOARD_WIDTH).fill('I');
    },
    (s) => {
      s.lines = 1;
    },
    (s) => {
      s.level = 2;
    },
    (s) => {
      s.rng = 0;
    },
    (s) => {
      s.rng = 0x1_0000_0000;
    },
    (s) => {
      s.bag = ['I', 'I'];
    },
    (s) => {
      s.next = ['I'];
    },
    (s) => {
      s.active.x = 100;
    },
    (s) => {
      s.active.rotation = 4;
    },
    (s) => {
      s.active.kind = '__proto__';
    },
    (s) => {
      s.active = null;
    },
    (s) => {
      s.over = true;
    },
    (s) => {
      s.over = 0;
    },
    (s) => {
      s.lockMs = 500;
    },
    (s) => {
      s.gravityMs = 850;
    },
    (s) => {
      s.lockResets = 16;
    },
    (s) => {
      s.gravityMs = NaN;
    },
    (s) => {
      s.lastClear = { id: 1, count: 1, rows: [19] };
    },
    (s) => {
      s.lastClear = { id: 0, count: 0, rows: [] };
    },
    (s) => {
      s[Symbol('unexpected')] = true;
    },
    (s) => {
      Object.setPrototypeOf(s, { injected: true });
    },
    (s) => {
      Object.defineProperty(s, 'score', {
        get() {
          throw Error('getter');
        },
      });
    },
    (s) => {
      const { x, y } = cells(s.active)[0];
      s.board[y][x] = 'J';
    },
    (s) => {
      s.board[0].extra = true;
    },
  ];
  for (const mutate of mutations) {
    const state = clone(createGame(42));
    mutate(state);
    assert.equal(parseGame(state), null, mutate.toString());
  }
  for (const value of [null, undefined, 42, '', [], new Date(), { version: 1 }]) {
    assert.equal(parseGame(value), null);
  }
  const polluted = JSON.parse(
    JSON.stringify(createGame(42)).replace(
      '"version":1',
      '"version":1,"__proto__":{"polluted":true}',
    ),
  );
  assert.equal(parseGame(polluted), null);
  assert.equal({}.polluted, undefined);
});

test('deterministic random action replays maintain board, collision, score and persistence invariants', () => {
  const actions = [
    (s) => move(s, -1),
    (s) => move(s, 1),
    rotate,
    softDrop,
    hardDrop,
    (s) => tick(s, 16.67),
    (s) => tick(s, 500),
    (s) => tick(s, 1000),
  ];
  for (let seed = 1; seed <= 30; seed += 1) {
    let state = createGame(seed);
    let replay = createGame(seed);
    let random = seed;
    for (let step = 0; step < 400; step += 1) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const action = actions[random % actions.length];
      const before = state;
      state = action(freeze(state));
      replay = action(replay);
      assert.deepEqual(state, replay);
      assert(state.score >= before.score);
      assert(state.lines >= before.lines);
      assert(state.piecesPlaced >= before.piecesPlaced);
      invariant(state);
      if (state.over) break;
    }
  }
});
