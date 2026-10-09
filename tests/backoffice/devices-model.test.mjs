import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ApiError, allowedPath, transport } from '../../apps/backoffice/dist/api.js';
import {
  DevicesModel,
  actions,
  attention,
  canPair,
  countdown,
  credentialState,
  groupDevices,
  legacyRegistry,
  parseEvents,
  parseIssued,
  parseRegistry,
  presence,
  reasonValid,
  relative,
  sameName,
  summary,
} from '../../apps/backoffice/dist/devices-model.js';
import { allowed, createBackofficeServer } from '../../apps/backoffice/server.mjs';

const branch = '10000000-0000-4000-8000-000000000003';
const T0 = Date.parse('2026-10-09T08:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const id = () => randomUUID();
const device = (over = {}) => ({
  id: id(),
  role: 'kiosk',
  name: 'iPad у входа',
  status: 'active',
  online: null,
  last_seen_at: iso(T0 - 30_000),
  app_version: '1.4.0',
  credential_expires_at: null,
  open_code: null,
  payment_open: false,
  revoked_at: null,
  ...over,
});
const registry = (devices, over = {}) => ({
  branch_id: branch,
  role: 'manager',
  as_of: iso(T0),
  kiosk_supported: true,
  devices,
  ...over,
});
const envelope = (code, reason) => ({
  code,
  message_key: `errors.${code.toLowerCase()}`,
  trace_id: randomUUID(),
  retryable: false,
  ...(reason === undefined ? {} : { error: { code: reason } }),
});

test('registry parser accepts snake_case and camelCase and rejects foreign or malformed data', () => {
  const edge = device({ role: 'edge', name: 'Касса 1' });
  const camel = {
    branchId: branch,
    role: 'analyst',
    asOf: iso(T0),
    kioskSupported: false,
    devices: [
      {
        id: edge.id,
        kind: 'display',
        name: 'Табло зала',
        status: 'active',
        lastSeenAt: iso(T0 - 60_000),
        appVersion: '2.0.1',
        openCode: { id: id(), expiresAt: iso(T0 + 60_000) },
      },
    ],
  };
  const parsed = parseRegistry(camel, branch);
  assert.equal(parsed.source, 'registry');
  assert.equal(parsed.role, 'analyst');
  assert.equal(parsed.kiosk_supported, false);
  assert.equal(parsed.devices[0].role, 'board', 'legacy kind maps to role');
  assert.equal(parsed.devices[0].app_version, '2.0.1');
  assert.equal(parsed.devices[0].open_code.expires_at, iso(T0 + 60_000));
  assert.equal(parseRegistry(registry([edge]), branch).devices[0].role, 'edge');
  for (const bad of [
    registry([edge], { branch_id: id() }),
    registry([edge], { role: 'owner' }),
    registry([{ ...edge, status: 'lost' }]),
    registry([{ ...edge, role: 'printer' }]),
    registry([{ ...edge, id: 'not-a-uuid' }]),
    registry([{ ...edge, last_seen_at: 'yesterday' }]),
    registry('x'),
  ])
    assert.throws(
      () => parseRegistry(bad, branch),
      (e) => e instanceof ApiError && e.code === 'INVALID_RESPONSE',
    );
});

test('presence: on line within 2 minutes, warning, attention after 10 minutes, pending and revoked', () => {
  assert.deepEqual(presence(device(), T0), { tone: 'good', label: 'На связи' });
  assert.deepEqual(presence(device({ last_seen_at: iso(T0 - 5 * 60_000) }), T0), {
    tone: 'warn',
    label: 'Нет связи 5 мин',
  });
  assert.deepEqual(presence(device({ last_seen_at: iso(T0 - 25 * 60_000) }), T0), {
    tone: 'bad',
    label: 'Нет связи 25 мин',
  });
  assert.equal(
    presence(device({ last_seen_at: iso(T0 - 3 * 3600_000) }), T0).label,
    'Нет связи 3 ч',
  );
  assert.equal(
    presence(device({ last_seen_at: iso(T0 - 3 * 86400_000) }), T0).label,
    'Нет связи 3 дн',
  );
  // The server verdict wins over the browser clock.
  assert.equal(presence(device({ online: false }), T0).tone, 'warn');
  assert.equal(presence(device({ status: 'pending' }), T0).label, 'Ожидает подключения');
  assert.equal(presence(device({ status: 'revoked' }), T0).label, 'Отозвано');
  assert.equal(presence(device({ last_seen_at: null }), T0).label, 'Нет данных о связи');
  assert.equal(relative(iso(T0 - 20_000), T0), 'только что');
  assert.equal(relative(iso(T0 - 7 * 60_000), T0), '7 мин назад');
  assert.equal(relative(null, T0), 'нет данных');
});

test('attention counts stale links, expiring cloud keys and expired codes; summary per branch', () => {
  const edge = device({
    role: 'edge',
    name: 'Касса',
    credential_expires_at: iso(T0 + 3 * 86400_000),
  });
  assert.equal(credentialState(edge.credential_expires_at, T0), 'warn');
  assert.equal(credentialState(iso(T0 + 20 * 86400_000), T0), 'ok');
  assert.equal(credentialState(iso(T0 - 1), T0), 'expired');
  assert.equal(attention(edge, T0), true);
  const stale = device({ last_seen_at: iso(T0 - 11 * 60_000) });
  const expired = device({
    status: 'pending',
    last_seen_at: null,
    open_code: { id: id(), expires_at: iso(T0 - 1000) },
  });
  const waiting = device({
    status: 'pending',
    last_seen_at: null,
    open_code: { id: id(), expires_at: iso(T0 + 600_000) },
  });
  const ok = device();
  const gone = device({ status: 'revoked', last_seen_at: iso(T0 - 86400_000) });
  assert.equal(attention(stale, T0), true);
  assert.equal(attention(expired, T0), true);
  assert.equal(attention(waiting, T0), false);
  assert.equal(attention(gone, T0), false);
  assert.deepEqual(summary({ devices: [edge, stale, expired, waiting, ok, gone] }, T0), {
    online: 2,
    attention: 3,
    pending: 2,
  });
});

test('groups follow the cabinet layout; revoked devices are kept apart', () => {
  const list = [
    device({ role: 'pos', name: 'Касса - приложение' }),
    device({ role: 'edge', name: 'Моноблок' }),
    device({ name: 'Б-киоск' }),
    device({ name: 'А-киоск', status: 'pending' }),
    device({ name: 'Старый', status: 'revoked' }),
    device({ role: 'kitchen_prep', name: 'Горячий цех' }),
    device({ role: 'board', name: 'Табло' }),
  ];
  const groups = groupDevices(list);
  assert.deepEqual(
    groups.map((g) => g.title),
    ['Касса (моноблок)', 'iPad-киоски', 'Кухня: приём', 'Кухня: сборка', 'Табло'],
  );
  assert.deepEqual(
    groups[0].current.map((d) => d.name),
    ['Моноблок', 'Касса - приложение'],
  );
  assert.deepEqual(
    groups[1].current.map((d) => d.name),
    ['Б-киоск', 'А-киоск'],
    'active first, then pending',
  );
  assert.deepEqual(
    groups[1].revoked.map((d) => d.name),
    ['Старый'],
  );
  assert.equal(groups[3].current.length, 0);
});

test('actions: never revoke the cashier node, kitchen/board/pos read-only, analyst views only', () => {
  const r = { ...registry([]), source: 'registry' };
  const edge = device({ role: 'edge' });
  assert.deepEqual(actions(edge, r), ['journal']);
  for (const role of ['pos', 'kitchen_prep', 'kitchen_assembly', 'board'])
    assert.deepEqual(actions(device({ role }), r), ['journal'], role);
  assert.deepEqual(actions(device(), r), ['rename', 'journal', 'revoke']);
  assert.deepEqual(
    actions(device({ status: 'pending', open_code: { id: id(), expires_at: iso(T0) } }), r),
    ['code', 'cancel_code', 'rename', 'journal', 'revoke'],
  );
  assert.deepEqual(actions(device({ payment_open: true }), r), ['rename', 'journal']);
  assert.deepEqual(actions(device(), { ...r, role: 'analyst' }), ['journal']);
  assert.deepEqual(actions(device({ status: 'revoked' }), r), ['journal']);
  assert.deepEqual(actions(device({ status: 'pending' }), { ...r, kiosk_supported: false }), [
    'rename',
    'journal',
    'revoke',
  ]);
  assert.equal(canPair(r), true);
  assert.equal(canPair({ ...r, kiosk_supported: false }), false);
  assert.equal(canPair({ ...r, role: 'analyst' }), false);
  const legacy = legacyRegistry(
    [
      {
        id: edge.id,
        name: 'Касса',
        kind: 'edge',
        status: 'active',
        last_pos_at: iso(T0 - 60_000),
        last_fulfillment_at: iso(T0 - 120_000),
      },
      { id: id(), name: 'Кухня', kind: 'kitchen', status: 'revoked' },
      { id: 'bad', name: 'x', kind: 'edge' },
    ],
    branch,
    'manager',
    iso(T0),
  );
  assert.equal(legacy.source, 'legacy');
  assert.equal(legacy.devices.length, 2);
  assert.equal(legacy.devices[0].last_seen_at, iso(T0 - 60_000));
  assert.equal(legacy.devices[1].role, 'kitchen_prep');
  assert.equal(canPair(legacy), false);
  for (const d of legacy.devices) assert.deepEqual(actions(d, legacy), [], 'legacy is read-only');
});

test('small helpers: countdown, reason and typed-name confirmation', () => {
  assert.equal(countdown(iso(T0 + 30 * 60_000), T0), '30:00');
  assert.equal(countdown(iso(T0 + 61_500), T0), '01:02');
  assert.equal(countdown(iso(T0 - 1), T0), '00:00');
  assert.equal(reasonValid('  ок '), false);
  assert.equal(reasonValid('Замена iPad'), true);
  assert.equal(reasonValid('x'.repeat(501)), false);
  assert.equal(sameName(' ipad у входа ', device()), true);
  assert.equal(sameName('iPad', device()), false);
  assert.deepEqual(
    parseIssued({
      codeId: id().toUpperCase(),
      login: 'kiosk-a1',
      password: 'abcdefghijkl',
      expiresAt: iso(T0),
    }).login,
    'kiosk-a1',
  );
  assert.equal(parseIssued({ code: 'AB12-CD34', expires_at: iso(T0) }).code, 'AB12-CD34');
  assert.throws(() => parseIssued({ login: 'kiosk-a1', password: 'short', expires_at: iso(T0) }));
  assert.throws(() => parseIssued({ code: 'abcd-efgh', expires_at: iso(T0) }));
  assert.equal(
    parseEvents({
      events: [{ action: 'paired', actor_kind: 'device', reason: null, at: iso(T0) }],
    })[0].action,
    'paired',
  );
});

function fakeApi(routes) {
  const calls = [];
  const api = async (path, request = {}) => {
    calls.push({ path, method: request.method ?? 'GET', body: request.body });
    const handler = routes[`${request.method ?? 'GET'} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`];
    if (!handler) throw new Error('unexpected ' + path);
    return handler(request.body, path);
  };
  return { api, calls };
}

test('iPad pairing: create kiosk, one-time login shown in memory, follows to paired, secrets dropped', async () => {
  let now = T0;
  const kiosk = id();
  const code = id();
  let paired = false;
  let createAttempts = 0;
  const { api, calls } = fakeApi({
    'GET branches/:id/devices': () =>
      registry(
        [
          device({ role: 'edge', name: 'Касса' }),
          device({
            id: kiosk,
            name: 'iPad у входа',
            status: paired ? 'active' : 'pending',
            last_seen_at: paired ? iso(now) : null,
            open_code: paired ? null : { id: code, expires_at: iso(T0 + 30 * 60_000) },
          }),
        ],
        { as_of: iso(now) },
      ),
    'POST branches/:id/devices': () => {
      createAttempts++;
      if (createAttempts === 1) throw new ApiError('NETWORK');
      return { device: { id: kiosk } };
    },
    'POST branches/:id/devices/:id/pairing-codes': () => ({
      code_id: code,
      login: 'kiosk-entrance',
      password: 'Sup3r-Secret-1',
      expires_at: iso(T0 + 30 * 60_000),
    }),
  });
  let changes = 0;
  const m = new DevicesModel(
    api,
    () => changes++,
    () => now,
  );
  await m.scope('actor', branch);
  assert.equal(m.data.devices.length, 2);
  m.startPairing();
  assert.equal(m.pairing.name, 'iPad-киоск 2');
  assert.equal(await m.issue('i', 'Новый киоск'), false);
  assert.match(m.pairing.error, /от 2 до 64/);
  assert.equal(await m.issue('iPad у входа', 'н'), false);
  assert.match(m.pairing.error, /причину/);
  // Lost reply on creation: the retry reuses the same requestId (idempotent create).
  assert.equal(await m.issue('iPad у входа', 'Новый киоск у входа'), false);
  assert.equal(m.pairing.stage, 'form');
  assert.equal(m.pairing.deviceId, null);
  assert.equal(await m.issue('iPad у входа', 'Новый киоск у входа'), true);
  const creates = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/devices'));
  assert.equal(creates.length, 2);
  assert.equal(creates[0].body.requestId, creates[1].body.requestId);
  assert.deepEqual(Object.keys(creates[1].body).sort(), ['name', 'reason', 'requestId', 'role']);
  assert.equal(creates[1].body.role, 'kiosk');
  const issue = calls.find((c) => c.path.endsWith('/pairing-codes'));
  assert.equal(issue.path, `branches/${branch}/devices/${kiosk}/pairing-codes`);
  assert.deepEqual(Object.keys(issue.body).sort(), ['reason', 'requestId']);
  assert.equal(m.pairing.stage, 'code');
  assert.equal(m.pairing.password, 'Sup3r-Secret-1');
  assert.equal(m.nextDelay(), 3000);
  now += 60_000;
  await m.load();
  assert.equal(m.pairing.stage, 'code', 'still waiting while the device is pending');
  paired = true;
  await m.load();
  assert.equal(m.pairing.stage, 'paired');
  assert.equal(m.pairing.password, null);
  assert.equal(m.nextDelay(), 15000);
  assert.ok(changes > 0);
  m.closePairing();
  assert.equal(m.pairing, null);
});

test('pairing code expiry and a lost code reply both drop the secret and demand a new code', async () => {
  let now = T0;
  const kiosk = id();
  let fail = false;
  const { api, calls } = fakeApi({
    'GET branches/:id/devices': () =>
      registry([device({ id: kiosk, status: 'pending', last_seen_at: null })], { as_of: iso(now) }),
    'POST branches/:id/devices/:id/pairing-codes': () => {
      if (fail) throw new ApiError('NETWORK');
      return {
        id: id(),
        login: 'kiosk-x',
        password: 'abcdefghijkl',
        expiresAt: iso(T0 + 30 * 60_000),
      };
    },
  });
  const m = new DevicesModel(
    api,
    () => {},
    () => now,
  );
  await m.scope('actor', branch);
  m.startPairing(m.data.devices[0]);
  assert.equal(await m.issue('', 'Повторный код'), true);
  now = T0 + 30 * 60_000;
  m.tick();
  assert.equal(m.pairing.stage, 'expired');
  assert.equal(m.pairing.password, null);
  m.startPairing(m.data.devices[0]);
  const before = m.pairing.codeRequest;
  fail = true;
  assert.equal(await m.issue('', 'Повторный код'), false);
  assert.match(m.pairing.error, /больше не будет показан/);
  assert.notEqual(m.pairing.codeRequest, before, 'a new code needs a new requestId');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/devices')).length, 0);
});

test('revoke: cashier node refused locally; kiosk needs reason and exact name; reasons explained', async () => {
  const edge = device({ role: 'edge', name: 'Касса' });
  const kiosk = device({ name: 'iPad у входа' });
  let conflict = false;
  const { api, calls } = fakeApi({
    'GET branches/:id/devices': () => registry([edge, kiosk]),
    'POST branches/:id/devices/:id/revoke': () => {
      if (conflict)
        throw new ApiError('CONFLICT', 409, 'EDGE_REVOKE_REQUIRES_REPLACEMENT_PROTOCOL');
      return { ok: true };
    },
  });
  const m = new DevicesModel(
    api,
    () => {},
    () => T0,
  );
  await m.scope('actor', branch);
  assert.match(await m.revoke(m.data.devices[0], 'Причина', 'Касса'), /нельзя отключить/);
  assert.match(await m.revoke(m.data.devices[1], 'н', 'iPad у входа'), /причину/);
  assert.match(await m.revoke(m.data.devices[1], 'Украден', 'iPad'), /точно как в карточке/);
  assert.equal(calls.filter((c) => c.path.endsWith('/revoke')).length, 0);
  assert.equal(await m.revoke(m.data.devices[1], 'Украден', 'ipad у входа'), '');
  const sent = calls.find((c) => c.path.endsWith('/revoke'));
  assert.equal(sent.path, `branches/${branch}/devices/${kiosk.id}/revoke`);
  assert.deepEqual(Object.keys(sent.body).sort(), ['confirmName', 'reason', 'requestId']);
  assert.equal(sent.body.confirmName, 'iPad у входа');
  conflict = true;
  assert.match(await m.revoke(m.data.devices[1], 'Украден', 'iPad у входа'), /Замена кассы/);
});

test('missing registry route falls back to read-only; other failures stay visible', async () => {
  let error = new ApiError('INVALID_RESPONSE', 404);
  const m = new DevicesModel(
    async () => {
      throw error;
    },
    () => {},
    () => T0,
  );
  await m.scope('actor', branch);
  assert.equal(m.unavailable, true);
  assert.equal(m.error, '');
  error = new ApiError('FORBIDDEN', 403);
  await m.load();
  assert.equal(m.unavailable, true, 'a previous verdict is not reset by an unrelated error');
  assert.match(m.error, /только управляющему/);
});

test('client and proxy allowlists accept exactly the device routes and methods', async () => {
  const b = `operations/branches/${branch}/devices`;
  const d = id(),
    c = id();
  for (const path of [
    b,
    `${b}/${d}/events`,
    `${b}/${d}/revoke`,
    `${b}/${d}/rename`,
    `${b}/${d}/pairing-codes`,
    `${b}/${d}/pairing-codes/${c}/cancel`,
  ])
    assert.equal(allowedPath(path), true, path);
  for (const path of [
    `${b}?all=1`,
    `${b}/${d}`,
    `${b}/${d}/delete`,
    `${b}/${d}/pairing-codes/${c}`,
    `${b}/${d}/staff-reset`,
    `${b}/commands/${c}`,
    `${b}/../commands`,
    `operations/branches/not-a-uuid/devices`,
  ])
    assert.equal(allowedPath(path), false, path);
  const p = `/v1/admin/backoffice/branches/${branch}/devices`;
  for (const [method, path, ok] of [
    ['GET', p, true],
    ['POST', p, true],
    ['PUT', p, false],
    ['GET', `${p}?x=1`, false],
    ['GET', `${p}/${d}/events`, true],
    ['POST', `${p}/${d}/events`, false],
    ['POST', `${p}/${d}/revoke`, true],
    ['GET', `${p}/${d}/revoke`, false],
    ['POST', `${p}/${d}/rename`, true],
    ['POST', `${p}/${d}/pairing-codes`, true],
    ['GET', `${p}/${d}/pairing-codes`, false],
    ['POST', `${p}/${d}/pairing-codes/${c}/cancel`, true],
    ['POST', `${p}/${d}`, false],
    ['POST', `${p}/${d}/staff-reset`, false],
    ['GET', `${p}/commands/${c}`, false],
  ])
    assert.equal(allowed(method, path), ok, `${method} ${path}`);

  // Proxy forwards the new routes with the bearer token; unknown device routes never leave it.
  const received = [];
  const api = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(registry([])));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const ui = createBackofficeServer({ apiPort: api.address().port });
  ui.listen(0, '127.0.0.1');
  await once(ui, 'listening');
  const base = `http://127.0.0.1:${ui.address().port}`;
  const token = 'a'.repeat(64);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    let r = await fetch(base + p, { headers });
    assert.equal(r.status, 200);
    const body = { requestId: id(), reason: 'Украден', confirmName: 'iPad' };
    r = await fetch(`${base}${p}/${d}/revoke`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(received.at(-1).body), body);
    assert.equal(received.at(-1).auth, 'Bearer ' + token);
    const count = received.length;
    r = await fetch(`${base}${p}/${d}/staff-reset`, { method: 'POST', headers, body: '{}' });
    assert.equal(r.status, 404);
    r = await fetch(`${base}${p}/${d}/events`, { method: 'POST', headers, body: '{}' });
    assert.equal(r.status, 404);
    assert.equal(received.length, count);
    // The browser transport maps the same paths onto the proxy.
    const original = globalThis.fetch;
    const seen = [];
    try {
      globalThis.fetch = async (url, options) => {
        seen.push([url, options.method]);
        return Response.json(registry([]));
      };
      await transport(`operations/branches/${branch}/devices/${d}/pairing-codes`, token, {
        method: 'POST',
        body: { requestId: id(), reason: 'Новый' },
      });
      await transport(`operations/branches/${branch}/devices`, 'session');
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(seen, [
      [`/v1/admin/backoffice/branches/${branch}/devices/${d}/pairing-codes`, 'POST'],
      [`/backoffice/api/v1/admin/backoffice/branches/${branch}/devices`, 'GET'],
    ]);
  } finally {
    ui.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => ui.close(resolve)),
      new Promise((resolve) => api.close(resolve)),
    ]);
  }
});

test('error envelope reasons for devices produce precise Russian text', async () => {
  const { failure, message } = await import('../../apps/backoffice/dist/api.js');
  assert.match(
    message(failure(409, envelope('CONFLICT', 'EDGE_REVOKE_REQUIRES_REPLACEMENT_PROTOCOL'))),
    /Кассу нельзя отключить/,
  );
  assert.match(message(failure(409, envelope('CONFLICT', 'CODE_ALREADY_ISSUED'))), /новый код/);
});
