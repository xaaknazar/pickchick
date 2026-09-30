import { ghostPiece, gravityIntervalMs, type GameState } from './engine.ts';

/** Only interpolate inside the next collision-free cell, never absolute board coordinates. */
export function fallingFrame(game: GameState) {
  const piece = game.active;
  if (!piece) return null;
  const interval = gravityIntervalMs(game.level);
  const landing = ghostPiece(game)!;
  const travel = landing.y > piece.y ? 1 : 0;
  const progress = travel ? Math.max(0, Math.min(1, game.gravityMs / interval)) : 0;
  return {
    x: piece.x,
    y: piece.y,
    travel,
    progress,
    duration: Math.max(1, interval - game.gravityMs),
  };
}

/** Also clamps an interrupted animation against the CURRENT piece's collision limit. */
export function fallingOffset(progress: number, travel: number, cell: number) {
  'worklet';
  return Math.max(0, Math.min(Number.isFinite(progress) ? progress : 0, travel)) * cell;
}
