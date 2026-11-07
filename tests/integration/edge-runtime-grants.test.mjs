import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool } from '@pickchick/database';
import {
  createQuote,
  createLocalOrder,
  cancelLocalOrder,
  readSession,
  setOrdering,
  setStop,
  openCashShift,
  closeCashShift,
  readCashShift,
  provisionStaff,
  readPosConfig,
} from '@pickchick/local-orders';
import { EdgeFulfillment } from '@pickchick/edge-fulfillment';
import { applyMenu, hashJson } from '@pickchick/menu-sync';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { fixture } from '../../packages/edge-fulfillment/tests/fixture.mjs';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { createEdge } from '../../services/edge/dist/index.js';

const denied = (error) => error.code === '42501';

async function runtime(ctx, run) {
  const role = 'edge_runtime_' + randomUUID().replaceAll('-', '');
  const password = randomBytes(32).toString('hex');
  let pool;
  try {
    await ctx.admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    const options = { schema: ctx.schema, fulfillment: true };
    await applyEdgeRuntimeGrants(ctx.pool, role, options);
    const url = new URL(ctx.url);
    url.username = role;
    url.password = password;
    url.searchParams.set('options', `-c search_path=${ctx.schema}`);
    pool = createPool(url.toString(), 2);
    assert.equal((await pool.query('SELECT current_user')).rows[0].current_user, role);
    assert.equal((await pool.query('SELECT session_user')).rows[0].session_user, role);
    await run(pool, role, options, url.toString());
  } finally {
    if (pool) await pool.end();
    await ctx.admin.query(`DROP OWNED BY ${role}`);
    await ctx.admin.query(`DROP ROLE ${role}`);
  }
}

