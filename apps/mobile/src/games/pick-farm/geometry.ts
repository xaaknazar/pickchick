// One projection for drawing, hit testing and camera limits.
export const TILE_WIDTH = 96;
export const TILE_HEIGHT = 48;
// Project a centered square to exactly one 2:1 ground diamond on both native and web.
// Explicit transforms also work on React Native Web, which emits an invalid CSS matrix
// for a 16-value native matrix. Order is intentional: compress AFTER rotating the square.
export const GROUND_TRANSFORM = [{ scaleY: 0.5 }, { rotate: '45deg' }, { scale: Math.SQRT1_2 }];
export const BED_ANCHOR = 23 / 32;
export function groundContains(x: number, y: number) {
  return Math.abs(x) / (TILE_WIDTH / 2) + Math.abs(y) / (TILE_HEIGHT / 2) <= 1;
}
export const WORLD_CENTER = { x: 450, y: 300 };
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;
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
/**
 * Ground rectangle the camera may show, in world pixels, centered on WORLD_CENTER.
 * It lies inside the generated grass plane (GRASS_CELLS per side), so grass always fills
 * the screen.
 */
export const MEADOW = { width: 4400, height: 2800 } as const;
/** Cells per side of the repeated grass plane centered on cell (31.5, 31.5). */
export const GRASS_CELLS = 112;
/** Field diamond plus the house above it, in world pixels. */
const PROPERTY = { width: 3072, height: 1840 } as const;
/** Screen rows reserved by the HUD; the world is drawn this far below the screen center. */
export const WORLD_OFFSET_Y = 48;
/**
 * Overview scale: the whole 32x32 field and the house stay visible, and the painted meadow
 * always covers the screen, so no empty margins appear at any zoom.
 */
export function fitFarm(width: number, height: number) {
  const contain = Math.min((width - 24) / PROPERTY.width, (height - 56) / PROPERTY.height);
  const cover = Math.max(width / MEADOW.width, height / MEADOW.height);
  return Math.max(0.06, contain, cover);
}
/** Keep the meadow under the whole screen; zoom never goes below the overview. */
export function clampCamera(
  x: number,
  y: number,
  zoom: number,
  fit: number,
  width: number,
  height: number,
) {
  const scale = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const s = fit * scale;
  const maxX = Math.max(0, (MEADOW.width * s - width) / 2);
  const half = (MEADOW.height / 2) * s;
  const minY = height / 2 - WORLD_OFFSET_Y - half,
    maxY = half - height / 2 - WORLD_OFFSET_Y;
  return {
    x: clamp(x, -maxX, maxX),
    y: minY <= maxY ? clamp(y, minY, maxY) : -WORLD_OFFSET_Y,
    zoom: scale,
  };
}
/** Camera that centers a world rectangle and fills a share of the screen with it. */
export function frameWorldRect(
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  fit: number,
  width: number,
  height: number,
  fill = 0.62,
  maxZoom = 3.2,
) {
  const w = Math.max(96, rect.maxX - rect.minX),
    h = Math.max(48, rect.maxY - rect.minY);
  const zoom = clamp(
    Math.min((width * fill) / (w * fit), (height * fill) / (h * fit)),
    MIN_ZOOM,
    maxZoom,
  );
  const s = fit * zoom;
  const cx = (rect.minX + rect.maxX) / 2,
    cy = (rect.minY + rect.maxY) / 2;
  // Center slightly below the screen middle: the HUD occupies the top rows.
  return clampCamera(
    -(cx - WORLD_CENTER.x) * s,
    16 - WORLD_OFFSET_Y - (cy - WORLD_CENTER.y) * s,
    zoom,
    fit,
    width,
    height,
  );
}
/** Screen position (relative to the field frame) of a world point. */
export function screenAtWorld(
  point: { x: number; y: number },
  camera: { x: number; y: number; zoom: number },
  fit: number,
  width: number,
  height: number,
) {
  const s = camera.zoom * fit;
  return {
    x: width / 2 + camera.x + (point.x - WORLD_CENTER.x) * s,
    y: height / 2 + WORLD_OFFSET_Y + camera.y + (point.y - WORLD_CENTER.y) * s,
  };
}

export type FieldFrame = { x: number; y: number; width: number; height: number };
export type FarmCamera = { x: number; y: number; zoom: number };
/** Inverse of the rendered world, including the actual screen's offset in a native sheet. */
export function worldAtPagePoint(
  page: { x: number; y: number },
  frame: FieldFrame,
  camera: FarmCamera,
  fit: number,
) {
  const scale = camera.zoom * fit;
  return {
    x: (page.x - frame.x - frame.width / 2 - camera.x) / scale + WORLD_CENTER.x,
    y: (page.y - frame.y - frame.height / 2 - WORLD_OFFSET_Y - camera.y) / scale + WORLD_CENTER.y,
  };
}

/** Zoom about the point the player is holding, before applying world boundary limits. */
export function cameraAroundPoint(
  camera: FarmCamera,
  point: { x: number; y: number },
  zoom: number,
) {
  const ratio = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)) / camera.zoom;
  return {
    x: point.x - (point.x - camera.x) * ratio,
    y: point.y - (point.y - camera.y) * ratio,
    zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)),
  };
}
/** Cull far-away sprites; keep a margin for tall trees and selection effects. */
export function worldPointVisible(
  point: { x: number; y: number },
  camera: FarmCamera,
  fit: number,
  width: number,
  height: number,
) {
  const x = width / 2 + camera.x + (point.x - WORLD_CENTER.x) * fit * camera.zoom;
  const y = height / 2 + WORLD_OFFSET_Y + camera.y + (point.y - WORLD_CENTER.y) * fit * camera.zoom;
  const margin = Math.max(120, 150 * fit * camera.zoom);
  return x >= -margin && x <= width + margin && y >= -margin && y <= height + margin;
}
