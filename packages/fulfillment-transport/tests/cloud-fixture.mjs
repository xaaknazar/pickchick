import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { CommerceRepository, digest } from '@pickchick/commerce-core';
import { provisionDevice } from '@pickchick/menu-sync';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { fixture as edgeFixture } from '../../edge-fulfillment/tests/fixture.mjs';
import {
  provisionFulfillmentTransport,
  pullFulfillment,
  acknowledgeFulfillment,
  receiveFulfillment,
} from '../dist/cloud.js';

const connection =
  process.env.FULFILLMENT_TRANSPORT_CLOUD_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
const checked = new URL(connection);
assert.ok(['postgres:', 'postgresql:'].includes(checked.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(checked.hostname), 'Local PostgreSQL only');
assert.ok(
  ['/pickchick_cloud', '/pickchick_test'].includes(checked.pathname),
  'Explicit development database only',
);
assert.equal(checked.search, '');
export const code = (expected) => (error) => error.code === expected;
export const eventOf = (row) => ({
  schemaVersion: 1,
  eventId: row.event_id,
  sequence: row.sequence,
  orderId: row.order_id,
  aggregateVersion: row.aggregate_version,
  type: row.event_type,
  payload: row.payload,
});
export function fixture(run) {
  return edgeFixture(async (edge) => {
    const schema = 'transport_cloud_' + randomUUID().replaceAll('-', ''),
      admin = createPool(connection, 2);
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(connection);
      url.searchParams.set('options', `-c search_path=${schema}`);
      pool = createPool(url.toString(), 16);
      await migrate(
        pool,
        fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url)),
        'cloud',
      );
      const { organizationId: org, branchId: branch, deviceId: device } = edge.scope;
      const legal = randomUUID(),
        release = randomUUID(),
        payment = randomUUID(),
        fiscal = randomUUID();
      await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic transport')", [
        org,
      ]);
      await pool.query(
        "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
        [legal, org],
      );
      await pool.query(
        "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'SYNTHETIC','Synthetic')",
        [branch, org, legal],
      );
      await pool.query(
        "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES($1,$2,$3,'edge','Synthetic')",
        [device, branch, org],
      );
      const credential = await provisionDevice(pool, device),
        auth = { deviceId: device, token: credential.token };
      const menu = { ...fixtureMenu, branch_id: branch, release_id: release };
      await pool.query(
        'INSERT INTO menu_releases(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,1,1,$3,$4,clock_timestamp())',
        [release, branch, menu, digest(menu)],
      );
      for (const [id, kind] of [
        [payment, 'payment'],
        [fiscal, 'fiscal'],
      ])
        await pool.query(
          "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,legal_entity_id,kind,provider,external_reference,enabled) VALUES($1,$2,$3,$4,$5,'synthetic-test',$6,true)",
          [id, org, branch, legal, kind, id],
        );
      const commerce = new CommerceRepository(pool),
        scope = { organizationId: org, branchId: branch, principalId: randomUUID(), role: 'sales' },
        manager = { ...scope, role: 'manager' };
      const workerId = randomUUID();
      const pull = (identity = auth) =>
        pullFulfillment(pool, identity, { workerId, leaseSeconds: 15 });
      const ack = (delivery, identity = auth) =>
        acknowledgeFulfillment(pool, identity, {
          eventId: delivery.command.eventId,
          workerId,
          leaseToken: delivery.leaseToken,
        });
      const events = async (orderId) =>
        (
          await edge.pool.query(
            'SELECT * FROM fulfillment_outbox WHERE order_id=$1 ORDER BY sequence',
            [orderId],
          )
        ).rows.map(eventOf);
      async function create() {
        const quote = await commerce.issueQuote(scope, randomUUID(), {
          releaseId: release,
          channel: 'mobile',
          serviceMode: 'takeaway',
          currency: 'KZT',
          ttlSeconds: 300,
          lines: [
            {
              lineId: randomUUID(),
              productId: 'burger',
              title: 'Synthetic burger',
              description: 'No onions',
              quantity: 2,
              unitPriceMinor: '150000',
              discountMinor: '0',
              taxCode: 'SYNTHETIC',
            },
          ],
        });
        const order = await commerce.createOrder(scope, randomUUID(), {
          quoteId: quote.quoteId,
          fiscalAccountId: fiscal,
        });
        return { ...order, quote };
      }
      async function reserve() {
        const value = await create(),
          delivery = (await pull()).event;
        assert.ok(delivery);
        assert.equal(delivery.command.type, 'edge.admission_requested');
        const reserved = await edge.repo.acceptCloud(edge.scope, delivery.command);
        return { ...value, reserved, delivery, event: (await events(value.orderId))[0] };
      }
      async function confirm(value) {
        await receiveFulfillment(pool, auth, value.event);
        await ack(value.delivery);
      }
      async function capture(value) {
        const attempt = await commerce.startPaymentAttempt(scope, randomUUID(), {
          orderId: value.orderId,
          providerAccountId: payment,
        });
        await commerce.observePayment(
          { organizationId: org, branchId: branch, accountId: payment },
          {
            eventId: randomUUID(),
            attemptId: attempt.attemptId,
            outcome: 'captured',
            operationId: randomUUID(),
            amountMinor: attempt.amountMinor,
            occurredAt: new Date().toISOString(),
          },
        );
        return await commerce.readOrder(scope, value.orderId);
      }
      async function issue(value) {
        const view = await capture(value),
          sale = view.fiscalDocuments[0];
        await commerce.observeFiscal(
          { organizationId: org, branchId: branch, accountId: fiscal },
          {
            eventId: randomUUID(),
            documentId: sale.id,
            outcome: 'issued',
            providerDocumentId: randomUUID(),
            fiscalMark: 'synthetic-only',
            receiptUrl: 'https://example.invalid/synthetic-only',
            amountMinor: sale.amount_minor,
            occurredAt: new Date().toISOString(),
          },
        );
      }
      async function accepted() {
        const value = await reserve();
        await confirm(value);
        await issue(value);
        const delivery = (await pull()).event;
        assert.equal(delivery.command.type, 'edge.kitchen_admission_requested');
        const accepted = await edge.repo.acceptCloud(edge.scope, delivery.command);
        await ack(delivery);
        return { ...value, accepted };
      }
      await provisionFulfillmentTransport(pool, edge.scope);
      await run({
        pool,
        admin,
        url,
        schema,
        auth,
        scope,
        manager,
        commerce,
        edge,
        legal,
        payment,
        fiscal,
        workerId,
        pull,
        ack,
        events,
        create,
        reserve,
        confirm,
        capture,
        issue,
        accepted,
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
  });
}
