import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PickBoxEngine, BOX_HEIGHT } from '../../apps/mobile/src/games/pick-box/engine.ts';
import { PickBoxRecords } from '../../apps/mobile/src/games/pick-box/storage.ts';
import {
  cameraFloor,
  worldScale,
  nextMilestone,
} from '../../apps/mobile/src/games/pick-box/ascent.ts';
import { boxCount } from '../../apps/mobile/src/games/pick-box/copy.ts';
import {
  parsePreferences,
  DEFAULT_PREFERENCES,
} from '../../apps/mobile/src/games/pick-box/preferences.ts';

const advance = (game, ms) => {
  for (let t = 0; t < ms; t += 1000 / 120) game.advance(1000 / 120);
};

test('failed write retains the session maximum until it is really persisted', async () => {
  let stored = '3',
    blocked = true;
  const record = new PickBoxRecords({
    read: async () => stored,
    write: async (value) => {
      if (blocked) throw Error('full');
      stored = value;
    },
  });
  assert.deepEqual(await record.record(12), { best: 12, saved: false });
  assert.deepEqual(await record.record(0), { best: 12, saved: false });
  assert.equal(stored, '3');
  blocked = false;
  assert.deepEqual(await record.record(4), { best: 12, saved: true });
  assert.equal(stored, '12');
  assert.deepEqual(await record.record(0), { best: 12, saved: true });
});
test('a failed read preserves the in-memory maximum and retries without overwriting unread data', async () => {
  let blocked = true,
    stored = '30',
    writes = 0;
  const record = new PickBoxRecords({
    read: async () => {
      if (blocked) throw Error('unavailable');
      return stored;
    },
    write: async (value) => {
      stored = value;
      writes++;
    },
  });
  assert.deepEqual(await record.record(12), { best: 12, saved: false });
  assert.deepEqual(await record.record(0), { best: 12, saved: false });
  assert.equal(writes, 0);
  blocked = false;
  assert.deepEqual(await record.record(5), { best: 30, saved: true });
  for (const invalid of [NaN, Infinity, -5, 2.5, 10_000_000])
    assert.deepEqual(await record.record(invalid), { best: 30, saved: true });
  assert.equal(writes, 0);
});
test('corrupt data remains untouched while the session best stays visible', async () => {
  let writes = 0;
  const record = new PickBoxRecords({
    read: async () => '{bad}',
    write: async () => {
      writes++;
    },
  });
  assert.deepEqual(await record.record(12), { best: 12, saved: false });
  assert.deepEqual(await record.record(0), { best: 12, saved: false });
  assert.equal(writes, 0);
});
test('first-time coaching waits for a tap then releases through real physics', () => {
  const game = new PickBoxEngine({ guideFirstDrop: true });
  assert.equal(game.needsFrames, false);
  game.start();
  const pose = game.held;
  advance(game, 8000);
  assert.deepEqual(game.held, pose);
  assert.equal(game.score, 0);
  assert(game.drop());
  advance(game, 1600);
  assert.equal(game.score, 1);
  assert.equal(game.snapshot().drops, 1);
  assert(game.time > 1500);
  assert.notDeepEqual(game.held, pose);
  game.pause();
  assert.equal(game.needsFrames, false);
  const time = game.time;
  advance(game, 1500);
  assert.equal(game.time, time);
  game.resume();
  assert(game.needsFrames);
  game.dispose();
});
test('a repeat player gets a moving pendulum; cooldown hides the unready box', () => {
  const game = new PickBoxEngine();
  game.start();
  const x = game.held.x;
  advance(game, 100);
  assert.notEqual(game.held.x, x);
  game.drop();
  assert.equal(game.isHolding, false);
  for (let i = 0; i < 1500 && game.score === 0; i++) game.advance(1000 / 120);
  assert.equal(game.score, 1);
  assert(game.isWaiting);
  assert.equal(game.isHolding, false);
  advance(game, 600);
  assert.equal(game.isWaiting, false);
  assert(game.isHolding);
  assert(game.canDrop);
  assert.equal(game.snapshot().bestCombo, game.combo);
  game.dispose();
});
test('short and large-text playfields keep the held box, landing and side margins visible', () => {
  for (const width of [280, 320, 393, 540])
    for (const pixels of [120, 194, 240, 340, 720]) {
      const scale = worldScale(width, pixels),
        height = pixels / scale;
      assert(scale * 360 < width);
      for (const top of [0, -600, -2000, -9000]) {
        const floor = cameraFloor(height, top);
        assert((top + floor + BOX_HEIGHT / 2) * scale < pixels);
        assert((top - 185 + floor - BOX_HEIGHT / 2 - 30) * scale >= 0);
      }
    }
});
test('every milestone has a nearby target including after reaching space', () => {
  assert.deepEqual(
    [0, 7, 8, 20, 28, 35, 36, 40, 100].map((score) => nextMilestone(score).target),
    [8, 8, 20, 28, 36, 36, 40, 50, 110],
  );
  for (let score = 0; score <= 120; score++) {
    const next = nextMilestone(score);
    assert(next.remaining > 0);
    assert.equal(next.remaining, next.target - score);
  }
});
test('Russian box counts and independent sound/haptic settings survive invalid storage', () => {
  assert.deepEqual(
    [0, 1, 2, 4, 5, 11, 14, 21, 22, 111].map((n) => boxCount(n, 'ru')),
    [
      '0 коробок',
      '1 коробка',
      '2 коробки',
      '4 коробки',
      '5 коробок',
      '11 коробок',
      '14 коробок',
      '21 коробка',
      '22 коробки',
      '111 коробок',
    ],
  );
  assert.equal(boxCount(1, 'en'), '1 box');
  assert.equal(boxCount(2, 'en'), '2 boxes');
  assert.equal(boxCount(1, 'kk'), '1 қорап');
  assert.deepEqual(parsePreferences('invalid'), DEFAULT_PREFERENCES);
  assert.deepEqual(parsePreferences('{"sound":false,"haptics":true,"tutorialDone":true}'), {
    sound: false,
    haptics: true,
    tutorialDone: true,
  });
  assert.deepEqual(parsePreferences('{"sound":"false","haptics":false}'), {
    sound: true,
    haptics: false,
    tutorialDone: false,
  });
});
test('local audio adds neither microphone permission nor background playback', async () => {
  const config = JSON.parse(await readFile(new URL('../../apps/mobile/app.json', import.meta.url)));
  const plugin = config.expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-audio');
  assert.deepEqual(plugin[1], {
    microphonePermission: false,
    recordAudioAndroid: false,
    enableBackgroundRecording: false,
    enableBackgroundPlayback: false,
  });
  for (const name of ['drop', 'impact', 'perfect', 'miss', 'peak', 'collapse']) {
    const wav = await readFile(
      new URL(`../../apps/mobile/assets/games/pick-box/audio/${name}.wav`, import.meta.url),
    );
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert(wav.length < 40_000);
  }
});
