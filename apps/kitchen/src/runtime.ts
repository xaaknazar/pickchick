import type { KitchenModel } from './model.js';
export type Every = (callback: () => void, milliseconds: number) => () => void;
const interval: Every = (callback, milliseconds) => {
  const timer = setInterval(callback, milliseconds);
  return () => clearInterval(timer);
};
/** Rendering the last complete display snapshot is independent from the next HTTP read. */
export function startRuntime(
  model: Pick<KitchenModel, 'state' | 'refresh'>,
  rotate: () => void,
  every: Every = interval,
) {
  const stopPolling = every(() => {
    if (model.state.actor && !model.state.busy) void model.refresh();
  }, 5000);
  const stopRotation = every(() => {
    if (model.state.actor && model.state.mode === 'display') rotate();
  }, 8000);
  return () => {
    stopPolling();
    stopRotation();
  };
}
