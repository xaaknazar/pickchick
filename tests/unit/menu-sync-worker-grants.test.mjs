import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MENU_SYNC_PRIVILEGES,
  MENU_SYNC_ROLE,
  menuSyncWorkerGrants,
} from '../../infra/windows/menu-sync-worker-grants.mjs';
import {
  MENU_SYNC_BACKUP_MAX_AGE_MS,
  assertFreshBackup,
  menuSyncEnvText,
  parseMenuSyncEnv,
  readExpectedMigrations,
  scramVerifier,
} from '../../infra/windows/menu-sync-upgrade-db.mjs';
import { edgeRuntimeGrantSql } from '../../infra/windows/edge-runtime-grants.mjs';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const source = (name) =>
  readFileSync(new URL(`../../packages/menu-sync/src/${name}`, import.meta.url), 'utf8');

test('grant SQL matches the reviewed least-privilege list exactly', () => {
  assert.equal(
    menuSyncWorkerGrants(MENU_SYNC_ROLE),
    [
      'GRANT USAGE ON SCHEMA "public" TO "pickchick_menu_sync";',
      'GRANT SELECT ON "public"."schema_migrations", "public"."branch_config", "public"."menu_snapshots", "public"."active_menu", "public"."menu_sync_state", "public"."inbox_messages", "public"."outbox_events", "public"."menu_media", "public"."menu_apply_results", "public"."fulfillment_config", "public"."fulfillment_routing", "public"."fulfillment_stations" TO "pickchick_menu_sync";',
      'GRANT INSERT ON "public"."menu_snapshots", "public"."active_menu", "public"."menu_sync_state", "public"."inbox_messages", "public"."outbox_events", "public"."menu_media", "public"."menu_apply_results", "public"."fulfillment_routing" TO "pickchick_menu_sync";',
      'GRANT UPDATE("singleton") ON "public"."branch_config" TO "pickchick_menu_sync";',
      'GRANT UPDATE("release_id") ON "public"."active_menu" TO "pickchick_menu_sync";',
      'GRANT UPDATE("last_sequence") ON "public"."menu_sync_state" TO "pickchick_menu_sync";',
      'GRANT UPDATE("attempts", "acknowledged_at") ON "public"."outbox_events" TO "pickchick_menu_sync";',
      'GRANT UPDATE("active_routing_version") ON "public"."fulfillment_config" TO "pickchick_menu_sync";',
    ].join('\n'),
  );
  const sql = menuSyncWorkerGrants('menu_sync_test', 'edge_schema');
  assert.match(sql, /^GRANT USAGE ON SCHEMA "edge_schema" TO "menu_sync_test";/);
  assert.doesNotMatch(
    sql,
    /local_staff|local_orders|local_stops|staff_sessions|local_cash|checkout_quotes|remote_stop|cashier_report|fulfillment_reservations|fulfillment_tasks|GRANT ALL|DELETE|TRUNCATE|SEQUENCE/,
  );
  for (const value of ['role; DROP DATABASE x', 'public.role', '"role"', '', 'A', 'a'.repeat(64)]) {
    assert.throws(() => menuSyncWorkerGrants(value));
    assert.throws(() => menuSyncWorkerGrants('menu_sync', value));
  }
});

