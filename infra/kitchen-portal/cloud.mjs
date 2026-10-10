import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { allowed } from '../../apps/kitchen/server.mjs';

/**
 * Second upstream of the kitchen portal (ADR-0014, S6): the cloud API `/v1/kitchen/*` for
 * kiosk/mobile orders owned by the cloud. Owner decision 5: the kitchen browser is a cloud
 * screen, not a cook. It is bound once with a one-time pairing code (cloud 056); the portal
 * exchanges the code server-side and keeps the resulting screen key only inside an encrypted,
 * HttpOnly, Secure, SameSite=Strict, path-scoped cookie. Every request is authenticated by the
 * cloud with that key (revocation and rotation take effect on the next poll; nothing is kept
 * in portal memory). Responses are re-shaped into the edge fulfillment contract the renderer
 * already validates, so no cloud-only field reaches it. The cashier and cook sessions are not
 * involved.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^pcks_[A-Za-z0-9_-]{43}$/;
const MODES = ['prep', 'assembly', 'display'];
const base = '/edge/v1/fulfillment';
export const CLOUD_PREFIX = '/cloud/v1/fulfillment';
const ORDER_STATES = [
  'held',
  'accepted',
  'in_production',
  'ready',
  'handed_over',
  'cancel_requested',
  'cancelled',
  'released',
];
const TASK_STATES = ['queued', 'in_progress', 'done', 'cancel_requested', 'cancelled'];

/** Operator config; absent or `enabled: false` keeps the portal exactly edge-only. */
export function validateCloudConfig(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_PORTAL_CONFIG');
  if (input.enabled !== true) {
    if (input.enabled !== false && input.enabled !== undefined)
      throw new Error('INVALID_PORTAL_CONFIG');
    return null;
  }
  let origin;
  try {
    origin = new URL(input.apiOrigin);
  } catch {
    throw new Error('INVALID_PORTAL_CONFIG');
  }
  const host = origin.hostname.replace(/^\[|\]$/g, '');
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.origin !== String(input.apiOrigin).replace(/\/$/, '') ||
    // Internal network only: a docker service name or a private/loopback address.
    !(
      /^[a-z][a-z0-9-]{0,62}$/.test(host) ||
      (isIP(host) === 4 && /^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host))
    ) ||
    !UUID.test(input.branchId ?? '') ||
    Object.keys(input).some((k) => !['enabled', 'apiOrigin', 'branchId'].includes(k))
  )
    throw new Error('INVALID_PORTAL_CONFIG');
  return { apiOrigin: origin.origin, branchId: input.branchId.toLowerCase() };
}

/**
 * Encrypted screen cookie per page role. AES-256-GCM with a key derived from the portal secret
 * and bound to the role and path, so a prep cookie never opens assembly. The browser cannot
 * read the screen key; the cloud remains the authority on whether it is still valid.
 */
