import { randomUUID } from 'node:crypto';
import {
  CartSchema,
  QuoteSchema,
  LocalOrderSchema,
  CreateLocalOrderSchema,
  CancelLocalOrderSchema,
  OrderingCommandSchema,
  OrderingStateSchema,
  StopCommandSchema,
  StopStateSchema,
  MenuSnapshotSchema,
  UuidSchema,
  EventEnvelopeSchema,
  LocalOrderListSchema,
} from '@pickchick/contracts';
import type { StaffSession, LocalOrder } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { authenticateStaff, requirePermission, audit } from './staff.js';
import type { StaffAuth } from './staff.js';
import { OrderError } from './errors.js';
import { priceCart } from './pricing.js';
import { command, lockBranch } from './commands.js';
import { requireOpenCashShift, loadCashShift } from './shifts.js';

async function activeMenu(client: DatabaseClient, branchId: string) {
  const result = await client.query(
    `SELECT s.payload FROM active_menu a JOIN menu_snapshots s
    ON s.id = a.release_id AND s.branch_id = a.branch_id WHERE a.branch_id = $1`,
    [branchId],
  );
  if (!result.rows[0]) throw new OrderError('BRANCH_UNAVAILABLE');
  return MenuSnapshotSchema.parse(result.rows[0].payload);
}
async function checkStops(client: DatabaseClient, branchId: string, variants: string[]) {
  const stopped = await client.query(
    'SELECT 1 FROM local_stops WHERE branch_id = $1 AND variant_id = ANY($2::uuid[]) AND stopped LIMIT 1',
    [branchId, variants],
  );
  if (stopped.rowCount) throw new OrderError('ITEM_STOPPED');
}

