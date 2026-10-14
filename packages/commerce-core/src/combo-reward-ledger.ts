import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import { CommerceError, type CommerceScope } from './model.js';
import { comboRewardProgress } from './combo-rewards.js';

export type ComboProgramOptions = { startsAt: string; approvalReference: string };
export function comboProgramOptions(env: NodeJS.ProcessEnv): ComboProgramOptions | null {
  if (env.CUSTOMER_COMBO_REWARDS_ENABLED !== 'true') return null;
  return z
    .object({
      startsAt: z.iso.datetime({ offset: true }),
      approvalReference: z.string().min(3).max(250),
    })
    .parse({
      startsAt: env.CUSTOMER_COMBO_REWARDS_STARTS_AT,
      approvalReference: env.CUSTOMER_COMBO_REWARDS_APPROVAL_REFERENCE,
    });
}
type Program = { id: string; starts_at: Date; approval_reference: string };
type Gift = { programId: string; productId: 'pick-combo'; lineId: string; discountMinor: string };
type Line = {
  lineId: string;
  productId: string;
  quantity: number;
  unitPriceMinor: string;
  baseUnitPriceMinor?: string;
  totalMinor: string;
  selectedDetails?: { kind?: string };
};
type Snapshot = { customerId?: string | null; channel?: string; lines: Line[]; comboGift?: Gift };
async function lockAccount(db: DatabaseClient, programId: string, customerId: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `combo:${programId}:${customerId}`,
  ]);
}
async function event(
  db: DatabaseClient,
  programId: string,
  customerId: string,
  orderId: string,
  kind: string,
  units: number,
  detail: object = {},
) {
  await db.query(
    'INSERT INTO combo_reward_events(id,program_id,customer_id,order_id,kind,units_delta,detail) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), programId, customerId, orderId, kind, units, detail],
  );
}
export async function comboBalance(db: DatabaseClient, programId: string, customerId: string) {
  // Terminal cancellation is recorded by the authenticated fulfillment worker.
  // Its contract forbids payment history, so a committed cancellation cannot race a new charge.
  const released = await db.query<{ order_id: string }>(
    `UPDATE combo_reward_redemptions r SET state='released',updated_at=clock_timestamp()
    WHERE r.program_id=$1 AND r.customer_id=$2 AND r.state='held'
    AND EXISTS(SELECT 1 FROM commerce_cancellation_intents c WHERE c.order_id=r.order_id AND c.state='cancelled')
    AND NOT EXISTS(SELECT 1 FROM commerce_payment_attempts a WHERE a.order_id=r.order_id)
    AND NOT EXISTS(SELECT 1 FROM commerce_captures c WHERE c.order_id=r.order_id)
    RETURNING r.order_id`,
    [programId, customerId],
  );
  for (const row of released.rows)
    await event(db, programId, customerId, row.order_id, 'release', 0, {
      reason: 'CONFIRMED_UNPAID_CANCELLATION',
    });

  const row = (
    await db.query<{ earned: string; used: string; held: string; review: boolean }>(
      `SELECT
    (SELECT coalesce(sum(units),0)::text FROM combo_reward_accruals WHERE program_id=$1 AND customer_id=$2) earned,
    (SELECT count(*)::text FROM combo_reward_redemptions WHERE program_id=$1 AND customer_id=$2 AND state='consumed') used,
    (SELECT count(*)::text FROM combo_reward_redemptions WHERE program_id=$1 AND customer_id=$2 AND state='held') held,
    EXISTS(SELECT 1 FROM combo_reward_accruals WHERE program_id=$1 AND customer_id=$2 AND refund_review) review`,
      [programId, customerId],
    )
  ).rows[0]!;
  const progress = comboRewardProgress({
    earnedUnits: Number(row.earned),
    usedGifts: Number(row.used),
    reservedGifts: Number(row.held),
  });
  return {
    ...progress,
    availableGifts: row.review ? 0 : progress.availableGifts,
    reconciliationRequired: row.review || progress.reconciliationRequired,
  };
}
export async function ensureComboProgram(
  db: DatabaseClient,
  scope: CommerceScope,
  options: ComboProgramOptions,
) {
  await db.query(
    `INSERT INTO combo_reward_programs(id,organization_id,branch_id,version,gift_product_id,starts_at,approval_reference)
    VALUES($1,$2,$3,'seven-paid-combos-v1','pick-combo',$4,$5) ON CONFLICT(organization_id,branch_id,version) DO NOTHING`,
    [
      randomUUID(),
      scope.organizationId,
      scope.branchId,
      options.startsAt,
      options.approvalReference,
    ],
  );
  const program = (
    await db.query<Program>(
      `SELECT id,starts_at,approval_reference FROM combo_reward_programs WHERE organization_id=$1 AND branch_id=$2 AND version='seven-paid-combos-v1'`,
      [scope.organizationId, scope.branchId],
    )
  ).rows[0]!;
  if (
    program.starts_at.getTime() !== new Date(options.startsAt).getTime() ||
    program.approval_reference !== options.approvalReference
  )
    throw new CommerceError('CONFLICT');
  return program;
}
export async function customerComboProgress(
  pool: DatabasePool,
  scope: CommerceScope,
  options: ComboProgramOptions | null,
) {
  if (!options) return { enabled: false as const };
  return transaction(pool, async (db) => {
    const program = await ensureComboProgram(db, scope, options);
    await lockAccount(db, program.id, scope.principalId);
    return {
      enabled: true as const,
      programId: program.id,
      giftProductId: 'pick-combo' as const,
      ...(await comboBalance(db, program.id, scope.principalId)),
    };
  });
}

