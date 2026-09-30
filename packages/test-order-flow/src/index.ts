import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import { testCatalog } from './catalog.js';
import { testCompleteCatalog } from './complete-catalog.js';
import {
  TEST_BRANCH_ID,
  TEST_CATALOG_VERSION,
  TEST_COMPLETE_CATALOG_VERSION,
  TestCatalogVersionSchema,
  TestCompleteLineSchema,
  type TestSelection,
  testLineId,
  TEST_NAMESPACE,
  TEST_ACCESS_NO_EXPIRY,
  TestActorSchema,
  TestCancellationSchema,
  TestCartSchema,
  TestCreateOrderSchema,
  TestCompleteTaskSchema,
  TestDisplaySchema,
  TestKitchenSchema,
  TestOrderSchema,
  TestOrdersSchema,
  TestComboProgressSchema,
  TestFeedbackInputSchema,
  TestFeedbackSchema,
  TestHistorySchema,
  TestPaymentSchema,
  TestQuoteSchema,
  TestResolvePaymentSchema,
  TestRoleSchema,
  TestSessionInputSchema,
  TestContinueSessionInputSchema,
  TestSessionSchema,
  TestVersionSchema,
  TestServiceShiftCurrentSchema,
  TestServiceShiftChangeSchema,
  type TestOrder,
  type TestRole,
} from './contracts.js';
export * from './contracts.js';
export { testCatalog, testCompleteCatalog };
export * from './representation.js';

export interface TestFlowConfig {
  enabled: boolean;
  environment: string;
  customerAuthEnabled?: boolean;
}
export type TestFlowErrorCode =
  | 'DISABLED'
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'QUOTE_EXPIRED'
  | 'RATE_LIMITED'
  | 'SHIFT_CLOSED'
  | 'BRANCH_UNAVAILABLE';
