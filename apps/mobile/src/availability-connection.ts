import type { Availability, AvailabilityReadState } from './availability.ts';

/**
 * Whether the availability long-poll has really lost the server (owner 28.10.2026, TestFlight 25:
 * «когда заходишь в корзину, на секунду выходит ошибка "Нет связи с сервером", и из-за этого
 * быстрая оплата пропадает»).
 *
 * A phone on a mobile network loses single requests all the time: the carrier or a proxy drops an
 * idle long-poll, a reused keep-alive connection is already closed by the other side («The network
 * connection was lost»), the radio wakes up. Before this module ONE failed read cycle (the
 * long-poll plus its confirmation snapshot, availability-recovery.ts, then sent within
 * milliseconds over the same dead connection) turned the status into «offline» at once: the cart
 * showed the red «Нет связи с сервером», the cart bar lost its payment handle, and the next read
 * about two seconds later brought both back. The customer saw a blink exactly when they looked,
 * usually right after opening the cart.
 *
 * Now the last good answer stays while the reader retries (stale-while-revalidate), and a
 * connection problem is shown only when it persists: a second failed cycle in a row (the retry
 * after about two seconds also failed) or five seconds without an answer, whichever comes first.
 * Shown at once are only final answers: the phone's own report that it has no network at all, and
 * an answer the reader will not retry (`error`: an HTTP refusal, a broken body, a captive-portal
 * page), which waiting would not change. Once shown, the problem stays until the server answers
 * again, so the banner never blinks on and off.
 *
 * This only decides what the customer sees. It never sends anything: payment still goes through
 * the guarded submit(), which asks the server again (quote, admission, invoice) and is refused
 * there when the restaurant cannot take the order. Closed hours, the server switch, the stop list
 * and «nothing payable before the first answer» are decided from the kept answer as before.
 */
export const CONNECTION_PROBLEM_AFTER_MS = 5_000;
/** Failed read cycles in a row that prove the server is not reachable. */
export const CONNECTION_PROBLEM_AFTER_FAILURES = 2;

/**
 * `offline`: a transport failure the reader retries (a dropped request, a timeout, HTTP 5xx, 408,
 * 429). `error`: an answer the reader does not retry (another HTTP refusal, a malformed body, a
 * captive-portal page); it stays until the app comes back to the foreground or the network changes.
 */
export type ReadFailure = 'offline' | 'error';

export interface ConnectionTrack {
  /** Failed read cycles in a row since the last answer. */
  failures: number;
  /** What the latest failure means; null while reads succeed. */
  kind: ReadFailure | null;
  /** Numbers each run of failures, so a timer armed for an old run never marks a new one. */
  streak: number;
  /**
   * When the current run of failures started (ms since the epoch), null while reads succeed. A
   * tracker recreated by a refresh waits only the rest of the persistence time, not all of it.
   */
  since: number | null;
  /** The phone itself reports no network interface (NetInfo isConnected === false). */
  phoneOffline: boolean;
  /** The problem is shown; it stays until the server answers again. */
  shown: boolean;
}

export const CONNECTION_OK: ConnectionTrack = {
  failures: 0,
  kind: null,
  streak: 0,
  since: null,
  phoneOffline: false,
  shown: false,
};

/** The server answered: whatever happened before is over. */
export function readSucceeded(track: ConnectionTrack): ConnectionTrack {
  return track.failures === 0 && !track.shown && !track.phoneOffline && track.kind === null
    ? track
    : { ...CONNECTION_OK, streak: track.streak };
}

/**
 * One read cycle failed. The second one in a row is a real problem; so is an answer the reader
 * will not retry (`error`), at once: no later read is coming to correct it.
 */
export function readFailed(
  track: ConnectionTrack,
  kind: ReadFailure,
  now: number = Date.now(),
): ConnectionTrack {
  const failures = track.failures + 1;
  const first = track.failures === 0;
  return {
    ...track,
    failures,
    kind,
    streak: first ? track.streak + 1 : track.streak,
    since: first || track.since === null ? now : track.since,
    shown: track.shown || kind === 'error' || failures >= CONNECTION_PROBLEM_AFTER_FAILURES,
  };
}

/** How long the persistence timer of the pending run still has to wait at `now`. */
export function persistenceWait(
  track: ConnectionTrack,
  now: number,
  delayMs: number = CONNECTION_PROBLEM_AFTER_MS,
): number {
  if (track.since === null) return delayMs;
  return Math.min(delayMs, Math.max(0, delayMs - (now - track.since)));
}

