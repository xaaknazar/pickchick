import { z } from 'zod';
const amount = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);
export const CustomerCheckoutConfigSchema = z.strictObject({
  enabled: z.boolean(),
  branchId: z.uuid(),
  restaurant: z.string(),
  fiscalPolicy: z.literal('deferred_pilot'),
});
export const CustomerQuoteSchema = z.strictObject({
  quoteId: z.uuid(),
  totalMinor: amount,
  expiresAt: z.iso.datetime(),
  serviceMode: z.enum(['takeaway', 'dine_in']),
});
export const CustomerCommerceOrderSchema = z.strictObject({
  orderId: z.uuid(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  restaurant: z.string(),
  displayNumber: z.string().nullable(),
  totalMinor: amount,
  serviceMode: z.enum(['takeaway', 'dine_in']),
  phase: z.enum([
    'awaiting_restaurant',
    'ready_to_pay',
    'sending',
    'awaiting_payment',
    'checking',
    'failed',
    'paid',
    'preparing',
    'ready',
    'handed_over',
    'attention',
  ]),
  expiresAt: z.iso.datetime().nullable(),
  receipt: z.enum(['deferred', 'pending', 'issued']),
  receiptUrl: z.url().nullable(),
  items: z
    .array(
      z.strictObject({
        productId: z.string(),
        title: z.string(),
        quantity: z.int().positive(),
        modifiers: z.array(z.string()),
      }),
    )
    .max(200),
});
export type CustomerCommerceOrder = z.infer<typeof CustomerCommerceOrderSchema>;
