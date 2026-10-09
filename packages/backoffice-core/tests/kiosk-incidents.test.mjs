import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  publishMenu,
  projectCatalogMenu,
  provisionDevice,
  pullMenu,
  applyMenu,
  acknowledgeMenu,
} from '@pickchick/menu-sync';
import { KioskCheckout, KioskSessions, KioskKaspiQrProcessor } from '@pickchick/commerce-core';
import { withSyncDatabases, authFor } from '../../../tests/helpers/sync.mjs';
import { publishCatalog } from '../../commerce-core/tests/catalog-fixture.mjs';
import { kioskIncidentGrants } from '../../../infra/staging/kiosk-incident-grants.mjs';
import { KioskPaymentIncidents } from '../dist/kiosk-incidents.js';

// Synthetic localhost databases only; no bank, bridge or private server env is touched.
process.env.APP_ENV ??= 'test';
process.env.CLOUD_DATABASE_URL ??=
  process.env.COMMERCE_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
process.env.EDGE_DATABASE_URL ??=
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55433/pickchick_edge';
process.env.EDGE_BRANCH_ID ??= randomUUID();
process.env.REDIS_URL ??= 'redis://127.0.0.1:56379/0';
for (const name of ['CLOUD_DATABASE_URL', 'EDGE_DATABASE_URL'])
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env[name]).hostname));

const sha = (v) => createHash('sha256').update(v).digest('hex');
const code = (c) => (e) => e.code === c;

class UncertainQr {
  creates = 0;
  async checkSession() {
    return true;
  }
  async create() {
    this.creates++;
    return { kind: 'uncertain' };
  }
  async status() {
    return { kind: 'uncertain' };
  }
}

