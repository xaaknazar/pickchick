import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { CommerceRepository, digest } from '@pickchick/commerce-core';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { provisionDevice } from '@pickchick/menu-sync';
import { fixture as edgeFixture } from '../../edge-fulfillment/tests/fixture.mjs';
import { provisionFulfillmentTransport, syncFulfillmentOnce } from '../dist/index.js';
import { createApi } from '../../../services/api/dist/index.js';
import { createEdge } from '../../../services/edge/dist/index.js';

export async function fixture(run, { enabled = true, kitchenComment } = {}) {
  return edgeFixture(async (f) => {
    const cloudUrl =
      process.env.CLOUD_DATABASE_URL ??
      'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
    const checked = new URL(cloudUrl);
    assert.ok(['postgres:', 'postgresql:'].includes(checked.protocol));
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(checked.hostname));
    assert.equal(checked.pathname, '/pickchick_cloud');
    assert.equal(checked.search, '');
    const admin = createPool(cloudUrl, 2),
      schema = 'transport_worker_' + randomUUID().replaceAll('-', '');
    let cloud, api, edgeApi;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(cloudUrl);
      url.searchParams.set('options', `-c search_path=${schema}`);
      cloud = createPool(url.toString(), 8);
      await migrate(
        cloud,
        fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url)),
        'cloud',
      );
      assert.deepEqual(
        await migrate(
          cloud,
          fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url)),
          'cloud',
        ),
        [],
      );
      assert.deepEqual(
        await migrate(
          f.pool,
          fileURLToPath(new URL('../../../db/edge/migrations/', import.meta.url)),
          'edge',
        ),
        [],
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
        "INSERT INTO devices(id,branch_id,organization_id,kind,name,status) VALUES($1,$2,$3,'edge','Synthetic','pending')",
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
        ...(kitchenComment ? { kitchenComment } : {}),
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

      const identity = await provisionDevice(cloud, device);
      await provisionFulfillmentTransport(cloud, f.scope);
      api = await createApi({
        service: 'api',
        environment: 'test',
        databaseUrl: url.toString(),
        port: 0,
        fulfillmentTransportEnabled: enabled,
      });
      await api.listen(0, '127.0.0.1');
      const origin = await api.getUrl();
      edgeApi = await createEdge({
        service: 'edge',
        environment: 'test',
        databaseUrl: f.url,
        port: 0,
        branchId: branch,
        edgeDeviceId: device,
        edgeFulfillmentEnabled: true,
        fulfillmentTransportEnabled: true,
      });
      await edgeApi.listen(0, '127.0.0.1');
      const edgeOrigin = await edgeApi.getUrl();
      const options = { enabled: true, branchId: branch, origin, identity };
      const tick = (io) => syncFulfillmentOnce(f.pool, options, io);
      const counts = async (pool, table) =>
        (await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count;
      const pay = async () => {
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
        const sale = (await commerce.readOrder(scope, order.orderId)).fiscalDocuments[0];
        return { attempt, sale };
      };
      const fiscalize = async (sale) =>
        commerce.observeFiscal(
          { organizationId: org, branchId: branch, accountId: fiscal },
          {
            eventId: randomUUID(),
            documentId: sale.id,
            outcome: 'issued',
            providerDocumentId: randomUUID(),
            fiscalMark: 'synthetic',
            receiptUrl: 'https://example.invalid/synthetic-receipt',
            amountMinor: sale.amount_minor,
            occurredAt: new Date().toISOString(),
          },
        );
      const createAdditional = async (productId) => {
        const nextQuote = await commerce.issueQuote(scope, randomUUID(), {
          releaseId: release,
          channel: 'mobile',
          serviceMode: 'takeaway',
          currency: 'KZT',
          ttlSeconds: 300,
          lines: [
            {
              lineId: randomUUID(),
              productId,
              title: 'Synthetic ' + productId,
              description: 'Synthetic',
              quantity: 1,
              unitPriceMinor: '100000',
              discountMinor: '0',
              taxCode: 'SYNTHETIC',
            },
          ],
        });
        return commerce.createOrder(scope, randomUUID(), {
          quoteId: nextQuote.quoteId,
          fiscalAccountId: fiscal,
        });
      };
      const lan = async (path, { actor = f.packer, body, key, ...init } = {}) =>
        fetch(edgeOrigin + '/edge/v1/fulfillment' + path, {
          ...init,
          headers: {
            Authorization: 'Bearer ' + actor.token,
            'X-Staff-Session-Id': actor.session_id,
            'X-Terminal-Id': actor.terminal_id,
            'Content-Type': 'application/json',
            ...(key ? { 'Idempotency-Key': key } : {}),
          },
          ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
        });
      await run({
        ...f,
        cloud,
        commerce,
        commercialScope: scope,
        order,
        quote,
        identity,
        options,
        tick,
        createAdditional,
        counts,
        pay,
        fiscalize,
        origin,
        edgeOrigin,
        api,
        edgeApi,
        lan,
      });
    } finally {
      if (api) await api.close();
      if (edgeApi) await edgeApi.close();
      if (cloud) await cloud.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
}
