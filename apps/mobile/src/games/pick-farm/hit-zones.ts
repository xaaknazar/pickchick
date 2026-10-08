import { cropPhase, growthProgress, type FarmState } from '@pickchick/farm-game';
import { isoPoint, groundContains, TREE_ART, TREE_TOP } from './geometry.ts';
import { spriteHitMasks } from './sprite-hit-masks.ts';

type Plot = FarmState['plots'][number];
type Point = { x: number; y: number };
const maskRows = new Map<string, string[]>();

/** Indicator above an object, in world pixels from the object's ground center. */
export const BADGE_OFFSET = { bed: -84, tree: TREE_TOP - 12 } as const;

/** Test actual opaque sprite pixels, not the transparent rectangular image box. */
export function spriteContains(key: string, u: number, v: number) {
  if (u < 0 || v < 0 || u >= 1 || v >= 1) return false;
  let rows = maskRows.get(key);
  if (!rows) {
    rows = spriteHitMasks[key]?.split('/');
    if (!rows) return false;
    maskRows.set(key, rows);
  }
  const x = Math.floor(u * 128),
    y = Math.floor(v * 128);
  const digit = rows[y]?.[Math.floor(x / 4)];
  return digit !== undefined && (parseInt(digit, 16) & (8 >> (x % 4))) !== 0;
}

/** Stage drawn for this planting; the same rule as GroundCrop (seeds < 10% < sprouts < 35%). */
function stageOf(plot: Plot, now: number) {
  const phase = cropPhase(plot, now);
  if (plot.kind !== 'bed' || phase !== 'growing') return phase;
  const progress = growthProgress(plot, now);
  return progress < 0.1 ? 'seeds' : progress < 0.35 ? 'sprouts' : 'growing';
}

export type HitOptions = {
  /** World radius of the status badge drawn above the object (it scales with zoom). */
  badgeRadius?: number;
  /** Extra ground tolerance for a fingertip, in world pixels. */
  slop?: number;
  /** Plots that show a status badge (ready, needs water, withered). */
  badged?: (plot: Plot) => boolean;
};

/** Same order as the painter: frontmost visible plant wins overlaps. */
export function plotAtPoint(
  plots: readonly Plot[],
  point: Point,
  now: number,
  options: HitOptions = {},
): Plot | undefined {
  const { badgeRadius = 12, slop = 0 } = options;
  const badged = options.badged ?? ((plot: Plot) => cropPhase(plot, now) === 'ready');
  const ordered = [...plots].sort((a, b) => a.x + a.y - b.x - b.y);
  // Badges float above everything, so they are tested first.
  for (let i = ordered.length - 1; i >= 0; i--) {
    const plot = ordered[i]!;
    if (!badged(plot)) continue;
    const center = isoPoint(plot.x, plot.y);
    const dy = point.y - (center.y + BADGE_OFFSET[plot.kind]);
    if ((point.x - center.x) ** 2 + dy ** 2 <= badgeRadius ** 2) return plot;
  }
  for (let i = ordered.length - 1; i >= 0; i--) {
    const plot = ordered[i]!;
    const center = isoPoint(plot.x, plot.y);
    const x = point.x - center.x,
      y = point.y - center.y;
    const stage = stageOf(plot, now);
    if (plot.cropId) {
      if (stage !== 'seeds' && stage !== 'sprouts') {
        // CropArt is square; atlas artwork is centered horizontally within it.
        const size = plot.kind === 'tree' ? TREE_ART : 96 * 0.93;
        const artWidth = (size * 248) / (1024 / 3 - 6);
        const top = plot.kind === 'tree' ? TREE_TOP : 27 - 96 * 0.1 - size;
        const left =
          plot.kind === 'tree' ? -artWidth / 2 : -48 + 96 * 0.035 + (size - artWidth) / 2;
        const phase = stage === 'empty' ? 'growing' : stage;
        if (spriteContains(`${plot.cropId}-${phase}`, (x - left) / artWidth, (y - top) / size))
          return plot;
      } else if (stage === 'sprouts') {
        const size = 96 * 0.38;
        const artWidth = (size * 248) / (1024 / 3 - 6);
        const left = -48 + 96 * 0.31 + (size - artWidth) / 2;
        const top = -69 + 96 * 0.35;
        if (spriteContains(`${plot.cropId}-growing`, (x - left) / artWidth, (y - top) / size))
          return plot;
      }
    }
    if (plot.kind === 'bed' && groundContains(x, y)) return plot;
  }
  if (slop <= 0) return undefined;
  // A fingertip near an object still selects it: nearest ground diamond within tolerance.
  let best: { plot: Plot; d: number } | undefined;
  for (const plot of plots) {
    const center = isoPoint(plot.x, plot.y);
    const d = Math.abs(point.x - center.x) / 48 + Math.abs(point.y - center.y) / 24;
    const limit = 1 + slop / 24;
    if (d <= limit && (!best || d < best.d)) best = { plot, d };
  }
  return best?.plot;
}
