import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabasePool, type DatabaseClient } from '@pickchick/database';
import { catalogHash } from '@pickchick/catalog-admin';
import { CommerceRepository, CommerceError, digest } from '@pickchick/commerce-core';
import {
  BackofficeError as ErrorCode,
  parse,
  Query,
  Request,
  Schemas,
  Recipe,
  type Kind,
  periodStart,
  stockEffect,
} from './model.js';
export * from './model.js';
export const BACKOFFICE = Symbol('BACKOFFICE');
type Actor = { id: string; organization_id: string; role: 'manager' | 'analyst' };
type Row = {
  id: string;
  kind: Kind;
  revision: number;
  payload: Record<string, unknown>;
  updated_at: Date;
};
const fail = (code: ConstructorParameters<typeof ErrorCode>[0]): never => {
  throw new ErrorCode(code);
};
/** Explicit trusted grant. A catalog token alone never grants new operational powers. */
export async function grantBackoffice(
  pool: DatabasePool,
  actorId: string,
  branchId: string,
  role: 'manager' | 'analyst',
) {
  parse(z.uuid(), actorId);
  parse(z.uuid(), branchId);
  parse(z.enum(['manager', 'analyst']), role);
  await transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'bo:grant:' + actorId + ':' + branchId,
    ]);
    const old = (
      await db.query('SELECT role FROM bo_access_grants WHERE actor_id=$1 AND branch_id=$2', [
        actorId,
        branchId,
      ])
    ).rows[0];
    await db.query(
      'INSERT INTO bo_access_grants(actor_id,branch_id,role) VALUES($1,$2,$3) ON CONFLICT(actor_id,branch_id) DO UPDATE SET role=excluded.role',
      [actorId, branchId, role],
    );
    await db.query(
      'INSERT INTO bo_access_audit(id,actor_id,branch_id,previous_role,role) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), actorId, branchId, old?.role ?? null, role],
    );
  });
}
export class Backoffice {
  constructor(
    private pool: DatabasePool,
    private enabled = false,
  ) {}
  private async scope(
    db: DatabaseClient,
    token: string,
    branch: string,
    write = false,
  ): Promise<Actor> {
    if (!this.enabled) fail('SERVICE_UNAVAILABLE');
    parse(z.uuid(), branch);
    if (!/^[a-f0-9]{64}$/.test(token)) fail('UNAUTHORIZED');
    const actor = (
      await db.query<Actor>(
        'SELECT id,organization_id FROM catalog_managers WHERE token_hash=$1 AND revoked_at IS NULL FOR SHARE',
        [catalogHash(token)],
      )
    ).rows[0];
    if (!actor) return fail('UNAUTHORIZED');
    const grant = (
      await db.query<{ role: Actor['role'] }>(
        'SELECT g.role FROM bo_access_grants g JOIN catalog_manager_branches s ON s.actor_id=g.actor_id AND s.branch_id=g.branch_id WHERE g.actor_id=$1 AND g.branch_id=$2 AND s.organization_id=$3 FOR SHARE OF g,s',
        [actor.id, branch, actor.organization_id],
      )
    ).rows[0];
    if (!grant || (write && grant.role !== 'manager')) return fail('FORBIDDEN');
    return { ...actor, role: grant.role };
  }
  async content(branch: string, channel: string) {
    parse(z.uuid(), branch);
    parse(z.enum(['mobile', 'kiosk', 'display']), channel);
    if (!this.enabled) return { schema_version: 1, branch_id: branch, promos: [], games: [] };
    const rows = (
      await this.pool.query(
        `SELECT DISTINCT ON(kind,record_id) record_id,kind,revision,payload,published_at FROM bo_publications WHERE branch_id=$1 AND kind IN ('promo','game') ORDER BY kind,record_id,revision DESC`,
        [branch],
      )
    ).rows;
    const now = Date.now();
    const inWindow = (p: { schedule: { starts_at: string; ends_at: string } }) =>
      Date.parse(p.schedule.starts_at) <= now && Date.parse(p.schedule.ends_at) > now;
    const promos = rows
      .filter((r) => r.kind === 'promo')
      .map((r) => ({ id: r.record_id, revision: r.revision, ...parse(Schemas.promo, r.payload) }))
      .filter(
        (p) =>
          p.status === 'active' &&
          p.channels.includes(channel as 'mobile' | 'kiosk' | 'display') &&
          inWindow(p),
      );
    const games = rows
      .filter((r) => r.kind === 'game')
      .map((r) => {
        const p = parse(Schemas.game, r.payload);
        return { template: p.template, enabled: p.enabled && inWindow(p), revision: r.revision };
      });
    return { schema_version: 1, branch_id: branch, promos: promos.slice(0, 20), games };
  }
  async read(token: string, branch: string, input: unknown = {}) {
    const q = parse(Query, input);
    return transaction(this.pool, async (db) => {
      // One coherent snapshot for metrics, documents and their balances.
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const actor = await this.scope(db, token, branch);
      const now = new Date(),
        start = periodStart(q.period, now);
      const rows = async (sql: string, args: unknown[] = [branch]) =>
        (await db.query(sql, args)).rows;
      const records = await rows(
        'SELECT id,kind,revision,payload,updated_at FROM bo_records WHERE branch_id=$1 ORDER BY kind,updated_at DESC,id LIMIT 2000',
      );
      const stock = await rows(
        `SELECT r.id,r.payload,b.quantity::text,b.value_minor::text,b.revision FROM bo_records r LEFT JOIN bo_stock_balances b ON b.branch_id=r.branch_id AND b.ingredient_id=r.id WHERE r.branch_id=$1 AND r.kind='ingredient' ORDER BY r.payload->>'name',r.id`,
      );
      const orders = await rows(
        `SELECT o.id,o.created_at,o.total_minor::text,o.version::text,o.state,o.snapshot->>'channel' channel,'cloud' owner,p.state payment_state,f.state kitchen_state,f.observed_at,
    (SELECT coalesce(sum(c.amount_minor),0)::text FROM commerce_captures c WHERE c.order_id=o.id) captured_minor,
    (SELECT coalesce(sum(r.amount_minor),0)::text FROM commerce_refund_effects r WHERE r.order_id=o.id) refunded_minor
    FROM commerce_orders o LEFT JOIN commerce_payment_intents p ON p.order_id=o.id LEFT JOIN cloud_fulfillment_projection f ON f.order_id=o.id WHERE o.branch_id=$1 AND o.created_at >= $2 ORDER BY o.created_at DESC,o.id LIMIT 200`,
        [branch, start],
      );
      const pos = await rows(
        `SELECT p.order_id id,p.first_observed_at created_at,p.total_minor::text,p.version::text,p.state,'pos' channel,p.commercial_owner owner,p.payment_state,coalesce(k.state,p.fulfillment_state) kitchen_state,coalesce(k.observed_at,p.updated_at) observed_at,p.execution_mode FROM pos_order_sync_projection p LEFT JOIN pos_kitchen_sync_projection k ON k.order_id=p.order_id AND k.branch_id=p.branch_id WHERE p.branch_id=$1 AND p.first_observed_at >= $2 ORDER BY p.first_observed_at DESC,p.order_id LIMIT 200`,
        [branch, start],
      );
      const metrics = (
        await rows(
          `SELECT
    (SELECT count(*)::int FROM commerce_orders WHERE branch_id=$1 AND created_at >= $2) orders,
    (SELECT count(*)::int FROM cloud_fulfillment_projection f JOIN commerce_orders o ON o.id=f.order_id WHERE o.branch_id=$1 AND o.created_at >= $2 AND f.state='handed_over') handed_over,
    (SELECT coalesce(sum(c.amount_minor),0)::text FROM commerce_captures c JOIN commerce_orders o ON o.id=c.order_id WHERE o.branch_id=$1 AND c.occurred_at >= $2) captured_minor,
    (SELECT coalesce(sum(r.amount_minor),0)::text FROM commerce_refund_effects r JOIN commerce_orders o ON o.id=r.order_id WHERE o.branch_id=$1 AND r.occurred_at >= $2) refunded_minor,
    (SELECT count(*)::int FROM commerce_payment_attempts p JOIN commerce_orders o ON o.id=p.order_id WHERE o.branch_id=$1 AND p.state='unknown') unknown_payments,
    ((SELECT count(*)::int FROM cloud_fulfillment_projection WHERE branch_id=$1 AND state IN ('accepted','in_production')) + (SELECT count(*)::int FROM pos_kitchen_sync_projection WHERE branch_id=$1 AND state IN ('accepted','in_production'))) kitchen_active,
    (SELECT count(*)::int FROM pos_order_sync_projection WHERE branch_id=$1 AND first_observed_at >= $2) pos_orders,
    (SELECT coalesce(sum(o.total_minor),0)::text FROM commerce_orders o JOIN cloud_fulfillment_projection f ON f.order_id=o.id WHERE o.branch_id=$1 AND o.created_at >= $2 AND f.state='handed_over') completed_total_minor`,
          [branch, start],
        )
      )[0];
      const chart = await rows(
        `SELECT (c.occurred_at AT TIME ZONE 'Asia/Almaty')::date::text AS "day",sum(c.amount_minor)::text amount_minor FROM commerce_captures c JOIN commerce_orders o ON o.id=c.order_id WHERE o.branch_id=$1 AND c.occurred_at >= $2 GROUP BY 1 ORDER BY 1`,
        [branch, start],
      );
      const finance = await rows(
        `SELECT d.id,d.order_id,d.kind,d.amount_minor::text,d.state,d.created_at FROM commerce_fiscal_documents d JOIN commerce_orders o ON o.id=d.order_id WHERE o.branch_id=$1 ORDER BY d.created_at DESC,d.id LIMIT 200`,
      );
      const refunds = await rows(
        `SELECT r.id,r.order_id,r.amount_minor::text,r.state,r.reason,r.created_at FROM commerce_refunds r JOIN commerce_orders o ON o.id=r.order_id WHERE o.branch_id=$1 ORDER BY r.created_at DESC,r.id LIMIT 200`,
      );
      const issues = await rows(
        'SELECT r.id,r.order_id,r.code,r.created_at FROM commerce_reconciliation_issues r JOIN commerce_orders o ON o.id=r.order_id WHERE o.branch_id=$1 ORDER BY r.created_at DESC,r.id LIMIT 100',
      );
      const devices = await rows(`SELECT d.id,d.name,d.kind,d.status,
    (SELECT max(received_at) FROM cloud_fulfillment_inbox i WHERE i.device_id=d.id) last_fulfillment_at,
    greatest((SELECT max(received_at) FROM pos_order_sync_inbox p WHERE p.device_id=d.id),(SELECT max(received_at) FROM pos_kitchen_sync_inbox p WHERE p.device_id=d.id)) last_pos_at
    FROM devices d WHERE d.branch_id=$1 ORDER BY d.name,d.id`);
      const kitchen = await rows(
        `SELECT * FROM (SELECT f.order_id,f.state,f.version,f.display_number::text,f.routing_version,f.assembly_station_id,f.observed_at,'cloud' commercial_owner FROM cloud_fulfillment_projection f WHERE f.branch_id=$1 UNION ALL SELECT k.order_id,k.state,k.version,k.display_number::text,k.routing_version,k.assembly_station_id,k.observed_at,'edge_pos' commercial_owner FROM pos_kitchen_sync_projection k WHERE k.branch_id=$1) observations ORDER BY observed_at DESC,order_id LIMIT 200`,
      );
      const guests =
        await rows(`SELECT c.id,c.created_at,count(o.id)::int orders,max(o.created_at) last_order_at,
    coalesce((SELECT i.accepted FROM identity_consents i WHERE i.customer_id=c.id AND i.kind='marketing' ORDER BY i.recorded_at DESC,i.id DESC LIMIT 1),false) marketing_consent
    FROM identity_customers c JOIN commerce_orders o ON o.customer_id=c.id WHERE o.branch_id=$1 AND c.deleted_at IS NULL GROUP BY c.id ORDER BY max(o.created_at) DESC,c.id LIMIT 200`);
      const audit = await rows(
        'SELECT id,actor_id,action,entity_id,reason,created_at FROM bo_audit WHERE branch_id=$1 ORDER BY created_at DESC,id LIMIT 200',
      );
      const catalog_audit = await rows(
        'SELECT id,actor_id,action,occurred_at created_at FROM catalog_audit WHERE branch_id=$1 ORDER BY occurred_at DESC,id LIMIT 100',
      );
      const documents = await rows(
        'SELECT id,kind,reference,reason,order_id,created_at FROM bo_stock_documents WHERE branch_id=$1 ORDER BY created_at DESC,id LIMIT 200',
      );
      const publications = await rows(
        `SELECT DISTINCT ON(kind,record_id) id,kind,record_id,revision,published_at,payload FROM bo_publications WHERE branch_id=$1 ORDER BY kind,record_id,revision DESC`,
      );
      return {
        schema_version: 1,
        branch_id: branch,
        role: actor.role,
        as_of: now.toISOString(),
        period_start: start.toISOString(),
        period: q.period,
        records,
        stock,
        orders,
        pos,
        metrics,
        chart,
        finance,
        refunds,
        issues,
        devices,
        kitchen,
        guests,
        audit,
        catalog_audit,
        documents,
        publications,
        limits: { orders: 200, records: 2000 },
        capabilities: {
          bank_settlement: false,
          push_delivery: false,
          external_reviews: false,
          fiscal_shift: false,
          edge_configuration_delivery: false,
        },
      };
    });
  }
  async order(token: string, branch: string, id: string) {
    parse(z.uuid(), id);
    return transaction(this.pool, async (db) => {
      await this.scope(db, token, branch);
      const o = (
        await db.query(
          'SELECT id,snapshot,state,version::text,total_minor::text,created_at FROM commerce_orders WHERE id=$1 AND branch_id=$2',
          [id, branch],
        )
      ).rows[0];
      if (!o) {
        const pos = (
          await db.query(
            'SELECT p.order_id id,p.snapshot,p.state,p.version,p.total_minor::text,p.payment_state,p.fiscal_state,p.execution_mode,coalesce(k.state,p.fulfillment_state) kitchen_state,k.version kitchen_version,k.observed_at FROM pos_order_sync_projection p LEFT JOIN pos_kitchen_sync_projection k ON k.order_id=p.order_id AND k.branch_id=p.branch_id WHERE p.order_id=$1 AND p.branch_id=$2',
            [id, branch],
          )
        ).rows[0];
        if (!pos) return fail('NOT_FOUND');
        const events = (
          await db.query(
            `SELECT event_id,envelope->>'event_type' event_type,aggregate_version,received_at,'order_commercial' aggregate_type,envelope->'payload'->>'state' state,NULL::text task_state FROM pos_order_sync_inbox WHERE order_id=$1 AND branch_id=$2
           UNION ALL SELECT event_id,event_type,aggregate_version,received_at,'order_fulfillment' aggregate_type,envelope->'payload'->>'state' state,envelope->'payload'->>'taskState' task_state FROM pos_kitchen_sync_inbox WHERE order_id=$1 AND branch_id=$2
           ORDER BY received_at,event_id LIMIT 500`,
            [id, branch],
          )
        ).rows;
        return { order: pos, owner: 'edge', captures: [], refunds: [], fiscal: [], events };
      }
      const captures = (
        await db.query(
          'SELECT id,amount_minor::text,occurred_at FROM commerce_captures WHERE order_id=$1 ORDER BY occurred_at',
          [id],
        )
      ).rows;
      const refunds = (
        await db.query(
          'SELECT id,amount_minor::text,state,reason,created_at FROM commerce_refunds WHERE order_id=$1 ORDER BY created_at',
          [id],
        )
      ).rows;
      const fiscal = (
        await db.query(
          'SELECT id,kind,amount_minor::text,state FROM commerce_fiscal_documents WHERE order_id=$1',
          [id],
        )
      ).rows;
      const events = (
        await db.query(
          'SELECT event_id,event_type,aggregate_version,received_at FROM cloud_fulfillment_inbox WHERE order_id=$1 ORDER BY aggregate_version,received_at LIMIT 500',
          [id],
        )
      ).rows;
      return { order: o, owner: 'cloud', captures, refunds, fiscal, events };
    });
  }
  async command(token: string, branch: string, input: unknown) {
    const req = parse(Request, input);
    try {
      return await transaction(this.pool, async (db) => {
        const actor = await this.scope(db, token, branch, true);
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'bo:actor:' + actor.id + ':' + req.request_id,
        ]);
        const hash = digest({ branch, ...req });
        const previous = (
          await db.query(
            'SELECT digest,result FROM bo_commands WHERE actor_id=$1 AND request_id=$2',
            [actor.id, req.request_id],
          )
        ).rows[0];
        if (previous) {
          if (previous.digest !== hash) return fail('CONFLICT');
          return previous.result;
        }
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'bo:branch:' + branch,
        ]);
        const c = req.command;
        let result: unknown;
        let before: unknown = null;
        let entity: string | null;
        if (c.type === 'save') {
          const payload = parse(Schemas[c.kind] as z.ZodType<Record<string, unknown>>, c.payload);
          const old = (
            await db.query<Row>(
              'SELECT * FROM bo_records WHERE branch_id=$1 AND kind=$2 AND id=$3 FOR UPDATE',
              [branch, c.kind, c.id],
            )
          ).rows[0];
          if ((old?.revision ?? 0) !== c.expected_revision) return fail('CONFLICT');
          before = old?.payload ?? null;
          entity = c.id;
          await this.validateRecord(db, branch, c.kind, payload, old);
          result = (
            await db.query(
              'INSERT INTO bo_records(id,branch_id,organization_id,kind,revision,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(branch_id,kind,id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=clock_timestamp() RETURNING id,kind,revision,payload,updated_at',
              [c.id, branch, actor.organization_id, c.kind, c.expected_revision + 1, payload],
            )
          ).rows[0];
          if (c.kind === 'ingredient')
            await db.query(
              'INSERT INTO bo_stock_balances(branch_id,ingredient_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
              [branch, c.id],
            );
        } else if (c.type === 'publish') {
          const row = (
            await db.query<Row>(
              'SELECT * FROM bo_records WHERE branch_id=$1 AND kind=$2 AND id=$3',
              [branch, c.kind, c.id],
            )
          ).rows[0];
          if (!row) return fail('NOT_FOUND');
          if (row.revision !== c.expected_revision) return fail('CONFLICT');
          if (c.kind === 'promo' && row.payload['status'] === 'draft') return fail('NOT_READY');
          entity = c.id;
          const publication = randomUUID();
          result = (
            await db.query(
              'INSERT INTO bo_publications(id,branch_id,organization_id,record_id,kind,revision,payload,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(branch_id,kind,record_id,revision) DO NOTHING RETURNING id,revision,published_at',
              [
                publication,
                branch,
                actor.organization_id,
                c.id,
                c.kind,
                c.expected_revision,
                row.payload,
                actor.id,
              ],
            )
          ).rows[0];
          if (!result) return fail('CONFLICT');
          await db.query(
            'INSERT INTO bo_delivery_outbox(id,branch_id,kind,payload) VALUES($1,$2,$3,$4)',
            [publication, branch, c.kind, row.payload],
          );
        } else if (c.type === 'stock') {
          result = await this.stock(db, branch, actor, req.reason, c.kind, c.reference, c.lines);
          entity = (result as { id: string }).id;
        } else if (c.type === 'produce' || c.type === 'consume') {
          result = await this.production(db, branch, actor, req.reason, c);
          entity = (result as { id: string }).id;
        } else if (c.type === 'revoke_device') {
          const d = (
            await db.query(
              'SELECT id,status FROM devices WHERE id=$1 AND branch_id=$2 FOR UPDATE',
              [c.id, branch],
            )
          ).rows[0];
          if (!d) return fail('NOT_FOUND');
          before = d;
          entity = c.id;
          await db.query("UPDATE devices SET status='revoked' WHERE id=$1", [c.id]);
          result = { id: c.id, status: 'revoked' };
        } else {
          entity = c.id;
          const o = (
            await db.query(
              'SELECT id,version FROM commerce_orders WHERE id=$1 AND branch_id=$2 FOR UPDATE',
              [c.id, branch],
            )
          ).rows[0];
          if (!o) return fail('NOT_FOUND');
          const scope = {
            organizationId: actor.organization_id,
            branchId: branch,
            principalId: actor.id,
            role: 'manager' as const,
          };
          const commerce = new CommerceRepository(this.pool);
          if (c.type === 'cancel_order') {
            if (Number(o.version) !== c.expected_version) return fail('CONFLICT');
            result = await commerce.requestUnpaidCancellation(
              scope,
              req.request_id,
              { orderId: c.id, reason: req.reason },
              db,
            );
          } else
            result = await commerce.requestRefund(
              scope,
              req.request_id,
              {
                orderId: c.id,
                captureId: c.capture_id,
                amountMinor: c.amount_minor,
                reason: req.reason,
                fulfillmentPolicy: 'manager_reviewed',
              },
              db,
            );
        }
        await db.query(
          'INSERT INTO bo_audit(id,branch_id,organization_id,actor_id,request_id,action,entity_id,reason,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            randomUUID(),
            branch,
            actor.organization_id,
            actor.id,
            req.request_id,
            c.type + ('kind' in c ? ':' + c.kind : ''),
            entity,
            req.reason,
            before,
            result,
          ],
        );
        await db.query(
          'INSERT INTO bo_commands(actor_id,request_id,branch_id,digest,result) VALUES($1,$2,$3,$4,$5)',
          [actor.id, req.request_id, branch, hash, result],
        );
        return result;
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === '23505') throw new ErrorCode('CONFLICT');
        if (['23503', '23514'].includes(String(error.code))) throw new ErrorCode('INVALID_REQUEST');
        if (['40001', '40P01'].includes(String(error.code)))
          throw new ErrorCode('SERVICE_UNAVAILABLE');
      }
      if (error instanceof CommerceError)
        throw new ErrorCode(
          error.code === 'INVALID'
            ? 'INVALID_REQUEST'
            : error.code === 'NOT_READY' || error.code === 'RESTAURANT_CLOSED'
              ? 'NOT_READY'
              : error.code === 'REFUND_LIMIT'
                ? 'CONFLICT'
                : error.code === 'EXPIRED'
                  ? 'CONFLICT'
                  : error.code,
        );
      throw error;
    }
  }
  private async validateRecord(
    db: DatabaseClient,
    branch: string,
    kind: Kind,
    payload: Record<string, unknown>,
    old?: Row,
  ) {
    const exists = async (k: Kind, id: string) =>
      Boolean(
        (
          await db.query('SELECT 1 FROM bo_records WHERE branch_id=$1 AND kind=$2 AND id=$3', [
            branch,
            k,
            id,
          ])
        ).rowCount,
      );
    if (kind === 'game' && old && payload['template'] !== old.payload['template']) fail('CONFLICT');
    if (kind === 'ingredient' && old && payload['unit'] !== old.payload['unit']) fail('CONFLICT');
    if (kind === 'recipe') {
      const p = parse(Recipe, payload);
      for (const l of p.lines)
        if (!(await exists('ingredient', l.ingredient_id))) fail('INVALID_REQUEST');
      if (p.output_ingredient_id && !(await exists('ingredient', p.output_ingredient_id)))
        fail('INVALID_REQUEST');
      if (p.lines.some((l) => l.ingredient_id === p.output_ingredient_id)) fail('INVALID_REQUEST');
      const catalog = (
        await db.query(
          'SELECT v.payload FROM catalog_branch_heads h JOIN catalog_draft_versions v ON v.branch_id=h.branch_id AND v.revision=h.draft_revision WHERE h.branch_id=$1',
          [branch],
        )
      ).rows[0];
      if (
        !p.output_ingredient_id &&
        !catalog?.payload.products.some((v: { id: string }) => v.id === p.product_id)
      )
        fail('INVALID_REQUEST');
    }
    if (kind === 'shift') {
      const p = parse(Schemas.shift, payload),
        previous = old ? parse(Schemas.shift, old.payload) : null;
      if (!(await exists('employee', p.employee_id))) fail('INVALID_REQUEST');
      if (p.closed_at && Date.parse(p.closed_at) < Date.parse(p.opened_at)) fail('INVALID_REQUEST');
      if (Boolean(p.closed_at) !== (p.closing_cash_minor !== null)) fail('INVALID_REQUEST');
      if (
        previous &&
        (previous.closed_at ||
          p.opened_at !== previous.opened_at ||
          p.employee_id !== previous.employee_id ||
          p.opening_cash_minor !== previous.opening_cash_minor)
      )
        fail('CONFLICT');
      if (
        !old &&
        (
          await db.query(
            "SELECT 1 FROM bo_records WHERE branch_id=$1 AND kind='shift' AND payload->>'closed_at' IS NULL",
            [branch],
          )
        ).rowCount
      )
        fail('CONFLICT');
    }
    if (kind === 'ticket') {
      const p = parse(Schemas.ticket, payload);
      if (p.assignee_id && !(await exists('employee', p.assignee_id))) fail('INVALID_REQUEST');
    }
    if (kind === 'ticket' || kind === 'review') {
      if (old?.payload.source === 'mobile_test') {
        for (const field of [
          'source',
          'order_id',
          ...(kind === 'review' ? ['stars', 'text'] : ['description']),
        ]) {
          if (payload[field] !== old.payload[field]) fail('CONFLICT');
        }
      }

      const p = kind === 'ticket' ? parse(Schemas.ticket, payload) : parse(Schemas.review, payload);
      if (
        p.order_id &&
        !(
          await db.query(
            'SELECT 1 FROM commerce_orders WHERE id=$1 AND branch_id=$2 UNION ALL SELECT 1 FROM pos_order_sync_projection WHERE order_id=$1 AND branch_id=$2 UNION ALL SELECT 1 FROM test_orders WHERE id=$1 AND branch_id=$2',
            [p.order_id, branch],
          )
        ).rowCount
      )
        fail('INVALID_REQUEST');
    }
    if (kind === 'station') {
      const p = parse(Schemas.station, payload);
      if (
        p.device_id &&
        !(
          await db.query(
            "SELECT 1 FROM devices WHERE id=$1 AND branch_id=$2 AND kind IN ('kitchen','display') AND status<>'revoked'",
            [p.device_id, branch],
          )
        ).rowCount
      )
        fail('INVALID_REQUEST');
    }
  }

  private async stock(
    db: DatabaseClient,
    branch: string,
    actor: Actor,
    reason: string,
    kind: 'receipt' | 'waste' | 'count',
    reference: string,
    lines: {
      ingredient_id: string;
      quantity: string;
      value_minor: string;
      expected_revision: number;
    }[],
  ) {
    const id = randomUUID();
    await db.query(
      'INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason) VALUES($1,$2,$3,$4,$5,$6)',
      [id, branch, actor.id, kind, reference, reason],
    );
    for (const line of lines) {
      const b = (
        await db.query(
          'SELECT quantity::text,value_minor::text,revision FROM bo_stock_balances WHERE branch_id=$1 AND ingredient_id=$2 FOR UPDATE',
          [branch, line.ingredient_id],
        )
      ).rows[0];
      if (!b) return fail('INVALID_REQUEST');
      if (b.revision !== line.expected_revision) return fail('CONFLICT');
      const e = stockEffect(kind, b, line);
      await this.movement(db, id, branch, line.ingredient_id, e);
    }
    return { id, kind, reference };
  }
  private async movement(
    db: DatabaseClient,
    id: string,
    branch: string,
    ingredient: string,
    e: ReturnType<typeof stockEffect>,
  ) {
    await db.query(
      'UPDATE bo_stock_balances SET quantity=$3,value_minor=$4,revision=revision+1 WHERE branch_id=$1 AND ingredient_id=$2',
      [branch, ingredient, e.quantity, e.value_minor],
    );
    await db.query(
      'INSERT INTO bo_stock_movements(document_id,branch_id,ingredient_id,quantity_delta,value_delta_minor,balance_after,value_after_minor) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, branch, ingredient, e.quantity_delta, e.value_delta_minor, e.quantity, e.value_minor],
    );
  }
  private async production(
    db: DatabaseClient,
    branch: string,
    actor: Actor,
    reason: string,
    c: Extract<z.infer<typeof Request>['command'], { type: 'produce' | 'consume' }>,
  ) {
    const needs = new Map<string, bigint>();
    let output: { id: string; quantity: bigint } | null = null;
    let snapshot: unknown;
    const add = (recipe: z.infer<typeof Recipe>, multiplier: bigint) => {
      for (const l of recipe.lines)
        needs.set(
          l.ingredient_id,
          (needs.get(l.ingredient_id) ?? 0n) + BigInt(l.quantity) * multiplier,
        );
    };
    if (c.type === 'produce') {
      const r = (
        await db.query<Row>(
          "SELECT * FROM bo_records WHERE branch_id=$1 AND kind='recipe' AND id=$2",
          [branch, c.recipe_id],
        )
      ).rows[0];
      if (!r) return fail('NOT_FOUND');
      if (r.revision !== c.recipe_revision) return fail('CONFLICT');
      const recipe = parse(Recipe, r.payload);
      if (!recipe.output_ingredient_id) return fail('INVALID_REQUEST');
      snapshot = r;
      add(recipe, BigInt(c.batches));
      output = {
        id: recipe.output_ingredient_id,
        quantity: BigInt(recipe.yield_quantity) * BigInt(c.batches),
      };
    } else {
      const row = (
        await db.query(
          'SELECT r.snapshot,f.state FROM bo_order_recipes r JOIN cloud_fulfillment_projection f ON f.order_id=r.order_id WHERE r.order_id=$1 AND r.branch_id=$2',
          [c.order_id, branch],
        )
      ).rows[0];
      if (!row || !['in_production', 'ready', 'handed_over'].includes(row.state))
        return fail('NOT_READY');
      if (
        (
          await db.query(
            "SELECT 1 FROM bo_stock_documents WHERE order_id=$1 AND kind='consumption'",
            [c.order_id],
          )
        ).rowCount
      )
        return fail('CONFLICT');
      snapshot = row.snapshot;
      for (const line of row.snapshot) {
        if (!line.recipe) return fail('NOT_READY');
        // Variant and combo norms require a dedicated recipe; never silently use base norms.
        const details = line.selected_details;
        if (
          details &&
          (details.kind === 'combo' || details.modifiers?.length || details.components?.length)
        )
          return fail('NOT_READY');
        add(parse(Recipe, line.recipe), BigInt(line.quantity));
      }
      if (needs.size === 0) return fail('NOT_READY');
    }
    const id = randomUUID();
    await db.query(
      'INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason,order_id,recipe_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        branch,
        actor.id,
        c.type === 'produce' ? 'production' : 'consumption',
        c.type === 'produce' ? c.reference : c.order_id,
        reason,
        c.type === 'consume' ? c.order_id : null,
        JSON.stringify(snapshot),
      ],
    );
    let cost = 0n;
    for (const [ingredient, quantity] of needs) {
      const b = (
        await db.query(
          'SELECT quantity::text,value_minor::text,revision FROM bo_stock_balances WHERE branch_id=$1 AND ingredient_id=$2 FOR UPDATE',
          [branch, ingredient],
        )
      ).rows[0];
      if (!b || b.revision !== c.expected_balances[ingredient]) return fail('CONFLICT');
      const e = stockEffect('waste', b, { quantity: quantity.toString(), value_minor: '0' });
      cost -= BigInt(e.value_delta_minor);
      await this.movement(db, id, branch, ingredient, e);
    }
    if (output) {
      const b = (
        await db.query(
          'SELECT quantity::text,value_minor::text,revision FROM bo_stock_balances WHERE branch_id=$1 AND ingredient_id=$2 FOR UPDATE',
          [branch, output.id],
        )
      ).rows[0];
      if (!b || b.revision !== c.expected_balances[output.id]) return fail('CONFLICT');
      await this.movement(
        db,
        id,
        branch,
        output.id,
        stockEffect('receipt', b, {
          quantity: output.quantity.toString(),
          value_minor: cost.toString(),
        }),
      );
    }
    return { id, kind: c.type === 'produce' ? 'production' : 'consumption' };
  }
}