async function fixture(run) {
  await withSyncDatabases(async (f) => {
    const pool = f.cloud.pool,
      payment = randomUUID(),
      kiosk = randomUUID(),
      deviceKey = randomBytes(32).toString('hex');
    const auth = authFor(await provisionDevice(pool, f.device));
    await pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [f.branch, f.org, f.device, randomUUID()],
    );
    await pool.query(
      "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}')",
      [f.branch, f.device],
    );
    await pool.query(
      "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1::uuid,$2,$3,'payment','kaspi-qr',$1::text,true,$4)",
      [payment, f.org, f.branch, f.legal],
    );
    await pool.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [kiosk, f.org, f.branch, sha(deviceKey)],
    );
    const sessions = new KioskSessions(pool, { piiKey: randomBytes(32) });
    const guestToken = randomBytes(32).toString('hex');
    await sessions.start(kiosk, deviceKey, { sessionId: randomUUID(), token: guestToken });
    const who = await sessions.authenticate(kiosk, deviceKey, guestToken);
    const publication = await publishCatalog({
      pool,
      scope: { organizationId: f.org, branchId: f.branch },
    });
    const menu = projectCatalogMenu(publication.payload, f.branch, 1, new Date().toISOString());
    await publishMenu(pool, menu);
    await pool.query(
      'INSERT INTO catalog_menu_deliveries(branch_id,catalog_version,release_id,device_id) VALUES($1,1,$2,$3)',
      [f.branch, menu.release_id, f.device],
    );
    const pulled = (await pullMenu(pool, auth)).event;
    await acknowledgeMenu(pool, auth, await applyMenu(f.edge.pool, f.branch, pulled));
    const checkout = new KioskCheckout(
      pool,
      {
        organizationId: f.org,
        branchId: f.branch,
        paymentAccountId: payment,
        paymentMethod: 'kaspi_qr',
        fiscalPolicy: 'deferred_pilot',
        approvalReference: 'Synthetic kiosk test only',
        taxCode: 'PENDING_PILOT',
        maxOrderMinor: '50000',
        hours: { openingTime: '10:00', closingTime: '00:00', timeZone: 'Asia/Almaty' },
      },
      sessions,
      () => new Date('2026-10-04T10:00:00Z'),
    );
    const quote = await checkout.quote(who, {
      key: randomUUID(),
      branchId: f.branch,
      catalog_version: 1,
      serviceMode: 'takeaway',
      items: [
        {
          productId: 'BURGER',
          quantity: 1,
          selections: [{ group_id: 'extra', option_id: 'sauce', quantity: 1 }],
        },
      ],
    });
    const order = await checkout.create(who, { key: randomUUID(), quoteId: quote.quoteId });
    const row = (
      await pool.query('SELECT quote_id,quote_digest FROM commerce_orders WHERE id=$1', [
        order.orderId,
      ])
    ).rows[0];
    const reservation = randomUUID();
    await checkout.repository.confirmAdmission(
      { organizationId: f.org, branchId: f.branch, deviceId: f.device },
      {
        eventId: randomUUID(),
        orderId: order.orderId,
        reservationId: reservation,
        quoteDigest: row.quote_digest,
      },
    );
    await pool.query(
      `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,quote_id,quote_hash,owner_hash,version,state,display_number,routing_version,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$7,1,'held','20',1,'{}')`,
      [order.orderId, f.branch, f.org, f.device, reservation, row.quote_id, row.quote_digest],
    );
    await checkout.pay(who, order.orderId, { method: 'kaspi_qr' });
    // Reproduces 8 Oct: one create with a lost answer leaves unknown without bank identity.
    const client = new UncertainQr();
    const processor = new KioskKaspiQrProcessor(
      pool,
      {
        accountId: payment,
        bridgeUrl: 'http://127.0.0.1:1',
        requestTimeoutMs: 1000,
        invoiceTtlSeconds: 180,
        webhookSecret: 'x'.repeat(32),
        session: null,
        latitude: 43,
        longitude: 76,
      },
      client,
    );
    await processor.tick();
    const age = async (minutes) => {
      // Test-only clock shift: the QR guard forbids moving issue time in production.
      await pool.query(
        'ALTER TABLE commerce_kiosk_kaspi_qr DISABLE TRIGGER commerce_kiosk_qr_guard',
      );
      await pool.query(
        `UPDATE commerce_kiosk_kaspi_qr q SET issue_started_at=t.v,expires_at=t.v+interval '180 seconds'
         FROM (SELECT clock_timestamp()-make_interval(mins=>$1) v) t WHERE q.order_id=$2`,
        [minutes, order.orderId],
      );
      await pool.query(
        'ALTER TABLE commerce_kiosk_kaspi_qr ENABLE TRIGGER commerce_kiosk_qr_guard',
      );
    };
    async function manager(role) {
      const id = randomUUID(),
        token = randomBytes(32).toString('hex');
      await pool.query(
        'INSERT INTO catalog_managers(id,organization_id,name,token_hash) VALUES($1,$2,$3,$4)',
        [id, f.org, 'Synthetic ' + role, sha(token)],
      );
      await pool.query(
        'INSERT INTO catalog_manager_branches(actor_id,organization_id,branch_id) VALUES($1,$2,$3)',
        [id, f.org, f.branch],
      );
      await pool.query('INSERT INTO bo_access_grants(actor_id,branch_id,role) VALUES($1,$2,$3)', [
        id,
        f.branch,
        role,
      ]);
      return { id, token };
    }
    const attempt = (
      await pool.query('SELECT id FROM commerce_payment_attempts WHERE order_id=$1', [
        order.orderId,
      ])
    ).rows[0].id;
    const accept = (extra = {}) => ({
      request_id: randomUUID(),
      order_id: order.orderId,
      attempt_id: attempt,
      reason: 'bank_identity_lost',
      note: 'Банковский ID потерян 8 октября, гость ушёл; сверка у менеджера',
      confirm: 'payment_result_remains_unknown',
      ...extra,
    });
    const money = async () =>
      (
        await pool.query(
          `SELECT json_build_object(
            'order',(SELECT row_to_json(o) FROM (SELECT state,total_minor,attention_required FROM commerce_orders WHERE id=$1) o),
            'attempts',(SELECT json_agg(json_build_object('id',id,'state',state) ORDER BY id) FROM commerce_payment_attempts WHERE order_id=$1),
            'qr',(SELECT json_agg(json_build_object('state',state,'op',operation_id,'payload',qr_payload,'expires',expires_at)) FROM commerce_kiosk_kaspi_qr WHERE order_id=$1),
            'captures',(SELECT count(*) FROM commerce_captures WHERE order_id=$1)) v`,
          [order.orderId],
        )
      ).rows[0].v;
    await run({
      ...f,
      pool,
      payment,
      sessions,
      who,
      checkout,
      order,
      attempt,
      client,
      processor,
      age,
      manager,
      accept,
      money,
      incidents: new KioskPaymentIncidents(pool, true),
    });
  });
}