export class TestFlowError extends Error {
  constructor(readonly code: TestFlowErrorCode) {
    super(code);
    this.name = 'TestFlowError';
  }
}
function priceCompleteLine(item: {
  product_id: string;
  quantity: number;
  selections: TestSelection[];
}) {
  const product = testCompleteCatalog.products.find(
    (candidate) => candidate.id === item.product_id,
  );
  if (!product) throw new TestFlowError('INVALID_REQUEST');
  const selections = item.selections
    .map((selection) => {
      const group = product.modifier_groups.find(
        (candidate) => candidate.id === selection.group_id,
      );
      const option = group?.options.find((candidate) => candidate.id === selection.option_id);
      if (!group || !option || !option.available || selection.quantity > option.max_quantity)
        throw new TestFlowError('INVALID_REQUEST');
      return {
        ...selection,
        group_label: group.title,
        option_label: option.label,
        price_delta_minor: option.price_delta_minor,
      };
    })
    .sort((left, right) =>
      `${left.group_id}:${left.option_id}`.localeCompare(`${right.group_id}:${right.option_id}`),
    );
  for (const group of product.modifier_groups) {
    const quantity = selections
      .filter((selection) => selection.group_id === group.id)
      .reduce((total, selection) => total + selection.quantity, 0);
    if (quantity < group.min || quantity > group.max) throw new TestFlowError('INVALID_REQUEST');
  }
  const unit = selections.reduce(
    (total, selection) => total + BigInt(selection.price_delta_minor) * BigInt(selection.quantity),
    BigInt(product.price_minor),
  );
  return TestCompleteLineSchema.parse({
    id: product.id,
    name: product.name,
    description: product.description,
    category: product.category,
    image_id: product.image_id,
    prep_required: product.prep_required,
    serving_label: product.serving_label,
    nutrition: product.nutrition,
    nutrition_provenance: product.nutrition_provenance,
    line_id: testLineId(product.id, selections),
    base_price_minor: product.price_minor,
    price_minor: unit.toString(),
    quantity: item.quantity,
    line_total_minor: (unit * BigInt(item.quantity)).toString(),
    selections,
  });
}
function estimatePreparation(items: { product_id: string; quantity: number }[]) {
  const baseline = Math.max(
    ...items.map(
      (item) =>
        testCompleteCatalog.products.find((product) => product.id === item.product_id)
          ?.prep_minutes ?? 1,
    ),
  );
  const quantity = items.reduce((total, item) => total + item.quantity, 0);
  // The source's estimate is retained as a demonstration, bounded independently
  // of real kitchen admission/capacity (which this TEST namespace does not model).
  const minutes = Math.min(120, Math.ceil(baseline + (quantity - 1) * 1.2));
  return { min: minutes, max: minutes };
}
function kitchenLineTitle(line: TestOrder['snapshot']['lines'][number]) {
  const choices =
    'selections' in line
      ? line.selections
          .map(
            (selection) =>
              `${selection.group_label}: ${selection.option_label} × ${selection.quantity}`,
          )
          .join('; ')
      : '';
  return `${line.name} × ${line.quantity}${choices ? ` - ${choices}` : ''}`;
}
const synthetic = { synthetic: true as const, namespace: TEST_NAMESPACE };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const id = (value: string) => {
  if (!z.uuid().safeParse(value).success) throw new TestFlowError('INVALID_REQUEST');
  return value;
};
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TestFlowError('INVALID_REQUEST');
  return result.data;
}
function enabled(config: TestFlowConfig) {
  if (!config.enabled || !['local', 'test', 'staging'].includes(config.environment))
    throw new TestFlowError('DISABLED');
}
interface Actor {
  id: string;
  role: TestRole;
  branch_id: string;
  channel: 'mobile' | 'kiosk' | null;
}
function accessExpiry(value: Date | number | undefined): string {
  // node-postgres represents a timestamptz infinity as Number.POSITIVE_INFINITY.
  if (value === Number.POSITIVE_INFINITY) return TEST_ACCESS_NO_EXPIRY;
  if (value instanceof Date) return value.toISOString();
  throw new Error('Invalid TEST access expiry');
}
async function identityOwner(client: DatabaseClient, token: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new TestFlowError('UNAUTHORIZED');
  const row = (
    await client.query<{ customer_id: string }>(
      `SELECT s.customer_id FROM identity_sessions s JOIN identity_customers c ON c.id=s.customer_id
     WHERE s.access_hash=$1 AND s.revoked_at IS NULL AND s.access_expires_at>clock_timestamp()
       AND c.deleted_at IS NULL FOR SHARE OF s,c`,
      [hash(token)],
    )
  ).rows[0];
  if (!row) throw new TestFlowError('UNAUTHORIZED');
  return row.customer_id;
}
async function authenticate(
  client: DatabaseClient,
  token: string,
  roles: TestRole[],
  customerAuthEnabled = false,
): Promise<Actor> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new TestFlowError('UNAUTHORIZED');
  let actor = (
    await client.query<Actor>(
      'SELECT id,role,branch_id,channel FROM test_actors WHERE token_hash=$1 AND expires_at>clock_timestamp() AND revoked_at IS NULL',
      [hash(token)],
    )
  ).rows[0];
  if (customerAuthEnabled && actor?.role === 'customer' && actor.channel === 'mobile')
    throw new TestFlowError('UNAUTHORIZED');
  if (!actor && customerAuthEnabled) {
    const customerId = await identityOwner(client, token);
    actor = (
      await client.query<Actor>(
        `SELECT a.id,a.role,a.branch_id,a.channel FROM identity_customer_test_actors m
       JOIN test_actors a ON a.id=m.actor_id WHERE m.customer_id=$1
       AND a.role='customer' AND a.channel='mobile' AND a.branch_id=$2
       AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()`,
        [customerId, TEST_BRANCH_ID],
      )
    ).rows[0];
  }
  if (!actor) throw new TestFlowError('UNAUTHORIZED');
  if (!roles.includes(actor.role)) throw new TestFlowError('FORBIDDEN');
  return actor;
}
async function lockFlow(client: DatabaseClient) {
  await client.query('SELECT id FROM test_flow_lock WHERE id=true FOR UPDATE');
}
async function checkBranch(client: DatabaseClient) {
  if (
    !(
      await client.query(
        "SELECT 1 FROM branches WHERE id=$1 AND code='TEST-ALMATY-01' AND ordering_enabled=false",
        [TEST_BRANCH_ID],
      )
    ).rowCount
  )
    throw new TestFlowError('BRANCH_UNAVAILABLE');
}
async function prune(client: DatabaseClient) {
  // All FK cascades stay within the explicitly disposable test namespace.
  return (
    (
      await client.query(
        "DELETE FROM test_actors WHERE expires_at<clock_timestamp()-interval '7 days' OR revoked_at<clock_timestamp()-interval '7 days'",
      )
    ).rowCount ?? 0
  );
}
export async function cleanupTestFlow(pool: DatabasePool, config: TestFlowConfig) {
  enabled(config);
  return transaction(pool, async (client) => {
    await lockFlow(client);
    return { ...synthetic, removed_actors: await prune(client) };
  });
}
export async function provisionTestActor(
  pool: DatabasePool,
  config: TestFlowConfig,
  role: unknown,
) {
  enabled(config);
  const validRole = parse(TestRoleSchema.exclude(['customer']), role);
  return transaction(pool, async (client) => {
    await lockFlow(client);
    await checkBranch(client);
    await prune(client);
    const count = (
      await client.query<{ count: string }>(
        "SELECT count(*) FROM test_actors WHERE role<>'customer' AND expires_at>clock_timestamp() AND revoked_at IS NULL",
      )
    ).rows[0];
    if (Number(count?.count) >= 20) throw new TestFlowError('RATE_LIMITED');
    const token = randomBytes(32).toString('hex');
    const row = (
      await client.query<{ id: string; expires_at: Date | number }>(
        "INSERT INTO test_actors(id,branch_id,token_hash,role,expires_at) VALUES ($1,$2,$3,$4,'infinity') RETURNING id,expires_at",
        [randomUUID(), TEST_BRANCH_ID, hash(token), validRole],
      )
    ).rows[0];
    return TestActorSchema.parse({
      ...synthetic,
      actor_id: row?.id,
      token,
      role: validRole,
      branch_id: TEST_BRANCH_ID,
      expires_at: accessExpiry(row?.expires_at),
    });
  });
}
export async function revokeTestActor(pool: DatabasePool, config: TestFlowConfig, actorId: string) {
  enabled(config);
  id(actorId);
  return transaction(pool, async (client) => {
    await lockFlow(client);
    await client.query('UPDATE test_actors SET revoked_at=clock_timestamp() WHERE id=$1', [
      actorId,
    ]);
    return { ...synthetic, revoked: true };
  });
}

const orderSelect = `SELECT o.*, 'T-' || lpad(o.sequence::text,GREATEST(length(o.sequence::text),6),'0') AS number,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('task_id',t.id,'station',t.station,'title',t.title,'state',t.state,'mandatory',t.mandatory)
  ORDER BY t.station DESC,t.task_key) FROM test_kitchen_tasks t WHERE t.order_id=o.id),'[]'::jsonb) AS tasks FROM test_orders o`;
