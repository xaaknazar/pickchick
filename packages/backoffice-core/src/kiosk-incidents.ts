import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabasePool, type DatabaseClient } from '@pickchick/database';
import { catalogHash } from '@pickchick/catalog-admin';
import { digest } from '@pickchick/commerce-core';
import { BackofficeError, parse } from './model.js';

export const KIOSK_INCIDENTS = Symbol('KIOSK_INCIDENTS');
/** The QR attempt must be at least this old: a fresh attempt may still resolve on its own. */
export const KIOSK_INCIDENT_MIN_AGE_MINUTES = 15;

const Accept = z.strictObject({
  request_id: z.uuid(),
  order_id: z.uuid(),
  attempt_id: z.uuid(),
  reason: z.enum(['bank_identity_lost', 'bank_result_unknown']),
  note: z.string().trim().min(3).max(500),
  // Explicit operator acknowledgement: nothing is declared paid or failed.
  confirm: z.literal('payment_result_remains_unknown'),
});
type Actor = { id: string; organization_id: string; role: 'manager' | 'analyst' };
type Candidate = {
  order_id: string;
  attempt_id: string;
  account_id: string;
  session_id: string;
  organization_id: string;
  total_minor: string;
  order_state: string;
  attempt_state: string;
  qr_state: string;
  has_operation_id: boolean;
  issue_started_at: Date;
  created_at: Date;
};
const fail = (code: ConstructorParameters<typeof BackofficeError>[0]): never => {
  throw new BackofficeError(code);
};
// Only kiosk QR attempts whose bank result is still open and nothing else is pending.
const CANDIDATES = `SELECT o.id order_id,a.id attempt_id,a.account_id,o.principal_id session_id,o.organization_id,
  o.total_minor::text total_minor,o.state order_state,a.state attempt_state,q.state qr_state,
  q.operation_id IS NOT NULL has_operation_id,q.issue_started_at,o.created_at
 FROM commerce_orders o
 JOIN commerce_payment_attempts a ON a.order_id=o.id AND a.state IN ('pending','unknown')
 JOIN commerce_kiosk_kaspi_qr q ON q.attempt_id=a.id AND q.state IN ('issuing','unknown')
 WHERE o.branch_id=$1 AND o.customer_id IS NULL AND o.snapshot->>'channel'='kiosk'
  AND q.issue_started_at<=clock_timestamp()-make_interval(mins=>${KIOSK_INCIDENT_MIN_AGE_MINUTES})
  AND NOT EXISTS(SELECT 1 FROM commerce_kiosk_payment_incidents h WHERE h.order_id=o.id)
  AND NOT EXISTS(SELECT 1 FROM commerce_captures c WHERE c.order_id=o.id)
  AND NOT EXISTS(SELECT 1 FROM commerce_refunds r WHERE r.order_id=o.id)`;

/**
 * Hands an unresolved kiosk QR payment to staff. Only a branch manager may accept it; the
 * attempt, QR row and order are never modified, so a late bank result still attaches only to
 * the original order. The accepted incident lets the kiosk end that guest session.
 */
