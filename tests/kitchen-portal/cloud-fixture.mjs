/** Fake cashier edge + fake cloud API behind the real kitchen portal (no PostgreSQL). */
import { createServer, request } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { createPortal } from '../../infra/kitchen-portal/server.mjs';
import { executeJob } from '../../infra/kitchen-portal/agent.mjs';

export const ORIGIN = 'https://kitchen.example';
export const key = () => 'pcks_' + randomBytes(32).toString('base64url');
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}
async function readBody(req) {
  const parts = [];
  for await (const p of req) parts.push(p);
  return Buffer.concat(parts).toString('utf8');
}
export function call(port, method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          Host: 'kitchen.example',
          ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      },
      async (res) => {
        const text = await readBody(res);
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* raw */
        }
        resolve({ status: res.statusCode, text, json: parsed });
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Fake cashier edge (only what the portal needs) behind the real link and agent. */
function fakeEdge(world) {
  return createServer(async (req, res) => {
    const body = await readBody(req);
    world.edgeCalls.push({ method: req.method, path: req.url, body });
    const session = world.sessions.get(req.headers.authorization);
    if (req.url === '/edge/v1/session') {
      if (!session || world.revoked.has(session.session_id))
        return json(res, 401, { code: 'UNAUTHORIZED' });
      return json(res, 200, { ...session, token: undefined });
    }
    const error = (status, code) =>
      json(res, status, { code, message_key: 'x', retryable: false, trace_id: randomUUID() });
    if (req.url === '/edge/v1/staff/login') {
      const input = JSON.parse(body || '{}');
      const found = [...world.sessions.entries()].find(
        ([, v]) => v.login === input.login && v.terminal_id === input.terminal_id,
      );
      if (!found || input.password !== world.password) return error(401, 'UNAUTHORIZED');
      const { login, ...credential } = found[1];
      void login;
      return json(res, 200, { ...credential, token: found[0].slice('Bearer '.length) });
    }
    if (req.url === '/edge/v1/staff/logout') return json(res, 200, {});
    if (req.url === '/edge/v1/fulfillment/config')
      return json(res, 200, { enabled: true, wholeTicketActions: true });
    if (!session) return error(401, 'UNAUTHORIZED');
    if (req.url === '/edge/v1/fulfillment/stations')
      return json(res, 200, {
        branchId: world.branchId,
        items: [
          { id: world.prep, kind: 'prep', name: 'Горячий цех' },
          { id: world.assembly, kind: 'assembly', name: 'Сборка' },
        ],
      });
    if (req.url.startsWith('/edge/v1/fulfillment/kitchen'))
      return json(res, 200, {
        items: world.edgeOrder && world.edgeOrder.state !== 'handed_over' ? [world.edgeOrder] : [],
        nextAfterOrderId: null,
      });
    if (req.url.startsWith('/edge/v1/fulfillment/display'))
      return json(res, 200, {
        items: world.edgeOrder
          ? [{ number: world.edgeOrder.displayNumber, state: 'preparing' }]
          : [],
        nextAfterNumber: null,
      });
    if (req.url.includes('/actions')) {
      if (!world.edgeOrder || !req.url.includes(world.edgeOrder.orderId))
        return error(404, 'NOT_FOUND');
      world.edgeOrder.version++;
      world.edgeOrder.tasks[0].state = 'done';
      const o = world.edgeOrder;
      return json(res, 200, {
        orderId: o.orderId,
        branchId: o.branchId,
        version: o.version,
        state: o.state,
        displayNumber: o.displayNumber,
        routingVersion: o.routingVersion,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      });
    }
    return error(404, 'NOT_FOUND');
  });
}

/** Fake cloud API `/v1/kitchen/*` with per-key roles, idempotent commands and a key echo trap. */
function fakeCloud(world) {
  const results = new Map();
  return createServer(async (req, res) => {
    const body = await readBody(req);
    world.cloudCalls.push({ method: req.method, path: req.url, headers: req.headers, body });
    if (world.cloudDown) return json(res, 503, { code: 'SERVICE_UNAVAILABLE' });
    const role = world.keyRoles.get(req.headers.authorization?.slice('Bearer '.length));
    if (!role || world.cloudRevoked) return json(res, 401, { code: 'UNAUTHORIZED' });
    const url = new URL(req.url, 'http://x');
    const leak = { echo: req.headers.authorization, key: req.headers.authorization };
    if (url.pathname === '/v1/kitchen/me')
      return json(res, 200, {
        screenId: randomUUID(),
        branchId: world.branchId,
        role,
        stationIds: role === 'prep' ? [world.prep] : role === 'assembly' ? [world.assembly] : [],
        generation: 1,
      });
    if (url.pathname === '/v1/kitchen/stations')
      return json(res, 200, {
        items: [
          { id: world.prep, kind: 'prep', name: 'Горячий цех', allowed: role === 'prep', ...leak },
          { id: world.assembly, kind: 'assembly', name: 'Сборка', allowed: role === 'assembly' },
        ],
      });
    if (url.pathname === '/v1/kitchen/kitchen')
      return json(res, 200, { items: [{ ...world.order, ...leak }], nextAfterOrderId: null });
    if (url.pathname === '/v1/kitchen/display')
      return json(res, 200, {
        items: [{ number: 301, state: 'ready', fulfillmentOwner: 'cloud', ...leak }],
        nextAfterNumber: null,
      });
    if (url.pathname === '/v1/kitchen/commands' && req.method === 'POST') {
      const idem = req.headers['idempotency-key'];
      const command = JSON.parse(body);
      const scope = role + ':' + idem;
      if (results.has(scope)) return json(res, 200, results.get(scope));
      if (command.orderId !== world.order.orderId) return json(res, 404, { code: 'NOT_FOUND' });
      if (command.expectedVersion !== world.order.version)
        return json(res, 409, { code: 'CONFLICT' });
      world.order.version++;
      world.order.state = command.action === 'ready' ? 'ready' : 'in_production';
      if (command.action === 'complete_station') world.order.tasks[0].state = 'done';
      const { tasks, serviceMode, kitchenComment, ...view } = world.order;
      void tasks;
      void serviceMode;
      void kitchenComment;
      results.set(scope, { ...view, ...leak });
      return json(res, 200, results.get(scope));
    }
    if (url.pathname.startsWith('/v1/kitchen/orders/'))
      return json(res, 200, { ...world.order, ...leak });
    return json(res, 404, { code: 'NOT_FOUND' });
  });
}

