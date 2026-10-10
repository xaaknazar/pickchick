import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool, transaction } from '@pickchick/database';
import {
  TerminalAccess,
  terminalHash,
  TerminalRateLimitError,
  exchangeTerminalAccess,
  provisionStaff,
  authenticateStaff,
} from '@pickchick/local-orders';
import { createEdge } from '../../services/edge/dist/index.js';
import { fixture } from '../../packages/edge-fulfillment/tests/fixture.mjs';
import { terminalAccessGrants } from '../../infra/windows/terminal-access-grants.mjs';

function make(ctx, extras = {}) {
  const code = randomBytes(16).toString('hex'),
    issuedAt = new Date();
  return {
    code,
    command: {
      commandId: randomUUID(),
      branchId: ctx.scope.branchId,
      edgeDeviceId: ctx.scope.deviceId,
      terminalId: randomUUID(),
      mode: 'display',
      name: 'Synthetic display',
      generation: 1,
      action: 'pair',
      codeHash: terminalHash(code),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 600000).toISOString(),
      ...extras,
    },
  };
}
const repo = (ctx) => new TerminalAccess(ctx.pool, ctx.scope.branchId, ctx.scope.deviceId);
const auth = (key) => ({ id: key.terminalId, key: key.terminalKey });
async function rejects(promise, code) {
  await assert.rejects(promise, (error) => error.code === code);
}

