import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, transaction, migrate } from '@pickchick/database';
import { StaffCredentialSchema } from '@pickchick/contracts';
import { createEdge } from '@pickchick/edge';
import {
  loginStaff,
  logoutStaff,
  setStaffPassword,
  provisionStaff,
  authenticateStaff,
} from '@pickchick/local-orders';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { withOrderDesk, staffAuth, staffHeaders } from '../helpers/orders.mjs';
import { running, request, withSyncDatabases } from '../helpers/sync.mjs';

const password = 'Synthetic password 42';
const loginBody = (credential, login = 'cashier.one', secret = password) => ({
  login,
  password: secret,
  terminal_id: credential.terminal_id,
});
const unauthorized = (error) => error.code === 'UNAUTHORIZED';
const loginPost = (url, body) =>
  request(url + '/edge/v1/staff/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const enroll = (ctx, credential = ctx.cashier, login = 'cashier.one') =>
  setStaffPassword(ctx.edge.pool, ctx.branch, staffAuth(credential), login, password);

test('password HTTP login preserves identity/role/closed ordering and logout revokes only its current bearer', async () => {
  await withOrderDesk(async (ctx) => {
    const before = (await ctx.edge.pool.query('SELECT * FROM branch_config')).rows;
    await enroll(ctx);
    await assert.rejects(
      transaction(ctx.edge.pool, (client) =>
        authenticateStaff(client, ctx.branch, staffAuth(ctx.cashier)),
      ),
      unauthorized,
    );
    // Password credentials allow a new 8h local session after the bootstrap access window has expired.
    await ctx.edge.pool.query(
      "UPDATE local_staff SET access_expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
      [ctx.cashier.staff_id],
    );
    const edge = await running(createEdge, ctx.edge.config);
    try {
      const response = await loginPost(edge.url, loginBody(ctx.cashier, ' CASHIER.ONE '));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const actor = StaffCredentialSchema.parse(await response.json());
      assert.equal(actor.staff_id, ctx.cashier.staff_id);
      assert.equal(actor.branch_id, ctx.branch);
      assert.equal(actor.terminal_id, ctx.cashier.terminal_id);
      assert.equal(actor.role, 'cashier');
      assert.ok(Date.parse(actor.expires_at) > Date.now() + 7.9 * 3600000);
      assert.equal(
        (await request(edge.url + '/edge/v1/session', { headers: staffHeaders(actor) })).status,
        200,
      );
      assert.deepEqual((await ctx.edge.pool.query('SELECT * FROM branch_config')).rows, before);
      const stored = (await ctx.edge.pool.query('SELECT * FROM local_staff_passwords')).rows[0];
      assert.equal(stored.algorithm, 'scrypt-v1');
      assert.ok(!JSON.stringify(stored).includes(password));
      const logout = await request(edge.url + '/edge/v1/staff/logout', {
        method: 'POST',
        headers: staffHeaders(actor),
      });
      assert.equal(logout.status, 204);
      assert.equal(await logout.text(), '');
      assert.equal(
        (await request(edge.url + '/edge/v1/session', { headers: staffHeaders(actor) })).status,
        401,
      );
      assert.equal(
        (await request(edge.url + '/edge/v1/session', { headers: staffHeaders(ctx.manager) }))
          .status,
        200,
      );
      const kitchen = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('kitchen'));
      await enroll(ctx, kitchen, 'kitchen.one');
      assert.equal(
        (await loginStaff(ctx.edge.pool, ctx.branch, loginBody(kitchen, 'kitchen.one'))).role,
        'kitchen',
      );
      const oversized = await loginPost(edge.url, {
        ...loginBody(ctx.cashier),
        padding: 'x'.repeat(2048),
      });
      assert.equal(oversized.status, 413);
      assert.ok(!(await oversized.text()).includes(password));
    } finally {
      await edge.app.close();
    }
  }, false);
});

