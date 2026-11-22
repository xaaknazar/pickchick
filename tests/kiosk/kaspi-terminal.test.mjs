// ADR-0018: the kiosk's LAN client for its Kaspi Smart POS and the token renewal.
// Synthetic fetch and terminal doubles only: no terminal, bank or network is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kaspiEnvelope,
  kaspiExpiration,
  kaspiPinShort,
  kaspiTerminalCall,
  kaspiTerminalProbe,
  kaspiTlsFrom,
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

// Owner 16.11.2026: no DHCP reservation is possible, so the terminal may get a new address.
function movedFixture(newHost, { identity = { terminalId: 'T1', serialNum: 'S1' } } = {}) {
  const h = { raw: JSON.stringify(link()), calls: [], now: Date.parse('2026-11-16T12:00:00Z') };
  const port = async (host, method, params, options = {}) => {
    h.calls.push({ host, method, timeoutMs: options.timeoutMs ?? null });
    if (host !== newHost) return { kind: 'unreachable', reason: 'CONNECT' };
    if (method === 'deviceinfo') return { kind: 'ok', data: identity };
    if (method === 'payment') return { kind: 'ok', data: { processId: 'P9', status: 'wait' } };
    return { kind: 'ok', data: { status: 'wait' } };
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
  h.moved = [];
  h.session.onRelocated = (l) => h.moved.push(l.host);
  return h;
}

test('a silent address: the same terminal is found in the /24, kept and the call sent there once', async () => {
  const h = movedFixture('192.168.1.145');
  await h.session.load();
  const answer = await h.session.call('payment', { amount: '4190' });
  assert.equal(answer.kind, 'ok');
  assert.equal(parseTerminalLink(h.raw).host, '192.168.1.145');
  assert.deepEqual(h.moved, ['192.168.1.145']);
  const payments = h.calls.filter((c) => c.method === 'payment');
  assert.deepEqual(
    payments.map((c) => c.host),
    ['192.168.1.50', '192.168.1.145'],
  );
  const probes = h.calls.filter((c) => c.method === 'deviceinfo');
  assert.ok(probes.every((c) => c.host.startsWith('192.168.1.') && c.host !== '192.168.1.50'));
  assert.ok(probes.every((c) => c.timeoutMs === 1500));
});

test('another terminal at a new address is not taken; the search runs at most once a minute', async () => {
  const h = movedFixture('192.168.1.145', { identity: { terminalId: 'T2', serialNum: 'S2' } });
  await h.session.load();
  const first = await h.session.call('status', { processId: 'P1' });
  assert.equal(first.kind, 'unreachable');
  assert.equal(parseTerminalLink(h.raw).host, '192.168.1.50');
  assert.deepEqual(h.moved, []);
  const count = h.calls.length;
  await h.session.call('status', { processId: 'P1' });
  assert.equal(h.calls.length, count + 1, 'no second search within a minute');
  h.now += 61000;
  await h.session.call('status', { processId: 'P1' });
  assert.ok(h.calls.length > count + 2, 'searched again after a minute');
});

test('a lost answer never starts a search (the request may have reached the terminal)', async () => {
  const h = sessionFixture(link(), {
    payment: { kind: 'lost', reason: 'TIMEOUT' },
  });
  await h.session.load();
  const answer = await h.session.call('payment', { amount: '4190' });
  assert.equal(answer.kind, 'lost');
  assert.deepEqual(
    h.calls.map((c) => c.method),
    ['payment'],
  );
});

// ---- HTTPS with the terminal's leaf certificate pinned (22.11.2026, ADR-0018 point 1). ----
// The native kaspi-tls module is replaced by a double: `certs` maps a host to the SHA-256 of
// the certificate it presents (null: plain HTTP only, absent: nothing listens). Like the Swift
// side, a request is `delivered` only after the presented leaf matched the pin.
const PIN = '228fc8c4' + 'ab'.repeat(24) + '5d0e9a17';
const OTHER_PIN = 'ff'.repeat(32);
function fakeTls(certs, answers = {}) {
  const h = { delivered: [], requests: [], probes: [] };
  h.native = {
    probe: async (host, port, timeoutMs) => {
      h.probes.push({ host, port, timeoutMs });
      if (!(host in certs)) return { transport: 'none' };
      return certs[host] === null
        ? { transport: 'http' }
        : { transport: 'https', sha256: certs[host] };
    },
    request: async (host, port, path, token, sha256, timeoutMs) => {
      h.requests.push({ host, path, sha256 });
      if (!(host in certs) || certs[host] === null)
        return { ok: false, failure: 'CONNECT', sent: false };
      if (certs[host] !== sha256) return { ok: false, failure: 'CERTIFICATE', sent: false };
      const parsed = new URL('https://terminal' + path);
      const method = parsed.pathname.replace('/v2/', '');
      h.delivered.push({ host, port, method, token, timeoutMs });
      const answer = answers[method] ?? answers.default;
      if (typeof answer === 'function') return answer(host);
      if (answer) return answer;
      return { ok: false, failure: 'CONNECTION', sent: true };
    },
  };
  h.tls = kaspiTlsFrom(h.native);
  return h;
}
const tlsJson = (status, body) => ({ ok: true, status, body: JSON.stringify(body) });
const tlsDeviceinfo = (terminalId = 'T1', serialNum = 'S1') =>
  tlsJson(200, { statusCode: 0, data: { terminalId, serialNum } });
const noFetch = async () => {
  throw new Error('plain HTTP must not be used for a pinned link');
};
const memoryStore = (h) => ({
  read: async () => h.raw,
  write: async (raw) => {
    h.raw = raw;
  },
  remove: async () => {
    h.raw = null;
  },
});

test('a pinned call goes over the native TLS only, with the path, token and pin', async () => {
  const t = fakeTls(
    { '192.168.1.50': PIN },
    { status: tlsJson(200, { statusCode: 0, data: { status: 'wait' } }) },
  );
  const answer = await kaspiTerminalCall(
    '192.168.1.50',
    'status',
    { processId: 'P-1' },
    { token: 'tok_1', pin: PIN },
    noFetch,
    t.tls,
  );
  assert.deepEqual(answer, { kind: 'ok', data: { status: 'wait' } });
  assert.deepEqual(t.requests, [
    { host: '192.168.1.50', path: '/v2/status?processId=P-1', sha256: PIN },
  ]);
  assert.equal(t.delivered[0].port, 8080);
  assert.equal(t.delivered[0].token, 'tok_1');
  await assert.rejects(
    kaspiTerminalCall('192.168.1.50', 'status', {}, { pin: PIN.toUpperCase() }, noFetch, t.tls),
    /PIN/,
  );
});

test('another certificate: the payment is never sent, the answer is unreachable CERTIFICATE', async () => {
  const t = fakeTls(
    { '192.168.1.50': OTHER_PIN },
    { default: tlsJson(200, { statusCode: 0, data: { processId: 'P-1' } }) },
  );
  const answer = await kaspiTerminalCall(
    '192.168.1.50',
    'payment',
    { amount: '4190' },
    { token: 'tok_1', pin: PIN },
    noFetch,
    t.tls,
  );
  assert.deepEqual(answer, { kind: 'unreachable', reason: 'CERTIFICATE' });
  assert.equal(t.delivered.length, 0, 'nothing passed the handshake');
  assert.deepEqual(
    t.requests.map((r) => r.path),
    ['/v2/deviceinfo'],
    'only the pre-flight reached the handshake; the payment was never attempted',
  );
});

test('over TLS a sent change that fails is lost; a read that never reached TLS is unreachable', async () => {
  const lostPayment = fakeTls(
    { '192.168.1.50': PIN },
    { deviceinfo: tlsDeviceinfo(), payment: { ok: false, failure: 'TIMEOUT', sent: true } },
  );
  assert.deepEqual(
    await kaspiTerminalCall(
      '192.168.1.50',
      'payment',
      { amount: '4190' },
      { token: 't', pin: PIN },
      noFetch,
      lostPayment.tls,
    ),
    { kind: 'lost', reason: 'TIMEOUT' },
  );
  const silent = fakeTls({});
  assert.deepEqual(
    await kaspiTerminalCall('192.168.1.50', 'status', {}, { pin: PIN }, noFetch, silent.tls),
    { kind: 'unreachable', reason: 'CONNECT' },
  );
  // An unreadable native answer is never taken as «not sent».
  const odd = kaspiTlsFrom({ probe: async () => ({}), request: async () => 'garbage' });
  assert.deepEqual(
    await kaspiTerminalCall('192.168.1.50', 'status', {}, { pin: PIN }, noFetch, odd),
    { kind: 'lost', reason: 'CONNECTION' },
  );
  // Without the native module (web, an older build) nothing is sent over HTTPS at all.
  for (const tls of [undefined, kaspiTlsFrom(null)])
    assert.deepEqual(
      await kaspiTerminalCall(
        '192.168.1.50',
        'payment',
        { amount: '1' },
        { pin: PIN },
        noFetch,
        tls,
      ),
      { kind: 'unreachable', reason: 'CONNECT' },
    );
});

test('probe: TLS gives the pin; a plain HTTP terminal is http; silence is null', async () => {
  const t = fakeTls({ '192.168.1.50': PIN, '192.168.1.60': null });
  assert.deepEqual(await kaspiTerminalProbe('192.168.1.50', noFetch, t.tls), {
    transport: 'https',
    pin: PIN,
  });
  assert.equal(t.probes[0].port, 8080);
  assert.equal(t.delivered.length, 0, 'the probe sends no request');
  const { fetcher, calls } = fakeFetch({ deviceinfo });
  assert.deepEqual(await kaspiTerminalProbe('192.168.1.60', fetcher, t.tls), {
    transport: 'http',
  });
  assert.equal(calls[0].url, 'http://192.168.1.60:8080/v2/deviceinfo');
  assert.equal(calls[0].init.headers.accesstoken, undefined, 'no token in the probe');
  const none = fakeFetch({});
  assert.equal(await kaspiTerminalProbe('192.168.1.70', none.fetcher, t.tls), null);
  assert.equal(none.calls.length, 0, 'nothing listens: no HTTP attempt');
  // Web or an older build: no TLS, the address is asked over plain HTTP.
  assert.deepEqual(await kaspiTerminalProbe('192.168.1.60', fetcher), { transport: 'http' });
  assert.equal(await kaspiTerminalProbe('192.168.1.60', none.fetcher), null);
  await assert.rejects(kaspiTerminalProbe('8.8.8.8', noFetch, t.tls), /HOST/);
  // A malformed certificate hash from the native side is no pin.
  const bad = kaspiTlsFrom({
    probe: async () => ({ transport: 'https', sha256: 'xyz' }),
    request: async () => ({}),
  });
  assert.deepEqual(await bad.probe('192.168.1.50', 8080, 5000), { transport: 'http' });
  assert.equal(kaspiPinShort(PIN), '228fc8c4…5d0e9a17');
});

test('a stored pin is strictly checked; links stored before HTTPS are plain HTTP', () => {
  assert.equal(parseTerminalLink(JSON.stringify(link())).pin, null);
  assert.equal(parseTerminalLink(JSON.stringify(link({ pin: null }))).pin, null);
  assert.equal(parseTerminalLink(JSON.stringify(link({ pin: PIN }))).pin, PIN);
  for (const pin of [PIN.toUpperCase(), PIN.slice(1), '', 42, 'ab:'.repeat(32)])
    assert.equal(parseTerminalLink(JSON.stringify(link({ pin }))), null, String(pin));
});

test('an HTTPS link: the renewal and every session call are pinned, the pin is kept', async () => {
  const h = {
    raw: JSON.stringify(link({ pin: PIN, expiresAt: Date.parse('2026-11-16T13:00:00Z') })),
  };
  const pins = [];
  const session = new TerminalSession(
    memoryStore(h),
    async (host, method, params, options = {}) => {
      pins.push([method, options.pin ?? null]);
      return method === 'revoke' ? revoked : { kind: 'ok', data: { status: 'wait' } };
    },
    () => Date.parse('2026-11-16T12:00:00Z'),
  );
  await session.load();
  await session.call('status', { processId: 'P1' });
  assert.deepEqual(pins, [
    ['revoke', PIN],
    ['status', PIN],
  ]);
  assert.equal(parseTerminalLink(h.raw).accessToken, 'new-access');
  assert.equal(parseTerminalLink(h.raw).pin, PIN, 'renewal keeps the pin');
});

test('a moved HTTPS terminal is taken only with the same ID, serial and certificate', async () => {
  // .145: same IDs, another certificate (a look-alike); .147: same certificate, another
  // terminal; .146: the same terminal.
  const t = fakeTls(
    { '192.168.1.145': OTHER_PIN, '192.168.1.146': PIN, '192.168.1.147': PIN },
    {
      deviceinfo: (host) =>
        host === '192.168.1.147' ? tlsDeviceinfo('T2', 'S2') : tlsDeviceinfo('T1', 'S1'),
      status: tlsJson(200, { statusCode: 0, data: { status: 'wait' } }),
    },
  );
  const h = { raw: JSON.stringify(link({ pin: PIN })) };
  const session = new TerminalSession(
    memoryStore(h),
    (host, method, params, options) =>
      kaspiTerminalCall(host, method, params, options, noFetch, t.tls),
    () => Date.parse('2026-11-16T12:00:00Z'),
  );
  const moved = [];
  session.onRelocated = (l) => moved.push(l.host);
  await session.load();
  const answer = await session.call('status', { processId: 'P1' });
  assert.equal(answer.kind, 'ok');
  assert.deepEqual(moved, ['192.168.1.146']);
  assert.equal(parseTerminalLink(h.raw).host, '192.168.1.146');
  assert.equal(parseTerminalLink(h.raw).pin, PIN);
  assert.ok(
    t.requests.every((r) => r.sha256 === PIN),
    'the search is pinned',
  );
  assert.equal(
    t.delivered.some((d) => d.host === '192.168.1.145'),
    false,
    'nothing passed the handshake of the look-alike',
  );

  // Only the look-alike remains: the link stays, the call is unreachable (nothing was sent).
  const alone = fakeTls({ '192.168.1.145': OTHER_PIN }, { deviceinfo: tlsDeviceinfo() });
  const h2 = { raw: JSON.stringify(link({ pin: PIN })) };
  const s2 = new TerminalSession(
    memoryStore(h2),
    (host, method, params, options) =>
      kaspiTerminalCall(host, method, params, options, noFetch, alone.tls),
    () => Date.parse('2026-11-16T12:00:00Z'),
  );
  await s2.load();
  assert.equal((await s2.call('status', { processId: 'P1' })).kind, 'unreachable');
  assert.equal(parseTerminalLink(h2.raw).host, '192.168.1.50');
  assert.equal(alone.delivered.length, 0);
});

test('terminal copy: the pin mismatch text of the owner task, in ru/kk/en', async () => {
  const { terminalCopyForTest } = await import('../../apps/kiosk/src/terminalCopy.ts');
  assert.equal(
    terminalCopyForTest.ru.result_certificate,
    'Терминал отвечает с другим сертификатом. Проверьте IP или привяжите заново.',
  );
  for (const locale of ['kk', 'en']) {
    assert.ok(terminalCopyForTest[locale].result_certificate.length > 20);
    assert.ok(terminalCopyForTest[locale].result_protection.length > 20);
  }
});

test('relocate sends the token only on a pinned HTTPS link (protected terminals need it)', async () => {
  const calls = [];
  const link = {
    host: '192.168.2.145',
    terminalId: 'T1',
    serial: 'S1',
    pin: 'e2'.repeat(32),
    name: 'pickchick-kiosk-abc123',
    accessToken: 'acc-1',
    refreshToken: 'ref-1',
    expiresAt: Date.now() + 86400000,
    linkedAt: 1,
  };
  let raw = JSON.stringify(link);
  const session = new TerminalSession(
    {
      read: async () => raw,
      write: async (r) => {
        raw = r;
      },
      remove: async () => {
        raw = null;
      },
    },
    async (host, method, params, options = {}) => {
      calls.push({ host, method, token: options.token ?? null });
      if (method === 'deviceinfo' && host === '192.168.2.150' && options.token === 'acc-1')
        return { kind: 'ok', data: { terminalId: 'T1', serialNum: 'S1' } };
      if (method === 'deviceinfo' && host === '192.168.2.150')
        return { kind: 'refused', httpStatus: 401, statusCode: 999, message: null };
      return { kind: 'unreachable', reason: 'CONNECT' };
    },
    () => Date.now(),
  );
  await session.load();
  assert.equal(await session.relocate(), true);
  assert.equal(session.current().host, '192.168.2.150');
  assert.ok(calls.filter((c) => c.method === 'deviceinfo').every((c) => c.token === 'acc-1'));

  // A plain-HTTP link: no token goes to the other addresses.
  calls.length = 0;
  raw = JSON.stringify({ ...link, pin: null, host: '192.168.2.145' });
  await session.load();
  await session.relocate();
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.token === null));
});
