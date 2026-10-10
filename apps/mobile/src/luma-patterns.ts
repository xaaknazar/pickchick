// Luma-inspired feedback patterns (owner request 2026-10-11): pure rules shared by the
// sheet, toast, order status line and slide-to-confirm components and their unit tests.

/** Toast stays on screen this long unless swiped away. */
export const TOAST_DURATION_MS = 2500;
/** Upward drag (px) or velocity (px/s) that dismisses a toast. */
export const TOAST_SWIPE_DISMISS = { distance: 24, velocity: 500 };
/** Fraction of the track the knob must travel to confirm. */
export const SLIDE_CONFIRM_THRESHOLD = 0.9;
/** Sheet spring: settles quickly without a visible bounce past the resting edge. */
export const SHEET_SPRING = { damping: 26, stiffness: 260, mass: 1 } as const;

export const lumaPalette = {
  successSurface: '#E7F5ED',
  successInk: '#0B4F31',
  successIcon: '#116D45',
  infoSurface: '#F2F6FF',
  infoInk: '#04143A',
  infoIcon: '#2E6FE8',
  // Dimmed backdrop; a solid deeper dim replaces the blur when transparency is reduced.
  scrim: 'rgba(2, 8, 24, 0.55)',
  scrimSolid: 'rgba(2, 8, 24, 0.82)',
  // Translucent secondary action on the navy order screen.
  translucent: 'rgba(242, 246, 255, 0.12)',
  translucentBorder: 'rgba(242, 246, 255, 0.16)',
  // Primary-light action: light surface with navy ink.
  light: '#F2F6FF',
  lightInk: '#04143A',
} as const;

export type ToastTone = 'success' | 'info';
export type ToastMessage = { id: number; text: string; tone: ToastTone; icon: string };

export function toastStyle(tone: ToastTone) {
  return tone === 'success'
    ? {
        background: lumaPalette.successSurface,
        ink: lumaPalette.successInk,
        icon: lumaPalette.successIcon,
      }
    : { background: lumaPalette.infoSurface, ink: lumaPalette.infoInk, icon: lumaPalette.infoIcon };
}

// Gesture callbacks run on the UI thread, so these helpers are worklets.
export function toastShouldDismiss(translationY: number, velocityY: number) {
  'worklet';
  return (
    translationY <= -TOAST_SWIPE_DISMISS.distance || velocityY <= -TOAST_SWIPE_DISMISS.velocity
  );
}

/** Knob position clamped to the track; returns progress 0..1. */
export function slideProgress(translationX: number, travel: number) {
  'worklet';
  if (travel <= 0) return 0;
  return Math.min(1, Math.max(0, translationX / travel));
}
export function slideConfirmed(progress: number) {
  'worklet';
  return progress >= SLIDE_CONFIRM_THRESHOLD;
}

type StatusInput = {
  state: string;
  number?: string | null;
  tasks?: { station: string; state: string }[];
};
export type OrderStatusLine = {
  icon: 'checkmark-circle' | 'flame' | 'cube' | 'bag-check' | 'happy' | 'close-circle' | 'time';
  label: string;
  tone: 'success' | 'active' | 'ready' | 'muted';
  /** Spoken in one phrase by screen readers. */
  accessibilityLabel: string;
};

/** Mirrors order-status.orderStage: assembly starts once the prep task is done. */
function assembling(order: StatusInput) {
  const tasks = order.tasks ?? [];
  return (
    order.state === 'preparing' &&
    tasks.length > 0 &&
    tasks.every((task) => task.station !== 'prep' || task.state === 'done')
  );
}

export function orderStatusLine(order: StatusInput): OrderStatusLine {
  const number = order.number ? `Ваш номер ${order.number}` : '';
  const line = (
    icon: OrderStatusLine['icon'],
    label: string,
    tone: OrderStatusLine['tone'],
  ): OrderStatusLine => ({
    icon,
    label,
    tone,
    accessibilityLabel: number ? `${label}. ${number}` : label,
  });
  switch (order.state) {
    case 'ready':
      return line('bag-check', 'Готов - заберите на выдаче', 'ready');
    case 'fulfilled':
      return line('happy', 'Выдан', 'muted');
    case 'cancelled':
      return line('close-circle', 'Отменён', 'muted');
    case 'preparing':
      return assembling(order)
        ? line('cube', 'Собираем', 'active')
        : line('flame', 'Готовится', 'active');
    case 'awaiting_test_payment':
      return line('time', 'Ждём подтверждения', 'muted');
    default:
      return line('checkmark-circle', 'Заказ принят', 'success');
  }
}

/** A toast is shown only for a live transition into "ready", never for an order opened as ready. */
export function readyTransition(previous: string | null | undefined, next: string) {
  return previous != null && previous !== 'ready' && next === 'ready';
}

export const TOASTS = {
  addedToCart: { text: 'Добавлено в корзину', tone: 'success', icon: 'checkmark-circle' },
  orderReady: { text: 'Заказ готов - заберите на выдаче', tone: 'success', icon: 'bag-check' },
} as const satisfies Record<string, Omit<ToastMessage, 'id'>>;
