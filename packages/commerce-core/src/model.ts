import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  PricedCatalogQuoteSchema,
  PricedCatalogLineSchema,
} from '@pickchick/catalog-pricing/model';

export class CommerceError extends Error {
  constructor(
    public readonly code:
      'INVALID' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'EXPIRED' | 'NOT_READY' | 'REFUND_LIMIT',
  ) {
    super(code);
  }
}
export const MAX_MINOR = 9_000_000_000_000_000n;
const uuid = z.uuid();
const reference = z.string().min(1).max(160);
export const MinorSchema = z
  .string()
  .refine((value) => /^(0|[1-9][0-9]{0,15})$/.test(value) && BigInt(value) <= MAX_MINOR);
const positive = MinorSchema.refine((value) => /^[0-9]+$/.test(value) && BigInt(value) > 0n);
// These contexts are supplied by authenticated server adapters, never parsed
// from a customer's claims. This package does not authenticate HTTP requests.
export const ScopeSchema = z.strictObject({
  organizationId: uuid,
  branchId: uuid,
  principalId: uuid,
  role: z.enum(['sales', 'manager']),
});
export type CommerceScope = z.infer<typeof ScopeSchema>;
export const ProviderSchema = z.strictObject({
  organizationId: uuid,
  branchId: uuid,
  accountId: uuid,
});
export type TrustedProvider = z.infer<typeof ProviderSchema>;
export const EdgeSchema = z.strictObject({ organizationId: uuid, branchId: uuid, deviceId: uuid });
export type TrustedEdge = z.infer<typeof EdgeSchema>;
export const LineSchema = z.strictObject({
  lineId: uuid,
  productId: reference,
  title: z.string().min(1).max(250),
  quantity: z.number().int().min(1).max(1000),
  unitPriceMinor: MinorSchema,
  discountMinor: MinorSchema,
  taxCode: z.string().min(1).max(32),
  description: z.string().max(2000).default(''),
});
export const FoundationPricedQuoteSchema = z.strictObject({
  releaseId: uuid,
  customerId: uuid.nullable().default(null),
  channel: z.literal('mobile'),
  serviceMode: z.enum(['takeaway', 'dine_in']),
  currency: z.literal('KZT'),
  ttlSeconds: z.number().int().min(1).max(900),
  lines: z.array(LineSchema).min(1).max(200),
});
export const TaxBindingSchema = z.strictObject({
  legalEntityId: uuid,
  approvalReference: z.string().trim().min(3).max(250),
  version: z.number().int().positive().max(2147483647),
});
export const PublishedCatalogQuoteSchema = PricedCatalogQuoteSchema.extend({
  channel: z.literal('mobile'),
  taxBinding: TaxBindingSchema,
  lines: z
    .array(PricedCatalogLineSchema.extend({ taxCode: z.string().trim().min(1).max(32) }))
    .min(1)
    .max(200),
});
export const PricedQuoteSchema = z.union([
  FoundationPricedQuoteSchema,
  PublishedCatalogQuoteSchema,
]);
export type ServerPricedQuote = z.input<typeof PricedQuoteSchema>;
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new CommerceError('INVALID');
  return result.data;
}
export function digest(input: unknown): string {
  function canonical(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
      return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return (
        '{' +
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child))
          .join(',') +
        '}'
      );
    }
    throw new CommerceError('INVALID');
  }
  return createHash('sha256').update(canonical(input)).digest('hex');
}
export function priceSnapshot(input: unknown) {
  const quote = parse(PricedQuoteSchema, input);
  if (new Set(quote.lines.map((line) => line.lineId)).size !== quote.lines.length)
    throw new CommerceError('INVALID');
  let total = 0n;
  const lines = quote.lines.map((line) => {
    const gross = BigInt(line.unitPriceMinor) * BigInt(line.quantity);
    const net = gross - BigInt(line.discountMinor);
    if (net < 0n || gross > MAX_MINOR) throw new CommerceError('INVALID');
    if (
      'baseUnitPriceMinor' in line &&
      (BigInt(line.baseUnitPriceMinor) + BigInt(line.modifiersUnitPriceMinor) !==
        BigInt(line.unitPriceMinor) ||
        line.grossMinor !== gross.toString() ||
        line.totalMinor !== net.toString())
    )
      throw new CommerceError('INVALID');
    total += net;
    return { ...line, grossMinor: gross.toString(), totalMinor: net.toString() };
  });
  if (total <= 0n || total > MAX_MINOR) throw new CommerceError('INVALID');
  if ('catalogReference' in quote) {
    if (quote.totalMinor !== total.toString() || quote.subtotalMinor !== total.toString())
      throw new CommerceError('INVALID');
    // Preserve the discriminated catalog shape for the database verification port.
    return { ...quote, totalMinor: total.toString() };
  }
  return { ...quote, lines, totalMinor: total.toString() };
}
export const CreateOrderSchema = z.strictObject({ quoteId: uuid, fiscalAccountId: uuid });
export const AttemptSchema = z.strictObject({ orderId: uuid, providerAccountId: uuid });
export const AdmissionSchema = z.strictObject({
  eventId: reference,
  orderId: uuid,
  reservationId: uuid,
  quoteDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const PaymentObservationSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    eventId: reference,
    attemptId: uuid,
    outcome: z.literal('captured'),
    operationId: reference,
    amountMinor: positive,
    occurredAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    eventId: reference,
    attemptId: uuid,
    outcome: z.enum(['pending', 'unknown', 'failed']),
    occurredAt: z.iso.datetime({ offset: true }),
  }),
]);
export const RefundRequestSchema = z.strictObject({
  orderId: uuid,
  captureId: uuid,
  amountMinor: positive,
  reason: z.string().min(3).max(500),
  fulfillmentPolicy: z.enum(['not_dispatched', 'manager_reviewed']).default('not_dispatched'),
});
export const RefundObservationSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    eventId: reference,
    refundId: uuid,
    outcome: z.literal('succeeded'),
    operationId: reference,
    amountMinor: positive,
    occurredAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    eventId: reference,
    refundId: uuid,
    outcome: z.enum(['pending', 'unknown', 'failed']),
    occurredAt: z.iso.datetime({ offset: true }),
  }),
]);
export const FiscalObservationSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    eventId: reference,
    documentId: uuid,
    outcome: z.literal('issued'),
    providerDocumentId: reference,
    fiscalMark: reference,
    receiptUrl: z.url().refine((value) => new URL(value).protocol === 'https:'),
    amountMinor: positive,
    occurredAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    eventId: reference,
    documentId: uuid,
    outcome: z.enum(['pending', 'unknown', 'failed']),
    occurredAt: z.iso.datetime({ offset: true }),
  }),
]);
export const UUIDSchema = uuid;
export const LeaseSchema = z.strictObject({
  workerId: uuid,
  limit: z.number().int().min(1).max(100),
  leaseSeconds: z.number().int().min(5).max(300),
});
export const AckSchema = z.strictObject({ eventId: uuid, workerId: uuid, leaseToken: uuid });
