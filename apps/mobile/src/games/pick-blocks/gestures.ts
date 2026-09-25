export type BlockDragAxis = 'horizontal' | 'vertical' | null;

/** Decide once per touch, so thumb wobble cannot change the intended trajectory. */
export function blockDragAxis(dx: number, dy: number, previous: BlockDragAxis): BlockDragAxis {
  if (previous || Math.max(Math.abs(dx), Math.abs(dy)) <= 8) return previous;
  return Math.abs(dx) >= Math.abs(dy) * 0.8 ? 'horizontal' : 'vertical';
}

export function blockDrag(dx: number, dy: number, cell: number, axis?: BlockDragAxis) {
  const step = Math.max(12, cell);
  const horizontal = (axis ?? blockDragAxis(dx, dy, null)) === 'horizontal';
  return {
    x: horizontal ? Math.trunc(dx / step) : 0,
    y: horizontal ? 0 : Math.max(0, Math.trunc(dy / step)),
  };
}
export function isBlockDrop(dx: number, dy: number, cell: number, duration: number) {
  return dy >= Math.max(36, cell * 2) && dy > Math.abs(dx) * 1.5 && duration < 240;
}
