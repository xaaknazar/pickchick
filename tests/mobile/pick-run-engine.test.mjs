import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceRun,
  createRun,
  jumpRun,
  parseRunBest,
  RUN_DURATION,
} from '../../apps/mobile/src/games/pick-run/engine.ts';
import { blockDrag, isBlockDrop } from '../../apps/mobile/src/games/pick-blocks/gestures.ts';

test('runner uses fixed steps and rejects invalid time; long stalls do not fast-forward the run', () => {
  const g = createRun(8);
  const a = advanceRun(g, 80),
    b = advanceRun(advanceRun(g, 40), 40);
  for (const key of ['x', 'elapsed', 'distance', 'y'])
    assert.ok(Math.abs(a[key] - b[key]) < 0.000001);
  assert.strictEqual(advanceRun(g, NaN), g);
  assert.strictEqual(advanceRun(g, -1), g);
  assert.ok(advanceRun(g, 9000).elapsed <= 100.01);
});
test('jump is physical, cannot double-jump, and buffers a tap just before landing', () => {
  let g = jumpRun(createRun());
  g = advanceRun(g, 100);
  assert.ok(g.y > 40);
  assert.equal(jumpRun(g).velocity, g.velocity);
  const landed = advanceRun(jumpRun({ ...g, y: 1, velocity: -300 }), 20);
  assert.ok(landed.velocity > 0, 'early tap should jump on landing');
});
test('collision loses one life, breaks a combo, grants recovery, and a clear jump passes safely', () => {
  const g = { ...createRun(), x: 75, combo: 5 };
  const hit = advanceRun(g, 20);
  assert.equal(hit.lives, 2);
  assert.equal(hit.combo, 0);
  assert.ok(hit.shield > 0);
  assert.equal(advanceRun(hit, 100).lives, 2);
  assert.equal(advanceRun({ ...g, y: 90, velocity: 0 }, 20).lives, 3);
});
test('food rewards one collection only and combo bonus is local score', () => {
  const g = { ...createRun(), x: 63, y: 85, velocity: 0, combo: 2 };
  const collected = advanceRun(g, 10);
  assert.equal(collected.collected, true);
  assert.equal(collected.score, 15);
  assert.equal(collected.combo, 3);
  assert.equal(advanceRun(collected, 10).score, 15);
});
test('run ends at the finish or third collision and input cannot mutate a finished game', () => {
  const ended = advanceRun({ ...createRun(), elapsed: RUN_DURATION - 10 }, 20);
  assert.equal(ended.over, true);
  assert.strictEqual(jumpRun(ended), ended);
  assert.strictEqual(advanceRun(ended, 100), ended);
  assert.equal(advanceRun({ ...createRun(), lives: 1, x: 70 }, 20).over, true);
});
test('score parsing rejects malformed values; horizontal thumb wobble does not lower a block', () => {
  for (const raw of [null, '-2', 'Infinity', '12abc', '1000001', '{}'])
    assert.equal(parseRunBest(raw), 0);
  assert.equal(parseRunBest('125'), 125);
  assert.deepEqual(blockDrag(60, 18, 20), { x: 3, y: 0 });
  assert.deepEqual(blockDrag(10, 65, 20), { x: 0, y: 3 });
  assert.equal(isBlockDrop(5, 80, 20, 150), true);
  assert.equal(isBlockDrop(65, 80, 20, 150), false);
  assert.equal(isBlockDrop(5, 80, 20, 400), false);
});

test('a consistently timed single jump clears a full run across difficulty levels', () => {
  let g = createRun(123);
  for (let i = 0; i < 1400 && !g.over; i++) {
    if (g.y === 0 && g.x < 164 && g.x > 100) g = jumpRun(g);
    g = advanceRun(g, 40);
  }
  assert.equal(g.over, true);
  assert.ok(g.elapsed >= RUN_DURATION - 1, 'all 45 seconds are playable');
  assert.equal(g.lives, 3);
  assert.ok(g.score > 100);
});