/** Called only after the immutable catalog quote has been repriced by the repository. */
export async function priceComboGift<T extends Snapshot & { totalMinor: string }>(
  db: DatabaseClient,
  scope: CommerceScope,
  snapshot: T,
  selection: { lineIndex: number; options: ComboProgramOptions },
) {
  if (snapshot.customerId !== scope.principalId || snapshot.channel !== 'mobile')
    throw new CommerceError('FORBIDDEN');
  const program = await ensureComboProgram(db, scope, selection.options);
  await lockAccount(db, program.id, scope.principalId);
  const balance = await comboBalance(db, program.id, scope.principalId);
  if (!balance.availableGifts || balance.reconciliationRequired)
    throw new CommerceError('CONFLICT');
  const line = snapshot.lines[selection.lineIndex];
  if (
    !line ||
    line.productId !== 'pick-combo' ||
    !line.baseUnitPriceMinor ||
    BigInt(line.baseUnitPriceMinor) <= 0n
  )
    throw new CommerceError('INVALID');
  // The base combo is free. Optional paid upgrades remain visibly payable.
  const discount = BigInt(line.baseUnitPriceMinor);
  const gift: Gift = {
    programId: program.id,
    productId: 'pick-combo',
    lineId: line.lineId,
    discountMinor: discount.toString(),
  };
  return {
    ...snapshot,
    comboGift: gift,
    discountMinor: discount.toString(),
    totalMinor: (BigInt(snapshot.totalMinor) - discount).toString(),
    lines: snapshot.lines.map((l) =>
      l === line
        ? {
            ...l,
            discountMinor: discount.toString(),
            totalMinor: (BigInt(l.totalMinor) - discount).toString(),
          }
        : l,
    ),
  };
}

export async function reserveComboGift(
  db: DatabaseClient,
  scope: CommerceScope,
  orderId: string,
  snapshot: Record<string, unknown>,
) {
  const gift = snapshot.comboGift as Gift | undefined;
  if (!gift) return;
  const program = await db.query(
    'SELECT 1 FROM combo_reward_programs WHERE id=$1 AND organization_id=$2 AND branch_id=$3',
    [gift.programId, scope.organizationId, scope.branchId],
  );
  if (!program.rowCount) throw new CommerceError('FORBIDDEN');
  await lockAccount(db, gift.programId, scope.principalId);
  const balance = await comboBalance(db, gift.programId, scope.principalId);
  if (!balance.availableGifts || balance.reconciliationRequired)
    throw new CommerceError('CONFLICT');
  await db.query(
    "INSERT INTO combo_reward_redemptions(order_id,program_id,customer_id,state) VALUES($1,$2,$3,'held')",
    [orderId, gift.programId, scope.principalId],
  );
  await event(db, gift.programId, scope.principalId, orderId, 'hold', 0);
}

