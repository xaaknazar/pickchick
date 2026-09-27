import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fallingFrame,
  fallingOffset,
} from '../../apps/mobile/src/games/pick-blocks/falling-motion.ts';
import {
  createGame,
  cells,
  ghostPiece,
  move,
  rotate,
  softDrop,
  hardDrop,
  tick,
} from '../../apps/mobile/src/games/pick-blocks/engine.ts';

function check(state) {
  const frame = fallingFrame(state);
  if (!state.active) return assert.equal(frame, null);
  const ghost = ghostPiece(state);
  assert.equal(frame.x, ghost.x, 'rendered column must match landing guide');
  assert.equal(frame.y, state.active.y);
  for (const progress of [-100, 0, 0.25, 0.99, 1, 1000, NaN]) {
    const offset = fallingOffset(progress, frame.travel, 24) / 24;
    for (const p of cells(state.active)) {
      assert(p.x >= 0 && p.x + 1 <= 10, 'rendered tile crosses wall');
      assert(p.y + offset + 1 <= 20, 'rendered tile crosses floor');
      assert(p.y + offset <= ghost.y + (p.y - state.active.y));
      for (let y = Math.max(0, Math.floor(p.y + offset)); y < Math.ceil(p.y + offset + 1); y++) {
        assert.equal(state.board[y][p.x], null, 'rendered tile crosses settled block');
      }
    }
  }
}

test('square follows the landing column after both swipes, never retains old coordinates', () => {
  let game = { ...createGame(42), active: { kind: 'O', rotation: 0, x: 4, y: 14 }, gravityMs: 360 };
  for (const direction of [-1, 1, -1, 1]) {
    for (let i = 0; i < 12; i++) {
      game = move(game, direction);
      check(game);
    }
  }
});

test('floor and stack suppress even stale animated offsets after rotation and soft drop', () => {
  for (const piece of [
    { kind: 'I', rotation: 0, x: 3, y: 18 },
    { kind: 'I', rotation: 1, x: -2, y: 5 },
    { kind: 'I', rotation: 3, x: 8, y: 5 },
    { kind: 'O', rotation: 0, x: 8, y: 18 },
  ]) {
    const game = { ...createGame(42), active: piece };
    check(game);
    check(rotate(game));
    check(softDrop(game));
  }
  const stacked = { ...createGame(42), active: { kind: 'O', rotation: 0, x: 4, y: 10 } };
  stacked.board[12][4] = 'J';
  assert.equal(fallingFrame(stacked).travel, 0);
  assert.equal(fallingOffset(1000, fallingFrame(stacked).travel, 24), 0);
  check(stacked);
});

test('rendered cells stay bounded through repeated drops, spawns, wall kicks and gravity', () => {
  for (let seed = 1; seed <= 40; seed++) {
    let game = createGame(seed);
    for (let step = 0; step < 240 && !game.over; step++) {
      game = [
        (g) => move(g, -1),
        rotate,
        (g) => move(g, 1),
        softDrop,
        (g) => tick(g, 87),
        (g) => tick(g, 720),
        hardDrop,
      ][(step * 17 + seed) % 7](game);
      check(game);
    }
  }
});

test('new piece starts at engine origin after hard drop instead of retaining the old fall', () => {
  const game = {
    ...createGame(42),
    active: { kind: 'O', rotation: 0, x: 0, y: 17 },
    gravityMs: 500,
  };
  const next = hardDrop(game);
  assert.equal(next.piecesPlaced, game.piecesPlaced + 1);
  assert.equal(fallingFrame(next).y, 0);
  assert.equal(fallingFrame(next).progress, 0);
  check(next);
  assert.equal(fallingFrame({ ...next, active: null, over: true }), null);
});
