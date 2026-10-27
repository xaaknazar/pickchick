/**
 * Arithmetic for the owner's six purchased combos + one gift programme
 * («Купи 6 комбо, 7-е в подарок», owner decision 27.10.2026; was 7 + 1).
 * Inputs must come from the commercial PostgreSQL ledger, never client claims
 * or the existing practice counter. This module does not grant or spend gifts.
 *
 * The rule changed before the programme was ever enabled, so no stored balance was
 * earned under the old threshold. The ledger keeps its historical programme
 * identifier `seven-paid-combos-v1` (fixed by the applied migration 060); it names
 * the schema row, not the threshold. Never change this threshold again once a
 * programme has started: every balance is recomputed from it on each read.
 *
 * Installed apps (builds 21/23) parse the response with currentStamps <= 6,
 * visibleStamps <= 7 and remainingToNextGift <= 7; threshold 6 stays inside them.
 */
export const COMBO_REWARD_THRESHOLD = 6;

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
      currentStamps === 0 && !reconciliationRequired && (availableGifts > 0 || reservedGifts > 0)
        ? COMBO_REWARD_THRESHOLD
        : currentStamps,
    remainingToNextGift: COMBO_REWARD_THRESHOLD - currentStamps,
  };
}
