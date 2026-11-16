import Matter from 'matter-js';
import { ASCENT_STEPS, ascentStage } from './ascent.ts';

const { Engine, Bodies, Body, Composite, Events, Sleeping } = Matter;
export const WORLD_WIDTH = 360;
export const BOX_WIDTH = 126;
export const BOX_HEIGHT = (BOX_WIDTH * 10) / 23;
export const PLATFORM_WIDTH = 190;
export const STEP_MS = 1000 / 120;
export const INITIAL_LIVES = 3;

/*
 * Tower balance (owner request, 16 November 2026). Settled boxes are held by the
 * game instead of raw stacked physics, so an early crooked box cannot topple a tower
 * that has since been built straight. Each placement adds its offset from the box
 * below to a signed lean; older offsets fade with every new box, faster after a
 * PERFECT. A strong lean makes the top of the tower sway; straight placements calm
 * it again. A lean beyond the limit breaks the top of the tower off.
 */
export const LEAN_MEMORY = 0.72;
export const PERFECT_CALM = 0.75;
export const LEAN_LIMIT = 85;
export const SWAY_FROM = 0.4;
export const SWAY_MAX = 30;
export const SWAY_DEPTH = 7;
const COLLAPSE_DEPTH = 10;

export type Phase = 'ready' | 'playing' | 'paused' | 'over';
export type Box = {
  id: number;
  body: Matter.Body;
  counted: boolean;
  fallen: boolean;
  /** Pose the held tower returns to when it is not swaying. */
  rest?: { x: number; y: number; angle: number };
  /** Smoothed share of the sway this box follows; 1 at the top. */
  sway?: number;
};
export type Cue = {
  kind: 'drop' | 'impact' | 'land' | 'perfect' | 'miss' | 'collapse' | 'peak' | 'wobble';
  x: number;
  y: number;
  time: number;
};
export type Pose = { x: number; y: number; angle: number; vx: number };
export type Snapshot = {
  phase: Phase;
  score: number;
  lives: number;
  combo: number;
  bestCombo: number;
  drops: number;
  settling: boolean;
  peak: number;
  reason: 'lives' | 'collapse' | null;
  canDrop: boolean;
  swaying: boolean;
};

export const PEAK_THRESHOLDS = ASCENT_STEPS;
export const peakForScore = ascentStage;

/** All physics uses world coordinates, independent of screen size, camera and effects. */
export class PickBoxEngine {
  readonly physics: Matter.Engine;
  readonly platform: Matter.Body;
  boxes: Box[] = [];
  phase: Phase = 'ready';
  score = 0;
  lives = INITIAL_LIVES;
  combo = 0;
  bestCombo = 0;
  reason: Snapshot['reason'] = null;
  time = 0;
  top = 0;
  cues: Cue[] = [];
  /** Signed tower lean in world units; positive leans right. */
  lean = 0;
  /** Current sway amplitude at the top of the tower, in world units. */
  swayAmplitude = 0;
  private swayPhase = 0;
  private active: Box | null = null;
  private settledFor = 0;
  private fallingFor = 0;
  private cooldown = 0;
  private accumulator = 0;
  private sequence = 0;
  private impactPlayed = false;
  private endedAt = 0;
  private version = 0;
  private lastVersion = -1;

  private readonly options: { guideFirstDrop?: boolean };

  constructor(options: { guideFirstDrop?: boolean } = {}) {
    this.options = options;
    this.physics = Engine.create({
      enableSleeping: true,
      positionIterations: 12,
      velocityIterations: 10,
    });
    this.platform = Bodies.rectangle(WORLD_WIDTH / 2, 22, PLATFORM_WIDTH, 44, {
      isStatic: true,
      friction: 0.85,
      label: 'platform',
    });
    Composite.add(this.physics.world, this.platform);
    Events.on(this.physics, 'collisionStart', ({ pairs }) => {
      if (!this.active || this.impactPlayed) return;
      if (pairs.some((p) => p.bodyA === this.active?.body || p.bodyB === this.active?.body)) {
        this.impactPlayed = true;
        this.version++;
        this.emit('impact', this.active.body.position.x, this.active.body.position.y);
      }
    });
  }

  get canDrop() {
    return this.phase === 'playing' && !this.active && this.cooldown <= 0;
  }

  get held(): Pose {
    const speed = 1.35 + Math.min(this.score, 40) * 0.017;
    const phase = (this.time / 1000) * speed;
    const amplitude = 112 + Math.min(this.score * 0.65, 23);
    return {
      x: WORLD_WIDTH / 2 + Math.sin(phase) * amplitude,
      y: this.top - 185 + (1 - Math.cos(Math.sin(phase) * 0.6)) * 100,
      angle: Math.sin(phase) * 0.075,
      // A little momentum remains after release; the player can learn to lead the target.
      vx: ((Math.cos(phase) * amplitude * speed) / 60) * 0.18,
    };
  }

  get isHolding() {
    return !this.active && this.cooldown <= 0 && this.phase !== 'over';
  }

  get isWaiting() {
    return !this.active && this.cooldown > 0;
  }

