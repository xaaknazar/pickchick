// One projection for drawing, hit testing and camera limits.
export const TILE_WIDTH = 96;
export const TILE_HEIGHT = 48;
export const WORLD_CENTER = { x: 450, y: 300 };
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
export function isoPoint(col: number, row: number) {
  return { x: 450 + (col - row) * 48, y: 300 + (col + row - 63) * 24 };
}
export function cellAtPoint(px: number, py: number) {
  return {
    x: Math.round(31.5 + (px - 450) / 96 + (py - 300) / 48),
    y: Math.round(31.5 - (px - 450) / 96 + (py - 300) / 48),
  };
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function fitFarm(width: number, height: number) {
  return Math.max(0.06, Math.min((width - 48) / 3072, (height - 144) / 1960));
}
export function clampCamera(
  x: number,
  y: number,
  zoom: number,
  fit: number,
  width: number,
  height: number,
) {
  const scale = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  if (scale === MIN_ZOOM) return { x: 0, y: 0, zoom: MIN_ZOOM };
  // At the overview the entire property is fixed; panning is useful only after zooming in.
  const maxX = Math.max(0, (3072 * fit * scale - (width - 48)) / 2);
  const maxY = Math.max(0, (1960 * fit * scale - (height - 144)) / 2);
  return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY), zoom: scale };
}
