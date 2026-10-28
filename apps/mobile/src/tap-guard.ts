// Owner redesign 27.10.2026: the header profile button sits where the next screen has its own
// controls (the profile's settings button, the sign-in sheet backdrop and «Поддержка»). A double
// tap must open the profile once and must not press what appears under the finger.
// Pure logic so the header, the screens it opens and unit tests share one source.

/** Covers the second tap of a double tap (usually 100-300 ms later) and an instant web push. */
export const pushSettleMs = 400;

export type TapGate = {
  /** Runs `action` unless an action ran less than the window ago; true when it ran. */
  run(action: () => void): boolean;
  /** Re-arms the gate, for example when the screen with the button is focused again. */
  reset(): void;
};

/** Lets the first press through and ignores repeats while its push is still running. */
export function createTapGate(windowMs = pushSettleMs, now: () => number = Date.now): TapGate {
  let lockedUntil = Number.NEGATIVE_INFINITY;
  return {
    run(action) {
      const time = now();
      if (time < lockedUntil) return false;
      lockedUntil = time + windowMs;
      action();
      return true;
    },
    reset() {
      lockedUntil = Number.NEGATIVE_INFINITY;
    },
  };
}
