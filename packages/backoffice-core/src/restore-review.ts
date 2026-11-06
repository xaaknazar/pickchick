import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { BackofficeError, parse } from './model.js';

export async function listRestoreReviews(db: DatabaseClient, branch: string, input: unknown) {
  const q = parse(z.strictObject({ after: z.uuid().optional() }), input);
  if (
    !(await db.query("SELECT to_regclass('pos_kitchen_restore_conflicts') IS NOT NULL AS ok"))
      .rows[0].ok
  )
    return { installed: false, items: [], next: null };
  const rows = (
    await db.query(
      `SELECT c.event_id,c.order_id,c.aggregate_version,c.canonical_version,c.reason,c.received_at,
     c.envelope->'payload'->>'state' observed_state,p.state canonical_state,p.display_number,
     d.reason review_reason,d.recorded_at reviewed_at,d.actor_id,m.name reviewer_name
     FROM pos_kitchen_restore_conflicts c JOIN pos_kitchen_sync_projection p ON p.order_id=c.order_id
     LEFT JOIN pos_kitchen_restore_decisions d USING(event_id)
     LEFT JOIN catalog_managers m ON m.id=d.actor_id
     WHERE c.branch_id=$1 AND ($2::uuid IS NULL OR c.event_id>$2) ORDER BY c.event_id LIMIT 51`,
      [branch, q.after ?? null],
    )
  ).rows;
  return {
    installed: true,
    items: rows.slice(0, 50),
    next: rows.length > 50 ? (rows[49].event_id as string) : null,
  };
}

/** Human reconciliation only; never changes any order, payment or handoff. */
export async function decideRestoreReview(
  db: DatabaseClient,
  branch: string,
  actor: string,
  input: unknown,
) {
  const c = parse(
    z.strictObject({
      commandId: z.uuid(),
      eventId: z.uuid(),
      expectedVersion: z.literal(1),
      reason: z.string().trim().min(3).max(500),
    }),
    input,
  );
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'restore-review-command:' + c.commandId,
  ]);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'restore-review:' + c.eventId,
  ]);
  const conflict = (
    await db.query(
      'SELECT event_id FROM pos_kitchen_restore_conflicts WHERE event_id=$1 AND branch_id=$2',
      [c.eventId, branch],
    )
  ).rows[0];
  if (!conflict) throw new BackofficeError('NOT_FOUND');
  const previous = (
    await db.query(
      'SELECT * FROM pos_kitchen_restore_decisions WHERE event_id=$1 OR command_id=$2',
      [c.eventId, c.commandId],
    )
  ).rows;
  if (previous.length) {
    if (
      previous.length !== 1 ||
      previous[0].command_id !== c.commandId ||
      previous[0].event_id !== c.eventId ||
      previous[0].actor_id !== actor ||
      previous[0].reason !== c.reason
    )
      throw new BackofficeError('CONFLICT');
  } else {
    await db.query(
      'INSERT INTO pos_kitchen_restore_decisions(event_id,command_id,actor_id,reason) VALUES($1,$2,$3,$4)',
      [c.eventId, c.commandId, actor, c.reason],
    );
  }
  return { eventId: c.eventId, version: 2, reviewed: true };
}
