import { createContext } from 'react';
import { measureRect, type FlyRect } from './motion';

/** Dining choice whose tile grows into the menu (prototype `.zoomfill`). */
export type RevealMode = 'dine_in' | 'takeaway';

interface Pending {
  mode: RevealMode;
  rect: FlyRect | null;
  at: number;
  /** A mounted reveal waiting for a measurement that had not arrived yet. */
  late?: (rect: FlyRect) => void;
}

type Measurable = Parameters<typeof measureRect>[0];

/** A reveal older than this belongs to an earlier tap and never plays. */
const fresh = 1000;
/**
 * A tile measured this long after the tap still starts the fill. Measuring is
 * asynchronous, so a very quick tap can choose before its tile is measured.
 */
const lateBy = 250;
let last: { mode: RevealMode; rect: FlyRect } | null = null;
let pending: Pending | null = null;

/** Remember where a dining tile sits as soon as a finger lands on it. */
export function trackRevealTile(mode: RevealMode, view: Measurable) {
  void measureRect(view).then((rect) => {
    if (!rect?.width) return;
    last = { mode, rect };
    if (pending?.mode !== mode) return;
    pending.rect = rect;
    const late = pending.late;
    if (!late) return;
    const quick = Date.now() - pending.at <= lateBy;
    pending = null;
    if (quick) late(rect);
  });
}

/** Arm the zoom fill for the tile that was just chosen. Never delays the choice. */
export function armReveal(mode: RevealMode, view: Measurable) {
  pending = { mode, rect: last?.mode === mode ? last.rect : null, at: Date.now() };
  trackRevealTile(mode, view);
}

/** The armed reveal for `mode` when it is fresh enough to play, else null. */
export function peekReveal(mode: RevealMode | null | undefined) {
  if (!pending || pending.mode !== mode || !pending.rect) return null;
  if (Date.now() - pending.at > fresh) return null;
  return pending.rect;
}

/**
 * The armed reveal for `mode` is still being measured: call `late` once with
 * the tile's rectangle if it arrives promptly. Returns a cancel function.
 */
export function awaitReveal(mode: RevealMode | null | undefined, late: (rect: FlyRect) => void) {
  const armed = pending;
  if (!armed || armed.mode !== mode || armed.rect || Date.now() - armed.at > lateBy) {
    return () => {};
  }
  armed.late = late;
  return () => {
    if (armed.late === late) armed.late = undefined;
  };
}

/** Drop the armed reveal so a later menu mount does not replay it. */
export function clearReveal() {
  pending = null;
}

/** Prototype product page circle: opens in 620 ms, closes in 460 ms. */
export const circleOpen = 620;
export const circleClose = 460;

let productOrigin: { x: number; y: number; at: number } | null = null;

/**
 * Remember the centre of the card (or billboard) a finger just landed on: the
 * product page opens as a circle from there. Measuring never delays the tap.
 */
export function noteProductOrigin(view: Measurable) {
  const at = Date.now();
  void measureRect(view).then((rect) => {
    if (rect?.width)
      productOrigin = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, at };
  });
}

/** The fresh tap centre (window coordinates) for the page now opening, once. */
export function takeProductOrigin() {
  const origin = productOrigin;
  productOrigin = null;
  return origin && Date.now() - origin.at <= fresh * 2 ? { x: origin.x, y: origin.y } : null;
}

/**
 * True inside a screen that is leaving (ScreenTransition keeps it on a frozen
 * layer). A circle-revealed screen uses it to close itself over the next one.
 */
export const LeavingContext = createContext(false);
