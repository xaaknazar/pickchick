import { createHash } from 'node:crypto';
import { z } from 'zod';
export class LoyaltyError extends Error {
  constructor(
    public readonly code:
      | 'INVALID'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'PROGRAM_INACTIVE'
      | 'INSUFFICIENT_POINTS'
      | 'REFUND_LIMIT'
      | 'NOT_READY',
  ) {
    super(code);
  }
}
export const MAX_POINTS = 9_000_000_000_000_000n;
export const Amount = z
  .string()
  .refine((v) => /^(0|[1-9][0-9]{0,15})$/.test(v) && BigInt(v) <= MAX_POINTS);
const positive = Amount.refine((v) => /^[0-9]+$/.test(v) && BigInt(v) > 0n);
const signed = z
  .string()
  .refine(
    (v) => /^-?[1-9][0-9]{0,15}$/.test(v) && BigInt(v) >= -MAX_POINTS && BigInt(v) <= MAX_POINTS,
  );
const uuid = z.uuid();
export const UUID = uuid;
export const Context = z.strictObject({
  organizationId: uuid,
  branchId: uuid,
  actorId: uuid,
  authority: z.enum(['manager', 'checkout', 'fulfillment', 'refund', 'scheduler']),
});
export type TrustedLoyaltyContext = z.infer<typeof Context>;
export const Customer = z.strictObject({ organizationId: uuid, customerId: uuid });
export type AuthenticatedLoyaltyCustomer = z.infer<typeof Customer>;
export const Rules = z.strictObject({
  earnBasisPoints: z.number().int().min(0).max(10000),
  pointValueMinor: positive,
  maxRedemptionBasisPoints: z.number().int().min(0).max(10000),
  lotTtlDays: z.number().int().min(1).max(3650).nullable(),
  refundSpentExpiry: z.literal('new_lot_ttl'),
  expiredEarnRefund: z.literal('ignore_expired'),
});
export type ProgramRules = z.infer<typeof Rules>;
export const Program = z.strictObject({
  version: z.number().int().min(1).max(1000000),
  rules: Rules,
  approvalReference: z.string().trim().min(3).max(250),
  reason: z.string().trim().min(3).max(500),
});
export const Activate = z.strictObject({
  programId: uuid,
  reason: z.string().trim().min(3).max(500),
});
export const OrderIdentity = { customerId: uuid, programId: uuid, orderId: uuid };
export const Earn = z.strictObject({
  ...OrderIdentity,
  originalEligibleMinor: Amount,
  fulfillmentEventId: uuid,
});
export const EarnRefund = z.strictObject({
  ...OrderIdentity,
  originalEligibleMinor: Amount,
  sourceRefundId: uuid,
  eligibleRefundMinor: positive,
});
export const Reserve = z.strictObject({
  ...OrderIdentity,
  points: positive,
  eligibleOrderMinor: positive,
});
export const Release = z.strictObject({
  customerId: uuid,
  holdId: uuid,
  resolutionReference: uuid,
  reason: z.string().trim().min(3).max(500),
});
export const Capture = z.strictObject({ customerId: uuid, holdId: uuid, sourceCaptureId: uuid });
export const RedemptionRefund = z.strictObject({
  customerId: uuid,
  holdId: uuid,
  sourceRefundId: uuid,
  points: positive,
});
export const Adjust = z.strictObject({
  customerId: uuid,
  programId: uuid,
  deltaPoints: signed,
  reason: z.string().trim().min(3).max(500),
});
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new LoyaltyError('INVALID');
  return result.data;
}
export function digest(input: unknown): string {
  function canonical(v: unknown): string {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
      return (
        '{' +
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
          .join(',') +
        '}'
      );
    throw new LoyaltyError('INVALID');
  }
  return createHash('sha256').update(canonical(input)).digest('hex');
}
export function earnedPoints(eligibleMinor: string, rules: ProgramRules): bigint {
  const amount = parse(Amount, eligibleMinor),
    config = parse(Rules, rules);
  return (
    (BigInt(amount) * BigInt(config.earnBasisPoints)) / (10000n * BigInt(config.pointValueMinor))
  );
}
export function maxRedemption(eligibleMinor: string, rules: ProgramRules): bigint {
  const amount = parse(Amount, eligibleMinor),
    config = parse(Rules, rules);
  return (
    (BigInt(amount) * BigInt(config.maxRedemptionBasisPoints)) /
    (10000n * BigInt(config.pointValueMinor))
  );
}
export const availablePoints = (balance: bigint, reserved: bigint) =>
  balance > reserved ? balance - reserved : 0n;
