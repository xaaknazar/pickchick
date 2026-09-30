import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE,
  COLS,
  ROWS,
  FOOD_IDS,
  START,
  VECTORS,
  createMaze,
  walkable,
  cellId,
  turn,
  step,
  advance,
  nextLevel,
  parseMaze,
  stepDuration,
} from '../../apps/mobile/src/games/pick-man/engine.ts';

function safe(game = createMaze(7)) {
  return {
    ...game,
    shield: 14,
    enemies: [
      { x: 1, y: 1, direction: 'right' },
      { x: 15, y: 1, direction: 'left' },
      { x: 8, y: 17, direction: 'up' },
    ],
  };
}
test('original maze has a closed border, reachable food, and valid spawns', () => {
  assert.equal(MAZE.length, ROWS);
  assert(MAZE.every((row) => row.length === COLS && row.startsWith('#') && row.endsWith('#')));
  assert.equal(MAZE[0], '#'.repeat(COLS));
  assert.equal(MAZE.at(-1), '#'.repeat(COLS));
  const seen = new Set([cellId(START)]),
    queue = [START];
  for (const p of queue)
    for (const d of Object.values(VECTORS)) {
      const n = { x: p.x + d.x, y: p.y + d.y };
      if (walkable(n) && !seen.has(cellId(n))) {
        seen.add(cellId(n));
        queue.push(n);
      }
    }
  assert(FOOD_IDS.every((id) => seen.has(id)));
  assert(FOOD_IDS.length > 100);
  assert(parseMaze(createMaze(0)));
});
test('fixed-step timing, buffered turns and walls behave deterministically', () => {
  const start = safe();
  assert.equal(advance(start, 100).player.x, start.player.x);
  assert.deepEqual(advance(advance(start, 100), 105), advance(start, 205));
  const buffered = step(turn({ ...start, player: { x: 3, y: 1, direction: 'left' } }, 'up'));
  assert.deepEqual(buffered.player, { x: 2, y: 1, direction: 'left' });
  assert.equal(buffered.desired, 'up');
  const stopped = step({ ...start, player: { x: 1, y: 1, direction: 'left' }, desired: 'up' });
  assert.deepEqual(stopped.player, { x: 1, y: 1, direction: 'left' });
  assert.strictEqual(advance(start, NaN), start);
  assert.strictEqual(advance(start, -10), start);
});
test('food is consumed once, power protects the player, collisions consume one life', () => {
  let g = step(safe());
  const score = g.score;
  assert(score > 0);
  assert(!g.remaining.includes(cellId(g.player)));
  g = step(turn(step(turn(g, 'right')), 'left'));
  assert.equal(g.score, score);
  const power = step({
    ...safe(),
    player: { x: 1, y: 2, direction: 'down' },
    desired: 'down',
    shield: 0,
  });
  assert.equal(power.power, 42);
  assert(power.score >= 50);
  const collision = {
    ...safe(),
    shield: 0,
    player: { x: 8, y: 10, direction: 'left' },
    desired: 'left',
    enemies: [
      { x: 7, y: 10, direction: 'right' },
      { x: 1, y: 1, direction: 'right' },
      { x: 15, y: 1, direction: 'left' },
    ],
  };
  const hit = step(collision);
  assert.equal(hit.lives, 2);
  assert.deepEqual(hit.player, START);
  assert.equal(hit.shield, 14);
  const powered = step({ ...collision, power: 10 });
  assert.equal(powered.lives, 3);
  assert(powered.score >= 200);
  const over = step({ ...collision, lives: 1 });
  assert.equal(over.status, 'over');
  assert.equal(over.lives, 0);
  assert.strictEqual(step(over), over);
});
test('last food completes a level; next level preserves score and lives', () => {
  const g = safe();
  g.remaining = [cellId({ x: 7, y: 10 })];
  g.lives = 2;
  const won = step(g);
  assert.equal(won.status, 'won');
  assert.equal(won.remaining.length, 0);
  const next = nextLevel(won);
  assert.equal(next.level, 2);
  assert.equal(next.lives, 2);
  assert.equal(next.score, won.score + 500);
  assert.equal(next.remaining.length, FOOD_IDS.length);
  assert(stepDuration(2) < stepDuration(1));
  assert(parseMaze(next));
  assert.strictEqual(nextLevel(g), g);
});
test('long random play never crosses walls or invents food and replays exactly', () => {
  let a = createMaze(997),
    b = createMaze(997);
  const directions = Object.keys(VECTORS);
  for (let i = 0; i < 3000; i++) {
    if (a.status === 'over') {
      a = createMaze(i);
      b = createMaze(i);
    }
    if (a.status === 'won') {
      a = nextLevel(a);
      b = nextLevel(b);
    }
    const direction = directions[(Math.imul(i, 17) >>> 2) % 4];
    a = advance(turn(a, direction), 83);
    b = advance(turn(b, direction), 83);
    assert(walkable(a.player));
    assert(a.enemies.every(walkable));
    assert(parseMaze(a));
    assert.deepEqual(a, b);
  }
});
test('invalid saved actors, states, timers and duplicated food fail validation', () => {
  const g = createMaze();
  for (const patch of [
    { player: { x: 0, y: 0, direction: 'left' } },
    { remaining: [1] },
    { remaining: [...g.remaining, g.remaining[0]] },
    { score: -1 },
    { remainder: Infinity },
    { remainder: stepDuration(1) },
    { enemies: [] },
    { lives: 0 },
    { status: 'won' },
    { power: 43 },
    { desired: 'diagonal' },
  ])
    assert.equal(parseMaze({ ...g, ...patch }), null);
  const parsed = parseMaze(g);
  parsed.remaining.pop();
  assert.notEqual(parsed.remaining.length, g.remaining.length);
});
