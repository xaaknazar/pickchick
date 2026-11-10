import { loadStaffAccess, staffError } from './staff-auth.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URLSearchParams } from 'node:url';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
/** Raw photo upload: the only route with a non-JSON body and the only one above 300 KB. */
export const UPLOAD_ROUTE = new RegExp(`^/v1/admin/catalog/branches/${UUID}/assets$`, 'i');
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const JSON_MAX_BYTES = 300 * 1024;
/** Content-addressed catalog photo renditions, proxied same-origin so CSP img-src stays 'self'. */
export const MEDIA_ROUTE = /^\/v1\/media\/catalog\/[a-f0-9]{64}(?:\.(?:card|hero|thumb))?\.webp$/;
export const MEDIA_MAX_BYTES = 1500000;
/**
 * Lane bo-ui (audit F10): GET .../ops/orders - an Almaty date window, optionally a search
 * (number or a piece of the id), channel, cash desk, order and page; each key at most once.
 */
function ordersQuery(q, flags = '') {
  const one = (k) => q.getAll(k).length <= 1;
  const day = (v) => v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const value = (k, re) => q.get(k) === null || re.test(q.get(k));
  return (
    [...q.keys()].every((k) =>
      ['start_date', 'end_date', 'q', 'channel', 'terminal_id', 'sort', 'page'].includes(k),
    ) &&
    ['start_date', 'end_date', 'q', 'channel', 'terminal_id', 'sort', 'page'].every(one) &&
    day(q.get('start_date')) &&
    day(q.get('end_date')) &&
    value('q', /^[0-9a-fA-F№ -]{0,40}$/) &&
    value('channel', /^(mobile|kiosk|pos)$/) &&
    value('terminal_id', new RegExp(`^${UUID}$`, flags)) &&
    value('sort', /^(new|old|number|amount)$/) &&
    value('page', /^[1-9][0-9]{0,3}$/)
  );
}
function reportQuery(search) {
  if (search.length > 400) return false;
  const query = new URLSearchParams(search);
  const seen = new Set();
  for (const [key] of query) {
    if (!['period', 'start_date', 'end_date', 'shift_id'].includes(key) || seen.has(key))
      return false;
    seen.add(key);
  }
  const period = query.get('period') ?? 'day';
  if (!['day', 'today', 'yesterday', 'week', 'month', 'quarter', 'year', 'custom'].includes(period))
    return false;
  const shift = query.get('shift_id');
  if (shift !== null && !new RegExp(`^${UUID}$`, 'i').test(shift)) return false;
  const start = query.get('start_date'),
    end = query.get('end_date');
  if (period !== 'custom') return start === null && end === null;
  const validDate = (value) => {
    if (
      value === null ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      value < '2000-01-01' ||
      value > '2099-12-31'
    )
      return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  return (
    validDate(start) &&
    validDate(end) &&
    start <= end &&
    Date.parse(end) - Date.parse(start) <= 365 * 86400000
  );
}
export const allowed = (method, path) => {
  const [pathname, search, extra] = path.split('?');
  if (extra !== undefined || path.includes('#')) return false;
  if (new RegExp(`^/v1/admin/backoffice/branches/${UUID}/restore-reviews$`).test(pathname)) {
    if (method === 'POST') return search === undefined;
    if (method !== 'GET') return false;
    const q = new URLSearchParams(search ?? '');
    return (
      [...q.keys()].every((k) => k === 'after') &&
      q.getAll('after').length <= 1 &&
      (q.get('after') === null || new RegExp(`^${UUID}$`).test(q.get('after')))
    );
  }

  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/workforce$`).test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    return (
      [...q.keys()].length === 1 &&
      q.getAll('month').length === 1 &&
      /^\d{4}-\d{2}-01$/.test(q.get('month') ?? '')
    );
  }
  if (
    method === 'POST' &&
    search === undefined &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/workforce/commands$`).test(pathname)
  )
    return true;
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/finance$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    return (
      (search?.length ?? 0) <= 1600 &&
      [...q.keys()].every(
        (k) =>
          ['start_date', 'end_date', 'center', 'page', 'category', 'basis', 'search'].includes(k) &&
          q.getAll(k).length === 1,
      ) &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('start_date') ?? '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('end_date') ?? '') &&
      /^(all|restaurant|workshop|office|shared)$/.test(q.get('center') ?? 'all') &&
      /^\d{1,6}$/.test(q.get('page') ?? '0') &&
      /^(both|cash|pnl)$/.test(q.get('basis') ?? 'both') &&
      /^[a-z-]{0,60}$/.test(q.get('category') ?? '') &&
      (q.get('search')?.length ?? 0) <= 80
    );
  }
  if (
    method === 'POST' &&
    search === undefined &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/finance/commands$`, 'i').test(pathname)
  )
    return true;
  // Stage 2, lane rec: daily payment reconciliation (one business day per read).
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/reconciliation$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    return (
      [...q.keys()].length === 1 &&
      q.getAll('day').length === 1 &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('day') ?? '')
    );
  }
  if (
    method === 'POST' &&
    search === undefined &&
    new RegExp(
      `^/v1/admin/backoffice/branches/${UUID}/reconciliation/(?:preview|commands)$`,
      'i',
    ).test(pathname)
  )
    return true;
  // Cutover CC-6 (contracts 5.10): stock v2 report; cutover read views live under ops/<view>.
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/ops/stock$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    // Lane bo-ui2 step 4: view=balances and view=reorder take no dates; the API decides by its
    // flag (BACKOFFICE_STOCK_REPORTS_ENABLED) and answers INVALID_REQUEST without it.
    if ([...q.keys()].length === 1 && /^(balances|reorder)$/.test(q.get('view') ?? ''))
      return (search?.length ?? 0) <= 200 && q.getAll('view').length === 1;
    return (
      (search?.length ?? 0) <= 200 &&
      [...q.keys()].length === 3 &&
      ['view', 'start_date', 'end_date'].every((k) => q.getAll(k).length === 1) &&
      // Lane bo-ui stock P1 (step 8) adds variance and consumption; the API decides by its flag.
      /^(waste|movement|variance|consumption)$/.test(q.get('view') ?? '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('start_date') ?? '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('end_date') ?? '')
    );
  }
  // Cutover CC-7: sales report of an Almaty date window (the server checks the 92-day limit).
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/ops/sales$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    return (
      (search?.length ?? 0) <= 200 &&
      [...q.keys()].length === 2 &&
      ['start_date', 'end_date'].every((k) => q.getAll(k).length === 1) &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('start_date') ?? '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('end_date') ?? '')
    );
  }
  // Lane bo-ui «Касса» (BACKOFFICE_POS_DAY_ENABLED): one Almaty day, optionally one cash desk.
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/ops/pos-day$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    const keys = [...q.keys()];
    const terminal = q.get('terminal_id');
    return (
      (search?.length ?? 0) <= 200 &&
      keys.every((k) => k === 'date' || k === 'terminal_id') &&
      q.getAll('date').length === 1 &&
      q.getAll('terminal_id').length <= 1 &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') ?? '') &&
      (terminal === null || new RegExp(`^${UUID}$`, 'i').test(terminal))
    );
  }
  // Lane bo-ui (audit F10): the order registry of an Almaty date window, searched, sorted and
  // paged on the server (BACKOFFICE_POS_DAY_ENABLED).
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/ops/orders$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    return (search?.length ?? 0) <= 300 && ordersQuery(q, 'i');
  }
  // Lane bo-ui automatic consumption: the menu-stock links (no query) and the queue of one
  // Almaty day or of every day, optionally one state.
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/ops/menu-links$`, 'i').test(pathname)
  )
    return search === undefined;
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/ops/consumption$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    const state = q.get('state');
    const date = q.get('date');
    return (
      (search?.length ?? 0) <= 200 &&
      [...q.keys()].every((k) => k === 'state' || k === 'date') &&
      q.getAll('state').length <= 1 &&
      q.getAll('date').length <= 1 &&
      (state === null ||
        /^(pending|previewed|applied|blocked|skipped|not_required)$/.test(state)) &&
      (date === null || /^\d{4}-\d{2}-\d{2}$/.test(date))
    );
  }
  // Lane bo-ui step 6: the manager shift of one Almaty day (or today) and the cash desk roster.
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/ops/manager-shifts$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    const date = q.get('date');
    return (
      (search?.length ?? 0) <= 200 &&
      [...q.keys()].every((k) => k === 'date') &&
      q.getAll('date').length <= 1 &&
      (date === null || /^\d{4}-\d{2}-\d{2}$/.test(date))
    );
  }
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/ops/staff-roster$`, 'i').test(pathname)
  )
    return search === undefined;
  // Lane bo-ui step 7: the discount editor, every discount or one with its revisions.
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/ops/discounts$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    const id = q.get('id');
    return (
      (search?.length ?? 0) <= 200 &&
      [...q.keys()].every((k) => k === 'id') &&
      q.getAll('id').length <= 1 &&
      (id === null || new RegExp(`^${UUID}$`, 'i').test(id))
    );
  }
  // Lane bo-ui2 step 2 (BACKOFFICE_SUPPLY_ENABLED): the suppliers, one with its prices, and the
  // supply requests of an Almaty window (the server checks the 92 days), optionally one state,
  // one kind and one request.
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/ops/suppliers$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    const id = q.get('id');
    return (
      (search?.length ?? 0) <= 200 &&
      [...q.keys()].every((k) => k === 'id') &&
      q.getAll('id').length <= 1 &&
      (id === null || new RegExp(`^${UUID}$`, 'i').test(id))
    );
  }
  // Lane bo-ui2 step 3: the price imports of the branch, or one of them with its report.
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/ops/supplier-imports$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    const id = q.get('id');
    return (
      (search?.length ?? 0) <= 200 &&
      [...q.keys()].every((k) => k === 'id') &&
      q.getAll('id').length <= 1 &&
      (id === null || new RegExp(`^${UUID}$`, 'i').test(id))
    );
  }
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/ops/supply-requests$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    const keys = ['start_date', 'end_date', 'state', 'kind', 'id'];
    const value = (k, re) => q.get(k) === null || re.test(q.get(k));
    return (
      (search?.length ?? 0) <= 200 &&
      [...q.keys()].every((k) => keys.includes(k)) &&
      keys.every((k) => q.getAll(k).length <= 1) &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('start_date') ?? '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('end_date') ?? '') &&
      value('state', /^(draft|submitted|received|cancelled)$/) &&
      value('kind', /^(central_kitchen|bakery|household|supplier)$/) &&
      value('id', new RegExp(`^${UUID}$`, 'i'))
    );
  }
  // Lane bo-ui2 step 5 (BACKOFFICE_STAFF_ASSIGNMENT_ENABLED): the staff assignment of one
  // business day (or today), or the intervals of a window (the server checks the 92 days),
  // optionally of one employee or one station.
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/ops/staff-assignments$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    const keys = ['date', 'start_date', 'end_date', 'employee_id', 'station_code'];
    const day = (k) => q.get(k) === null || /^\d{4}-\d{2}-\d{2}$/.test(q.get(k));
    const range = q.has('start_date') || q.has('end_date');
    return (
      (search?.length ?? 0) <= 200 &&
      [...q.keys()].every((k) => keys.includes(k)) &&
      keys.every((k) => q.getAll(k).length <= 1) &&
      ['date', 'start_date', 'end_date'].every(day) &&
      (range
        ? !q.has('date') && q.has('start_date') && q.has('end_date')
        : !q.has('employee_id') && !q.has('station_code')) &&
      (q.get('employee_id') === null || new RegExp(`^${UUID}$`, 'i').test(q.get('employee_id'))) &&
      (q.get('station_code') === null || /^[a-z][a-z0-9_]{1,39}$/.test(q.get('station_code')))
    );
  }
  if (method === 'GET' && new RegExp(`^/v1/admin/backoffice/branches/${UUID}$`, 'i').test(pathname))
    return reportQuery(search ?? '');
  if (search !== undefined) return false;
  // Audit 19.10, finding 4.3: kiosk payment incidents (list for manager/analyst, accept for the
  // branch manager only; the API keeps the role check, the 15-minute guard and the audit).
  if (
    (method === 'GET' || method === 'POST') &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/kiosk-payment-incidents$`, 'i').test(
      pathname,
    )
  )
    return true;
  if (
    method === 'GET' &&
    new RegExp(
      `^/v1/admin/backoffice/branches/${UUID}/devices(?:/(?:${UUID}|kitchen-password-reset)/events|/${UUID}/inventory-events)?$`,
      'i',
    ).test(pathname)
  )
    return true;
  if (
    method === 'POST' &&
    new RegExp(
      `^/v1/admin/backoffice/branches/${UUID}/devices/(?:pairing-codes|revoke|kitchen-password-reset|inventory)$`,
      'i',
    ).test(pathname)
  )
    return true;
  if (
    (method === 'GET' || method === 'POST') &&
    (UPLOAD_ROUTE.test(pathname) ||
      new RegExp(`^/v1/admin/backoffice/branches/${UUID}/stops$`, 'i').test(pathname))
  )
    return true;
  return (
    (method === 'GET' &&
      new RegExp(`^/v1/admin/backoffice/branches/${UUID}/orders/${UUID}$`, 'i').test(pathname)) ||
    (method === 'POST' &&
      new RegExp(`^/v1/admin/backoffice/branches/${UUID}/commands$`, 'i').test(pathname)) ||
    (method === 'GET'
      ? new RegExp(`^/v1/admin/catalog/branches(?:/${UUID})?$`, 'i').test(pathname)
      : method === 'PUT'
        ? new RegExp(`^/v1/admin/catalog/branches/${UUID}/draft$`, 'i').test(pathname)
        : method === 'POST' &&
          new RegExp(`^/v1/admin/catalog/branches/${UUID}/(?:draft/seed|publish)$`, 'i').test(
            pathname,
          ))
  );
};
const assets = new Map([
  ['/workspace.css', ['workspace.css', 'text/css; charset=utf-8']],
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ...['styles', 'fonts', 'workforce', 'inventory', 'device-center', 'audit-fixes'].map((n) => [
    `/${n}.css`,
    [`${n}.css`, 'text/css; charset=utf-8'],
  ]),
  ...[
    'app',
    'api',
    'model',
    'domain',
    'dom',
    'editor',
    'operations',
    'operations-model',
    'inventory',
    'inventory-model',
    'devices-model',
    'components/DeviceAccessView',
    'kiosk-incidents-model',
    'components/KioskIncidentsView',
    'reconciliation-model',
    'components/ReconciliationView',
    'finance',
    'finance-model',
    'workforce',
    'workforce-model',
    'finance-report',
    'finance-charts',
    'sales-report',
    'sales-report-model',
    // Lane bo-ui «Касса» (shown only while the API reports capabilities.pos_day).
    'pos-day',
    'pos-day-model',
    'orders-model',
    // Lane bo-ui audit fixes (active only while the API reports them).
    'ui-fixes',
    'dialog-guard',
    'audit-model',
    // Lane bo-ui step 5 «Списание по продажам» (shown only with capabilities.stock_p1).
    'autoconsume',
    'autoconsume-model',
    // Lane bo-ui step 6 (shown only with capabilities.manager_shifts / staff_positions).
    'manager-shift',
    'manager-shift-model',
    'staff-positions-model',
    // Lane bo-ui step 7 «Скидки» (shown only with capabilities.discounts).
    'discounts',
    'discounts-model',
    // Lane bo-ui2 step 2 «Закупки» (shown only with capabilities.supply).
    'supply',
    'supply-model',
    // Lane bo-ui2 step 4 stock reports (used only with capabilities.stock_reports).
    'stock-reports-model',
    // Lane bo-ui2 step 5 «Расстановка» (shown only with capabilities.staff_assignment).
    'assignment',
    'assignment-model',
    // Cutover Аг4: «Внешнее меню» of «Меню и цены» (aggregator prices).
    'external-menu',
  ].map((n) => [`/${n}.js`, [`${n}.js`, 'text/javascript; charset=utf-8']]),
  ...['logo.png', 'shot.jpg', ...Array.from({ length: 24 }, (_, i) => `i${i}.jpg`)].map((n) => [
    `/assets/${n}`,
    [`assets/${n}`, n.endsWith('.png') ? 'image/png' : 'image/jpeg'],
  ]),
  ...[
    'fccca918fea4',
    'aebf2ab4a4ce',
    'a2e2c783ca6f',
    '46dd4cdca58c',
    '8db00ff46c67',
    'a28eb6d3ccb5',
    'c940764593d0',
  ].map((n) => [`/assets/fonts/inter-${n}.woff2`, [`assets/fonts/inter-${n}.woff2`, 'font/woff2']]),
]);
const security = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
/** Local operator UI. Only the configured loopback API and catalog routes are reachable. */
export function createBackofficeServer({
  apiPort = 3100,
  apiHost = '127.0.0.1',
  staffAccess = null,
  assetDir = new URL('dist/', import.meta.url),
  timeoutMs = 12000,
  staticPrefix = '',
} = {}) {
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535)
    throw new Error('Invalid API port');
  if (!['127.0.0.1', 'pickchick-staging-api-1'].includes(apiHost))
    throw new Error('Invalid API host');
  if (!['', '/backoffice'].includes(staticPrefix)) throw new Error('Invalid static prefix');
  return createServer(
    { requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 },
    async (req, res) => {
      const send = (status, payload) => {
        res.writeHead(status, { ...security, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(staffAccess ? staffError(payload, status) : payload));
      };
      let access;
      if (staffAccess) {
        try {
          access = await staffAccess(req, res, send);
        } catch {
          if (!res.headersSent) send(503, { code: 'SERVICE_UNAVAILABLE' });
          else res.destroy();
          return;
        }
        if (access === false) return;
      }
      const expected = `127.0.0.1:${req.socket.localPort}`;
      if (
        !staffAccess &&
        (req.headers.host !== expected ||
          (req.headers.origin && req.headers.origin !== `http://${expected}`) ||
          req.headers['sec-fetch-site'] === 'cross-site')
      ) {
        send(403, { code: 'FORBIDDEN' });
        return;
      }
      const path = access?.path ?? req.url ?? '';
      if (path.startsWith('/v1/media/')) {
        // Public, immutable photo bytes: no credential is forwarded upstream.
        if (req.method !== 'GET' || !MEDIA_ROUTE.test(path)) {
          send(404, { code: 'NOT_FOUND' });
          return;
        }
        try {
          const response = await fetch(`http://${apiHost}:${apiPort}${path}`, {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (
            response.status !== 200 ||
            response.headers.get('content-type') !== 'image/webp' ||
            Number(response.headers.get('content-length') ?? 0) > MEDIA_MAX_BYTES
          ) {
            await response.body?.cancel().catch(() => undefined);
            send(404, { code: 'NOT_FOUND' });
            return;
          }
          const chunks = [];
          let size = 0;
          for await (const chunk of response.body ?? []) {
            size += chunk.length;
            if (size > MEDIA_MAX_BYTES) {
              send(502, { code: 'INVALID_RESPONSE' });
              return;
            }
            chunks.push(chunk);
          }
          const bytes = Buffer.concat(chunks);
          res.writeHead(200, {
            ...security,
            'Cache-Control': 'private, max-age=31536000, immutable',
            'Content-Type': 'image/webp',
            'Content-Length': bytes.length,
          });
          res.end(bytes);
        } catch {
          if (!res.headersSent) send(504, { code: 'NETWORK' });
          else res.destroy();
        }
        return;
      }
      if (path.startsWith('/v1/')) {
        if (!allowed(req.method, path)) {
          send(404, { code: 'NOT_FOUND' });
          return;
        }
        const auth = staffAccess ? access?.authorization : req.headers.authorization;
        if (typeof auth !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(auth)) {
          send(401, { code: 'UNAUTHORIZED' });
          return;
        }
        let body;
        const headers = { Authorization: auth };
        const upload = req.method === 'POST' && UPLOAD_ROUTE.test(path);
        if (upload) {
          const type = req.headers['content-type'];
          const key = req.headers['idempotency-key'];
          if (!UPLOAD_TYPES.includes(type)) {
            send(415, { code: 'INVALID_REQUEST' });
            return;
          }
          if (typeof key !== 'string' || !new RegExp(`^${UUID}$`, 'i').test(key)) {
            send(400, { code: 'INVALID_REQUEST' });
            return;
          }
          if (Number(req.headers['content-length'] ?? 0) > UPLOAD_MAX_BYTES) {
            send(413, { code: 'PAYLOAD_TOO_LARGE' });
            req.resume();
            return;
          }
          const chunks = [];
          let size = 0;
          try {
            for await (const chunk of req) {
              size += chunk.length;
              if (size > UPLOAD_MAX_BYTES) {
                send(413, { code: 'PAYLOAD_TOO_LARGE' });
                return;
              }
              chunks.push(chunk);
            }
          } catch {
            if (!res.destroyed) send(400, { code: 'INVALID_REQUEST' });
            return;
          }
          if (!size) {
            send(400, { code: 'INVALID_REQUEST' });
            return;
          }
          body = Buffer.concat(chunks);
          headers['Content-Type'] = type;
          headers['Idempotency-Key'] = key.toLowerCase();
        } else if (req.method !== 'GET') {
          if (req.headers['content-type'] !== 'application/json') {
            send(415, { code: 'INVALID_REQUEST' });
            return;
          }
          const chunks = [];
          let size = 0;
          try {
            for await (const chunk of req) {
              size += chunk.length;
              if (size > JSON_MAX_BYTES) {
                send(413, { code: 'INVALID_REQUEST' });
                return;
              }
              chunks.push(chunk);
            }
            body = Buffer.concat(chunks).toString('utf8');
            JSON.parse(body);
          } catch {
            if (!res.destroyed) send(400, { code: 'INVALID_REQUEST' });
            return;
          }
          headers['Content-Type'] = 'application/json';
        }
        try {
          const response = await fetch(`http://${apiHost}:${apiPort}${path}`, {
            method: req.method,
            headers,
            redirect: 'error',
            // Re-encoding a large photo takes longer than a JSON command.
            signal: AbortSignal.timeout(upload ? Math.max(timeoutMs, 30000) : timeoutMs),
            ...(body === undefined ? {} : { body }),
          });
          const chunks = [];
          let size = 0;
          // A reconciliation day lists every matched operation for the accountant's export; a
          // stock report lists up to 200 documents with all their lines; a sales report lists up
          // to 200 refunds and 200 staff meals with 92 days; a cashier day («Касса») up to 2200
          // receipts with their items, tenders, refunds and Webkassa receipts; the discounts up to
          // 200 with their catalog scope and the catalog names.
          const limit = /\/ops\/pos-day\?/.test(path)
            ? 8 * 1024 * 1024
            : /\/(?:reconciliation|ops\/stock|ops\/sales)\?/.test(path) ||
                /\/ops\/discounts(?:\?|$)/.test(path)
              ? 4 * 1024 * 1024
              : 1024 * 1024;
          for await (const chunk of response.body ?? []) {
            size += chunk.length;
            if (size > limit) {
              send(502, { code: 'INVALID_RESPONSE' });
              return;
            }
            chunks.push(chunk);
          }
          res.writeHead(response.status, {
            ...security,
            'Content-Type': 'application/json; charset=utf-8',
          });
          res.end(Buffer.concat(chunks));
        } catch {
          send(504, { code: 'NETWORK' });
        }
        return;
      }
      if (req.method !== 'GET') {
        send(405, { code: 'INVALID_REQUEST' });
        return;
      }
      if (staticPrefix && path === staticPrefix) {
        res.writeHead(308, { ...security, Location: staticPrefix + '/' });
        res.end();
        return;
      }
      const assetPath = staticPrefix
        ? path.startsWith(staticPrefix + '/')
          ? path.slice(staticPrefix.length)
          : ''
        : path;
      const asset = assets.get(assetPath);
      if (!asset) {
        send(404, { code: 'NOT_FOUND' });
        return;
      }
      try {
        const data = await readFile(new URL(asset[0], assetDir));
        res.writeHead(200, { ...security, 'Content-Type': asset[1] });
        res.end(data);
      } catch {
        if (!res.headersSent) send(503, { code: 'ASSETS_NOT_BUILT' });
        else res.destroy();
      }
    },
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.BACKOFFICE_PORT ?? 4177),
    apiPort = Number(process.env.BACKOFFICE_API_PORT ?? process.env.API_PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid backoffice port');
  // Per-person accounts file (private permissions checked before it is read).
  const privateFile = process.env.BACKOFFICE_STAFF_FILE;
  const staffAccess = privateFile ? await loadStaffAccess(privateFile) : null;
  createBackofficeServer({
    apiPort,
    staffAccess,
    apiHost: staffAccess ? 'pickchick-staging-api-1' : '127.0.0.1',
    staticPrefix: staffAccess ? '/backoffice' : '',
  }).listen(port, staffAccess ? '0.0.0.0' : '127.0.0.1', () =>
    console.log(`PickChick Backoffice: http://127.0.0.1:${port}`),
  );
}
