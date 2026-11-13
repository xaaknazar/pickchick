/** Artistic milestones, not literal geographic heights. Shared by HUD and scenery. */
export const ASCENT_STEPS = [0, 8, 20, 28, 36] as const;
export const ascentStage = (score: number) =>
  Math.max(
    0,
    ASCENT_STEPS.findLastIndex((threshold) => score >= threshold),
  );

/** Keep both the swinging box and landing surface visible, including short screens. */
export function cameraFloor(height: number, top: number) {
  const safeHeight = Math.max(300, height);
  const landing = Math.min(safeHeight - 30, Math.max(250, safeHeight * 0.64));
  return Math.max(safeHeight - 56, landing - top);
}

/** Keep short/large-text screens playable by scaling the world, never the touch controls. */
export const worldScale = (width: number, height: number) =>
  Math.max(0.1, Math.min(width / 408, height / 300));

export function nextMilestone(score: number) {
  const stage = ASCENT_STEPS.findIndex((threshold) => threshold > score);
  if (stage >= 0)
    return { stage, remaining: ASCENT_STEPS[stage]! - score, target: ASCENT_STEPS[stage]! };
  const target = (Math.floor(score / 10) + 1) * 10;
  return { stage: 4, remaining: target - score, target };
}
