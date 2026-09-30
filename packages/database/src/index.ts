import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;
export type DatabaseScope = 'cloud' | 'edge';

export function createPool(connectionString: string, max = 5): DatabasePool {
  if (!Number.isInteger(max) || max < 1 || max > 64) throw new Error('Invalid database pool limit');
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 10000,
    statement_timeout: 5000,
    application_name: 'pickchick-foundation',
  });
  // Never emit driver errors containing connection strings or credentials.
  pool.on('error', () => console.error(JSON.stringify({ event: 'database_pool_error' })));
  return pool;
}

export async function transaction<T>(
  pool: DatabasePool,
  operation: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let connectionError: Error | undefined;
  let discard = false;
  // pg-pool removes its idle error listener while a client is leased. Socket
  // failures can emit separately from query rejection, including during rollback.
  const onConnectionError = (error: Error) => {
    connectionError ??= error;
    discard = true;
  };
  client.on('error', onConnectionError);
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    if (connectionError) throw connectionError;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (!connectionError) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // A failed rollback leaves the connection unusable or its transaction
        // state unknown. Preserve the original error and remove it from the pool.
        discard = true;
      }
    }
    throw error;
  } finally {
    try {
      client.release(discard ? true : undefined);
    } finally {
      // release installs the pool's idle listener first: no unhandled-error gap.
      client.removeListener('error', onConnectionError);
    }
  }
}

export async function migrate(
  pool: DatabasePool,
  directory: string,
  scope: DatabaseScope,
): Promise<string[]> {
  const files = (await readdir(directory))
    .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name))
    .sort();
  if (files.length === 0) throw new Error('No migration files found');
  return transaction(pool, async (client) => {
    // One transaction/session holds the lock through ledger validation and all DDL.
    await client.query('SELECT pg_advisory_xact_lock(724001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      scope text NOT NULL CHECK (scope IN ('cloud', 'edge')),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: string; checksum: string; scope: string }>(
      'SELECT version, checksum, scope FROM schema_migrations ORDER BY version',
    );
    if (rows.some((row) => row.scope !== scope || !files.includes(row.version))) {
      throw new Error('Migration ledger belongs to another scope or unsupported schema');
    }
    const applied = new Map(rows.map((row) => [row.version, row.checksum]));
    const completed: string[] = [];
    for (const filename of files) {
      const sql = await readFile(join(directory, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(filename)) {
        if (applied.get(filename) !== checksum) throw new Error(`Changed migration: ${filename}`);
        continue;
      }
      if (rows.some((row) => row.version > filename)) throw new Error('Out-of-order migration');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, checksum, scope) VALUES ($1, $2, $3)',
        [filename, checksum, scope],
      );
      completed.push(filename);
    }
    return completed;
  });
}