test('every table and column the menu worker code writes or reads is granted, and nothing else', () => {
  const sql = ['edge.ts', 'worker.ts', 'media.ts'].map(source).join('\n');
  const read = new Set(),
    inserted = new Set(),
    updated = new Map();
  const addUpdate = (table, columns) => {
    for (const column of columns) updated.set(`${table}.${column}`, true);
  };
  for (const [, table] of sql.matchAll(/\b(?:FROM|JOIN) ([a-z_]+)\b/g)) read.add(table);
  for (const match of sql.matchAll(
    /INSERT INTO ([a-z_]+)[\s\S]*?(?:ON CONFLICT[^`]*?DO UPDATE SET ([^`]*?))?(?:RETURNING|`)/g,
  )) {
    inserted.add(match[1]);
    if (match[2])
      addUpdate(
        match[1],
        [...match[2].matchAll(/([a-z_]+) = /g)].map((m) => m[1]),
      );
  }
  for (const match of sql.matchAll(/\bUPDATE ([a-z_]+) SET ([^']*?) WHERE/g))
    addUpdate(
      match[1],
      [...match[2].matchAll(/([a-z_]+) = /g)].map((m) => m[1]),
    );
  assert.deepEqual([...inserted].sort(), [
    'active_menu',
    'fulfillment_routing',
    'inbox_messages',
    'menu_apply_results',
    'menu_media',
    'menu_snapshots',
    'menu_sync_state',
    'outbox_events',
  ]);
  assert.deepEqual([...updated.keys()].sort(), [
    'active_menu.release_id',
    'fulfillment_config.active_routing_version',
    'menu_sync_state.last_sequence',
    'outbox_events.acknowledged_at',
    'outbox_events.attempts',
  ]);
  for (const table of read) assert.equal(MENU_SYNC_PRIVILEGES[table]?.select, true, table);
  for (const table of inserted) assert.equal(MENU_SYNC_PRIVILEGES[table]?.insert, true, table);
  for (const key of updated.keys()) {
    const [table, column] = key.split('.');
    assert.ok(MENU_SYNC_PRIVILEGES[table]?.update.includes(column), key);
  }
  // The grant list has no write the code does not need; branch_config UPDATE(singleton) only
  // backs the branch row lock and can only ever be set to true by its CHECK.
  for (const [table, privileges] of Object.entries(MENU_SYNC_PRIVILEGES)) {
    if (privileges.insert) assert.ok(inserted.has(table), table);
    for (const column of privileges.update)
      assert.ok(
        updated.has(`${table}.${column}`) || `${table}.${column}` === 'branch_config.singleton',
        `${table}.${column}`,
      );
  }
  // Row locks: FOR UPDATE needs an UPDATE privilege on some column of each locked table.
  assert.match(sql, /SELECT id FROM branch_config WHERE id = \$1 FOR UPDATE/);
  assert.ok(MENU_SYNC_PRIVILEGES.branch_config.update.length);
  assert.ok(MENU_SYNC_PRIVILEGES.fulfillment_config.update.length);
  assert.match(
    sql,
    /FROM fulfillment_config WHERE branch_id = \$1\$\{lock \? ' FOR UPDATE' : ''\}/,
  );
});

test('edge runtime gets read-only photo cache access only when schema018 is applied', () => {
  assert.doesNotMatch(edgeRuntimeGrantSql('edge_runtime'), /menu_media/);
  const sql = edgeRuntimeGrantSql('edge_runtime', { menuMedia: true });
  assert.match(sql, /GRANT SELECT ON "public"\."menu_media" TO "edge_runtime";/);
  assert.doesNotMatch(sql, /(INSERT|UPDATE[^;]*) ON "public"\."menu_media"|menu_apply_results/);
  assert.throws(() => edgeRuntimeGrantSql('edge_runtime', { menuMedia: 'true' }));
});

test('backup proof must be complete, fresh and taken at the current ledger', () => {
  const branchId = '10000000-0000-4000-8000-000000000003';
  const now = new Date('2026-10-08T12:00:00.000Z');
  const ledger = [
    { scope: 'edge', version: '001_edge_foundation.sql', checksum: 'a'.repeat(64) },
    { scope: 'edge', version: '002_edge_snapshot_guards.sql', checksum: 'b'.repeat(64) },
  ];
  const manifest = {
    format: 'pickchick-native-service-backup-v1',
    branchId,
    sourceDatabase: 'pickchick_edge',
    backupVerified: true,
    restoreVerified: true,
    rehearsalDropped: true,
    completed: true,
    sha256: 'c'.repeat(64),
    archiveBytes: 4096,
    finishedAt: '2026-10-08T10:00:00.000Z',
    // backup-native-service.mjs stores the ledger as version, checksum, scope.
    ledger: ledger.map(({ version, checksum, scope }) => ({ version, checksum, scope })),
  };
  assert.deepEqual(assertFreshBackup(manifest, { branchId, ledger, now }), {
    sha256: 'c'.repeat(64),
    finishedAt: manifest.finishedAt,
  });
  const stale = new Date(now.getTime() - MENU_SYNC_BACKUP_MAX_AGE_MS - 1).toISOString();
  for (const patch of [
    { finishedAt: stale },
    { finishedAt: '2026-10-08T12:00:01.000Z' },
    { finishedAt: 'yesterday' },
    { format: 'pickchick-native-backup-v1' },
    { branchId: '10000000-0000-4000-8000-0000000000aa' },
    { sourceDatabase: 'pickchick_cloud' },
    { backupVerified: false },
    { restoreVerified: 'true' },
    { rehearsalDropped: false },
    { completed: false },
    { sha256: 'C'.repeat(64) },
    { archiveBytes: 0 },
    { ledger: manifest.ledger.slice(0, 1) },
    { ledger: [manifest.ledger[0], { ...manifest.ledger[1], checksum: 'd'.repeat(64) }] },
  ])
    assert.throws(
      () => assertFreshBackup({ ...manifest, ...patch }, { branchId, ledger, now }),
      /Fresh matching backup/,
    );
  assert.throws(() => assertFreshBackup(null, { branchId, ledger, now }), /Fresh matching/);
});

test('worker environment is generated off by default and only a matching file is reused', () => {
  const branchId = '10000000-0000-4000-8000-000000000003',
    deviceId = '20000000-0000-4000-8000-000000000004',
    password = '1'.repeat(64);
  const text = menuSyncEnvText({ password, branchId, deviceId });
  assert.equal(
    text,
    [
      'APP_ENV=local',
      `EDGE_BRANCH_ID=${branchId}`,
      `EDGE_DEVICE_ID=${deviceId}`,
      'EDGE_MENU_SYNC_CLOUD_ORIGIN=http://127.0.0.1:43100',
      'EDGE_MENU_SYNC_MODE=off',
      `EDGE_DATABASE_URL=postgresql://pickchick_menu_sync:${password}@127.0.0.1:55433/pickchick_edge`,
      '',
    ].join('\n'),
  );
  assert.deepEqual(parseMenuSyncEnv(text, { branchId, deviceId }), { password, mode: 'off' });
  const report = text.replace('EDGE_MENU_SYNC_MODE=off', 'EDGE_MENU_SYNC_MODE=report');
  assert.equal(parseMenuSyncEnv(report, { branchId, deviceId }).mode, 'report');
  for (const changed of [
    text + 'EDGE_FULFILLMENT_ENABLED=true\n',
    text.replace('EDGE_MENU_SYNC_MODE=off', 'EDGE_MENU_SYNC_MODE=on'),
    text.replace('127.0.0.1:43100', '127.0.0.1:3100'),
    text.replace(deviceId, branchId),
    text.replace('pickchick_menu_sync', 'pickchick_edge_owner'),
  ])
    assert.throws(() => parseMenuSyncEnv(changed, { branchId, deviceId }), /not overwritten/);
  for (const input of [
    { password: 'short', branchId, deviceId },
    { password, branchId: 'x', deviceId },
    { password, branchId, deviceId, mode: 'on' },
  ])
    assert.throws(() => menuSyncEnvText(input));
});