  get needsFrames() {
    return this.phase === 'playing' || (this.phase === 'over' && this.time - this.endedAt <= 1800);
  }

  start() {
    if (this.phase !== 'ready') return;
    this.phase = 'playing';
    this.version++;
  }

  pause() {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.accumulator = 0;
    this.version++;
  }

  resume() {
    if (this.phase !== 'paused') return;
    this.phase = 'playing';
    this.accumulator = 0;
    this.version++;
  }

  drop(): boolean {
    if (!this.canDrop) return false;
    const pose = this.held;
    const body = Bodies.rectangle(pose.x, pose.y, BOX_WIDTH, BOX_HEIGHT, {
      angle: pose.angle,
      density: 0.002,
      friction: 0.75,
      frictionStatic: 0.9,
      frictionAir: 0.009,
      restitution: 0.035,
      sleepThreshold: 90,
      chamfer: { radius: 1.5 },
      label: 'pick-box',
    });
    Body.setVelocity(body, { x: pose.vx, y: 0.2 });
    this.active = { id: ++this.sequence, body, counted: false, fallen: false };
    this.boxes.push(this.active);
    Composite.add(this.physics.world, body);
    this.impactPlayed = false;
    this.settledFor = this.fallingFor = 0;
    this.emit('drop', pose.x, pose.y);
    this.version++;
    return true;
  }

