/* global URLSearchParams */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { hashJson, syncMenuOnce } from '@pickchick/menu-sync';
import { provisionFulfillment } from '@pickchick/edge-fulfillment';
import { ensureMenuSyncRole, upgradeMenuSync } from '../../infra/windows/menu-sync-upgrade-db.mjs';
import { assertMenuSyncPrivileges } from '../../infra/windows/menu-sync-worker-grants.mjs';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const denied = (error) => error.code === '42501';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const webp = (seed) => {
  const body = Buffer.concat([Buffer.from('WEBPVP8L'), Buffer.from(seed.repeat(16))]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF'), size, body]);
};

/** Edge schema at ledger 017 (the cashier today) with fulfillment routing and two roles. */
async function edgeAt017(run) {
  const config = loadConfig('edge');
  const admin = createPool(config.databaseUrl, 2);
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `menu_role_${suffix}`,
    role = `menu_sync_${suffix}`,
    runtimeRole = `menu_runtime_${suffix}`;
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-menu-sync-upgrade-'));
  let pool;
  try {
    for (const name of (await readdir(join(appRoot, 'db/edge/migrations'))).filter(
      (n) => n.endsWith('.sql') && n < '018',
    ))
      await copyFile(join(appRoot, 'db/edge/migrations', name), join(dir, name));
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(config.databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString(), 4);
    await migrate(pool, dir, 'edge');
    const scope = {
      organizationId: randomUUID(),
      branchId: randomUUID(),
      deviceId: randomUUID(),
      producerId: randomUUID(),
    };
    await pool.query(
      "INSERT INTO branch_config(id,code,name,timezone) VALUES ($1,'MENU','Synthetic','Asia/Almaty')",
      [scope.branchId],
    );
    const prep = randomUUID(),
      assembly = randomUUID();
    await provisionFulfillment(pool, {
      ...scope,
      stations: [
        { id: prep, kind: 'prep', name: 'Synthetic prep' },
        { id: assembly, kind: 'assembly', name: 'Synthetic assembly' },
      ],
      routing: {
        version: 1,
        assemblyStationId: assembly,
        routes: [{ productId: fixtureMenu.items[0].product_id, stationId: prep, kind: 'prep' }],
      },
    });
    await admin.query(`CREATE ROLE ${runtimeRole} NOLOGIN NOINHERIT`);
    const ledger = async () =>
      (await pool.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version'))
        .rows;
    const backup = async (overrides = {}) => ({
      format: 'pickchick-native-service-backup-v1',
      runId: randomUUID(),
      branchId: scope.branchId,
      sourceDatabase: 'pickchick_edge',
      backupVerified: true,
      restoreVerified: true,
      rehearsalDropped: true,
      completed: true,
      sha256: 'a'.repeat(64),
      archiveBytes: 1024,
      finishedAt: new Date(Date.now() - 60000).toISOString(),
      ledger: (await ledger()).map((row) => ({
        version: row.version,
        checksum: row.checksum,
        scope: row.scope,
      })),
      ...overrides,
    });
    const options = async (mode, extra = {}) => ({
      mode,
      appRoot,
      branchId: scope.branchId,
      deviceId: scope.deviceId,
      backup: await backup(),
      schema,
      role,
      runtimeRole,
      // The shared development database keeps PUBLIC TEMP; the native foundation revokes it.
      databaseDefaultsRevoked: false,
      ...extra,
    });
    await run({
      admin,
      pool,
      url,
      schema,
      role,
      runtimeRole,
      scope,
      prep,
      assembly,
      backup,
      options,
    });
  } finally {
    await pool?.end();
    for (const name of [role, runtimeRole]) {
      await admin.query(`DROP OWNED BY ${name}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${name}`);
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
}

test('guarded upgrade applies 018, creates the login role once and grants the exact least-privilege set', async () => {
  await edgeAt017(async (ctx) => {
    const client = await ctx.pool.connect();
    try {
      const inspect = await upgradeMenuSync(client, await ctx.options('inspect'));
      assert.equal(inspect.migrations, 17);
      assert.equal(inspect.migrationPending, true);
      assert.equal(inspect.roleExists, false);
      assert.equal(inspect.grantsVerified, false);
      // Gates: stale or foreign backup, wrong device, wrong branch, missing role on apply.
      for (const backup of [
        await ctx.backup({ finishedAt: new Date(Date.now() - 7 * 3600_000).toISOString() }),
        await ctx.backup({ finishedAt: new Date(Date.now() + 3600_000).toISOString() }),
        await ctx.backup({ restoreVerified: false }),
        await ctx.backup({ branchId: randomUUID() }),
        await ctx.backup({ ledger: [] }),
        await ctx.backup({ format: 'pickchick-native-backup-v1' }),
      ])
        await assert.rejects(
          upgradeMenuSync(client, await ctx.options('inspect', { backup })),
          /Fresh matching backup/,
        );
      await assert.rejects(
        upgradeMenuSync(client, await ctx.options('inspect', { deviceId: randomUUID() })),
        /fulfillment binding/,
      );
      await assert.rejects(
        upgradeMenuSync(client, await ctx.options('inspect', { branchId: randomUUID() })),
        /Branch differs|Fresh matching backup/,
      );
      await assert.rejects(upgradeMenuSync(client, await ctx.options('apply')), /must exist first/);
      assert.equal(
        (await client.query("SELECT to_regclass('menu_media') IS NULL AS absent")).rows[0].absent,
        true,
      );

      const password = randomBytes(32).toString('hex');
      assert.deepEqual(await ensureMenuSyncRole(ctx.admin, { role: ctx.role, password }), {
        role: ctx.role,
        created: true,
      });
      // An existing role is verified, never reset.
      assert.deepEqual(
        await ensureMenuSyncRole(ctx.admin, {
          role: ctx.role,
          password: randomBytes(32).toString('hex'),
        }),
        { role: ctx.role, created: false },
      );
      const before = await ctx.backup();
      const applied = await upgradeMenuSync(client, await ctx.options('apply'));
      assert.equal(applied.migrationApplied, true);
      assert.equal(applied.migrations, 18);
      assert.equal(applied.grantsVerified, true);
      assert.equal(applied.fingerprint, inspect.fingerprint);
      // The old backup no longer matches the ledger.
      await assert.rejects(
        upgradeMenuSync(client, await ctx.options('inspect', { backup: before })),
        /Fresh matching backup/,
      );
      const again = await upgradeMenuSync(client, await ctx.options('apply'));
      assert.equal(again.migrationApplied, false);
      assert.equal(again.migrations, 18);
      assert.equal(again.grantsVerified, true);
      const verified = await upgradeMenuSync(client, await ctx.options('inspect'));
      assert.deepEqual(
        [verified.migrationPending, verified.roleExists, verified.grantsVerified],
        [false, true, true],
      );

      // Any widened privilege is detected by inspect and removed by a re-apply.
      await client.query(`GRANT SELECT ON local_staff TO ${ctx.role}`);
      assert.equal(
        (await upgradeMenuSync(client, await ctx.options('inspect'))).grantsVerified,
        false,
      );
      await client.query(`GRANT UPDATE(payload) ON menu_snapshots TO ${ctx.role}`);
      await assert.rejects(
        assertMenuSyncPrivileges(client, ctx.role, ctx.schema, { databaseDefaultsRevoked: false }),
        /privileges differ/,
      );
      assert.equal(
        (await upgradeMenuSync(client, await ctx.options('apply'))).grantsVerified,
        true,
      );
      // Another role's privileges are never changed by the helper.
      await client.query(`GRANT SELECT ON local_orders TO ${ctx.runtimeRole}`);
      await upgradeMenuSync(client, await ctx.options('apply'));
      assert.equal(
        (
          await client.query("SELECT has_table_privilege($1,'local_orders','SELECT') AS granted", [
            ctx.runtimeRole,
          ])
        ).rows[0].granted,
        true,
      );

      const rights = (
        await client.query(
          `SELECT has_table_privilege($1,'menu_media','SELECT') AS media_read,
            has_table_privilege($1,'menu_media','INSERT') AS media_insert,
            has_table_privilege($2,'local_staff','SELECT') AS staff,
            has_table_privilege($2,'local_orders','SELECT') AS orders,
            has_table_privilege($2,'local_stops','SELECT') AS stops,
            has_table_privilege($2,'menu_snapshots','DELETE') AS snapshot_delete,
            has_column_privilege($2,'menu_sync_state','producer_id','UPDATE') AS producer_rewrite,
            has_column_privilege($2,'fulfillment_config','device_id','UPDATE') AS device_rewrite,
            has_column_privilege($2,'outbox_events','payload','UPDATE') AS outbox_rewrite`,
          [ctx.runtimeRole, ctx.role],
        )
      ).rows[0];
      assert.deepEqual(rights, {
        media_read: true,
        media_insert: false,
        staff: false,
        orders: false,
        stops: false,
        snapshot_delete: false,
        producer_rewrite: false,
        device_rewrite: false,
        outbox_rewrite: false,
      });
    } finally {
      client.release();
    }
  });
});

test('the restricted role pulls, holds, downloads photos, derives routing, applies and rejects', async () => {
  await edgeAt017(async (ctx) => {
    const client = await ctx.pool.connect();
    const password = randomBytes(32).toString('hex');
    try {
      await ensureMenuSyncRole(ctx.admin, { role: ctx.role, password });
      await upgradeMenuSync(client, await ctx.options('apply'));
    } finally {
      client.release();
    }
    // Edge runtime grant reset now includes the read-only photo cache automatically.
    await applyEdgeRuntimeGrants(ctx.pool, ctx.runtimeRole, { schema: ctx.schema });
    await assert.rejects(
      applyEdgeRuntimeGrants(ctx.pool, ctx.runtimeRole, { schema: ctx.schema, menuMedia: false }),
      /flag differs/,
    );
    const branch = ctx.scope.branchId;
    // Operator-installed local v2 without a menu cursor, as on the cashier today.
    const local = { ...fixtureMenu, branch_id: branch, release_id: randomUUID(), version: 2 };
    await ctx.pool.query(
      `INSERT INTO menu_snapshots(id,branch_id,version,schema_version,payload,checksum,published_at)
       VALUES ($1,$2,2,1,$3,$4,$5)`,
      [local.release_id, branch, local, hashJson(local), local.published_at],
    );
    await ctx.pool.query('INSERT INTO active_menu(branch_id,release_id) VALUES ($1,$2)', [
      branch,
      local.release_id,
    ]);
    const photo = webp('card');
    const sha = sha256(photo);
    const installed = fixtureMenu.items[0];
    const added = {
      product_id: randomUUID(),
      variant_id: randomUUID(),
      category_id: installed.category_id,
      name: { ru: 'Новый ролл', kk: 'Жаңа ролл' },
      price_minor: '199000',
      currency: 'KZT',
      image_url: `/assets/menu/${sha}.webp`,
      image: { sha256: sha, url: `/assets/menu/${sha}.webp` },
      source_id: 'new-wrap',
      kind: 'item',
      kitchen: { route: 'prep' },
    };
    const release = (version) => ({
      ...fixtureMenu,
      branch_id: branch,
      release_id: randomUUID(),
      version,
      items: [
        { ...installed, source_id: 'installed', kind: 'item', kitchen: { route: 'prep' } },
        added,
      ],
    });
    const producer = randomUUID();
    const event = (menu, sequence) => ({
      event_id: randomUUID(),
      producer_id: producer,
      producer_sequence: String(sequence),
      aggregate_type: 'menu_release',
      aggregate_id: menu.release_id,
      aggregate_version: menu.version,
      event_type: 'menu.published',
      schema_version: 1,
      branch_id: branch,
      occurred_at: new Date().toISOString(),
      correlation_id: randomUUID(),
      causation_id: null,
      payload: { menu, checksum: hashJson(menu) },
    });
    const v3 = release(3);
    const queue = [event(v3, 1), event(release(3), 2)],
      acks = [],
      requests = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({ path: url.pathname, query: url.search });
      const json = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/internal/v1/edge/sync/pull')
        return json(200, { event: queue[0] ?? null });
      if (url.pathname === '/internal/v1/edge/sync/ack') {
        const ack = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        acks.push(ack);
        if (queue[0]?.event_id === ack.event_id) queue.shift();
        return json(200, { event_id: ack.event_id, acknowledged: true });
      }
      if (url.pathname === `/internal/v1/edge/media/${sha}.card.webp`) {
        res.writeHead(200, { 'Content-Type': 'image/webp' });
        return res.end(photo);
      }
      return json(404, { code: 'NOT_FOUND' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(ctx.url);
    url.username = ctx.role;
    url.password = password;
    const worker = createPool(url.toString(), 2);
    const identity = {
      device_id: ctx.scope.deviceId,
      branch_id: branch,
      token: 'b'.repeat(64),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    };
    try {
      assert.equal((await worker.query('SELECT current_user AS u')).rows[0].u, ctx.role);
      const sync = (applyEvents) => syncMenuOnce(worker, branch, origin, identity, { applyEvents });
      // Report mode: the active v2 is reported, the delivered v3 is held untouched.
      assert.deepEqual(await sync(false), { state: 'held', release_id: v3.release_id, version: 3 });
      assert.deepEqual(Object.fromEntries(new URLSearchParams(requests[0].query)), {
        active_release_id: local.release_id,
        active_version: '2',
      });
      assert.equal(requests.length, 1);
      assert.equal(acks.length, 0);
      // Apply mode as the restricted role: photo cache, routing v2, snapshot, ACK.
      assert.deepEqual(await sync(true), { state: 'applied' });
      assert.equal(acks.length, 1);
      assert.equal(acks[0].result, undefined);
      assert.equal(
        (await ctx.pool.query('SELECT release_id FROM active_menu')).rows[0].release_id,
        v3.release_id,
      );
      assert.equal(
        (await ctx.pool.query('SELECT active_routing_version AS v FROM fulfillment_config')).rows[0]
          .v,
        2,
      );
      assert.equal((await ctx.pool.query('SELECT sha256 FROM menu_media')).rows[0].sha256, sha);
      // A stale publication is ACKed rejected by the same role.
      assert.deepEqual(await sync(true), { state: 'rejected', reason: 'VERSION_NOT_NEWER' });
      assert.equal(acks[1].reason, 'VERSION_NOT_NEWER');
      assert.deepEqual(await sync(true), { state: 'idle' });
      assert.deepEqual(
        (await ctx.pool.query('SELECT version,result,reason FROM menu_apply_results ORDER BY 1'))
          .rows,
        [
          { version: 3, result: 'applied', reason: null },
          { version: 3, result: 'rejected', reason: 'VERSION_NOT_NEWER' },
        ],
      );
      // Nothing outside the menu domain is reachable.
      for (const sql of [
        'SELECT * FROM local_staff',
        'SELECT * FROM local_orders',
        'SELECT * FROM local_stops',
        'SELECT * FROM staff_sessions',
        'DELETE FROM menu_snapshots',
        'DELETE FROM outbox_events',
        "UPDATE outbox_events SET payload='{}'::jsonb",
        'UPDATE fulfillment_config SET device_id=gen_random_uuid()',
        'UPDATE branch_config SET ordering_enabled=true',
        'CREATE TABLE menu_sync_probe(id int)',
      ])
        await assert.rejects(worker.query(sql), denied, sql);
      // The edge runtime reads the cached photo but cannot write it.
      const runtime = await ctx.pool.connect();
      try {
        await runtime.query('BEGIN');
        await runtime.query(`SET LOCAL ROLE ${ctx.runtimeRole}`);
        assert.equal((await runtime.query('SELECT count(*)::int n FROM menu_media')).rows[0].n, 1);
        await assert.rejects(runtime.query('DELETE FROM menu_media'), denied);
        await runtime.query('ROLLBACK');
      } finally {
        runtime.release();
      }
    } finally {
      await worker.end();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