function projectOrder(row: Record<string, unknown>): TestOrder {
  if (!(row.created_at instanceof Date) || !(row.updated_at instanceof Date))
    throw new Error('Invalid database timestamps');
  return TestOrderSchema.parse({
    ...synthetic,
    order_id: row.id,
    number: row.number,
    branch_id: row.branch_id,
    version: row.version,
    state: row.state,
    payment_state: row.payment_state,
    payment_attempt_id: row.payment_attempt_id,
    fiscal_state: 'not_applicable',
    snapshot: row.snapshot,
    tasks: row.tasks,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    cancellation_reason: row.cancellation_reason,
  });
}
async function loadOrder(
  client: DatabaseClient,
  actor: Actor,
  orderId: string,
  lock = false,
): Promise<TestOrder> {
  const row = (
    await client.query<Record<string, unknown>>(
      `${orderSelect} WHERE o.id=$1 AND o.branch_id=$2 ${lock ? 'FOR UPDATE OF o' : ''}`,
      [orderId, actor.branch_id],
    )
  ).rows[0];
  if (!row || (actor.role === 'customer' && row.actor_id !== actor.id))
    throw new TestFlowError('NOT_FOUND');
  return projectOrder(row);
}
async function emit(client: DatabaseClient, order: TestOrder, event: string) {
  // PostgreSQL delivers this hint only after COMMIT. Outbox/database remain the truth.
  await client.query("SELECT pg_notify('pickchick_test_orders', $1)", [order.order_id]);
  await client.query(
    'INSERT INTO test_outbox(id,order_id,aggregate_version,event_type,payload) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), order.order_id, order.version, `test.${event}`, order],
  );
}
async function dispatch(client: DatabaseClient, order: TestOrder) {
  for (const line of order.snapshot.lines.filter((line) => line.prep_required)) {
    await client.query(
      "INSERT INTO test_kitchen_tasks(id,order_id,task_key,station,title) VALUES ($1,$2,$3,'prep',$4)",
      [
        randomUUID(),
        order.order_id,
        `prep:${'line_id' in line ? line.line_id : line.id}`,
        kitchenLineTitle(line),
      ],
    );
  }
  await client.query(
    "INSERT INTO test_kitchen_tasks(id,order_id,task_key,station,title) VALUES ($1,$2,'assembly','assembly','Проверить состав и собрать тестовый заказ')",
    [randomUUID(), order.order_id],
  );
}
function version(order: TestOrder, expected: number) {
  if (order.version !== expected) throw new TestFlowError('CONFLICT');
}

async function readFeedback(client: DatabaseClient, branch: string, orderId: string) {
  const rows = (
    await client.query<{ id: string; kind: string; payload: Record<string, unknown> }>(
      "SELECT id,kind,payload FROM bo_records WHERE branch_id=$1 AND kind IN ('review','ticket') AND payload->>'order_id'=$2 AND payload->>'source'='mobile_test' ORDER BY updated_at,id LIMIT 6",
      [branch, orderId],
    )
  ).rows;
  const review = rows.find((row) => row.kind === 'review');
  // Never expose assignee details, internal notes, or staff-only resolutions.
  return TestFeedbackSchema.parse({
    review: review
      ? { id: review.id, stars: review.payload.stars, text: review.payload.text }
      : null,
    tickets: rows
      .filter((row) => row.kind === 'ticket')
      .map((row) => ({ id: row.id, text: row.payload.description, status: row.payload.status })),
  });
}

