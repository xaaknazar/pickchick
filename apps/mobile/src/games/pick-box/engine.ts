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
 * Tower model (owner, 16 November 2026: "like real life, fitting its own physics").
 * A box falls and lands as a free rigid body. Once it rests flat it becomes part of
 * the tower, and the tower behaves like one flexible column standing on its base:
 *  - Balance. A box must keep the centre of mass of the boxes above it over itself.
 *    `balance` is the worst such overhang, signed, as a share of the safe half-width.
 *  - Bedding in. A joint that has carried weight for a while has settled: its overhang
 *    counts in full for the first two boxes above it and then fades (`BEDDING`), so a
 *    crooked box stops mattering after five or six straight ones. The fade is steep
 *    enough that a straight box never makes the balance worse.
 *  - Drift. Bedding in forgives one crooked box, not a tower that keeps creeping to one
 *    side (owner, 17 November 2026: a tower that had walked a box and a half sideways
 *    still stood). The whole weight above every box, however old the joint, must stay
 *    over that box: past `COLUMN_FREE` of its half-width the column starts to lean on
 *    it, and just past its edge (`COLUMN_LIMIT`) everything above tips off.
 *  - Lean. The column leans towards the heavy side, in proportion to the balance.
 *  - Sway. The column is a damped spring. A landing pushes it towards the side the box
 *    landed on, harder the further off centre it lands; it swings there first, then
 *    back and forth, and settles. An unsettled tower is livelier: the same push moves
 *    it further and it takes longer to calm down. Close to the tipping point it cannot
 *    settle at all and keeps swaying until it is stacked straight.
 *  - Height. A stack of up to four boxes is rigid and does not move at all. Above that the
 *    tower grows more flexible with every box: it leans and sways wider and slower.
 *  - Shape. The whole column bends from its base and every box tilts with the bend, so
 *    boxes never slide across each other.
 *  - Collapse. When the overhang reaches the edge (balance 1) the boxes above the
 *    overloaded one tip off towards the lean; the boxes under it stay standing.
 */
/** How much a joint still counts with 1, 2, 3... boxes above it. */
export const BEDDING = [1, 1, 0.85, 0.72, 0.58, 0.4, 0.2] as const;
/** Share of half a box the weight above may overhang before the top tips off. */
export const SAFE_OVERHANG = 0.85;
/**
 * Share of half a box the whole weight above a box may sit off its middle for free: as far
 * as one box can hang and still rest, so a single crooked box is forgotten as before.
 */
export const COLUMN_FREE = 0.76;
/**
 * Share of half a box at which the weight above tips off. A real stack goes at 1, the edge;
 * the tenth on top is the game's margin, and it lets the tower fall just as its top
 * reaches the edge of the screen.
 */
