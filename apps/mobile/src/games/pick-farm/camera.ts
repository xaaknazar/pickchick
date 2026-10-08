import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated } from 'react-native';
import { clampCamera, type FarmCamera } from './geometry';

/** Friction per 16 ms frame for a released pan; 0.92 stops a fast flick in ~0.6 s. */
export const FLING_FRICTION = 0.92;
const easeOut = (t: number) => 1 - (1 - t) ** 3;
type Bounds = { fit: number; width: number; height: number };

/** Pure interpolation used by animated camera moves; zoom eases in log space. */
export function tweenCamera(from: FarmCamera, to: FarmCamera, t: number): FarmCamera {
  const k = easeOut(Math.max(0, Math.min(1, t)));
  return {
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
    zoom: Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * k),
  };
}
/** One decay step of a fling; returns null once motion is imperceptible. */
export function flingStep(velocity: { x: number; y: number }, ms: number) {
  const decay = FLING_FRICTION ** (ms / 16);
  const next = { x: velocity.x * decay, y: velocity.y * decay };
  return Math.hypot(next.x, next.y) < 0.02 ? null : next;
}

/**
 * Camera state lives in a ref and in Animated values, so panning never re-renders the
 * field. React receives a throttled `view` for culling and screen-space overlays.
 */
export function useFarmCamera(bounds: Bounds) {
  const camera = useRef<FarmCamera>({ x: 0, y: 0, zoom: 1 });
  const pan = useRef(new Animated.ValueXY()).current;
  const zoom = useRef(new Animated.Value(1)).current;
  const [view, setView] = useState<FarmCamera>(camera.current);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const frame = useRef<number | null>(null);
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listeners = useRef(new Set<(camera: FarmCamera) => void>());

  const publish = useCallback((immediate: boolean) => {
    if (immediate) {
      if (viewTimer.current) clearTimeout(viewTimer.current);
      viewTimer.current = null;
      setView({ ...camera.current });
      return;
    }
    if (viewTimer.current) return;
    viewTimer.current = setTimeout(() => {
      viewTimer.current = null;
      setView({ ...camera.current });
    }, 90);
  }, []);
  const apply = useCallback(
    (x: number, y: number, z: number, immediate = false) => {
      const { fit, width, height } = boundsRef.current;
      const next = clampCamera(x, y, z, fit, width, height);
      camera.current = next;
      pan.setValue({ x: next.x, y: next.y });
      zoom.setValue(next.zoom);
      for (const listener of listeners.current) listener(next);
      publish(immediate);
      return next;
    },
    [pan, zoom, publish],
  );
  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const set = useCallback(
    (x: number, y: number, z: number, immediate = false) => {
      stop();
      return apply(x, y, z, immediate);
    },
    [apply, stop],
  );
  const animateTo = useCallback(
    (target: FarmCamera, duration = 340) => {
      stop();
      const { fit, width, height } = boundsRef.current;
      const to = clampCamera(target.x, target.y, target.zoom, fit, width, height);
      const from = { ...camera.current };
      const start = performance.now();
      const step = () => {
        const t = (performance.now() - start) / duration;
        const v = tweenCamera(from, to, t);
        apply(v.x, v.y, v.zoom, t >= 1);
        frame.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      frame.current = requestAnimationFrame(step);
    },
    [apply, stop],
  );
  /** Continue a released pan; velocity in screen px per ms. */
  const fling = useCallback(
    (vx: number, vy: number) => {
      stop();
      let velocity: { x: number; y: number } | null = { x: vx, y: vy };
      let last = performance.now();
      const step = () => {
        const now = performance.now();
        const ms = Math.min(48, now - last);
        last = now;
        const before = camera.current;
        const next = apply(before.x + velocity!.x * ms, before.y + velocity!.y * ms, before.zoom);
        // Hitting the meadow edge stops that axis instead of bouncing.
        velocity = flingStep(
          {
            x: next.x === before.x + velocity!.x * ms ? velocity!.x : 0,
            y: next.y === before.y + velocity!.y * ms ? velocity!.y : 0,
          },
          ms,
        );
        if (velocity) frame.current = requestAnimationFrame(step);
        else {
          frame.current = null;
          publish(true);
        }
      };
      frame.current = requestAnimationFrame(step);
    },
    [apply, stop, publish],
  );
  useEffect(
    () => () => {
      stop();
      if (viewTimer.current) clearTimeout(viewTimer.current);
    },
    [stop],
  );
  // Controls are stable for the screen's lifetime; only `view` changes while panning.
  const controls = useMemo(
    () => ({
      camera,
      pan,
      zoom,
      set,
      animateTo,
      fling,
      stop,
      subscribe(listener: (camera: FarmCamera) => void) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [pan, zoom, set, animateTo, fling, stop],
  );
  return [controls, view] as const;
}