test('generic failures and durable account lockout survive edge restart and do not return secret input', async () => {
  await withOrderDesk(async (ctx) => {
    await enroll(ctx);
    let edge = await running(createEdge, ctx.edge.config);
    try {
      const inputs = [
        loginBody(ctx.cashier, 'unknown.login'),
        loginBody(ctx.cashier, 'cashier.one', 'Wrong password 42'),
        { ...loginBody(ctx.cashier), terminal_id: randomUUID() },
        { ...loginBody(ctx.cashier), branch_id: randomUUID() },
      ];
      for (const input of inputs) {
        const response = await loginPost(edge.url, input);
        assert.equal(response.status, 401);
        const error = await response.json();
        assert.equal(error.code, 'UNAUTHORIZED');
        assert.equal(error.message_key, 'errors.unauthorized');
        assert.ok(!JSON.stringify(error).includes(input.password));
      }
      for (let i = 0; i < 3; i++)
        await assert.rejects(
          loginStaff(
            ctx.edge.pool,
            ctx.branch,
            loginBody(ctx.cashier, 'cashier.one', 'Wrong password 42'),
          ),
          unauthorized,
        );
      await edge.app.close();
      edge = await running(createEdge, ctx.edge.config);
      assert.equal(
        (await loginPost(edge.url, loginBody(ctx.cashier, 'cashier.one', 'Wrong password 42')))
          .status,
        401,
      );
      assert.equal(
        (await ctx.edge.pool.query('SELECT failed_attempts FROM local_staff_passwords')).rows[0]
          .failed_attempts,
        5,
      );
      assert.equal((await loginPost(edge.url, loginBody(ctx.cashier))).status, 401);
      await ctx.edge.pool.query(
        "UPDATE local_staff_passwords SET locked_until=clock_timestamp()-interval '1 second'",
      );
      const actor = await loginStaff(ctx.edge.pool, ctx.branch, loginBody(ctx.cashier));
      assert.equal(actor.staff_id, ctx.cashier.staff_id);
      assert.deepEqual(
        (
          await ctx.edge.pool.query(
            'SELECT failed_attempts,locked_until FROM local_staff_passwords',
          )
        ).rows,
        [{ failed_attempts: 0, locked_until: null }],
      );
      await ctx.edge.pool.query('UPDATE local_staff SET active=false WHERE id=$1', [
        actor.staff_id,
      ]);
      await assert.rejects(
        loginStaff(ctx.edge.pool, ctx.branch, loginBody(ctx.cashier)),
        unauthorized,
      );
    } finally {
      await edge.app.close();
    }
  }, false);
});

test('terminal throttle counts changing logins and survives restart without unbounded unknown-login rows', async () => {
  await withOrderDesk(async (ctx) => {
    await enroll(ctx);
    for (let i = 0; i < 10; i++)
      await assert.rejects(
        loginStaff(ctx.edge.pool, ctx.branch, loginBody(ctx.cashier, 'unknown.' + i)),
        unauthorized,
      );
    const edge = await running(createEdge, ctx.edge.config);
    try {
      const limited = await loginPost(edge.url, loginBody(ctx.cashier));
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('retry-after'), '60');
      assert.equal((await limited.json()).code, 'AUTH_RATE_LIMITED');
      assert.equal(
        (await ctx.edge.pool.query('SELECT count(*)::int AS n FROM local_staff_login_limits'))
          .rows[0].n,
        1,
      );
      assert.equal(
        (await ctx.edge.pool.query('SELECT count(*)::int AS n FROM local_staff_passwords')).rows[0]
          .n,
        1,
      );
      for (let i = 0; i < 5; i++)
        await assert.rejects(
          loginStaff(ctx.edge.pool, ctx.branch, {
            ...loginBody(ctx.cashier),
            terminal_id: randomUUID(),
          }),
          unauthorized,
        );
      assert.equal(
        (await ctx.edge.pool.query('SELECT count(*)::int AS n FROM local_staff_login_limits'))
          .rows[0].n,
        1,
      );
      await ctx.edge.pool.query(
        "UPDATE local_staff_login_limits SET window_started_at=clock_timestamp()-interval '61 seconds'",
      );
      assert.equal((await loginPost(edge.url, loginBody(ctx.cashier))).status, 200);
      assert.equal(
        (await ctx.edge.pool.query('SELECT attempts FROM local_staff_login_limits')).rows[0]
          .attempts,
        1,
      );
    } finally {
      await edge.app.close();
    }
  }, false);
});

