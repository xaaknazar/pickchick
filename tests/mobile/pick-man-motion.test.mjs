import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMotion,
  queueMotion,
  advanceMotion,
} from '../../apps/mobile/src/games/pick-man/motion.ts';
const start = { x: 8, y: 10, direction: 'left' };
const left = { x: 7, y: 10, direction: 'left' };
const up = { x: 7, y: 9, direction: 'up' };

test('constant travel speed is independent of 30/60/120 Hz rendering', () => {
  for (const hz of [30, 60, 120]) {
    let motion = queueMotion(createMotion(start), left);
    for (let i = 0; i < hz / 10; i++) motion = advanceMotion(motion, 1000 / hz, 200);
    assert.ok(Math.abs(motion.x - 7.5) < 1e-9);
    assert.equal(motion.y, 10);
  }
});
test('early next step retains its corner and carries frame time into the next corridor', () => {
  let motion = advanceMotion(queueMotion(createMotion(start), left), 50, 200);
  motion = queueMotion(motion, up);
  assert.equal(motion.direction, 'left');
  for (let i = 0; i < 3; i++) {
    motion = advanceMotion(motion, 50, 200);
    assert.equal(motion.y, 10);
  }
  assert.equal(motion.x, 7);
  motion = advanceMotion(motion, 50, 200);
  assert.equal(motion.x, 7);
  assert.equal(motion.y, 9.75);
  assert.equal(motion.direction, 'up');
  let crossing = advanceMotion(queueMotion(queueMotion(createMotion(start), left), up), 80, 100);
  crossing = advanceMotion(crossing, 40, 100);
  assert.equal(crossing.x, 7);
  assert.ok(Math.abs(crossing.y - 9.8) < 1e-9);
});
test('stationary engine ticks do not restart motion, and idle frames do not overshoot', () => {
  const partial = advanceMotion(queueMotion(createMotion(start), left), 50, 200);
  assert.equal(queueMotion(partial, left), partial);
  let motion = partial;
  for (let i = 0; i < 10; i++) motion = advanceMotion(motion, 50, 200);
  assert.equal(motion.x, 7);
  assert.equal(motion.y, 10);
  assert.deepEqual(motion.queue, []);
  assert.equal(advanceMotion(motion, 50, 200), motion);
});
test('respawn and restore clear pending movement instead of crossing walls', () => {
  const moving = advanceMotion(queueMotion(createMotion(start), left), 50, 200);
  const spawn = { x: 1, y: 1, direction: 'right' };
  assert.deepEqual(queueMotion(moving, spawn), createMotion(spawn));
  assert.deepEqual(queueMotion(moving, left, true), createMotion(left));
  assert.equal(advanceMotion(moving, 0, 200), moving);
});
