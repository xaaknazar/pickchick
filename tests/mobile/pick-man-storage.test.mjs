import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMaze, step } from '../../apps/mobile/src/games/pick-man/engine.ts';
import { MazeStorage, parseSnapshot } from '../../apps/mobile/src/games/pick-man/storage.ts';
test('serialized writes preserve newest progress and the highest personal record', async () => {
  let raw = null;
  const storage = new MazeStorage({
    read: async () => raw,
    write: async (value) => {
      await new Promise((r) => setTimeout(r, 2));
      raw = value;
    },
  });
  const g = createMaze(),
    next = step(g);
  await Promise.all([storage.save(g, 900), storage.save(next, 20)]);
  const restored = await storage.load();
  assert.equal(restored.error, false);
  assert.equal(restored.snapshot.best, 900);
  assert.deepEqual(restored.snapshot.game, next);
});
test('failed saves can be retried; invalid snapshots never enter the game', async () => {
  let fails = true,
    raw = null;
  const storage = new MazeStorage({
    read: async () => {
      if (fails) throw Error('read');
      return raw;
    },
    write: async (value) => {
      if (fails) throw Error('write');
      raw = value;
    },
  });
  assert.equal((await storage.load()).error, true);
  assert.equal(await storage.save(createMaze(), 0), false);
  fails = false;
  assert.equal(await storage.save(createMaze(), 0), true);
  assert((await storage.load()).snapshot.game);
  for (const value of [
    '{',
    'x'.repeat(18001),
    JSON.stringify({ version: 1, best: -1, game: null }),
    JSON.stringify({ version: 1, best: 0, game: {} }),
  ])
    assert.equal(parseSnapshot(value), null);
});
