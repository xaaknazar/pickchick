import { CROPS, cropPhase, type FarmState } from '@pickchick/farm-game';
import { isoPoint } from './geometry.ts';
import { spriteHitMasks } from './sprite-hit-masks.ts';

type Plot = FarmState['plots'][number];
type Point = { x: number; y: number };
const maskRows = new Map<string, string[]>();

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

/** Same order as the painter: frontmost visible plant wins overlaps. */
export function plotAtPoint(plots: readonly Plot[], point: Point, now: number): Plot | undefined {
  const ordered = [...plots].sort((a, b) => a.x + a.y - b.x - b.y);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const plot = ordered[i]!;
    const center = isoPoint(plot.x, plot.y);
    const x = point.x - center.x,
      y = point.y - center.y;
    const phase = cropPhase(plot, now);
    // The ready badge belongs to this plot too, including its visible circular edge.
    if (phase === 'ready' && (x - 32) ** 2 + (y + 64) ** 2 <= 12 ** 2) return plot;
    if (plot.cropId) {
      const crop = CROPS.find((item) => item.id === plot.cropId)!;
      const fraction =
        plot.plantedAt === null ? 0 : (now - plot.plantedAt) / (crop.growSeconds * 1000);
      const sprouts =
        plot.kind === 'bed' && phase === 'growing' && fraction >= 0.1 && fraction < 0.35;
      const seeds = plot.kind === 'bed' && phase === 'growing' && fraction < 0.1;
      if (!sprouts && !seeds) {
        // CropArt is square; atlas artwork is centered horizontally within it.
        const size = plot.kind === 'tree' ? 112 : 96 * 0.93;
        const artWidth = (size * 248) / (1024 / 3 - 6);
        const top = plot.kind === 'tree' ? -77 : 27 - 96 * 0.1 - size;
        const left =
          plot.kind === 'tree' ? -artWidth / 2 : -48 + 96 * 0.035 + (size - artWidth) / 2;
        if (
          spriteContains(
            `${plot.cropId}-${phase === 'empty' ? 'growing' : phase}`,
            (x - left) / artWidth,
            (y - top) / size,
          )
        )
          return plot;
      }
      if (sprouts) {
        const h = (96 * 387) / 684;
        if (spriteContains('sprouts', (x + 48) / 96, (y - (27 - h)) / h)) return plot;
      }
    }
    if (plot.kind === 'bed') {
      const h = (96 * 388) / 688;
      if (spriteContains('soil', (x + 48) / 96, (y - (27 - h)) / h)) return plot;
    }
  }
  return undefined;
}
