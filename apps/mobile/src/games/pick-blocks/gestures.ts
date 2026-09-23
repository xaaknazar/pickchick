/** Ignore thumb wobble: a predominantly horizontal drag must not also drop a piece. */
export function blockDrag(dx: number, dy: number, cell: number) {
  const step = Math.max(12, cell * 0.85);
  const horizontal = Math.abs(dx) >= Math.abs(dy) * 0.8;
  return {
    x: horizontal ? Math.trunc(dx / step) : 0,
    y: horizontal ? 0 : Math.max(0, Math.trunc(dy / step)),
  };
}
export function isBlockDrop(dx: number, dy: number, cell: number, duration: number) {
  return dy >= Math.max(36, cell * 2) && dy > Math.abs(dx) * 1.5 && duration < 240;
}