export class KioskPaymentIncidents {
  constructor(
    private readonly pool: DatabasePool,
    private readonly enabled = false,
  ) {}
  private async scope(db: DatabaseClient, token: string, branch: string, write: boolean) {
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
  async list(token: string, branch: string) {
    return transaction(this.pool, async (db) => {
      await this.scope(db, token, branch, false);
      const candidates = (
        await db.query<Candidate>(CANDIDATES + ' ORDER BY o.created_at', [branch])
      ).rows;
      const accepted = (
        await db.query(
          `SELECT h.order_id,h.attempt_id,h.reason,h.note,h.accepted_at,m.name accepted_by_name,a.state attempt_state
           FROM commerce_kiosk_payment_incidents h JOIN catalog_managers m ON m.id=h.accepted_by
           JOIN commerce_payment_attempts a ON a.id=h.attempt_id
           WHERE h.branch_id=$1 ORDER BY h.accepted_at DESC LIMIT 100`,
          [branch],
        )
      ).rows;
      return {
        min_age_minutes: KIOSK_INCIDENT_MIN_AGE_MINUTES,
        // Guest session and account ids stay server-side.
        candidates: candidates.map((r) => ({
          order_id: r.order_id,
          attempt_id: r.attempt_id,
          total_minor: r.total_minor,
          order_state: r.order_state,
          attempt_state: r.attempt_state,
          qr_state: r.qr_state,
          has_operation_id: r.has_operation_id,
          issue_started_at: r.issue_started_at,
          created_at: r.created_at,
        })),
        accepted,
      };
    });
  }
  async accept(token: string, branch: string, input: unknown) {
    const req = parse(Accept, input);
    return transaction(this.pool, async (db) => {
      const actor = await this.scope(db, token, branch, true);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'bo:actor:' + actor.id + ':' + req.request_id,
      ]);
      const hash = digest({ branch, kind: 'kiosk_payment_incident', ...req });
      const previous = (
        await db.query(
          'SELECT digest,result FROM bo_commands WHERE actor_id=$1 AND request_id=$2',
          [actor.id, req.request_id],
        )
      ).rows[0];
      if (previous) return previous.digest === hash ? previous.result : fail('CONFLICT');
      const peek = (
        await db.query<{ principal_id: string }>(
          "SELECT principal_id FROM commerce_orders WHERE id=$1 AND branch_id=$2 AND organization_id=$3 AND customer_id IS NULL AND snapshot->>'channel'='kiosk'",
          [req.order_id, branch, actor.organization_id],
        )
      ).rows[0];
      if (!peek) return fail('NOT_FOUND');
      // Same key as KioskSessions.withLock: serializes with guest payment, creation and end.
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('kiosk-session:' || $1::text, 0))",
        [peek.principal_id],
      );
      await db.query('SELECT 1 FROM commerce_orders WHERE id=$1 FOR UPDATE', [req.order_id]);
      const row = (
        await db.query<Candidate>(CANDIDATES + ' AND o.id=$2 AND a.id=$3', [
          branch,
          req.order_id,
          req.attempt_id,
        ])
      ).rows[0];
      if (!row || row.organization_id !== actor.organization_id) return fail('CONFLICT');
      const observed = {
        order_state: row.order_state,
        attempt_state: row.attempt_state,
        qr_state: row.qr_state,
        has_operation_id: row.has_operation_id,
        issue_started_at: row.issue_started_at.toISOString(),
        total_minor: row.total_minor,
      };
      const incident = (
        await db.query(
          `INSERT INTO commerce_kiosk_payment_incidents(attempt_id,order_id,account_id,organization_id,branch_id,session_id,accepted_by,request_id,reason,note,observed)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING attempt_id,order_id,reason,note,accepted_at`,
          [
            row.attempt_id,
            row.order_id,
            row.account_id,
            row.organization_id,
            branch,
            row.session_id,
            actor.id,
            req.request_id,
            req.reason,
            req.note,
            observed,
          ],
        )
      ).rows[0];
      // Same JSON shape as a replay served from bo_commands.
      const result = JSON.parse(
        JSON.stringify({
          incident,
          order_state: row.order_state,
          attempt_state: row.attempt_state,
          qr_state: row.qr_state,
          kiosk: 'session_end_allowed',
        }),
      );
      await db.query(
        `INSERT INTO bo_audit(id,branch_id,organization_id,actor_id,request_id,action,entity_id,reason,before_value,after_value)
         VALUES($1,$2,$3,$4,$5,'kiosk_payment_incident',$6,$7,$8,$9)`,
        [
          randomUUID(),
          branch,
          actor.organization_id,
          actor.id,
          req.request_id,
          req.order_id,
          req.note,
          observed,
          result,
        ],
      );
      await db.query(
        'INSERT INTO bo_commands(actor_id,request_id,branch_id,digest,result) VALUES($1,$2,$3,$4,$5)',
        [actor.id, req.request_id, branch, hash, result],
      );
      return result;
    });
  }
}
