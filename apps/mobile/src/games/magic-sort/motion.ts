/** One transaction: approach, continuous transfer, then return before commit. */
export const POUR_DURATION = 1400;
export const POUR_TIMELINE = [0, 0.22, 0.78, 1] as const;
export function pouringPose(
  width: number,
  height: number,
  landingX: number,
  landingY: number,
  direction: 1 | -1,
) {
  const angle = direction * 65;
  const radians = (angle * Math.PI) / 180;
  const mouthX = landingX - direction * 5;
  const mouthY = landingY - 10;
  const offset = height / 2 - height * 0.025;
  return {
    x: mouthX - width / 2 - offset * Math.sin(radians),
    y: mouthY - height / 2 + offset * Math.cos(radians),
    angle,
    mouthX,
    mouthY,
    streamLength: Math.hypot(landingX - mouthX, landingY - mouthY),
    streamAngle: (-Math.atan2(landingX - mouthX, landingY - mouthY) * 180) / Math.PI,
  };
}
