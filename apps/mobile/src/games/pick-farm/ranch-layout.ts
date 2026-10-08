import {
  animalStatus,
  landBounds,
  nextLandExpansion,
  type AnimalKind,
  type FarmState,
  type PenId,
} from '@pickchick/farm-game';
import { isoPoint } from './geometry.ts';

/**
 * Where the v3 world objects stand (pure data and math, unit-tested): pens behind the field,
 * land sale signs and scenery around it. Ranch.tsx draws them.
 */
type Point = { x: number; y: number };
/** The v3 art is drawn with 52 px per cell axis unit; the game uses 48. */
export const ART_SCALE = 48 / 52;
export const PEN_ART = {
  coop: {
    width: 295,
    height: 214,
    // Yard back corner inside the image (printed by build-v3-art.py).
    anchor: { x: 132.2, y: 70 },
    yard: { x: 3, y: 2.4 },
  },
  barn: {
    width: 358,
    height: 267,
    anchor: { x: 163.5, y: 92 },
    yard: { x: 3.6, y: 3 },
  },
} as const;
/** Yard back corners in cell coordinates: behind the field, to the right of the house. */
export const PEN_CORNER: Record<PenId, Point> = {
  coop: { x: 19.5, y: 10.5 },
  barn: { x: 24.5, y: 9.4 },
};
/** Where animals stand, in yard units from the back corner (feet position). */
export const SPOTS: Record<PenId, Point[]> = {
  coop: [
    { x: 2.4, y: 1.0 },
    { x: 0.5, y: 1.6 },
    { x: 1.6, y: 1.45 },
    { x: 2.55, y: 1.5 },
    { x: 0.95, y: 2.1 },
    { x: 1.7, y: 2.15 },
  ],
  barn: [
    { x: 2.75, y: 1.35 },
    { x: 0.8, y: 2.3 },
    { x: 1.85, y: 2.15 },
    { x: 3.05, y: 1.95 },
  ],
};
/** Open yard ground where busy animals stroll (clear of buildings, troughs and fences). */
export const WALK: Record<PenId, Point[]> = {
  coop: [
    { x: 2.4, y: 0.7 },
    { x: 2.7, y: 1.15 },
    { x: 2.35, y: 1.5 },
    { x: 1.65, y: 1.4 },
    { x: 0.5, y: 1.5 },
    { x: 0.6, y: 2.05 },
    { x: 1.25, y: 2.15 },
    { x: 1.85, y: 2.2 },
    { x: 2.6, y: 2.2 },
  ],
  barn: [
    { x: 2.7, y: 1.2 },
    { x: 3.2, y: 1.55 },
    { x: 2.6, y: 1.85 },
    { x: 1.8, y: 2.0 },
    { x: 0.8, y: 2.2 },
    { x: 0.6, y: 2.65 },
    { x: 1.6, y: 2.7 },
    { x: 2.3, y: 2.7 },
    { x: 3.25, y: 2.0 },
  ],
};
/** One stroll: stand, then walk to the next point. Rhythm differs per animal. */
export const STROLL = { period: 9000, walk: 2600 } as const;
export type AnimalMode = 'home' | 'stroll';
function hash(a: number, b: number) {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return (h ^ (h >>> 12)) >>> 0;
}
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
/** Stroll target of one animal in one cycle: a walk point, never the same twice in a row. */
export function strollPoint(pen: PenId, id: number, cycle: number): Point {
  const points = WALK[pen];
  const i = hash(id, cycle) % points.length;
  const before = hash(id, cycle - 1) % points.length;
  return points[i === before ? (i + 1) % points.length : i]!;
}
/**
 * Where an animal is at time t (yard units, feet). Ready and hungry animals stay on their
 * home spot so a tap finds them; busy ones stroll. Pure, so drawing and taps agree.
 */
