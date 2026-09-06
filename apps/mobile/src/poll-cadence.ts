/** Polling is a TEST fallback until branch-scoped event delivery is implemented. */
export function orderPollDelay(
  input: {
    active: boolean;
    failures: number;
    expired: boolean;
  },
  random = Math.random,
): number | null {
  if (input.expired) return null;
  const failures = Math.max(0, Math.min(6, input.failures));
  const base =
    failures > 0 ? Math.min(60_000, 3_000 * 2 ** (failures - 1)) : input.active ? 3_000 : 60_000;
  return Math.round(base * (1 + Math.max(0, Math.min(1, random())) * 0.2));
}