export const COLUMN_LIMIT = 1.1;
/** Share of the way from free to falling at which the player is told to stack back. */
export const LEAN_WARNING = 0.15;
/** Boxes that visibly tip off in a collapse; the camera never shows more of the tower. */
const TOPPLE_MAX = 12;
/** Danger (0..1) from which the tower can no longer settle on its own. */
export const SWAY_FROM = 0.4;
/** The column's deflection grows with height to this power: between rocking and bending. */
const SHAPE = 1.7;
/** Share of the column's slope the boxes visibly tilt by; the full slope unsettles landings. */
const TILT = 0.7;
const SWAY_MAX = 24;
const LEAN_MAX = 18;
const LANDING_PUSH = 26;
const DAMPING = 0.11;
/** Towers this tall sway at their slowest and widest. */
const TALL_TOWER = 30;
/** A stack this low is rigid: it neither leans nor sways, however crooked (owner, 16.11). */
export const STIFF_STACK = 4;
/** Wind on the rope by ascent stage: city, Furmanov, Talgar, atmosphere, space. */
const WIND = [0, 0.5, 0.8, 1, 0] as const;
const HOLD_REACH = 135;
export const METEOR_FLIGHT_MS = 900;

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
  /** Tilt the box landed with and is still settling out of, in radians. */
  lay?: number;
};
export type Cue = {
  kind: 'drop' | 'impact' | 'land' | 'perfect' | 'miss' | 'collapse' | 'peak' | 'wobble' | 'meteor';
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
  /** Side the tower has crept to and now leans on: stack back the other way. */
  leaning: -1 | 0 | 1;
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
  /**
   * Worst overhang in the tower after bedding in: how far the centre of mass of the boxes
   * above a box sits from its middle, as a share of the safe half-width. Positive is to
   * the right; at 1 the top tips off.
   */
  balance = 0;
  private balanceBreak = 0;
  /**
   * Worst overhang of a whole column of boxes over an old joint, 0 while it is within
   * `COLUMN_FREE` and 1 at `COLUMN_LIMIT`, where it falls. Signed like `balance`.
   */
  drift = 0;
  /**
   * Midway between the leftmost and rightmost box of the tower: boxes stacked here hang
   * least over either of them, so this is where a crept tower has to come back to.
   */
  private home = WORLD_WIDTH / 2;
  /** Top of the tower relative to rest, in world units: steady lean plus spring swing. */
  private leanNow = 0;
  private swingX = 0;
  private swingV = 0;
  private jolt = { at: -1e9, amp: 0 };
  private kick = { at: -1e9, dir: 0 };
  private rng = 0x5049434b;
  private meteorAt = 0;
  private meteorFrom = 1;
  private active: Box | null = null;
  private settledFor = 0;
  /** The active box hangs too far over or rests tilted, and is being tipped off. */
  private tipping = false;
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
        // The landing knocks the top of the tower; a hard landing shivers it more.
        const body = this.active.body;
        this.jolt = {
          at: this.time,
          amp: Math.min(3.5, 0.25 * body.speed) * (Math.sign(body.velocity.x) || 1),
        };
        this.emit('impact', this.active.body.position.x, this.active.body.position.y);
      }
    });
  }

  get canDrop() {
    return this.phase === 'playing' && !this.active && this.cooldown <= 0;
  }

  /** Rope pendulum: wind in the mountains, meteor knocks in space. */
  private pose(time: number) {
    const speed = 1.35 + Math.min(this.score, 40) * 0.017;
    const wind = WIND[peakForScore(this.score)] ?? 0;
    const phase = (time / 1000) * speed * (1 + 0.22 * wind);
    const gust = 0.5 + 0.5 * Math.sin(time * 0.00071 + 1.3);
    const amplitude = Math.min(
      HOLD_REACH,
      112 + Math.min(this.score * 0.65, 23) + 18 * wind * gust,
    );
    const swing = Math.sin(phase);
    const since = time - this.kick.at;
    const knock =
      since >= 0 && since < 2600
        ? Math.exp(-since / 650) * Math.sin((since / 1000) * 2 * Math.PI * 1.4)
        : 0;
    return {
      x: WORLD_WIDTH / 2 + swing * amplitude + this.kick.dir * 26 * knock,
      y: this.top - 185 + (1 - Math.cos(swing * 0.6)) * 100,
      angle: swing * (0.075 + 0.05 * wind) + this.kick.dir * 0.3 * knock,
    };
  }

  get held(): Pose {
    const pose = this.pose(this.time);
    // A little momentum remains after release; the player can learn to lead the target.
    const perMs = (this.pose(this.time + 1).x - this.pose(this.time - 1).x) / 2;
    return { ...pose, vx: ((perMs * 1000) / 60) * 0.18 };
  }

  /** The meteor flying at the held box in space, in world coordinates. */
  get meteor(): { x: number; y: number; dir: number; visible: boolean } {
    const progress = 1 - (this.meteorAt - this.time) / METEOR_FLIGHT_MS;
    if (!this.meteorAt || progress < 0 || progress >= 1 || !this.isHolding)
      return { x: 0, y: 0, dir: this.meteorFrom, visible: false };
    const target = this.pose(this.time);
    const startX = this.meteorFrom > 0 ? WORLD_WIDTH + 40 : -40;
    const eased = progress * progress;
    return {
      x: startX + (target.x - this.meteorFrom * 50 - startX) * eased,
      y: target.y - 150 + 150 * eased,
      dir: this.meteorFrom,
      visible: true,
    };
  }

  private random() {
    this.rng ^= this.rng << 13;
    this.rng ^= this.rng >>> 17;
    this.rng ^= this.rng << 5;
    this.rng >>>= 0;
    return this.rng / 0x1_0000_0000;
  }

  /** In space a small meteor now and then knocks the hanging box sideways. */
  private meteors() {
    if (peakForScore(this.score) < 4) {
      this.meteorAt = 0;
      return;
    }
    if (!this.meteorAt) {
      this.meteorAt = this.time + 3500 + this.random() * 3500;
      this.meteorFrom = this.random() < 0.5 ? -1 : 1;
      return;
    }
    if (this.time < this.meteorAt) return;
    if (this.isHolding) {
      // It hits the box from its own side and pushes it the other way.
      this.kick = { at: this.time, dir: -this.meteorFrom };
      const pose = this.pose(this.time);
      this.emit('meteor', pose.x + this.meteorFrom * 50, pose.y);
    }
    this.meteorAt = 0;
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
    this.tipping = false;
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
      if (this.phase === 'playing') this.meteors();
    }
    // Fallen boxes leave the world. Settled boxes remain dynamic, even below the camera.
    this.boxes = this.boxes.filter((box) => {
      if (box.body.position.y < 600 && Math.abs(box.body.position.x - 180) < 1000) return true;
      Composite.remove(this.physics.world, box.body);
      return false;
    });
    this.cues = this.cues.filter((cue) => this.time - cue.time < 1400);
  }

  /** 0 while the weight sits well inside the boxes, 1 at the tipping point. */
  get danger() {
    return Math.max(0, Math.min(1, (Math.abs(this.balance) - 0.3) / 0.7));
  }

  get swaying() {
    return this.danger > SWAY_FROM && this.mast().flex > 0;
  }

  /**
   * The tower has crept to one side (1 right, -1 left): its weight is close to the edge of
   * a box further down and its top is still out on that side. Stacking straight does not
   * cure this; boxes must go back the other way until the top is over the tower's middle.
   */
  get leaning(): -1 | 0 | 1 {
    if (Math.abs(this.drift) < LEAN_WARNING || this.mast().flex === 0) return 0;
    // Fresh crooked boxes on top are the more urgent warning while they rock the tower.
    if (this.drift !== this.balance && this.swaying) return 0;
    const top = this.tower().at(-1)?.rest;
    const out = top ? top.x - this.home : 0;
    // Back over the middle, straight boxes are what brings the weight home.
    if (Math.abs(out) <= BOX_WIDTH / 16 || out * this.drift <= 0) return 0;
    return out > 0 ? 1 : -1;
  }

  /** How far the top is from rest right now, and how wide it is swinging. */
  get sway() {
    return this.leanNow + this.swingX;
  }

  get swayAmplitude() {
    return Math.hypot(this.swingX, this.swingV / this.mast().omega);
  }

  private tower() {
    return this.boxes.filter((box) => box.counted && !box.fallen && box.rest);
  }

  /** A taller tower is a longer column: more flexible, with a slower swing. */
  private mast() {
    const boxes = this.tower().length;
    const tall = Math.min(1, boxes / TALL_TOWER);
    const give = Math.max(0, Math.min(1, (boxes - STIFF_STACK) / (TALL_TOWER - STIFF_STACK)));
    return {
      tall,
      // A few boxes stand like a block; the give grows with every box above that.
      flex: 1.2 * give ** 0.8,
      // Radians per millisecond: a 1.1 s swing for a stub, 2.6 s for a tall tower. Close
      // to tipping the column has little left to pull it back and swings slower still.
      omega: ((2 * Math.PI) / (1100 + 1500 * tall)) * (1 - 0.25 * this.danger),
    };
  }

  /** Lean and spring swing of the held tower; the settling box rides along with its support. */
  private swayTower() {
    const tower = this.tower();
    const { flex, omega } = this.mast();
    const blend = 1 - Math.exp(-STEP_MS / 400);
    const side = Math.sign(this.balance);
    this.leanNow +=
      (Math.max(-1.2, Math.min(1.2, this.balance)) * LEAN_MAX * flex - this.leanNow) * blend;
    // Near the tipping point the tower keeps a swing of this width instead of settling.
    const strength = Math.max(0, (this.danger - SWAY_FROM) / (1 - SWAY_FROM));
    const sustain = SWAY_MAX * flex * strength ** 1.2;
    const width = Math.hypot(this.swingX, this.swingV / omega);
    if (sustain > 0 && width < 0.4) this.swingV = (side || 1) * omega * 0.6;
    // An unsettled tower loses its swing more slowly.
    const calmDown = DAMPING * (1 - 0.6 * Math.min(1, Math.abs(this.balance)));
    const damping =
      sustain > 0
        ? Math.max(-0.6, calmDown * (1 - (sustain / Math.max(width, 0.4)) ** 2))
        : calmDown;
    this.swingV += (-omega * omega * this.swingX - 2 * damping * omega * this.swingV) * STEP_MS;
    this.swingX += this.swingV * STEP_MS;
    if (sustain === 0 && width < 0.02) this.swingX = this.swingV = 0;
    if (Math.abs(this.leanNow) < 0.01 && this.balance === 0) this.leanNow = 0;
    const since = this.time - this.jolt.at;
    const jolt =
      since >= 0 && since < 900
        ? this.jolt.amp * Math.exp(-since / 160) * Math.sin((since / 1000) * 2 * Math.PI * 9)
        : 0;
    // A low stack hardly shivers under a landing; a tall one passes the knock up.
    const offset = this.leanNow + this.swingX + jolt * Math.min(1, tower.length / 8);
    const top = tower.at(-1);
    const before = top ? { x: top.body.position.x, angle: top.body.angle } : null;
    tower.forEach((box, index) => {
      const height = (index + 1) / tower.length;
      const share = height ** SHAPE;
      box.sway = (box.sway ?? share) + (share - (box.sway ?? share)) * blend;
      const rest = box.rest!;
      // Far down a tall tower the movement is too small to see; those boxes stand still.
      const moves = Math.abs(offset * box.sway) >= 0.2;
      const x = moves ? rest.x + offset * box.sway : rest.x;
      // Each box tilts with the slope of the bent column under it.
      const slope = (TILT * SHAPE * box.sway) / (height * tower.length * BOX_HEIGHT);
      // A box that came to rest slightly tilted lies down flat on its support.
      if (box.lay) box.lay = Math.abs(box.lay) < 1e-3 ? 0 : box.lay * Math.exp(-STEP_MS / 90);
      const angle = (moves ? rest.angle + offset * slope : rest.angle) + (box.lay ?? 0);
      if (box.body.position.x === x && box.body.angle === angle) return;
      Body.setPosition(box.body, { x, y: rest.y });
      Body.setAngle(box.body, angle);
    });
    if (top && before && this.active && this.impactPlayed) {
      const shift = top.body.position.x - before.x;
      const turn = top.body.angle - before.angle;
      if (shift) Body.translate(this.active.body, { x: shift, y: 0 });
      if (turn) {
        // Carried round with the box it rests on.
        const pivot = top.body.position;
        const body = this.active.body;
        const dx = body.position.x - pivot.x;
        const dy = body.position.y - pivot.y;
        const cos = Math.cos(turn);
        const sin = Math.sin(turn);
        Body.setPosition(body, {
          x: pivot.x + dx * cos - dy * sin,
          y: pivot.y + dx * sin + dy * cos,
        });
        Body.rotate(body, turn);
      }
    }
  }

  /** Where a box resting on the top of the swaying tower sits once the tower is at rest. */
  private atRest(body: Matter.Body) {
    const top = this.tower().at(-1);
    if (!top?.rest) return { x: body.position.x, offset: body.position.x - WORLD_WIDTH / 2 };
    const bend = top.body.angle - top.rest.angle;
    const x = body.position.x - (top.body.position.x - top.rest.x) - bend * BOX_HEIGHT;
    return { x, offset: x - top.rest.x };
  }

  /** Lock a settled box into the held tower; its weight pushes and re-balances the column. */
  private hold(box: Box, perfect: boolean) {
    const body = box.body;
    const top = this.tower().at(-1);
    const { x, offset } = this.atRest(body);
    // At rest a box lies flat on the one below; the tilt it landed with settles out.
    box.lay = body.angle - (top?.rest ? top.body.angle : 0);
    box.rest = { x, y: body.position.y, angle: top?.rest?.angle ?? 0 };
    box.sway = top?.sway ?? 0;
    Body.setStatic(body, true);
    const wasWarned = this.swaying || this.leaning !== 0;
    const unrest = Math.min(1, Math.abs(this.balance));
    const { flex, omega } = this.mast();
    if (perfect) {
      // A centred box steadies the tower.
      this.swingX *= 0.5;
      this.swingV *= 0.5;
    }
    // Off-centre weight lands on one side and pushes the top that way first; a tower
    // that has not settled yet is pushed further.
    if (top)
      this.swingV +=
        omega * (offset / (BOX_WIDTH / 2)) * LANDING_PUSH * flex ** 0.7 * (1 + 0.5 * unrest);
    this.measureBalance();
    if (!wasWarned && (this.swaying || this.leaning !== 0))
      this.emit('wobble', body.position.x, body.bounds.min.y);
  }

  /** Like a real stack: the boxes above each box must keep their weight over it. */
  private measureBalance() {
    const tower = this.tower();
    const half = BOX_WIDTH / 2;
    this.balance = 0;
    this.balanceBreak = 0;
    this.drift = 0;
    let weight = 0;
    for (let above = 1; above < tower.length; above++) {
      const index = tower.length - 1 - above;
      weight += tower[index + 1]!.rest!.x;
      const overhang = weight / above - tower[index]!.rest!.x;
      // A fresh joint: counts in full at first and fades as it beds in.
      const fresh = (overhang / (half * SAFE_OVERHANG)) * (BEDDING[above - 1] ?? 0);
      // Any joint, however old: the whole weight above it has crept towards its edge.
      const over = Math.abs(overhang) / half - COLUMN_FREE;
      const column = over > 0 ? (Math.sign(overhang) * over) / (COLUMN_LIMIT - COLUMN_FREE) : 0;
      if (Math.abs(column) > Math.abs(this.drift)) this.drift = column;
      const share = Math.abs(column) > Math.abs(fresh) ? column : fresh;
      if (Math.abs(share) > Math.abs(this.balance)) {
        this.balance = share;
        this.balanceBreak = above;
      }
    }
    const xs = tower.map((box) => box.rest!.x);
    this.home = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : WORLD_WIDTH / 2;
  }

  /** The boxes above the overloaded one tip off towards the lean; the rest stays standing. */
  private topple(direction: number, reach: number) {
    const tower = this.tower();
    // Deep under the camera nothing is seen; only the visible top is set loose.
    reach = Math.min(reach, TOPPLE_MAX);
    tower.forEach((box, index) => {
      const depth = tower.length - 1 - index;
      if (depth >= reach) return;
      const lift = 1 - depth / reach;
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
    const support = this.tower().at(-1);
    // Only a box lying flat on its support can become part of the tower; a tilted one
    // keeps moving under gravity until it lies flat or falls.
    const flat = Math.abs(body.angle - (support?.body.angle ?? 0)) < 0.12;
    const calm = body.speed < 0.48 && body.angularSpeed < 0.015 && flat;
    this.settledFor = supported && calm && !this.tipping ? this.settledFor + STEP_MS : 0;
    if (this.settledFor >= 300) {
      const { offset } = this.atRest(body);
      // A box resting on less than ~62 % of its bottom does not stay: it tips over the
      // edge and costs a life.
      const half = support ? BOX_WIDTH / 2 : PLATFORM_WIDTH / 2;
      if (Math.abs(offset) > half - BOX_WIDTH * 0.12) {
        const direction = Math.sign(offset) || 1;
        this.tipping = true;
        this.settledFor = 0;
        Sleeping.set(body, false);
        Body.setAngularVelocity(body, direction * 0.05);
        Body.setVelocity(body, { x: direction * 1.4, y: body.velocity.y });
        return;
      }
      const perfect =
        Math.abs(offset) <= 8 && Math.abs(body.angle - (support?.body.angle ?? 0)) < 0.08;
      box.counted = true;
      this.hold(box, perfect);
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
      if (Math.abs(this.balance) >= 1) {
        this.topple(Math.sign(this.balance), Math.max(2, this.balanceBreak));
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
      leaning: this.leaning,
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
