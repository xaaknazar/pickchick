import { Component, Fragment, createElement, type ReactNode } from 'react';
import type { KioskState } from './model';

/**
 * Audit 23.11 #2: a render that throws used to leave a blank screen on an unattended iPad.
 * Two boundaries show a plain notice instead and try again by themselves:
 * - around the guest screens (GuestScreen): the controller and its polling stay alive above it,
 *   so an open payment keeps being read and reported while the notice is shown;
 * - around the whole app (App): the tree is mounted again and the controller restores the stored
 *   flow, exactly as after an app restart (a payment is resumed, never cleared).
 */
/** The guest screens are drawn again this long after a failure. */
export const SCREEN_RESTART_MS = 10000;
/**
 * The whole app is mounted again this long after a failure: longer than a cloud request (15 s)
 * or a terminal call (8 s) of the controller that is being replaced may still take.
 */
export const APP_RESTART_MS = 20000;
/** A second failure of the guest screens within this time gives up the guest's draft. */
export const SCREEN_CRASH_REPEAT_MS = 60000;

/**
 * Whether drawing the guest screens again should also start a new guest: only when the failure
 * repeats and nothing but a plain draft is open. With an order, a payment (also one being
 * changed while the terminal waits) or a recovery the screens are only drawn again, so the
 * payment state is never touched from here.
 */
export function crashEndsGuest(
  model: Pick<
    KioskState,
    | 'ready'
    | 'busy'
    | 'step'
    | 'order'
    | 'recoveryRequired'
    | 'terminalPayment'
    | 'terminalOpen'
    | 'syncPending'
  >,
  repeated: boolean,
) {
  return (
    repeated &&
    model.ready &&
    !model.busy &&
    model.step !== 'start' &&
    !model.order &&
    !model.recoveryRequired &&
    !model.terminalPayment &&
    !model.terminalOpen &&
    !model.syncPending
  );
}

type Props = {
  restartMs: number;
  /** The notice shown instead of the failed tree; `restart` draws the tree again at once. */
  fallback: (restart: () => void) => ReactNode;
  /** Called just before the tree is drawn again. */
  onRestart?: () => void;
  children?: ReactNode;
};
type State = { failed: boolean; round: number };

export class KioskErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, round: 0 };
  private timer: ReturnType<typeof setTimeout> | undefined;
  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }
  componentDidCatch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.restart, this.props.restartMs);
  }
  componentWillUnmount() {
    clearTimeout(this.timer);
  }
  restart = () => {
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      this.props.onRestart?.();
    } catch {
      // The tree is drawn again whatever the callback did.
    }
    // A new key mounts the tree from scratch instead of re-rendering the failed one.
    this.setState((state) => ({ failed: false, round: state.round + 1 }));
  };
  render() {
    return this.state.failed
      ? this.props.fallback(this.restart)
      : createElement(Fragment, { key: this.state.round }, this.props.children);
  }
}
