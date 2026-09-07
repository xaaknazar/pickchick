import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { provisionStaff } from '@pickchick/local-orders';
import { EdgeFulfillment, provisionFulfillment, grantStation, digest } from '../dist/index.js';
export const connection =
  process.env.EDGE_FULFILLMENT_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55433/pickchick_edge';
const checked = new URL(connection);
assert.ok(['postgres:', 'postgresql:'].includes(checked.protocol));
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(checked.hostname),
  'Local edge PostgreSQL only',
);
assert.ok(
  ['/pickchick_edge', '/pickchick_test'].includes(checked.pathname),
  'Explicit development database only',
);
assert.equal(checked.search, '', 'Connection overrides may not select another host/schema');
export async function fixture(run) {
  const schema = 'fulfillment_' + randomUUID().replaceAll('-', '');
  const admin = createPool(connection, 2);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString(), 16);
    await migrate(
      pool,
      fileURLToPath(new URL('../../../db/edge/migrations/', import.meta.url)),
      'edge',
    );
    const scope = {
      organizationId: randomUUID(),
      branchId: randomUUID(),
      deviceId: randomUUID(),
      producerId: randomUUID(),
    };
    await pool.query(
      "INSERT INTO branch_config(id,code,name,timezone,ordering_enabled) VALUES($1,'SYNTHETIC','Synthetic edge','Asia/Almaty',true)",
      [scope.branchId],
    );
    const prep = randomUUID(),
      assembly = randomUUID();
    const setup = {
      ...scope,
      stations: [
        { id: prep, kind: 'prep', name: 'Synthetic prep' },
        { id: assembly, kind: 'assembly', name: 'Synthetic assembly' },
      ],
      routing: {
        version: 1,
        assemblyStationId: assembly,
        routes: [
          { productId: 'burger', stationId: prep, kind: 'prep' },
          { productId: 'fries', stationId: prep, kind: 'prep' },
          { productId: 'drink', stationId: assembly, kind: 'assembly_item' },
        ],
      },
    };
    await provisionFulfillment(pool, setup);
    const staff = async (role) => {
      const credential = await provisionStaff(pool, scope.branchId, {
        staff_id: randomUUID(),
        terminal_id: randomUUID(),
        name: 'Synthetic staff',
        role,
      });
      return { ...credential, auth: { sessionId: credential.session_id, token: credential.token } };
    };
    const cook = await staff('kitchen'),
      packer = await staff('kitchen'),
      manager = await staff('shift_manager'),
      cashier = await staff('cashier');
    await grantStation(pool, scope.branchId, cook.staff_id, prep);
    await grantStation(pool, scope.branchId, packer.staff_id, assembly);
    const repo = new EdgeFulfillment(pool);
    const admission = (combo = false) => {
      const snapshot = {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        legalEntityId: randomUUID(),
        customerId: randomUUID(),
        channel: 'mobile',
        serviceMode: 'takeaway',
        currency: 'KZT',
        totalMinor: '349000',
        ttlSeconds: 300,
        lines: [
          {
            lineId: randomUUID(),
            productId: combo ? 'combo' : 'burger',
            title: 'Synthetic combo',
            description: 'No onions; sealed bag',
            quantity: 2,
            unitPriceMinor: '174500',
            discountMinor: '0',
            grossMinor: '349000',
            totalMinor: '349000',
            taxCode: 'SYNTHETIC',
            ...(combo
              ? {
                  selectedDetails: {
                    kind: 'combo',
                    modifiers: [
                      {
                        groupId: 'drink',
                        groupTitle: { ru: 'Напиток', kk: '' },
                        optionId: 'drink',
                        label: { ru: 'Synthetic drink', kk: '' },
                        quantity: 1,
                        linkedProductId: 'drink',
                      },
                    ],
                    components: [
                      {
                        productId: 'burger',
                        quantity: 1,
                        name: { ru: 'Synthetic burger', kk: '' },
                        description: { ru: 'No onions', kk: '' },
                      },
                      {
                        productId: 'fries',
                        quantity: 2,
                        name: { ru: 'Synthetic fries', kk: '' },
                        description: { ru: 'Synthetic', kk: '' },
                      },
                      {
                        productId: 'drink',
                        quantity: 1,
                        name: { ru: 'Synthetic drink', kk: '' },
                        description: { ru: 'Cold', kk: '' },
                      },
                    ],
                  },
                }
              : {}),
          },
        ],
      };
      return {
        eventId: randomUUID(),
        type: 'edge.admission_requested',
        payload: {
          orderId: randomUUID(),
          branchId: scope.branchId,
          quoteId: randomUUID(),
          quoteDigest: digest(snapshot),
          snapshot,
          owner: 'cloud',
        },
      };
    };
    const authorize = (command, res) => ({
      eventId: randomUUID(),
      type: 'edge.kitchen_admission_requested',
      payload: {
        orderId: command.payload.orderId,
        branchId: scope.branchId,
        reservationId: res.reservationId,
        deviceId: scope.deviceId,
        quoteDigest: command.payload.quoteDigest,
        snapshot: command.payload.snapshot,
        owner: 'cloud',
      },
    });
    async function accepted(combo = false) {
      const command = admission(combo),
        reserved = await repo.acceptCloud(scope, command),
        auth = authorize(command, reserved),
        order = await repo.acceptCloud(scope, auth);
      return { command, reserved, auth, order };
    }
    const read = (id) => repo.readOrder(scope.branchId, manager.auth, id);
    const act = (order, action, actor = manager, extra = {}) =>
      repo.act(scope.branchId, actor.auth, {
        commandId: randomUUID(),
        orderId: order.orderId,
        expectedVersion: order.version,
        action,
        ...extra,
      });
    async function complete(order) {
      let current = await read(order.orderId);
      for (const task of current.tasks) {
        current = await act(current, 'start_task', manager, {
          taskId: task.id,
          expectedTaskVersion: task.version,
        });
        current = await act(current, 'complete_task', manager, {
          taskId: task.id,
          expectedTaskVersion: task.version + 1,
        });
      }
      return current;
    }
    const cancel = (row, type = 'edge.fulfillment_cancel_requested') => ({
      eventId: randomUUID(),
      type,
      payload: {
        orderId: row.orderId,
        branchId: scope.branchId,
        reservationId: row.reservationId,
        quoteDigest: row.quoteDigest,
        owner: 'cloud',
        expectedVersion: row.version,
        reason: 'Synthetic cancellation',
      },
    });
    const count = async (table) =>
      Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
    await run({
      schema,
      url: url.toString(),
      pool,
      admin,
      scope,
      setup,
      prep,
      assembly,
      cook,
      packer,
      manager,
      cashier,
      repo,
      admission,
      authorize,
      accepted,
      read,
      act,
      complete,
      cancel,
      count,
    });
  } finally {
    if (pool) await pool.end();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      assert.equal(
        (await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount,
        0,
      );
    } finally {
      await admin.end();
    }
  }
}
export const errorCode = (code) => (error) => error.code === code;