test('SCRAM verifier is pre-hashed and the reviewed migration set contains 018', async () => {
  const verifier = scramVerifier('2'.repeat(64), Buffer.alloc(16, 7));
  assert.match(
    verifier,
    /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/,
  );
  assert.ok(!verifier.includes('2'.repeat(64)));
  assert.notEqual(scramVerifier('2'.repeat(64)), scramVerifier('2'.repeat(64)));
  assert.throws(() => scramVerifier('plain'));
  const migrations = await readExpectedMigrations(appRoot);
  assert.equal(migrations[17].version, '018_edge_menu_publication.sql');
  assert.ok(migrations.every((m) => m.scope === 'edge' && /^[a-f0-9]{64}$/.test(m.checksum)));
});

test('foundation credentials are validated without importing the unshipped foundation helper', async () => {
  const { foundationCredentials } = await import('../../infra/windows/menu-sync-upgrade-db.mjs');
  const branchId = '10000000-0000-4000-8000-000000000003';
  const valid = {
    format: 'pickchick-native-secrets-v1',
    branchId,
    installId: '20000000-0000-4000-8000-000000000005',
    passwords: {
      pickchick_bootstrap: '1'.repeat(64),
      pickchick_edge_owner: '2'.repeat(64),
      pickchick_edge_runtime: '3'.repeat(64),
    },
  };
  assert.equal(foundationCredentials(valid, branchId), valid);
  for (const value of [
    { ...valid, branchId: '10000000-0000-4000-8000-0000000000aa' },
    { ...valid, format: 'other' },
    { ...valid, passwords: { ...valid.passwords, pickchick_edge_owner: '1'.repeat(64) } },
    { ...valid, passwords: { ...valid.passwords, extra: '4'.repeat(64) } },
    { ...valid, passwords: { ...valid.passwords, pickchick_bootstrap: 'short' } },
    null,
  ])
    assert.throws(() => foundationCredentials(value, branchId), /Invalid private setup credential/);
});