export function screenCookies({ key, mode, secure = true }) {
  if (!/^[a-f0-9]{64}$/.test(key ?? '') || !MODES.includes(mode))
    throw new Error('INVALID_PORTAL_CONFIG');
  const path = `/kitchen-live/${mode}/`,
    name = 'pickchick_cloud_screen_' + mode,
    aad = Buffer.from('pickchick-cloud-screen-v1:' + mode + ':' + path);
  const cipherKey = hkdfSync('sha256', Buffer.from(key, 'hex'), Buffer.alloc(0), aad, 32);
  const suffix = `; Path=${path}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  const valid = (v) =>
    isRecord(v) &&
    Object.keys(v).sort().join(',') === 'branchId,generation,role,screenId,screenKey' &&
    UUID.test(v.screenId) &&
    UUID.test(v.branchId) &&
    v.role === mode &&
    Number.isSafeInteger(v.generation) &&
    v.generation > 0 &&
    KEY.test(v.screenKey);
  return {
    name,
    clear: () => `${name}=; Max-Age=0${suffix}`,
    seal(value) {
      if (!valid(value)) throw new Error('INVALID_SCREEN');
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', cipherKey, iv);
      cipher.setAAD(aad);
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return `${name}=${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}; Max-Age=31536000${suffix}`;
    },
    read(header) {
      if (typeof header !== 'string' || header.length > 4096) return null;
      const values = header
        .split(';')
        .map((x) => x.trim())
        .filter((x) => x.startsWith(name + '='));
      if (values.length !== 1) return null;
      try {
        const text = values[0].slice(name.length + 1);
        if (!/^[A-Za-z0-9_-]{40,1500}$/.test(text)) return null;
        const bytes = Buffer.from(text, 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', cipherKey, bytes.subarray(0, 12));
        decipher.setAAD(aad);
        decipher.setAuthTag(bytes.subarray(12, 28));
        const value = JSON.parse(
          Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
        );
        return valid(value) ? value : null;
      } catch {
        return null;
      }
    },
  };
}
/** What a person types (case, spaces, dashes); the cloud does the real normalisation. */
export function pairingCode(raw) {
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || Object.keys(v).join(',') !== 'code' || typeof v.code !== 'string')
    return null;
  const code = v.code.trim();
  return code.length <= 40 && /^[0-9A-Za-z]{10}$/.test(code.replace(/[\s-]/g, '')) ? code : null;
}

/** The shared ErrorSchema shape: the renderer treats anything else as an unknown outcome. */
export function errorBody(code) {
  const keys = {
    INVALID_REQUEST: 'errors.invalid_request',
    UNAUTHORIZED: 'errors.unauthorized',
    NOT_FOUND: 'errors.not_found',
    CONFLICT: 'errors.conflict',
    RATE_LIMITED: 'errors.rate_limited',
    SERVICE_UNAVAILABLE: 'errors.service_unavailable',
  };
  return {
    code,
    message_key: keys[code],
    retryable: ['SERVICE_UNAVAILABLE', 'CONFLICT', 'RATE_LIMITED'].includes(code),
    trace_id: randomUUID(),
  };
}
const STATUS = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
};
export class CloudFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.status = STATUS[code];
  }
}
const fail = (code) => {
  throw new CloudFailure(code);
};

// ---- Re-shaping cloud responses into the edge fulfillment contract ----
const isRecord = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max, min = 0) =>
  typeof v === 'string' && v.length >= min && v.length <= max ? v : fail('SERVICE_UNAVAILABLE');
const id = (v) => (typeof v === 'string' && UUID.test(v) ? v : fail('SERVICE_UNAVAILABLE'));
const positive = (v, max = 2147483647) =>
  Number.isSafeInteger(v) && v >= 1 && v <= max ? v : fail('SERVICE_UNAVAILABLE');
const oneOf = (v, values) => (values.includes(v) ? v : fail('SERVICE_UNAVAILABLE'));
const date = (v) =>
  typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v))
    ? v
    : fail('SERVICE_UNAVAILABLE');
function displayNumber(v) {
  if (v === null) return null;
  if (Number.isSafeInteger(v) && v >= 1) return String(v);
  if (typeof v === 'string' && /^[1-9]\d{0,18}$/.test(v)) return v;
  return fail('SERVICE_UNAVAILABLE');
}
function names(v) {
  if (!isRecord(v)) fail('SERVICE_UNAVAILABLE');
  return { ru: text(v.ru, 250), kk: text(v.kk ?? '', 250) };
}
export function summaryView(v, branchId) {
  if (!isRecord(v) || id(v.branchId).toLowerCase() !== branchId) fail('SERVICE_UNAVAILABLE');
  if (v.fulfillmentOwner !== undefined && v.fulfillmentOwner !== 'cloud')
    fail('SERVICE_UNAVAILABLE');
  return {
    orderId: id(v.orderId),
    branchId: v.branchId,
    version: positive(v.version),
    state: oneOf(v.state, ORDER_STATES),
    displayNumber: displayNumber(v.displayNumber),
    routingVersion: positive(v.routingVersion),
    createdAt: date(v.createdAt),
    updatedAt: date(v.updatedAt),
    fulfillmentOwner: 'cloud',
  };
}
export function orderView(v, branchId) {
  if (!isRecord(v) || !Array.isArray(v.tasks) || v.tasks.length > 2000) fail('SERVICE_UNAVAILABLE');
  return {
    ...summaryView(v, branchId),
    assemblyStationId: id(v.assemblyStationId),
    channel: oneOf(v.channel, ['mobile', 'kiosk']),
    serviceMode: oneOf(v.serviceMode, ['takeaway', 'dine_in']),
    ...(v.kitchenComment === undefined || v.kitchenComment === null
      ? {}
      : { kitchenComment: text(v.kitchenComment, 60) }),
    tasks: v.tasks.map((t) => {
      if (!isRecord(t) || !isRecord(t.details) || !Array.isArray(t.details.modifiers))
        fail('SERVICE_UNAVAILABLE');
      const d = t.details;
      return {
        taskId: id(t.taskId ?? t.id),
        stationId: id(t.stationId),
        version: positive(t.version),
        state: oneOf(t.state, TASK_STATES),
        kind: oneOf(t.kind, ['prep', 'assembly_item']),
        details: {
          lineId: id(d.lineId),
          productId: text(d.productId, 160, 1),
          title: text(d.title, 250, 1),
          parentTitle: text(d.parentTitle ?? '', 250),
          description: text(d.description ?? '', 2000),
          quantity: positive(d.quantity, 1000000),
          modifiers: d.modifiers.slice(0, 100).map((m) => {
            if (!isRecord(m)) fail('SERVICE_UNAVAILABLE');
            return {
              groupId: text(m.groupId, 160, 1),
              groupTitle: names(m.groupTitle),
              optionId: text(m.optionId, 160, 1),
              label: names(m.label),
              quantity: positive(m.quantity, 1000000),
              linkedProductId:
                m.linkedProductId === null || m.linkedProductId === undefined
                  ? null
                  : text(m.linkedProductId, 160, 1),
            };
          }),
        },
      };
    }),
  };
}
function stationsView(v, branchId) {
  if (!isRecord(v) || !Array.isArray(v.items) || v.items.length > 100) fail('SERVICE_UNAVAILABLE');
  return {
    branchId,
    items: v.items
      .filter((s) => isRecord(s) && s.allowed === true)
      .map((s) => ({
        id: id(s.id),
        kind: oneOf(s.kind, ['prep', 'assembly']),
        name: text(s.name, 160, 1),
      })),
  };
}
function kitchenView(v, branchId) {
  if (!isRecord(v) || !Array.isArray(v.items) || v.items.length > 100) fail('SERVICE_UNAVAILABLE');
  return {
    items: v.items.map((o) => orderView(o, branchId)),
    nextAfterOrderId: v.nextAfterOrderId === null ? null : id(v.nextAfterOrderId),
  };
}
function displayView(v) {
  if (!isRecord(v) || !Array.isArray(v.items) || v.items.length > 100) fail('SERVICE_UNAVAILABLE');
  return {
    items: v.items.map((i) => {
      if (!isRecord(i)) fail('SERVICE_UNAVAILABLE');
      const name = typeof i.name === 'string' && i.name ? text(i.name, 14) : undefined;
      return {
        number: displayNumber(i.number) ?? fail('SERVICE_UNAVAILABLE'),
        ...(name ? { name } : {}),
        state: oneOf(i.state, ['preparing', 'ready']),
      };
    }),
    nextAfterNumber: v.nextAfterNumber === null ? null : displayNumber(v.nextAfterNumber),
  };
}
/** Exactly the renderer's kitchen action shapes; anything else never reaches the cloud. */
export function actionBody(raw) {
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return fail('INVALID_REQUEST');
  }
  if (!isRecord(v) || !Number.isSafeInteger(v.expectedVersion) || v.expectedVersion < 1)
    fail('INVALID_REQUEST');
  const keys = Object.keys(v).sort().join(',');
  if (['start_task', 'complete_task', 'confirm_stop'].includes(v.action)) {
    if (
      keys !== 'action,expectedTaskVersion,expectedVersion,taskId' ||
      !UUID.test(v.taskId ?? '') ||
      !Number.isSafeInteger(v.expectedTaskVersion) ||
      v.expectedTaskVersion < 1
    )
      fail('INVALID_REQUEST');
  } else if (['ready', 'handoff'].includes(v.action)) {
    if (keys !== 'action,expectedVersion') fail('INVALID_REQUEST');
  } else if (v.action === 'complete_station') {
    if (keys !== 'action,expectedVersion,stationId' || !UUID.test(v.stationId ?? ''))
      fail('INVALID_REQUEST');
  } else fail('INVALID_REQUEST');
  return v;
}

/** Bounded set of order ids the cloud reported: edge actions for them are refused. */
class OwnerIndex {
  constructor(limit = 10000) {
    this.limit = limit;
    this.ids = new Map();
  }
  add(orderId) {
    this.ids.delete(orderId);
    this.ids.set(orderId, true);
    while (this.ids.size > this.limit) this.ids.delete(this.ids.keys().next().value);
  }
  has(orderId) {
    return this.ids.has(orderId);
  }
}

export class CloudUpstream {
  constructor(config, { fetchImpl = fetch, timeoutMs = 8000, now = () => Date.now() } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.owners = new OwnerIndex();
    this.lastOk = 0;
    this.stations = new Map();
  }
  get online() {
    return this.now() - this.lastOk < 30000;
  }
  async call(screenKey, method, path, { body, idempotencyKey } = {}) {
    const headers = { Accept: 'application/json' };
    if (screenKey) headers.Authorization = 'Bearer ' + screenKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response;
    try {
      response = await this.fetch(this.config.apiOrigin + '/v1/kitchen' + path, {
        method,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return fail('SERVICE_UNAVAILABLE');
    }
    let payload;
    try {
      if (Number(response.headers.get('content-length') ?? 0) > 3 * 1024 * 1024) throw new Error();
      const raw = await response.text();
      if (raw.length > 3 * 1024 * 1024) throw new Error();
      payload = JSON.parse(raw);
    } catch {
      return fail('SERVICE_UNAVAILABLE');
    }
    // A reachable API counts as connected even when it rejects one request.
    if ([200, 400, 401, 404, 409].includes(response.status)) this.lastOk = this.now();
    if (response.status === 200) return payload;
    // 401: the screen key is revoked, rotated or unknown - the browser must pair again.
    if (response.status === 401) fail('UNAUTHORIZED');
    if (response.status === 400) fail('INVALID_REQUEST');
    if (response.status === 404) fail('NOT_FOUND');
    if (response.status === 409) fail('CONFLICT');
    // 403 (station outside the screen) and 5xx are an outage of the stream, not a sign-out.
    return fail('SERVICE_UNAVAILABLE');
  }
  /** One-time code -> screen key, server-side. Only this role and branch are accepted. */
  async pair(mode, code) {
    const out = await this.call(null, 'POST', '/pairing', { body: { pairingCode: code } });
    const screen = isRecord(out) && isRecord(out.screen) ? out.screen : null;
    if (
      !screen ||
      typeof out.screenKey !== 'string' ||
      !UUID.test(screen.screenId ?? '') ||
      !Number.isSafeInteger(screen.generation)
    )
      fail('SERVICE_UNAVAILABLE');
    // The code is spent either way; a code for another role/branch never binds this page.
    if (screen.role !== mode || String(screen.branchId).toLowerCase() !== this.config.branchId)
      fail('CONFLICT');
    return {
      screenId: screen.screenId.toLowerCase(),
      branchId: this.config.branchId,
      role: mode,
      generation: screen.generation,
      screenKey: out.screenKey,
    };
  }
  /** Live check of the cookie against the cloud (revocation, rotation, branch, role). */
  async me(screen) {
    const me = await this.call(screen.screenKey, 'GET', '/me');
    if (
      !isRecord(me) ||
      String(me.screenId).toLowerCase() !== screen.screenId ||
      String(me.branchId).toLowerCase() !== this.config.branchId ||
      me.role !== screen.role ||
      me.generation !== screen.generation ||
      !Array.isArray(me.stationIds)
    )
      fail('UNAUTHORIZED');
    const stationIds = me.stationIds.map((s) => id(s).toLowerCase());
    this.stations.set(screen.screenId + ':' + screen.generation, {
      at: this.now(),
      ids: new Set(stationIds),
    });
    return {
      screenId: screen.screenId,
      branchId: this.config.branchId,
      role: screen.role,
      stationIds,
    };
  }
  async screenStations(screen) {
    const cached = this.stations.get(screen.screenId + ':' + screen.generation);
    if (cached && this.now() - cached.at < 60000) return cached.ids;
    await this.me(screen);
    return this.stations.get(screen.screenId + ':' + screen.generation).ids;
  }
  /**
   * One browser request in edge shape -> one cloud call with this screen's key -> edge-shaped
   * JSON. `path` is relative to CLOUD_PREFIX and was validated with the edge allowlist.
   */
  async handle(screen, method, path, { body, idempotencyKey } = {}) {
    const branchId = this.config.branchId,
      mode = screen.role,
      key = screen.screenKey;
    const url = new URL(path, 'http://portal.invalid');
    const order = /^\/orders\/([0-9a-f-]{36})(\/actions)?$/i.exec(url.pathname);
    if (method === 'GET' && url.pathname === '/config')
      return { enabled: true, wholeTicketActions: true };
    if (method === 'GET' && url.pathname === '/stations') {
      if (mode === 'display') {
        await this.me(screen);
        return { branchId, items: [] };
      }
      return stationsView(await this.call(key, 'GET', '/stations'), branchId);
    }
    if (method === 'GET' && url.pathname === '/display') {
      const q = new globalThis.URLSearchParams({ limit: url.searchParams.get('limit') ?? '50' });
      const after = url.searchParams.get('afterNumber');
      if (after !== null) {
        // Cloud numbers end at 899: a later edge-only cursor has no cloud page left.
        if (BigInt(after) >= 899n) return { items: [], nextAfterNumber: null };
        q.set('afterNumber', after);
      }
      return displayView(await this.call(key, 'GET', '/display?' + q));
    }
    if (mode === 'display') fail('NOT_FOUND');
    if (method === 'GET' && url.pathname === '/kitchen') {
      const station = url.searchParams.get('stationId');
      // A station this screen does not serve has no cloud work; polling it would 403.
      if (station && !(await this.screenStations(screen)).has(station.toLowerCase()))
        return { items: [], nextAfterOrderId: null };
      const page = kitchenView(await this.call(key, 'GET', '/kitchen' + url.search), branchId);
      for (const item of page.items) this.owners.add(item.orderId.toLowerCase());
      return page;
    }
    if (method === 'GET' && order && !order[2]) {
      const view = orderView(
        await this.call(key, 'GET', '/orders/' + order[1] + url.search),
        branchId,
      );
      this.owners.add(view.orderId.toLowerCase());
      return view;
    }
    if (method === 'POST' && order && order[2]) {
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey ?? '')) fail('INVALID_REQUEST');
      const command = { orderId: order[1].toLowerCase(), ...actionBody(body) };
      const result = summaryView(
        await this.call(key, 'POST', '/commands', { body: command, idempotencyKey }),
        branchId,
      );
      if (result.orderId.toLowerCase() !== command.orderId) fail('SERVICE_UNAVAILABLE');
      this.owners.add(command.orderId);
      return result;
    }
    return fail('NOT_FOUND');
  }
}

/** Edge-equivalent path validation for `/cloud/v1/fulfillment/...` (same query allowlist). */
export function allowedCloud(method, rest) {
  return typeof rest === 'string' && allowed(method, base + rest);
}
