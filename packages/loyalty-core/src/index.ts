import { randomUUID } from 'node:crypto';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import type { z } from 'zod';
import {
  Activate,
  Adjust,
  Capture,
  Context,
  Customer,
  Earn,
  EarnRefund,
  LoyaltyError,
  MAX_POINTS,
  Program,
  RedemptionRefund,
  Release,
  Reserve,
  Rules,
  UUID,
  availablePoints,
  digest,
  earnedPoints,
  maxRedemption,
  parse,
} from './model.js';
import type { AuthenticatedLoyaltyCustomer, ProgramRules, TrustedLoyaltyContext } from './model.js';
export * from './model.js';

type Wallet = {
  id: string;
  organization_id: string;
  customer_id: string;
  balance_points: string;
  reserved_points: string;
  debt_points: string;
  version: string;
};
type Lot = {
  id: string;
  remaining_points: string;
  held_points: string;
  pending_revocation_points: string;
  expired_points: string;
  expired_refund_offset_points: string;
  sequence: string;
  expires_at: Date | null;
};
type Hold = {
  id: string;
  wallet_id: string;
  organization_id: string;
  program_id: string;
  order_id: string;
  points: string;
  eligible_minor: string;
  state: 'held' | 'released' | 'captured';
  capture_id: string | null;
  resolution_id: string | null;
  resolution_reason: string | null;
};
type Reward = {
  original_minor: string;
  refunded_minor: string;
  fulfillment_event_id: string | null;
  initial_awarded_points: string;
  lot_id: string | null;
};
export type WalletView = {
  walletId: string;
  balancePoints: string;
  reservedPoints: string;
  availablePoints: string;
  debtPoints: string;
  version: string;
};
type Tx = { db: DatabaseClient; ctx: TrustedLoyaltyContext; now: Date; wallet: Wallet };
const min = (a: bigint, b: bigint) => (a < b ? a : b);
function fail(code: ConstructorParameters<typeof LoyaltyError>[0]): never {
  throw new LoyaltyError(code);
}
function view(w: Wallet): WalletView {
  return {
    walletId: w.id,
    balancePoints: w.balance_points,
    reservedPoints: w.reserved_points,
    availablePoints: availablePoints(
      BigInt(w.balance_points),
      BigInt(w.reserved_points),
    ).toString(),
    debtPoints: w.debt_points,
    version: w.version,
  };
}

