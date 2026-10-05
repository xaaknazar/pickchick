import type { DatabasePool } from '@pickchick/database';
import { CommerceRepository } from './repository.js';
import { digest, type CommerceScope } from './model.js';

/** Shared presentation; repository verifies principal ownership before projections. */
export async function readCheckoutOrder(
  pool: DatabasePool,
  repository: CommerceRepository,
  scope: CommerceScope,
  orderId: string,
  walletsEnabled = false,
) {
  // Ownership is checked before consulting any provider/fulfillment projection.
  const order = await repository.readOrder(scope, orderId);
  const [invoice, projection, branch, method, hosted] = await Promise.all([
    pool.query<{ state: string; operation_id: string | null; expires_at: Date | null }>(
      'SELECT state,operation_id,expires_at FROM commerce_kaspi_invoices WHERE order_id=$1 ORDER BY issue_started_at DESC LIMIT 1',
      [orderId],
    ),
    pool.query<{
      state: string;
      display_number: string | null;
      observed_at: Date;
      assembly: boolean;
    }>(
      `SELECT p.state,p.display_number::text,p.observed_at,
          EXISTS(SELECT 1 FROM cloud_fulfillment_observed_tasks t WHERE t.order_id=p.order_id
          AND t.station_id=p.assembly_station_id AND t.state IN ('in_progress','done')) assembly
         FROM cloud_fulfillment_projection p WHERE p.order_id=$1`,
      [orderId],
    ),
    pool.query<{ name: string }>('SELECT name FROM branches WHERE id=$1', [scope.branchId]),
    walletsEnabled
      ? pool.query<{ method: 'kaspi' | 'card' | 'apple_pay' | 'google_pay' }>(
          'SELECT method FROM commerce_checkout_payment_methods WHERE order_id=$1',
          [orderId],
        )
      : Promise.resolve({ rows: [] }),
    walletsEnabled
      ? pool.query<{ expires_at: Date }>(
          'SELECT expires_at FROM commerce_tiptoppay_sessions WHERE order_id=$1',
          [orderId],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const bank = invoice.rows[0],
    kitchen = projection.rows[0];
  const paid = order.money.captured === order.totalMinor && order.money.refunded === '0';
  const phase =
    order.attentionRequired ||
    (BigInt(order.money.captured) > 0n && !paid) ||
    BigInt(order.money.refunded) > 0n ||
    ['cancel_requested', 'cancelled', 'released'].includes(kitchen?.state ?? '')
      ? 'attention'
      : paid
        ? kitchen?.state === 'handed_over'
          ? 'handed_over'
          : kitchen?.state === 'ready'
            ? 'ready'
            : ['accepted', 'in_production'].includes(kitchen?.state ?? '')
              ? 'preparing'
              : 'paid'
        : bank?.state === 'unknown' ||
            order.attempts.some((a) => a.state === 'unknown') ||
            (hosted.rows[0] && hosted.rows[0].expires_at.getTime() <= Date.now())
          ? 'checking'
          : bank?.state === 'failed' || order.attempts.some((a) => a.state === 'failed')
            ? 'failed'
            : bank?.state === 'issued' && bank.operation_id
              ? 'awaiting_payment'
              : hosted.rows.length
                ? 'awaiting_payment'
                : order.attempts.length
                  ? 'sending'
                  : order.state === 'awaiting_payment'
                    ? 'ready_to_pay'
                    : 'awaiting_restaurant';
  const sale = order.fiscalDocuments.find((d) => d.kind === 'sale' && d.state === 'issued');
  // Receipt URLs are intentionally omitted until a dedicated fiscal adapter exposes a verified receipt.
  const body = {
    orderId,
    paymentMethod: method.rows[0]?.method ?? 'kaspi',
    branchId: scope.branchId,
    createdAt: order.createdAt,
    updatedAt: kitchen?.observed_at.toISOString() ?? order.updatedAt,
    kitchenStage:
      paid && phase === 'preparing' ? (kitchen?.assembly ? 'assembly' : 'cooking') : null,
    restaurant: branch.rows[0]?.name ?? 'PickChick',
    displayNumber: kitchen?.display_number ?? null,
    totalMinor: order.totalMinor,
    serviceMode: order.snapshot.serviceMode as 'takeaway' | 'dine_in',
    kitchenComment:
      typeof order.snapshot.kitchenComment === 'string' ? order.snapshot.kitchenComment : null,
    phase,
    expiresAt: bank?.expires_at?.toISOString() ?? hosted.rows[0]?.expires_at.toISOString() ?? null,
    receipt: sale ? 'issued' : order.fiscalPolicy === 'deferred_pilot' ? 'deferred' : 'pending',
    receiptUrl: null,
    items: (
      order.snapshot.lines as {
        productId: string;
        title: string;
        quantity: number;
        totalMinor: string;
        selectedDetails?: { modifiers?: { label: { ru: string }; quantity: number }[] };
      }[]
    ).map((line) => ({
      productId: line.productId,
      title: line.title,
      quantity: line.quantity,
      totalMinor: line.totalMinor,
      modifiers:
        line.selectedDetails?.modifiers?.map(
          (m) => `${m.label.ru}${m.quantity > 1 ? ` × ${m.quantity}` : ''}`,
        ) ?? [],
    })),
  };
  return { ...body, revision: digest(body) };
}
