import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { terminalCookies } from '../../apps/kitchen/terminal-cookie.mjs';
import { call, cookieOf, setup } from './cloud-fixture.mjs';

// Synthetic documentation addresses only (RFC 5737); no real clients.
const attacker = { 'X-PickChick-Client-IP': '203.0.113.66' };
const config = '/kitchen-live/prep/config.json';

async function exhaust(ctx, headers, path = config, times = 361) {
  let last;
  for (let i = 0; i < times; i++) last = await call(ctx.port, 'GET', path, headers);
  return last;
}

test('one anonymous client cannot freeze a paired cloud screen or other clients', async () => {
  const ctx = await setup();
  try {
    const raw = ctx.issueCode('prep');
    const paired = await call(
      ctx.port,
      'POST',
      '/kitchen-live/prep/cloud/pair',
      { 'X-PickChick-Client-IP': '198.51.100.7' },
      { code: raw },
    );
    assert.equal(paired.status, 200);
    const jar = cookieOf(paired.cookie);
    assert.equal((await exhaust(ctx, attacker)).status, 429);
    for (let i = 0; i < 12; i++)
      await call(ctx.port, 'POST', '/kitchen-live/prep/cloud/pair', attacker, {
        code: 'ZZZZ-ZZZZZZ',
      });
    const refused = await call(ctx.port, 'POST', '/kitchen-live/prep/cloud/pair', attacker, {
      code: 'ZZZZ-ZZZZZZ',
    });
    assert.equal(refused.status, 429);
    // The screen keeps polling even from the attacker's own address (shared NAT/proxy).
    const feed = `/kitchen-live/prep/cloud/v1/fulfillment/kitchen?stationId=${ctx.world.prep}&limit=100`;
    for (const headers of [{}, attacker, { 'X-PickChick-Client-IP': '198.51.100.7' }]) {
      const r = await call(ctx.port, 'GET', feed, { ...headers, Cookie: jar });
      assert.equal(r.status, 200);
    }
    // Another anonymous client has its own budget.
    const other = { 'X-PickChick-Client-IP': '198.51.100.8' };
    assert.equal((await call(ctx.port, 'GET', config, other)).status, 200);
    assert.equal(
      (
        await call(ctx.port, 'POST', '/kitchen-live/prep/cloud/pair', other, {
          code: ctx.issueCode('prep'),
        })
      ).status,
      200,
    );
  } finally {
    await ctx.close();
  }
});

test('a paired cashier-mode terminal has its own budget for reads and cook logins', async () => {
  const portalKey = 'b'.repeat(64);
  const ctx = await setup({ cloud: false, terminalAccess: true, portalKey });
  try {
    const credential = {
      terminalId: randomUUID(),
      branchId: ctx.world.branchId,
      mode: 'prep',
      generation: 1,
      terminalKey: 'c'.repeat(64),
    };
    const jar = cookieOf(
      terminalCookies({ key: portalKey, mode: 'prep', path: '/kitchen-live/prep/' }).seal(
        credential,
      ),
    );
    assert.equal((await exhaust(ctx, attacker)).status, 429);
    const login = '/kitchen-live/prep/edge/v1/staff/login';
    for (let i = 0; i < 13; i++)
      await call(ctx.port, 'POST', login, attacker, { login: 'x', password: 'y' });
    assert.equal(
      (await call(ctx.port, 'POST', login, attacker, { login: 'x', password: 'y' })).status,
      429,
    );
    const screen = { ...attacker, Cookie: jar };
    assert.equal((await call(ctx.port, 'GET', config, screen)).status, 200);
    const cook = await call(ctx.port, 'POST', login, screen, { login: 'x', password: 'y' });
    assert.notEqual(cook.status, 429);
    // A forged or foreign cookie is just an anonymous client.
    const forged = cookieOf(
      terminalCookies({ key: 'd'.repeat(64), mode: 'prep', path: '/kitchen-live/prep/' }).seal(
        credential,
      ),
    );
    assert.equal(
      (await call(ctx.port, 'GET', config, { ...attacker, Cookie: forged })).status,
      429,
    );
  } finally {
    await ctx.close();
  }
});

test('anonymous key table overflow never blocks paired screens', async () => {
  const ctx = await setup();
  try {
    const paired = await call(
      ctx.port,
      'POST',
      '/kitchen-live/prep/cloud/pair',
      {},
      { code: ctx.issueCode('prep') },
    );
    const jar = cookieOf(paired.cookie);
    let last;
    for (let i = 0; i < 2100; i++)
      last = await call(ctx.port, 'GET', '/kitchen-live/prep/cloud/session', {
        'X-PickChick-Client-IP': `10.${(i >> 8) & 255}.${i & 255}.1`,
      });
    assert.equal(last.status, 429);
    const session = await call(ctx.port, 'GET', '/kitchen-live/prep/cloud/session', {
      'X-PickChick-Client-IP': '10.200.0.1',
      Cookie: jar,
    });
    assert.equal(session.status, 200);
  } finally {
    await ctx.close();
  }
});

test('an invalid client address header cannot mint fresh budgets', async () => {
  const ctx = await setup({ cloud: false });
  try {
    let last;
    for (let i = 0; i < 361; i++)
      last = await call(ctx.port, 'GET', config, { 'X-PickChick-Client-IP': 'spoof-' + i });
    assert.equal(last.status, 429);
  } finally {
    await ctx.close();
  }
});

// QA 20.10 (release-fixes-1019), audit S18 (5.0): rotating addresses inside one IPv6 subscriber
// prefix, or switching between the IPv4 and IPv4-mapped forms, never mints fresh budgets.
test('QA S18: one IPv6 /64 or one IPv4 in two notations shares a single anonymous budget', async () => {
  const ctx = await setup({ cloud: false });
  try {
    let last;
    for (let i = 0; i < 361; i++)
      last = await call(ctx.port, 'GET', config, {
        'X-PickChick-Client-IP': `2001:db8:1:2:${(i % 65535).toString(16)}::${i % 7}`,
      });
    assert.equal(last.status, 429);
    // The same subscriber written in full or compressed form is the same client.
    assert.equal(
      (
        await call(ctx.port, 'GET', config, {
          'X-PickChick-Client-IP': '2001:0db8:0001:0002:ffff:0000:0000:0001',
        })
      ).status,
      429,
    );
    // Another /64 has its own budget.
    assert.equal(
      (await call(ctx.port, 'GET', config, { 'X-PickChick-Client-IP': '2001:db8:1:3::1' })).status,
      200,
    );
    for (let i = 0; i < 361; i++)
      last = await call(ctx.port, 'GET', config, {
        'X-PickChick-Client-IP': i % 2 ? '203.0.113.9' : '::ffff:203.0.113.9',
      });
    assert.equal(last.status, 429);
  } finally {
    await ctx.close();
  }
});
