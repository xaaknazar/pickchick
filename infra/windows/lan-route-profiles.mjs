/**
 * Route profiles of the branch LAN gateway (cutover CL-4, contracts section 5.5). The gateway
 * listens on one port (3443) and picks the profile by the client's IPv4:
 *
 * - `kitchen`: today's kitchen list plus the KDS routes of CR kds-5 and restore-review;
 * - `display`: the order board only (pairing, its terminal session, config and the board);
 * - `pos`: an exact mirror of the pos-desktop allowlist (apps/pos-desktop/protocol.mjs) plus its
 *   readiness probe, the content-addressed menu photos and the build it adds to GET pos/config.
 *
 * Self-contained on purpose: the Windows service copies this file next to
 * kitchen-lan-gateway.mjs, without the apps. tests/operations/kitchen-lan.test.mjs imports the
 * pos-desktop and kitchen app allowlists and proves the profiles equal them.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const base = '/edge/v1/fulfillment';

export const PROFILE_NAMES = Object.freeze(['kitchen', 'display', 'pos']);

/** The raw request target as the client sent it, only when it is already normalized. */
function target(raw) {
  if (typeof raw !== 'string' || /[%#\\]/.test(raw) || !raw.startsWith('/')) return null;
  const url = new URL(raw, 'https://127.0.0.1');
  return raw === url.pathname + url.search ? url : null;
}
/** Each allowed key at most once; values by the same rules as the kitchen app (server.mjs). */
function query(url, keys) {
  for (const [key, value] of url.searchParams) {
    if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1) return false;
    if (['stationId', 'afterOrderId'].includes(key) && !new RegExp(`^${UUID}$`, 'i').test(value))
      return false;
    if (key === 'limit' && (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 100)) return false;
    if (key === 'scope' && !['open', 'today'].includes(value)) return false;
    if (
      key === 'afterNumber' &&
      (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n)
    )
      return false;
  }
  return true;
}

/** Kitchen screens (prep, assembly and staff-login kitchen clients). */
export function allowedKitchenRoute(method, raw) {
  const url = target(raw);
  if (!url) return false;
  if (
    method === 'POST' &&
    [
      '/edge/v1/staff/login',
      '/edge/v1/staff/logout',
      '/edge/v1/staff/password-reset',
      '/edge/v1/terminals/pair',
    ].includes(raw)
  )
    return true;
  if (method === 'GET' && ['/edge/v1/session', '/edge/v1/terminals/session'].includes(raw))
    return true;
  if (!url.pathname.startsWith(base + '/')) return false;
  // Cutover KDS (contracts 5.4, CR kds-5): POST incidents and restore-review (C4/279).
  if (method === 'POST')
    return (
      !url.search &&
      (new RegExp(`^${base}/orders/${UUID}/(?:actions|restore-review)$`, 'i').test(url.pathname) ||
        url.pathname === base + '/incidents')
    );
  if (method !== 'GET') return false;
  let keys;
  if ([base + '/config', base + '/stations', base + '/layout'].includes(url.pathname)) keys = [];
  else if (url.pathname === base + '/kitchen') keys = ['stationId', 'afterOrderId', 'limit'];
  else if (url.pathname === base + '/display') keys = ['afterNumber', 'limit'];
  else if (url.pathname === base + '/kds/breading') keys = ['limit'];
  else if (url.pathname === base + '/incidents') {
    if (!url.searchParams.has('scope')) return false;
    keys = ['scope'];
  } else if (new RegExp(`^${base}/orders/${UUID}$`, 'i').test(url.pathname)) keys = ['stationId'];
  else return false;
  return query(url, keys);
}

/** The order board: a paired display terminal, never staff, kitchen queues or orders. */
export function allowedDisplayRoute(method, raw) {
  const url = target(raw);
  if (!url) return false;
  if (method === 'POST') return raw === '/edge/v1/terminals/pair';
  if (method !== 'GET') return false;
  if (['/edge/v1/terminals/session', base + '/config'].includes(raw)) return true;
  return url.pathname === base + '/display' && query(url, ['afterNumber', 'limit']);
}

/*
 * pos-desktop allowlist, copied literally from apps/pos-desktop/protocol.mjs (SALE_ROUTES,
 * SHIFT_FILTERED, readPath, writePath). A test compares the regular expressions, so a route
 * added to the desk without this profile fails the build instead of answering 404 on site.
 */
const POS_SALE_READS = [
  'pos/config',
  `pos/sales/${UUID}`,
  'pos/fiscal-receipts/pending',
  `cash-shifts/${UUID}/x-report`,
  `cash-shifts/${UUID}/z-report`,
];
const POS_SALE_WRITES = [
  'staff/approvals',
  'pos/sales',
  `pos/sales/${UUID}/void`,
  `pos/sales/${UUID}/refunds`,
  `pos/fiscal-receipts/${UUID}/record`,
];
export const POS_READ_PATH = new RegExp(
  `^/edge/v1/(session|menu|menu/version|ordering|cloud-link|orders|orders/${UUID}|cash-shifts|cash-shifts/current|cash-shifts/${UUID}|availability/stops(?:/${UUID})?|${POS_SALE_READS.join('|')})$`,
  'i',
);
export const POS_WRITE_PATH = new RegExp(
  `^/edge/v1/(staff/(login|pin|logout)|checkout/quotes|orders|orders/${UUID}/cancel|cash-shifts|cash-shifts/${UUID}/(?:close|movements)|ordering/(open|close)|availability/stops|${POS_SALE_WRITES.join('|')})$`,
  'i',
);
/** GET paths of the desk that may carry exactly one `?shift_id=<uuid>`. */
export const POS_SHIFT_FILTERED = Object.freeze(['orders', 'pos/fiscal-receipts/pending']);
/** Content-addressed menu photos the desk reads through its edge transport. */
export const POS_MEDIA_PATH = /^\/edge\/v1\/media\/[a-f0-9]{64}\.webp$/;
/** Same limits as pos-desktop: PIN checks 2 KiB, other commands 64 000 bytes, answers 4 MB. */
const POS_PIN_PATHS = ['/edge/v1/staff/login', '/edge/v1/staff/pin', '/edge/v1/staff/approvals'];
/** pos-desktop BODYLESS_WRITES: sent without a body (a body there is refused). */
export const POS_BODYLESS = Object.freeze(['/edge/v1/staff/logout']);
/** pos-desktop CLIENT_VERSION: the build the desk adds to GET pos/config (CR pos-2 1.1). */
export const POS_CLIENT_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

/** One cash desk (pos-desktop with edgeHost): its own requests only, nothing of the kitchen. */
export function allowedPosRoute(method, raw) {
  const url = target(raw);
  if (!url) return false;
  if (method === 'GET' && (raw === '/health/ready' || POS_MEDIA_PATH.test(raw))) return true;
  if (url.search && url.pathname === '/edge/v1/pos/config')
    return (
      method === 'GET' &&
      url.search.startsWith('?client_version=') &&
      POS_CLIENT_VERSION.test(url.search.slice('?client_version='.length))
    );
  if (url.search)
    return (
      method === 'GET' &&
      POS_SHIFT_FILTERED.some((path) => url.pathname === `/edge/v1/${path}`) &&
      new RegExp(`^\\?shift_id=${UUID}$`, 'i').test(url.search) &&
      POS_READ_PATH.test(url.pathname)
    );
  if (method === 'GET') return POS_READ_PATH.test(url.pathname);
  return method === 'POST' && POS_WRITE_PATH.test(url.pathname);
}

const KITCHEN_SMALL = ['/edge/v1/staff/login', '/edge/v1/staff/password-reset'];
/**
 * What the gateway does per profile. `headers`: request headers forwarded to the edge (nothing
 * else is); `bodyLimit(path)`: JSON POST body bytes; `bodyless`: POST paths sent without a body;
 * `responseLimit`: JSON answer bytes; `rawJson`: answer bytes are passed as received (validated
 * JSON) instead of re-serialized; `mediaLimit`: WebP bytes of POS_MEDIA_PATH (pos only).
 * `kitchen` is exactly the gateway before profiles.
 */
export const PROFILES = Object.freeze({
  kitchen: Object.freeze({
    allows: allowedKitchenRoute,
    headers: Object.freeze([
      'authorization',
      'x-staff-session-id',
      'x-terminal-id',
      'x-terminal-key',
      'idempotency-key',
    ]),
    bodyLimit: (path) =>
      KITCHEN_SMALL.includes(path) || path === '/edge/v1/terminals/pair' ? 2048 : 16384,
    bodyless: Object.freeze(['/edge/v1/staff/logout']),
    responseLimit: 3 * 1024 * 1024,
    rawJson: false,
    mediaLimit: 0,
  }),
  display: Object.freeze({
    allows: allowedDisplayRoute,
    headers: Object.freeze(['x-terminal-id', 'x-terminal-key']),
    bodyLimit: () => 2048,
    bodyless: Object.freeze([]),
    responseLimit: 3 * 1024 * 1024,
    rawJson: false,
    mediaLimit: 0,
  }),
  pos: Object.freeze({
    allows: allowedPosRoute,
    headers: Object.freeze(['authorization', 'x-staff-session-id', 'idempotency-key']),
    bodyLimit: (path) => (POS_PIN_PATHS.includes(path) ? 2048 : 64000),
    bodyless: POS_BODYLESS,
    responseLimit: 4000000,
    rawJson: true,
    mediaLimit: 1500000,
  }),
});
