import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { CommerceRepository, digest } from '@pickchick/commerce-core';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { fixture } from './fixture.mjs';

const cloudUrl =
  process.env.EDGE_FULFILLMENT_CLOUD_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
const checked = new URL(cloudUrl);
assert.ok(['postgres:', 'postgresql:'].includes(checked.protocol));
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(checked.hostname));
assert.ok(['/pickchick_cloud', '/pickchick_test'].includes(checked.pathname));
assert.equal(checked.search, '');

test('actual commerce outbox drives local admission and gated execution; handoff cannot mutate cloud money', () =>
  fixture(async (f) => {
    const schema = 'fulfillment_cloud_' + randomUUID().replaceAll('-', '');
    const admin = createPool(cloudUrl, 2);
    let cloud;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(cloudUrl);
      url.searchParams.set('options', `-c search_path=${schema}`);
      cloud = createPool(url.toString(), 4);
      await migrate(
        cloud,
        fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url)),
        'cloud',
      );
      const org = f.scope.organizationId,
        branch = f.scope.branchId,
        device = f.scope.deviceId,
        legal = randomUUID(),
        release = randomUUID(),
        payment = randomUUID(),
        fiscal = randomUUID();
      await cloud.query(
        "INSERT INTO organizations(id,name) VALUES($1,'Synthetic transport test')",
        [org],
      );
      await cloud.query(
        "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
        [legal, org],
      );
      await cloud.query(
        "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'SYNTHETIC','Synthetic transport test')",
        [branch, org, legal],
      );
      await cloud.query(
        "INSERT INTO devices(id,branch_id,organization_id,kind,name,status) VALUES($1,$2,$3,'edge','Synthetic','active')",
        [device, branch, org],
      );
      const menu = { ...fixtureMenu, branch_id: branch, release_id: release };
      await cloud.query(
        'INSERT INTO menu_releases(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,1,1,$3,$4,clock_timestamp())',
        [release, branch, menu, digest(menu)],
      );
      for (const [id, kind] of [
        [payment, 'payment'],
        [fiscal, 'fiscal'],
      ])
        await cloud.query(
          "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,legal_entity_id,kind,provider,external_reference,enabled) VALUES($1,$2,$3,$4,$5,'synthetic-test',$6,true)",
          [id, org, branch, legal, kind, id],
        );
      const commerce = new CommerceRepository(cloud),
        scope = { organizationId: org, branchId: branch, principalId: randomUUID(), role: 'sales' };
      const quote = await commerce.issueQuote(scope, randomUUID(), {
        releaseId: release,
        channel: 'mobile',
        serviceMode: 'dine_in',
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
      const admission = (
        await cloud.query(
          "SELECT * FROM commerce_outbox WHERE event_type='edge.admission_requested'",
        )
      ).rows[0];
      const reserved = await f.repo.acceptCloud(f.scope, {
        eventId: admission.id,
        type: admission.event_type,
        payload: admission.payload,
      });
      const ack = (
        await f.pool.query(
          "SELECT * FROM fulfillment_outbox WHERE event_type='edge.admission_reserved'",
        )
      ).rows[0];
      await commerce.confirmAdmission(
        { organizationId: org, branchId: branch, deviceId: device },
        {
          eventId: ack.event_id,
          orderId: reserved.orderId,
          reservationId: reserved.reservationId,
          quoteDigest: reserved.quoteDigest,
        },
      );
      const attempt = await commerce.startPaymentAttempt(scope, randomUUID(), {
        orderId: order.orderId,
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
      assert.equal(
        (
          await cloud.query(
            "SELECT count(*) FROM commerce_outbox WHERE event_type='edge.kitchen_admission_requested'",
          )
        ).rows[0].count,
        '0',
      );
      const paid = await commerce.readOrder(scope, order.orderId),
        sale = paid.fiscalDocuments[0];
      await commerce.observeFiscal(
        { organizationId: org, branchId: branch, accountId: fiscal },
        {
          eventId: randomUUID(),
          documentId: sale.id,
          outcome: 'issued',
          providerDocumentId: randomUUID(),
          fiscalMark: 'synthetic-mark',
          receiptUrl: 'https://example.invalid/synthetic-receipt',
          amountMinor: sale.amount_minor,
          occurredAt: new Date().toISOString(),
        },
      );
      const authorize = (
        await cloud.query(
          "SELECT * FROM commerce_outbox WHERE event_type='edge.kitchen_admission_requested'",
        )
      ).rows[0];
      const before = await commerce.readOrder(scope, order.orderId);
      let local = await f.repo.acceptCloud(f.scope, {
        eventId: authorize.id,
        type: authorize.event_type,
        payload: authorize.payload,
      });
      local = await f.complete(local);
      local = await f.act(local, 'ready', f.packer);
      local = await f.act(local, 'handoff', f.packer);
      assert.equal(local.state, 'handed_over');
      assert.equal(await f.count('fulfillment_tasks'), 1);
      const after = await commerce.readOrder(scope, order.orderId);
      assert.deepEqual(after, before);
      assert.equal(after.state, 'paid_pending_acceptance');
      assert.equal(after.money.captured, attempt.amountMinor);
      assert.equal(after.captures.length, 1);
      assert.equal(after.fiscalDocuments.length, 1);
    } finally {
      if (cloud) await cloud.end();
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
  }));