/** Internal server port. Contexts must come from authenticated authorization, never request JSON. */
export class LoyaltyRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: { clock?: () => Date } = {},
  ) {}
  private async now(db: DatabaseClient): Promise<Date> {
    const date =
      this.options.clock?.() ??
      (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    if (!Number.isFinite(date.getTime())) fail('INVALID');
    return date;
  }
  private async scope(db: DatabaseClient, ctx: TrustedLoyaltyContext) {
    if (
      !(
        await db.query('SELECT 1 FROM branches WHERE id=$1 AND organization_id=$2', [
          ctx.branchId,
          ctx.organizationId,
        ])
      ).rowCount
    )
      fail('FORBIDDEN');
  }
  private async run<I, O>(
    context: TrustedLoyaltyContext,
    key: string,
    kind: string,
    schema: z.ZodType<I>,
    input: unknown,
    authorities: TrustedLoyaltyContext['authority'][],
    body: (db: DatabaseClient, ctx: TrustedLoyaltyContext, input: I, now: Date) => Promise<O>,
  ): Promise<O> {
    const ctx = parse(Context, context),
      commandKey = parse(UUID, key),
      data = parse(schema, input);
    if (!authorities.includes(ctx.authority)) fail('FORBIDDEN');
    const hash = digest({ kind, context: ctx, input: data });
    return transaction(this.pool, async (db) => {
      await this.scope(db, ctx);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'loyalty-command:' + ctx.organizationId + ':' + commandKey,
      ]);
      const old = (
        await db.query<{ digest: string; result: O }>(
          'SELECT digest,result FROM loyalty_commands WHERE organization_id=$1 AND command_key=$2',
          [ctx.organizationId, commandKey],
        )
      ).rows[0];
      if (old) {
        if (old.digest !== hash) fail('CONFLICT');
        return old.result;
      }
      const result = await body(db, ctx, data, await this.now(db));
      await db.query(
        'INSERT INTO loyalty_commands(organization_id,command_key,digest,result) VALUES($1,$2,$3,$4)',
        [ctx.organizationId, commandKey, hash, JSON.stringify(result)],
      );
      return result;
    }).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if (error.code === '23505') fail('CONFLICT');
        if (error.code === '23514') fail('INVALID');
      }
      throw error;
    });
  }
  private async lockWallet(
    db: DatabaseClient,
    ctx: TrustedLoyaltyContext,
    customerId: string,
    now: Date,
    allowDeleted = false,
  ): Promise<Tx> {
    // Deletion revokes customer access, but existing financial liabilities still resolve.
    const identity = (
      await db.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM identity_customers WHERE id=$1',
        [customerId],
      )
    ).rows[0];
    if (!identity || (identity.deleted_at && !allowDeleted)) fail('NOT_FOUND');
    if (!identity.deleted_at)
      await db.query(
        'INSERT INTO loyalty_wallets(id,organization_id,customer_id) VALUES($1,$2,$3) ON CONFLICT(organization_id,customer_id) DO NOTHING',
        [randomUUID(), ctx.organizationId, customerId],
      );
    const wallet = (
      await db.query<Wallet>(
        'SELECT * FROM loyalty_wallets WHERE organization_id=$1 AND customer_id=$2 FOR UPDATE',
        [ctx.organizationId, customerId],
      )
    ).rows[0]!;
    if (!wallet) fail('NOT_FOUND');
    const tx = { db, ctx, now, wallet };
    await this.expireLots(tx);
    return tx;
  }
  private async program(
    db: DatabaseClient,
    org: string,
    id: string,
    active = false,
  ): Promise<ProgramRules> {
    const row = (
      await db.query<{ rules: unknown }>(
        `SELECT p.rules FROM loyalty_programs p WHERE p.id=$1 AND p.organization_id=$2 AND ${active ? 'EXISTS(SELECT 1 FROM loyalty_active_programs a WHERE a.organization_id=p.organization_id AND a.program_id=p.id)' : 'EXISTS(SELECT 1 FROM loyalty_activations a WHERE a.organization_id=p.organization_id AND a.program_id=p.id)'}`,
        [id, org],
      )
    ).rows[0];
    if (!row) fail('PROGRAM_INACTIVE');
    return parse(Rules, row.rules);
  }
  private async snapshot(tx: Tx): Promise<WalletView> {
    return view(
      (await tx.db.query<Wallet>('SELECT * FROM loyalty_wallets WHERE id=$1', [tx.wallet.id]))
        .rows[0]!,
    );
  }
  private async balance(tx: Tx, delta: bigint, kind: string, reference: string, reason: string) {
    if (delta === 0n) return;
    if (delta > MAX_POINTS || delta < -MAX_POINTS) fail('INVALID');
    await tx.db.query(
      'INSERT INTO loyalty_ledger(id,wallet_id,organization_id,delta_points,kind,reference_id,actor_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        randomUUID(),
        tx.wallet.id,
        tx.ctx.organizationId,
        delta.toString(),
        kind,
        reference,
        tx.ctx.actorId,
        reason,
        tx.now,
      ],
    );
    await tx.db.query(
      'UPDATE loyalty_wallets SET balance_points=balance_points+$2,version=version+1 WHERE id=$1',
      [tx.wallet.id, delta.toString()],
    );
  }
  private async move(tx: Tx, lot: string, kind: string, points: bigint, reference: string) {
    if (points > 0n)
      await tx.db.query(
        'INSERT INTO loyalty_movements(id,wallet_id,lot_id,kind,points,reference_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), tx.wallet.id, lot, kind, points.toString(), reference, tx.now],
      );
  }
  private async lots(tx: Tx, where = 'remaining_points>0'): Promise<Lot[]> {
    return (
      await tx.db.query<Lot>(
        `SELECT * FROM loyalty_lots WHERE wallet_id=$1 AND ${where} ORDER BY sequence`,
        [tx.wallet.id],
      )
    ).rows;
  }
  private async expireLots(tx: Tx) {
    const lots = await tx.db.query<Lot>(
      'SELECT * FROM loyalty_lots WHERE wallet_id=$1 AND expires_at<=$2 AND remaining_points>held_points ORDER BY sequence',
      [tx.wallet.id, tx.now],
    );
    for (const lot of lots.rows) {
      const q = BigInt(lot.remaining_points) - BigInt(lot.held_points);
      await tx.db.query(
        'UPDATE loyalty_lots SET remaining_points=remaining_points-$2,expired_points=expired_points+$2 WHERE id=$1',
        [lot.id, q.toString()],
      );
      await this.balance(tx, -q, 'expire', lot.id, 'Approved lot expiry');
      await this.move(tx, lot.id, 'expire', q, lot.id);
    }
  }
  private async settleDebt(tx: Tx) {
    let debt = BigInt(
      (
        await tx.db.query<{ debt_points: string }>(
          'SELECT debt_points FROM loyalty_wallets WHERE id=$1',
          [tx.wallet.id],
        )
      ).rows[0]!.debt_points,
    );
    if (!debt) return;
    for (const lot of await this.lots(tx)) {
      if (lot.expires_at && lot.expires_at <= tx.now) continue;
      const q = min(debt, BigInt(lot.remaining_points) - BigInt(lot.held_points));
      if (!q) continue;
      await tx.db.query(
        'UPDATE loyalty_lots SET remaining_points=remaining_points-$2,debt_settled_points=debt_settled_points+$2 WHERE id=$1',
        [lot.id, q.toString()],
      );
      await tx.db.query('UPDATE loyalty_wallets SET debt_points=debt_points-$2 WHERE id=$1', [
        tx.wallet.id,
        q.toString(),
      ]);
      await this.move(tx, lot.id, 'settle_debt', q, tx.wallet.id);
      debt -= q;
      if (!debt) break;
    }
  }
  private async credit(
    tx: Tx,
    programId: string,
    rules: ProgramRules,
    points: bigint,
    kind: 'earn' | 'restore' | 'adjust',
    source: string,
    reason: string,
  ): Promise<string | null> {
    if (!points) return null;
    const id = randomUUID();
    const expires =
      rules.lotTtlDays === null ? null : new Date(tx.now.getTime() + rules.lotTtlDays * 86400000);
    await tx.db.query(
      'INSERT INTO loyalty_lots(id,wallet_id,organization_id,program_id,source_kind,source_id,initial_points,remaining_points,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)',
      [
        id,
        tx.wallet.id,
        tx.ctx.organizationId,
        programId,
        kind,
        source,
        points.toString(),
        expires,
        tx.now,
      ],
    );
    await this.balance(tx, points, kind, source, reason);
    await this.move(tx, id, 'credit', points, source);
    await this.settleDebt(tx);
    return id;
  }
  private async order(tx: Tx, orderId: string, programId: string) {
    // Serialize same source order even if another customer is supplied concurrently.
    await tx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'loyalty-order:' + tx.ctx.organizationId + ':' + orderId,
    ]);
    const row = (
      await tx.db.query<{ wallet_id: string; program_id: string; branch_id: string }>(
        'SELECT * FROM loyalty_order_refs WHERE organization_id=$1 AND order_id=$2',
        [tx.ctx.organizationId, orderId],
      )
    ).rows[0];
    if (row) {
      if (
        row.wallet_id !== tx.wallet.id ||
        row.program_id !== programId ||
        row.branch_id !== tx.ctx.branchId
      )
        fail('CONFLICT');
      return;
    }
    await tx.db.query(
      'INSERT INTO loyalty_order_refs(order_id,organization_id,branch_id,wallet_id,program_id) VALUES($1,$2,$3,$4,$5)',
      [orderId, tx.ctx.organizationId, tx.ctx.branchId, tx.wallet.id, programId],
    );
  }
  private async reward(
    tx: Tx,
    input: z.infer<typeof Earn> | z.infer<typeof EarnRefund>,
  ): Promise<Reward> {
    await this.order(tx, input.orderId, input.programId);
    await tx.db.query(
      'INSERT INTO loyalty_rewards(organization_id,order_id,wallet_id,program_id,original_minor) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [
        tx.ctx.organizationId,
        input.orderId,
        tx.wallet.id,
        input.programId,
        input.originalEligibleMinor,
      ],
    );
    const row = (
      await tx.db.query<Reward>(
        'SELECT * FROM loyalty_rewards WHERE organization_id=$1 AND order_id=$2',
        [tx.ctx.organizationId, input.orderId],
      )
    ).rows[0]!;
    if (row.original_minor !== input.originalEligibleMinor) fail('CONFLICT');
    return row;
  }
  createApprovedProgram(ctx: TrustedLoyaltyContext, key: string, input: z.infer<typeof Program>) {
    return this.run(
      ctx,
      key,
      'create_program',
      Program,
      input,
      ['manager'],
      async (db, c, data) => {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'loyalty-program:' + c.organizationId,
        ]);
        const old = (
          await db.query<{
            id: string;
            rules: unknown;
            approval_reference: string;
            reason: string;
            approved_by: string;
          }>('SELECT * FROM loyalty_programs WHERE organization_id=$1 AND version=$2', [
            c.organizationId,
            data.version,
          ])
        ).rows[0];
        if (old) {
          if (
            digest({
              rules: old.rules,
              approvalReference: old.approval_reference,
              reason: old.reason,
              actor: old.approved_by,
            }) !==
            digest({
              rules: data.rules,
              approvalReference: data.approvalReference,
              reason: data.reason,
              actor: c.actorId,
            })
          )
            fail('CONFLICT');
          return { programId: old.id };
        }
        const id = randomUUID();
        await db.query(
          'INSERT INTO loyalty_programs(id,organization_id,version,rules,approval_reference,reason,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            c.organizationId,
            data.version,
            data.rules,
            data.approvalReference,
            data.reason,
            c.actorId,
          ],
        );
        return { programId: id };
      },
    );
  }
  activateProgram(ctx: TrustedLoyaltyContext, key: string, input: z.infer<typeof Activate>) {
    return this.run(
      ctx,
      key,
      'activate_program',
      Activate,
      input,
      ['manager'],
      async (db, c, data) => {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'loyalty-program:' + c.organizationId,
        ]);
        if (
          !(
            await db.query('SELECT 1 FROM loyalty_programs WHERE id=$1 AND organization_id=$2', [
              data.programId,
              c.organizationId,
            ])
          ).rowCount
        )
          fail('NOT_FOUND');
        const id = randomUUID();
        await db.query(
          'INSERT INTO loyalty_activations(id,organization_id,program_id,actor_id,reason) VALUES($1,$2,$3,$4,$5)',
          [id, c.organizationId, data.programId, c.actorId, data.reason],
        );
        await db.query(
          'INSERT INTO loyalty_active_programs(organization_id,program_id) VALUES($1,$2) ON CONFLICT(organization_id) DO UPDATE SET program_id=excluded.program_id',
          [c.organizationId, data.programId],
        );
        return { programId: data.programId, activationId: id };
      },
    );
  }
  earnFulfilledOrder(ctx: TrustedLoyaltyContext, key: string, input: z.infer<typeof Earn>) {
    return this.run(ctx, key, 'earn', Earn, input, ['fulfillment'], async (db, c, data, now) => {
      const tx = await this.lockWallet(db, c, data.customerId, now),
        rules = await this.program(db, c.organizationId, data.programId),
        reward = await this.reward(tx, data);
      if (reward.fulfillment_event_id)
        return {
          orderId: data.orderId,
          awardedPoints: reward.initial_awarded_points,
          wallet: await this.snapshot(tx),
        };
      const points = earnedPoints(
        (BigInt(reward.original_minor) - BigInt(reward.refunded_minor)).toString(),
        rules,
      );
      const lot = await this.credit(
        tx,
        data.programId,
        rules,
        points,
        'earn',
        data.orderId,
        'Trusted order fulfillment',
      );
      await db.query(
        'UPDATE loyalty_rewards SET fulfillment_event_id=$3,initial_awarded_points=$4,lot_id=$5 WHERE organization_id=$1 AND order_id=$2',
        [c.organizationId, data.orderId, data.fulfillmentEventId, points.toString(), lot],
      );
      return {
        orderId: data.orderId,
        awardedPoints: points.toString(),
        wallet: await this.snapshot(tx),
      };
    });
  }
  private async revoke(
    tx: Tx,
    points: bigint,
    source: string,
    kind: 'clawback' | 'adjust',
    reason: string,
    onlyLot?: string,
  ) {
    let remaining = points,
      offset = 0n;
    const lots = onlyLot
      ? (
          await tx.db.query<Lot>('SELECT * FROM loyalty_lots WHERE id=$1 AND wallet_id=$2', [
            onlyLot,
            tx.wallet.id,
          ])
        ).rows
      : await this.lots(tx);
    for (const lot of lots) {
      if (onlyLot) {
        offset = min(
          remaining,
          BigInt(lot.expired_points) - BigInt(lot.expired_refund_offset_points),
        );
        remaining -= offset;
        await tx.db.query(
          'UPDATE loyalty_lots SET expired_refund_offset_points=expired_refund_offset_points+$2,clawed_back_points=clawed_back_points+$3 WHERE id=$1',
          [lot.id, offset.toString(), points.toString()],
        );
      }
      const free = min(remaining, BigInt(lot.remaining_points) - BigInt(lot.held_points));
      if (free) {
        await tx.db.query(
          'UPDATE loyalty_lots SET remaining_points=remaining_points-$2,revoked_points=revoked_points+$2 WHERE id=$1',
          [lot.id, free.toString()],
        );
        await this.move(tx, lot.id, 'revoke_free', free, source);
        remaining -= free;
      }
      const held = min(remaining, BigInt(lot.held_points) - BigInt(lot.pending_revocation_points));
      if (held) {
        await tx.db.query(
          'UPDATE loyalty_lots SET pending_revocation_points=pending_revocation_points+$2 WHERE id=$1',
          [lot.id, held.toString()],
        );
        await this.move(tx, lot.id, 'revoke_held', held, source);
        remaining -= held;
      }
      if (!remaining) break;
    }
    if (remaining)
      await tx.db.query('UPDATE loyalty_wallets SET debt_points=debt_points+$2 WHERE id=$1', [
        tx.wallet.id,
        remaining.toString(),
      ]);
    await this.balance(tx, -(points - offset), kind, source, reason);
    await this.settleDebt(tx);
  }
  refundEarned(ctx: TrustedLoyaltyContext, key: string, input: z.infer<typeof EarnRefund>) {
    return this.run(
      ctx,
      key,
      'refund_earned',
      EarnRefund,
      input,
      ['refund'],
      async (db, c, data, now) => {
        const tx = await this.lockWallet(db, c, data.customerId, now, true),
          rules = await this.program(db, c.organizationId, data.programId),
          reward = await this.reward(tx, data);
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'loyalty-earned-refund:' + c.organizationId + ':' + data.sourceRefundId,
        ]);
        const old = (
          await db.query<{ order_id: string; wallet_id: string; eligible_minor: string }>(
            'SELECT * FROM loyalty_earned_refunds WHERE organization_id=$1 AND source_refund_id=$2',
            [c.organizationId, data.sourceRefundId],
          )
        ).rows[0];
        if (old) {
          if (
            old.order_id !== data.orderId ||
            old.wallet_id !== tx.wallet.id ||
            old.eligible_minor !== data.eligibleRefundMinor
          )
            fail('CONFLICT');
          return { orderId: data.orderId, wallet: await this.snapshot(tx) };
        }
        const refunded = BigInt(reward.refunded_minor) + BigInt(data.eligibleRefundMinor);
        if (refunded > BigInt(reward.original_minor)) fail('REFUND_LIMIT');
        await db.query(
          'INSERT INTO loyalty_earned_refunds(organization_id,source_refund_id,order_id,wallet_id,eligible_minor) VALUES($1,$2,$3,$4,$5)',
          [
            c.organizationId,
            data.sourceRefundId,
            data.orderId,
            tx.wallet.id,
            data.eligibleRefundMinor,
          ],
        );
        if (reward.fulfillment_event_id && reward.lot_id) {
          const previous = earnedPoints(
              (BigInt(reward.original_minor) - BigInt(reward.refunded_minor)).toString(),
              rules,
            ),
            next = earnedPoints((BigInt(reward.original_minor) - refunded).toString(), rules);
          await this.revoke(
            tx,
            previous - next,
            data.sourceRefundId,
            'clawback',
            'Trusted financial refund',
            reward.lot_id,
          );
        }
        await db.query(
          'UPDATE loyalty_rewards SET refunded_minor=$3 WHERE organization_id=$1 AND order_id=$2',
          [c.organizationId, data.orderId, refunded.toString()],
        );
        return { orderId: data.orderId, wallet: await this.snapshot(tx) };
      },
    );
  }
  reserveRedemption(ctx: TrustedLoyaltyContext, key: string, input: z.infer<typeof Reserve>) {
    return this.run(ctx, key, 'reserve', Reserve, input, ['checkout'], async (db, c, data, now) => {
      const tx = await this.lockWallet(db, c, data.customerId, now),
        rules = await this.program(db, c.organizationId, data.programId, true);
      await this.order(tx, data.orderId, data.programId);
      const old = (
        await db.query<Hold>(
          'SELECT * FROM loyalty_holds WHERE organization_id=$1 AND order_id=$2',
          [c.organizationId, data.orderId],
        )
      ).rows[0];
      if (old) {
        if (old.points !== data.points || old.eligible_minor !== data.eligibleOrderMinor)
          fail('CONFLICT');
        return { holdId: old.id, state: old.state, wallet: await this.snapshot(tx) };
      }
      const q = BigInt(data.points);
      if (q > maxRedemption(data.eligibleOrderMinor, rules)) fail('INVALID');
      if (q > BigInt((await this.snapshot(tx)).availablePoints)) fail('INSUFFICIENT_POINTS');
      const id = randomUUID();
      await db.query(
        "INSERT INTO loyalty_holds(id,wallet_id,organization_id,order_id,program_id,points,eligible_minor,state) VALUES($1,$2,$3,$4,$5,$6,$7,'held')",
        [
          id,
          tx.wallet.id,
          c.organizationId,
          data.orderId,
          data.programId,
          data.points,
          data.eligibleOrderMinor,
        ],
      );
      let left = q;
      for (const lot of await this.lots(tx)) {
        const take = min(left, BigInt(lot.remaining_points) - BigInt(lot.held_points));
        if (!take) continue;
        await db.query(
          'INSERT INTO loyalty_allocations(hold_id,lot_id,wallet_id,points) VALUES($1,$2,$3,$4)',
          [id, lot.id, tx.wallet.id, take.toString()],
        );
        await db.query('UPDATE loyalty_lots SET held_points=held_points+$2 WHERE id=$1', [
          lot.id,
          take.toString(),
        ]);
        await this.move(tx, lot.id, 'hold', take, id);
        left -= take;
        if (!left) break;
      }
      if (left) fail('INSUFFICIENT_POINTS');
      await db.query(
        'UPDATE loyalty_wallets SET reserved_points=reserved_points+$2,version=version+1 WHERE id=$1',
        [tx.wallet.id, data.points],
      );
      return { holdId: id, state: 'held' as const, wallet: await this.snapshot(tx) };
    });
  }
  private async hold(tx: Tx, id: string): Promise<Hold> {
    const row = (
      await tx.db.query<Hold>(
        'SELECT * FROM loyalty_holds WHERE id=$1 AND wallet_id=$2 AND organization_id=$3',
        [id, tx.wallet.id, tx.ctx.organizationId],
      )
    ).rows[0];
    if (!row) fail('NOT_FOUND');
    if (
      !(
        await tx.db.query(
          'SELECT 1 FROM loyalty_order_refs WHERE organization_id=$1 AND order_id=$2 AND branch_id=$3',
          [tx.ctx.organizationId, row.order_id, tx.ctx.branchId],
        )
      ).rowCount
    )
      fail('FORBIDDEN');
    return row;
  }
  private async resolve(tx: Tx, hold: Hold, capture: boolean) {
    const allocations = (
      await tx.db.query<Lot & { points: string }>(
        'SELECT l.*,a.points FROM loyalty_allocations a JOIN loyalty_lots l ON l.id=a.lot_id WHERE a.hold_id=$1 ORDER BY l.sequence',
        [hold.id],
      )
    ).rows;
    for (const lot of allocations) {
      const q = BigInt(lot.points),
        revoked = min(q, BigInt(lot.pending_revocation_points));
      if (capture) {
        await tx.db.query(
          'UPDATE loyalty_lots SET held_points=held_points-$2,remaining_points=remaining_points-$2,pending_revocation_points=pending_revocation_points-$3,redeemed_points=redeemed_points+$2 WHERE id=$1',
          [lot.id, q.toString(), revoked.toString()],
        );
        if (revoked)
          await tx.db.query('UPDATE loyalty_wallets SET debt_points=debt_points+$2 WHERE id=$1', [
            tx.wallet.id,
            revoked.toString(),
          ]);
      } else
        await tx.db.query(
          'UPDATE loyalty_lots SET held_points=held_points-$2,remaining_points=remaining_points-$3,pending_revocation_points=pending_revocation_points-$3,revoked_points=revoked_points+$3 WHERE id=$1',
          [lot.id, q.toString(), revoked.toString()],
        );
      await this.move(tx, lot.id, capture ? 'capture' : 'release', q, hold.id);
    }
    await tx.db.query(
      'UPDATE loyalty_wallets SET reserved_points=reserved_points-$2,version=version+1 WHERE id=$1',
      [tx.wallet.id, hold.points],
    );
    if (capture)
      await this.balance(tx, -BigInt(hold.points), 'redeem', hold.id, 'Trusted payment capture');
    await this.expireLots(tx);
    await this.settleDebt(tx);
  }
  releaseRedemption(ctx: TrustedLoyaltyContext, key: string, input: z.infer<typeof Release>) {
    return this.run(
      ctx,
      key,
      'release',
      Release,
      input,
      ['checkout', 'refund', 'manager'],
      async (db, c, data, now) => {
        const tx = await this.lockWallet(db, c, data.customerId, now, true),
          hold = await this.hold(tx, data.holdId);
        if (hold.state === 'released') {
          if (
            hold.resolution_id !== data.resolutionReference ||
            hold.resolution_reason !== data.reason
          )
            fail('CONFLICT');
          return { holdId: hold.id, state: hold.state, wallet: await this.snapshot(tx) };
        }
        if (hold.state !== 'held') fail('CONFLICT');
        if (
          (await db.query('SELECT 1 FROM loyalty_redemption_refunds WHERE hold_id=$1', [hold.id]))
            .rowCount
        )
          fail('NOT_READY');
        await this.resolve(tx, hold, false);
        await db.query(
          "UPDATE loyalty_holds SET state='released',resolution_id=$2,resolution_reason=$3 WHERE id=$1",
          [hold.id, data.resolutionReference, data.reason],
        );
        return { holdId: hold.id, state: 'released' as const, wallet: await this.snapshot(tx) };
      },
    );
  }
  private async applyRestorations(tx: Tx, hold: Hold) {
    const rows = (
      await tx.db.query<{ source_refund_id: string; points: string }>(
        'SELECT r.* FROM loyalty_redemption_refunds r LEFT JOIN loyalty_refund_applications a USING(organization_id,source_refund_id) WHERE r.hold_id=$1 AND a.source_refund_id IS NULL ORDER BY r.source_refund_id',
        [hold.id],
      )
    ).rows;
    const rules = await this.program(tx.db, tx.ctx.organizationId, hold.program_id);
    for (const r of rows) {
      const id = await this.credit(
        tx,
        hold.program_id,
        rules,
        BigInt(r.points),
        'restore',
        r.source_refund_id,
        'Trusted redemption refund',
      );
      await tx.db.query(
        'INSERT INTO loyalty_refund_applications(organization_id,source_refund_id,lot_id) VALUES($1,$2,$3)',
        [tx.ctx.organizationId, r.source_refund_id, id],
      );
    }
  }
  captureRedemption(ctx: TrustedLoyaltyContext, key: string, input: z.infer<typeof Capture>) {
    return this.run(ctx, key, 'capture', Capture, input, ['checkout'], async (db, c, data, now) => {
      const tx = await this.lockWallet(db, c, data.customerId, now, true),
        hold = await this.hold(tx, data.holdId);
      if (hold.state === 'captured') {
        if (hold.capture_id !== data.sourceCaptureId) fail('CONFLICT');
        return { holdId: hold.id, state: hold.state, wallet: await this.snapshot(tx) };
      }
      if (hold.state !== 'held') fail('CONFLICT');
      await this.resolve(tx, hold, true);
      await db.query("UPDATE loyalty_holds SET state='captured',capture_id=$2 WHERE id=$1", [
        hold.id,
        data.sourceCaptureId,
      ]);
      await this.applyRestorations(tx, hold);
      return { holdId: hold.id, state: 'captured' as const, wallet: await this.snapshot(tx) };
    });
  }
  refundRedemption(
    ctx: TrustedLoyaltyContext,
    key: string,
    input: z.infer<typeof RedemptionRefund>,
  ) {
    return this.run(
      ctx,
      key,
      'refund_redemption',
      RedemptionRefund,
      input,
      ['refund'],
      async (db, c, data, now) => {
        const tx = await this.lockWallet(db, c, data.customerId, now, true),
          hold = await this.hold(tx, data.holdId);
        if (hold.state === 'released') fail('CONFLICT');
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'loyalty-redemption-refund:' + c.organizationId + ':' + data.sourceRefundId,
        ]);
        const old = (
          await db.query<{ hold_id: string; points: string }>(
            'SELECT * FROM loyalty_redemption_refunds WHERE organization_id=$1 AND source_refund_id=$2',
            [c.organizationId, data.sourceRefundId],
          )
        ).rows[0];
        if (old) {
          if (old.hold_id !== hold.id || old.points !== data.points) fail('CONFLICT');
          return {
            holdId: hold.id,
            pending: hold.state === 'held',
            wallet: await this.snapshot(tx),
          };
        }
        const sum = BigInt(
          (
            await db.query<{ sum: string }>(
              'SELECT coalesce(sum(points),0)::text AS sum FROM loyalty_redemption_refunds WHERE hold_id=$1',
              [hold.id],
            )
          ).rows[0]!.sum,
        );
        if (sum + BigInt(data.points) > BigInt(hold.points)) fail('REFUND_LIMIT');
        await db.query(
          'INSERT INTO loyalty_redemption_refunds(organization_id,source_refund_id,hold_id,wallet_id,points) VALUES($1,$2,$3,$4,$5)',
          [c.organizationId, data.sourceRefundId, hold.id, tx.wallet.id, data.points],
        );
        if (hold.state === 'captured') await this.applyRestorations(tx, hold);
        return { holdId: hold.id, pending: hold.state === 'held', wallet: await this.snapshot(tx) };
      },
    );
  }
  adjust(ctx: TrustedLoyaltyContext, key: string, input: z.infer<typeof Adjust>) {
    return this.run(ctx, key, 'adjust', Adjust, input, ['manager'], async (db, c, data, now) => {
      const tx = await this.lockWallet(db, c, data.customerId, now, true),
        rules = await this.program(db, c.organizationId, data.programId, true),
        q = BigInt(data.deltaPoints);
      const reference = parse(UUID, key);
      if (q > 0n) await this.credit(tx, data.programId, rules, q, 'adjust', reference, data.reason);
      else await this.revoke(tx, -q, reference, 'adjust', data.reason);
      return { wallet: await this.snapshot(tx) };
    });
  }
  expire(ctx: TrustedLoyaltyContext, key: string, customerId: string) {
    return this.run(ctx, key, 'expire', UUID, customerId, ['scheduler'], async (db, c, id, now) => {
      const tx = await this.lockWallet(db, c, id, now, true);
      return { wallet: await this.snapshot(tx) };
    });
  }
  async readWallet(context: AuthenticatedLoyaltyCustomer): Promise<WalletView | null> {
    const c = parse(Customer, context);
    return transaction(this.pool, async (db) => {
      if (
        !(
          await db.query('SELECT 1 FROM identity_customers WHERE id=$1 AND deleted_at IS NULL', [
            c.customerId,
          ])
        ).rowCount
      )
        fail('NOT_FOUND');
      const row = (
        await db.query<Wallet>(
          'SELECT * FROM loyalty_wallets WHERE organization_id=$1 AND customer_id=$2 FOR UPDATE',
          [c.organizationId, c.customerId],
        )
      ).rows[0];
      if (!row) return null;
      // Read port performs lazy expiry; actor is the authenticated customer, no branch action.
      const tx: Tx = {
        db,
        ctx: { ...c, branchId: c.organizationId, actorId: c.customerId, authority: 'scheduler' },
        wallet: row,
        now: await this.now(db),
      };
      await this.expireLots(tx);
      return this.snapshot(tx);
    });
  }
}
