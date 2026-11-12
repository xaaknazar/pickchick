import Matter from 'matter-js';
import { ASCENT_STEPS, ascentStage } from './ascent.ts';

const { Engine, Bodies, Body, Composite, Events } = Matter;
export const WORLD_WIDTH = 360;
export const BOX_WIDTH = 126;
export const BOX_HEIGHT = (BOX_WIDTH * 10) / 23;
export const PLATFORM_WIDTH = 190;
export const STEP_MS = 1000 / 120;
export const INITIAL_LIVES = 3;

export type Phase = 'ready' | 'playing' | 'paused' | 'over';
export type Box = { id: number; body: Matter.Body; counted: boolean; fallen: boolean };
export type Cue = {
  kind: 'drop' | 'impact' | 'land' | 'perfect' | 'miss' | 'collapse' | 'peak';
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
  peak: number;
  reason: 'lives' | 'collapse' | null;
  canDrop: boolean;
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
  reason: Snapshot['reason'] = null;
  time = 0;
  top = 0;
  cues: Cue[] = [];
  private active: Box | null = null;
  private settledFor = 0;
  private fallingFor = 0;
  private cooldown = 0;
  private accumulator = 0;
  private sequence = 0;
  private impactPlayed = false;
  private collapseFor = 0;
  private foundation: Box | null = null;
  private lostBoxes = 0;
  private endedAt = 0;
  private version = 0;
  private lastVersion = -1;

  constructor() {
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
    return !this.active && this.phase !== 'over';
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
    this.time += STEP_MS;
    Engine.update(this.physics, STEP_MS);
    if (this.phase === 'playing') {
      if (this.cooldown > 0) {
        this.cooldown -= STEP_MS;
        if (this.cooldown <= 0) this.version++;
      }
      this.checkTower();
      if (this.phase === 'playing') this.checkActive();
    }
    // Fallen boxes leave the world. Settled boxes remain dynamic, even below the camera.
    this.boxes = this.boxes.filter((box) => {
      if (box.body.position.y < 600 && Math.abs(box.body.position.x - 180) < 1000) return true;
      Composite.remove(this.physics.world, box.body);
      return false;
    });
    this.cues = this.cues.filter((cue) => this.time - cue.time < 1400);
  }

  private checkTower() {
    const counted = this.boxes.filter((box) => box.counted && !box.fallen);
    for (const box of counted) {
      const { x, y } = box.body.position;
      if (y > BOX_HEIGHT || x < -BOX_WIDTH || x > WORLD_WIDTH + BOX_WIDTH) {
        box.fallen = true;
        this.lostBoxes++;
        this.emit('collapse', x, y);
      }
    }
    const foundation = this.foundation;
    const foundationLost =
      foundation?.fallen || (foundation && Math.abs(foundation.body.angle) > 1.0);
    const majorityLost = this.lostBoxes >= Math.max(1, Math.ceil(this.score / 2));
    this.collapseFor = foundationLost || majorityLost ? this.collapseFor + STEP_MS : 0;
    if (this.collapseFor > 180) this.end('collapse');
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
      box.counted = true;
      this.foundation ??= box;
      const support = this.boxes
        .filter((b) => b !== box && b.counted && !b.fallen)
        .sort((a, b) => a.body.position.y - b.body.position.y)[0];
      const perfect =
        Math.abs(body.position.x - (support?.body.position.x ?? 180)) <= 8 &&
        Math.abs(body.angle) < 0.08;
      const previousPeak = peakForScore(this.score);
      this.score++;
      this.combo = perfect ? this.combo + 1 : 0;
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
      peak: peakForScore(this.score),
      reason: this.reason,
      canDrop: this.canDrop,
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