/** Same transaction and order lock as capture/refund/cancellation reconciliation. */
export async function reconcileComboRewards(db: DatabaseClient, orderId: string): Promise<boolean> {
  // New code remains compatible with an installation that has not applied 060 yet.
  if (
    !(
      await db.query(
        "SELECT CASE WHEN to_regclass('combo_reward_programs') IS NULL THEN false ELSE has_table_privilege(current_user, 'combo_reward_programs', 'SELECT') END present",
      )
    ).rows[0]?.present
  )
    return false;
  const row = (
    await db.query<{
      customer_id: string | null;
      principal_id: string;
      total_minor: string;
      snapshot: Snapshot;
      attention_required: boolean;
      program_id: string;
      starts_at: Date;
      captured: string;
      refunded: string;
      first_capture: Date | null;
      pending_refund: boolean;
      failed: boolean;
      unresolved: boolean;
      cancelled: boolean;
    }>(
      `SELECT o.*,p.id program_id,p.starts_at,
    (SELECT coalesce(sum(amount_minor),0)::text FROM commerce_captures WHERE order_id=o.id) captured,
    (SELECT coalesce(sum(amount_minor),0)::text FROM commerce_refund_effects WHERE order_id=o.id) refunded,
    (SELECT min(received_at) FROM commerce_captures WHERE order_id=o.id) first_capture,
    EXISTS(SELECT 1 FROM commerce_refunds WHERE order_id=o.id AND state IN ('pending','unknown')) pending_refund,
    EXISTS(SELECT 1 FROM commerce_payment_attempts WHERE order_id=o.id AND state='failed') failed,
    EXISTS(SELECT 1 FROM commerce_payment_attempts WHERE order_id=o.id AND state IN ('pending','unknown')) unresolved,
    EXISTS(SELECT 1 FROM commerce_cancellation_intents WHERE order_id=o.id AND state='cancelled') cancelled
    FROM commerce_orders o JOIN combo_reward_programs p ON p.organization_id=o.organization_id AND p.branch_id=o.branch_id
    WHERE o.id=$1 AND o.snapshot->>'channel'='mobile' AND o.customer_id=o.principal_id`,
      [orderId],
    )
  ).rows[0];
  if (!row?.customer_id) return false;
  const customer = row.customer_id;
  await lockAccount(db, row.program_id, customer);
  const paid = row.captured === row.total_minor;
  const allocated = (
    await db.query<{ line_id: string; quantity: string }>(
      `SELECT l.line_id,sum(l.quantity)::text quantity FROM commerce_refund_lines l
    JOIN commerce_refunds r ON r.id=l.refund_id
    WHERE r.order_id=$1 AND r.state='succeeded' AND (SELECT count(*)=1 AND sum(amount_minor)=r.amount_minor FROM commerce_refund_effects e WHERE e.refund_id=r.id)
    GROUP BY l.line_id`,
      [orderId],
    )
  ).rows;
  const unknownPartial =
    BigInt(row.refunded) > 0n &&
    BigInt(row.refunded) < BigInt(row.total_minor) &&
    Boolean(
      (
        await db.query(
          `SELECT 1 FROM commerce_refund_effects e WHERE e.order_id=$1 AND (NOT EXISTS(SELECT 1 FROM commerce_refund_lines l WHERE l.refund_id=e.refund_id) OR e.amount_minor<>(SELECT amount_minor FROM commerce_refunds WHERE id=e.refund_id) OR (SELECT count(*) FROM commerce_refund_effects x WHERE x.refund_id=e.refund_id)>1) LIMIT 1`,
          [orderId],
        )
      ).rowCount,
    );
  let units = 0;
  if (
    paid &&
    row.first_capture &&
    row.first_capture >= row.starts_at &&
    BigInt(row.refunded) < BigInt(row.total_minor)
  ) {
    for (const line of row.snapshot.lines) {
      if (line.selectedDetails?.kind !== 'combo' || BigInt(line.unitPriceMinor) <= 0n) continue;
      const giftUnits = row.snapshot.comboGift?.lineId === line.lineId ? 1 : 0;
      units += Math.max(
        0,
        line.quantity -
          giftUnits -
          Number(allocated.find((l) => l.line_id === line.lineId)?.quantity ?? 0),
      );
    }
  }
  const review =
    unknownPartial ||
    row.pending_refund ||
    (BigInt(row.captured) > 0n && !paid) ||
    BigInt(row.refunded) > BigInt(row.total_minor);
  const old = (
    await db.query<{ units: number; refund_review: boolean }>(
      'SELECT units,refund_review FROM combo_reward_accruals WHERE program_id=$1 AND order_id=$2',
      [row.program_id, orderId],
    )
  ).rows[0];
  if (!old || old.units !== units || old.refund_review !== review) {
    await db.query(
      `INSERT INTO combo_reward_accruals(program_id,order_id,customer_id,units,refund_review) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(program_id,order_id) DO UPDATE SET units=EXCLUDED.units,refund_review=EXCLUDED.refund_review,updated_at=clock_timestamp()`,
      [row.program_id, orderId, customer, units, review],
    );
    await event(db, row.program_id, customer, orderId, 'accrual', units - (old?.units ?? 0), {
      refundReview: review,
    });
  }
  const redemption = (
    await db.query<{ state: string }>(
      'SELECT state FROM combo_reward_redemptions WHERE order_id=$1',
      [orderId],
    )
  ).rows[0];
  if (redemption) {
    // A failed bank attempt is terminal; unknown/pending results retain the hold.
    if (paid && redemption.state !== 'consumed') {
      const balance = await comboBalance(db, row.program_id, customer);
      if (balance.reconciliationRequired) return true;
    }
    const next = paid
      ? 'consumed'
      : row.captured === '0' && !row.unresolved && (row.failed || row.cancelled)
        ? 'released'
        : redemption.state;
    if (next !== redemption.state) {
      if (redemption.state === 'released' && next === 'consumed') {
        const balance = await comboBalance(db, row.program_id, customer);
        if (!balance.availableGifts || balance.reconciliationRequired) return true;
      }
      await db.query(
        'UPDATE combo_reward_redemptions SET state=$2,updated_at=clock_timestamp() WHERE order_id=$1',
        [orderId, next],
      );
      await event(
        db,
        row.program_id,
        customer,
        orderId,
        next === 'consumed' ? 'consume' : 'release',
        0,
      );
    }
  }
  const balance = await comboBalance(db, row.program_id, customer);
  if (balance.reconciliationRequired && BigInt(row.refunded) > 0n && old?.units !== units) {
    await event(db, row.program_id, customer, orderId, 'review', 0, {
      reason: 'RETURN_AFTER_GIFT_RESERVATION_OR_USE',
    });
    return true;
  }
  return false;
}

