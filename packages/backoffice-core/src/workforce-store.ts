import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabasePool, type DatabaseClient } from '@pickchick/database';
import { catalogHash } from '@pickchick/catalog-admin';
import { digest } from '@pickchick/commerce-core';
import { BackofficeError, parse } from './model.js';
import {
  WorkforceRequest,
  WorkforceSchemas,
  WorkMonth,
  WorkTime,
  WorkPlan,
  HourlyRate,
  calculateWorkforce,
  localWorkDate,
  monthWindow,
  type WorkRecord,
} from './workforce.js';

const fail = (code: ConstructorParameters<typeof BackofficeError>[0]): never => {
  throw new BackofficeError(code);
};
type Actor = { id: string; organization_id: string; role: 'manager' | 'analyst' };

/** Disabled until explicitly wired, migrated, provisioned and accepted. */
export class Workforce {
  constructor(
    private pool: DatabasePool,
    private enabled = false,
  ) {}
  private async scope(db: DatabaseClient, token: string, branch: string, write = false) {
    if (!this.enabled) return fail('SERVICE_UNAVAILABLE');
    parse(z.uuid(), branch);
    if (!/^[a-f0-9]{64}$/.test(token)) return fail('UNAUTHORIZED');
    const actor = (
      await db.query<Actor>(
        `SELECT m.id,m.organization_id,g.role FROM catalog_managers m
       JOIN catalog_manager_branches s ON s.actor_id=m.id AND s.organization_id=m.organization_id
       JOIN bo_access_grants g ON g.actor_id=m.id AND g.branch_id=s.branch_id
       WHERE m.token_hash=$1 AND m.revoked_at IS NULL AND s.branch_id=$2 FOR SHARE OF m,s,g`,
        [catalogHash(token), branch],
      )
    ).rows[0];
    if (!actor || (write && actor.role !== 'manager')) return fail('FORBIDDEN');
    return actor;
  }
  private async records(db: DatabaseClient, branch: string): Promise<WorkRecord[]> {
    const rows = (
      await db.query<WorkRecord>(
        'SELECT id,kind,revision,payload FROM bo_workforce_records WHERE branch_id=$1 ORDER BY id LIMIT 10001',
        [branch],
      )
    ).rows;
    if (rows.length > 10000) return fail('NOT_READY'); // Never calculate truncated pay.
    return rows;
  }
  private async snapshot(db: DatabaseClient, branch: string, month: string) {
    const records = await this.records(db, branch);
    const window = monthWindow(month);
    const events = (
      await db.query(
        'SELECT id,employee_id,source,external_id,occurred_at,direction,received_at FROM bo_workforce_events WHERE branch_id=$1 AND occurred_at >= $2 AND occurred_at < $3 ORDER BY occurred_at,id LIMIT 5001',
        [branch, new Date(window.start - 86400000), new Date(window.end + 86400000)],
      )
    ).rows;
    if (events.length > 5000) return fail('NOT_READY');
    const employees = (
      await db.query(
        "SELECT id,revision,payload FROM bo_records WHERE branch_id=$1 AND kind='employee' ORDER BY payload->>'name',id LIMIT 1001",
        [branch],
      )
    ).rows;
    if (employees.length > 1000) return fail('NOT_READY');
    const linked = new Set(
      records
        .filter((r) => r.kind === 'time')
        .flatMap((r) => {
          const p = parse(WorkTime, r.payload);
          return p.status === 'approved' ? p.source_event_ids : [];
        }),
    );
    const unresolved = events.filter((e) => {
      const t = new Date(e.occurred_at).getTime();
      return t >= window.start && t < window.end && !linked.has(e.id);
    });
    const period = (
      await db.query(
        'SELECT closed,revision,snapshot FROM bo_workforce_periods WHERE branch_id=$1 AND month=$2',
        [branch, month],
      )
    ).rows[0] ?? { closed: false, revision: 0, snapshot: null };
    const audit = (
      await db.query(
        "SELECT id,actor_id,action,reason,created_at,before_value,after_value FROM bo_audit WHERE branch_id=$1 AND action LIKE 'workforce.%' ORDER BY created_at DESC,id DESC LIMIT 100",
        [branch],
      )
    ).rows;
    return {
      month,
      timezone: 'Asia/Almaty',
      employees,
      records,
      events,
      unresolved_events: unresolved.length,
      period,
      calculation: calculateWorkforce(month, records),
      audit,
      audit_limit: 100,
      source_status: 'manual_import_only' as const,
    };
  }
  async read(token: string, branch: string, month: string) {
    parse(WorkMonth, month);
    return transaction(this.pool, async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const actor = await this.scope(db, token, branch);
      return { ...(await this.snapshot(db, branch, month)), role: actor.role, branch_id: branch };
    });
  }
  private async employee(db: DatabaseClient, branch: string, employee: string) {
    const found = (
      await db.query(
        "SELECT payload FROM bo_records WHERE branch_id=$1 AND kind='employee' AND id=$2 FOR SHARE",
        [branch, employee],
      )
    ).rows[0];
    if (!found) fail('NOT_FOUND');
  }
  private async unlocked(
    db: DatabaseClient,
    branch: string,
    payload: Record<string, unknown>,
    kind: string,
  ) {
    const closed = (
      await db.query<{ month: string }>(
        'SELECT month::text FROM bo_workforce_periods WHERE branch_id=$1 AND closed',
        [branch],
      )
    ).rows;
    for (const { month } of closed) {
      if (
        kind === 'rate' &&
        String(payload.effective_date) <
          new Date(monthWindow(month).end + 5 * 3600000).toISOString().slice(0, 10)
      )
        fail('CONFLICT');
      if (kind === 'bonus' && payload.month === month) fail('CONFLICT');
      if (
        kind === 'plan' &&
        (localWorkDate(String(payload.start)).slice(0, 7) === month.slice(0, 7) ||
          localWorkDate(String(payload.end)).slice(0, 7) === month.slice(0, 7))
      )
        fail('CONFLICT');
      if (kind === 'time') {
        const time = parse(WorkTime, payload),
          w = monthWindow(month);
        if (
          time.date.slice(0, 7) === month.slice(0, 7) ||
          time.intervals.some((s) => Date.parse(s.start) < w.end && Date.parse(s.end) > w.start)
        )
          fail('CONFLICT');
      }
    }
  }
  async command(token: string, branch: string, input: unknown) {
    const request = parse(WorkforceRequest, input),
      hash = digest({ branch, request });
    return transaction(this.pool, async (db) => {
      const actor = await this.scope(db, token, branch, true);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'workforce-request:' + actor.id + ':' + request.request_id,
      ]);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'workforce:' + branch,
      ]);
      const prior = (
        await db.query(
          'SELECT digest,result FROM bo_workforce_commands WHERE actor_id=$1 AND request_id=$2',
          [actor.id, request.request_id],
        )
      ).rows[0];
      if (prior) {
        if (prior.digest !== hash) return fail('CONFLICT');
        return prior.result;
      }
      const c = request.command;
      let before: unknown = null;
      let result: Record<string, unknown>;
      if (c.type === 'save') {
        const payload = parse(
          WorkforceSchemas[c.kind] as z.ZodType<Record<string, unknown>>,
          c.payload,
        );
        await this.employee(db, branch, String(payload.employee_id));
        const old = (
          await db.query<WorkRecord>(
            'SELECT id,kind,revision,payload FROM bo_workforce_records WHERE branch_id=$1 AND id=$2',
            [branch, c.id],
          )
        ).rows[0];
        if ((old?.revision ?? 0) !== c.expected_revision || (old && old.kind !== c.kind))
          return fail('CONFLICT');
        if (old) {
          const previous = old.payload as Record<string, unknown>;
          if (previous.employee_id !== payload.employee_id) fail('CONFLICT');
          // Rates are effective-dated and immutable; add a future rate instead.
          if (c.kind === 'rate') fail('CONFLICT');
          await this.unlocked(db, branch, previous, c.kind);
        }
        await this.unlocked(db, branch, payload, c.kind);
        const records = await this.records(db, branch);
        const others = records.filter((r) => r.id !== c.id);
        if (c.kind === 'rate') {
          const rate = parse(HourlyRate, payload);
          if (
            others.some(
              (r) =>
                r.kind === 'rate' &&
                (r.payload as Record<string, unknown>).employee_id === rate.employee_id &&
                (r.payload as Record<string, unknown>).effective_date === rate.effective_date,
            )
          )
            fail('CONFLICT');
        }
        if (c.kind === 'plan') {
          const p = parse(WorkPlan, payload);
          if (
            p.status !== 'cancelled' &&
            others.some((r) => {
              if (r.kind !== 'plan') return false;
              const q = parse(WorkPlan, r.payload);
              return (
                q.employee_id === p.employee_id &&
                q.status !== 'cancelled' &&
                Date.parse(p.start) < Date.parse(q.end) &&
                Date.parse(p.end) > Date.parse(q.start)
              );
            })
          )
            fail('CONFLICT');
        }
        if (c.kind === 'time') {
          const time = parse(WorkTime, payload);
          if (
            time.status !== 'voided' &&
            others.some(
              (r) =>
                r.kind === 'time' &&
                (r.payload as Record<string, unknown>).employee_id === time.employee_id &&
                (r.payload as Record<string, unknown>).date === time.date &&
                (r.payload as Record<string, unknown>).status !== 'voided',
            )
          )
            fail('CONFLICT');
          if (time.intervals.some((s) => Date.parse(s.end) > Date.now())) fail('INVALID_REQUEST');
          const linked = (
            await db.query(
              'SELECT id,employee_id,occurred_at FROM bo_workforce_events WHERE branch_id=$1 AND id=ANY($2::uuid[])',
              [branch, time.source_event_ids],
            )
          ).rows;
          if (
            linked.length !== time.source_event_ids.length ||
            linked.some(
              (e) =>
                e.employee_id !== time.employee_id ||
                Math.abs(
                  Date.parse(time.date + 'T00:00:00+05:00') - new Date(e.occurred_at).getTime(),
                ) >
                  2 * 86400000,
            )
          )
            fail('INVALID_REQUEST');
          if (
            time.status === 'approved' &&
            others.some(
              (r) =>
                r.kind === 'time' &&
                parse(WorkTime, r.payload).status === 'approved' &&
                parse(WorkTime, r.payload).source_event_ids.some((v) =>
                  time.source_event_ids.includes(v),
                ),
            )
          )
            fail('CONFLICT');
          // Also check overnight overlaps across dates and month boundaries.
          for (const r of others.filter((r) => r.kind === 'time')) {
            const q = parse(WorkTime, r.payload);
            if (
              q.employee_id === time.employee_id &&
              q.status !== 'voided' &&
              time.status !== 'voided' &&
              time.intervals.some((s) =>
                q.intervals.some(
                  (t) =>
                    Date.parse(s.start) < Date.parse(t.end) &&
                    Date.parse(s.end) > Date.parse(t.start),
                ),
              )
            )
              fail('CONFLICT');
          }
        }
        before = old ?? null;
        await db.query(
          'INSERT INTO bo_workforce_records(id,branch_id,kind,employee_id,revision,payload) VALUES($1,$2,$3,$4,1,$5) ON CONFLICT(branch_id,id) DO UPDATE SET revision=bo_workforce_records.revision+1,payload=excluded.payload,updated_at=clock_timestamp()',
          [c.id, branch, c.kind, payload.employee_id, JSON.stringify(payload)],
        );
        result = { id: c.id, revision: c.expected_revision + 1 };
      } else if (c.type === 'import') {
        let inserted = 0;
        for (const event of c.events) {
          await this.employee(db, branch, event.employee_id);
          if (Date.parse(event.occurred_at) > Date.now() + 60000) fail('INVALID_REQUEST');
          const old = (
            await db.query(
              'SELECT payload FROM bo_workforce_events WHERE branch_id=$1 AND source=$2 AND external_id=$3',
              [branch, c.source, event.external_id],
            )
          ).rows[0];
          if (old) {
            if (digest(old.payload) !== digest(event)) fail('CONFLICT');
            continue;
          }
          await db.query(
            'INSERT INTO bo_workforce_events(id,branch_id,employee_id,source,external_id,occurred_at,direction,payload,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [
              randomUUID(),
              branch,
              event.employee_id,
              c.source,
              event.external_id,
              event.occurred_at,
              event.direction,
              JSON.stringify(event),
              actor.id,
            ],
          );
          inserted++;
        }
        result = { inserted, duplicates: c.events.length - inserted };
      } else {
        const snap = await this.snapshot(db, branch, c.month);
        if (snap.period.revision !== c.expected_revision || snap.period.closed === c.closed)
          fail('CONFLICT');
        if (c.closed && monthWindow(c.month).end > Date.now()) fail('NOT_READY');
        if (c.closed && (snap.unresolved_events || snap.calculation.issues.length))
          fail('NOT_READY');
        before = snap.period;
        await db.query(
          'INSERT INTO bo_workforce_periods(branch_id,month,closed,revision,snapshot) VALUES($1,$2,$3,1,$4) ON CONFLICT(branch_id,month) DO UPDATE SET closed=excluded.closed,revision=bo_workforce_periods.revision+1,snapshot=excluded.snapshot',
          [
            branch,
            c.month,
            c.closed,
            JSON.stringify({
              calculation: snap.calculation,
              records: snap.records,
              closed_by: actor.id,
            }),
          ],
        );
        result = { month: c.month, closed: c.closed, revision: c.expected_revision + 1 };
      }
      await db.query(
        'INSERT INTO bo_audit(id,branch_id,organization_id,actor_id,request_id,action,entity_id,reason,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          randomUUID(),
          branch,
          actor.organization_id,
          actor.id,
          request.request_id,
          'workforce.' + c.type,
          result.id ?? null,
          request.reason,
          JSON.stringify(before),
          JSON.stringify(c),
        ],
      );
      await db.query(
        'INSERT INTO bo_workforce_commands(actor_id,request_id,branch_id,digest,result) VALUES($1,$2,$3,$4,$5)',
        [actor.id, request.request_id, branch, hash, JSON.stringify(result)],
      );
      return result;
    });
  }
}
