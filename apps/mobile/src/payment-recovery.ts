export type PendingPayment = {
  key: string;
  quoteId: string;
  signature: string;
  orderId?: string;
  sendInvoice?: boolean;
  /** Epoch ms of the customer's tap. Absent in drafts written by build 20 and earlier. */
  createdAt?: number;
};

export const pendingPaymentKey = (customerId: string | undefined) =>
  `pickchick.commerce.pending.v1:${customerId}`;

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
    (draft.createdAt !== undefined &&
      (!Number.isSafeInteger(draft.createdAt) || (draft.createdAt as number) <= 0))
  )
    throw new Error('INVALID_PENDING');
  return draft as PendingPayment;
}

/**
 * Intents the customer closed in this app session (audit 2.0). PaymentRecovery does not push
 * them back onto the screen; the next app start offers the recovery once more.
 */
const dismissed = new Set<string>();
export function dismissPendingPayment(key: string) {
  dismissed.add(key);
}
export function pendingPaymentDismissed(draft: PendingPayment | null): boolean {
  return !!draft && dismissed.has(draft.key);
}