/** Records item-level intent before contacting the bank. Only a confirmed refund removes units. */
export async function recordComboRefundLines(
  db: DatabaseClient,
  orderId: string,
  refundId: string,
  amountMinor: string,
  items?: { lineId: string; quantity: number }[],
) {
  if (!items?.length) return;
  if (new Set(items.map((l) => l.lineId)).size !== items.length) throw new CommerceError('INVALID');
  const snapshot = (
    await db.query<{ snapshot: Snapshot }>('SELECT snapshot FROM commerce_orders WHERE id=$1', [
      orderId,
    ])
  ).rows[0]!.snapshot;
  let amount = 0n;
  for (const item of items) {
    const line = snapshot.lines.find((l) => l.lineId === item.lineId);
    if (!line) throw new CommerceError('INVALID');
    const giftUnits = snapshot.comboGift?.lineId === line.lineId ? 1 : 0;
    const used = (
      await db.query<{ units: string }>(
        `SELECT coalesce(sum(l.quantity),0)::text units FROM commerce_refund_lines l JOIN commerce_refunds r ON r.id=l.refund_id WHERE r.order_id=$1 AND l.line_id=$2 AND r.state<>'failed'`,
        [orderId, item.lineId],
      )
    ).rows[0]!;
    if (item.quantity + Number(used.units) > line.quantity - giftUnits)
      throw new CommerceError('REFUND_LIMIT');
    amount += BigInt(line.unitPriceMinor) * BigInt(item.quantity);
  }
  if (amount !== BigInt(amountMinor)) throw new CommerceError('INVALID');
  for (const item of items)
    await db.query(
      'INSERT INTO commerce_refund_lines(refund_id,line_id,quantity) VALUES($1,$2,$3)',
      [refundId, item.lineId, item.quantity],
    );
}
