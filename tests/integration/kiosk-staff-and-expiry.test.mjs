// Release audit 19.10.2026 (kiosk lane), HTTP level against the real API on synthetic local
// databases: the kiosk staff code route (findings 3.3/3.4/3.0) and the definitive NOT_FOUND answer
// for a retried POST /orders of an expired guest (finding 3.0). No bank, kitchen or device.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createApi } from '@pickchick/api';
import {
  KioskSessions,
  createKioskStaffPinVerifier,
} from '../../packages/commerce-core/dist/index.js';
import { running, withSyncDatabases } from '../helpers/sync.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(run, extraEnv = {}) {
  await withSyncDatabases(async (ctx) => {
    const pool = ctx.cloud.pool,
      kiosk = randomUUID(),
      deviceKey = randomBytes(32).toString('hex'),
      piiKey = randomBytes(32);
    await pool.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [kiosk, ctx.org, ctx.branch, sha(deviceKey)],
    );
    const sessions = new KioskSessions(pool, { piiKey });
    const guest = async () => {
      const token = randomBytes(32).toString('hex'),
        sessionId = randomUUID();
      await sessions.start(kiosk, deviceKey, { sessionId, token });
      return { sessionId, token };
    };
    const env = {
      KIOSK_CHECKOUT_ENABLED: 'true',
      KASPI_REMOTE_ACCOUNT_ID: randomUUID(),
      CUSTOMER_KASPI_OPENING_TIME: '10:00',
      CUSTOMER_KASPI_CLOSING_TIME: '00:00',
      CUSTOMER_KASPI_TIMEZONE: 'Asia/Almaty',
      KIOSK_CHECKOUT_ORGANIZATION_ID: ctx.org,
      KIOSK_CHECKOUT_BRANCH_ID: ctx.branch,
      KIOSK_CHECKOUT_FISCAL_POLICY: 'deferred_pilot',
      KIOSK_CHECKOUT_APPROVAL_REFERENCE: 'Synthetic kiosk staff test only',
      KIOSK_CHECKOUT_TAX_CODE: 'PENDING_PILOT',
      KIOSK_CHECKOUT_PII_KEY: piiKey.toString('hex'),
      ...extraEnv,
    };
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    let api;
    try {
      Object.assign(process.env, env);
      api = await running(createApi, ctx.cloud.config);
      const post = async (path, body, headers = {}) => {
        const response = await fetch(api.url + '/v1/kiosk-checkout' + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
      };
      const device = { 'X-Kiosk-Device': kiosk, 'X-Kiosk-Key': deviceKey };
      await run({ ...ctx, pool, post, device, guest, sessions });
    } finally {
      if (api) await api.app.close();
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });
}

test('staff code route: device credentials, server-side code, per-device lock, nothing stored', async () => {
  const verifier = await createKioskStaffPinVerifier('482915');
  await fixture(
    async (ctx) => {
      assert.deepEqual(await ctx.post('/staff/verify', { pin: '482915' }, ctx.device), {
        status: 200,
        body: { valid: true },
      });
      const wrong = await ctx.post('/staff/verify', { pin: '111111' }, ctx.device);
      assert.deepEqual([wrong.status, wrong.body.code], [401, 'UNAUTHORIZED']);
      assert.equal((await ctx.post('/staff/verify', { pin: 'abc' }, ctx.device)).status, 400);
      // Another device key never reaches the code check.
      const stranger = await ctx.post(
        '/staff/verify',
        { pin: '482915' },
        { ...ctx.device, 'X-Kiosk-Key': randomBytes(32).toString('hex') },
      );
      assert.deepEqual([stranger.status, stranger.body.code], [403, 'FORBIDDEN']);
      for (let i = 0; i < 3; i++) await ctx.post('/staff/verify', { pin: '111111' }, ctx.device);
      assert.equal((await ctx.post('/staff/verify', { pin: '111111' }, ctx.device)).status, 429);
      assert.equal((await ctx.post('/staff/verify', { pin: '482915' }, ctx.device)).status, 429);
      // No guest session was allocated by any staff check.
      assert.equal(
        (await ctx.pool.query('SELECT count(*)::int n FROM kiosk_sessions')).rows[0].n,
        0,
      );
    },
    { KIOSK_STAFF_PIN_VERIFIER: verifier },
  );
});

test('without a configured code every staff action is unavailable', () =>
  fixture(async (ctx) => {
    const answer = await ctx.post('/staff/verify', { pin: '482915' }, ctx.device);
    assert.deepEqual([answer.status, answer.body.code], [503, 'NOT_READY']);
  }));

test('a retried POST /orders of an expired guest without an order is NOT_FOUND 404, not FORBIDDEN', () =>
  fixture(async (ctx) => {
    const expired = await ctx.guest();
    await ctx.pool.query(
      "UPDATE kiosk_sessions SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
      [expired.sessionId],
    );
    const body = { key: randomUUID(), quoteId: randomUUID() };
    const answer = await ctx.post('/orders', body, {
      ...ctx.device,
      Authorization: 'Bearer ' + expired.token,
    });
    // The public code every installed kiosk reads as "no order, pay again" (EXPIRED is not a
    // public error code: the HTTP filter would turn it into CONFLICT, which keeps recovery).
    assert.deepEqual([answer.status, answer.body.code], [404, 'NOT_FOUND']);
    // An ended guest is still refused as before.
    const ended = await ctx.guest();
    await ctx.sessions.end(ended.sessionId);
    const refused = await ctx.post('/orders', body, {
      ...ctx.device,
      Authorization: 'Bearer ' + ended.token,
    });
    assert.equal(refused.status, 403);
  }));
