import { z } from 'zod';
const amount = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);
export const CustomerPaymentMethodSchema = z.enum(['kaspi', 'card', 'apple_pay', 'google_pay']);
export const CustomerHostedPaymentSchema = z.strictObject({
  orderId: z.uuid(),
  attemptId: z.uuid(),
  checkoutUrl: z.url(),
  expiresAt: z.iso.datetime(),
});
export type CustomerHostedPayment = z.infer<typeof CustomerHostedPaymentSchema>;
export const CustomerCheckoutConfigSchema = z.strictObject({
  enabled: z.boolean(),
  paymentMethods: z.array(CustomerPaymentMethodSchema).optional(),
  orderCommentEnabled: z.boolean().optional().default(false),
  branchId: z.uuid(),
  restaurant: z.string(),
  fiscalPolicy: z.literal('deferred_pilot'),
});
export const CustomerQuoteSchema = z.strictObject({
  quoteId: z.uuid(),
  totalMinor: amount,
  expiresAt: z.iso.datetime(),
  serviceMode: z.enum(['takeaway', 'dine_in']),
  kitchenComment: z.string().max(60).nullable().optional(),
});
export const CustomerCommerceOrderSchema = z.strictObject({
  orderId: z.uuid(),
  paymentMethod: CustomerPaymentMethodSchema.optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  restaurant: z.string(),
  branchId: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  kitchenStage: z.enum(['cooking', 'assembly']).nullable(),
  displayNumber: z.string().nullable(),
  totalMinor: amount,
  serviceMode: z.enum(['takeaway', 'dine_in']),
  kitchenComment: z.string().max(60).nullable().optional(),
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
        totalMinor: amount,
        modifiers: z.array(z.string()),
      }),
    )
    .max(200),
});
export type CustomerCommerceOrder = z.infer<typeof CustomerCommerceOrderSchema>;

export const CustomerOrderFeedbackInputSchema = z.strictObject({
  rating: z.int().min(1).max(5),
  comment: z.string().trim().max(500).optional(),
});
export const CustomerOrderFeedbackResponseSchema = z.strictObject({
  orderId: z.uuid(),
  enabled: z.boolean(),
  feedback: z
    .strictObject({
      rating: z.int().min(1).max(5),
      comment: z.string().max(500).nullable(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
  preparationStartedAt: z.iso.datetime().nullable(),
  readyAt: z.iso.datetime().nullable(),
});
export type CustomerOrderFeedbackResponse = z.infer<typeof CustomerOrderFeedbackResponseSchema>;

export const CustomerOrderFeedbackListSchema = z.strictObject({
  feedback: z
    .array(
      z.strictObject({
        orderId: z.uuid(),
        rating: z.int().min(1).max(5),
        comment: z.string().max(500).nullable(),
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
      }),
    )
    .max(30),
});
export type CustomerOrderFeedbackList = z.infer<typeof CustomerOrderFeedbackListSchema>;