/** A role that holds nothing in the schema yet: the only role a schema020+ reset still grants (#278). */
async function freshRole(ctx, run) {
  const role = 'edge_runtime_' + randomUUID().replaceAll('-', '');
  await ctx.admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT`);
  try {
    await run(role);
  } finally {
    await ctx.admin.query(`DROP OWNED BY ${role}`);
    await ctx.admin.query(`DROP ROLE ${role}`);
  }
}

test('real edge runtime executes POS, row locks and kitchen lifecycle without setup authority', async () => {
  await fixture(async (ctx) => {
    const menu = { ...fixtureMenu, release_id: randomUUID(), branch_id: ctx.scope.branchId };
    await applyMenu(ctx.pool, ctx.scope.branchId, {
      event_id: randomUUID(),
      producer_id: randomUUID(),
      producer_sequence: '1',
      branch_id: ctx.scope.branchId,
      aggregate_type: 'menu_release',
      aggregate_id: menu.release_id,
      aggregate_version: 1,
      schema_version: 1,
      event_type: 'menu.published',
      payload: { menu, checksum: hashJson(menu) },
      occurred_at: new Date().toISOString(),
      correlation_id: randomUUID(),
      causation_id: null,
    });
    const accepted = await ctx.accepted(); // Trusted synthetic setup in this temporary schema only.
    const registerManager = await provisionStaff(ctx.pool, ctx.scope.branchId, {
      staff_id: randomUUID(),
      terminal_id: ctx.cashier.terminal_id,
      name: 'Synthetic register manager',
      role: 'shift_manager',
    });
    const managerAuth = { sessionId: registerManager.session_id, token: registerManager.token };
    await runtime(ctx, async (pool) => {
      const branch = ctx.scope.branchId;
      assert.equal((await readSession(pool, branch, ctx.cashier.auth)).role, 'cashier');
      const shift = await openCashShift(pool, branch, managerAuth, randomUUID(), {
        opening_cash_minor: '500000',
      });
      const quote = await createQuote(pool, branch, ctx.cashier.auth, {
        release_id: menu.release_id,
        service_mode: 'takeaway',
        items: [{ variant_id: menu.items[0].variant_id, quantity: 2 }],
      });
      const key = randomUUID();
      const order = await createLocalOrder(pool, branch, ctx.cashier.auth, key, {
        quote_id: quote.quote_id,
      });
      assert.equal(order.fulfillment_state, 'blocked');
      assert.equal(
        (await createLocalOrder(pool, branch, ctx.cashier.auth, key, { quote_id: quote.quote_id }))
          .order_id,
        order.order_id,
      );
      assert.equal(
        (
          await cancelLocalOrder(pool, branch, ctx.cashier.auth, randomUUID(), order.order_id, {
            expected_version: 1,
            reason: 'Synthetic grant acceptance',
          })
        ).state,
        'cancelled',
      );
      assert.equal(
        (await readCashShift(pool, branch, ctx.cashier.auth, shift.shift_id)).order_count,
        1,
      );
      const closed = await closeCashShift(pool, branch, managerAuth, randomUUID(), shift.shift_id, {
        expected_version: 1,
        counted_cash_minor: '499900',
        reason: 'Synthetic cash count',
      });
      assert.equal(closed.discrepancy_minor, '-100');
      await assert.rejects(pool.query('UPDATE local_cash_shifts SET opening_cash_minor=1'), denied);
      await assert.rejects(pool.query('DELETE FROM local_cash_shifts'), denied);
      await setStop(pool, branch, ctx.manager.auth, randomUUID(), {
        variant_id: menu.items[0].variant_id,
        expected_version: 0,
        stopped: true,
        reason: 'Synthetic stop',
      });
      await setStop(pool, branch, ctx.manager.auth, randomUUID(), {
        variant_id: menu.items[0].variant_id,
        expected_version: 1,
        stopped: false,
        reason: 'Synthetic return',
      });
      await setOrdering(pool, branch, ctx.manager.auth, randomUUID(), false, {
        expected_version: 1,
      });
      const repo = new EdgeFulfillment(pool);
      const page = await repo.listKitchen(branch, ctx.cook.auth, { stationId: ctx.prep });
      assert.equal(page.items.length, 1);
      let current = await repo.readOrder(branch, ctx.cook.auth, accepted.order.orderId, {
        stationId: ctx.prep,
      });
      for (const task of current.tasks) {
        for (const [action, expectedTaskVersion] of [
          ['start_task', task.version],
          ['complete_task', task.version + 1],
        ]) {
          current = await repo.act(branch, ctx.cook.auth, {
            commandId: randomUUID(),
            orderId: current.orderId,
            expectedVersion: current.version,
            action,
            taskId: task.id,
            expectedTaskVersion,
          });
        }
      }
      for (const action of ['ready', 'handoff'])
        current = await repo.act(branch, ctx.packer.auth, {
          commandId: randomUUID(),
          orderId: current.orderId,
          expectedVersion: current.version,
          action,
        });
      assert.equal(current.state, 'handed_over');
      for (const sql of [
        `UPDATE local_staff SET role='shift_manager' WHERE id='${ctx.cook.staff_id}'`,
        'UPDATE staff_sessions SET expires_at=now()',
        'UPDATE local_terminals SET active=false',
        'DELETE FROM fulfillment_station_grants',
        'UPDATE fulfillment_station_grants SET station_id=station_id',
        'INSERT INTO local_staff(id) VALUES(gen_random_uuid())',
        'DELETE FROM local_orders',
        'UPDATE menu_snapshots SET payload=payload',
        'UPDATE fulfillment_routing SET payload=payload',
        'UPDATE fulfillment_config SET device_id=device_id',
        'UPDATE fulfillment_stations SET kind=kind',
        'SELECT 1 FROM fulfillment_release_results',
        'INSERT INTO fulfillment_release_results(producer_id) VALUES(gen_random_uuid())',
        'UPDATE fulfillment_reservations SET snapshot=snapshot',
        'UPDATE fulfillment_outbox SET acknowledged_at=now()',
        'CREATE TABLE should_not_exist(id int)',
      ])
        await assert.rejects(pool.query(sql), denied, sql);
      await assert.rejects(
        pool.query('UPDATE local_staff SET lock_anchor=true'),
        (error) => error.code === '23514',
      );
      await setOrdering(pool, branch, ctx.manager.auth, randomUUID(), true, {
        expected_version: 2,
      });
      await assert.rejects(repo.acceptCloud(ctx.scope, ctx.admission()), denied);
    });
  });
});

test('kitchen HTTP uses restricted runtime credentials for config locks, stations and commands', async () => {
  await fixture(async (ctx) => {
    const accepted = await ctx.accepted();
    await runtime(ctx, async (_pool, _role, _options, databaseUrl) => {
      const app = await createEdge({
        service: 'edge',
        environment: 'test',
        databaseUrl,
        branchId: ctx.scope.branchId,
        edgeDeviceId: ctx.scope.deviceId,
        edgeFulfillmentEnabled: true,
        port: 0,
      });
      try {
        await app.listen(0, '127.0.0.1');
        const base = await app.getUrl();
        const call = async (path, actor, body) => {
          const response = await fetch(base + '/edge/v1/fulfillment' + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              Authorization: 'Bearer ' + actor.token,
              'X-Staff-Session-Id': actor.session_id,
              'X-Terminal-Id': actor.terminal_id,
              'Idempotency-Key': randomUUID(),
              'Content-Type': 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(5000),
          });
          return { status: response.status, body: await response.json() };
        };
        for (const [path, actor] of [
          ['/stations', ctx.cook],
          ['/kitchen?stationId=' + ctx.prep, ctx.cook],
          ['/display', ctx.cook],
          ['/orders/' + accepted.order.orderId + '?stationId=' + ctx.prep, ctx.cook],
        ])
          assert.equal((await call(path, actor)).status, 200, path);
        assert.equal((await call('/kitchen?stationId=' + ctx.assembly, ctx.cook)).status, 403);
        assert.equal((await call('/display', ctx.cashier)).status, 403);
        const current = await ctx.read(accepted.order.orderId);
        const task = current.tasks[0];
        const action = await call('/orders/' + current.orderId + '/actions', ctx.cook, {
          action: 'start_task',
          expectedVersion: current.version,
          taskId: task.id,
          expectedTaskVersion: task.version,
        });
        assert.equal(action.status, 200);
        assert.equal(action.body.state, 'in_production');
      } finally {
        await app.close();
      }
    });
  });
});

/** Every privilege of `role` on the objects of `schema`, as sorted text rows. */
async function privileges(pool, schema, role) {
  const { rows } = await pool.query(
    `SELECT format('%s|%s',c.relname,x.privilege_type) AS p
       FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
      WHERE c.relnamespace=$1::regnamespace AND x.grantee=$2::regrole
     UNION ALL
     SELECT format('%s.%s|%s',c.relname,a.attname,x.privilege_type)
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl) x
      WHERE c.relnamespace=$1::regnamespace AND a.attnum>0 AND NOT a.attisdropped AND x.grantee=$2::regrole
     UNION ALL
     SELECT format('%s()|%s',p.proname,x.privilege_type)
       FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
      WHERE p.pronamespace=$1::regnamespace AND x.grantee=$2::regrole
     UNION ALL
     SELECT format('schema|%s',x.privilege_type)
       FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) x
      WHERE n.oid=$1::regnamespace AND x.grantee=$2::regrole`,
    [schema, role],
  );
  return rows.map((r) => r.p).sort();
}

test('schema020+: reapplying runtime grants to a live role is refused before any REVOKE (#278)', async () => {
  await fixture(async (ctx) =>
    runtime(ctx, async (pool, role, options) => {
      // A grant from another tool (here a stray column) must survive the refused reapply.
      await ctx.pool.query(`GRANT UPDATE(role) ON local_staff TO ${role}`);
      const before = await privileges(ctx.pool, ctx.schema, role);
      assert.ok(before.includes('local_staff.role|UPDATE'));
      for (const attempt of [
        options,
        { ...options, fulfillment: false },
        { ...options, cloudLink: true },
        { schema: ctx.schema },
      ])
        await assert.rejects(applyEdgeRuntimeGrants(ctx.pool, role, attempt), /Live runtime role/);
      assert.deepEqual(await privileges(ctx.pool, ctx.schema, role), before);
      await pool.query("UPDATE local_staff SET role='cashier' WHERE false");
      await pool.query('SELECT 1 FROM fulfillment_reservations LIMIT 1');
      assert.equal((await readSession(pool, ctx.scope.branchId, ctx.cashier.auth)).role, 'cashier');
      const owner = (await ctx.pool.query('SELECT current_user')).rows[0].current_user;
      await assert.rejects(applyEdgeRuntimeGrants(ctx.pool, owner, options));
    }),
  );
});

test('schema020+: a role holding nothing yet is still granted; PUBLIC privileges are refused', async () => {
  await fixture(async (ctx) => {
    const fresh = 'edge_runtime_' + randomUUID().replaceAll('-', '');
    await ctx.admin.query(`CREATE ROLE ${fresh} NOLOGIN NOINHERIT`);
    try {
      const options = { schema: ctx.schema, fulfillment: true };
      await ctx.pool.query('GRANT UPDATE(role) ON local_staff TO PUBLIC');
      await assert.rejects(applyEdgeRuntimeGrants(ctx.pool, fresh, options), /public/i);
      assert.deepEqual(await privileges(ctx.pool, ctx.schema, fresh), []);
      await ctx.pool.query('REVOKE UPDATE(role) ON local_staff FROM PUBLIC');
      await applyEdgeRuntimeGrants(ctx.pool, fresh, options);
      assert.ok((await privileges(ctx.pool, ctx.schema, fresh)).includes('local_orders|INSERT'));
    } finally {
      await ctx.admin.query(`DROP OWNED BY ${fresh}`);
      await ctx.admin.query(`DROP ROLE ${fresh}`);
    }
  });
});

test('cutover 026: runtime grants hold exactly the reviewed POS sales privileges and a live role is never reset', async () => {
  await fixture(async (ctx) =>
    runtime(ctx, async (pool, role, options) => {
      const { RUNTIME_PRIVILEGES, assertPosSalesPrivileges, posSalesGrantees } =
        await import('../../infra/windows/pos-sales-grants.mjs');
      const exact = () =>
        assertPosSalesPrivileges(ctx.pool, role, RUNTIME_PRIVILEGES, { schema: ctx.schema });
      // CR pos-1 section 1: with 026 applied the reset re-grants the 026 runtime set exactly.
      assert.deepEqual(await exact(), { verified: true, relations: 14 });
      assert.deepEqual(await posSalesGrantees(ctx.pool, { schema: ctx.schema }), [role]);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM pos_payment_methods')).rows[0].n,
        8,
      );
      for (const sql of [
        'UPDATE pos_payment_methods SET enabled=true',
        "UPDATE branch_config SET pos_service_mode='pos_sale'",
        'SELECT 1 FROM pos_sale_sync_state',
        'SELECT 1 FROM pos_sales_setting_changes',
        'UPDATE pos_sale_outbox SET attempts=attempts+1',
        'DELETE FROM pos_sales',
      ])
        await assert.rejects(pool.query(sql), denied, sql);
      // #278: a live role is never reset. A stray grant makes the reset refuse before any REVOKE
      // and stays visible to the exact check until the operator removes it.
      await ctx.pool.query(`GRANT UPDATE ON pos_sales, pos_sale_sync_state TO ${role}`);
      await assert.rejects(exact(), /POS sales table privileges differ/);
      await assert.rejects(applyEdgeRuntimeGrants(ctx.pool, role, options), /Live runtime role/);
      await assert.rejects(exact(), /POS sales table privileges differ/);
      await ctx.pool.query(`REVOKE UPDATE ON pos_sales, pos_sale_sync_state FROM ${role}`);
      assert.deepEqual(await exact(), { verified: true, relations: 14 });
      // A first install without kitchen access still gets the POS sale objects (they are not
      // kitchen privileges).
      await freshRole(ctx, async (other) => {
        await applyEdgeRuntimeGrants(ctx.pool, other, { ...options, fulfillment: false });
        assert.deepEqual(
          await assertPosSalesPrivileges(ctx.pool, other, RUNTIME_PRIVILEGES, {
            schema: ctx.schema,
          }),
          { verified: true, relations: 14 },
        );
      });
      // A ledger that names 026 while its objects are missing (or the reverse) is refused.
      const row = (
        await ctx.pool.query(
          "DELETE FROM schema_migrations WHERE version='026_edge_pos_sales.sql' RETURNING version,checksum,scope",
        )
      ).rows[0];
      try {
        await freshRole(ctx, (other) =>
          assert.rejects(
            applyEdgeRuntimeGrants(ctx.pool, other, options),
            /POS sales migration objects differ/,
          ),
        );
      } finally {
        await ctx.pool.query(
          'INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)',
          [row.version, row.checksum, row.scope],
        );
      }
      assert.deepEqual(await exact(), { verified: true, relations: 14 });
    }),
  );
});

test('cutover 027: runtime grants hold exactly the reviewed KDS privileges with kitchen access only', async () => {
  await fixture(async (ctx) =>
    runtime(ctx, async (pool, role, options) => {
      const { assertKdsRuntimePrivileges, kdsTableGrantees } =
        await import('../../infra/windows/kds-grants.mjs');
      // CR kds-1 section 3: with 027 applied and fulfillment, the reset grants the KDS set.
      assert.equal((await assertKdsRuntimePrivileges(ctx.pool, role, ctx.schema)).verified, true);
      assert.deepEqual(await kdsTableGrantees(ctx.pool, ctx.schema), [role]);
      for (const sql of [
        'UPDATE kds_settings SET layout_enabled=true',
        'SELECT 1 FROM kds_setting_changes',
        'DELETE FROM courier_incidents',
        'UPDATE delivery_handovers SET staff_id=staff_id',
      ])
        await assert.rejects(pool.query(sql), denied, sql);
      // #278: dropping kitchen access on a live role is refused, the KDS set stays as it was.
      await assert.rejects(
        applyEdgeRuntimeGrants(ctx.pool, role, { ...options, fulfillment: false }),
        /Live runtime role/,
      );
      assert.equal((await assertKdsRuntimePrivileges(ctx.pool, role, ctx.schema)).verified, true);
      // A first install without kitchen access reaches none of the KDS tables.
      await freshRole(ctx, async (other) => {
        await applyEdgeRuntimeGrants(ctx.pool, other, { ...options, fulfillment: false });
        assert.deepEqual(await kdsTableGrantees(ctx.pool, ctx.schema), [role]);
        assert.equal(
          (
            await ctx.pool.query(`SELECT has_table_privilege($1,'kds_settings','SELECT') AS can`, [
              other,
            ])
          ).rows[0].can,
          false,
        );
      });
      // A ledger that names 027 while its objects are missing (or the reverse) is refused.
      const row = (
        await ctx.pool.query(
          "DELETE FROM schema_migrations WHERE version='027_edge_kds_foundation.sql' RETURNING version,checksum,scope",
        )
      ).rows[0];
      try {
        await freshRole(ctx, (other) =>
          assert.rejects(
            applyEdgeRuntimeGrants(ctx.pool, other, options),
            /KDS migration objects differ/,
          ),
        );
      } finally {
        await ctx.pool.query(
          'INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)',
          [row.version, row.checksum, row.scope],
        );
      }
    }),
  );
});

test('cutover 028: the runtime reads the desk number through its table SELECT and can never write it, with and without kitchen access', async () => {
  await fixture(async (ctx) =>
    runtime(ctx, async (pool, role, options) => {
      const { setDeskNumber } = await import('../../scripts/pos-sales-setup.mjs');
      // CR pos-7 section 1.3: 028 needs no grant of its own. The table-level SELECT on
      // local_terminals covers the new column; the runtime's column UPDATE(lock_anchor) and the
      // device access UPDATE(active) never reach it.
      const privileges = async (who = role) =>
        (
          await ctx.pool.query(
            `SELECT has_column_privilege($1,'local_terminals','desk_number','SELECT') AS select,
               has_column_privilege($1,'local_terminals','desk_number','INSERT') AS insert,
               has_column_privilege($1,'local_terminals','desk_number','UPDATE') AS update`,
            [who],
          )
        ).rows[0];
      const readOnly = { select: true, insert: false, update: false };
      assert.deepEqual(await privileges(), readOnly);
      await assert.rejects(pool.query('UPDATE local_terminals SET desk_number=1'), denied);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM local_terminals WHERE desk_number IS NOT NULL',
          )
        ).rows[0].n,
        0,
      );
      // A first install reads and never writes the desk number, with and without kitchen access.
      for (const fulfillment of [true, false])
        await freshRole(ctx, async (other) => {
          await applyEdgeRuntimeGrants(ctx.pool, other, { ...options, fulfillment });
          assert.deepEqual(await privileges(other), readOnly);
        });
      // GET pos/config of the runtime answers null until the owner numbers the desk, then the
      // number; the owner's audited command is the only writer.
      assert.equal(
        (await readPosConfig(pool, ctx.scope.branchId, ctx.cashier.auth)).desk_number,
        null,
      );
      const numbered = await setDeskNumber(ctx.pool, ctx.scope.branchId, {
        terminal_id: ctx.cashier.terminal_id,
        desk_number: 2,
        reason: 'Касса 2 у окна',
      });
      assert.deepEqual(numbered.desk, { terminal_id: ctx.cashier.terminal_id, desk_number: 2 });
      assert.equal(numbered.changes.length, 1);
      assert.equal(
        (await readPosConfig(pool, ctx.scope.branchId, ctx.cashier.auth)).desk_number,
        2,
      );
      await assert.rejects(
        pool.query('UPDATE local_terminals SET desk_number=NULL WHERE id=$1', [
          ctx.cashier.terminal_id,
        ]),
        denied,
      );
      // #278: a stray column grant makes the live reset refuse; the operator removes it.
      await ctx.pool.query(`GRANT UPDATE(desk_number) ON local_terminals TO ${role}`);
      assert.equal((await privileges()).update, true);
      await assert.rejects(applyEdgeRuntimeGrants(ctx.pool, role, options), /Live runtime role/);
      assert.equal((await privileges()).update, true);
      await ctx.pool.query(`REVOKE UPDATE(desk_number) ON local_terminals FROM ${role}`);
      assert.deepEqual(await privileges(), readOnly);
      assert.equal(
        (await readPosConfig(pool, ctx.scope.branchId, ctx.cashier.auth)).desk_number,
        2,
      );
    }),
  );
});
