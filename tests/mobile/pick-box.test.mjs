import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PickBoxEngine,
  BOX_WIDTH,
  BOX_HEIGHT,
  SAFE_OVERHANG,
  STEP_MS,
  peakForScore,
} from '../../apps/mobile/src/games/pick-box/engine.ts';
import { cameraFloor } from '../../apps/mobile/src/games/pick-box/ascent.ts';
import { PickBoxRecords, parseRecord } from '../../apps/mobile/src/games/pick-box/storage.ts';

const frames = (game, count) => {
  for (let i = 0; i < count; i++) game.advance(1000 / 60);
};
const until = (game, condition, limit = 1800) => {
  for (let i = 0; i < limit && !condition(); i++) game.advance(1000 / 60);
  assert(condition(), `Condition not reached: ${JSON.stringify(game.snapshot())}`);
};
const topBox = (game) => game.boxes.filter((b) => b.counted && !b.fallen).at(-1);
function stack(game, offset = 0) {
  const previous = game.score;
  const target = () => (topBox(game)?.body.position.x ?? 180) + offset;
  until(game, () => game.canDrop && Math.abs(game.held.x + game.held.vx * 24 - target()) < 1.3);
  assert(game.drop());
  until(game, () => game.score === previous + 1 || game.phase === 'over');
}

