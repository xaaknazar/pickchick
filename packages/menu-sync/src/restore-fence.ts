import type { DatabaseClient, DatabasePool } from '@pickchick/database';

export type EdgeRestoreState = 'unsupported' | 'initial' | 'current' | 'restore' | 'operator';
export interface EdgeRestoreFence {
  state: EdgeRestoreState;
  epoch: number | null;
  /** How far every edge-to-cloud producer sequence moved in this call (0 unless fenced now). */
  sequenceGap: string;
}

/**
 * Restore fencing (edge schema023, docs/operations/edge-restore.md). Compares the database the
 * edge runs on with the identity recorded in its own ledger; a restored copy gets one fence:
 * producer sequences move past the lost timeline and the menu cursor may skip forward once.
 * Idempotent and cheap when nothing changed. An edge before schema023 reports 'unsupported'.
 * `force` is the operator command for a file-level restore that kept the database identity.
 */
export async function fenceRestoredEdge(
  db: Pick<DatabaseClient | DatabasePool, 'query'>,
  force = false,
): Promise<EdgeRestoreFence> {
  const supported = await db.query<{ ok: boolean }>(
    "SELECT to_regprocedure('edge_restore_fence(boolean)') IS NOT NULL AS ok",
  );
  if (!supported.rows[0]?.ok) return { state: 'unsupported', epoch: null, sequenceGap: '0' };
  const row = (
    await db.query<{ state: EdgeRestoreState; epoch: number; sequence_gap: string }>(
      'SELECT state, epoch, sequence_gap::text FROM edge_restore_fence($1)',
      [force],
    )
  ).rows[0];
  if (!row) throw new Error('Edge restore fence returned no state');
  return { state: row.state, epoch: row.epoch, sequenceGap: row.sequence_gap };
}
