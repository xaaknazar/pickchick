import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, generateKeyPairSync } from 'node:crypto';
import {
  CustomerNotifications,
  NotificationError,
  notificationTemplates,
  classifyPushResult,
  apnsPayload,
  pushOptions,
} from '../../packages/customer-notifications/dist/index.js';
import {
  PushDeviceSchema,
  NotificationPreferencePatchSchema,
} from '../../packages/contracts/dist/index.js';
import { CommerceRepository, digest } from '../../packages/commerce-core/dist/index.js';
import { withSyncDatabases } from '../helpers/sync.mjs';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const local =
  process.env.NOTIFICATIONS_TEST_DATABASES === '1' ||
  Boolean(process.env.CLOUD_DATABASE_URL && process.env.EDGE_DATABASE_URL);
const apns = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
test('disabled config is credential-free and cannot register a device', async () => {
  assert.deepEqual(pushOptions({}), { enabled: false });
  const notifications = new CustomerNotifications({}, { enabled: false });
  assert.deepEqual(notifications.config(), {
    enabled: false,
    providers: [],
    consentVersion: 'notifications-v1',
  });
  await assert.rejects(
    notifications.register('a'.repeat(64), {
      installationId: randomUUID(),
      provider: 'apns',
      environment: 'production',
      bundleId: 'kz.pickchick.app',
      token: 'c'.repeat(64),
    }),
    (e) => e instanceof NotificationError && e.code === 'SERVICE_UNAVAILABLE',
  );
});
test('push contracts reject missing consent, invalid native tokens and arbitrary bundle IDs', () => {
  assert.equal(NotificationPreferencePatchSchema.safeParse({ promotions: true }).success, false);
  assert.equal(
    NotificationPreferencePatchSchema.safeParse({
      promotions: true,
      consentVersion: 'notifications-v1',
    }).success,
    true,
  );
  assert.equal(NotificationPreferencePatchSchema.safeParse({ locale: 'en' }).success, true);
  for (const body of [{ token: 'invalid' }, { bundleId: 'attacker.app' }, { provider: 'expo' }])
    assert.equal(
      PushDeviceSchema.safeParse({
        installationId: randomUUID(),
        provider: 'apns',
        environment: 'production',
        token: 'a'.repeat(64),
        bundleId: 'kz.pickchick.app',
        ...body,
      }).success,
      false,
    );
});
test('provider outcomes preserve uncertainty, invalidation and bounded retry classes', () => {
  assert.equal(classifyPushResult('apns', 200).state, 'accepted');
  assert.equal(classifyPushResult('apns', 410).state, 'invalid');
  assert.equal(classifyPushResult('apns', 400, 'DeviceTokenNotForTopic').state, 'invalid');
  assert.equal(classifyPushResult('fcm', 404, 'UNREGISTERED').state, 'invalid');
  for (const p of ['apns', 'fcm']) {
    assert.equal(classifyPushResult(p, 429).state, 'retry');
    assert.equal(classifyPushResult(p, 503).state, 'retry');
    assert.equal(classifyPushResult(p, 403).state, 'failed');
  }
});
test('all push events use three languages and payloads carry no phone, amount or order contents', () => {
  for (const text of Object.values(notificationTemplates))
    for (const lang of ['ru', 'kk', 'en']) {
      assert.ok(text[lang].title);
      assert.ok(text[lang].body);
    }
  const payload = apnsPayload({
    ...notificationTemplates.ready.kk,
    notificationId: randomUUID(),
    orderId: randomUUID(),
  });
  assert.deepEqual(Object.keys(payload).sort(), ['aps', 'notificationId', 'orderId', 'type']);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 4096);
});
async function fixture(run) {
  for (const key of ['CLOUD_DATABASE_URL', 'EDGE_DATABASE_URL'])
    assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env[key]).hostname));
  await withSyncDatabases(async ({ cloud, org, legal, branch, menu }) => {
    const pool = cloud.pool,
      notifications = new CustomerNotifications(pool, {
        enabled: true,
        encryptionKey: randomBytes(32),
        apns: { key: apns, keyId: 'TESTKEY123', teamId: 'TESTTEAM12' },
      });
    async function identity() {
      const id = randomUUID(),
        session = randomUUID(),
        token = randomBytes(32).toString('hex');
      await pool.query(
        "INSERT INTO identity_customers(id,phone_lookup,phone_cipher,profile_cipher,created_at) VALUES($1,$2,'synthetic','synthetic',clock_timestamp())",
        [id, sha(id)],
      );
      await pool.query(
        "INSERT INTO identity_sessions(id,customer_id,device_hash,access_hash,access_expires_at,refresh_hash,created_at,refreshed_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour',$5,clock_timestamp(),clock_timestamp())",
        [session, id, sha(session), sha(token), sha('refresh' + token)],
      );
      return { id, session, token };
    }
    const customer = await identity(),
      other = await identity();
    const release = menu(),
      fiscal = randomUUID();
    await pool.query(
      'INSERT INTO menu_releases(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,1,1,$3,$4,clock_timestamp())',
      [release.release_id, branch, release, digest(release)],
    );
    await pool.query(
      "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,legal_entity_id,kind,provider,external_reference,enabled) VALUES($1,$2,$3,$4,'fiscal','synthetic-test',$5,true)",
      [fiscal, org, branch, legal, fiscal],
    );
    async function order() {
      const repo = new CommerceRepository(pool),
        scope = { organizationId: org, branchId: branch, principalId: customer.id, role: 'sales' };
      const q = await repo.issueQuote(scope, randomUUID(), {
        releaseId: release.release_id,
        customerId: customer.id,
        channel: 'mobile',
        serviceMode: 'takeaway',
        currency: 'KZT',
        ttlSeconds: 300,
        lines: [
          {
            lineId: randomUUID(),
            productId: 'test',
            title: 'Synthetic',
            quantity: 1,
            unitPriceMinor: '100',
            discountMinor: '0',
            taxCode: 'TEST',
          },
        ],
      });
      return (
        await repo.createOrder(scope, randomUUID(), { quoteId: q.quoteId, fiscalAccountId: fiscal })
      ).orderId;
    }
    await run({ pool, notifications, customer, other, order });
  });
}
test(
  'PostgreSQL consent, ownership, token rotation, revocation, retries and deduplicated inbox',
  { skip: !local },
  async () =>
    fixture(async ({ pool, notifications: n, customer: a, other: b, order }) => {
      assert.deepEqual(await n.preferences(a.token), {
        locale: 'ru',
        orders: false,
        promotions: false,
      });
      await assert.rejects(
        n.updatePreferences(a.token, { promotions: true }),
        (e) => e.code === 'INVALID_REQUEST',
      );
      await n.updatePreferences(a.token, { orders: true, locale: 'kk' });
      const device = {
        installationId: randomUUID(),
        provider: 'apns',
        environment: 'production',
        token: 'd'.repeat(64),
        bundleId: 'kz.pickchick.app',
      };
      await n.register(a.token, device);
      await n.register(a.token, device);
      assert.equal((await pool.query('SELECT * FROM customer_push_devices')).rows.length, 1);
      const stored = (await pool.query('SELECT token_cipher FROM customer_push_devices')).rows[0]
        .token_cipher;
      assert.ok(!stored.includes(device.token));
      const id = await order();
      await Promise.all([n.observe(a.id, id, 'paid'), n.observe(a.id, id, 'paid')]);
      const inbox = await n.inbox(a.token);
      assert.equal(inbox.items.length, 1);
      assert.equal(inbox.items[0].title, 'Төлем расталды');
      assert.equal((await n.inbox(b.token)).items.length, 0);
      await assert.rejects(n.read(b.token, inbox.items[0].id), (e) => e.code === 'NOT_FOUND');
      await n.read(a.token, inbox.items[0].id);
      assert.ok((await n.inbox(a.token)).items[0].readAt);
      let sends = 0;
      await Promise.all([
        n.deliver(async () => {
          sends++;
          return { state: 'retry', code: 'timeout' };
        }),
        n.deliver(async () => {
          sends++;
          return { state: 'retry', code: 'timeout' };
        }),
      ]);
      assert.equal(sends, 1);
      assert.equal(
        (await pool.query('SELECT state FROM customer_push_deliveries')).rows[0].state,
        'pending',
      );
      await pool.query(
        "UPDATE customer_push_deliveries SET available_at=clock_timestamp()-interval '1 second'",
      );
      await n.updatePreferences(a.token, { locale: 'en' });
      await n.register(a.token, { ...device, token: 'e'.repeat(64) });
      await n.deliver(async (target, message) => {
        assert.equal(target.token, 'e'.repeat(64));
        assert.equal(message.title, 'Payment confirmed');
        return { state: 'accepted', code: 'accepted' };
      });
      await n.observe(a.id, id, 'preparing');
      await n.updatePreferences(a.token, { orders: false });
      let forbidden = 0;
      await n.deliver(async () => {
        forbidden++;
        return { state: 'accepted', code: 'accepted' };
      });
      assert.equal(forbidden, 0);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM customer_push_deliveries WHERE state IN ('pending','sending')",
          )
        ).rows[0].count,
        '0',
      );
      await n.updatePreferences(a.token, { orders: true });
      const second = await order();
      await n.observe(a.id, second, 'ready');
      await pool.query(
        'UPDATE identity_sessions SET revoked_at=clock_timestamp(),access_hash=NULL,refresh_hash=NULL WHERE id=$1',
        [a.session],
      );
      await n.deliver(async () => {
        forbidden++;
        return { state: 'accepted', code: 'accepted' };
      });
      assert.equal(forbidden, 0);
      assert.equal(
        (await pool.query('SELECT token_cipher FROM customer_push_devices')).rows[0].token_cipher,
        null,
      );
      await assert.rejects(n.inbox(a.token), (e) => e.code === 'UNAUTHORIZED');
    }),
);
