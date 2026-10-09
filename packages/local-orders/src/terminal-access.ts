import { createHash, randomBytes } from 'node:crypto';
import {
  DeviceAccessCommandSchema,
  DeviceAccessExchangeResponseSchema,
  DeviceAccessReceiptSchema,
  TerminalCredentialSchema,
  TerminalPairRequestSchema,
  UuidSchema,
  type DeviceAccessReceipt,
  type TerminalMode,
} from '@pickchick/contracts';
import { transaction, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import type { KitchenPasswordReset } from './kitchen-password-reset.js';
import { OrderError } from './errors.js';

export class TerminalRateLimitError extends Error {}
export const terminalHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function edgeDeviceAccessEnabled(env: Record<string, string | undefined> = process.env) {
  const value = env['EDGE_DEVICE_ACCESS_ENABLED'] ?? 'false';
  if (!['true', 'false'].includes(value)) throw new Error('Invalid edge device access flag');
  return value === 'true';
}
export type TerminalAuth = { id: string; key: string };
type TerminalSession = {
  terminalId: string;
  branchId: string;
  mode: TerminalMode;
  generation: number;
  valid: true;
};
async function branchLock(db: DatabaseClient, branch: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'terminal-access:' + branch,
  ]);
}
/** Caller holds terminal first (same lock order as staff auth and command application). */
export async function authenticateTerminal(
  db: DatabaseClient,
  branch: string,
  auth: TerminalAuth,
): Promise<TerminalSession> {
  if (!UuidSchema.safeParse(auth.id).success || !/^[a-f0-9]{64}$/.test(auth.key))
    throw new OrderError('UNAUTHORIZED');
  const row = (
    await db.query<{ mode: TerminalMode; generation: number }>(
      `SELECT r.mode,r.generation FROM terminal_access_registry r
    JOIN local_terminals t ON t.id=r.terminal_id AND t.branch_id=r.branch_id
    WHERE r.terminal_id=$1 AND r.branch_id=$2 AND r.state='paired' AND r.key_hash=$3 AND t.active FOR SHARE OF r`,
      [auth.id, branch, terminalHash(auth.key)],
    )
  ).rows[0];
  if (!row) throw new OrderError('UNAUTHORIZED');
  return { terminalId: auth.id, branchId: branch, ...row, valid: true };
}
/** Legacy terminals remain compatible; managed terminals can never omit the new credential. */
export async function authenticateManagedTerminal(
  db: DatabaseClient,
  branch: string,
  auth: TerminalAuth,
) {
  if (!UuidSchema.safeParse(auth.id).success) throw new OrderError('UNAUTHORIZED');
  const terminal = (
    await db.query<{ device_access_managed: boolean; registered: boolean }>(
      `SELECT device_access_managed,EXISTS(SELECT 1 FROM terminal_access_registry r WHERE r.terminal_id=t.id) AS registered
     FROM local_terminals t WHERE t.id=$1 AND t.branch_id=$2`,
      [auth.id, branch],
    )
  ).rows[0];
  if (!terminal) throw new OrderError('UNAUTHORIZED');
  // The persisted bit is the authoritative fence even if a damaged/missing registry row exists.
  if (terminal.device_access_managed || terminal.registered || auth.key)
    return authenticateTerminal(db, branch, auth);
  return null;
}
export class TerminalAccess {
  constructor(
    private readonly pool: DatabasePool,
    readonly branchId: string,
    readonly edgeDeviceId: string,
  ) {
    if (!UuidSchema.safeParse(branchId).success || !UuidSchema.safeParse(edgeDeviceId).success)
      throw new OrderError('INVALID_REQUEST');
  }
  async receive(input: unknown) {
    const parsed = DeviceAccessCommandSchema.safeParse(input);
    if (!parsed.success) throw new OrderError('INVALID_REQUEST');
    const command = parsed.data;
    if (command.branchId !== this.branchId || command.edgeDeviceId !== this.edgeDeviceId)
      throw new OrderError('FORBIDDEN');
    return transaction(this.pool, async (db) => {
      await branchLock(db, this.branchId);
      const binding = (
        await db.query('SELECT 1 FROM fulfillment_config WHERE branch_id=$1 AND device_id=$2', [
          this.branchId,
          this.edgeDeviceId,
        ])
      ).rowCount;
      if (!binding) throw new OrderError('FORBIDDEN');
      const previous = (
        await db.query('SELECT payload,state FROM terminal_access_commands WHERE command_id=$1', [
          command.commandId,
        ])
      ).rows[0];
      if (previous) {
        if (
          JSON.stringify(DeviceAccessCommandSchema.parse(previous.payload)) !==
          JSON.stringify(command)
        )
          throw new OrderError('CONFLICT');
        return previous.state as DeviceAccessReceipt['state'];
      }
      const sameGeneration = (
        await db.query(
          'SELECT 1 FROM terminal_access_commands WHERE terminal_id=$1 AND generation=$2',
          [command.terminalId, command.generation],
        )
      ).rowCount;
      if (sameGeneration) throw new OrderError('CONFLICT');
      const local = (
        await db.query('SELECT branch_id FROM local_terminals WHERE id=$1 FOR UPDATE', [
          command.terminalId,
        ])
      ).rows[0];
      const prior = (
        await db.query('SELECT * FROM terminal_access_registry WHERE terminal_id=$1 FOR UPDATE', [
          command.terminalId,
        ])
      ).rows[0];
      const expired = (
        await db.query<{ expired: boolean; future: boolean }>(
          "SELECT $1::timestamptz<=clock_timestamp() AS expired,$2::timestamptz>clock_timestamp()+interval '30 seconds' AS future",
          [command.expiresAt, command.issuedAt],
        )
      ).rows[0]!;
      const rejected =
        expired.future ||
        (local && (!prior || local.branch_id !== this.branchId)) ||
        (prior &&
          (prior.edge_device_id !== this.edgeDeviceId ||
            prior.mode !== command.mode ||
            prior.generation >= command.generation));
      const state: DeviceAccessReceipt['state'] = rejected
        ? 'rejected'
        : command.action === 'pair' && expired.expired
          ? 'expired'
          : 'applied';
      await db.query(
        `INSERT INTO terminal_access_commands(command_id,branch_id,edge_device_id,terminal_id,generation,payload,state)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          command.commandId,
          this.branchId,
          this.edgeDeviceId,
          command.terminalId,
          command.generation,
          command,
          state,
        ],
      );
      if (rejected) return state;
      // Only an explicit command may allocate a new ID; collisions with all legacy IDs are rejected.
      await db.query(
        `INSERT INTO local_terminals(id,branch_id,active,device_access_managed) VALUES($1,$2,false,true)
        ON CONFLICT(id) DO UPDATE SET active=false`,
        [command.terminalId, this.branchId],
      );
      await db.query(
        `INSERT INTO terminal_access_registry(terminal_id,branch_id,edge_device_id,mode,name,generation,command_id,state,code_hash,key_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10)
        ON CONFLICT(terminal_id) DO UPDATE SET generation=excluded.generation,command_id=excluded.command_id,
        name=excluded.name,state=excluded.state,code_hash=excluded.code_hash,key_hash=NULL,expires_at=excluded.expires_at`,
        [
          command.terminalId,
          this.branchId,
          this.edgeDeviceId,
          command.mode,
          command.name,
          command.generation,
          command.commandId,
          command.action === 'revoke' ? 'revoked' : state === 'expired' ? 'expired' : 'pending',
          state === 'applied' && command.action === 'pair' ? command.codeHash : null,
          command.expiresAt,
        ],
      );
      return state;
    });
  }
  async pair(input: unknown) {
    // Commit even invalid/unsuccessful attempts. Codes and IP addresses never become counter keys.
    const allowed = await transaction(this.pool, async (db) => {
      const result = await db.query(
        `INSERT INTO terminal_pair_limits(branch_id,window_started_at,attempts) VALUES($1,clock_timestamp(),1)
        ON CONFLICT(branch_id) DO UPDATE SET window_started_at=CASE WHEN terminal_pair_limits.window_started_at<=clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE terminal_pair_limits.window_started_at END,
        attempts=CASE WHEN terminal_pair_limits.window_started_at<=clock_timestamp()-interval '1 minute' THEN 1 ELSE terminal_pair_limits.attempts+1 END
        WHERE terminal_pair_limits.window_started_at<=clock_timestamp()-interval '1 minute' OR terminal_pair_limits.attempts<30 RETURNING attempts`,
        [this.branchId],
      );
      return result.rowCount === 1;
    });
    if (!allowed) throw new TerminalRateLimitError();
    const parsed = TerminalPairRequestSchema.safeParse(input);
    if (!parsed.success) throw new OrderError('UNAUTHORIZED');
    const result = await transaction(this.pool, async (db) => {
      await branchLock(db, this.branchId);
      const row = (
        await db.query(
          `SELECT *,expires_at<=clock_timestamp() AS expired FROM terminal_access_registry
        WHERE branch_id=$1 AND edge_device_id=$2 AND code_hash=$3 AND state='pending'`,
          [this.branchId, this.edgeDeviceId, terminalHash(parsed.data.code)],
        )
      ).rows[0];
      if (!row || (parsed.data.mode && row.mode !== parsed.data.mode)) return null;
      await db.query('SELECT id FROM local_terminals WHERE id=$1 FOR UPDATE', [row.terminal_id]);
      if (row.expired) {
        await db.query(
          "UPDATE terminal_access_registry SET state='expired',code_hash=NULL WHERE terminal_id=$1",
          [row.terminal_id],
        );
        await db.query(
          "UPDATE terminal_access_commands SET state='expired' WHERE command_id=$1 AND state='applied'",
          [row.command_id],
        );
        return null;
      }
      const key = randomBytes(32).toString('hex');
      await db.query(
        "UPDATE terminal_access_registry SET state='paired',code_hash=NULL,key_hash=$2 WHERE terminal_id=$1",
        [row.terminal_id, terminalHash(key)],
      );
      await db.query('UPDATE local_terminals SET active=true WHERE id=$1', [row.terminal_id]);
      await db.query(
        "UPDATE terminal_access_commands SET state='paired' WHERE command_id=$1 AND state='applied'",
        [row.command_id],
      );
      return TerminalCredentialSchema.parse({
        terminalId: row.terminal_id,
        branchId: this.branchId,
        mode: row.mode,
        generation: row.generation,
        terminalKey: key,
      });
    });
    if (!result) throw new OrderError('UNAUTHORIZED');
    return result;
  }
  session(auth: TerminalAuth) {
    if (!UuidSchema.safeParse(auth.id).success) throw new OrderError('UNAUTHORIZED');
    return transaction(this.pool, async (db) => {
      await db.query('SELECT id FROM local_terminals WHERE id=$1 AND branch_id=$2 FOR SHARE', [
        auth.id,
        this.branchId,
      ]);
      return authenticateTerminal(db, this.branchId, auth);
    });
  }
  async receipts(): Promise<DeviceAccessReceipt[]> {
    return transaction(this.pool, async (db) => {
      await branchLock(db, this.branchId);
      await db.query(
        `UPDATE terminal_access_commands SET state='expired' WHERE command_id IN (
        SELECT command_id FROM terminal_access_registry WHERE branch_id=$1 AND state='pending' AND expires_at<=clock_timestamp()) AND state='applied'`,
        [this.branchId],
      );
      await db.query(
        "UPDATE terminal_access_registry SET state='expired',code_hash=NULL WHERE branch_id=$1 AND state='pending' AND expires_at<=clock_timestamp()",
        [this.branchId],
      );
      return (
        await db.query(
          `SELECT command_id AS "commandId",terminal_id AS "terminalId",generation,state FROM terminal_access_commands
        WHERE branch_id=$1 AND edge_device_id=$2 AND state IS DISTINCT FROM reported_state ORDER BY received_at,command_id LIMIT 50`,
          [this.branchId, this.edgeDeviceId],
        )
      ).rows.map((row) => DeviceAccessReceiptSchema.parse(row));
    });
  }
  async acknowledge(input: unknown) {
    const receipt = DeviceAccessReceiptSchema.parse(input);
    // CAS prevents a slow applied ACK from hiding a concurrently committed paired receipt.
    await this.pool.query(
      `UPDATE terminal_access_commands SET reported_state=$4 WHERE command_id=$1 AND terminal_id=$2 AND generation=$3 AND state=$4 AND branch_id=$5 AND edge_device_id=$6`,
      [
        receipt.commandId,
        receipt.terminalId,
        receipt.generation,
        receipt.state,
        this.branchId,
        this.edgeDeviceId,
      ],
    );
  }
}
/** Bounded, separate mailbox: no bank/financial command, no transaction spans HTTP. */
export async function exchangeTerminalAccess(
  repository: TerminalAccess,
  identity: { device_id: string; token: string },
  origin: string,
  fetcher: typeof fetch = fetch,
  resets?: KitchenPasswordReset,
) {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    !(url.protocol === 'https:' || origin === 'http://127.0.0.1:43100')
  )
    throw new Error('Invalid device mailbox origin');
  if (identity.device_id !== repository.edgeDeviceId || !/^[a-f0-9]{64}$/.test(identity.token))
    throw new Error('Device identity differs');
  const receipts = await repository.receipts();
  const resetReceipts = (await resets?.receipts()) ?? [];
  const response = await fetcher(origin + '/internal/v1/edge/devices/exchange', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: {
      'Content-Type': 'application/json',
      'X-Device-ID': identity.device_id,
      Authorization: 'Bearer ' + identity.token,
    },
    body: JSON.stringify({ protocolVersion: 1, receipts, resetReceipts }),
  });
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('content-type')?.includes('application/json')
  )
    throw new Error('Device mailbox unavailable');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 65536) throw new Error('Device mailbox too large');
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const data = DeviceAccessExchangeResponseSchema.parse(
    JSON.parse(Buffer.concat(parts).toString('utf8')),
  );
  if (data.branchId !== repository.branchId || data.edgeDeviceId !== repository.edgeDeviceId)
    throw new Error('Device mailbox scope differs');
  if (
    data.acknowledged.some(
      (item) => !receipts.some((sent) => JSON.stringify(sent) === JSON.stringify(item)),
    )
  )
    throw new Error('Unexpected receipt acknowledgment');
  if (data.resetCommands.length && !resets) throw new Error('Reset mailbox unavailable');
  if (
    data.resetAcknowledged.some(
      (item) => !resetReceipts.some((sent) => JSON.stringify(sent) === JSON.stringify(item)),
    )
  )
    throw new Error('Unexpected reset acknowledgment');
  for (const command of data.resetCommands) await resets!.receive(command);
  for (const receipt of data.resetAcknowledged) await resets!.acknowledge(receipt);
  for (const command of data.commands) await repository.receive(command);
  for (const receipt of data.acknowledged) await repository.acknowledge(receipt);
  return {
    received: data.commands.length + data.resetCommands.length,
    acknowledged: data.acknowledged.length + data.resetAcknowledged.length,
  };
}