export function animalPlace(pen: PenId, id: number, index: number, mode: AnimalMode, t: number) {
  if (mode === 'home') {
    const spot = SPOTS[pen][index % SPOTS[pen].length]!;
    return { ...spot, facing: index % 2 ? -1 : 1, walking: false, from: spot, to: spot, start: 0 };
  }
  const offset = (id * 2311) % STROLL.period;
  const cycle = Math.floor((t + offset) / STROLL.period);
  const phase = (t + offset) % STROLL.period;
  const from = strollPoint(pen, id, cycle - 1),
    to = strollPoint(pen, id, cycle);
  const k = phase < STROLL.walk ? ease(phase / STROLL.walk) : 1;
  // Screen x grows with x - y: face the way the animal walks.
  const facing = to.x - to.y - (from.x - from.y) >= 0 ? 1 : -1;
  return {
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
    facing,
    walking: phase < STROLL.walk,
    from,
    to,
    start: t - phase,
  };
}
/** World radius of an animal for taps (fingertip slop included). */
export const ANIMAL_TAP = { chicken: 34, cow: 52 } as const;
/** Visual body center above the feet, in world px. */
export const ANIMAL_BODY = { chicken: 22, cow: 32 } as const;
/** The animal under a world point: the nearest body within reach. */
export function animalAt(
  world: Point,
  pen: PenId,
  kind: 'chicken' | 'cow',
  animals: { id: number; index: number; mode: AnimalMode; condition?: string }[],
  t: number,
  slop = 0,
  /** Only these conditions count (a sweep feeds hungry ones; a busy passer-by is skipped). */
  only?: readonly string[],
) {
  let best: { id: number; d: number } | null = null;
  for (const a of animals) {
    if (only && !only.includes(a.condition ?? '')) continue;
    const place = animalPlace(pen, a.id, a.index, a.mode, t);
    const p = at(pen, place.x, place.y);
    const d = Math.hypot(world.x - p.x, world.y - (p.y - ANIMAL_BODY[kind]));
    if (d <= ANIMAL_TAP[kind] + slop && (!best || d < best.d)) best = { id: a.id, d };
  }
  return best?.id ?? null;
}
export type YardAnimal = {
  id: number;
  index: number;
  mode: AnimalMode;
  condition: 'ready' | 'hungry' | 'busy';
};
/** Animals of one pen with their condition; only busy ones stroll, and only with motion. */
export function yardAnimals(
  state: FarmState,
  kind: AnimalKind,
  now: number,
  moving: boolean,
): YardAnimal[] {
  const status = animalStatus(state, kind, now);
  const ready = new Set(status.ready.map((v) => v.id));
  const hungry = new Set(status.hungry.map((v) => v.id));
  return status.list.map((v, index) => {
    const condition = ready.has(v.id) ? 'ready' : hungry.has(v.id) ? 'hungry' : 'busy';
    return {
      id: v.id,
      index,
      condition,
      mode: moving && condition === 'busy' ? 'stroll' : 'home',
    };
  });
}
/** Locked-land tiles revealed by an expansion, with a delay sweeping from the front corner. */
export function revealTiles(from: number, to: number) {
  const b = (land: number) => {
    const half = 6 + 2 * land;
    return { min: 32 - half, max: 31 + half };
  };
  const a = b(from),
    n = b(to);
  const tiles: { x: number; y: number; delay: number }[] = [];
  for (let y = n.min; y <= n.max; y += 2)
    for (let x = n.min; x <= n.max; x += 2) {
      const inside = x >= a.min && x + 1 <= a.max && y >= a.min && y + 1 <= a.max;
      if (inside) continue;
      const vx = x + 1 - 32,
        vy = y + 1 - 32;
      const angle = Math.acos(
        Math.max(-1, Math.min(1, (vx + vy) / Math.SQRT2 / Math.hypot(vx, vy))),
      );
      tiles.push({ x, y, delay: Math.round((angle / Math.PI) * 900) });
    }
  return tiles;
}
export const at = (pen: PenId, dx: number, dy: number) =>
  isoPoint(PEN_CORNER[pen].x + dx, PEN_CORNER[pen].y + dy);

