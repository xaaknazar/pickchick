export type PendingPayment = {
  key: string;
  quoteId: string;
  signature: string;
  orderId?: string;
  sendInvoice?: boolean;
  /** Epoch ms of the customer's tap. Absent in drafts written by build 20 and earlier. */
  createdAt?: number;
  /**
   * Epoch ms when the customer closed this payment (the X of a payment screen or of the resume
   * banner). Kept in the intent itself, so it stays closed after an app restart (owner 28.10.2026,
   * TestFlight 26). Absent while it is open and in drafts written before this field existed.
   */
  closedAt?: number;
};

export const pendingPaymentKey = (customerId: string | undefined) =>
  `pickchick.commerce.pending.v1:${customerId}`;

const epoch = (value: unknown) =>
  value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);

/** Restoring a durable command reuses its key, never generates another payment. */
export function parsePendingPayment(raw: string | null): PendingPayment | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('INVALID_PENDING');
  const draft = value as Partial<PendingPayment>;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (
    typeof draft.key !== 'string' ||
    !uuid.test(draft.key) ||
    typeof draft.quoteId !== 'string' ||
    !uuid.test(draft.quoteId) ||
    typeof draft.signature !== 'string' ||
    (draft.orderId !== undefined &&
      (typeof draft.orderId !== 'string' || !uuid.test(draft.orderId))) ||
    (draft.sendInvoice !== undefined && typeof draft.sendInvoice !== 'boolean') ||
    !epoch(draft.createdAt) ||
    !epoch(draft.closedAt)
  )
    throw new Error('INVALID_PENDING');
  return draft as PendingPayment;
}

/**
 * Intents closed in this app run whose `closedAt` may not have reached storage (a failed write):
 * they stay closed for the rest of the run. Storage keeps them closed across restarts.
 */
const dismissed = new Set<string>();
/**
 * Intents this app run created or the customer opened explicitly (a pay tap, the resume banner).
 * Only these come back on the cart or «Заказы» by themselves (a return from Kaspi.kz); an intent
 * saved by an earlier run never takes over a screen (owner 28.10.2026: the app opens on the menu).
 */
const thisRun = new Set<string>();

/**
 * The customer closed this payment (audit 0.2 / 2.0, owner 28.10.2026). The intent stays saved
 * while the bank may still act, so the next explicit pay tap reopens the same order instead of a
 * second invoice, but it loses its automatic invoice and never opens by itself again: not at the
 * next start, not when the cart opens. The first close keeps its time.
 */
export function closePendingPayment(draft: PendingPayment, now: number): PendingPayment {
  dismissed.add(draft.key);
  return { ...draft, sendInvoice: false, closedAt: draft.closedAt ?? now };
}

/**
 * An explicit pay tap reopened a closed intent and its order is on screen again: it is open
 * again (a restart while it waits in Kaspi offers it once more). Its automatic invoice stays
 * withdrawn.
 */
export function reopenPendingPayment(draft: PendingPayment): PendingPayment {
  dismissed.delete(draft.key);
  thisRun.add(draft.key);
  if (draft.closedAt === undefined) return draft;
  const open = { ...draft };
  delete open.closedAt;
  return open;
}

/** Closed for the rest of this run at once, before its `closedAt` reaches storage. */
export function dismissPendingPayment(key: string) {
  dismissed.add(key);
}

/** Closed by the customer: in storage, or in this app run. */
export function pendingPaymentClosed(draft: PendingPayment | null): boolean {
  return !!draft && (draft.closedAt !== undefined || dismissed.has(draft.key));
}

export function adoptPendingPayment(key: string) {
  thisRun.add(key);
}
export function pendingPaymentOfThisRun(draft: PendingPayment | null): boolean {
  return !!draft && thisRun.has(draft.key);
}