test('terminal pair is atomic one-use, mode mismatch does not consume, only hashes persist, receipt ACK cannot hide pair', async () =>
  fixture(async (ctx) => {
    const access = repo(ctx),
      item = make(ctx);
    assert.equal(await access.receive(item.command), 'applied');
    const initial = await access.receipts();
    await rejects(access.pair({ code: item.code, mode: 'prep' }), 'UNAUTHORIZED');
    const results = await Promise.allSettled([
      access.pair({ code: item.code, mode: 'display' }),
      access.pair({ code: item.code, mode: 'display' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const key = results.find((r) => r.status === 'fulfilled').value;
    assert.equal(key.terminalKey.length, 64);
    assert.equal((await access.session(auth(key))).mode, 'display');
    await access.acknowledge(initial[0]);
    assert.equal((await access.receipts())[0].state, 'paired');
    const database = JSON.stringify(
      (await ctx.pool.query('SELECT * FROM terminal_access_registry')).rows,
    );
    assert.ok(!database.includes(key.terminalKey));
    assert.ok(!database.includes(item.code));
    assert.equal(
      (await ctx.pool.query('SELECT code_hash FROM terminal_access_registry')).rows[0].code_hash,
      null,
    );
    assert.equal(await access.receive(item.command), 'paired');
    await rejects(access.receive({ ...item.command, name: 'changed' }), 'CONFLICT');
    const receipt = (await access.receipts())[0];
    await access.acknowledge(receipt);
    assert.deepEqual(await access.receipts(), []);
    assert.equal(await ctx.count('local_staff'), 4, 'pair must not create a staff identity');
  }));

test('generation fence invalidates old key, stale command cannot resurrect; overdue revoke still applies', async () =>
  fixture(async (ctx) => {
    const access = repo(ctx),
      first = make(ctx);
    await access.receive(first.command);
    const old = await access.pair({ code: first.code });
    const next = make(ctx, { terminalId: old.terminalId, generation: 3 });
    await access.receive(next.command);
    await rejects(access.session(auth(old)), 'UNAUTHORIZED');
    const stale = make(ctx, { terminalId: old.terminalId, generation: 2 });
    assert.equal(await access.receive(stale.command), 'rejected');
    const current = await access.pair({ code: next.code });
    const revoke = make(ctx, {
      terminalId: old.terminalId,
      generation: 4,
      action: 'revoke',
      codeHash: null,
      issuedAt: new Date(Date.now() - 1200000).toISOString(),
      expiresAt: new Date(Date.now() - 600000).toISOString(),
    });
    assert.equal(await access.receive(revoke.command), 'applied');
    await rejects(access.session(auth(current)), 'UNAUTHORIZED');
    assert.equal(
      (await ctx.pool.query('SELECT active FROM local_terminals WHERE id=$1', [old.terminalId]))
        .rows[0].active,
      false,
    );
    assert.equal(
      await access.receive(next.command),
      'paired',
      'old command replay returns historical receipt without mutation',
    );
    await rejects(access.session(auth(current)), 'UNAUTHORIZED');
  }));

test('foreign binding, legacy terminal collision and expired pair never grant access; rate limit persists failures', async () =>
  fixture(async (ctx) => {
    const access = repo(ctx),
      foreign = make(ctx, { edgeDeviceId: randomUUID() });
    await rejects(access.receive(foreign.command), 'FORBIDDEN');
    const collision = make(ctx, { terminalId: ctx.manager.terminal_id });
    assert.equal(await access.receive(collision.command), 'rejected');
    assert.equal(
      (
        await ctx.pool.query('SELECT active FROM local_terminals WHERE id=$1', [
          ctx.manager.terminal_id,
        ])
      ).rows[0].active,
      true,
    );
    const expired = make(ctx, {
      issuedAt: new Date(Date.now() - 700000).toISOString(),
      expiresAt: new Date(Date.now() - 100000).toISOString(),
    });
    assert.equal(await access.receive(expired.command), 'expired');
    await rejects(access.pair({ code: expired.code }), 'UNAUTHORIZED');
    for (let i = 0; i < 29; i++) await rejects(access.pair({ code: 'invalid' }), 'UNAUTHORIZED');
    await assert.rejects(access.pair({ code: 'invalid' }), TerminalRateLimitError);
    assert.equal(
      (await ctx.pool.query('SELECT count(*)::int AS count FROM terminal_pair_limits')).rows[0]
        .count,
      1,
    );
    assert.equal(
      (await ctx.pool.query('SELECT attempts FROM terminal_pair_limits')).rows[0].attempts,
      30,
    );
  }));

test('separate mailbox validates response scope and ACKs, durable replay survives unknown HTTP result', async () =>
  fixture(async (ctx) => {
    const access = repo(ctx),
      item = make(ctx),
      identity = { device_id: ctx.scope.deviceId, token: 'a'.repeat(64) },
      origin = 'https://synthetic.invalid';
    let sent;
    const fake = async (url, options) => {
      assert.equal(url, origin + '/internal/v1/edge/devices/exchange');
      assert.equal(options.redirect, 'error');
      sent = JSON.parse(options.body);
      return Response.json({
        branchId: ctx.scope.branchId,
        edgeDeviceId: ctx.scope.deviceId,
        commands: [item.command],
        acknowledged: sent.receipts,
      });
    };
    assert.equal((await exchangeTerminalAccess(access, identity, origin, fake)).received, 1);
    assert.equal((await exchangeTerminalAccess(access, identity, origin, fake)).acknowledged, 1);
    await assert.rejects(
      exchangeTerminalAccess(access, identity, origin, async () => {
        throw new Error('synthetic network loss');
      }),
    );
    assert.equal(await ctx.count('terminal_access_commands'), 1);
    await assert.rejects(
      exchangeTerminalAccess(access, identity, origin, async () =>
        Response.json({
          branchId: randomUUID(),
          edgeDeviceId: ctx.scope.deviceId,
          commands: [],
          acknowledged: [],
        }),
      ),
    );
    await assert.rejects(
      exchangeTerminalAccess(
        access,
        identity,
        origin,
        async () =>
          new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }),
      ),
    );
    assert.equal(await ctx.count('terminal_access_commands'), 1);
  }));

async function http(ctx, run) {
  const prior = process.env.EDGE_DEVICE_ACCESS_ENABLED;
  process.env.EDGE_DEVICE_ACCESS_ENABLED = 'true';
  const app = await createEdge({
    service: 'edge',
    environment: 'test',
    databaseUrl: ctx.url,
    branchId: ctx.scope.branchId,
    edgeDeviceId: ctx.scope.deviceId,
    edgeFulfillmentEnabled: true,
    port: 0,
  });
  try {
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    await run((path, options = {}) =>
      fetch(url + path, { signal: AbortSignal.timeout(5000), ...options }),
    );
  } finally {
    await app.close();
    if (prior === undefined) delete process.env.EDGE_DEVICE_ACCESS_ENABLED;
    else process.env.EDGE_DEVICE_ACCESS_ENABLED = prior;
  }
}
const terminalHeaders = (key) => ({
  'X-Terminal-ID': key.terminalId,
  'X-Terminal-Key': key.terminalKey,
});
const staffHeaders = (key, actor) => ({
  ...terminalHeaders(key),
  Authorization: 'Bearer ' + actor.token,
  'X-Staff-Session-ID': actor.session_id,
});

test('display credential only reads public queue and session; staff login/kitchen/actions denied, revoke immediate, legacy stays valid', async () =>
  fixture(async (ctx) => {
    const access = repo(ctx),
      item = make(ctx);
    await access.receive(item.command);
    await http(ctx, async (call) => {
      const response = await call('/edge/v1/terminals/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: item.code, mode: 'display' }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const key = await response.json();
      const session = await call('/edge/v1/terminals/session', { headers: terminalHeaders(key) });
      assert.equal(session.status, 200);
      assert.equal((await session.json()).terminalKey, undefined);
      assert.equal(
        (await call('/edge/v1/fulfillment/display', { headers: terminalHeaders(key) })).status,
        200,
      );
      assert.equal(
        (await call('/edge/v1/fulfillment/kitchen', { headers: terminalHeaders(key) })).status,
        401,
      );
      const login = await call('/edge/v1/staff/login', {
        method: 'POST',
        headers: { ...terminalHeaders(key), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          terminal_id: key.terminalId,
          login: 'synthetic',
          password: 'secret-not-authority',
        }),
      });
      assert.equal(login.status, 403);
      assert.equal(
        (
          await call('/edge/v1/fulfillment/display', {
            headers: {
              Authorization: 'Bearer ' + ctx.manager.token,
              'X-Staff-Session-ID': ctx.manager.session_id,
              'X-Terminal-ID': ctx.manager.terminal_id,
            },
          })
        ).status,
        200,
      );
      await access.receive(
        make(ctx, { terminalId: key.terminalId, generation: 2, action: 'revoke', codeHash: null })
          .command,
      );
      assert.equal(
        (await call('/edge/v1/fulfillment/display', { headers: terminalHeaders(key) })).status,
        401,
      );
    });
  }));

test('prep terminal still needs staff and cannot act on assembly or read another mode even as manager', async () =>
  fixture(async (ctx) => {
    const access = repo(ctx),
      item = make(ctx, { mode: 'prep' });
    await access.receive(item.command);
    const key = await access.pair({ code: item.code });
    const staff = await provisionStaff(ctx.pool, ctx.scope.branchId, {
      staff_id: ctx.manager.staff_id,
      terminal_id: key.terminalId,
      name: 'Synthetic staff',
      role: 'shift_manager',
    });
    const { order } = await ctx.accepted();
    await http(ctx, async (call) => {
      assert.equal(
        (
          await call('/edge/v1/fulfillment/kitchen?stationId=' + ctx.prep, {
            headers: terminalHeaders(key),
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await call('/edge/v1/fulfillment/kitchen?stationId=' + ctx.prep, {
            headers: staffHeaders(key, staff),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call('/edge/v1/fulfillment/kitchen?stationId=' + ctx.assembly, {
            headers: staffHeaders(key, staff),
          })
        ).status,
        403,
      );
      const noKey = staffHeaders(key, staff);
      delete noKey['X-Terminal-Key'];
      assert.equal(
        (await call('/edge/v1/fulfillment/kitchen?stationId=' + ctx.prep, { headers: noKey }))
          .status,
        401,
      );
      const stations = await (
        await call('/edge/v1/fulfillment/stations', { headers: staffHeaders(key, staff) })
      ).json();
      assert.deepEqual(
        stations.items.map((s) => s.id),
        [ctx.prep],
      );
      assert.equal(
        (
          await call('/edge/v1/fulfillment/orders/' + order.orderId + '/actions', {
            method: 'POST',
            headers: {
              ...staffHeaders(key, staff),
              'Content-Type': 'application/json',
              'Idempotency-Key': randomUUID(),
            },
            body: JSON.stringify({ action: 'ready', expectedVersion: order.version }),
          })
        ).status,
        403,
      );
      await rejects(
        transaction(ctx.pool, (db) =>
          authenticateStaff(db, ctx.scope.branchId, {
            sessionId: staff.session_id,
            token: staff.token,
          }),
        ),
        'UNAUTHORIZED',
      );
    });
  }));

test('restricted mailbox role writes only registration state; runtime role consumes code without mailbox insertion', async () =>
  fixture(async (ctx) => {
    const workerRole = 'device_worker_' + randomUUID().replaceAll('-', ''),
      runtimeRole = 'device_runtime_' + randomUUID().replaceAll('-', '');
    const roles = [workerRole, runtimeRole];
    const pools = [];
    try {
      for (const [index, role] of roles.entries()) {
        await ctx.admin.query(`CREATE ROLE ${role}`);
        await ctx.admin.query(terminalAccessGrants(role, ctx.schema, { worker: index === 0 }));
        const roleUrl = new URL(ctx.url);
        roleUrl.searchParams.set('options', `-c search_path=${ctx.schema} -c role=${role}`);
        const pool = createPool(roleUrl.toString(), 1);
        pools.push(pool);
        assert.equal((await pool.query('SELECT current_user')).rows[0].current_user, role);
      }
      const worker = new TerminalAccess(pools[0], ctx.scope.branchId, ctx.scope.deviceId),
        runtime = new TerminalAccess(pools[1], ctx.scope.branchId, ctx.scope.deviceId),
        item = make(ctx);
      await worker.receive(item.command);
      const key = await runtime.pair({ code: item.code });
      assert.equal((await runtime.session(auth(key))).valid, true);
      const receipts = await worker.receipts();
      await worker.acknowledge(receipts[0]);
      assert.deepEqual(await worker.receipts(), []);
      await assert.rejects(
        pools[0].query('SELECT * FROM local_staff'),
        (error) => error.code === '42501',
      );
      await assert.rejects(
        pools[0].query('UPDATE local_orders SET version=version+1'),
        (error) => error.code === '42501',
      );
      await assert.rejects(runtime.receive(make(ctx).command), (error) => error.code === '42501');
    } finally {
      for (const pool of pools) await pool.end();
      for (const role of roles) {
        await ctx.admin.query(`DROP OWNED BY ${role}`);
        await ctx.admin.query(`DROP ROLE ${role}`);
      }
    }
  }));

// Password reset is a separate owner ticket, never implied by terminal pairing.
import { KitchenPasswordReset, setStaffPassword, loginStaff } from '@pickchick/local-orders';
import { edgeRuntimeGrantSql } from '../../infra/windows/edge-runtime-grants.mjs';
function resetTicket(ctx, extras = {}) {
  const code = randomBytes(16).toString('hex'),
    issuedAt = new Date();
  return {
    code,
    command: {
      commandId: randomUUID(),
      branchId: ctx.scope.branchId,
      edgeDeviceId: ctx.scope.deviceId,
      login: 'kitchen',
      codeHash: terminalHash(code),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 600000).toISOString(),
      ...extras,
    },
  };
}
test('owner reset ticket needs existing kitchen identity and paired prep terminal; atomic consume revokes sessions without PIN/role writes', async () =>
  fixture(async (ctx) => {
    await setStaffPassword(
      ctx.pool,
      ctx.scope.branchId,
      ctx.cook.auth,
      'kitchen',
      'Original-test-password-18',
    );
    const old = await loginStaff(ctx.pool, ctx.scope.branchId, {
      login: 'kitchen',
      password: 'Original-test-password-18',
      terminal_id: ctx.cook.terminal_id,
    });
    const access = repo(ctx),
      prep = make(ctx, { mode: 'prep' }),
      display = make(ctx);
    await access.receive(prep.command);
    await access.receive(display.command);
    const prepKey = await access.pair({ code: prep.code }),
      displayKey = await access.pair({ code: display.code });
    const resets = new KitchenPasswordReset(ctx.pool, ctx.scope.branchId, ctx.scope.deviceId),
      ticket = resetTicket(ctx);
    assert.equal(await resets.receive(ticket.command), 'applied');
    const initial = await resets.receipts();
    const before = (
      await ctx.pool.query('SELECT id,branch_id,name,role,active FROM local_staff ORDER BY id')
    ).rows;
    const pins = (await ctx.pool.query('SELECT * FROM local_staff_pins')).rows;
    await rejects(
      resets.reset(
        {
          code: ticket.code,
          password: 'Changed-test-password-18',
          terminal_id: displayKey.terminalId,
        },
        auth(displayKey),
      ),
      'FORBIDDEN',
    );
    assert.equal((await resets.receipts())[0].state, 'applied');
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        resets.reset(
          {
            code: ticket.code,
            password: 'Changed-test-password-18',
            terminal_id: prepKey.terminalId,
          },
          auth(prepKey),
        ),
      ),
    );
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    await resets.acknowledge(initial[0]);
    assert.equal((await resets.receipts())[0].state, 'used');
    await rejects(
      transaction(ctx.pool, (db) =>
        authenticateStaff(db, ctx.scope.branchId, { sessionId: old.session_id, token: old.token }),
      ),
      'UNAUTHORIZED',
    );
    await rejects(
      loginStaff(ctx.pool, ctx.scope.branchId, {
        login: 'kitchen',
        password: 'Original-test-password-18',
        terminal_id: ctx.cook.terminal_id,
      }),
      'UNAUTHORIZED',
    );
    assert.equal(
      (
        await loginStaff(ctx.pool, ctx.scope.branchId, {
          login: 'kitchen',
          password: 'Changed-test-password-18',
          terminal_id: ctx.cook.terminal_id,
        })
      ).staff_id,
      ctx.cook.staff_id,
    );
    assert.deepEqual(
      (await ctx.pool.query('SELECT id,branch_id,name,role,active FROM local_staff ORDER BY id'))
        .rows,
      before,
    );
    assert.deepEqual((await ctx.pool.query('SELECT * FROM local_staff_pins')).rows, pins);
    const stored = JSON.stringify(
      (await ctx.pool.query('SELECT * FROM kitchen_password_reset_commands')).rows,
    );
    assert.ok(!stored.includes(ticket.code));
    assert.ok(!stored.includes('Changed-test-password'));
    assert.equal(
      Number(
        (
          await ctx.pool.query(
            "SELECT count(*) FROM local_audit WHERE action='staff.password_reset_by_owner_ticket'",
          )
        ).rows[0].count,
      ),
      1,
    );
    assert.equal(await resets.receive(ticket.command), 'used');
  }));

test('reset unknown identity/expired/older tickets never enroll staff; newer owner ticket invalidates older one', async () =>
  fixture(async (ctx) => {
    const resets = new KitchenPasswordReset(ctx.pool, ctx.scope.branchId, ctx.scope.deviceId);
    assert.equal(await resets.receive(resetTicket(ctx).command), 'rejected');
    await setStaffPassword(
      ctx.pool,
      ctx.scope.branchId,
      ctx.cook.auth,
      'kitchen',
      'Original-test-password-18',
    );
    const first = resetTicket(ctx);
    assert.equal(await resets.receive(first.command), 'applied');
    const newer = resetTicket(ctx, {
      issuedAt: new Date(Date.now() + 100).toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    });
    assert.equal(await resets.receive(newer.command), 'applied');
    assert.equal(
      (await resets.receipts()).find((r) => r.commandId === first.command.commandId).state,
      'expired',
    );
    assert.equal(
      await resets.receive(
        resetTicket(ctx, {
          issuedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 599000).toISOString(),
        }).command,
      ),
      'rejected',
    );
    assert.equal(await ctx.count('local_staff'), 4);
  }));

test('restricted worker cannot read password hashes; restricted runtime executes ticket reset and HTTP never exposes ticket material', async () =>
  fixture(async (ctx) => {
    await setStaffPassword(
      ctx.pool,
      ctx.scope.branchId,
      ctx.cook.auth,
      'kitchen',
      'Original-test-password-18',
    );
    const workerRole = 'reset_worker_' + randomUUID().replaceAll('-', ''),
      runtimeRole = 'reset_runtime_' + randomUUID().replaceAll('-', '');
    const roles = [workerRole, runtimeRole],
      pools = [];
    try {
      for (const [index, role] of roles.entries()) {
        await ctx.admin.query(`CREATE ROLE ${role}`);
        if (index === 1)
          await ctx.admin.query(
            edgeRuntimeGrantSql(role, {
              schema: ctx.schema,
              fulfillment: true,
              cashierReports: true,
              menuMedia: true,
              remoteStops: true,
            }),
          );
        await ctx.admin.query(terminalAccessGrants(role, ctx.schema, { worker: index === 0 }));
        const url = new URL(ctx.url);
        url.searchParams.set('options', `-c search_path=${ctx.schema} -c role=${role}`);
        pools.push(createPool(url.toString(), 1));
      }
      const worker = new TerminalAccess(pools[0], ctx.scope.branchId, ctx.scope.deviceId),
        runtime = new TerminalAccess(pools[1], ctx.scope.branchId, ctx.scope.deviceId);
      const item = make(ctx, { mode: 'assembly' });
      await worker.receive(item.command);
      const key = await runtime.pair({ code: item.code });
      const resetWorker = new KitchenPasswordReset(
          pools[0],
          ctx.scope.branchId,
          ctx.scope.deviceId,
        ),
        resetRuntime = new KitchenPasswordReset(pools[1], ctx.scope.branchId, ctx.scope.deviceId),
        ticket = resetTicket(ctx);
      assert.equal(await resetWorker.receive(ticket.command), 'applied');
      assert.deepEqual(
        await resetRuntime.reset(
          { code: ticket.code, password: 'Changed-test-password-18', terminal_id: key.terminalId },
          auth(key),
        ),
        { reset: true },
      );
      const receipt = (await resetWorker.receipts())[0];
      await resetWorker.acknowledge(receipt);
      assert.deepEqual(await resetWorker.receipts(), []);
      await assert.rejects(
        pools[0].query('SELECT verifier FROM local_staff_passwords'),
        (error) => error.code === '42501',
      );
      await assert.rejects(
        pools[0].query("UPDATE local_staff_passwords SET verifier=repeat('a',64)"),
        (error) => error.code === '42501',
      );
      await assert.rejects(
        pools[1].query("UPDATE local_staff SET role='shift_manager'"),
        (error) => error.code === '42501',
      );
      const next = resetTicket(ctx, {
        issuedAt: new Date(Date.now() + 200).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      });
      await resetWorker.receive(next.command);
      await http(ctx, async (call) => {
        const response = await call('/edge/v1/staff/password-reset', {
          method: 'POST',
          headers: { ...terminalHeaders(key), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: next.code,
            password: 'Final-test-password-18',
            terminal_id: key.terminalId,
          }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { reset: true });
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(
          (
            await call('/edge/v1/staff/password-reset', {
              method: 'POST',
              headers: { ...terminalHeaders(key), 'Content-Type': 'application/json' },
              body: JSON.stringify({
                code: next.code,
                password: 'Final-test-password-18',
                terminal_id: key.terminalId,
              }),
            })
          ).status,
          401,
        );
      });
    } finally {
      for (const pool of pools) await pool.end();
      for (const role of roles) {
        await ctx.admin.query(`DROP OWNED BY ${role}`);
        await ctx.admin.query(`DROP ROLE ${role}`);
      }
    }
  }));

test('managed credentials cannot downgrade with feature off; password login validates terminal key inside its transaction', async () =>
  fixture(async (ctx) => {
    await setStaffPassword(
      ctx.pool,
      ctx.scope.branchId,
      ctx.cook.auth,
      'kitchen',
      'Original-test-password-18',
    );
    const access = repo(ctx),
      item = make(ctx, { mode: 'prep' });
    await access.receive(item.command);
    const key = await access.pair({ code: item.code });
    const body = {
      login: 'kitchen',
      password: 'Original-test-password-18',
      terminal_id: key.terminalId,
    };
    await rejects(loginStaff(ctx.pool, ctx.scope.branchId, body), 'UNAUTHORIZED');
    const credential = await loginStaff(ctx.pool, ctx.scope.branchId, body, false, auth(key));
    const before = process.env.EDGE_DEVICE_ACCESS_ENABLED;
    process.env.EDGE_DEVICE_ACCESS_ENABLED = 'false';
    try {
      await rejects(
        transaction(ctx.pool, (db) =>
          authenticateStaff(db, ctx.scope.branchId, {
            sessionId: credential.session_id,
            token: credential.token,
          }),
        ),
        'UNAUTHORIZED',
      );
      assert.equal(
        (
          await transaction(ctx.pool, (db) =>
            authenticateStaff(db, ctx.scope.branchId, {
              sessionId: credential.session_id,
              token: credential.token,
              terminal: auth(key),
            }),
          )
        ).staff_id,
        ctx.cook.staff_id,
      );
      await access.receive(
        make(ctx, {
          terminalId: key.terminalId,
          mode: 'prep',
          generation: 2,
          action: 'revoke',
          codeHash: null,
        }).command,
      );
      await rejects(
        loginStaff(ctx.pool, ctx.scope.branchId, body, false, auth(key)),
        'UNAUTHORIZED',
      );
    } finally {
      if (before === undefined) delete process.env.EDGE_DEVICE_ACCESS_ENABLED;
      else process.env.EDGE_DEVICE_ACCESS_ENABLED = before;
    }
  }));

test('readiness proves schema020 and feature tables, not only a running HTTP process', async () =>
  fixture(async (ctx) => {
    await http(ctx, async (call) => {
      assert.equal((await call('/health/ready')).status, 200);
      await ctx.pool.query("DELETE FROM schema_migrations WHERE version='020_terminal_access.sql'");
      const result = await call('/health/ready');
      assert.equal(result.status, 503);
      assert.equal((await result.json()).ready, false);
    });
  }));

test('a managed terminal with missing registry remains fail-closed for bearer and password login', () =>
  fixture(async (ctx) => {
    await setStaffPassword(
      ctx.pool,
      ctx.scope.branchId,
      ctx.cook.auth,
      'kitchen',
      'Synthetic-password-missing-registry',
    );
    const legacy = await loginStaff(ctx.pool, ctx.scope.branchId, {
      login: 'kitchen',
      password: 'Synthetic-password-missing-registry',
      terminal_id: ctx.cook.terminal_id,
    });
    await ctx.pool.query('UPDATE local_terminals SET device_access_managed=true WHERE id=$1', [
      ctx.cook.terminal_id,
    ]);
    assert.equal(
      (
        await ctx.pool.query('SELECT 1 FROM terminal_access_registry WHERE terminal_id=$1', [
          ctx.cook.terminal_id,
        ])
      ).rowCount,
      0,
    );
    const before = process.env.EDGE_DEVICE_ACCESS_ENABLED;
    process.env.EDGE_DEVICE_ACCESS_ENABLED = 'false';
    try {
      for (const key of ['', randomBytes(32).toString('hex')]) {
        await rejects(
          transaction(ctx.pool, (db) =>
            authenticateStaff(db, ctx.scope.branchId, {
              sessionId: legacy.session_id,
              token: legacy.token,
              terminal: { id: ctx.cook.terminal_id, key },
            }),
          ),
          'UNAUTHORIZED',
        );
        await rejects(
          loginStaff(
            ctx.pool,
            ctx.scope.branchId,
            {
              login: 'kitchen',
              password: 'Synthetic-password-missing-registry',
              terminal_id: ctx.cook.terminal_id,
            },
            false,
            { id: ctx.cook.terminal_id, key },
          ),
          'UNAUTHORIZED',
        );
      }
    } finally {
      if (before === undefined) delete process.env.EDGE_DEVICE_ACCESS_ENABLED;
      else process.env.EDGE_DEVICE_ACCESS_ENABLED = before;
    }
  }));
