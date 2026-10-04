import { createHash } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabasePool, type DatabaseClient } from '@pickchick/database';
import {
  createFarm,
  applyFarmCommand,
  FarmStateSchema,
  FarmCommandSchema,
  FarmGameError,
} from '@pickchick/farm-game';
export const FARM = Symbol('FARM');
export const FarmRequestSchema = z
  .object({
    commandId: z.uuid(),
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    command: FarmCommandSchema,
  })
  .strict();
export class FarmPersistenceError extends Error {
  constructor(
    public readonly code: string,
    public readonly state?: z.infer<typeof FarmStateSchema>,
  ) {
    super(code);
  }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + stable(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export class FarmPersistence {
  constructor(
    private readonly pool: DatabasePool,
    private readonly enabled: boolean = false,
  ) {}
  private available() {
    if (!this.enabled) throw new FarmPersistenceError('FARM_UNAVAILABLE');
  }
  private async locked(db: DatabaseClient, customerId: string) {
    await db.query("SET LOCAL statement_timeout='5s'");
    await db.query("SET LOCAL lock_timeout='3s'");
    // A customer row serializes lazy creation, commands and account deletion.
    const customer = await db.query(
      'SELECT id FROM identity_customers WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
      [customerId],
    );
    if (!customer.rowCount) throw new FarmPersistenceError('UNAUTHORIZED');
    const time = await db.query(
      'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now',
    );
    const serverNow = Number(time.rows[0].now);
    await db.query(
      'INSERT INTO customer_farms(customer_id,state) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [customerId, createFarm(serverNow)],
    );
    const row = await db.query('SELECT state FROM customer_farms WHERE customer_id=$1 FOR UPDATE', [
      customerId,
    ]);
    return { state: FarmStateSchema.parse(row.rows[0].state), serverNow };
  }
  async get(customerId: string) {
    this.available();
    return transaction(this.pool, (db) => this.locked(db, customerId));
  }
  async command(customerId: string, input: unknown) {
    this.available();
    const parsed = FarmRequestSchema.safeParse(input);
    if (!parsed.success) throw new FarmPersistenceError('INVALID_REQUEST');
    const request = parsed.data;
    const digest = createHash('sha256').update(stable(request)).digest('hex');
    return transaction(this.pool, async (db) => {
      const current = await this.locked(db, customerId);
      const receipt = await db.query(
        'SELECT request_hash FROM customer_farm_commands WHERE customer_id=$1 AND command_id=$2',
        [customerId, request.commandId],
      );
      if (receipt.rowCount) {
        if (receipt.rows[0].request_hash !== digest)
          throw new FarmPersistenceError('COMMAND_ID_CONFLICT');
        return current;
      }
      if (current.state.revision !== request.expectedRevision)
        throw new FarmPersistenceError('STALE_STATE', current.state);
      const count = await db.query(
        'SELECT count(*)::int AS count FROM customer_farm_commands WHERE customer_id=$1',
        [customerId],
      );
      if (count.rows[0].count >= 100000) throw new FarmPersistenceError('COMMAND_LIMIT');
      const recent = await db.query(
        "SELECT count(*)::int AS count FROM customer_farm_commands WHERE customer_id=$1 AND created_at > clock_timestamp()-interval '1 minute'",
        [customerId],
      );
      if (recent.rows[0].count >= 120) throw new FarmPersistenceError('RATE_LIMITED');
      let state;
      try {
        state = FarmStateSchema.parse(
          applyFarmCommand(current.state, request.command, current.serverNow),
        );
      } catch (error) {
        if (error instanceof FarmGameError) throw new FarmPersistenceError(error.code);
        throw error;
      }
      await db.query('UPDATE customer_farms SET state=$2 WHERE customer_id=$1', [
        customerId,
        state,
      ]);
      await db.query(
        'INSERT INTO customer_farm_commands(customer_id,command_id,request_hash,revision) VALUES($1,$2,$3,$4)',
        [customerId, request.commandId, digest, state.revision],
      );
      return { state, serverNow: current.serverNow };
    });
  }
}