export async function setup({ cloud = true, terminalAccess = false } = {}) {
  const branchId = randomUUID(),
    prep = randomUUID(),
    assembly = randomUUID();
  const keys = { prep: key(), assembly: key(), display: key() };
  const at = new Date().toISOString();
  const world = {
    branchId,
    prep,
    assembly,
    edgeCalls: [],
    cloudCalls: [],
    sessions: new Map(),
    revoked: new Set(),
    keyRoles: new Map(Object.entries(keys).map(([role, k]) => [k, role])),
    cloudRevoked: false,
    cloudDown: false,
    password: 'Synthetic-' + randomUUID(),
    edgeOrder: {
      orderId: randomUUID(),
      branchId,
      version: 2,
      state: 'accepted',
      displayNumber: '12',
      routingVersion: 1,
      createdAt: new Date(Date.now() - 6 * 60000).toISOString(),
      updatedAt: at,
      assemblyStationId: assembly,
      channel: 'pos',
      serviceMode: 'dine_in',
      tasks: [
        {
          taskId: randomUUID(),
          stationId: prep,
          version: 1,
          state: 'queued',
          kind: 'prep',
          details: {
            lineId: randomUUID(),
            productId: 'wings',
            title: 'Крылья острые',
            parentTitle: 'Крылья острые',
            description: '',
            quantity: 6,
            modifiers: [],
          },
        },
      ],
    },
    order: {
      orderId: randomUUID(),
      branchId,
      channel: 'kiosk',
      fulfillmentOwner: 'cloud',
      ownerEpoch: '1',
      version: 3,
      state: 'accepted',
      displayNumber: 301,
      routingVersion: 1,
      assemblyStationId: assembly,
      createdAt: at,
      updatedAt: at,
      serviceMode: 'takeaway',
      displayName: 'Алия',
      tasks: [
        {
          id: randomUUID(),
          stationId: prep,
          kind: 'prep',
          state: 'queued',
          version: 1,
          componentKey: 'x:parent',
          details: {
            lineId: randomUUID(),
            productId: 'burger',
            title: 'Чикен бургер',
            quantity: 2,
            parentTitle: 'Чикен бургер',
            description: '',
            modifiers: [
              {
                groupId: 'sauce',
                groupTitle: { ru: 'Соус', kk: 'Тұздық' },
                optionId: 'bbq',
                label: { ru: 'Барбекю', kk: 'Барбекю' },
                quantity: 1,
                linkedProductId: null,
                priceMinor: '0',
              },
            ],
          },
        },
      ],
    },
  };
  const edge = fakeEdge(world),
    api = fakeCloud(world);
  const edgePort = await listen(edge),
    apiPort = await listen(api);
  const terminals = { prep: randomUUID(), assembly: randomUUID(), display: randomUUID() };
  const portal = await createPortal({
    origin: ORIGIN,
    key: 'a'.repeat(64),
    terminals,
    branchLabel: 'Synthetic',
    terminalAccess,
    ...(cloud
      ? {
          cloudKitchen: {
            enabled: true,
            apiOrigin: `http://127.0.0.1:${apiPort}`,
            branchId,
            keys,
          },
        }
      : {}),
  });
  const port = await listen(portal.server);
  let stop = new AbortController();
  const worker = async (signal) => {
    while (!signal.aborted) {
      const job = await portal.link.poll(signal).catch(() => null);
      if (job) portal.link.reply(await executeJob(job, edgePort));
    }
  };
  let workers = Promise.all([worker(stop.signal), worker(stop.signal)]);
  const staff = (mode, login) => {
    const token = randomBytes(32).toString('hex');
    const session = {
      session_id: randomUUID(),
      staff_id: randomUUID(),
      terminal_id: terminals[mode],
      branch_id: branchId,
      role: 'kitchen',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      ...(login ? { login } : {}),
    };
    world.sessions.set('Bearer ' + token, session);
    return {
      session,
      headers: {
        Authorization: 'Bearer ' + token,
        'X-Staff-Session-ID': session.session_id,
        'X-Terminal-ID': terminals[mode],
      },
    };
  };
  return {
    world,
    keys,
    terminals,
    port,
    portal,
    staff,
    async edgeDown() {
      stop.abort();
      await workers;
      portal.link.lastSeen = 0;
    },
    edgeUp() {
      stop = new AbortController();
      workers = Promise.all([worker(stop.signal), worker(stop.signal)]);
    },
    async close() {
      stop.abort();
      await workers;
      await portal.close();
      edge.closeAllConnections();
      api.closeAllConnections();
      await Promise.all([edge, api].map((s) => new Promise((r) => s.close(r))));
    },
  };
}
export const leaked = (ctx, text) => Object.values(ctx.keys).some((k) => text.includes(k));
