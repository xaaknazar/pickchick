import { z } from 'zod';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CustomerComboRewardsSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    programId: z.uuid(),
    giftProductId: z.literal('pick-combo'),
    earnedUnits: count,
    completedCycles: count,
    currentStamps: count.max(6),
    availableGifts: count,
    usedGifts: count,
    reservedGifts: count,
    reconciliationRequired: z.boolean(),
    visibleStamps: count.max(7),
    remainingToNextGift: count.min(1).max(7),
  }),
]);
export type CustomerComboRewards = z.infer<typeof CustomerComboRewardsSchema>;
