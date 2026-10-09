import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '@pickchick/api';
import { createPool } from '@pickchick/database';
import { RESOURCE } from '@pickchick/platform';
import { projectCatalogMenu, provisionDevice, publishMenu } from '@pickchick/menu-sync';
import { KioskSessions } from '../../packages/commerce-core/dist/index.js';
import { publishCatalog } from '../../packages/commerce-core/tests/catalog-fixture.mjs';
import { headersFor, running, withSyncDatabases } from '../helpers/sync.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

async function until(predicate, message, ms = 5000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) assert.fail(message);
    await delay(10);
  }
}

/** Opening hours around the current Almaty time, so a quote never meets a closed restaurant. */
function openHours() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Almaty',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const now =
    Number(parts.find((p) => p.type === 'hour').value) * 60 +
    Number(parts.find((p) => p.type === 'minute').value);
  const at = (minutes) => {
    const value = (((minutes % 1440) + 1440) % 1440) | 0;
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  };
  return { opening: at(now - 60), closing: at(now + 180) };
}

/**
 * The real API with synthetic mobile and kiosk storefronts, a kiosk guest and a provisioned
 * cashier edge device. `start(overrides)` boots one API process with admission overrides.
 */
async function fixture(run) {
  await withSyncDatabases(async (ctx) => {
    const pool = ctx.cloud.pool,
      kiosk = randomUUID(),
      deviceKey = randomBytes(32).toString('hex'),
      piiKey = randomBytes(32),
      payment = randomUUID(),
      hours = openHours();
    const edge = await provisionDevice(pool, ctx.device);
    await pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [ctx.branch, ctx.org, ctx.device, randomUUID()],
    );
    await pool.query(
      "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}')",
      [ctx.branch, ctx.device],
    );
    await pool.query(
      "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1::uuid,$2,$3,'payment','kaspi-remote',$1::text,true,$4)",
      [payment, ctx.org, ctx.branch, ctx.legal],
    );
    await pool.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [kiosk, ctx.org, ctx.branch, sha(deviceKey)],
    );
    const token = randomBytes(32).toString('hex');
    await new KioskSessions(pool, { piiKey }).start(kiosk, deviceKey, {
      sessionId: randomUUID(),
      token,
    });
    const publication = await publishCatalog({
      pool,
      scope: { organizationId: ctx.org, branchId: ctx.branch },
    });
    // A pending menu delivery gives the edge pull a real event to return.
    await publishMenu(
      pool,
      projectCatalogMenu(publication.payload, ctx.branch, 1, new Date().toISOString()),
    );
    const env = {
      CUSTOMER_KASPI_PILOT_ENABLED: 'true',
      CUSTOMER_KASPI_ORGANIZATION_ID: ctx.org,
      CUSTOMER_KASPI_BRANCH_ID: ctx.branch,
      KASPI_REMOTE_ACCOUNT_ID: payment,
      CUSTOMER_KASPI_PILOT_CUSTOMER_IDS: randomUUID(),
      CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE: 'Synthetic admission test only',
      CUSTOMER_KASPI_OPENING_TIME: hours.opening,
      CUSTOMER_KASPI_CLOSING_TIME: hours.closing,
      CUSTOMER_KASPI_TIMEZONE: 'Asia/Almaty',
      CATALOG_MOBILE_STOREFRONT_ENABLED: 'true',
      KIOSK_CHECKOUT_ENABLED: 'true',
      KIOSK_CHECKOUT_ORGANIZATION_ID: ctx.org,
      KIOSK_CHECKOUT_BRANCH_ID: ctx.branch,
      KIOSK_CHECKOUT_FISCAL_POLICY: 'deferred_pilot',
      KIOSK_CHECKOUT_APPROVAL_REFERENCE: 'Synthetic admission test only',
      KIOSK_CHECKOUT_TAX_CODE: 'PENDING_PILOT',
      KIOSK_CHECKOUT_MAX_MINOR: '50000',
      KIOSK_CHECKOUT_PII_KEY: piiKey.toString('hex'),
    };
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    const apps = [];
    try {
      Object.assign(process.env, env);
      const start = async (overrides) => {
        const api = await running(createApi, { ...ctx.cloud.config, ...overrides });
        apps.push(api.app);
        return { ...api, admission: api.app.get(RESOURCE).admission };
      };
      const kioskHeaders = {
        'X-Kiosk-Device': kiosk,
        'X-Kiosk-Key': deviceKey,
        Authorization: 'Bearer ' + token,
      };
      const cart = () => ({
        key: randomUUID(),
        branchId: ctx.branch,
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
      await run({ ...ctx, pool, start, kioskHeaders, edgeHeaders: headersFor(edge), cart });
    } finally {
      for (const app of apps) await app.close();
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });
}

const signatureOf = async (url, headers = {}) => {
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  const signature = response.headers.get('x-availability-signature');
  assert.match(signature, /^[a-f0-9]{64}$/);
  return signature;
};

test('40 open long-polls hold no ordinary slot: a kiosk quote and the cashier edge pull still pass', () =>
  fixture(async (ctx) => {
    // Before the split all 40 waits shared HTTP_MAX_IN_FLIGHT: with 4 slots, 36 of them and
    // every later quote or edge request were answered 503.
    const api = await ctx.start({ httpMaxInFlight: 4, databasePoolMax: 4 });
    const mobile = await signatureOf(api.url + '/v1/customer-checkout/availability');
    const kiosk = await signatureOf(api.url + '/v1/kiosk-checkout/availability', ctx.kioskHeaders);
    const abort = new AbortController();
    const polls = [
      ...Array.from({ length: 34 }, () =>
        fetch(`${api.url}/v1/customer-checkout/availability?after=${mobile}`, {
          signal: abort.signal,
        }).catch(() => null),
      ),
      ...Array.from({ length: 6 }, () =>
        fetch(`${api.url}/v1/kiosk-checkout/availability?after=${kiosk}`, {
          headers: ctx.kioskHeaders,
          signal: abort.signal,
        }).catch(() => null),
      ),
    ];
    try {
      await until(() => api.admission.longPolls === 40, 'all 40 long-polls are waiting');
      assert.equal(api.admission.active, 0, 'waiting long-polls occupy no ordinary slot');
      assert.equal(api.admission.paced, 0);
      const quote = await fetch(api.url + '/v1/kiosk-checkout/quotes', {
        method: 'POST',
        headers: { ...ctx.kioskHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(ctx.cart()),
      });
      const quoted = await quote.json();
      assert.equal(quote.status, 200, JSON.stringify(quoted));
      assert.equal(quoted.totalMinor, '11000');
      const pull = await fetch(api.url + '/internal/v1/edge/sync/pull', {
        headers: ctx.edgeHeaders,
      });
      assert.equal(pull.status, 200);
      assert.equal((await pull.json()).event.event_type, 'menu.published');
      assert.equal((await fetch(api.url + '/v1/branches')).status, 200);
      const metrics = await (await fetch(api.url + '/health/metrics')).text();
      assert.match(metrics, /pickchick_http_long_poll_in_flight 40\n/);
      assert.match(metrics, /pickchick_http_long_poll_limit 64\n/);
      assert.match(metrics, /pickchick_http_edge_limit 16\n/);
      assert.match(metrics, /pickchick_http_rejected_total 0\n/);
      assert.equal(api.admission.longPolls, 40, 'the waits were not disturbed');
    } finally {
      abort.abort();
      await Promise.all(polls);
    }
    await until(() => api.admission.longPolls === 0, 'aborted long-polls release their budget');
    assert.equal(api.admission.active, 0);
  }));

test('saturated public capacity never blocks the device-authenticated edge transport', () =>
  fixture(async (ctx) => {
    const api = await ctx.start({ httpMaxInFlight: 1, databasePoolMax: 3 });
    const blocker = createPool(ctx.cloud.config.databaseUrl, 1);
    const lock = await blocker.connect();
    let held;
    try {
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE branches IN ACCESS EXCLUSIVE MODE');
      held = fetch(api.url + '/v1/branches');
      await until(() => api.admission.active === 1, 'the public read holds the only slot');
      const publicRequest = await fetch(api.url + '/v1/capabilities');
      assert.equal(publicRequest.status, 503);
      assert.equal(publicRequest.headers.get('retry-after'), '1');
      for (let attempt = 0; attempt < 3; attempt++) {
        const pull = await fetch(api.url + '/internal/v1/edge/sync/pull', {
          headers: ctx.edgeHeaders,
        });
        assert.equal(pull.status, 200);
        assert.equal((await pull.json()).event.event_type, 'menu.published');
      }
      // An unauthenticated caller gets an answer from the edge budget, not ordinary capacity.
      assert.equal((await fetch(api.url + '/internal/v1/edge/sync/pull')).status, 401);
      assert.deepEqual([api.admission.edge, api.admission.edgeBorrowed], [0, 0]);
      assert.equal(api.admission.active, 1);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
      await blocker.end();
    }
    assert.equal((await held).status, 200);
    await until(() => api.admission.active === 0, 'the public read completes');
  }));

test('long-poll overflow answers the current state after a pause; per-IP cap uses trusted hops only', () =>
  fixture(async (ctx) => {
    const api = await ctx.start({
      httpMaxLongPoll: 2,
      httpMaxLongPollPerIp: 2,
      httpLongPollOverflowDelayMs: 400,
      trustedProxyIps: ['127.0.0.1'],
    });
    const mobile = await signatureOf(api.url + '/v1/customer-checkout/availability');
    const kiosk = await signatureOf(api.url + '/v1/kiosk-checkout/availability', ctx.kioskHeaders);
    const abort = new AbortController();
    const poll = (ip, headers = {}, path = `/v1/customer-checkout/availability?after=${mobile}`) =>
      fetch(api.url + path, {
        headers: { 'X-Forwarded-For': ip, ...headers },
        signal: abort.signal,
      });
    const waiting = [poll('203.0.113.7'), poll('203.0.113.7')].map((p) => p.catch(() => null));
    try {
      await until(() => api.admission.longPolls === 2, 'two long-polls wait');
      const started = Date.now();
      // The pool is full: a mobile and a kiosk poll of other clients get paced answers.
      const paced = [
        poll('198.51.100.20'),
        poll('198.51.100.21', ctx.kioskHeaders, `/v1/kiosk-checkout/availability?after=${kiosk}`),
      ];
      await until(() => api.admission.paced === 2, 'two overflow requests are paced');
      assert.equal(api.admission.active, 0, 'the pause holds no ordinary slot');
      // The overflow is bounded as well (as large as the pool); beyond it the answer is 503.
      const full = await poll('198.51.100.22');
      assert.equal(full.status, 503);
      assert.equal(full.headers.get('retry-after'), '1');
      const answers = await Promise.all(paced);
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 250 && elapsed < 3000, `paced answer after ${elapsed} ms`);
      for (const [index, answer] of answers.entries()) {
        assert.equal(answer.status, 200, 'overflow is not a 503');
        assert.equal(answer.headers.get('x-availability-signature'), index === 1 ? kiosk : mobile);
        assert.equal(answer.headers.get('x-catalog-version'), '1');
        assert.ok((await answer.json()).products.length > 0);
      }
      // A plain read (no `after`) stays an ordinary immediate request.
      const plainStarted = Date.now();
      assert.equal((await fetch(api.url + '/v1/customer-checkout/availability')).status, 200);
      assert.ok(Date.now() - plainStarted < 250);
      // 203.0.113.7 already waits twice: two more are paced, the next is refused at once.
      const more = [poll('203.0.113.7'), poll('203.0.113.7')];
      await until(() => api.admission.paced === 2, 'the client fills its paced share');
      const refused = await poll('203.0.113.7');
      assert.equal(refused.status, 429);
      assert.equal(refused.headers.get('retry-after'), '1');
      assert.equal((await refused.json()).code, 'RATE_LIMITED');
      for (const answer of await Promise.all(more)) assert.equal(answer.status, 200);
      // The cap covers long-polls only; the same client still reaches ordinary routes.
      const ordinary = await fetch(api.url + '/v1/branches', {
        headers: { 'X-Forwarded-For': '203.0.113.7' },
      });
      assert.equal(ordinary.status, 200);
      const metrics = await (await fetch(api.url + '/health/metrics')).text();
      assert.match(metrics, /pickchick_http_long_poll_paced_total 4\n/);
      assert.match(metrics, /pickchick_http_long_poll_client_rejected_total 1\n/);
      assert.match(metrics, /pickchick_http_long_poll_clients 1\n/);
    } finally {
      abort.abort();
      await Promise.all(waiting);
    }
    await until(
      () => api.admission.longPolls === 0 && api.admission.longPollClients === 0,
      'released waits forget their client',
    );

    // A peer that is not a configured proxy cannot pick its key with X-Forwarded-For.
    const direct = await ctx.start({
      httpMaxLongPoll: 10,
      httpMaxLongPollPerIp: 1,
      httpLongPollOverflowDelayMs: 300,
      trustedProxyIps: ['10.255.255.1'],
    });
    const forged = (ip) =>
      fetch(`${direct.url}/v1/customer-checkout/availability?after=${mobile}`, {
        headers: { 'X-Forwarded-For': ip },
      });
    const second = new AbortController();
    const first = fetch(`${direct.url}/v1/customer-checkout/availability?after=${mobile}`, {
      headers: { 'X-Forwarded-For': '192.0.2.1' },
      signal: second.signal,
    }).catch(() => null);
    try {
      await until(() => direct.admission.longPolls === 1, 'the first forged client waits');
      const rotated = forged('192.0.2.2');
      await until(() => direct.admission.paced === 1, 'a rotated header is the same client');
      assert.equal(direct.admission.longPolls, 1, 'room in the pool, but not for this client');
      assert.equal((await forged('192.0.2.3')).status, 429);
      assert.equal(direct.admission.longPollClients, 1);
      assert.equal((await rotated).status, 200);
    } finally {
      second.abort();
      await first;
    }
    await until(() => direct.admission.longPolls === 0, 'the forged wait is released');
  }));
