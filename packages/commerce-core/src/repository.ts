import { UnpaidCancellationRequestSchema, UnpaidCancellationViewSchema } from './model.js';
import { randomUUID } from 'node:crypto';
import { authenticateDevice } from '@pickchick/menu-sync';
import type { DeviceAuth } from '@pickchick/menu-sync';
import { transaction } from '@pickchick/database';
import { priceCatalogSnapshot, CatalogPricingError } from '@pickchick/catalog-pricing';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import {
  CommerceError,
  ScopeSchema,
  ProviderSchema,
  EdgeSchema,
  CreateOrderSchema,
  AttemptSchema,
  AdmissionSchema,
  PaymentObservationSchema,
  RefundRequestSchema,
  RefundObservationSchema,
  FiscalObservationSchema,
  UUIDSchema,
  LeaseSchema,
  AckSchema,
  parse,
  digest,
  priceSnapshot,
} from './model.js';
import type { CommerceScope, TrustedProvider, TrustedEdge } from './model.js';

type Boundary = { organizationId: string; branchId: string };
interface OrderRow {
  id: string;
  organization_id: string;
  branch_id: string;
  principal_id: string;
  customer_id: string | null;
  quote_id: string;
  fiscal_account_id: string | null;
  fiscal_policy: 'required' | 'deferred_pilot';
  snapshot: Record<string, unknown>;
  total_minor: string;
  currency: string;
  quote_digest: string;
  state: string;
  version: string;
  admission_device_id: string | null;
  admission_reservation_id: string | null;
  attention_required: boolean;
  kitchen_effect_id: string | null;
}
interface AttemptRow {
  id: string;
  order_id: string;
  account_id: string;
  intent_id: string;
  state: string;
  intended_minor: string;
}
interface RefundRow {
  id: string;
  order_id: string;
  account_id: string;
  capture_id: string;
  amount_minor: string;
  state: string;
}
interface FiscalRow {
  id: string;
  order_id: string;
  account_id: string;
  kind: string;
  amount_minor: string;
  original_sale_id: string | null;
  state: string;
  request: Record<string, unknown>;
}
interface MoneyRow {
  captured: string;
  refunded: string;
  reserved: string;
}