test('stuck unknown QR blocks the kiosk until a manager accepts it, without changing money state', () =>
  fixture(async (f) => {
    assert.equal(f.client.creates, 1);
    assert.equal((await f.checkout.read(f.who, f.order.orderId)).phase, 'checking');
    await assert.rejects(f.sessions.end(f.who.sessionId), code('CONFLICT'));
    const { token } = await f.manager('manager');
    // A fresh attempt may still resolve: it is neither listed nor accepted.
    assert.deepEqual((await f.incidents.list(token, f.branch)).candidates, []);
    await assert.rejects(f.incidents.accept(token, f.branch, f.accept()), code('CONFLICT'));
    await f.age(20);
    const listed = await f.incidents.list(token, f.branch);
    assert.equal(listed.candidates.length, 1);
    assert.equal(listed.candidates[0].order_id, f.order.orderId);
    assert.equal(listed.candidates[0].has_operation_id, false);
    assert.equal('session_id' in listed.candidates[0], false);
    const before = await f.money();
    const request = f.accept();
    const result = await f.incidents.accept(token, f.branch, request);
    assert.equal(result.kiosk, 'session_end_allowed');
    assert.equal(result.attempt_state, 'unknown');
    assert.deepEqual(await f.incidents.accept(token, f.branch, request), result);
    await assert.rejects(
      f.incidents.accept(token, f.branch, { ...request, note: 'другая причина' }),
      code('CONFLICT'),
    );
    await assert.rejects(f.incidents.accept(token, f.branch, f.accept()), code('CONFLICT'));
    // Nothing about the payment or the order changed; only the device presentation did.
    assert.deepEqual(await f.money(), before);
    const shown = await f.checkout.read(f.who, f.order.orderId);
    assert.equal(shown.phase, 'failed');
    assert.equal(shown.payment.state, 'checking');
    assert.equal(shown.payment.qrPayload, null);
    await f.sessions.end(f.who.sessionId);
    const audit = (
      await f.pool.query(
        "SELECT reason,before_value,after_value FROM bo_audit WHERE action='kiosk_payment_incident' AND entity_id=$1",
        [f.order.orderId],
      )
    ).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].before_value.attempt_state, 'unknown');
    assert.equal((await f.incidents.list(token, f.branch)).accepted.length, 1);
    // The QR row stays due for reconciliation; the worker never re-creates.
    await f.pool.query(
      "UPDATE commerce_kiosk_kaspi_qr SET next_check_at=clock_timestamp()-interval '1 second'",
    );
    await f.processor.tick();
    assert.equal(f.client.creates, 1);
    assert.deepEqual(await f.money(), before);
  }));

