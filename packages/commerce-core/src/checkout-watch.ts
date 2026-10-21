import type { DatabasePool } from '@pickchick/database';

type Db = Pick<DatabasePool, 'query'>;

/**
 * Customer order long-poll (audit 2.8). A full `CustomerCheckout.read()` costs about twenty
 * statements and a row lock on the order; repeating it every 500 ms per open screen made idle
 * watchers the main database load. The watch now compares a cheap mark and reads the full
 * view only when the mark moves.
 *
 * The mark covers every row `readCheckoutOrder()` and the head-guard check derive the view
 * from. Each long-poll still starts with a full read, so an input missing here could delay an
 * update by at most one poll window (20 s), never lose it.
 */
const CLOUD_TABLES = ['cloud_channel_orders', 'cloud_kitchen_orders', 'cloud_kitchen_tasks'];

/** Same guard as cloud-channel.ts: old schema or a narrow role means edge orders only. */
export async function checkoutWatchCloudTables(db: Db): Promise<boolean> {
  return (
    (
      await db.query<{ readable: boolean }>(
        `SELECT bool_and(CASE WHEN to_regclass(t) IS NULL THEN false ELSE has_table_privilege(t,'SELECT') END) AS readable
        FROM unnest($1::text[]) t`,
        [CLOUD_TABLES],
      )
    ).rows[0]?.readable === true
  );
}

const part = (sql: string) => `coalesce((${sql}),'-')`;
const EDGE_PARTS = [
  `SELECT concat(o.version,':',o.state,':',o.attention_required,':',o.updated_at) FROM commerce_orders o WHERE o.id=$1::uuid`,
  `SELECT string_agg(concat(a.id,':',a.state),',' ORDER BY a.id) FROM commerce_payment_attempts a WHERE a.order_id=$1::uuid`,
  `SELECT string_agg(concat(c.id,':',c.amount_minor),',' ORDER BY c.id) FROM commerce_captures c WHERE c.order_id=$1::uuid`,
  `SELECT string_agg(concat(r.id,':',r.state),',' ORDER BY r.id) FROM commerce_refunds r WHERE r.order_id=$1::uuid`,
  `SELECT string_agg(concat(e.id,':',e.amount_minor),',' ORDER BY e.id) FROM commerce_refund_effects e WHERE e.order_id=$1::uuid`,
  `SELECT string_agg(concat(f.id,':',f.state),',' ORDER BY f.id) FROM commerce_fiscal_documents f WHERE f.order_id=$1::uuid`,
  `SELECT string_agg(concat(k.attempt_id,':',k.state,':',k.operation_id,':',k.expires_at,':',k.issue_started_at),',' ORDER BY k.attempt_id) FROM commerce_kaspi_invoices k WHERE k.order_id=$1::uuid`,
  `SELECT concat(p.version,':',p.state,':',p.display_number,':',p.observed_at,':',p.assembly_station_id) FROM cloud_fulfillment_projection p WHERE p.order_id=$1::uuid`,
  `SELECT string_agg(concat(t.task_id,':',t.station_id,':',t.version,':',t.state),',' ORDER BY t.task_id) FROM cloud_fulfillment_observed_tasks t WHERE t.order_id=$1::uuid`,
  `SELECT string_agg(concat(i.id,':',i.state,':',i.reason,':',i.updated_at),',' ORDER BY i.id) FROM commerce_cancellation_intents i WHERE i.order_id=$1::uuid`,
];
const CLOUD_PARTS = [
  `SELECT concat(co.version,':',co.state,':',co.display_number,':',co.updated_at,':',co.assembly_station_id) FROM cloud_kitchen_orders co WHERE co.order_id=$1::uuid`,
  `SELECT string_agg(concat(ct.id,':',ct.station_id,':',ct.version,':',ct.state),',' ORDER BY ct.id) FROM cloud_kitchen_tasks ct WHERE ct.order_id=$1::uuid`,
  `SELECT concat(cc.channel,':',cc.fiscal_status) FROM cloud_channel_orders cc WHERE cc.order_id=$1::uuid`,
];
const markSql = (cloud: boolean) =>
  `SELECT md5(concat_ws('|',${[...EDGE_PARTS, ...(cloud ? CLOUD_PARTS : [])].map(part).join(',')})) AS mark`;
const EDGE_SQL = markSql(false),
  CLOUD_SQL = markSql(true);

/** One statement, no locks. Equal marks: the customer view of this order is unchanged. */
export async function checkoutOrderMark(db: Db, orderId: string, cloud: boolean) {
  return (await db.query<{ mark: string }>(cloud ? CLOUD_SQL : EDGE_SQL, [orderId])).rows[0]!.mark;
}

/**
 * Waits until the order revision differs from `after`, the deadline passes or the client
 * leaves. The mark is taken before each full read, so a change committed between the two is
 * either in that read or moves the next mark.
 */
export async function watchCheckoutOrder<T extends { revision: string }>(options: {
  after: string;
  deadline: number;
  read(): Promise<T>;
  mark(): Promise<string>;
  stopped(): boolean;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = Math.max(1000, options.intervalMs ?? 1000);
  let mark = await options.mark();
  let order = await options.read();
  while (!options.stopped() && order.revision === options.after && now() < options.deadline) {
    await sleep(Math.min(interval, Math.max(0, options.deadline - now())));
    if (options.stopped()) break;
    const next = await options.mark();
    if (next === mark) continue;
    mark = next;
    order = await options.read();
  }
  return order;
}