async function boundary(client: DatabaseClient, scope: Boundary) {
  const result = await client.query('SELECT 1 FROM branches WHERE id=$1 AND organization_id=$2', [
    scope.branchId,
    scope.organizationId,
  ]);
  if (!result.rowCount) throw new CommerceError('FORBIDDEN');
}
async function account(
  client: DatabaseClient,
  scope: Boundary,
  id: string,
  kind: 'payment' | 'fiscal',
  enabled = false,
  legalEntityId?: unknown,
) {
  const legal = legalEntityId === undefined ? null : parse(UUIDSchema, legalEntityId);
  const result = await client.query(
    'SELECT 1 FROM commerce_provider_accounts WHERE id=$1 AND branch_id=$2 AND organization_id=$3 AND kind=$4 AND (NOT $5 OR enabled) AND ($6::uuid IS NULL OR legal_entity_id=$6)',
    [id, scope.branchId, scope.organizationId, kind, enabled, legal],
  );
  if (!result.rowCount) throw new CommerceError('FORBIDDEN');
}
async function lock(client: DatabaseClient, key: unknown) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [digest(key)]);
}
async function order(client: DatabaseClient, scope: Boundary, id: string, principal?: string) {
  const result = await client.query<OrderRow>(
    `SELECT * FROM commerce_orders WHERE id=$1 AND branch_id=$2 AND organization_id=$3 AND ($4::uuid IS NULL OR principal_id=$4) FOR UPDATE`,
    [id, scope.branchId, scope.organizationId, principal ?? null],
  );
  if (!result.rows[0]) throw new CommerceError('NOT_FOUND');
  return result.rows[0];
}
async function totals(client: DatabaseClient, id: string): Promise<MoneyRow> {
  return (
    await client.query<MoneyRow>(
      `SELECT
    COALESCE((SELECT SUM(amount_minor) FROM commerce_captures WHERE order_id=$1),0)::text captured,
    COALESCE((SELECT SUM(amount_minor) FROM commerce_refund_effects WHERE order_id=$1),0)::text refunded,
    COALESCE((SELECT SUM(amount_minor) FROM commerce_refunds WHERE order_id=$1 AND state IN ('pending','unknown')),0)::text reserved`,
      [id],
    )
  ).rows[0]!;
}
async function emit(
  client: DatabaseClient,
  id: string,
  effect: string,
  eventType: string,
  payload: unknown,
) {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO commerce_outbox(id,order_id,effect_key,event_type,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(order_id,effect_key) DO NOTHING RETURNING id`,
    [randomUUID(), id, effect, eventType, payload],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  return (
    await client.query<{ id: string }>(
      'SELECT id FROM commerce_outbox WHERE order_id=$1 AND effect_key=$2',
      [id, effect],
    )
  ).rows[0]!.id;
}
async function issue(
  client: DatabaseClient,
  row: OrderRow,
  key: string,
  code: string,
  details: unknown,
) {
  const result = await client.query(
    'INSERT INTO commerce_reconciliation_issues(id,order_id,issue_key,code,details) VALUES($1,$2,$3,$4,$5) ON CONFLICT(order_id,issue_key) DO NOTHING',
    [randomUUID(), row.id, key, code, details],
  );
  await client.query('UPDATE commerce_orders SET attention_required=true WHERE id=$1', [row.id]);
  row.attention_required = true;
  if (result.rowCount)
    await emit(client, row.id, 'review:' + key, 'commerce.review_required', {
      orderId: row.id,
      code,
      details,
    });
}
async function fiscalDocument(
  client: DatabaseClient,
  row: OrderRow,
  kind: 'sale' | 'refund',
  operationId: string,
  amount: string,
) {
  // Deferred pilots record real money, but never manufacture a fiscal receipt.
  if (row.fiscal_policy === 'deferred_pilot') return;
  const sale =
    kind === 'refund'
      ? (
          await client.query<{ id: string }>(
            "SELECT id FROM commerce_fiscal_documents WHERE order_id=$1 AND kind='sale'",
            [row.id],
          )
        ).rows[0]
      : null;
  if (kind === 'refund' && !sale) throw new CommerceError('NOT_READY');
  const id = randomUUID();
  await client.query(
    `INSERT INTO commerce_fiscal_documents(id,order_id,account_id,kind,business_operation_id,original_sale_id,amount_minor,request) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(kind,business_operation_id) DO NOTHING`,
    [
      id,
      row.id,
      row.fiscal_account_id,
      kind,
      operationId,
      sale?.id ?? null,
      amount,
      {
        orderId: row.id,
        kind,
        businessOperationId: operationId,
        originalSaleId: sale?.id ?? null,
        amountMinor: amount,
        currency: row.currency,
        snapshot: row.snapshot,
      },
    ],
  );
}
async function reconcile(client: DatabaseClient, row: OrderRow) {
  const money = await totals(client, row.id);
  const captured = BigInt(money.captured),
    total = BigInt(row.total_minor);
  if (captured > total)
    await issue(client, row, 'overcapture', 'CAPTURE_EXCEEDS_INTENT', {
      intendedMinor: row.total_minor,
    });
  if (BigInt(money.refunded) + BigInt(money.reserved) > captured)
    await issue(client, row, 'refund-exposure', 'REFUND_EXPOSURE_EXCEEDS_CAPTURE', {});
  const attempts = (
    await client.query<{ state: string }>(
      'SELECT state FROM commerce_payment_attempts WHERE order_id=$1',
      [row.id],
    )
  ).rows;
  if (captured > 0n && attempts.some((a) => a.state === 'pending' || a.state === 'unknown'))
    await issue(client, row, 'capture-pending-attempt', 'CAPTURE_WITH_ANOTHER_PENDING_ATTEMPT', {});
  const paymentState =
    captured >= total
      ? 'succeeded'
      : captured > 0n || attempts.some((a) => a.state === 'unknown')
        ? 'unknown'
        : attempts.some((a) => a.state === 'pending')
          ? 'pending'
          : attempts.length
            ? 'failed'
            : 'created';
  await client.query('UPDATE commerce_payment_intents SET state=$2 WHERE order_id=$1', [
    row.id,
    paymentState,
  ]);
  if (captured >= total) await fiscalDocument(client, row, 'sale', row.id, row.total_minor);
  const documents = (
    await client.query<FiscalRow>('SELECT * FROM commerce_fiscal_documents WHERE order_id=$1', [
      row.id,
    ])
  ).rows;
  const saleIssued = documents.some((d) => d.kind === 'sale' && d.state === 'issued');
  for (const document of documents) {
    if (
      document.state === 'queued' &&
      !row.attention_required &&
      (document.kind === 'sale' || saleIssued)
    ) {
      await emit(client, row.id, 'fiscal:' + document.id, 'fiscal.submit_requested', {
        documentId: document.id,
        accountId: document.account_id,
        kind: document.kind,
        request: document.request,
      });
    }
  }
  if (
    captured === total &&
    (saleIssued || row.fiscal_policy === 'deferred_pilot') &&
    row.admission_reservation_id &&
    !row.attention_required &&
    BigInt(money.refunded) === 0n &&
    BigInt(money.reserved) === 0n &&
    !(await client.query('SELECT 1 FROM commerce_cancellation_intents WHERE order_id=$1', [row.id]))
      .rowCount
  ) {
    const effectId = await emit(
      client,
      row.id,
      'kitchen-admission',
      'edge.kitchen_admission_requested',
      {
        orderId: row.id,
        branchId: row.branch_id,
        owner: 'cloud',
        reservationId: row.admission_reservation_id,
        deviceId: row.admission_device_id,
        quoteDigest: row.quote_digest,
        snapshot: row.snapshot,
      },
    );
    row.kitchen_effect_id = effectId;
  }
  const state = row.attention_required
    ? 'attention_required'
    : captured >= total
      ? 'paid_pending_acceptance'
      : row.admission_reservation_id
        ? 'awaiting_payment'
        : 'awaiting_admission';
  await client.query(
    'UPDATE commerce_orders SET state=$2,version=version+1,updated_at=clock_timestamp(),kitchen_effect_id=$3 WHERE id=$1',
    [row.id, state, row.kitchen_effect_id],
  );
  return {
    orderId: row.id,
    state,
    paymentState,
    capturedMinor: money.captured,
    refundedMinor: money.refunded,
    reservedRefundMinor: money.reserved,
    attentionRequired: row.attention_required,
    kitchenEffectId: row.kitchen_effect_id,
  };
}

export class CommerceRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly fiscalPilot?: {
      organizationId: string;
      branchId: string;
      approvalReference: string;
    },
  ) {}

  /** Server-only opt-in. No client parameter can turn fiscalization off. */
  async createDeferredFiscalOrder(scope: CommerceScope, key: string, quoteId: string) {
    const policy = this.fiscalPilot;
    if (
      !policy ||
      policy.organizationId !== scope.organizationId ||
      policy.branchId !== scope.branchId ||
      policy.approvalReference.trim().length < 3 ||
      policy.approvalReference.length > 250
    )
      throw new CommerceError('FORBIDDEN');
    parse(UUIDSchema, quoteId);
    return this.createOrderWithPolicy(
      scope,
      key,
      { quoteId, fiscalAccountId: null },
      policy.approvalReference,
    );
  }

  private async command<T>(
    scopeInput: CommerceScope,
    key: string,
    operation: string,
    input: unknown,
    run: (client: DatabaseClient, scope: CommerceScope) => Promise<T>,
    manager = false,
    db?: DatabaseClient,
  ): Promise<T> {
    const scope = parse(ScopeSchema, scopeInput);
    parse(UUIDSchema, key);
    if (manager && scope.role !== 'manager') throw new CommerceError('FORBIDDEN');
    const execute = async (client: DatabaseClient) => {
      await boundary(client, scope);
      const parts = [scope.organizationId, scope.branchId, scope.principalId, operation, key];
      await lock(client, ['command', ...parts]);
      const hash = digest(input);
      const old = (
        await client.query<{ request_digest: string; result: T }>(
          `SELECT request_digest,result FROM commerce_commands WHERE organization_id=$1 AND branch_id=$2 AND principal_id=$3 AND operation=$4 AND idempotency_key=$5`,
          parts,
        )
      ).rows[0];
      if (old) {
        if (old.request_digest !== hash) throw new CommerceError('CONFLICT');
        return old.result;
      }
      const result = await run(client, scope);
      await client.query(
        'INSERT INTO commerce_commands(organization_id,branch_id,principal_id,operation,idempotency_key,request_digest,result) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [...parts, hash, result],
      );
      return result;
    };
    return db ? execute(db) : transaction(this.pool, execute);
  }

  /** Internal pricing port: amounts MUST originate from a trusted pricing service. */
  async issueQuote(scope: CommerceScope, key: string, input: unknown) {
    const quote = priceSnapshot(input);
    return this.command(scope, key, 'quote', quote, async (client, actor) => {
      const branch = (
        await client.query<{ legal_entity_id: string; ordering_enabled: boolean }>(
          'SELECT legal_entity_id,ordering_enabled FROM branches WHERE id=$1',
          [actor.branchId],
        )
      ).rows[0]!;
      if ('catalogReference' in quote) {
        const ref = quote.catalogReference;
        if (!branch.ordering_enabled) throw new CommerceError('NOT_READY');
        if (
          ref.organizationId !== actor.organizationId ||
          ref.branchId !== actor.branchId ||
          quote.taxBinding.legalEntityId !== branch.legal_entity_id
        )
          throw new CommerceError('FORBIDDEN');
        // Publication takes FOR UPDATE on the same mutable head. Minimal runtime
        // UPDATE(lock_anchor) permits this lock, without permission to publish.
        const head = (
          await client.query<{ published_version: number | null }>(
            'SELECT published_version FROM catalog_branch_heads WHERE branch_id=$1 AND organization_id=$2 FOR SHARE',
            [actor.branchId, actor.organizationId],
          )
        ).rows[0];
        if (!head) throw new CommerceError('NOT_FOUND');
        if (head.published_version !== ref.version) throw new CommerceError('CONFLICT');
        const publication = (
          await client.query<{ payload: unknown; payload_hash: string; published_at: Date }>(
            'SELECT payload,payload_hash,published_at FROM catalog_publications WHERE branch_id=$1 AND organization_id=$2 AND version=$3',
            [actor.branchId, actor.organizationId, ref.version],
          )
        ).rows[0];
        if (!publication) throw new CommerceError('NOT_FOUND');
        if (
          publication.payload_hash !== ref.payloadHash ||
          publication.published_at.toISOString() !== ref.publishedAt
        )
          throw new CommerceError('CONFLICT');
        const cart = {
          catalog_version: ref.version,
          service_mode: quote.serviceMode,
          items: quote.lines.map((line) => ({
            sku: line.sku,
            quantity: line.quantity,
            selections: line.selectedDetails.modifiers.map((option) => ({
              group_id: option.groupId,
              option_id: option.optionId,
              quantity: option.quantity,
            })),
          })),
        };
        let repriced;
        try {
          repriced = priceCatalogSnapshot(
            {
              reference: ref,
              orderingEnabled: branch.ordering_enabled,
              payload: publication.payload,
            },
            {
              organizationId: actor.organizationId,
              branchId: actor.branchId,
              customerId: quote.customerId,
              channel: 'mobile',
            },
            cart,
          );
        } catch (error) {
          if (error instanceof CatalogPricingError) throw new CommerceError('INVALID');
          throw error;
        }
        // Prices, SKU/selection identity, components, allergens and nutrition
        // must match the immutable PG publication, not just internally add up.
        const comparable = {
          ...quote,
          lines: quote.lines.map(({ taxCode, ...line }) => {
            void taxCode;
            return line;
          }),
        };
        const { taxBinding, ...withoutTax } = comparable;
        void taxBinding;
        if (digest(withoutTax) !== digest(repriced)) throw new CommerceError('INVALID');
      } else {
        const release = await client.query(
          'SELECT 1 FROM menu_releases WHERE id=$1 AND branch_id=$2',
          [quote.releaseId, actor.branchId],
        );
        if (!release.rowCount) throw new CommerceError('NOT_FOUND');
      }
      const snapshot = {
        ...quote,
        organizationId: actor.organizationId,
        branchId: actor.branchId,
        legalEntityId: branch.legal_entity_id,
      };
      const id = randomUUID();
      const result = await client.query<{ created_at: Date; expires_at: Date }>(
        `INSERT INTO commerce_quotes(id,organization_id,branch_id,principal_id,customer_id,release_id,total_minor,currency,snapshot,digest,created_at,expires_at,catalog_version,catalog_payload_hash,catalog_published_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,statement_timestamp(),statement_timestamp()+$11*interval '1 second',$12,$13,$14) RETURNING created_at,expires_at`,
        [
          id,
          actor.organizationId,
          actor.branchId,
          actor.principalId,
          quote.customerId,
          'releaseId' in quote ? quote.releaseId : null,
          quote.totalMinor,
          quote.currency,
          snapshot,
          digest(snapshot),
          quote.ttlSeconds,
          'catalogReference' in quote ? quote.catalogReference.version : null,
          'catalogReference' in quote ? quote.catalogReference.payloadHash : null,
          'catalogReference' in quote ? quote.catalogReference.publishedAt : null,
        ],
      );
      return {
        quoteId: id,
        snapshot,
        digest: digest(snapshot),
        createdAt: result.rows[0]!.created_at.toISOString(),
        expiresAt: result.rows[0]!.expires_at.toISOString(),
      };
    });
  }
  async createOrder(scope: CommerceScope, key: string, input: unknown) {
    return this.createOrderWithPolicy(scope, key, parse(CreateOrderSchema, input), null);
  }
  private async createOrderWithPolicy(
    scope: CommerceScope,
    key: string,
    request: { quoteId: string; fiscalAccountId: string | null },
    deferral: string | null,
  ) {
    // Preserve the pre-pilot command hash for replay of existing fiscal orders.
    const commandInput = deferral ? { ...request, deferral } : request;
    return this.command(scope, key, 'order', commandInput, async (client, actor) => {
      // Quotes are immutable. Serialize consumption without granting UPDATE
      // merely to SELECT FOR UPDATE an immutable financial snapshot.
      await lock(client, ['consume-quote', request.quoteId]);
      const quote = (
        await client.query<{
          id: string;
          snapshot: Record<string, unknown>;
          customer_id: string | null;
          total_minor: string;
          currency: string;
          digest: string;
          valid: boolean;
        }>(
          'SELECT *,expires_at>clock_timestamp() valid FROM commerce_quotes WHERE id=$1 AND organization_id=$2 AND branch_id=$3 AND principal_id=$4',
          [request.quoteId, actor.organizationId, actor.branchId, actor.principalId],
        )
      ).rows[0];
      if (!quote) throw new CommerceError('NOT_FOUND');
      const old = (
        await client.query<OrderRow>('SELECT * FROM commerce_orders WHERE quote_id=$1', [quote.id])
      ).rows[0];
      if (old) {
        if (old.fiscal_account_id !== request.fiscalAccountId) throw new CommerceError('CONFLICT');
        return { orderId: old.id, quoteId: old.quote_id };
      }
      if (!quote.valid) throw new CommerceError('EXPIRED');
      if (deferral) {
        // First live pilot is explicitly limited to one order per admitted customer.
        // Serialize inside this transaction so two different quotes cannot race it.
        await lock(client, [
          'pilot-budget',
          actor.organizationId,
          actor.branchId,
          actor.principalId,
        ]);
        if (
          (
            await client.query(
              "SELECT 1 FROM commerce_orders WHERE organization_id=$1 AND branch_id=$2 AND principal_id=$3 AND fiscal_policy='deferred_pilot' LIMIT 1",
              [actor.organizationId, actor.branchId, actor.principalId],
            )
          ).rowCount
        )
          throw new CommerceError('NOT_READY');
      }
      if (request.fiscalAccountId)
        await account(
          client,
          actor,
          request.fiscalAccountId,
          'fiscal',
          true,
          quote.snapshot.legalEntityId,
        );
      const id = randomUUID();
      await client.query(
        `INSERT INTO commerce_orders(id,organization_id,branch_id,principal_id,customer_id,quote_id,fiscal_account_id,snapshot,total_minor,currency,quote_digest,fiscal_policy,fiscal_deferral_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          actor.organizationId,
          actor.branchId,
          actor.principalId,
          quote.customer_id,
          quote.id,
          request.fiscalAccountId,
          quote.snapshot,
          quote.total_minor,
          quote.currency,
          quote.digest,
          deferral ? 'deferred_pilot' : 'required',
          deferral,
        ],
      );
      await client.query(
        'INSERT INTO commerce_payment_intents(id,order_id,intended_minor) VALUES($1,$2,$3)',
        [randomUUID(), id, quote.total_minor],
      );
      await emit(client, id, 'admission', 'edge.admission_requested', {
        orderId: id,
        branchId: actor.branchId,
        quoteId: quote.id,
        quoteDigest: quote.digest,
        snapshot: quote.snapshot,
        owner: 'cloud',
      });
      return { orderId: id, quoteId: quote.id };
    });
  }
  /** Legacy trusted internal port; network adapters must use actual DeviceAuth below. */
  async confirmAdmission(edgeInput: TrustedEdge, input: unknown) {
    const edge = parse(EdgeSchema, edgeInput),
      event = parse(AdmissionSchema, input);
    return transaction(this.pool, async (client) => {
      const device = await client.query(
        "SELECT 1 FROM devices WHERE id=$1 AND branch_id=$2 AND organization_id=$3 AND kind='edge' AND status='active'",
        [edge.deviceId, edge.branchId, edge.organizationId],
      );
      if (!device.rowCount) throw new CommerceError('FORBIDDEN');
      return this.applyAdmission(client, edge, event);
    });
  }
  /** Authenticate inside the effect transaction. The optional client is only for an
   * internal transaction owner which atomically persists its transport inbox. */
  async confirmAdmissionAuthenticated(auth: DeviceAuth, input: unknown, client?: DatabaseClient) {
    const event = parse(AdmissionSchema, input),
      identity = { ...auth };
    const apply = async (connection: DatabaseClient) => {
      const branchId = await authenticateDevice(connection, identity);
      const row = (
        await connection.query<{ organization_id: string }>(
          'SELECT organization_id FROM branches WHERE id=$1',
          [branchId],
        )
      ).rows[0];
      if (!row) throw new CommerceError('FORBIDDEN');
      return this.applyAdmission(
        connection,
        { organizationId: row.organization_id, branchId, deviceId: identity.deviceId },
        event,
      );
    };
    return client ? apply(client) : transaction(this.pool, apply);
  }
  private async applyAdmission(
    client: DatabaseClient,
    edge: TrustedEdge,
    event: ReturnType<typeof AdmissionSchema.parse>,
  ) {
    // Order first also matches the outer authenticated transport transaction.
    const row = await order(client, edge, event.orderId);
    await lock(client, ['edge', edge.deviceId, event.eventId]);
    const old = (
      await client.query<{ request_digest: string; result: unknown }>(
        'SELECT request_digest,result FROM commerce_edge_inbox WHERE device_id=$1 AND event_id=$2',
        [edge.deviceId, event.eventId],
      )
    ).rows[0];
    if (old) {
      if (old.request_digest !== digest(event)) throw new CommerceError('CONFLICT');
      return old.result;
    }
    if (row.quote_digest !== event.quoteDigest) throw new CommerceError('CONFLICT');
    if (
      row.admission_reservation_id &&
      (row.admission_reservation_id !== event.reservationId ||
        row.admission_device_id !== edge.deviceId)
    )
      throw new CommerceError('CONFLICT');
    await client.query(
      'UPDATE commerce_orders SET admission_device_id=$2,admission_reservation_id=$3 WHERE id=$1',
      [row.id, edge.deviceId, event.reservationId],
    );
    row.admission_device_id = edge.deviceId;
    row.admission_reservation_id = event.reservationId;
    const result = await reconcile(client, row);
    await client.query(
      'INSERT INTO commerce_edge_inbox(device_id,event_id,request_digest,result) VALUES($1,$2,$3,$4)',
      [edge.deviceId, event.eventId, digest(event), result],
    );
    return result;
  }
  /** Trusted internal manager port only; no HTTP principal is accepted here. */
  async requestUnpaidCancellation(
    scope: CommerceScope,
    key: string,
    input: unknown,
    db?: DatabaseClient,
  ) {
    const request = parse(UnpaidCancellationRequestSchema, input);
    return this.command(
      scope,
      key,
      'unpaid_cancellation',
      request,
      async (client, actor) => {
        const row = await order(client, actor, request.orderId);
        const binding = (
          await client.query(
            'SELECT active FROM fulfillment_transport_bindings WHERE branch_id=$1 FOR SHARE',
            [actor.branchId],
          )
        ).rows[0];
        if (!binding?.active) throw new CommerceError('NOT_READY');
        if (
          (
            await client.query('SELECT 1 FROM commerce_cancellation_intents WHERE order_id=$1', [
              row.id,
            ])
          ).rowCount
        )
          throw new CommerceError('CONFLICT');
        if (
          row.kitchen_effect_id ||
          row.attention_required ||
          (
            await client.query(
              `SELECT 1 FROM commerce_payment_attempts WHERE order_id=$1 UNION ALL SELECT 1 FROM commerce_captures WHERE order_id=$1 UNION ALL SELECT 1 FROM commerce_refunds WHERE order_id=$1 LIMIT 1`,
              [row.id],
            )
          ).rowCount
        )
          throw new CommerceError('NOT_READY');
        await client.query(
          "INSERT INTO commerce_cancellation_intents(id,order_id,organization_id,branch_id,requested_by,reason,state) VALUES($1,$2,$3,$4,$5,$6,'waiting_admission')",
          [
            randomUUID(),
            row.id,
            actor.organizationId,
            actor.branchId,
            actor.principalId,
            request.reason,
          ],
        );
        await this.scheduleUnpaidCancellation(client, actor, row.id);
        return this.cancellationView(client, actor, row.id);
      },
      true,
      db,
    );
  }
  private async cancellationView(client: DatabaseClient, scope: Boundary, orderId: string) {
    const row = (
      await client.query(
        'SELECT * FROM commerce_cancellation_intents WHERE order_id=$1 AND organization_id=$2 AND branch_id=$3',
        [orderId, scope.organizationId, scope.branchId],
      )
    ).rows[0];
    if (!row) throw new CommerceError('NOT_FOUND');
    return UnpaidCancellationViewSchema.parse({
      cancellationId: row.id,
      orderId: row.order_id,
      state: row.state,
      releaseEventId: row.release_event_id,
      expectedEdgeVersion: row.expected_edge_version,
      resultEventId: row.result_event_id,
      resolutionCode: row.resolution_code,
    });
  }
  async readUnpaidCancellation(scopeInput: CommerceScope, orderId: string) {
    const scope = parse(ScopeSchema, scopeInput);
    parse(UUIDSchema, orderId);
    if (scope.role !== 'manager') throw new CommerceError('FORBIDDEN');
    return transaction(this.pool, async (client) => {
      await boundary(client, scope);
      return this.cancellationView(client, scope, orderId);
    });
  }
  /** Called inside authenticated admission/projection TX; never across HTTP. */
  async scheduleUnpaidCancellation(client: DatabaseClient, scope: Boundary, orderId: string) {
    const row = await order(client, scope, orderId);
    const intent = (
      await client.query(
        'SELECT * FROM commerce_cancellation_intents WHERE order_id=$1 FOR UPDATE',
        [orderId],
      )
    ).rows[0];
    if (!intent || intent.state !== 'waiting_admission') return;
    if (!row.admission_reservation_id) return;
    const p = (
      await client.query('SELECT * FROM cloud_fulfillment_projection WHERE order_id=$1', [row.id])
    ).rows[0];
    let problem: string | null = null;
    if (
      (
        await client.query('SELECT 1 FROM commerce_payment_attempts WHERE order_id=$1 LIMIT 1', [
          row.id,
        ])
      ).rowCount ||
      row.kitchen_effect_id
    )
      problem = 'PAYMENT_HISTORY';
    else if (
      !p ||
      p.device_id !== row.admission_device_id ||
      p.reservation_id !== row.admission_reservation_id
    )
      problem = 'ADMISSION_UNCONFIRMED';
    else if (p.state !== 'held') problem = 'EDGE_NOT_HELD';
    if (problem) {
      await client.query(
        "UPDATE commerce_cancellation_intents SET state='needs_review',resolution_code=$2,updated_at=clock_timestamp() WHERE id=$1",
        [intent.id, problem],
      );
      return;
    }
    const eventId = await emit(
      client,
      row.id,
      'unpaid-release:' + intent.id,
      'edge.admission_release_requested',
      {
        orderId: row.id,
        branchId: row.branch_id,
        reservationId: row.admission_reservation_id,
        quoteDigest: row.quote_digest,
        owner: 'cloud',
        expectedVersion: p.version,
        reason: intent.reason,
      },
    );
    await client.query(
      "UPDATE commerce_cancellation_intents SET state='release_pending',release_event_id=$2,expected_edge_version=$3,reservation_id=$4,updated_at=clock_timestamp() WHERE id=$1",
      [intent.id, eventId, p.version, row.admission_reservation_id],
    );
  }
  async startPaymentAttempt(scope: CommerceScope, key: string, input: unknown) {
    const request = parse(AttemptSchema, input);
    return this.command(scope, key, 'attempt', request, async (client, actor) => {
      const row = await order(
        client,
        actor,
        request.orderId,
        actor.role === 'manager' ? undefined : actor.principalId,
      );
      if (
        (
          await client.query('SELECT 1 FROM commerce_cancellation_intents WHERE order_id=$1', [
            row.id,
          ])
        ).rowCount
      )
        throw new CommerceError('NOT_READY');
      // A transport-owned admission may have been released/cancelled by its edge.
      // The order lock serializes this decision with incoming fulfillment facts.
      const transport = (
        await client.query<{ device_id: string; active: boolean }>(
          'SELECT device_id,active FROM fulfillment_transport_bindings WHERE branch_id=$1 FOR SHARE',
          [actor.branchId],
        )
      ).rows[0];
      if (transport) {
        if (!transport.active) throw new CommerceError('NOT_READY');
        const admission = (
          await client.query<{ state: string; device_id: string; reservation_id: string }>(
            'SELECT state,device_id,reservation_id FROM cloud_fulfillment_projection WHERE order_id=$1',
            [row.id],
          )
        ).rows[0];
        if (
          !admission ||
          admission.state !== 'held' ||
          admission.device_id !== transport.device_id ||
          admission.device_id !== row.admission_device_id ||
          admission.reservation_id !== row.admission_reservation_id
        )
          throw new CommerceError('NOT_READY');
      }
      await account(
        client,
        actor,
        request.providerAccountId,
        'payment',
        true,
        row.snapshot.legalEntityId,
      );
      if (!row.admission_reservation_id || row.attention_required)
        throw new CommerceError('NOT_READY');
      const money = await totals(client, row.id);
      if (BigInt(money.captured) > 0n) throw new CommerceError('NOT_READY');
      if (
        (
          await client.query(
            "SELECT 1 FROM commerce_payment_attempts WHERE order_id=$1 AND state IN ('pending','unknown')",
            [row.id],
          )
        ).rowCount
      )
        throw new CommerceError('NOT_READY');
      const intent = (
        await client.query<{ id: string }>(
          'SELECT id FROM commerce_payment_intents WHERE order_id=$1',
          [row.id],
        )
      ).rows[0]!;
      const id = randomUUID();
      await client.query(
        'INSERT INTO commerce_payment_attempts(id,intent_id,order_id,account_id,intended_minor) VALUES($1,$2,$3,$4,$5)',
        [id, intent.id, row.id, request.providerAccountId, row.total_minor],
      );
      await emit(client, row.id, 'payment:' + id, 'payment.submit_requested', {
        attemptId: id,
        orderId: row.id,
        accountId: request.providerAccountId,
        amountMinor: row.total_minor,
        currency: row.currency,
        externalReference: id,
      });
      await reconcile(client, row);
      return { attemptId: id, orderId: row.id, amountMinor: row.total_minor, state: 'pending' };
    });
  }

  private async observation<T>(
    providerInput: TrustedProvider,
    kind: 'payment' | 'refund' | 'fiscal',
    event: { eventId: string },
    run: (client: DatabaseClient, provider: TrustedProvider) => Promise<T>,
  ) {
    const provider = parse(ProviderSchema, providerInput);
    return transaction(this.pool, async (client) => {
      // Disabled accounts still accept observations for their in-flight effects.
      await account(client, provider, provider.accountId, kind === 'fiscal' ? 'fiscal' : 'payment');
      await lock(client, ['provider', provider.accountId, kind, event.eventId]);
      const old = (
        await client.query<{ request_digest: string; result: T }>(
          'SELECT request_digest,result FROM commerce_provider_inbox WHERE account_id=$1 AND event_kind=$2 AND event_id=$3',
          [provider.accountId, kind, event.eventId],
        )
      ).rows[0];
      if (old) {
        if (old.request_digest !== digest(event)) throw new CommerceError('CONFLICT');
        return old.result;
      }
      const result = await run(client, provider);
      await client.query(
        'INSERT INTO commerce_provider_inbox(account_id,event_kind,event_id,request_digest,observation,result) VALUES($1,$2,$3,$4,$5,$6)',
        [provider.accountId, kind, event.eventId, digest(event), event, result],
      );
      return result;
    });
  }
  async observePayment(provider: TrustedProvider, input: unknown) {
    const event = parse(PaymentObservationSchema, input);
    return this.observation(provider, 'payment', event, async (client, trusted) => {
      const hint = (
        await client.query<AttemptRow>(
          'SELECT * FROM commerce_payment_attempts WHERE id=$1 AND account_id=$2',
          [event.attemptId, trusted.accountId],
        )
      ).rows[0];
      if (!hint) throw new CommerceError('NOT_FOUND');
      const row = await order(client, trusted, hint.order_id);
      const attempt = (
        await client.query<AttemptRow>('SELECT * FROM commerce_payment_attempts WHERE id=$1', [
          hint.id,
        ])
      ).rows[0]!;
      if (event.outcome === 'captured') {
        const inserted = await client.query<{ id: string }>(
          'INSERT INTO commerce_captures(id,order_id,attempt_id,account_id,operation_id,amount_minor,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,operation_id) DO NOTHING RETURNING id',
          [
            randomUUID(),
            row.id,
            attempt.id,
            trusted.accountId,
            event.operationId,
            event.amountMinor,
            event.occurredAt,
          ],
        );
        const existing = (
          await client.query<{
            id: string;
            order_id: string;
            attempt_id: string;
            amount_minor: string;
          }>('SELECT * FROM commerce_captures WHERE account_id=$1 AND operation_id=$2', [
            trusted.accountId,
            event.operationId,
          ])
        ).rows[0]!;
        if (
          existing.order_id !== row.id ||
          existing.attempt_id !== attempt.id ||
          existing.amount_minor !== event.amountMinor
        ) {
          await issue(
            client,
            row,
            'capture-conflict:' + digest(event.operationId),
            'CAPTURE_REFERENCE_CONFLICT',
            { operationId: event.operationId, existingOrderId: existing.order_id },
          );
        } else {
          await client.query("UPDATE commerce_payment_attempts SET state='succeeded' WHERE id=$1", [
            attempt.id,
          ]);
          if (inserted.rowCount)
            await emit(client, row.id, 'capture:' + existing.id, 'payment.capture_recorded', {
              orderId: row.id,
              captureId: existing.id,
              amountMinor: event.amountMinor,
            });
          if (BigInt((await totals(client, row.id)).captured) < BigInt(row.total_minor))
            await emit(
              client,
              row.id,
              'payment-resolution:' + attempt.id,
              'payment.reconcile_requested',
              { attemptId: attempt.id, accountId: trusted.accountId },
            );
        }
      } else {
        const rank: Record<string, number> = { pending: 0, unknown: 1, failed: 2, succeeded: 3 };
        if (rank[event.outcome]! > rank[attempt.state]!)
          await client.query('UPDATE commerce_payment_attempts SET state=$2 WHERE id=$1', [
            attempt.id,
            event.outcome,
          ]);
        if (
          event.outcome === 'unknown' &&
          attempt.state !== 'succeeded' &&
          attempt.state !== 'failed'
        )
          await emit(
            client,
            row.id,
            'payment-resolution:' + attempt.id,
            'payment.reconcile_requested',
            { attemptId: attempt.id, accountId: trusted.accountId },
          );
      }
      return reconcile(client, row);
    });
  }
  async requestRefund(scope: CommerceScope, key: string, input: unknown, db?: DatabaseClient) {
    const request = parse(RefundRequestSchema, input);
    return this.command(
      scope,
      key,
      'refund',
      request,
      async (client, actor) => {
        const row = await order(client, actor, request.orderId);
        if (row.kitchen_effect_id && request.fulfillmentPolicy !== 'manager_reviewed')
          throw new CommerceError('NOT_READY');
        const capture = (
          await client.query<{ id: string; account_id: string; amount_minor: string }>(
            'SELECT * FROM commerce_captures WHERE id=$1 AND order_id=$2',
            [request.captureId, row.id],
          )
        ).rows[0];
        if (!capture) throw new CommerceError('NOT_FOUND');
        const balance = (
          await client.query<{ refunded: string; reserved: string }>(
            `SELECT
        COALESCE((SELECT SUM(e.amount_minor) FROM commerce_refund_effects e JOIN commerce_refunds r ON r.id=e.refund_id WHERE r.capture_id=$1),0)::text refunded,
        COALESCE((SELECT SUM(amount_minor) FROM commerce_refunds WHERE capture_id=$1 AND state IN ('pending','unknown')),0)::text reserved`,
            [capture.id],
          )
        ).rows[0]!;
        if (
          BigInt(request.amountMinor) + BigInt(balance.refunded) + BigInt(balance.reserved) >
          BigInt(capture.amount_minor)
        )
          throw new CommerceError('REFUND_LIMIT');
        await account(
          client,
          actor,
          capture.account_id,
          'payment',
          true,
          row.snapshot.legalEntityId,
        );
        const id = randomUUID();
        await client.query(
          'INSERT INTO commerce_refunds(id,order_id,capture_id,account_id,principal_id,amount_minor,reason,fulfillment_policy) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            id,
            row.id,
            capture.id,
            capture.account_id,
            actor.principalId,
            request.amountMinor,
            request.reason,
            request.fulfillmentPolicy,
          ],
        );
        await emit(client, row.id, 'refund:' + id, 'refund.submit_requested', {
          refundId: id,
          orderId: row.id,
          captureId: capture.id,
          accountId: capture.account_id,
          amountMinor: request.amountMinor,
          externalReference: id,
        });
        await reconcile(client, row);
        return {
          refundId: id,
          orderId: row.id,
          amountMinor: request.amountMinor,
          state: 'pending',
        };
      },
      true,
      db,
    );
  }
  async observeRefund(provider: TrustedProvider, input: unknown) {
    const event = parse(RefundObservationSchema, input);
    return this.observation(provider, 'refund', event, async (client, trusted) => {
      const hint = (
        await client.query<RefundRow>(
          'SELECT * FROM commerce_refunds WHERE id=$1 AND account_id=$2',
          [event.refundId, trusted.accountId],
        )
      ).rows[0];
      if (!hint) throw new CommerceError('NOT_FOUND');
      const row = await order(client, trusted, hint.order_id);
      const refund = (
        await client.query<RefundRow>('SELECT * FROM commerce_refunds WHERE id=$1', [hint.id])
      ).rows[0]!;
      if (event.outcome === 'succeeded') {
        const inserted = await client.query<{ id: string }>(
          'INSERT INTO commerce_refund_effects(id,refund_id,order_id,account_id,operation_id,amount_minor,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,operation_id) DO NOTHING RETURNING id',
          [
            randomUUID(),
            refund.id,
            row.id,
            trusted.accountId,
            event.operationId,
            event.amountMinor,
            event.occurredAt,
          ],
        );
        const existing = (
          await client.query<{ id: string; refund_id: string; amount_minor: string }>(
            'SELECT * FROM commerce_refund_effects WHERE account_id=$1 AND operation_id=$2',
            [trusted.accountId, event.operationId],
          )
        ).rows[0]!;
        if (existing.refund_id !== refund.id || existing.amount_minor !== event.amountMinor)
          await issue(
            client,
            row,
            'refund-conflict:' + digest(event.operationId),
            'REFUND_REFERENCE_CONFLICT',
            { operationId: event.operationId },
          );
        else {
          await client.query("UPDATE commerce_refunds SET state='succeeded' WHERE id=$1", [
            refund.id,
          ]);
          const count = (
            await client.query<{ count: string }>(
              'SELECT COUNT(*)::text count FROM commerce_refund_effects WHERE refund_id=$1',
              [refund.id],
            )
          ).rows[0]!;
          if (event.amountMinor !== refund.amount_minor || Number(count.count) > 1)
            await issue(client, row, 'refund-amount:' + refund.id, 'UNEXPECTED_REFUND_EFFECT', {
              refundId: refund.id,
            });
          if (inserted.rowCount) {
            // Preserve every actual refund; uncertain legal corrections remain
            // visible for review instead of issuing a guessed fiscal document.
            if (event.amountMinor === refund.amount_minor && Number(count.count) === 1) {
              const hasSale = (
                await client.query(
                  "SELECT 1 FROM commerce_fiscal_documents WHERE order_id=$1 AND kind='sale'",
                  [row.id],
                )
              ).rowCount;
              if (hasSale)
                await fiscalDocument(client, row, 'refund', existing.id, event.amountMinor);
              else
                await issue(
                  client,
                  row,
                  'refund-no-sale:' + refund.id,
                  'REFUND_WITHOUT_SALE_DOCUMENT',
                  { refundId: refund.id },
                );
            }
            await emit(client, row.id, 'refund-recorded:' + existing.id, 'refund.effect_recorded', {
              orderId: row.id,
              refundId: refund.id,
              effectId: existing.id,
              amountMinor: event.amountMinor,
            });
          }
        }
      } else {
        const rank: Record<string, number> = { pending: 0, unknown: 1, failed: 2, succeeded: 3 };
        if (rank[event.outcome]! > rank[refund.state]!)
          await client.query('UPDATE commerce_refunds SET state=$2 WHERE id=$1', [
            refund.id,
            event.outcome,
          ]);
        if (
          event.outcome === 'unknown' &&
          refund.state !== 'succeeded' &&
          refund.state !== 'failed'
        )
          await emit(
            client,
            row.id,
            'refund-resolution:' + refund.id,
            'refund.reconcile_requested',
            { refundId: refund.id, accountId: trusted.accountId },
          );
      }
      return reconcile(client, row);
    });
  }
  async observeFiscal(provider: TrustedProvider, input: unknown) {
    const event = parse(FiscalObservationSchema, input);
    return this.observation(provider, 'fiscal', event, async (client, trusted) => {
      const hint = (
        await client.query<FiscalRow>(
          'SELECT * FROM commerce_fiscal_documents WHERE id=$1 AND account_id=$2',
          [event.documentId, trusted.accountId],
        )
      ).rows[0];
      if (!hint) throw new CommerceError('NOT_FOUND');
      const row = await order(client, trusted, hint.order_id);
      const document = (
        await client.query<FiscalRow>('SELECT * FROM commerce_fiscal_documents WHERE id=$1', [
          hint.id,
        ])
      ).rows[0]!;
      if (event.outcome === 'issued') {
        const inserted = await client.query<{ id: string }>(
          'INSERT INTO commerce_fiscal_effects(id,document_id,order_id,account_id,provider_document_id,fiscal_mark,receipt_url,amount_minor,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(account_id,provider_document_id) DO NOTHING RETURNING id',
          [
            randomUUID(),
            document.id,
            row.id,
            trusted.accountId,
            event.providerDocumentId,
            event.fiscalMark,
            event.receiptUrl,
            event.amountMinor,
            event.occurredAt,
          ],
        );
        const existing = (
          await client.query<{ document_id: string; amount_minor: string; fiscal_mark: string }>(
            'SELECT * FROM commerce_fiscal_effects WHERE account_id=$1 AND provider_document_id=$2',
            [trusted.accountId, event.providerDocumentId],
          )
        ).rows[0]!;
        if (
          existing.document_id !== document.id ||
          existing.amount_minor !== event.amountMinor ||
          existing.fiscal_mark !== event.fiscalMark
        )
          await issue(
            client,
            row,
            'fiscal-conflict:' + digest(event.providerDocumentId),
            'FISCAL_REFERENCE_CONFLICT',
            { providerDocumentId: event.providerDocumentId },
          );
        else {
          const count = (
            await client.query<{ count: string }>(
              'SELECT COUNT(*)::text count FROM commerce_fiscal_effects WHERE document_id=$1',
              [document.id],
            )
          ).rows[0]!;
          if (event.amountMinor !== document.amount_minor || Number(count.count) > 1)
            await issue(client, row, 'fiscal-amount:' + document.id, 'UNEXPECTED_FISCAL_EFFECT', {
              documentId: document.id,
            });
          await client.query("UPDATE commerce_fiscal_documents SET state='issued' WHERE id=$1", [
            document.id,
          ]);
          if (inserted.rowCount)
            await emit(client, row.id, 'fiscal-issued:' + document.id, 'fiscal.issued', {
              orderId: row.id,
              documentId: document.id,
              kind: document.kind,
            });
        }
      } else {
        const rank: Record<string, number> = {
          queued: 0,
          pending: 1,
          unknown: 2,
          failed: 3,
          issued: 4,
        };
        if (rank[event.outcome]! > rank[document.state]!)
          await client.query('UPDATE commerce_fiscal_documents SET state=$2 WHERE id=$1', [
            document.id,
            event.outcome,
          ]);
        if (
          event.outcome === 'unknown' &&
          document.state !== 'issued' &&
          document.state !== 'failed'
        )
          await emit(
            client,
            row.id,
            'fiscal-resolution:' + document.id,
            'fiscal.reconcile_requested',
            { documentId: document.id, accountId: trusted.accountId },
          );
      }
      return reconcile(client, row);
    });
  }
  async readOrder(scopeInput: CommerceScope, id: string) {
    const scope = parse(ScopeSchema, scopeInput);
    parse(UUIDSchema, id);
    return transaction(this.pool, async (client) => {
      const row = await order(
        client,
        scope,
        id,
        scope.role === 'manager' ? undefined : scope.principalId,
      );
      return {
        orderId: row.id,
        quoteId: row.quote_id,
        branchId: row.branch_id,
        owner: 'cloud',
        state: row.state,
        version: row.version,
        totalMinor: row.total_minor,
        currency: row.currency,
        snapshot: row.snapshot,
        attentionRequired: row.attention_required,
        kitchenEffectId: row.kitchen_effect_id,
        fiscalPolicy: row.fiscal_policy,
        money: await totals(client, id),
        attempts: (
          await client.query<AttemptRow>(
            'SELECT * FROM commerce_payment_attempts WHERE order_id=$1 ORDER BY created_at,id',
            [id],
          )
        ).rows,
        captures: (
          await client.query(
            'SELECT * FROM commerce_captures WHERE order_id=$1 ORDER BY received_at,id',
            [id],
          )
        ).rows,
        refunds: (
          await client.query<RefundRow>(
            'SELECT * FROM commerce_refunds WHERE order_id=$1 ORDER BY created_at,id',
            [id],
          )
        ).rows,
        fiscalDocuments: (
          await client.query<FiscalRow>(
            'SELECT * FROM commerce_fiscal_documents WHERE order_id=$1 ORDER BY created_at,id',
            [id],
          )
        ).rows,
        issues: (
          await client.query(
            'SELECT code,details FROM commerce_reconciliation_issues WHERE order_id=$1 ORDER BY created_at,id',
            [id],
          )
        ).rows,
      };
    });
  }
  /** Internal branch worker: leasing is at-least-once; adapters must reconcile timeouts. */
  async claimOutbox(scopeInput: CommerceScope, input: unknown) {
    const scope = parse(ScopeSchema, scopeInput),
      request = parse(LeaseSchema, input);
    if (scope.role !== 'manager') throw new CommerceError('FORBIDDEN');
    return transaction(this.pool, async (client) => {
      await boundary(client, scope);
      const token = randomUUID();
      return (
        await client.query(
          `WITH selected AS (
        SELECT e.id FROM commerce_outbox e JOIN commerce_orders o ON o.id=e.order_id
        WHERE o.organization_id=$1 AND o.branch_id=$2 AND e.acknowledged_at IS NULL AND (e.lease_until IS NULL OR e.lease_until<clock_timestamp())
        AND (e.event_type NOT IN ('edge.admission_requested','edge.kitchen_admission_requested','edge.admission_release_requested') OR NOT EXISTS (SELECT 1 FROM fulfillment_transport_bindings b WHERE b.branch_id=o.branch_id))
        AND (e.event_type NOT IN ('payment.submit_requested','edge.kitchen_admission_requested') OR NOT EXISTS(SELECT 1 FROM commerce_cancellation_intents i WHERE i.order_id=o.id))
        AND (e.event_type NOT IN ('payment.submit_requested','refund.submit_requested','fiscal.submit_requested','edge.kitchen_admission_requested') OR NOT o.attention_required)
        AND (e.event_type NOT IN ('payment.submit_requested','refund.submit_requested','fiscal.submit_requested') OR EXISTS(SELECT 1 FROM commerce_provider_accounts a WHERE a.id=(e.payload->>'accountId')::uuid AND a.enabled))
        AND (e.event_type<>'payment.submit_requested' OR EXISTS(SELECT 1 FROM commerce_payment_attempts a WHERE a.id=(e.payload->>'attemptId')::uuid AND a.state='pending'))
        AND (e.event_type<>'refund.submit_requested' OR EXISTS(SELECT 1 FROM commerce_refunds r WHERE r.id=(e.payload->>'refundId')::uuid AND r.state='pending'))
        AND (e.event_type<>'fiscal.submit_requested' OR EXISTS(SELECT 1 FROM commerce_fiscal_documents d WHERE d.id=(e.payload->>'documentId')::uuid AND d.state IN ('queued','pending')))
        AND (e.event_type<>'edge.kitchen_admission_requested' OR NOT EXISTS(SELECT 1 FROM commerce_refunds r WHERE r.order_id=o.id AND r.state<>'failed'))
        AND (e.event_type<>'edge.kitchen_admission_requested' OR EXISTS(SELECT 1 FROM devices d WHERE d.id=o.admission_device_id AND d.branch_id=o.branch_id AND d.status='active'))
        ORDER BY e.sequence LIMIT $3 FOR UPDATE OF e SKIP LOCKED)
        UPDATE commerce_outbox e SET lease_worker=$4,lease_token=$5,lease_until=clock_timestamp()+$6*interval '1 second',attempts=attempts+1
        FROM selected s WHERE e.id=s.id RETURNING e.*`,
          [
            scope.organizationId,
            scope.branchId,
            request.limit,
            request.workerId,
            token,
            request.leaseSeconds,
          ],
        )
      ).rows;
    });
  }
  async acknowledgeOutbox(scopeInput: CommerceScope, input: unknown) {
    const scope = parse(ScopeSchema, scopeInput),
      request = parse(AckSchema, input);
    if (scope.role !== 'manager') throw new CommerceError('FORBIDDEN');
    const result = await this.pool.query(
      `UPDATE commerce_outbox e SET acknowledged_at=COALESCE(e.acknowledged_at,clock_timestamp()) FROM commerce_orders o WHERE e.order_id=o.id AND o.organization_id=$1 AND o.branch_id=$2 AND e.id=$3 AND (e.event_type NOT IN ('edge.admission_requested','edge.kitchen_admission_requested','edge.admission_release_requested') OR NOT EXISTS (SELECT 1 FROM fulfillment_transport_bindings b WHERE b.branch_id=o.branch_id)) AND e.lease_worker=$4 AND e.lease_token=$5 AND (e.lease_until>clock_timestamp() OR e.acknowledged_at IS NOT NULL) RETURNING e.id`,
      [scope.organizationId, scope.branchId, request.eventId, request.workerId, request.leaseToken],
    );
    if (!result.rowCount) throw new CommerceError('CONFLICT');
    return { eventId: request.eventId, acknowledged: true };
  }
}