  /** Cap elapsed time after a stalled frame. Never simulate a hidden app catching up. */
  advance(elapsedMs: number) {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || this.phase === 'paused') return;
    if (this.phase === 'over' && this.time - this.endedAt > 1800) return;
    if (this.phase === 'ready') {
      this.time += Math.min(elapsedMs, 50);
      return;
    }
    this.accumulator += Math.min(elapsedMs, 50);
    while (this.accumulator >= STEP_MS) {
      this.step();
      this.accumulator -= STEP_MS;
    }
  }

  private step() {
    // A new player's first box waits calmly for the taught tap. Later rounds use the normal swing.
    if (this.phase === 'playing' && this.options.guideFirstDrop && this.sequence === 0) return;
    this.time += STEP_MS;
    Engine.update(this.physics, STEP_MS);
    if (this.phase === 'playing') {
      if (this.cooldown > 0) {
        this.cooldown -= STEP_MS;
        if (this.cooldown <= 0) this.version++;
      }
      this.swayTower();
      this.checkActive();
    }
    // Fallen boxes leave the world. Settled boxes remain dynamic, even below the camera.
    this.boxes = this.boxes.filter((box) => {
      if (box.body.position.y < 600 && Math.abs(box.body.position.x - 180) < 1000) return true;
      Composite.remove(this.physics.world, box.body);
      return false;
    });
    this.cues = this.cues.filter((cue) => this.time - cue.time < 1400);
  }

  /** 0 when straight, 1 at the collapse limit. */
  get danger() {
    return Math.min(1, Math.abs(this.lean) / LEAN_LIMIT);
  }

  get swaying() {
    return this.danger > SWAY_FROM;
  }

  private tower() {
    return this.boxes.filter((box) => box.counted && !box.fallen && box.rest);
  }

  /** Kinematic sway of the held tower; the settling box rides along with its support. */
  private swayTower() {
    const tower = this.tower();
    const strength = Math.max(0, (this.danger - SWAY_FROM) / (1 - SWAY_FROM));
    const target = SWAY_MAX * strength ** 1.2;
    const blend = 1 - Math.exp(-STEP_MS / 600);
    this.swayAmplitude += (target - this.swayAmplitude) * blend;
    if (this.swayAmplitude < 0.02 && target === 0) this.swayAmplitude = 0;
    // Period shortens from 2.6 s to 1.6 s as the lean approaches the limit.
    this.swayPhase += ((2 * Math.PI) / (2600 - 1000 * strength)) * STEP_MS;
    const bias = 0.35 * Math.max(-1, Math.min(1, this.lean / (0.6 * LEAN_LIMIT)));
    const offset = this.swayAmplitude * (Math.sin(this.swayPhase) + bias);
    const top = tower.at(-1);
    const before = top ? top.body.position.x : 0;
    tower.forEach((box, index) => {
      const depth = tower.length - 1 - index;
      const share = Math.max(0, 1 - depth / SWAY_DEPTH) ** 2;
      box.sway = (box.sway ?? share) + (share - (box.sway ?? share)) * blend;
      if (share === 0 && box.sway < 1e-3) box.sway = 0;
      const rest = box.rest!;
      const x = rest.x + offset * box.sway;
      if (box.body.position.x === x && box.body.angle === rest.angle && share === 0) return;
      const bend = (2 * Math.max(0, 1 - depth / SWAY_DEPTH)) / (SWAY_DEPTH * BOX_HEIGHT);
      Body.setPosition(box.body, { x, y: rest.y });
      Body.setAngle(box.body, rest.angle + offset * bend * 0.35 * Math.min(1, box.sway * 2));
    });
    if (top && this.active && this.impactPlayed) {
      const shift = top.body.position.x - before;
      if (shift) Body.translate(this.active.body, { x: shift, y: 0 });
    }
  }

  /** Lock a settled box into the held tower and update the lean. */
  private hold(box: Box, offset: number, perfect: boolean) {
    const body = box.body;
    const top = this.tower().at(-1);
    const shift = top?.rest ? top.body.position.x - top.rest.x : 0;
    box.rest = { x: body.position.x - shift, y: body.position.y, angle: body.angle };
    box.sway = top?.sway ?? 0;
    Body.setStatic(body, true);
    const wasSwaying = this.swaying;
    this.lean = this.lean * LEAN_MEMORY * (perfect ? PERFECT_CALM : 1) + offset;
    // A straight-standing tower always warns by swaying before it can fall.
    if (!wasSwaying && Math.abs(this.lean) >= LEAN_LIMIT)
      this.lean = Math.sign(this.lean) * LEAN_LIMIT * 0.95;
    if (!wasSwaying && this.swaying) this.emit('wobble', body.position.x, body.bounds.min.y);
  }

  /** The top of the tower breaks off towards its lean; the lower part stays standing. */
  private topple() {
    const tower = this.tower();
    const direction = Math.sign(this.lean) || 1;
    tower.forEach((box, index) => {
      const depth = tower.length - 1 - index;
      if (depth >= COLLAPSE_DEPTH) return;
      const lift = 1 - depth / COLLAPSE_DEPTH;
      Body.setStatic(box.body, false);
      Sleeping.set(box.body, false);
      Body.setVelocity(box.body, { x: direction * (0.4 + 2.6 * lift), y: -0.2 * lift });
      Body.setAngularVelocity(box.body, direction * 0.035 * lift);
      box.fallen = true;
    });
  }

  private checkActive() {
    if (!this.active) return;
    const box = this.active;
    const body = box.body;
    this.fallingFor += STEP_MS;
    const supported = this.physics.pairs.list.some((pair: Matter.Pair) => {
      if (!pair.isActive || (pair.bodyA !== body && pair.bodyB !== body)) return false;
      const other = pair.bodyA === body ? pair.bodyB : pair.bodyA;
      return (
        other.position.y > body.position.y &&
        (other === this.platform ||
          this.boxes.some((b) => b.body === other && b.counted && !b.fallen))
      );
    });
    const calm = body.speed < 0.48 && body.angularSpeed < 0.015 && Math.abs(body.angle) < 0.48;
    this.settledFor = supported && calm ? this.settledFor + STEP_MS : 0;
    if (this.settledFor >= 300) {
      const support = this.tower().at(-1);
      const offset = body.position.x - (support?.body.position.x ?? WORLD_WIDTH / 2);
      const perfect = Math.abs(offset) <= 8 && Math.abs(body.angle) < 0.08;
      box.counted = true;
      this.hold(box, offset, perfect);
      const previousPeak = peakForScore(this.score);
      this.score++;
      this.combo = perfect ? this.combo + 1 : 0;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      this.top = Math.min(
        0,
        ...this.boxes.filter((b) => b.counted && !b.fallen).map((b) => b.body.bounds.min.y),
      );
      this.emit(perfect ? 'perfect' : 'land', body.position.x, body.bounds.min.y);
      if (peakForScore(this.score) !== previousPeak)
        this.emit('peak', body.position.x, body.bounds.min.y);
      this.active = null;
      this.cooldown = 450;
      this.version++;
      if (Math.abs(this.lean) >= LEAN_LIMIT) {
        this.topple();
        this.end('collapse');
      }
    } else if (
      body.position.y > 200 ||
      body.position.x < -BOX_WIDTH ||
      body.position.x > WORLD_WIDTH + BOX_WIDTH ||
      this.fallingFor > 9500
    ) {
      this.lives--;
      this.combo = 0;
      this.emit('miss', body.position.x, Math.min(body.position.y, this.top + 60));
      // A tipped box still participates physically; a miss is only charged once.
      this.active = null;
      this.cooldown = 550;
      this.version++;
      if (!this.lives) this.end('lives');
    }
  }

  private end(reason: Snapshot['reason']) {
    this.phase = 'over';
    this.reason = reason;
    this.endedAt = this.time;
    this.version++;
    if (reason === 'collapse') this.emit('collapse', 180, this.top);
  }

  private emit(kind: Cue['kind'], x: number, y: number) {
    this.cues.push({ kind, x, y, time: this.time });
  }

  snapshot(): Snapshot {
    return {
      phase: this.phase,
      score: this.score,
      lives: this.lives,
      combo: this.combo,
      bestCombo: this.bestCombo,
      drops: this.sequence,
      settling: !!this.active && this.impactPlayed,
      peak: peakForScore(this.score),
      reason: this.reason,
      canDrop: this.canDrop,
      swaying: this.swaying,
    };
  }

  /** React's HUD only receives changes, never a render on each physics tick. */
  changed(): Snapshot | null {
    if (this.version === this.lastVersion) return null;
    this.lastVersion = this.version;
    return this.snapshot();
  }

  dispose() {
    Events.off(this.physics, 'collisionStart');
    Composite.clear(this.physics.world, false);
    Engine.clear(this.physics);
  }
}
