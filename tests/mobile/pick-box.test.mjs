import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  PickBoxEngine,
  BOX_WIDTH,
  BOX_HEIGHT,
  peakForScore,
} from '../../apps/mobile/src/games/pick-box/engine.ts';
import { cameraFloor } from '../../apps/mobile/src/games/pick-box/ascent.ts';
import { PickBoxRecords, parseRecord } from '../../apps/mobile/src/games/pick-box/storage.ts';

const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const { Body, Sleeping } = require('matter-js');
const frames = (game, count) => {
  for (let i = 0; i < count; i++) game.advance(1000 / 60);
};
const until = (game, condition, limit = 1800) => {
  for (let i = 0; i < limit && !condition(); i++) game.advance(1000 / 60);
  assert(condition(), `Condition not reached: ${JSON.stringify(game.snapshot())}`);
};
function stack(game) {
  const previous = game.score;
  const target =
    game.boxes
      .filter((b) => b.counted && !b.fallen)
      .sort((a, b) => a.body.position.y - b.body.position.y)[0]?.body.position.x ?? 180;
  until(game, () => game.canDrop && Math.abs(game.held.x + game.held.vx * 24 - target) < 1.3);
  assert(game.drop());
  until(game, () => game.score === previous + 1);
}

test('box collision proportions match the supplied 23 x 23 x 10 cm packaging', () => {
  assert(Math.abs(BOX_WIDTH / BOX_HEIGHT - 23 / 10) < 1e-12);
});
test('one tap releases only one box, and score waits for stable support', () => {
  const game = new PickBoxEngine();
  assert.equal(game.drop(), false);
  game.start();
  assert(game.drop());
  for (let i = 0; i < 20; i++) assert.equal(game.drop(), false);
  assert.equal(game.boxes.length, 1);
  assert.equal(game.score, 0);
  until(game, () => game.score === 1);
  frames(game, 300);
  assert.equal(game.score, 1);
  assert.equal(game.lives, 3);
  assert(game.canDrop);
  game.dispose();
});
test('twelve timed drops stack through real collisions and unlock Furmanov', () => {
  const game = new PickBoxEngine();
  game.start();
  for (let i = 0; i < 12; i++) stack(game);
  assert.equal(game.score, 12);
  assert.equal(game.lives, 3);
  assert.equal(game.snapshot().peak, 1);
  assert(game.top < -BOX_HEIGHT * 11.5);
  assert(game.boxes.every((b) => !b.body.isStatic));
  game.dispose();
});
test('edge drops rotate under gravity, miss once, and end on the third lost life', () => {
  const game = new PickBoxEngine();
  game.start();
  for (let lives = 3; lives > 0; lives--) {
    until(game, () => game.canDrop && game.held.x > 291);
    game.drop();
    const body = game.boxes.at(-1).body;
    let angle = 0;
    until(game, () => {
      angle = Math.max(angle, Math.abs(body.angle));
      return game.lives < lives;
    });
    assert(angle > 0.2, 'off-center contact must rotate the box');
    assert.equal(game.lives, lives - 1);
    if (lives > 1) {
      frames(game, 80);
      assert.equal(game.lives, lives - 1);
    }
  }
  assert.equal(game.score, 0);
  assert.equal(game.reason, 'lives');
  assert.equal(game.phase, 'over');
  assert.equal(game.drop(), false);
  game.dispose();
});
test('foundation loss ends the tower without waiting for three misses', () => {
  const game = new PickBoxEngine();
  game.start();
  for (let i = 0; i < 5; i++) stack(game);
  // A deterministic physical perturbation, not a mocked collision or score change.
  const base = game.boxes[0].body;
  Sleeping.set(base, false);
  Body.translate(base, { x: 200, y: 0 });
  Body.setVelocity(base, { x: 2, y: 0 });
  until(game, () => game.phase === 'over');
  assert.equal(game.reason, 'collapse');
  assert.equal(game.lives, 3);
  frames(game, 200);
  assert.equal(game.reason, 'collapse');
  game.dispose();
});
test('pausing freezes falling bodies, pendulum and score; resuming cannot fast-forward', () => {
  const game = new PickBoxEngine();
  game.start();
  game.drop();
  frames(game, 10);
  game.pause();
  const before = { p: { ...game.boxes[0].body.position }, time: game.time, held: game.held };
  game.advance(60_000);
  frames(game, 120);
  assert.deepEqual({ p: game.boxes[0].body.position, time: game.time, held: game.held }, before);
  assert.equal(game.drop(), false);
  game.resume();
  game.advance(60_000);
  assert(game.time - before.time <= 51);
  assert.equal(game.score, 0);
  until(game, () => game.score === 1);
  game.dispose();
});
test('nonfinite and negative time cannot poison the simulation', () => {
  const game = new PickBoxEngine();
  game.start();
  game.drop();
  for (const time of [NaN, Infinity, -Infinity, -20, 0]) game.advance(time);
  assert.equal(game.time, 0);
  frames(game, 150);
  assert.equal(game.score, 1);
  game.dispose();
});
test('new game clears lives, bodies, combo and camera target', () => {
  const old = new PickBoxEngine();
  old.start();
  stack(old);
  old.dispose();
  assert.equal(old.physics.world.bodies.length, 0);
  const game = new PickBoxEngine();
  assert.deepEqual(game.snapshot(), {
    phase: 'ready',
    score: 0,
    lives: 3,
    combo: 0,
    bestCombo: 0,
    drops: 0,
    settling: false,
    peak: 0,
    reason: null,
    canDrop: false,
  });
  assert.equal(game.top, 0);
  assert.equal(game.boxes.length, 0);
  game.dispose();
});
test('frame grouping does not change a seeded physics outcome', () => {
  const a = new PickBoxEngine(),
    b = new PickBoxEngine();
  a.start();
  b.start();
  a.drop();
  b.drop();
  frames(a, 120);
  for (let i = 0; i < 240; i++) b.advance(1000 / 120);
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert(Math.abs(a.boxes[0].body.position.y - b.boxes[0].body.position.y) < 0.1);
  a.dispose();
  b.dispose();
});
test('ascent reaches mountains, summit, atmosphere and space at stable boundaries', () => {
  assert.deepEqual(
    [0, 7, 8, 19, 20, 27, 28, 35, 36, 100].map(peakForScore),
    [0, 0, 1, 1, 2, 2, 3, 3, 4, 4],
  );
});
test('camera keeps the held box and landing face visible as the tower rises', () => {
  for (const height of [340, 500, 720, 920]) {
    for (const top of [0, -100, -600, -2000, -9000]) {
      const floor = cameraFloor(height, top);
      assert(top + floor >= 250, 'landing target must leave room for pendulum');
      assert(top + floor < height - 20, 'landing target must remain on screen');
      assert(top - 185 + floor - BOX_HEIGHT / 2 > 0, 'held box cannot clip the top');
    }
  }
});
test('records reject corrupt input and preserve the largest concurrent result', async () => {
  assert.equal(parseRecord(null), 0);
  for (const raw of ['-1', '1.5', 'Infinity', '{}', '10000000', ''])
    assert.equal(parseRecord(raw), null);
  let stored = '12';
  const store = new PickBoxRecords({
    read: async () => stored,
    write: async (v) => {
      stored = v;
    },
  });
  const values = await Promise.all([
    store.record(),
    store.record(19),
    store.record(13),
    store.record(26),
  ]);
  assert.equal(stored, '26');
  assert.equal(values.at(-1).best, 26);
});
test('storage failure keeps gameplay available and never overwrites an unread record', async () => {
  let writes = 0;
  const failed = new PickBoxRecords({
    read: async () => {
      throw Error('blocked');
    },
    write: async () => {
      writes++;
    },
  });
  assert.deepEqual(await failed.record(9), { best: 9, saved: false });
  assert.equal(writes, 0);
  const corrupt = new PickBoxRecords({
    read: async () => '{bad}',
    write: async () => {
      writes++;
    },
  });
  assert.equal((await corrupt.record(3)).saved, false);
  assert.equal(writes, 0);
});

test('a well-aligned forty-box tower can reach space through unmodified physics', () => {
  const game = new PickBoxEngine();
  game.start();
  for (let score = 0; score < 40; score++) {
    for (
      let i = 0;
      i < 2400 && !(game.canDrop && Math.abs(game.held.x + game.held.vx * 24 - 180) < 0.8);
      i++
    )
      game.advance(1000 / 120);
    assert(game.drop());
    for (let i = 0; i < 2400 && game.score === score && game.phase === 'playing'; i++)
      game.advance(1000 / 120);
    assert.equal(game.score, score + 1);
  }
  assert.equal(game.snapshot().peak, 4);
  assert.equal(game.phase, 'playing');
  assert(game.boxes.every((box) => !box.body.isStatic));
  game.dispose();
});
