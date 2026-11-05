import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Transactional database step only, not a deployment entry point. The Windows operator must
// first verify cloud072, exact runtime/CI, fresh restored backup and stopped writers under the
// maintenance lease. This helper never starts services, fences a database or sends an event.
export const QUEUE_RECOVERY_MIGRATION = '025_edge_kitchen_restore_review.sql';
export const QUEUE_RECOVERY_CHECKSUM =
  'ab73b1abff4850098c513d7b39bda5e86ff21ac6ea5c06a1420410dcb31ad18a';
const added = [
  'fulfillment_restore_epochs',
  'fulfillment_restore_reviews',
  'fulfillment_restore_decisions',
];
const functions = [
  'mark_restored_fulfillment()',
  'stamp_restored_fulfillment_event()',
  'guard_fulfillment_restore_history()',
];
const identifier = (name) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name ?? '')) throw Error('Invalid identifier');
  return '"' + name + '"';
};
const hash = (value) => createHash('sha256').update(value).digest('hex');

export async function upgradeQueueRecoverySchema(
  client,
  { mode, appRoot, branchId, schema = 'public', runtimeRole = 'pickchick_edge_runtime' },
) {
  if (!['inspect', 'apply'].includes(mode)) throw Error('Invalid mode');
  const ns = identifier(schema),
    role = identifier(runtimeRole);
  const pinned = JSON.parse(
    await readFile(new URL('./native-edge-backup-ledger.json', import.meta.url), 'utf8'),
  ).slice(0, 25);
  if (
    pinned.length !== 25 ||
    pinned[24].version !== QUEUE_RECOVERY_MIGRATION ||
    pinned[24].checksum !== QUEUE_RECOVERY_CHECKSUM
  )
    throw Error('Reviewed ledger differs');
  for (const entry of pinned) {
    if (hash(await readFile(join(appRoot, 'db/edge/migrations', entry.version))) !== entry.checksum)
      throw Error('Reviewed migration bytes differ');
  }
  const sql = await readFile(join(appRoot, 'db/edge/migrations', QUEUE_RECOVERY_MIGRATION), 'utf8');
  if (hash(sql) !== QUEUE_RECOVERY_CHECKSUM) throw Error('Reviewed migration bytes differ');
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-queue-recovery-025',0))",
    );
    const tables = (
      await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [
        schema,
      ])
    ).rows.map((r) => r.tablename);
    if (!tables.includes('schema_migrations') || added.some((t) => tables.includes(t)))
      throw Error('Expected schema024 without restore-review objects');
    await client.query(
      'LOCK TABLE ' +
        tables.map((t) => ns + '.' + identifier(t)).join(',') +
        ' IN ACCESS EXCLUSIVE MODE',
    );
    const ledger = (
      await client.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')
    ).rows;
    if (JSON.stringify(ledger) !== JSON.stringify(pinned.slice(0, 24)))
      throw Error('Exact unchanged schema024 required; no replay');
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw Error('Branch differs');
    const roles = (
      await client.query(
        `SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
        EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS member,
        EXISTS(SELECT 1 FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass
          AND d.refobjid=r.oid AND d.deptype='o') AS owns
        FROM pg_roles r WHERE rolname=$1`,
        [runtimeRole],
      )
    ).rows;
    if (roles.length !== 1 || Object.entries(roles[0]).some(([k, v]) => k !== 'oid' && v))
      throw Error('Existing unprivileged runtime role required');
    const snapshot = async () => {
      const data = {};
      for (const table of tables.filter((t) => t !== 'schema_migrations')) {
        data[table] = (
          await client.query(
            `SELECT count(*)::text count,md5(COALESCE(string_agg(h,'' ORDER BY h),'')) digest
           FROM (SELECT md5(to_jsonb(t)::text) h FROM ${ns}.${identifier(table)} t) rows`,
          )
        ).rows[0];
      }
      data.sequences = (
        await client.query(
          'SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename',
          [schema],
        )
      ).rows;
      data.acl = (
        await client.query(
          `SELECT c.relname,c.relacl,a.attname,a.attacl FROM pg_class c
         LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
         WHERE c.relnamespace=$1::regnamespace AND c.relname=ANY($2)
         ORDER BY c.relname,a.attnum`,
          [schema, tables],
        )
      ).rows;
      return JSON.stringify(data);
    };
    const before = await snapshot();
    if (mode === 'apply') {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)', [
        'edge',
        QUEUE_RECOVERY_MIGRATION,
        QUEUE_RECOVERY_CHECKSUM,
      ]);
      // Add only the new permissions. Keep existing runtime/worker grants byte-for-byte.
      await client.query(`GRANT SELECT ON ${ns}.fulfillment_restore_reviews,${ns}.fulfillment_restore_decisions TO ${role};
        GRANT INSERT ON ${ns}.fulfillment_restore_decisions TO ${role};`);
      for (const fn of functions)
        await client.query(`REVOKE ALL ON FUNCTION ${ns}.${fn} FROM PUBLIC`);
      const unexpected = (
        await client.query(
          `SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
         WHERE c.relnamespace=$1::regnamespace AND c.relname=ANY($2)
         AND x.grantee<>c.relowner AND (x.is_grantable OR x.grantee<>$3 OR
           NOT (c.relname IN ('fulfillment_restore_reviews','fulfillment_restore_decisions') AND x.privilege_type='SELECT'
             OR c.relname='fulfillment_restore_decisions' AND x.privilege_type='INSERT'))`,
          [schema, added, roles[0].oid],
        )
      ).rowCount;
      if (unexpected) throw Error('Unexpected restore-review privileges');
      if ((await snapshot()) !== before)
        throw Error('Existing data, sequences or privileges changed');
      for (const table of added) {
        if (
          (await client.query(`SELECT count(*)::int n FROM ${ns}.${identifier(table)}`)).rows[0]
            .n !== 0
        )
          throw Error('Upgrade must not fence or resolve existing orders');
      }
    }
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      migrations: mode === 'apply' ? 25 : 24,
      dataPreserved: true,
      fingerprint: hash(before),
      runtimeRole,
      restoreFenceExecuted: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