/** The persistence timer of run `streak` fired: still failing, so it is a real problem. */
export function failurePersisted(track: ConnectionTrack, streak: number): ConnectionTrack {
  return track.kind !== null && !track.shown && track.streak === streak
    ? { ...track, shown: true }
    : track;
}

/**
 * The phone's own network report. No network at all is shown at once (there is nothing to wait
 * for); a network coming back changes nothing until the server answers.
 */
export function phoneNetworkChanged(track: ConnectionTrack, connected: boolean): ConnectionTrack {
  if (connected) return track.phoneOffline ? { ...track, phoneOffline: false } : track;
  if (track.phoneOffline && track.shown) return track;
  return { ...track, phoneOffline: true, shown: true, kind: track.kind ?? 'offline' };
}

/** A failure is waiting to prove itself (the persistence timer should run). */
export function failurePending(track: ConnectionTrack): boolean {
  return track.kind !== null && !track.shown;
}

/**
 * The reader stopped or started again: the app went to the background (the customer switches to
 * Kaspi.kz to pay, locks the phone) or came back, or the phone lost its network interface. A
 * failure not shown yet belonged to reads that no longer run, so it is forgotten (independent QA
 * 28.10, item 20): its five seconds must not run out while nothing is read (on iPhone the timer
 * fires on the first frame after the return), and the first failure after the return (iOS often
 * reports «connection lost» right after resume) is not «the second failure in a row», because
 * nothing was read in between. Both rules count only while reads run. A problem already shown
 * stays until the server answers (no blinking), and the phone's own report is kept.
 */
export function readsPaused(track: ConnectionTrack): ConnectionTrack {
  return failurePending(track) ? { ...track, failures: 0, kind: null, since: null } : track;
}

/** The connection problem the customer should see now, or null. */
export function connectionProblem(track: ConnectionTrack): ReadFailure | null {
  if (track.phoneOffline) return 'offline';
  return track.shown ? track.kind : null;
}

/**
 * The read state the app shows: the kept answer with its own status while reads succeed or a
 * failure has not persisted yet; «offline» / «error» once it has. Before the first answer a
 * transient failure stays «checking» (nothing payable, a grey «Проверяем…», no banner).
 */
export function shownAvailabilityState(
  data: Availability | null,
  track: ConnectionTrack,
): AvailabilityReadState {
  const problem = connectionProblem(track);
  if (problem) return { data, status: problem };
  return { data, status: data ? 'online' : 'checking' };
}

/**
 * The tracker the availability hook drives: failures, successes and the phone's network go in,
 * the track comes out through `onChange`; the persistence timer lives here so it can be tested.
 * A tracker started from an `initial` track with a failure still pending (the hook restarts the
 * reader on a refresh) waits only what is left of that run's persistence time.
 * `reading(active)` follows the reader: going inactive forgets a failure not shown yet and stops
 * its timer (readsPaused); coming back after a pause starts from a clean run. Repeated reports of
 * the same state (every network event re-reports «active») change nothing, and the first report
 * of a new tracker that reads keeps the pending run of a refresh.
 */
export function createConnectionTracker(options: {
  onChange(track: ConnectionTrack): void;
  initial?: ConnectionTrack;
  delayMs?: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let track = options.initial ?? CONNECTION_OK;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerStreak: number | null = null;
  let stopped = false;
  // Whether the reader runs: null until the first report.
  let reading: boolean | null = null;
  const disarm = () => {
    clearTimeout(timer);
    timer = undefined;
    timerStreak = null;
  };
  const arm = () => {
    if (!failurePending(track)) {
      disarm();
      return;
    }
    // One timer per run of failures: later failures of the same run do not restart it.
    if (timerStreak === track.streak) return;
    disarm();
    const streak = track.streak;
    timerStreak = streak;
    timer = setTimeout(
      () => {
        timer = undefined;
        timerStreak = null;
        set(failurePersisted(track, streak));
      },
      persistenceWait(track, now(), options.delayMs),
    );
  };
  const set = (next: ConnectionTrack) => {
    if (stopped) return;
    const changed = next !== track;
    track = next;
    arm();
    if (changed) options.onChange(track);
  };
  arm();
  return {
    succeeded: () => set(readSucceeded(track)),
    failed: (kind: ReadFailure) => set(readFailed(track, kind, now())),
    network: (connected: boolean) => set(phoneNetworkChanged(track, connected)),
    reading(active: boolean) {
      const resumed = active && reading === false;
      reading = active;
      if (!active || resumed) set(readsPaused(track));
    },
    current: () => track,
    stop() {
      stopped = true;
      disarm();
    },
  };
}
