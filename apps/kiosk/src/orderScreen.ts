import type { KioskState } from './model';

/** Seconds a paid order keeps its number on screen; any touch starts them again. */
export const PAID_HOLD = 40;
/**
 * Seconds a paid order without its kitchen number waits on screen (polling continues and the
 * number shows as soon as it arrives) before the kiosk returns to the start screen (owner
 * decision 2026-10-10: two minutes).
 */
export const NUMBER_WAIT_HOLD = 120;
/** Seconds a failed payment (or a payment incident) stays before returning to the start. */
export const FAILED_HOLD = 30;

/** What the order screen shows and how it leaves, from the guest-facing state. */
export function orderScreenState(
  model: Pick<KioskState, 'order' | 'commercial' | 'qrPayment' | 'recoveryRequired'>,
) {
  const order = model.order;
  const paid = !!order && ['simulated_approved', 'paid'].includes(order.payment_state);
  const failed = order?.state === 'failed' || order?.state === 'cancelled';
  const waitingForNumber = !!model.commercial && paid && (!order!.number || order!.number === '-');
  // A manager-accepted payment incident reaches the device as `failed` while the QR payment is
  // still being checked: the result is unknown ("Результат оплаты уточняется"), not a decline.
  const incident =
    !!model.commercial &&
    order?.state === 'failed' &&
    !!model.qrPayment &&
    model.qrPayment.state !== 'failed';
  const canReset = !!order && (paid || failed) && !model.recoveryRequired;
  return {
    paid,
    failed,
    waitingForNumber,
    incident,
    canReset,
    /** Seconds until the automatic return to the start screen. */
    hold: waitingForNumber ? NUMBER_WAIT_HOLD : paid ? PAID_HOLD : FAILED_HOLD,
    /**
     * Owner decision 2026-10-10: the incident screen also has a visible "Отменить" that takes
     * the same safe path as its auto-reset (the payment stays on reconciliation; the kiosk
     * never declares it paid or failed).
     */
    cancel: incident && canReset,
  };
}