/** Where a box released now comes down: the engine's own free fall, replayed step by step. */
function landing(game) {
  const held = game.held;
  let x = held.x,
    y = held.y,
    dx = held.vx / 2,
    dy = 0.1;
  for (let i = 0; i < 400 && y < game.top - BOX_HEIGHT / 2; i++) {
    dx *= 1 - 0.0045;
    dy = dy * (1 - 0.0045) + 0.001 * STEP_MS * STEP_MS;
    x += dx;
    y += dy;
  }
  return x;
}
/** Like `stack`, but lands within a unit or two of the wanted offset however tall the tower. */
function place(game, offset = 0) {
  const previous = game.score;
  const target = () => (topBox(game)?.body.position.x ?? 180) + offset;
  until(game, () => game.canDrop && Math.abs(landing(game) - target()) < 0.8, 2400);
  assert(game.drop());
  until(game, () => game.score === previous + 1 || game.phase === 'over');
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
  // Settled boxes are held by the tower; only the box in flight is a free body.
  assert(game.boxes.every((b) => b.counted && b.body.isStatic));
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
    swaying: false,
    leaning: 0,
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

test('a well-aligned forty-box tower reaches space without swaying', () => {
  const game = new PickBoxEngine();
  game.start();
  for (let score = 0; score < 40; score++) {
    stack(game);
    assert.equal(game.score, score + 1);
    assert.equal(game.swaying, false, `box ${score + 1}: balance ${game.balance}`);
  }
  assert.equal(game.snapshot().peak, 4);
  assert.equal(game.phase, 'playing');
  assert.equal(game.swaying, false);
  assert(game.boxes.every((box) => box.body.isStatic));
  game.dispose();
});
test('mountain wind swings the rope harder than the city air', () => {
  const swing = (score) => {
    const game = new PickBoxEngine();
    game.start();
    game.score = score;
    let angle = 0;
    for (let i = 0; i < 900; i++) {
      game.advance(1000 / 60);
      angle = Math.max(angle, Math.abs(game.held.angle));
    }
    game.dispose();
    return angle;
  };
  assert(swing(0) <= 0.076);
  assert(swing(22) > 0.1);
});
test('in space a meteor flies in and knocks the hanging box', () => {
  const game = new PickBoxEngine();
  game.start();
  game.score = 40;
  const kinds = new Set();
  const emit = game.emit.bind(game);
  game.emit = (kind, ...rest) => (kinds.add(kind), emit(kind, ...rest));
  let seen = false,
    angle = 0;
  for (let i = 0; i < 60 * 9 && !kinds.has('meteor'); i++) {
    game.advance(1000 / 60);
    seen ||= game.meteor.visible;
  }
  assert(seen, 'the meteor is visible before it hits');
  assert(kinds.has('meteor'));
  for (let i = 0; i < 60; i++) {
    game.advance(1000 / 60);
    angle = Math.max(angle, Math.abs(game.held.angle));
  }
  assert(angle > 0.12, `knock angle ${angle}`);
  assert.equal(game.phase, 'playing');
  game.dispose();
});
test('a box hanging far over the edge tips off instead of sticking', () => {
  const game = new PickBoxEngine();
  game.start();
  stack(game);
  const before = game.score;
  const target = topBox(game).body.position.x + 54;
  until(game, () => game.canDrop && Math.abs(game.held.x + game.held.vx * 24 - target) < 1.3);
  game.drop();
  const body = game.boxes.at(-1).body;
  until(game, () => game.lives === 2);
  assert.equal(game.score, before);
  assert(!game.boxes.some((b) => b.body === body && b.counted));
  game.dispose();
});
const share = (px) => px / ((BOX_WIDTH / 2) * SAFE_OVERHANG);
test('a low stack stands still however crooked it is', () => {
  // Owner, 16.11.2026: two boxes, the second a little crooked, must not start swaying.
  const game = new PickBoxEngine();
  const kinds = new Set();
  const emit = game.emit.bind(game);
  game.emit = (kind, ...rest) => (kinds.add(kind), emit(kind, ...rest));
  game.start();
  for (const offset of [0, 40, 0]) {
    stack(game, offset);
    assert.equal(game.swaying, false);
    assert.equal(game.snapshot().swaying, false);
    frames(game, 90);
    for (let i = 0; i < 240; i++) {
      game.advance(1000 / 120);
      assert.equal(game.sway, 0);
    }
    assert(game.boxes.every((b) => b.body.position.x === b.rest.x));
  }
  assert(game.balance > share(30), `balance ${game.balance}`);
  assert(!kinds.has('wobble'));
  game.dispose();
});
test('a crooked box beds in: after six straight boxes the tower stands as usual', () => {
  // Owner, 16.11.2026: a crooked box low down, then five or six straight ones, and the
  // tower must stand normally again.
  const game = new PickBoxEngine();
  game.start();
  for (const offset of [0, 40]) place(game, offset);
  assert(game.balance > share(30), `balance ${game.balance}`);
  for (let i = 0; i < 2; i++) place(game);
  assert(game.balance > 0.3, `still settling: balance ${game.balance}`);
  for (let i = 0; i < 4; i++) place(game);
  frames(game, 600);
  assert.equal(game.phase, 'playing');
  assert.equal(game.score, 8);
  assert.equal(game.lives, 3);
  assert(Math.abs(game.balance) < 0.3, `balance ${game.balance}`);
  assert.equal(game.swaying, false);
  assert.equal(game.drift, 0, 'one crooked box is not a creeping tower');
  assert.equal(game.snapshot().leaning, 0);
  assert(game.swayAmplitude < 0.5);
  game.dispose();
});
test('a crooked box moves an unsettled tower more than a settled one', () => {
  const swing = (offsets) => {
    const game = new PickBoxEngine();
    game.start();
    for (const offset of offsets) stack(game, offset);
    frames(game, 360);
    stack(game, 22);
    let widest = 0;
    for (let i = 0; i < 240; i++) {
      game.advance(1000 / 120);
      widest = Math.max(widest, game.swayAmplitude);
    }
    assert.equal(game.phase, 'playing');
    game.dispose();
    return widest;
  };
  const settled = swing([0, 0, 0, 0, 0, 0]);
  const unsettled = swing([0, 0, 0, 0, 40, 0]);
  assert(settled > 2, `a crooked box always moves the tower: ${settled}`);
  assert(unsettled > settled * 1.2, JSON.stringify({ settled, unsettled }));
});
test('crooked boxes swing the tower to their own side; straight boxes calm it', () => {
  const game = new PickBoxEngine();
  const kinds = new Set();
  const emit = game.emit.bind(game);
  game.emit = (kind, ...rest) => (kinds.add(kind), emit(kind, ...rest));
  game.start();
  for (const offset of [0, 0, 0, 0, -26, -26]) place(game, offset);
  assert.equal(game.phase, 'playing');
  assert(game.balance < -0.7, `balance ${game.balance}`);
  assert(game.swaying && game.snapshot().swaying);
  assert(kinds.has('wobble'));
  // Boxes went left, so the top leans and swings left of where it rests.
  let left = 0,
    right = 0,
    sum = 0;
  for (let i = 0; i < 480; i++) {
    game.advance(1000 / 120);
    left = Math.min(left, game.sway);
    right = Math.max(right, game.sway);
    sum += game.sway;
  }
  assert(sum / 480 < -2, `mean sway ${sum / 480}`);
  assert(left < -5 && right < -left / 3, JSON.stringify({ left, right }));
  assert(right - left > 3, 'it keeps swinging near the tipping point');
  for (let i = 0; i < 6 && game.swaying; i++) place(game);
  assert.equal(game.swaying, false, `balance ${game.balance}`);
  for (let i = 0; i < 3; i++) place(game);
  frames(game, 900);
  assert(game.swayAmplitude < 0.3, `amplitude ${game.swayAmplitude}`);
  assert(Math.abs(game.balance) < 0.3, `balance ${game.balance}`);
  assert.equal(game.phase, 'playing');
  assert.equal(game.lives, 3);
  game.dispose();
});
test('the tower bends as one column: boxes tilt with it and do not slide apart', () => {
  const game = new PickBoxEngine();
  game.start();
  for (let i = 0; i < 14; i++) stack(game);
  frames(game, 240);
  game.balance = 0.9;
  until(game, () => game.sway > 10);
  const tower = game.boxes.filter((b) => b.counted && !b.fallen);
  const moved = tower.map((b) => b.body.position.x - b.rest.x);
  assert(
    moved.every((x, i) => i === 0 || x >= moved[i - 1]),
    'higher boxes move further',
  );
  assert(moved[0] < 1 && moved.at(-1) > 9, JSON.stringify(moved));
  const top = tower.at(-1);
  const step = moved.at(-1) - moved.at(-2);
  const tilt = top.body.angle - top.rest.angle;
  assert(tilt > 0, 'leaning right turns the boxes clockwise');
  // The boxes show 70 % of the column's slope, so the faces stay together to the eye.
  const turn = (tilt * BOX_HEIGHT) / step;
  assert(turn > 0.55 && turn < 0.95, JSON.stringify({ tilt, step, turn }));
  game.dispose();
});
test('a staircase to one side tips its top off that side; the base stands', () => {
  const game = new PickBoxEngine();
  game.start();
  for (let i = 0; i < 6; i++) stack(game);
  stack(game, -38);
  assert.equal(game.phase, 'playing');
  assert(game.swaying, 'one crooked box only warns');
  stack(game, -38);
  assert.equal(game.phase, 'over');
  assert.equal(game.reason, 'collapse');
  assert(game.balance <= -1, `balance ${game.balance}`);
  assert.equal(game.lives, 3);
  const loose = game.boxes.filter((b) => !b.body.isStatic);
  assert.equal(loose.length, 2);
  assert(game.boxes[0].body.isStatic);
  const before = loose.map((b) => b.body.position.x);
  frames(game, 90);
  assert(loose.at(-1).body.position.x < before.at(-1) - 40, 'the top falls to the left');
  assert.equal(game.drop(), false);
  game.dispose();
});
test('a tall tower leans and sways wider and slower than a short one', () => {
  const measure = (boxes) => {
    const game = new PickBoxEngine();
    game.start();
    for (let i = 0; i < boxes; i++) stack(game);
    game.balance = -0.9;
    frames(game, 600);
    let left = Infinity,
      right = -Infinity,
      crossings = 0,
      sum = 0,
      previous = game.sway;
    const samples = [];
    for (let i = 0; i < 600; i++) {
      game.advance(1000 / 60);
      samples.push(game.sway);
      left = Math.min(left, game.sway);
      right = Math.max(right, game.sway);
      sum += game.sway;
    }
    const mid = sum / samples.length;
    for (const value of samples) {
      if ((previous - mid) * (value - mid) < 0) crossings++;
      previous = value;
    }
    game.dispose();
    return { width: right - left, lean: mid, crossings };
  };
  const stub = measure(3);
  const short = measure(8);
  const tall = measure(26);
  const report = JSON.stringify({ stub, short, tall });
  assert.equal(stub.width, 0, report);
  assert(short.lean < 0 && tall.lean < short.lean * 1.5, report);
  assert(tall.width > short.width * 1.5, report);
  assert(tall.crossings < short.crossings, report);
});
test('a landing shivers the top of the tower, which then settles', () => {
  const game = new PickBoxEngine();
  game.start();
  for (let i = 0; i < 7; i++) stack(game);
  const top = topBox(game);
  const target = top.body.position.x;
  until(game, () => game.canDrop && Math.abs(game.held.x + game.held.vx * 24 - target) < 1.3);
  game.drop();
  let moved = 0;
  until(game, () => {
    moved = Math.max(moved, Math.abs(top.body.position.x - top.rest.x));
    return game.score === 8;
  });
  assert(moved > 0.3, `top moved ${moved}`);
  frames(game, 600);
  assert(game.swayAmplitude < 0.2);
  assert(Math.abs(top.body.position.x - top.rest.x) < 2);
  game.dispose();
});

const restX = (game) => game.boxes.filter((b) => b.counted && !b.fallen).map((b) => b.rest.x);
test('a tower that keeps creeping to one side leans, is warned and falls that way', () => {
  // Owner, 17.11.2026 (TestFlight 39, 88 boxes): the tower had walked more than a box
  // width to the right, every joint only a little off, and still stood.
  const game = new PickBoxEngine();
  const kinds = [];
  const emit = game.emit.bind(game);
  game.emit = (kind, ...rest) => (kinds.push(kind), emit(kind, ...rest));
  game.start();
  for (let i = 0; i < 10; i++) place(game);
  assert.equal(game.drift, 0);
  let warned = 0;
  let swayed = 0;
  let widest = 0;
  // It creeps a little with every box, then goes straight up from where it got to.
  while (game.phase === 'playing' && game.score < 60) {
    place(game, game.score < 22 ? 8 : 0);
    if (game.phase !== 'playing') break;
    const hud = game.snapshot();
    if (hud.leaning && !warned) {
      warned = game.score;
      assert.equal(hud.leaning, 1, 'it leans to the side it crept to');
      assert.equal(hud.swaying, false, 'the warning comes before the tower rocks');
      assert(kinds.includes('wobble'), 'the warning is felt as well as read');
      assert(game.sway > 2, `the column visibly leans right: ${game.sway}`);
    }
    if (hud.swaying && !swayed) swayed = game.score;
    widest = Math.max(widest, restX(game).at(-1) - 180);
  }
  const report = JSON.stringify({ warned, swayed, fell: game.score, widest, drift: game.drift });
  assert.equal(game.phase, 'over', report);
  assert.equal(game.reason, 'collapse', report);
  assert.equal(game.lives, 3);
  assert(game.drift >= 1 && game.balance >= 1, report);
  assert(warned && swayed > warned, report);
  assert(game.score - warned >= 5, `too little time to stack back: ${report}`);
  // Before the fix a tower walked 150 units sideways and off the screen (408 units wide).
  assert(widest > 80 && 180 + widest + BOX_WIDTH / 2 < 384, report);
  const loose = game.boxes.filter((b) => !b.body.isStatic);
  assert(loose.length >= 6 && loose.length <= 12, `loose ${loose.length}`);
  const before = loose.at(-1).body.position.x;
  frames(game, 90);
  assert(loose.at(-1).body.position.x > before + 40, 'the top falls to the right');
  game.dispose();
});
test('stacking back the other way saves a tower that crept sideways', () => {
  const game = new PickBoxEngine();
  game.start();
  for (let i = 0; i < 10; i++) place(game);
  for (let i = 0; i < 19; i++) place(game, 3);
  let warned = 0;
  // Straight boxes on a crept tower still pile weight on the far side: the warning comes.
  while (game.score < 75) {
    const hud = game.snapshot();
    if (hud.leaning) warned++;
    place(game, -12 * hud.leaning);
    assert.equal(game.phase, 'playing', `box ${game.score}: drift ${game.drift}`);
  }
  assert(warned > 0, 'the player was told to stack back');
  assert.equal(game.lives, 3);
  assert(Math.abs(game.drift) < 0.5, `drift ${game.drift}`);
  assert.equal(game.swaying, false);
  game.dispose();
});
