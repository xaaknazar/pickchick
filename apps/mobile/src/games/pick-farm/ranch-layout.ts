import { landBounds, nextLandExpansion, type FarmState, type PenId } from '@pickchick/farm-game';
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
