export type PendingPayment = {
  key: string;
  quoteId: string;
  signature: string;
  orderId?: string;
  sendInvoice?: boolean;
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
    (draft.sendInvoice !== undefined && typeof draft.sendInvoice !== 'boolean')
  )
    throw new Error('INVALID_PENDING');
  return draft as PendingPayment;
}
