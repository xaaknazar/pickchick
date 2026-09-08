import type { Actor } from './engine';

/** Presentation only: follow the engine's corridor waypoints at constant speed. */
export type MazeMotion = {
  x: number;
  y: number;
  direction: Actor['direction'];
  target: Actor;
  queue: Actor[];
};
export function createMotion(actor: Actor): MazeMotion {
  'worklet';
  return { x: actor.x, y: actor.y, direction: actor.direction, target: actor, queue: [] };
}
export function queueMotion(motion: MazeMotion, target: Actor, reset = false): MazeMotion {
  'worklet';
  const distance = Math.abs(target.x - motion.target.x) + Math.abs(target.y - motion.target.y);
  // Respawn/restore must not draw a route through walls. Adjacent turns retain
  // their previous waypoint, even if the engine delivers the next step early.
  if (reset || distance > 1) return createMotion(target);
  if (distance === 0) return motion;
  return { ...motion, target, queue: [...motion.queue, target] };
}
export function advanceMotion(motion: MazeMotion, elapsed: number, interval: number): MazeMotion {
  'worklet';
  if (!motion.queue.length || elapsed <= 0 || !Number.isFinite(elapsed)) return motion;
  let budget = Math.min(elapsed, 80) / interval;
  let { x, y, direction } = motion;
  const queue = [...motion.queue];
  while (queue.length && budget > 0) {
    const next = queue[0]!;
    const dx = next.x - x,
      dy = next.y - y;
    const distance = Math.abs(dx) + Math.abs(dy);
    direction = next.direction;
    if (distance <= budget) {
      x = next.x;
      y = next.y;
      budget -= distance;
      queue.shift();
    } else {
      x += (dx * budget) / distance;
      y += (dy * budget) / distance;
      budget = 0;
    }
  }
  return { ...motion, x, y, direction, queue };
}
