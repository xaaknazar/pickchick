import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { allowed } from '../../apps/kitchen/server.mjs';

/**
 * Second upstream of the kitchen portal (ADR-0014, S6): the cloud API `/v1/kitchen/*` for
 * kiosk/mobile orders owned by the cloud. The browser never sees a cloud key: it calls
 * `/kitchen-live/<mode>/cloud/v1/fulfillment/*` with its existing staff session, the portal
 * checks that session itself, picks the key of (branch, page role) from its private config and
 * forwards the request over the private VPS network. Responses are re-shaped into the edge
 * fulfillment contract the renderer already validates, so no cloud-only field reaches it.
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
    !input.keys ||
    typeof input.keys !== 'object' ||
    Object.keys(input.keys).sort().join(',') !== 'assembly,display,prep' ||
    !MODES.every((mode) => KEY.test(input.keys[mode] ?? '')) ||
    new Set(Object.values(input.keys)).size !== 3
  )
    throw new Error('INVALID_PORTAL_CONFIG');
  return {
    apiOrigin: origin.origin,
    branchId: input.branchId.toLowerCase(),
    keys: { ...input.keys },
  };
}

/** The shared ErrorSchema shape: the renderer treats anything else as an unknown outcome. */
export function errorBody(code) {
  const keys = {
    INVALID_REQUEST: 'errors.invalid_request',
    UNAUTHORIZED: 'errors.unauthorized',
    NOT_FOUND: 'errors.not_found',
    CONFLICT: 'errors.conflict',
    SERVICE_UNAVAILABLE: 'errors.service_unavailable',
  };
  return {
    code,
    message_key: keys[code],
    retryable: code === 'SERVICE_UNAVAILABLE' || code === 'CONFLICT',
    trace_id: randomUUID(),
  };
}
const STATUS = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
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

/**
 * Staff sessions verified by the edge (the only holder of staff accounts). A session the edge
 * confirmed stays usable for the cloud stream until its own expiry while the cashier is
 * unreachable; whenever the edge answers again it is re-checked (every 30 s), and a rejection
 * removes it at once. Nothing is persisted: after a portal restart the edge must confirm again.
 */
export class SessionCache {
  constructor({ recheckMs = 30000, limit = 512, now = () => Date.now() } = {}) {
    this.recheckMs = recheckMs;
    this.limit = limit;
    this.now = now;
    this.entries = new Map();
  }
  static key(parts) {
    return createHash('sha256').update(parts.join('\n')).digest('hex');
  }
  get(key) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry ?? null;
  }
  fresh(entry) {
    return this.now() - entry.checkedAt < this.recheckMs;
  }
  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { ...value, checkedAt: this.now() });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
  }
  delete(key) {
    this.entries.delete(key);
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
    this.stationsByMode = new Map();
  }
  get online() {
    return this.now() - this.lastOk < 30000;
  }
  async call(mode, method, path, { body, idempotencyKey } = {}) {
    const headers = {
      Accept: 'application/json',
      Authorization: 'Bearer ' + this.config.keys[mode],
    };
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
    // A reachable, authenticated API counts as connected even when it rejects one command.
    if ([200, 400, 404, 409].includes(response.status)) this.lastOk = this.now();
    if (response.status === 200) return payload;
    // Key revoked/foreign station (401/403) is a cloud-side configuration fault, never a reason
    // to sign the cook out of the edge session.
    if (response.status === 400) fail('INVALID_REQUEST');
    if (response.status === 404) fail('NOT_FOUND');
    if (response.status === 409) fail('CONFLICT');
    return fail('SERVICE_UNAVAILABLE');
  }
  /** Stations of the role key (from `/me`), cached for a minute. */
  async keyStations(mode) {
    const cached = this.stationsByMode.get(mode);
    if (cached && this.now() - cached.at < 60000) return cached.ids;
    const me = await this.call(mode, 'GET', '/me');
    if (
      !isRecord(me) ||
      String(me.branchId).toLowerCase() !== this.config.branchId ||
      me.role !== mode ||
      !Array.isArray(me.stationIds)
    )
      fail('SERVICE_UNAVAILABLE');
    const ids = new Set(me.stationIds.map((s) => id(s).toLowerCase()));
    this.stationsByMode.set(mode, { at: this.now(), ids });
    return ids;
  }
  /**
   * One browser request in edge shape -> one cloud call -> edge-shaped JSON.
   * `path` is relative to CLOUD_PREFIX and was validated with the edge allowlist.
   */
  async handle(mode, method, path, { body, idempotencyKey } = {}) {
    const branchId = this.config.branchId;
    const url = new URL(path, 'http://portal.invalid');
    const order = /^\/orders\/([0-9a-f-]{36})(\/actions)?$/i.exec(url.pathname);
    if (method === 'GET' && url.pathname === '/config')
      return { enabled: true, wholeTicketActions: true };
    if (method === 'GET' && url.pathname === '/stations') {
      if (mode === 'display') return { branchId, items: [] };
      return stationsView(await this.call(mode, 'GET', '/stations'), branchId);
    }
    if (method === 'GET' && url.pathname === '/display') {
      const q = new globalThis.URLSearchParams({ limit: url.searchParams.get('limit') ?? '50' });
      const after = url.searchParams.get('afterNumber');
      if (after !== null) {
        // Cloud numbers end at 899: a later edge-only cursor has no cloud page left.
        if (BigInt(after) >= 899n) return { items: [], nextAfterNumber: null };
        q.set('afterNumber', after);
      }
      return displayView(await this.call(mode, 'GET', '/display?' + q));
    }
    if (mode === 'display') fail('NOT_FOUND');
    if (method === 'GET' && url.pathname === '/kitchen') {
      const station = url.searchParams.get('stationId');
      // A station this role key does not serve has no cloud work; polling it would 403.
      if (station && !(await this.keyStations(mode)).has(station.toLowerCase()))
        return { items: [], nextAfterOrderId: null };
      const page = kitchenView(await this.call(mode, 'GET', '/kitchen' + url.search), branchId);
      for (const item of page.items) this.owners.add(item.orderId.toLowerCase());
      return page;
    }
    if (method === 'GET' && order && !order[2]) {
      const view = orderView(
        await this.call(mode, 'GET', '/orders/' + order[1] + url.search),
        branchId,
      );
      this.owners.add(view.orderId.toLowerCase());
      return view;
    }
    if (method === 'POST' && order && order[2]) {
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey ?? '')) fail('INVALID_REQUEST');
      const command = { orderId: order[1].toLowerCase(), ...actionBody(body) };
      const result = summaryView(
        await this.call(mode, 'POST', '/commands', { body: command, idempotencyKey }),
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
