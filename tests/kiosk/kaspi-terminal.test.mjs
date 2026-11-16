// ADR-0018: the kiosk's LAN client for its Kaspi Smart POS and the token renewal.
// Synthetic fetch and terminal doubles only: no terminal, bank or network is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kaspiEnvelope,
  kaspiExpiration,
  kaspiTerminalCall,
  privateIPv4,
} from '../../apps/kiosk/src/kaspi-terminal.ts';
import {
  TerminalSession,
  TOKEN_RENEW_BEFORE_MS,
  parseTerminalLink,
  terminalIntegrationName,
} from '../../apps/kiosk/src/kaspi-terminal-link.ts';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
/** A fetch double: `answers` maps a /v2 method to a Response factory or an Error to throw. */
function fakeFetch(answers) {
  const calls = [];
  const fetcher = async (url, init) => {
    const parsed = new URL(url);
    const method = parsed.pathname.replace('/v2/', '');
    calls.push({ url, method, query: Object.fromEntries(parsed.searchParams), init });
    const answer = answers[method];
    if (!answer) throw new TypeError('Network request failed');
    if (answer === 'hang')
      return new Promise((_, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    if (answer instanceof Error) throw answer;
    return answer();
  };
  return { fetcher, calls };
}
const deviceinfo = () => json(200, { statusCode: 0, data: { terminalId: 'T1', serialNum: 'S1' } });

test('only private IPv4 addresses are terminals', () => {
  for (const ok of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.50'])
    assert.equal(privateIPv4(ok), true, ok);
  for (const bad of [
    '8.8.8.8',
    '172.32.0.1',
    '192.169.1.1',
    '127.0.0.1',
    '192.168.001.5',
    '192.168.1.256',
    'localhost',
    'terminal.kaspipos.kz',
    '',
    null,
  ])
    assert.equal(privateIPv4(bad), false, String(bad));
});

test('a call is a GET to http://<ip>:8080/v2/<method> with the accesstoken header', async () => {
  const { fetcher, calls } = fakeFetch({
    status: () => json(200, { statusCode: 0, data: { status: 'wait' } }),
  });
  const answer = await kaspiTerminalCall(
    '192.168.1.50',
    'status',
    { processId: 'P-1' },
    { token: 'tok_1' },
    fetcher,
  );
  assert.deepEqual(answer, { kind: 'ok', data: { status: 'wait' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://192.168.1.50:8080/v2/status?processId=P-1');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.accesstoken, 'tok_1');
  await assert.rejects(kaspiTerminalCall('8.8.8.8', 'deviceinfo', {}, {}, fetcher), /HOST/);
  await assert.rejects(
    kaspiTerminalCall('192.168.1.50', 'status', { processId: 'a b' }, {}, fetcher),
    /PARAM/,
  );
  assert.equal(calls.length, 1, 'nothing is sent for an invalid call');
});

test('answers are classified ok / refused / lost like the edge client', () => {
  assert.equal(kaspiEnvelope(200, JSON.stringify({ statusCode: 0, data: { a: 1 } })).kind, 'ok');
  assert.deepEqual(kaspiEnvelope(400, JSON.stringify({ statusCode: 107, errorText: 'busy' })), {
    kind: 'refused',
    httpStatus: 400,
    statusCode: 107,
    message: 'busy',
  });
  // An error code in a 200 envelope is still a refusal.
  assert.equal(kaspiEnvelope(200, JSON.stringify({ statusCode: 999 })).kind, 'refused');
  assert.deepEqual(kaspiEnvelope(200, 'not json'), { kind: 'lost', reason: 'ANSWER' });
  assert.deepEqual(kaspiEnvelope(200, JSON.stringify({ statusCode: 0 })), {
    kind: 'lost',
    reason: 'ANSWER',
  });
  assert.deepEqual(kaspiEnvelope(401, ''), {
    kind: 'refused',
    httpStatus: 401,
    statusCode: null,
    message: null,
  });
});

test('a failed read is unreachable; a read that times out is unreachable too', async () => {
  const failed = fakeFetch({});
  assert.deepEqual(
    await kaspiTerminalCall('10.0.0.5', 'status', { processId: '1' }, {}, failed.fetcher),
    {
      kind: 'unreachable',
      reason: 'CONNECT',
    },
  );
  const hang = fakeFetch({ status: 'hang' });
  assert.deepEqual(
    await kaspiTerminalCall(
      '10.0.0.5',
      'status',
      { processId: '1' },
      { timeoutMs: 20 },
      hang.fetcher,
    ),
    { kind: 'unreachable', reason: 'TIMEOUT' },
  );
});

test('a payment is unreachable only when the pre-flight fails; once sent it is lost', async () => {
  const down = fakeFetch({});
  assert.deepEqual(
    await kaspiTerminalCall('10.0.0.5', 'payment', { amount: '4190' }, {}, down.fetcher),
    {
      kind: 'unreachable',
      reason: 'CONNECT',
    },
  );
  assert.deepEqual(
    down.calls.map((c) => c.method),
    ['deviceinfo'],
    'the payment itself was never sent',
  );
  const dropped = fakeFetch({ deviceinfo, payment: new TypeError('Network request failed') });
  assert.deepEqual(
    await kaspiTerminalCall(
      '10.0.0.5',
      'payment',
      { amount: '4190' },
      { token: 't' },
      dropped.fetcher,
    ),
    { kind: 'lost', reason: 'CONNECTION' },
  );
  const slow = fakeFetch({ deviceinfo, payment: 'hang' });
  assert.deepEqual(
    await kaspiTerminalCall(
      '10.0.0.5',
      'payment',
      { amount: '4190' },
      { timeoutMs: 20 },
      slow.fetcher,
    ),
    { kind: 'lost', reason: 'TIMEOUT' },
  );
  const busy = fakeFetch({ deviceinfo, payment: () => json(400, { statusCode: 107 }) });
  const refused = await kaspiTerminalCall('10.0.0.5', 'payment', { amount: '1' }, {}, busy.fetcher);
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.statusCode, 107);
});

test('expirationDate is the terminal local time (UTC+5)', () => {
  assert.equal(kaspiExpiration('2024-09-25 17:27:03'), Date.parse('2024-09-25T12:27:03Z'));
  assert.equal(kaspiExpiration('soon'), null);
});

test('the integration name is pickchick-kiosk-<6 characters>', () => {
  assert.match(
    terminalIntegrationName('3fa9c1d2-0000-4000-8000-000000000000'),
    /^pickchick-kiosk-3fa9c1$/,
  );
});

function link(over = {}) {
  return {
    host: '192.168.1.50',
    terminalId: 'T1',
    serial: 'S1',
    name: 'pickchick-kiosk-abc123',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.parse('2026-11-17T12:00:00Z'),
    linkedAt: 0,
    ...over,
  };
}
function sessionFixture(stored, answers, now = Date.parse('2026-11-16T12:00:00Z')) {
  const h = { raw: JSON.stringify(stored), calls: [], now };
  const port = async (host, method, params, options = {}) => {
    h.calls.push({ host, method, params, token: options.token ?? null });
    const next = answers[method];
    return typeof next === 'function' ? next(options.token) : next;
  };
  const store = {
    read: async () => h.raw,
    write: async (raw) => {
      h.raw = raw;
    },
    remove: async () => {
      h.raw = null;
    },
  };
  h.session = new TerminalSession(store, port, () => h.now);
  return h;
}
const revoked = {
  kind: 'ok',
  data: {
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expirationDate: '2026-11-17 18:00:00',
  },
};

test('a token with less than 2 h left is renewed by /v2/revoke before the call', async () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  const h = sessionFixture(link({ expiresAt: now + TOKEN_RENEW_BEFORE_MS - 1000 }), {
    revoke: revoked,
    status: { kind: 'ok', data: { status: 'wait' } },
  });
  await h.session.load();
  await h.session.call('status', { processId: 'P1' });
  assert.deepEqual(
    h.calls.map((c) => [c.method, c.token]),
    [
      ['revoke', 'old-access'],
      ['status', 'new-access'],
    ],
  );
  assert.deepEqual(h.calls[0].params, {
    name: 'pickchick-kiosk-abc123',
    refreshToken: 'old-refresh',
  });
  const saved = parseTerminalLink(h.raw);
  assert.equal(saved.accessToken, 'new-access');
  assert.equal(saved.refreshToken, 'new-refresh');
  assert.equal(saved.expiresAt, Date.parse('2026-11-17T13:00:00Z'));
});

test('a fresh token is not renewed; a failed renewal keeps the old one and waits a minute', async () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  const fresh = sessionFixture(link(), { status: { kind: 'ok', data: {} } });
  await fresh.session.load();
  await fresh.session.call('status', { processId: 'P1' });
  assert.deepEqual(
    fresh.calls.map((c) => c.method),
    ['status'],
  );
  const h = sessionFixture(link({ expiresAt: now + 60000 }), {
    revoke: { kind: 'unreachable', reason: 'CONNECT' },
    status: { kind: 'ok', data: {} },
  });
  await h.session.load();
  await h.session.call('status', { processId: 'P1' });
  await h.session.call('status', { processId: 'P1' });
  assert.deepEqual(
    h.calls.map((c) => c.method),
    ['revoke', 'status', 'status'],
  );
  h.now += 61000;
  await h.session.call('status', { processId: 'P1' });
  assert.deepEqual(h.calls.map((c) => c.method).slice(3), ['revoke', 'status']);
  assert.equal(parseTerminalLink(h.raw).accessToken, 'old-access');
});

test('after 401/403 a read is retried once with the renewed token', async () => {
  const h = sessionFixture(link(), {
    revoke: revoked,
    status: (token) =>
      token === 'old-access'
        ? { kind: 'refused', httpStatus: 401, statusCode: 999, message: null }
        : { kind: 'ok', data: { status: 'wait' } },
  });
  await h.session.load();
  const answer = await h.session.call('status', { processId: 'P1' });
  assert.equal(answer.kind, 'ok');
  assert.deepEqual(
    h.calls.map((c) => [c.method, c.token]),
    [
      ['status', 'old-access'],
      ['revoke', 'old-access'],
      ['status', 'new-access'],
    ],
  );
});

test('a payment refused for its token renews it but is never sent again', async () => {
  const h = sessionFixture(link(), {
    revoke: revoked,
    payment: { kind: 'refused', httpStatus: 403, statusCode: null, message: null },
  });
  await h.session.load();
  const answer = await h.session.call('payment', { amount: '4190' });
  assert.equal(answer.kind, 'refused');
  assert.deepEqual(
    h.calls.map((c) => c.method),
    ['payment', 'revoke'],
  );
  assert.equal(h.session.current().accessToken, 'new-access');
});

test('a stored link is strictly checked; no link means no call', async () => {
  assert.equal(parseTerminalLink(JSON.stringify(link({ host: '8.8.8.8' }))), null);
  assert.equal(parseTerminalLink(JSON.stringify(link({ name: 'other' }))), null);
  assert.equal(parseTerminalLink('{'), null);
  const h = sessionFixture(null, {});
  h.raw = null;
  await h.session.load();
  assert.equal(await h.session.call('status', { processId: 'P1' }), null);
  assert.equal(h.calls.length, 0);
});