test('runtime can authenticate/revoke but cannot set a password, change roles or create staff/terminals', async () => {
  await withOrderDesk(async (ctx) => {
    await enroll(ctx);
    const role = 'auth_runtime_' + randomUUID().replaceAll('-', ''),
      secret = randomBytes(32).toString('hex');
    let pool;
    try {
      await ctx.edge.admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      await applyEdgeRuntimeGrants(ctx.edge.pool, role, { schema: ctx.edge.schema });
      const url = new URL(ctx.edge.config.databaseUrl);
      url.username = role;
      url.password = secret;
      pool = createPool(url.toString());
      const actor = await loginStaff(pool, ctx.branch, loginBody(ctx.cashier));
      assert.equal(
        (
          await transaction(pool, (client) =>
            authenticateStaff(client, ctx.branch, staffAuth(actor)),
          )
        ).role,
        'cashier',
      );
      for (const sql of [
        "UPDATE local_staff_passwords SET verifier=repeat('0',64)",
        "UPDATE local_staff_passwords SET login='attacker'",
        'DELETE FROM local_staff_passwords',
        'INSERT INTO local_staff_passwords(staff_id) VALUES(gen_random_uuid())',
        "UPDATE local_staff SET role='shift_manager'",
        'UPDATE local_terminals SET active=true',
        'INSERT INTO local_terminals(id) VALUES(gen_random_uuid())',
      ])
        await assert.rejects(pool.query(sql), (error) => error.code === '42501');
      await logoutStaff(pool, ctx.branch, staffAuth(actor));
      await assert.rejects(
        transaction(pool, (client) => authenticateStaff(client, ctx.branch, staffAuth(actor))),
        unauthorized,
      );
    } finally {
      await pool?.end();
      await ctx.edge.admin.query(`DROP OWNED BY ${role}`);
      await ctx.edge.admin.query(`DROP ROLE ${role}`);
    }
  }, false);
});

test('enrollment/reset is explicit, preserves staff role/terminal grants and revokes old sessions', async () => {
  await withOrderDesk(async (ctx) => {
    await enroll(ctx);
    const actor = await loginStaff(ctx.edge.pool, ctx.branch, loginBody(ctx.cashier));
    await assert.rejects(
      setStaffPassword(ctx.edge.pool, ctx.branch, staffAuth(actor), 'new.login', password),
      (error) => error.code === 'CONFLICT',
    );
    await assert.rejects(
      setStaffPassword(ctx.edge.pool, ctx.branch, staffAuth(ctx.manager), 'cashier.one', password),
      (error) => error.code === 'CONFLICT',
    );
    const before = (
      await ctx.edge.pool.query('SELECT id,branch_id,role,active FROM local_staff ORDER BY id')
    ).rows;
    const terminals = (await ctx.edge.pool.query('SELECT * FROM local_terminals ORDER BY id')).rows;
    await setStaffPassword(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(actor),
      'new.login',
      'New synthetic password 43',
      true,
    );
    assert.deepEqual(
      (await ctx.edge.pool.query('SELECT id,branch_id,role,active FROM local_staff ORDER BY id'))
        .rows,
      before,
    );
    assert.deepEqual(
      (await ctx.edge.pool.query('SELECT * FROM local_terminals ORDER BY id')).rows,
      terminals,
    );
    await assert.rejects(
      transaction(ctx.edge.pool, (client) =>
        authenticateStaff(client, ctx.branch, staffAuth(actor)),
      ),
      unauthorized,
    );
    await assert.rejects(
      loginStaff(ctx.edge.pool, ctx.branch, loginBody(ctx.cashier)),
      unauthorized,
    );
    assert.equal(
      (
        await loginStaff(
          ctx.edge.pool,
          ctx.branch,
          loginBody(ctx.cashier, 'new.login', 'New synthetic password 43'),
        )
      ).role,
      'cashier',
    );
  }, false);
});

