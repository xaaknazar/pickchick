/**
 * Arithmetic for the owner's seven purchased combos + one gift programme.
 * Inputs must come from the commercial PostgreSQL ledger, never client claims
 * or the existing practice counter. This module does not grant or spend gifts.
 */
export const COMBO_REWARD_THRESHOLD = 7;

export interface ComboRewardBalance {
  /** Qualifying purchased units after confirmed reversals, not order count. */
  earnedUnits: number;
  /** Gifts irreversibly attached to accepted orders. */
  usedGifts: number;
  /** Gifts held by an in-flight checkout, including an unknown payment result. */
  reservedGifts: number;
}

function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_COMBO_BALANCE');
  return value;
}

export function comboRewardProgress(input: ComboRewardBalance) {
  const earnedUnits = count(input.earnedUnits);
  const usedGifts = count(input.usedGifts);
  const reservedGifts = count(input.reservedGifts);
  const committedGifts = count(usedGifts + reservedGifts);
  const completedCycles = Math.floor(earnedUnits / COMBO_REWARD_THRESHOLD);
  const currentStamps = earnedUnits % COMBO_REWARD_THRESHOLD;
  const availableGifts = Math.max(0, completedCycles - committedGifts);
  // A return after redemption needs reconciliation, never an automatic charge
  // or a negative number of checkmarks in the customer's profile.
  const reconciliationRequired = committedGifts > completedCycles;
  return {
    earnedUnits,
    completedCycles,
    currentStamps,
    availableGifts,
    usedGifts,
    reservedGifts,
    reconciliationRequired,
    // Keep a just-completed card visible until its gift is selected/redeemed.
    // Beyond that boundary the remainder belongs to the next card.
    visibleStamps:
      currentStamps === 0 && availableGifts > 0 ? COMBO_REWARD_THRESHOLD : currentStamps,
    remainingToNextGift: COMBO_REWARD_THRESHOLD - currentStamps,
  };
}
