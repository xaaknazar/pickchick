import test from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from '../dist/runtime.js';
function scheduler() {
  let now = 0;
  const timers = [],
    completions = [];
  return {
    every(callback, period) {
      const timer = { callback, period, next: now + period, active: true };
      timers.push(timer);
      return () => {
        timer.active = false;
      };
    },
    later(callback, delay) {
      completions.push({ callback, at: now + delay });
    },
    advance(target) {
      for (; now <= target; now += 1000) {
        for (let i = completions.length - 1; i >= 0; i--)
          if (completions[i].at <= now) {
            const [entry] = completions.splice(i, 1);
            entry.callback();
          }
        for (const t of timers)
          if (t.active && t.next === now) {
            t.callback();
            t.next += t.period;
          }
      }
    },
  };
}
test('9-second full polls cannot starve LED rotation; only last complete snapshot is rendered', () => {
  const clock = scheduler();
  let completed = 0,
    reads = 0;
  const frames = [];
  const model = {
    state: { actor: {}, mode: 'display', busy: false, display: ['last-complete'] },
    refresh() {
      reads++;
      this.state.busy = true;
      clock.later(() => {
        completed++;
        this.state.display = ['complete-' + completed];
        this.state.busy = false;
      }, 9000);
    },
  };
  const stop = startRuntime(model, () => frames.push([...model.state.display]), clock.every);
  model.refresh();
  clock.advance(120000);
  assert.equal(reads, 13);
  assert.equal(completed, 12);
  assert.equal(frames.length, 15, 'rotation every8s despite9s reads');
  assert.deepEqual(frames[0], ['last-complete']);
  assert.ok(frames.every((f) => f.length === 1 && /^(last-complete|complete-\d+)$/.test(f[0])));
  stop();
  clock.advance(136000);
  assert.equal(frames.length, 15);
});
test('runtime still suppresses rotation for logged-out or kitchen sessions', () => {
  const clock = scheduler();
  let rotations = 0,
    polls = 0;
  const model = {
    state: { actor: null, mode: 'display', busy: false },
    async refresh() {
      polls++;
    },
  };
  startRuntime(model, () => rotations++, clock.every);
  clock.advance(16000);
  assert.equal(rotations, 0);
  assert.equal(polls, 0);
  model.state.actor = {};
  model.state.mode = 'kitchen';
  clock.advance(32000);
  assert.equal(rotations, 0);
  assert.ok(polls > 0);
  model.state.mode = 'display';
  model.state.busy = true;
  clock.advance(48000);
  assert.equal(rotations, 2);
  model.state.actor = null;
  clock.advance(64000);
  assert.equal(rotations, 2);
});