test('concurrent logout and password login have no lock-upgrade deadlock and leave one valid new session', async () => {
  await withOrderDesk(async (ctx) => {
    await enroll(ctx);
    let actor = await loginStaff(ctx.edge.pool, ctx.branch, loginBody(ctx.cashier));
    for (let i = 0; i < 3; i++) {
      const old = actor;
      const results = await Promise.allSettled([
        logoutStaff(ctx.edge.pool, ctx.branch, staffAuth(old)),
        loginStaff(ctx.edge.pool, ctx.branch, loginBody(ctx.cashier)),
      ]);
      if (results[0].status === 'rejected') assert.equal(results[0].reason.code, 'UNAUTHORIZED');
      assert.equal(results[1].status, 'fulfilled');
      actor = results[1].value;
      await assert.rejects(
        transaction(ctx.edge.pool, (client) =>
          authenticateStaff(client, ctx.branch, staffAuth(old)),
        ),
        unauthorized,
      );
      assert.equal(
        (
          await transaction(ctx.edge.pool, (client) =>
            authenticateStaff(client, ctx.branch, staffAuth(actor)),
          )
        ).staff_id,
        ctx.cashier.staff_id,
      );
    }
  }, false);
});

test('010 to 011 preserves existing sessions/menu/shift rows and does not seed a password or enable ordering', async () => {
  const directory = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));
  const old = await mkdtemp(join(tmpdir(), 'pickchick-password-upgrade-'));
  try {
    for (const name of await readdir(directory))
      if (/^\d{3}_[a-z_]+\.sql$/.test(name) && name < '011')
        await copyFile(join(directory, name), join(old, name));
    await withSyncDatabases(
      async (ctx) => {
        const setup = {
          staff_id: randomUUID(),
          terminal_id: randomUUID(),
          role: 'cashier',
          name: 'Synthetic legacy cashier',
        };
        const actor = await provisionStaff(ctx.edge.pool, ctx.branch, setup);
        const tables = [
          'branch_config',
          'local_staff',
          'local_terminals',
          'staff_sessions',
          'local_audit',
          'menu_snapshots',
          'active_menu',
          'local_cash_shifts',
        ];
        const before = new Map();
        for (const table of tables)
          before.set(
            table,
            (
              await ctx.edge.pool.query(
                'SELECT to_jsonb(t)' +
                  (table === 'branch_config'
                    ? "-'pos_service_mode'"
                    : table === 'local_terminals'
                      ? "-'device_access_managed'"
                      : '') +
                  ' AS record FROM ' +
                  table +
                  ' t',
              )
            ).rows,
          );
        const ledger = (
          await ctx.edge.pool.query(
            'SELECT version,checksum FROM schema_migrations ORDER BY version',
          )
        ).rows;
        const changed = await migrate(ctx.edge.pool, directory, 'edge');
        assert.ok(changed.includes('011_staff_passwords.sql'));
        assert.deepEqual(await migrate(ctx.edge.pool, directory, 'edge'), []);
        assert.deepEqual(
          (
            await ctx.edge.pool.query(
              'SELECT version,checksum FROM schema_migrations ORDER BY version',
            )
          ).rows.slice(0, 10),
          ledger,
        );
        for (const table of tables)
          assert.deepEqual(
            (
              await ctx.edge.pool.query(
                'SELECT to_jsonb(t)' +
                  (table === 'branch_config'
                    ? "-'pos_service_mode'"
                    : table === 'local_terminals'
                      ? "-'device_access_managed'"
                      : '') +
                  ' AS record FROM ' +
                  table +
                  ' t',
              )
            ).rows,
            before.get(table),
          );
        assert.equal(
          (
            await ctx.edge.pool.query(
              'SELECT count(*)::int AS n FROM local_terminals WHERE device_access_managed',
            )
          ).rows[0].n,
          0,
          'Migration does not enroll legacy terminals',
        );
        for (const table of ['local_staff_passwords', 'local_staff_login_limits'])
          assert.equal(
            (await ctx.edge.pool.query('SELECT count(*)::int AS n FROM ' + table)).rows[0].n,
            0,
          );
        assert.equal(
          (
            await transaction(ctx.edge.pool, (client) =>
              authenticateStaff(client, ctx.branch, staffAuth(actor)),
            )
          ).role,
          'cashier',
        );
      },
      { edgeMigrationDirectory: old },
    );
  } finally {
    await rm(old, { recursive: true, force: true });
  }
});