test('only an active branch manager may accept; analysts, strangers and disabled service refuse', () =>
  fixture(async (f) => {
    await f.age(20);
    const analyst = await f.manager('analyst');
    await assert.rejects(
      f.incidents.accept(analyst.token, f.branch, f.accept()),
      code('FORBIDDEN'),
    );
    assert.equal((await f.incidents.list(analyst.token, f.branch)).candidates.length, 1);
    await assert.rejects(
      f.incidents.accept(randomBytes(32).toString('hex'), f.branch, f.accept()),
      code('UNAUTHORIZED'),
    );
    const { token } = await f.manager('manager');
    await assert.rejects(
      new KioskPaymentIncidents(f.pool, false).accept(token, f.branch, f.accept()),
      code('SERVICE_UNAVAILABLE'),
    );
    await assert.rejects(f.incidents.accept(token, randomUUID(), f.accept()), code('FORBIDDEN'));
    for (const bad of [
      { confirm: 'paid' },
      { reason: 'customer_left' },
      { note: 'x' },
      { order_id: 'not-a-uuid' },
      { extra: true },
    ])
      await assert.rejects(
        f.incidents.accept(token, f.branch, f.accept(bad)),
        code('INVALID_REQUEST'),
      );
    await assert.rejects(
      f.incidents.accept(token, f.branch, f.accept({ attempt_id: randomUUID() })),
      code('CONFLICT'),
    );
    await assert.rejects(f.sessions.end(f.who.sessionId), code('CONFLICT'));
  }));

test('database guard and immutability hold even for direct SQL', () =>
  fixture(async (f) => {
    const { id } = await f.manager('manager');
    const insert = () =>
      f.pool.query(
        `INSERT INTO commerce_kiosk_payment_incidents(attempt_id,order_id,account_id,organization_id,branch_id,session_id,accepted_by,request_id,reason,note,observed)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'bank_identity_lost','direct insert','{}')`,
        [f.attempt, f.order.orderId, f.payment, f.org, f.branch, f.who.sessionId, id, randomUUID()],
      );
    await assert.rejects(insert(), (e) => e.code === '23514');
    await f.age(20);
    await insert();
    await assert.rejects(
      f.pool.query("UPDATE commerce_kiosk_payment_incidents SET note='changed'"),
    );
    await assert.rejects(f.pool.query('DELETE FROM commerce_kiosk_payment_incidents'));
    await f.sessions.end(f.who.sessionId);
  }));

test('a late bank capture still settles the original order and the incident no longer masks it', () =>
  fixture(async (f) => {
    await f.age(20);
    const { token } = await f.manager('manager');
    await f.incidents.accept(token, f.branch, f.accept());
    const order = (
      await f.pool.query(
        'SELECT organization_id,branch_id,total_minor::text FROM commerce_orders WHERE id=$1',
        [f.order.orderId],
      )
    ).rows[0];
    await f.checkout.repository.observePayment(
      { organizationId: order.organization_id, branchId: order.branch_id, accountId: f.payment },
      {
        eventId: 'late-' + randomUUID(),
        attemptId: f.attempt,
        outcome: 'captured',
        operationId: '9876543210',
        amountMinor: order.total_minor,
        occurredAt: new Date().toISOString(),
      },
    );
    const captures = (
      await f.pool.query('SELECT order_id,amount_minor::text FROM commerce_captures')
    ).rows;
    assert.deepEqual(captures, [{ order_id: f.order.orderId, amount_minor: order.total_minor }]);
    assert.notEqual((await f.checkout.read(f.who, f.order.orderId)).phase, 'failed');
  }));

test('runtime grant helper is the exact privilege the API needs', () =>
  fixture(async (f) => {
    const role = 'incident_api_' + randomUUID().replaceAll('-', '');
    await f.pool.query(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await f.pool.query(kioskIncidentGrants(role, true));
      const rows = (
        await f.pool.query(
          "SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee=$1 AND table_name='commerce_kiosk_payment_incidents' ORDER BY 1",
          [role],
        )
      ).rows.map((r) => r.privilege_type);
      assert.deepEqual(rows, ['INSERT', 'SELECT']);
      await f.pool.query(kioskIncidentGrants(role, false));
    } finally {
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.pool.query(`DROP ROLE ${role}`);
    }
  }));
