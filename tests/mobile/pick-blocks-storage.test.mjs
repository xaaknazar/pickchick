import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, hardDrop } from '../../apps/mobile/src/games/pick-blocks/engine.ts';
import {
  PICK_BLOCKS_STORAGE_KEY,
  PickBlocksStorage,
  parseSavedPickBlocks,
} from '../../apps/mobile/src/games/pick-blocks/storage.ts';

const saved = (game = createGame(7), best = game?.score ?? 0) =>
  JSON.stringify({ version: 1, best, game });

function fixture(initial = null) {
  let raw = initial;
  let readFailure = false;
  let writeFailure = false;
  const writes = [];
  const io = {
    async read() {
      if (readFailure) throw new Error('Read failed');
      return raw;
    },
    async write(value) {
      if (writeFailure) throw new Error('Write failed');
      raw = value;
      writes.push(value);
    },
  };
  return {
    storage: new PickBlocksStorage(io),
    io,
    writes,
    raw: () => raw,
    failRead: (value) => (readFailure = value),
    failWrite: (value) => (writeFailure = value),
  };
}

test('a local-only snapshot survives a fresh storage owner with defensive game validation', async () => {
  const f = fixture();
  assert.deepEqual(await f.storage.load(), { snapshot: null, error: false });
  const game = hardDrop(createGame(7));
  assert.deepEqual(await f.storage.save(game, game.score), { ok: true, best: game.score });
  const fresh = new PickBlocksStorage(f.io);
  const { snapshot, error } = await fresh.load();
  assert.equal(error, false);
  assert.deepEqual(snapshot.game, game);
  assert.notEqual(snapshot.game, game);
  assert.equal(snapshot.best, game.score);
  assert.deepEqual(Object.keys(snapshot).sort(), ['best', 'game', 'version']);
  assert.equal(PICK_BLOCKS_STORAGE_KEY, 'pickchick.pick-blocks.v1');
});

test('invalid, oversized and unversioned data never becomes a playable saved game', async () => {
  const game = createGame(9);
  for (const raw of [
    '{',
    'x'.repeat(32_769),
    '[]',
    'null',
    JSON.stringify({ version: 2, best: 0, game }),
    JSON.stringify({ version: 1, best: -1, game }),
    JSON.stringify({ version: 1, best: 0.5, game }),
    JSON.stringify({ version: 1, best: Number.MAX_SAFE_INTEGER + 1, game }),
    JSON.stringify({ version: 1, best: 0, game: { ...game, board: [] } }),
    JSON.stringify({ version: 1, best: 0, game, customerId: 'not-a-game-field' }),
    JSON.stringify({ version: 1, best: 0 }),
  ]) {
    assert.equal(parseSavedPickBlocks(raw), null);
    const f = fixture(raw);
    assert.deepEqual(await f.storage.load(), { snapshot: null, error: true });
    assert.equal(f.raw(), raw, 'validation alone must not delete storage');
    assert.equal((await f.storage.save(game, 0)).ok, true);
    assert.deepEqual(parseSavedPickBlocks(f.raw()).game, game);
  }
});

test('the saved record cannot be lower than the saved game score', () => {
  const game = hardDrop(createGame(10));
  assert.ok(game.score > 0);
  assert.equal(parseSavedPickBlocks(saved(game, 0)).best, game.score);
});

test('rapid piece saves stay ordered and an immediate remount reads the newest completed save', async () => {
  let raw = null;
  let releaseFirst;
  const firstWrite = new Promise((resolve) => (releaseFirst = resolve));
  let enteredFirst;
  const entered = new Promise((resolve) => (enteredFirst = resolve));
  const starts = [];
  const storage = new PickBlocksStorage({
    async read() {
      return raw;
    },
    async write(value) {
      starts.push(JSON.parse(value).game.piecesPlaced);
      if (starts.length === 1) {
        enteredFirst();
        await firstWrite;
      }
      raw = value;
    },
  });
  const first = hardDrop(createGame(22));
  const second = hardDrop(first);
  const one = storage.save(first, first.score);
  const two = storage.save(second, second.score);
  const remount = storage.load();
  await entered;
  assert.deepEqual(starts, [1]);
  releaseFirst();
  assert.equal((await one).ok, true);
  assert.equal((await two).ok, true);
  assert.deepEqual(starts, [1, 2]);
  assert.deepEqual((await remount).snapshot.game, second);
});

test('queued saves capture an independent snapshot at request time', async () => {
  const f = fixture();
  const game = createGame(3);
  const expected = globalThis.structuredClone(game);
  const pending = f.storage.save(game, 0);
  game.board[19][0] = 'I';
  game.active.x += 1;
  assert.equal((await pending).ok, true);
  assert.deepEqual(parseSavedPickBlocks(f.raw()).game, expected);
});

test('failed reads never overwrite an unreadable save; recovery merges its previous record', async () => {
  const previous = saved(hardDrop(createGame(30)), 9000);
  const f = fixture(previous);
  f.failRead(true);
  assert.deepEqual(await f.storage.load(), { snapshot: null, error: true });
  assert.equal((await f.storage.save(createGame(31), 0)).ok, false);
  assert.equal(f.raw(), previous);
  assert.equal(f.writes.length, 0);
  f.failRead(false);
  assert.deepEqual(await f.storage.save(createGame(31), 0), { ok: true, best: 9000 });
  assert.equal(parseSavedPickBlocks(f.raw()).best, 9000);
});

test('a failed write preserves the last good state and does not poison later saves', async () => {
  const f = fixture(saved(createGame(44), 100));
  await f.storage.load();
  const previous = f.raw();
  f.failWrite(true);
  assert.deepEqual(await f.storage.save(hardDrop(createGame(44)), 600), { ok: false, best: 600 });
  assert.equal(f.raw(), previous);
  f.failWrite(false);
  const next = createGame(45);
  assert.deepEqual(await f.storage.save(next, 0), { ok: true, best: 600 });
  assert.equal(parseSavedPickBlocks(f.raw()).best, 600);
  assert.deepEqual(parseSavedPickBlocks(f.raw()).game, next);
});

test('invalid writes cannot clobber a valid game or its high score', async () => {
  const previous = saved(createGame(4), 50);
  const f = fixture(previous);
  await f.storage.load();
  for (const [game, best] of [
    [createGame(1), -1],
    [{}, 0],
    [createGame(1), Infinity],
  ]) {
    assert.equal((await f.storage.save(game, best)).ok, false);
    assert.equal(f.raw(), previous);
  }
  assert.equal((await f.storage.save(createGame(1), 0)).ok, true);
  assert.equal(parseSavedPickBlocks(f.raw()).best, 50);
});

test('separate installations do not share a game or record', async () => {
  const first = fixture();
  const second = fixture();
  await first.storage.save(hardDrop(createGame(16)), 1000);
  assert.deepEqual(await second.storage.load(), { snapshot: null, error: false });
  assert.equal(second.raw(), null);
});
