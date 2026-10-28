import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EdgeBackupError,
  listBackupCopies,
  parseBackupKey,
  readEncryptedArchive,
} from './edge-backup-lib.mjs';

/**
 * Operator side of the restore runbook (docs/operations/edge-restore.md). Works on the cashier or
 * any machine with Node and the archive key; it never connects anywhere except `compare`.
 *
 *   list    <copies dir> <branchId>                  complete copies, newest first
 *   verify  <archive> <key file>                     authenticate and hash, print the summary
 *   decrypt <archive> <key file> <new dump file>     pg_dump archive + <dump>.meta.json
 *   compare <dump>.meta.json <dir with pg module>    EDGE_DATABASE_URL = the restored database
 *
 * decrypt writes new files only (never overwrites) and removes them unless every byte verified.
 * compare proves a restored database has the archived ledger, branch and row count of every table.
 */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function readSmallJson(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error('Unsafe input file');
  return JSON.parse(await readFile(path, 'utf8'));
}

const summary = (read) => ({
  createdAt: read.meta.createdAt,
  branchId: read.meta.branchId,
  schema: read.meta.schema,
  keyId: read.header.keyId,
  tables: Object.keys(read.meta.tableCounts ?? {}).length,
  dumpBytes: read.dumpBytes,
  dumpSha256: read.dumpSha256,
  archiveSha256: read.archiveSha256,
});

/**
 * Compares a restored database with the archive meta: same migration ledger, same single branch
 * and the same row count in every recorded table. Returns the differences (empty when equal).
 */
export async function compareRestoredDatabase(client, meta, { schema = 'public' } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid schema');
  const differences = [];
  const ledger = (
    await client.query(
      `SELECT version,checksum,scope FROM "${schema}".schema_migrations ORDER BY version`,
    )
  ).rows;
  if (JSON.stringify(ledger) !== JSON.stringify(meta.ledger)) differences.push('ledger');
  const branches = (await client.query(`SELECT id FROM "${schema}".branch_config`)).rows;
  if (branches.length !== 1 || branches[0].id !== meta.branchId) differences.push('branch');
  const tables = (
    await client.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`,
      [schema],
    )
  ).rows.map((row) => row.relname);
  const expected = meta.tableCounts ?? {};
  for (const table of new Set([...tables, ...Object.keys(expected)])) {
    if (!tables.includes(table) || !(table in expected)) {
      differences.push('table:' + table);
      continue;
    }
    const actual = (
      await client.query(
        `SELECT count(*)::text AS count FROM "${schema}"."${table.replaceAll('"', '""')}"`,
      )
    ).rows[0].count;
    if (actual !== expected[table]) differences.push('rows:' + table);
  }
  return differences;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const absolute = (path) => typeof path === 'string' && isAbsolute(path);
  if (command === 'list' && args.length === 2 && absolute(args[0]) && uuid.test(args[1] ?? '')) {
    const { copies, strays } = await listBackupCopies(args[0], { branchId: args[1] });
    for (const copy of copies)
      console.log(
        JSON.stringify({
          archive: copy.name,
          createdAt: copy.createdAt,
          schema: copy.sidecar.schema,
          keyId: copy.sidecar.keyId,
          archiveBytes: copy.bytes,
        }),
      );
    console.log(JSON.stringify({ copies: copies.length, incompleteOrTemporary: strays.length }));
    return;
  }
  if (command === 'verify' && args.length === 2 && args.every(absolute)) {
    const key = parseBackupKey(await readSmallJson(args[1], 4096));
    console.log(
      JSON.stringify({
        verified: true,
        ...summary(await readEncryptedArchive({ file: args[0], key })),
      }),
    );
    return;
  }
  if (command === 'decrypt' && args.length === 3 && args.every(absolute)) {
    const key = parseBackupKey(await readSmallJson(args[1], 4096));
    const read = await readEncryptedArchive({ file: args[0], key, output: args[2] });
    await writeFile(args[2] + '.meta.json', JSON.stringify(read.meta, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(JSON.stringify({ decrypted: true, ...summary(read) }));
    return;
  }
  if (command === 'compare' && args.length === 2 && args.every(absolute)) {
    const meta = await readSmallJson(args[0], 4 * 1024 * 1024);
    const { Client } = createRequire(join(resolve(args[1]), 'package.json'))('pg');
    const client = new Client({
      connectionString: new URL(process.env.EDGE_DATABASE_URL ?? '').href,
      connectionTimeoutMillis: 5000,
      statement_timeout: 120000,
    });
    client.on('error', () => undefined);
    await client.connect();
    try {
      const differences = await compareRestoredDatabase(client, meta);
      console.log(JSON.stringify({ matches: differences.length === 0, differences }));
      if (differences.length) process.exitCode = 1;
    } finally {
      await client.end();
    }
    return;
  }
  throw new Error('Invalid edge backup restore invocation');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(
      JSON.stringify({
        event: 'edge_backup_restore_failed',
        // Only reviewed codes; never paths, keys or driver messages.
        code: error instanceof EdgeBackupError ? error.code : 'INVALID_INPUT_OR_IO',
      }),
    );
    process.exitCode = 1;
  });