export async function createQuote(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  input: unknown,
) {
  const parsed = CartSchema.safeParse(input);
  if (!parsed.success) throw new OrderError('INVALID_REQUEST');
  const cart = parsed.data;
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'checkout');
    const branch = await lockBranch(client, branchId);
    if (!branch.ordering_enabled) throw new OrderError('BRANCH_UNAVAILABLE');
    const menu = await activeMenu(client, branchId);
    const pricing = priceCart(menu, cart);
    await checkStops(
      client,
      branchId,
      cart.items.map((item) => item.variant_id),
    );
    const time = (await client.query('SELECT clock_timestamp() AS time')).rows[0].time as Date;
    const quote = QuoteSchema.parse({
      quote_id: randomUUID(),
      branch_id: branchId,
      release_id: menu.release_id,
      menu_version: menu.version,
      service_mode: cart.service_mode,
      channel: 'pos',
      ...pricing,
      created_at: time.toISOString(),
      expires_at: new Date(time.getTime() + 300000).toISOString(),
    });
    await client.query(
      `INSERT INTO checkout_quotes(id,branch_id,staff_id,terminal_id,release_id,total_minor,snapshot,created_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        quote.quote_id,
        branchId,
        actor.staff_id,
        actor.terminal_id,
        quote.release_id,
        quote.total_minor,
        quote,
        quote.created_at,
        quote.expires_at,
      ],
    );
    return quote;
  });
}

async function loadOrder(
  client: DatabaseClient,
  branchId: string,
  actor: StaffSession,
  id: string,
): Promise<LocalOrder> {
  const result = await client.query(
    `SELECT o.*,q.staff_id,q.terminal_id,q.snapshot FROM local_orders o
    JOIN checkout_quotes q ON q.id=o.quote_id WHERE o.id=$1 AND o.branch_id=$2`,
    [id, branchId],
  );
  const row = result.rows[0];
  if (
    !row ||
    (actor.role !== 'shift_manager' &&
      (row.staff_id !== actor.staff_id || row.terminal_id !== actor.terminal_id))
  )
    throw new OrderError('NOT_FOUND');
  return LocalOrderSchema.parse({
    order_id: row.id,
    branch_id: row.branch_id,
    quote_id: row.quote_id,
    version: row.version,
    state: row.state,
    payment_state: row.payment_state,
    fiscal_state: row.fiscal_state,
    fulfillment_state: row.fulfillment_state,
    next_action: row.state === 'cancelled' ? 'none' : 'payment_not_available',
    snapshot: row.snapshot,
    created_at: row.created_at.toISOString(),
    cancellation_reason: row.cancellation_reason,
    ...(row.cash_shift_id ? { cash_shift_id: row.cash_shift_id } : {}),
  });
}

async function orderEvent(
  client: DatabaseClient,
  order: LocalOrder,
  type: 'order.created' | 'order.cancelled',
) {
  await client.query(
    'INSERT INTO local_order_streams(branch_id,producer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [order.branch_id, randomUUID()],
  );
  const stream = (
    await client.query(
      'UPDATE local_order_streams SET last_sequence=last_sequence+1 WHERE branch_id=$1 RETURNING *',
      [order.branch_id],
    )
  ).rows[0];
  const event = EventEnvelopeSchema.parse({
    event_id: randomUUID(),
    producer_id: stream.producer_id,
    producer_sequence: stream.last_sequence,
    aggregate_type: 'order_commercial',
    aggregate_id: order.order_id,
    aggregate_version: order.version,
    event_type: type,
    schema_version: 1,
    branch_id: order.branch_id,
    occurred_at: new Date().toISOString(),
    correlation_id: order.order_id,
    causation_id: null,
    payload: {
      order_id: order.order_id,
      quote_id: order.quote_id,
      state: order.state,
      payment_state: order.payment_state,
      fulfillment_state: order.fulfillment_state,
      total_minor: order.snapshot.total_minor,
      currency: 'KZT',
      channel: 'pos',
      service_mode: order.snapshot.service_mode,
      snapshot: order.snapshot,
    },
  });
  await client.query(
    `INSERT INTO outbox_events(event_id,producer_id,producer_sequence,branch_id,aggregate_type,aggregate_id,
    aggregate_version,schema_version,event_type,payload,occurred_at,correlation_id,causation_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,NULL)`,
    [
      event.event_id,
      event.producer_id,
      event.producer_sequence,
      event.branch_id,
      event.aggregate_type,
      event.aggregate_id,
      event.aggregate_version,
      event.event_type,
      event.payload,
      event.occurred_at,
      event.correlation_id,
    ],
  );
}

export async function createLocalOrder(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  key: string,
  input: unknown,
) {
  const parsed = CreateLocalOrderSchema.safeParse(input);
  if (!parsed.success) throw new OrderError('INVALID_REQUEST');
  return command(
    pool,
    branchId,
    auth,
    'checkout',
    'order.create',
    key,
    parsed.data,
    async (client, actor, branch) => {
      const row = (
        await client.query(
          `SELECT *, expires_at > clock_timestamp() AS valid FROM checkout_quotes
      WHERE id=$1 AND branch_id=$2 AND staff_id=$3 AND terminal_id=$4`,
          [parsed.data.quote_id, branchId, actor.staff_id, actor.terminal_id],
        )
      ).rows[0];
      if (!row) throw new OrderError('NOT_FOUND');
      if ((await client.query('SELECT 1 FROM local_orders WHERE quote_id=$1', [row.id])).rowCount)
        throw new OrderError('CONFLICT');
      if (!row.valid) throw new OrderError('QUOTE_EXPIRED');
      if (!branch.ordering_enabled) throw new OrderError('BRANCH_UNAVAILABLE');
      const menu = await activeMenu(client, branchId);
      if (menu.release_id !== row.release_id) throw new OrderError('MENU_CHANGED');
      const quote = QuoteSchema.parse(row.snapshot);
      await checkStops(
        client,
        branchId,
        quote.lines.map((item) => item.variant_id),
      );
      const shift = await requireOpenCashShift(client, branchId, actor);
      const shiftTotal = (
        await client.query(
          'SELECT coalesce(sum(total_minor),0)::text AS total FROM local_orders WHERE cash_shift_id=$1 AND branch_id=$2',
          [shift.id, branchId],
        )
      ).rows[0].total;
      if (BigInt(shiftTotal) + BigInt(quote.total_minor) > 9223372036854775807n)
        throw new OrderError('INVALID_REQUEST');
      const orderId = randomUUID();
      await client.query(
        'INSERT INTO local_orders(id,branch_id,quote_id,total_minor,cash_shift_id) VALUES ($1,$2,$3,$4,$5)',
        [orderId, branchId, quote.quote_id, quote.total_minor, shift.id],
      );
      const order = await loadOrder(client, branchId, actor, orderId);
      await orderEvent(client, order, 'order.created');
      await audit(client, branchId, actor.staff_id, 'order.created', orderId);
      return order;
    },
  );
}

export function readLocalOrder(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  orderId: string,
) {
  if (!UuidSchema.safeParse(orderId).success) throw new OrderError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    return loadOrder(client, branchId, actor, orderId);
  });
}

export function cancelLocalOrder(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  key: string,
  orderId: string,
  input: unknown,
) {
  const parsed = CancelLocalOrderSchema.safeParse(input);
  if (!parsed.success || !UuidSchema.safeParse(orderId).success)
    throw new OrderError('INVALID_REQUEST');
  return command(
    pool,
    branchId,
    auth,
    'checkout',
    'order.cancel',
    key,
    { order_id: orderId, ...parsed.data },
    async (client, actor) => {
      const old = await loadOrder(client, branchId, actor, orderId);
      if (old.version !== parsed.data.expected_version || old.state !== 'awaiting_payment')
        throw new OrderError('CONFLICT');
      await client.query(
        "UPDATE local_orders SET state='cancelled',version=version+1,cancellation_reason=$2 WHERE id=$1",
        [orderId, parsed.data.reason],
      );
      const order = await loadOrder(client, branchId, actor, orderId);
      await orderEvent(client, order, 'order.cancelled');
      await audit(client, branchId, actor.staff_id, 'order.cancelled', orderId);
      return order;
    },
  );
}

export function setOrdering(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  key: string,
  enabled: boolean,
  input: unknown,
) {
  const parsed = OrderingCommandSchema.safeParse(input);
  if (!parsed.success) throw new OrderError('INVALID_REQUEST');
  return command(
    pool,
    branchId,
    auth,
    'manage',
    'ordering.set',
    key,
    { ...parsed.data, enabled },
    async (client, actor, branch) => {
      if (branch.ordering_version !== parsed.data.expected_version)
        throw new OrderError('CONFLICT');
      if (enabled) await activeMenu(client, branchId);
      const result = await client.query(
        `UPDATE branch_config SET ordering_enabled=$2,ordering_version=ordering_version+1
      WHERE id=$1 RETURNING id AS branch_id,ordering_enabled,ordering_version AS version`,
        [branchId, enabled],
      );
      await audit(
        client,
        branchId,
        actor.staff_id,
        enabled ? 'ordering.opened' : 'ordering.closed',
        branchId,
      );
      return OrderingStateSchema.parse(result.rows[0]);
    },
  );
}
export function readOrdering(pool: DatabasePool, branchId: string, auth: StaffAuth) {
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    const row = (
      await client.query(
        'SELECT id AS branch_id,ordering_enabled,ordering_version AS version FROM branch_config WHERE id=$1',
        [branchId],
      )
    ).rows[0];
    return OrderingStateSchema.parse(row);
  });
}
export function setStop(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  key: string,
  input: unknown,
) {
  const parsed = StopCommandSchema.safeParse(input);
  if (!parsed.success) throw new OrderError('INVALID_REQUEST');
  const stop = parsed.data;
  return command(
    pool,
    branchId,
    auth,
    'manage',
    'availability.stop',
    key,
    stop,
    async (client, actor) => {
      const menu = await activeMenu(client, branchId);
      if (!menu.items.some((item) => item.variant_id === stop.variant_id))
        throw new OrderError('NOT_FOUND');
      const old = (
        await client.query('SELECT version FROM local_stops WHERE branch_id=$1 AND variant_id=$2', [
          branchId,
          stop.variant_id,
        ])
      ).rows[0];
      if ((old?.version ?? 0) !== stop.expected_version) throw new OrderError('CONFLICT');
      const result = await client.query(
        `INSERT INTO local_stops(branch_id,variant_id,stopped,version,reason) VALUES ($1,$2,$3,1,$4)
      ON CONFLICT(branch_id,variant_id) DO UPDATE SET stopped=EXCLUDED.stopped,version=local_stops.version+1,reason=EXCLUDED.reason
      RETURNING variant_id,stopped,version`,
        [branchId, stop.variant_id, stop.stopped, stop.reason],
      );
      await audit(client, branchId, actor.staff_id, 'availability.changed', stop.variant_id);
      return StopStateSchema.parse(result.rows[0]);
    },
  );
}

export function readStop(pool: DatabasePool, branchId: string, auth: StaffAuth, variantId: string) {
  if (!UuidSchema.safeParse(variantId).success) throw new OrderError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    const menu = await activeMenu(client, branchId);
    if (!menu.items.some((item) => item.variant_id === variantId))
      throw new OrderError('NOT_FOUND');
    const result = await client.query(
      'SELECT variant_id, stopped, version FROM local_stops WHERE branch_id=$1 AND variant_id=$2',
      [branchId, variantId],
    );
    return StopStateSchema.parse(
      result.rows[0] ?? { variant_id: variantId, stopped: false, version: 0 },
    );
  });
}

export function listLocalOrders(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  shiftId?: string,
) {
  if (shiftId !== undefined && !UuidSchema.safeParse(shiftId).success)
    throw new OrderError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    await lockBranch(client, branchId);
    if (shiftId) await loadCashShift(client, branchId, actor, shiftId);
    const rows = await client.query(
      `SELECT o.id FROM local_orders o JOIN checkout_quotes q ON q.id=o.quote_id
      WHERE o.branch_id=$1 AND ($2::boolean OR (q.staff_id=$3 AND q.terminal_id=$4))
      AND ($5::uuid IS NULL OR o.cash_shift_id=$5) ORDER BY o.created_at DESC,o.id DESC LIMIT 100`,
      [
        branchId,
        actor.role === 'shift_manager',
        actor.staff_id,
        actor.terminal_id,
        shiftId ?? null,
      ],
    );
    const orders = [];
    for (const row of rows.rows) orders.push(await loadOrder(client, branchId, actor, row.id));
    const time = (await client.query('SELECT clock_timestamp() AS time')).rows[0].time;
    return LocalOrderListSchema.parse({ orders, server_time: time.toISOString() });
  });
}