export class TestOrderFlow {
  constructor(
    private readonly pool: DatabasePool,
    private readonly config: TestFlowConfig,
  ) {}
  private async shiftSnapshot(client: DatabaseClient, branchId: string) {
    const row = (
      await client.query(
        'SELECT id AS shift_id,sequence::text AS number,state,version,opened_at,closed_at FROM test_service_shifts WHERE branch_id=$1 ORDER BY sequence DESC LIMIT 1',
        [branchId],
      )
    ).rows[0];
    return TestServiceShiftCurrentSchema.parse({
      synthetic: true,
      namespace: TEST_NAMESPACE,
      shift: row
        ? {
            ...row,
            opened_at: row.opened_at.toISOString(),
            closed_at: row.closed_at?.toISOString() ?? null,
          }
        : null,
    });
  }
  currentShift(token: string) {
    return this.read(token, ['manager'], (client, actor) =>
      this.shiftSnapshot(client, actor.branch_id),
    );
  }
  changeShift(token: string, key: string, action: 'open' | 'close', input: unknown) {
    const body = parse(TestServiceShiftChangeSchema, input);
    return this.command(token, ['manager'], key, `shift.${action}`, body, async (client, actor) => {
      const current = (await this.shiftSnapshot(client, actor.branch_id)).shift;
      if (
        (current?.shift_id ?? null) !== body.previous_shift_id ||
        (current?.version ?? null) !== body.expected_version
      )
        throw new TestFlowError('CONFLICT');
      if (action === 'open') {
        if (current?.state === 'open') throw new TestFlowError('CONFLICT');
        await client.query("INSERT INTO test_service_shifts(branch_id,state) VALUES($1,'open')", [
          actor.branch_id,
        ]);
      } else {
        if (!current || current.state !== 'open') throw new TestFlowError('CONFLICT');
        await client.query(
          "UPDATE test_service_shifts SET state='closed',version=version+1,closed_at=clock_timestamp() WHERE id=$1",
          [current.shift_id],
        );
      }
      return this.shiftSnapshot(client, actor.branch_id);
    });
  }
  // Compatibility name: daily now uses the persistent shift-scoped number.
  // Apply only to an already authorized server response. Stored command results and
  // outbox keep their original global references, including during an API rollback.
  async dailyNumbers<T>(result: T, shiftContext = false): Promise<T> {
    const references = new Set<string>();
    type NumberIdentity = {
      number: string;
      order_id: string;
      business_date: string;
      shift_number: string;
    };
    const visit = (value: unknown, replace?: Map<string, NumberIdentity>): unknown => {
      if (Array.isArray(value)) return value.map((item) => visit(item, replace));
      if (!value || typeof value !== 'object') return value;
      const output = Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          if (key === 'number' && typeof item === 'string' && /^T-\d{6,}$/.test(item)) {
            references.add(item);
            if (replace) {
              const number = replace.get(item);
              if (!number) throw new Error('Missing persistent order number');
              return [key, number.number];
            }
          }
          return [key, visit(item, replace)];
        }),
      );
      if (
        replace &&
        'number' in value &&
        typeof value.number === 'string' &&
        'channel' in value &&
        !('order_id' in value)
      ) {
        const identity = replace.get(value.number);
        if (identity)
          Object.assign(output, {
            order_id: identity.order_id,
            business_date: identity.business_date,
            ...(shiftContext ? { shift_number: identity.shift_number } : {}),
          });
      }
      return output;
    };
    visit(result);
    if (!references.size) return result;
    const rows = (
      await this.pool.query<NumberIdentity & { reference: string }>(
        `SELECT 'T-' || lpad(o.sequence::text,GREATEST(length(o.sequence::text),6),'0') AS reference,
       n.number::text AS number, n.order_id, n.business_date::text AS business_date, s.sequence::text AS shift_number FROM test_orders o JOIN test_order_numbers n ON n.order_id=o.id JOIN test_service_shifts s ON s.id=n.shift_id
       WHERE o.branch_id=$1 AND o.sequence=ANY($2::bigint[])`,
        [TEST_BRANCH_ID, [...references].map((reference) => reference.slice(2))],
      )
    ).rows;
    return visit(result, new Map(rows.map((row) => [row.reference, row]))) as T;
  }
  catalog(requestedVersion: unknown = TEST_CATALOG_VERSION) {
    enabled(this.config);
    const selected = parse(TestCatalogVersionSchema, requestedVersion);
    return selected === TEST_COMPLETE_CATALOG_VERSION ? testCompleteCatalog : testCatalog;
  }
  private async read<T>(
    token: string,
    roles: TestRole[],
    run: (client: DatabaseClient, actor: Actor) => Promise<T>,
  ) {
    enabled(this.config);
    return transaction(this.pool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const actor = await authenticate(client, token, roles, this.config.customerAuthEnabled);
      return run(client, actor);
    });
  }
  private async command<T>(
    token: string,
    roles: TestRole[],
    key: string,
    type: string,
    input: unknown,
    run: (client: DatabaseClient, actor: Actor) => Promise<T>,
  ): Promise<T> {
    enabled(this.config);
    id(key);
    const requestHash = hash(JSON.stringify({ type, input }));
    return transaction(this.pool, async (client) => {
      // One synthetic branch uses a common short-lived write lock: quota/command/order lock order never inverts.
      await lockFlow(client);
      const actor = await authenticate(client, token, roles, this.config.customerAuthEnabled);
      await checkBranch(client);
      const old = (
        await client.query<{ request_hash: string; result: T }>(
          'SELECT request_hash,result FROM test_command_results WHERE actor_id=$1 AND idempotency_key=$2',
          [actor.id, key],
        )
      ).rows[0];
      if (old) {
        if (old.request_hash !== requestHash) throw new TestFlowError('CONFLICT');
        return old.result;
      }
      const result = await run(client, actor);
      await client.query(
        'INSERT INTO test_command_results(actor_id,idempotency_key,request_hash,result) VALUES ($1,$2,$3,$4)',
        [actor.id, key, requestHash, result],
      );
      return result;
    });
  }
  async issueSession(input: unknown, token = '') {
    enabled(this.config);
    const body = parse(TestSessionInputSchema, input);
    if (this.config.customerAuthEnabled && body.channel === 'mobile')
      return this.customerSession(token);
    return transaction(this.pool, async (client) => {
      await lockFlow(client);
      await checkBranch(client);
      await prune(client);
      const row = (
        await client.query<{ active: string; today: string }>(
          "SELECT count(*) FILTER(WHERE created_at>=clock_timestamp()-interval '2 hours' AND revoked_at IS NULL)::text AS active,count(*) FILTER(WHERE created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::text AS today FROM test_actors WHERE role='customer'",
        )
      ).rows[0];
      if (Number(row?.active) >= 100 || Number(row?.today) >= 200)
        throw new TestFlowError('RATE_LIMITED');
      const token = randomBytes(32).toString('hex');
      const inserted = (
        await client.query<{ id: string; expires_at: Date | number }>(
          "INSERT INTO test_actors(id,branch_id,token_hash,role,channel,expires_at) VALUES ($1,$2,$3,'customer',$4,'infinity') RETURNING id,expires_at",
          [randomUUID(), TEST_BRANCH_ID, hash(token), body.channel],
        )
      ).rows[0];
      return TestSessionSchema.parse({
        ...synthetic,
        session_id: inserted?.id,
        token,
        expires_at: accessExpiry(inserted?.expires_at),
        channel: body.channel,
      });
    });
  }
  private async customerSession(token: string) {
    return transaction(this.pool, async (client) => {
      await lockFlow(client);
      await checkBranch(client);
      const customerId = await identityOwner(client, token);
      const row = (
        await client.query<{ actor_id: string }>(
          'SELECT actor_id FROM identity_customer_test_actors WHERE customer_id=$1',
          [customerId],
        )
      ).rows[0];
      if (!row) {
        const actorId = randomUUID();
        // This token is never disclosed. Every request must use a current identity access token.
        await client.query(
          "INSERT INTO test_actors(id,branch_id,token_hash,role,channel,expires_at) VALUES($1,$2,$3,'customer','mobile','infinity')",
          [actorId, TEST_BRANCH_ID, hash(randomBytes(32).toString('hex'))],
        );
        await client.query(
          'INSERT INTO identity_customer_test_actors(customer_id,actor_id) VALUES($1,$2)',
          [customerId, actorId],
        );
      }
      const actor = await authenticate(client, token, ['customer'], true);
      return TestSessionSchema.parse({
        ...synthetic,
        session_id: actor.id,
        token,
        expires_at: TEST_ACCESS_NO_EXPIRY,
        channel: 'mobile',
      });
    });
  }
  async continueSession(token: string, input: unknown) {
    enabled(this.config);
    parse(TestContinueSessionInputSchema, input);
    if (this.config.customerAuthEnabled) {
      const legacy = (
        await this.pool.query<{ channel: string }>(
          'SELECT channel FROM test_actors WHERE token_hash=$1',
          [hash(token)],
        )
      ).rows[0];
      if (!legacy || legacy.channel === 'mobile') return this.customerSession(token);
    }
    if (!/^[a-f0-9]{64}$/.test(token)) throw new TestFlowError('UNAUTHORIZED');
    return transaction(this.pool, async (client) => {
      await lockFlow(client);
      await checkBranch(client);
      // Expired credentials are accepted solely here, never for order operations.
      const actor = (
        await client.query<Actor & { expires_at: Date | number }>(
          'SELECT id,role,branch_id,channel,expires_at FROM test_actors WHERE token_hash=$1 AND revoked_at IS NULL',
          [hash(token)],
        )
      ).rows[0];
      if (!actor) throw new TestFlowError('UNAUTHORIZED');
      if (actor.role !== 'customer' || actor.branch_id !== TEST_BRANCH_ID)
        throw new TestFlowError('FORBIDDEN');
      // Existing mobile builds may still hold a pre-migration two-hour timestamp.
      // Refreshing permanent access metadata must not strand an unfinished order;
      // identity, commands, payment state and quotas are all retained unchanged.
      if (actor.expires_at !== Number.POSITIVE_INFINITY) {
        const unfinished = await client.query(
          "SELECT 1 FROM test_orders WHERE actor_id=$1 AND (state NOT IN ('fulfilled','cancelled') OR payment_state='simulated_unknown') LIMIT 1",
          [actor.id],
        );
        if (unfinished.rowCount) throw new TestFlowError('CONFLICT');
      }
      let expiresAt = actor.expires_at;
      if (actor.expires_at !== Number.POSITIVE_INFINITY) {
        const extended = (
          await client.query<{ expires_at: Date | number }>(
            "UPDATE test_actors SET expires_at='infinity' WHERE id=$1 RETURNING expires_at",
            [actor.id],
          )
        ).rows[0];
        if (!extended) throw new TestFlowError('UNAUTHORIZED');
        expiresAt = extended.expires_at;
      }
      // Returning the caller's token introduces no plaintext token storage. Keeping
      // this actor preserves history, daily issuance counts and per-actor quotas.
      return TestSessionSchema.parse({
        ...synthetic,
        session_id: actor.id,
        token,
        expires_at: accessExpiry(expiresAt),
        channel: actor.channel,
      });
    });
  }
  quote(token: string, key: string, input: unknown) {
    const body = parse(TestCartSchema, input);
    return this.command(token, ['customer'], key, 'quote.create', body, async (client, actor) => {
      const count = (
        await client.query<{ count: string }>(
          "SELECT count(*) FROM test_quotes WHERE actor_id=$1 AND created_at>=clock_timestamp()-interval '24 hours'",
          [actor.id],
        )
      ).rows[0];
      if (Number(count?.count) >= 40) throw new TestFlowError('RATE_LIMITED');
      const lines =
        body.catalog_version === TEST_COMPLETE_CATALOG_VERSION
          ? body.items.map((item) => priceCompleteLine(item))
          : body.items.map((item) => {
              const product = testCatalog.products.find(
                (product) => product.id === item.product_id,
              );
              if (!product) throw new TestFlowError('INVALID_REQUEST');
              return {
                ...product,
                quantity: item.quantity,
                line_total_minor: (BigInt(product.price_minor) * BigInt(item.quantity)).toString(),
              };
            });
      const created = (await client.query<{ time: Date }>('SELECT clock_timestamp() AS time'))
        .rows[0]?.time;
      if (!created) throw new Error('Database clock missing');
      const quote = TestQuoteSchema.parse({
        ...synthetic,
        quote_id: randomUUID(),
        branch_id: actor.branch_id,
        catalog_version: body.catalog_version,
        ...(body.catalog_version === TEST_COMPLETE_CATALOG_VERSION
          ? {
              payment_method: body.payment_method,
              estimated_minutes: estimatePreparation(body.items),
            }
          : {}),
        channel: actor.channel,
        service_mode: body.service_mode,
        currency: 'KZT',
        total_minor: lines
          .reduce((total, line) => total + BigInt(line.line_total_minor), 0n)
          .toString(),
        lines,
        created_at: created.toISOString(),
        expires_at: new Date(created.getTime() + 300000).toISOString(),
      });
      await client.query(
        'INSERT INTO test_quotes(id,actor_id,branch_id,snapshot,total_minor,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          quote.quote_id,
          actor.id,
          actor.branch_id,
          quote,
          quote.total_minor,
          quote.created_at,
          quote.expires_at,
        ],
      );
      return quote;
    });
  }
  createOrder(token: string, key: string, input: unknown) {
    const body = parse(TestCreateOrderSchema, input);
    return this.command(token, ['customer'], key, 'order.create', body, async (client, actor) => {
      const shift = (await this.shiftSnapshot(client, actor.branch_id)).shift;
      if (shift?.state === 'closed') throw new TestFlowError('SHIFT_CLOSED');
      const q = (
        await client.query(
          'SELECT *,expires_at>clock_timestamp() AS valid FROM test_quotes WHERE id=$1 AND actor_id=$2',
          [body.quote_id, actor.id],
        )
      ).rows[0];
      if (!q) throw new TestFlowError('NOT_FOUND');
      if (!q.valid) throw new TestFlowError('QUOTE_EXPIRED');
      if ((await client.query('SELECT 1 FROM test_orders WHERE quote_id=$1', [q.id])).rowCount)
        throw new TestFlowError('CONFLICT');
      if (
        (
          await client.query(
            "SELECT 1 FROM test_orders WHERE actor_id=$1 AND payment_state='simulated_unknown'",
            [actor.id],
          )
        ).rowCount
      )
        throw new TestFlowError('CONFLICT');
      const counts = (
        await client.query<{ owned: string; owned_active: string; active: string }>(
          "SELECT count(*) FILTER(WHERE actor_id=$1 AND created_at>=clock_timestamp()-interval '24 hours')::text AS owned,count(*) FILTER(WHERE actor_id=$1 AND state NOT IN ('fulfilled','cancelled'))::text AS owned_active,count(*) FILTER(WHERE state NOT IN ('fulfilled','cancelled'))::text AS active FROM test_orders",
          [actor.id],
        )
      ).rows[0];
      if (
        Number(counts?.owned) >= 20 ||
        Number(counts?.owned_active) >= 20 ||
        Number(counts?.active) >= 2000
      )
        throw new TestFlowError('RATE_LIMITED');
      const orderId = randomUUID();
      await client.query(
        body.execution_mode
          ? 'INSERT INTO test_orders(id,actor_id,branch_id,quote_id,snapshot,total_minor,execution_mode) VALUES ($1,$2,$3,$4,$5,$6,$7)'
          : 'INSERT INTO test_orders(id,actor_id,branch_id,quote_id,snapshot,total_minor) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          orderId,
          actor.id,
          actor.branch_id,
          q.id,
          q.snapshot,
          q.total_minor,
          ...(body.execution_mode ? [body.execution_mode] : []),
        ],
      );
      const order = await loadOrder(client, actor, orderId);
      await emit(client, order, 'order.created');
      if (body.execution_mode === 'unpaid_test') {
        await dispatch(client, order);
        await client.query(
          "UPDATE test_orders SET state='preparing',version=version+1,updated_at=clock_timestamp() WHERE id=$1",
          [orderId],
        );
        const submitted = await loadOrder(client, actor, orderId);
        await emit(client, submitted, 'order.submitted_unpaid');
        return submitted;
      }
      return order;
    });
  }
  readOrder(token: string, orderId: string) {
    id(orderId);
    return this.read(token, ['customer', 'prep', 'assembly', 'manager'], (client, actor) =>
      loadOrder(client, actor, orderId),
    );
  }
  feedback(token: string, orderId: string) {
    id(orderId);
    return this.read(token, ['customer'], async (client, actor) => {
      await loadOrder(client, actor, orderId);
      return readFeedback(client, actor.branch_id, orderId);
    });
  }
  submitFeedback(token: string, key: string, orderId: string, input: unknown) {
    id(orderId);
    const body = parse(TestFeedbackInputSchema, input);
    return this.command(
      token,
      ['customer'],
      key,
      'customer.feedback',
      { orderId, ...body },
      async (client, actor) => {
        const order = await loadOrder(client, actor, orderId, true);
        const existing = await readFeedback(client, actor.branch_id, orderId);
        if (body.kind === 'review' && (order.state !== 'fulfilled' || existing.review))
          throw new TestFlowError('CONFLICT');
        if (body.kind === 'ticket' && existing.tickets.length >= 5)
          throw new TestFlowError('RATE_LIMITED');
        const publicNumber =
          (
            await client.query<{ number: number }>(
              'SELECT number FROM test_order_numbers WHERE order_id=$1',
              [orderId],
            )
          ).rows[0]?.number ?? order.number;
        const payload =
          body.kind === 'review'
            ? {
                name: `Отзыв из приложения · заказ №${publicNumber}`,
                order_id: orderId,
                stars: body.stars,
                text: body.text,
                source: 'mobile_test',
                status: 'new',
                internal_note: '',
              }
            : {
                name: `Из приложения · заказ №${publicNumber}`,
                order_id: orderId,
                category: 'question',
                priority: 'normal',
                assignee_id: null,
                due_at: null,
                status: 'new',
                description: body.text,
                resolution: '',
                source: 'mobile_test',
              };
        // Atomic with the durable customer command result. BO staff still use their own RBAC/audit.
        await client.query(
          `INSERT INTO bo_records(id,branch_id,organization_id,kind,revision,payload)
        SELECT $1,id,organization_id,$2,1,$3 FROM branches WHERE id=$4`,
          [randomUUID(), body.kind, payload, actor.branch_id],
        );
        return readFeedback(client, actor.branch_id, orderId);
      },
    );
  }
  history(token: string, before?: string) {
    if (before !== undefined) id(before);
    return this.read(token, ['customer'], async (client, actor) => {
      const cursor = before ? await loadOrder(client, actor, before) : null;
      const rows = (
        await client.query<Record<string, unknown>>(
          `${orderSelect} WHERE o.branch_id=$1 AND o.actor_id=$2 AND o.state IN ('fulfilled','cancelled')
         ${cursor ? 'AND (o.created_at,o.id)<($3::timestamptz,$4::uuid)' : ''}
         ORDER BY o.created_at DESC,o.id DESC LIMIT 21`,
          cursor
            ? [actor.branch_id, actor.id, cursor.created_at, cursor.order_id]
            : [actor.branch_id, actor.id],
        )
      ).rows;
      return TestHistorySchema.parse({
        ...synthetic,
        orders: rows.slice(0, 20).map(projectOrder),
        has_more: rows.length > 20,
      });
    });
  }
  ownOrders(token: string) {
    return this.listOrders(token, ['customer']);
  }
  comboProgress(token: string) {
    if (!this.config.customerAuthEnabled) throw new TestFlowError('DISABLED');
    return this.read(token, ['customer'], async (client) => {
      const customerId = await identityOwner(client, token);
      const row = (
        await client.query<{ units: string }>(
          'SELECT coalesce(sum(units),0)::text AS units FROM test_combo_stamps WHERE customer_id=$1',
          [customerId],
        )
      ).rows[0];
      const units = Number(row?.units ?? 0);
      return TestComboProgressSchema.parse({
        ...synthetic,
        mode: 'practice',
        program_version: 'practice-single-combo-v1',
        threshold: 7,
        earned_units: units,
        current_stamps: units % 7,
        completed_cycles: Math.floor(units / 7),
        redeemable: false,
      });
    });
  }
  managerOrders(token: string) {
    return this.listOrders(token, ['manager']);
  }
  private listOrders(token: string, roles: TestRole[]) {
    return this.read(token, roles, async (client, actor) => {
      const rows = (
        await client.query<Record<string, unknown>>(
          // Published mobile clients accept a bounded full-snapshot response.
          // All unfinished orders precede recent history; the per-actor active
          // quota ensures none can be displaced by newer completed orders.
          `${orderSelect} WHERE o.branch_id=$1 ${actor.role === 'customer' ? 'AND o.actor_id=$2' : ''} ORDER BY (o.state NOT IN ('fulfilled','cancelled')) DESC,o.created_at DESC,o.id LIMIT ${actor.role === 'customer' ? 20 : 2000}`,
          actor.role === 'customer' ? [actor.branch_id, actor.id] : [actor.branch_id],
        )
      ).rows;
      const orders = rows.map(projectOrder);
      return TestOrdersSchema.parse({ ...synthetic, orders });
    });
  }
  simulatePayment(token: string, key: string, orderId: string, input: unknown) {
    id(orderId);
    const body = parse(TestPaymentSchema, input);
    return this.payment(token, ['customer'], key, orderId, body, false);
  }
  resolvePayment(token: string, key: string, orderId: string, input: unknown) {
    id(orderId);
    const body = parse(TestResolvePaymentSchema, input);
    return this.payment(token, ['manager'], key, orderId, body, true);
  }
  private payment(
    token: string,
    roles: TestRole[],
    key: string,
    orderId: string,
    body: z.infer<typeof TestPaymentSchema>,
    resolving: boolean,
  ) {
    return this.command(
      token,
      roles,
      key,
      resolving ? 'payment.resolve' : 'payment.simulate',
      { order_id: orderId, ...body },
      async (client, actor) => {
        const old = await loadOrder(client, actor, orderId, true);
        version(old, body.expected_version);
        if (
          old.state !== 'awaiting_test_payment' ||
          (resolving
            ? old.payment_state !== 'simulated_unknown'
            : !['not_started', 'simulated_declined'].includes(old.payment_state))
        )
          throw new TestFlowError('CONFLICT');
        if (
          !resolving &&
          (
            await client.query(
              "SELECT 1 FROM test_orders WHERE actor_id=$1 AND payment_state='simulated_unknown' AND id<>$2",
              [actor.id, orderId],
            )
          ).rowCount
        )
          throw new TestFlowError('CONFLICT');
        const paymentState = `simulated_${body.outcome}`;
        await client.query(
          'UPDATE test_orders SET payment_state=$2,payment_attempt_id=$3,state=$4,version=version+1,updated_at=clock_timestamp() WHERE id=$1',
          [
            orderId,
            paymentState,
            resolving ? old.payment_attempt_id : randomUUID(),
            body.outcome === 'approved' ? 'preparing' : 'awaiting_test_payment',
          ],
        );
        if (body.outcome === 'approved') await dispatch(client, old);
        const order = await loadOrder(client, actor, orderId);
        await emit(client, order, resolving ? 'payment.resolved' : 'payment.simulated');
        return order;
      },
    );
  }
  cancel(token: string, key: string, orderId: string, input: unknown) {
    id(orderId);
    const body = parse(TestCancellationSchema, input);
    return this.command(
      token,
      ['customer', 'manager'],
      key,
      'order.cancel',
      { order_id: orderId, ...body },
      async (client, actor) => {
        const old = await loadOrder(client, actor, orderId, true);
        version(old, body.expected_version);
        if (
          ['fulfilled', 'cancelled'].includes(old.state) ||
          old.payment_state === 'simulated_unknown'
        )
          throw new TestFlowError('CONFLICT');
        await client.query(
          "UPDATE test_orders SET state='cancelled',cancellation_reason=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
          [orderId, body.reason],
        );
        const order = await loadOrder(client, actor, orderId);
        await emit(client, order, 'order.cancelled');
        return order;
      },
    );
  }
  kitchen(token: string) {
    return this.read(token, ['prep', 'assembly', 'manager'], async (client, actor) => {
      const rows = (
        await client.query<Record<string, unknown>>(
          `${orderSelect} WHERE o.branch_id=$1 AND o.state IN ('preparing','ready') ORDER BY o.created_at,o.id LIMIT 2000`,
          [actor.branch_id],
        )
      ).rows;
      const orders = rows
        .map(projectOrder)
        .filter(
          (order) =>
            actor.role === 'manager' || order.tasks.some((task) => task.station === actor.role),
        );
      return TestKitchenSchema.parse({ ...synthetic, station: actor.role, orders });
    });
  }
  completeTask(token: string, key: string, orderId: string, taskId: string, input: unknown) {
    id(orderId);
    id(taskId);
    const body = parse(TestCompleteTaskSchema, input);
    return this.command(
      token,
      ['prep', 'assembly', 'manager'],
      key,
      'task.complete',
      { order_id: orderId, task_id: taskId, ...body },
      async (client, actor) => {
        const old = await loadOrder(client, actor, orderId, true);
        version(old, body.expected_version);
        if (old.state !== 'preparing') throw new TestFlowError('CONFLICT');
        const task = old.tasks.find((task) => task.task_id === taskId);
        if (!task) throw new TestFlowError('NOT_FOUND');
        if (actor.role !== 'manager' && actor.role !== task.station)
          throw new TestFlowError('FORBIDDEN');
        if (task.state === 'done') throw new TestFlowError('CONFLICT');
        if (
          task.station === 'assembly' &&
          old.tasks.some(
            (other) => other.station === 'prep' && other.mandatory && other.state !== 'done',
          )
        )
          throw new TestFlowError('CONFLICT');
        if (body.complete_station) {
          await client.query(
            "UPDATE test_kitchen_tasks SET state='done' WHERE order_id=$1 AND station=$2 AND state='pending'",
            [orderId, task.station],
          );
        } else {
          await client.query("UPDATE test_kitchen_tasks SET state='done' WHERE id=$1", [taskId]);
        }
        await client.query(
          'UPDATE test_orders SET state=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1',
          [orderId, task.station === 'assembly' ? 'ready' : 'preparing'],
        );
        const order = await loadOrder(client, actor, orderId);
        await emit(client, order, task.station === 'assembly' ? 'order.ready' : 'task.completed');
        return order;
      },
    );
  }
  handoff(token: string, key: string, orderId: string, input: unknown) {
    id(orderId);
    const body = parse(TestVersionSchema, input);
    return this.command(
      token,
      ['assembly', 'manager'],
      key,
      'order.handoff',
      { order_id: orderId, ...body },
      async (client, actor) => {
        const old = await loadOrder(client, actor, orderId, true);
        version(old, body.expected_version);
        if (old.state !== 'ready') throw new TestFlowError('CONFLICT');
        await client.query(
          "UPDATE test_orders SET state='fulfilled',version=version+1,updated_at=clock_timestamp() WHERE id=$1",
          [orderId],
        );
        const order = await loadOrder(client, actor, orderId);
        if (this.config.customerAuthEnabled) {
          // Same transaction as handoff/outbox. Quantity and ownership come only from stored data.
          // The unique order reference also rejects duplicate delivery with a new command key.
          await client.query(
            `INSERT INTO test_combo_stamps
            (order_id,customer_id,branch_id,program_version,units)
            SELECT o.id,m.customer_id,o.branch_id,'practice-single-combo-v1',sum((line->>'quantity')::integer)
            FROM test_orders o JOIN identity_customer_test_actors m ON m.actor_id=o.actor_id
            CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'lines') line
            WHERE o.id=$1 AND o.state='fulfilled'
              AND line->>'id' IN ('solo-combo','burger-combo','pick-combo','master-combo')
            GROUP BY o.id,m.customer_id ON CONFLICT(order_id) DO NOTHING`,
            [orderId],
          );
        }
        await emit(client, order, 'order.fulfilled');
        return order;
      },
    );
  }
  display(token: string) {
    return this.read(token, ['display', 'manager'], async (client, actor) => {
      const rows = (
        await client.query<{ number: string; channel: 'mobile' | 'kiosk'; state: string }>(
          "SELECT 'T-' || lpad(sequence::text,GREATEST(length(sequence::text),6),'0') AS number,snapshot->>'channel' AS channel,state FROM test_orders WHERE branch_id=$1 AND state IN ('preparing','ready') ORDER BY created_at,id LIMIT 2000",
          [actor.branch_id],
        )
      ).rows;
      const time = (await client.query<{ time: Date }>('SELECT clock_timestamp() AS time')).rows[0]
        ?.time;
      return TestDisplaySchema.parse({
        ...synthetic,
        branch_id: actor.branch_id,
        preparing: rows
          .filter((row) => row.state === 'preparing')
          .map(({ number, channel }) => ({ number, channel })),
        ready: rows
          .filter((row) => row.state === 'ready')
          .map(({ number, channel }) => ({ number, channel })),
        observed_at: time?.toISOString(),
      });
    });
  }
}
