/** Artistic milestones, not literal geographic heights. Shared by HUD and scenery. */
export const ASCENT_STEPS = [0, 8, 20, 28, 36] as const;
export const ascentStage = (score: number) =>
  Math.max(
    0,
    ASCENT_STEPS.findLastIndex((threshold) => score >= threshold),
  );

/** Keep both the swinging box and landing surface visible, including short screens. */
export function cameraFloor(height: number, top: number) {
  const landing = Math.max(250, height * 0.64);
  return Math.max(height - 56, landing - top);
}