/** World rectangle of a pen's artwork, used for taps. */
export function penRect(pen: PenId) {
  const a = PEN_ART[pen];
  const corner = at(pen, 0, 0);
  return {
    minX: corner.x - a.anchor.x * ART_SCALE,
    minY: corner.y - a.anchor.y * ART_SCALE,
    maxX: corner.x + (a.width - a.anchor.x) * ART_SCALE,
    maxY: corner.y + (a.height - a.anchor.y) * ART_SCALE,
  };
}
export function penCenter(pen: PenId) {
  return at(pen, PEN_ART[pen].yard.x / 2, PEN_ART[pen].yard.y / 2);
}
/** Pen under a world point: the drawn building and yard, a little generous for fingers. */
export function penAt(world: Point, slop = 8): PenId | null {
  for (const pen of ['barn', 'coop'] as const) {
    const r = penRect(pen);
    if (
      world.x >= r.minX - slop &&
      world.x <= r.maxX + slop &&
      world.y >= r.minY - slop &&
      world.y <= r.maxY + slop
    )
      return pen;
  }
  return null;
}
/** Land sale signs stand on locked ground next to the open square. */
export function landSigns(state: FarmState): Point[] {
  if (!nextLandExpansion(state)) return [];
  const b = landBounds(state);
  return [
    { x: b.maxX + 1.6, y: (b.minY + b.maxY) / 2 },
    { x: (b.minX + b.maxX) / 2, y: b.maxY + 1.6 },
  ];
}
export function landSignAt(state: FarmState, world: Point) {
  return landSigns(state).some((cell) => {
    const p = isoPoint(cell.x, cell.y);
    return Math.abs(world.x - p.x) < 44 && world.y > p.y - 96 && world.y < p.y + 14;
  });
}

export const SCENERY_SIZE = {
  tree: {
    width: 150,
    w: 176,
    h: 216,
  },
  treeDark: {
    width: 150,
    w: 175,
    h: 217,
  },
  bush: {
    width: 100,
    w: 147,
    h: 96,
  },
  berries: {
    width: 100,
    w: 147,
    h: 91,
  },
  rock: { width: 64, w: 108, h: 61 },
  flowers: {
    width: 74,
    w: 106,
    h: 58,
  },
  flowersPink: {
    width: 74,
    w: 106,
    h: 58,
  },
  pond: { width: 260, w: 165, h: 113 },
} as const;

export type SceneryKind = keyof typeof SCENERY_SIZE;
/** Hand-placed scenery around the field (cell coordinates), never on the field itself. */
export const SCENERY: readonly { kind: SceneryKind; x: number; y: number }[] = [
  // Behind the house and pens.
  { kind: 'treeDark', x: 10, y: 9 },
  { kind: 'tree', x: 16, y: 7 },
  { kind: 'bush', x: 17.5, y: 7.5 },
  { kind: 'treeDark', x: 31, y: 6 },
  { kind: 'tree', x: 36, y: 9 },
  { kind: 'flowers', x: 32.5, y: 11.5 },
  { kind: 'tree', x: 42, y: 8 },
  { kind: 'berries', x: 39, y: 12.5 },
  { kind: 'rock', x: 45, y: 12.5 },
  // Right side.
  { kind: 'treeDark', x: 52, y: 15 },
  { kind: 'flowersPink', x: 50, y: 20 },
  { kind: 'pond', x: 53.5, y: 27.5 },
  { kind: 'rock', x: 50.5, y: 25 },
  { kind: 'tree', x: 55, y: 35 },
  { kind: 'bush', x: 50.5, y: 38 },
  { kind: 'treeDark', x: 54, y: 44 },
  { kind: 'flowers', x: 50.5, y: 46 },
  // Left side, below the workshops.
  { kind: 'bush', x: 12, y: 26 },
  { kind: 'tree', x: 9, y: 30 },
  { kind: 'flowersPink', x: 12.5, y: 33 },
  { kind: 'treeDark', x: 10, y: 38 },
  { kind: 'rock', x: 12.5, y: 41 },
  { kind: 'tree', x: 8, y: 45 },
  // Front.
  { kind: 'berries', x: 20, y: 51 },
  { kind: 'tree', x: 25, y: 54 },
  { kind: 'flowers', x: 31, y: 50.5 },
  { kind: 'treeDark', x: 37, y: 55 },
  { kind: 'bush', x: 44, y: 51 },
  { kind: 'tree', x: 49, y: 53 },
];
/** Depth split: scenery behind the field's middle draws first, the rest after the plots. */
export const sceneryBack = SCENERY.filter((v) => v.x + v.y <= 63);
export const sceneryFront = SCENERY.filter((v) => v.x + v.y > 63);
