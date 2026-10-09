import { randomUUID } from 'node:crypto';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { lockBranch } from './commands.js';
import { activeMenuHasVariant } from './orders.js';

export type RemoteStopVerdict = 'applied' | 'conflict' | 'not_found' | 'no_open_shift' | 'expired';
export interface RemoteStopResult {
  commandId: string;
  state: RemoteStopVerdict;
  version: number | null;
}
interface RemoteStopRow {
  command_id: string;
  variant_id: string;
  stopped: boolean;
  duration: 'manual' | 'hour' | 'shift';
  reason: string;
  expected_version: number;
  actor_label: string;
  expired: boolean;
}

/** A command not applied within this window is stale: the back-office already shows it lapsed. */
export const REMOTE_STOP_MAX_AGE_SECONDS = 60;

/** Edge migration 019 is installed and this role may apply remote stops. */
export async function remoteStopsReady(db: Pick<DatabasePool | DatabaseClient, 'query'>) {
  const installed = (
    await db.query<{ ready: boolean }>(
      "SELECT to_regclass('remote_stop_commands') IS NOT NULL AND EXISTS(SELECT 1 FROM schema_migrations WHERE scope='edge' AND version='019_edge_remote_stops.sql') AS ready",
    )
  ).rows[0]!.ready;
  if (!installed) return false;
  return (
    await db.query<{ ready: boolean }>(
      "SELECT has_column_privilege('remote_stop_commands','state','UPDATE') AND has_table_privilege('local_stop_events','INSERT') AND has_column_privilege('local_stops','source','UPDATE') AS ready",
    )
  ).rows[0]!.ready;
}

async function decide(
  client: DatabaseClient,
  branchId: string,
  command: RemoteStopRow,
): Promise<RemoteStopResult> {
  const verdict = (state: RemoteStopVerdict, version: number | null = null) => ({
    commandId: command.command_id,
    state,
    version,
  });
  if (command.expired) return verdict('expired');
  if (!(await activeMenuHasVariant(client, branchId, command.variant_id)))
    return verdict('not_found');
  const current = Number(
    (
      await client.query<{ version: number }>(
        'SELECT version FROM local_stops WHERE branch_id=$1 AND variant_id=$2 FOR UPDATE',
        [branchId, command.variant_id],
      )
    ).rows[0]?.version ?? 0,
  );
  if (current !== command.expected_version) return verdict('conflict', current);
  let shiftId: string | null = null;
  if (command.stopped && command.duration === 'shift') {
    // A back-office stop has no terminal: it lasts until the register shift that is open now closes.
    const shift = (
      await client.query<{ id: string }>(
        "SELECT id FROM local_cash_shifts WHERE branch_id=$1 AND state='open' ORDER BY opened_at DESC,id LIMIT 1 FOR SHARE",
        [branchId],
      )
    ).rows[0];
    if (!shift) return verdict('no_open_shift');
    shiftId = shift.id;
  }
  // Same effect as the POS setStop; only the actor differs (no local staff for a remote actor).
  const saved = (
    await client.query<{ version: number }>(
      `INSERT INTO local_stops(branch_id,variant_id,stopped,version,reason,expires_at,expires_shift_id,updated_by,source)
      VALUES ($1,$2,$3,1,$4,CASE WHEN $5 THEN clock_timestamp()+interval '1 hour' ELSE NULL END,$6,NULL,'backoffice')
      ON CONFLICT(branch_id,variant_id) DO UPDATE SET stopped=EXCLUDED.stopped,version=local_stops.version+1,reason=EXCLUDED.reason,expires_at=EXCLUDED.expires_at,expires_shift_id=EXCLUDED.expires_shift_id,updated_by=NULL,source=EXCLUDED.source,updated_at=clock_timestamp()
      RETURNING version`,
      [
        branchId,
        command.variant_id,
        command.stopped,
        command.reason,
        command.stopped && command.duration === 'hour',
        shiftId,
      ],
    )
  ).rows[0]!;
  await client.query(
    `INSERT INTO local_stop_events(id,branch_id,variant_id,stopped,version,source,command_id,actor_label,duration,reason)
    VALUES ($1,$2,$3,$4,$5,'backoffice',$6,$7,$8,$9)`,
    [
      randomUUID(),
      branchId,
      command.variant_id,
      command.stopped,
      saved.version,
      command.command_id,
      command.actor_label,
      command.duration,
      command.reason,
    ],
  );
  return verdict('applied', Number(saved.version));
}

/**
 * Apply back-office stop commands from the edge inbox, oldest first, one transaction per command.
 * The edge service is the only writer of local_stops; this runs inside it, never in the worker.
 */
export async function applyRemoteStops(
  pool: DatabasePool,
  branchId: string,
  { limit = 20 }: { limit?: number } = {},
): Promise<RemoteStopResult[]> {
  const results: RemoteStopResult[] = [];
  // Cheap idle check: the loop runs every 500 ms and must not take the branch lock for nothing.
  const waiting = await pool.query(
    "SELECT 1 FROM remote_stop_commands WHERE branch_id=$1 AND state='received' LIMIT 1",
    [branchId],
  );
  if (!waiting.rowCount) return results;
  while (results.length < limit) {
    const result = await transaction(pool, async (client) => {
      // Same serialization as POS stop commands, so the version check cannot race a cashier.
      await lockBranch(client, branchId);
      const command = (
        await client.query<RemoteStopRow>(
          `SELECT command_id,variant_id,stopped,duration,reason,expected_version,actor_label,
          received_at < clock_timestamp()-$2*interval '1 second' AS expired
          FROM remote_stop_commands WHERE branch_id=$1 AND state='received'
          ORDER BY received_at,command_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [branchId, REMOTE_STOP_MAX_AGE_SECONDS],
        )
      ).rows[0];
      if (!command) return null;
      const decided = await decide(client, branchId, command);
      await client.query(
        'UPDATE remote_stop_commands SET state=$2,result_version=$3,applied_at=clock_timestamp() WHERE command_id=$1',
        [command.command_id, decided.state, decided.version],
      );
      return decided;
    });
    if (!result) break;
    results.push(result);
  }
  return results;
}
