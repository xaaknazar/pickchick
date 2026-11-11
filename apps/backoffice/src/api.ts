export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
    /** Precise server reason (`error.code` of the reason envelope) or a client-side context. */
    public readonly reason?: string,
  ) {
    super(code);
  }
}
export type Request = { method?: 'GET' | 'PUT' | 'POST'; body?: unknown };
export type Transport = (path: string, token: string, options?: Request) => Promise<unknown>;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
/** Lane bo-ui (audit F10): GET .../ops/orders, the order registry on the server. */
function ordersQuery(q: URLSearchParams) {
  const keys = ['start_date', 'end_date', 'q', 'channel', 'terminal_id', 'sort', 'page'];
  const day = (v: string | null) => v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const value = (k: string, re: RegExp) => q.get(k) === null || re.test(q.get(k) ?? '');
  return (
    [...q.keys()].every((k) => keys.includes(k)) &&
    keys.every((k) => q.getAll(k).length <= 1) &&
    day(q.get('start_date')) &&
    day(q.get('end_date')) &&
    value('q', /^[0-9a-fA-F№ -]{0,40}$/) &&
    value('channel', /^(mobile|kiosk|pos)$/) &&
    value('terminal_id', new RegExp(`^${UUID}$`)) &&
    value('sort', /^(new|old|number|amount)$/) &&
    value('page', /^[1-9][0-9]{0,3}$/)
  );
}
function reportQuery(search: string) {
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
  const validDate = (value: string | null): value is string => {
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
/**
 * «Расходы» (cloud077, BACKOFFICE_EXPENSES_ENABLED): organization-wide, not under a branch. GET
 * reads with a short plain query, POST writes without one; the API checks every value.
 */
export function expensesPath(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET'): boolean {
  const [pathname = '', search, extra] = path.split('?');
  if (extra !== undefined || path.includes('#')) return false;
  if (method === 'GET')
    return (
      /^operations\/expenses\/(meta|entry|journal|pnl|analytics|log|access)$/.test(pathname) &&
      (search === undefined || (search.length <= 600 && /^[A-Za-z0-9_=&%.,:+-]*$/.test(search)))
    );
  return (
    method === 'POST' &&
    search === undefined &&
    new RegExp(
      `^operations/expenses/(cell|row|cash|access|entries(/${UUID}(/delete)?)?|months/\\d{4}-\\d{2}/(close|open))$`,
    ).test(pathname)
  );
}
export function allowedPath(path: string): boolean {
  if (/^branches(?:\/[a-f0-9-]{36}(?:\/(?:draft|draft\/seed|publish|assets))?)?$/.test(path))
    return true;
  const [pathname = '', search, extra] = path.split('?');
  if (extra !== undefined || path.includes('#')) return false;
  if (new RegExp(`^operations/branches/${UUID}/restore-reviews$`).test(pathname)) {
    const q = new URLSearchParams(search ?? '');
    return (
      [...q.keys()].every((k) => k === 'after') &&
      q.getAll('after').length <= 1 &&
      (q.get('after') === null || new RegExp(`^${UUID}$`).test(q.get('after')!))
    );
  }
  if (new RegExp(`^operations/branches/${UUID}/workforce$`).test(pathname)) {
    const q = new URLSearchParams(search ?? '');
    return (
      [...q.keys()].length === 1 &&
      q.getAll('month').length === 1 &&
      /^\d{4}-\d{2}-01$/.test(q.get('month') ?? '')
    );
  }
  if (
    search === undefined &&
    new RegExp(`^operations/branches/${UUID}/workforce/commands$`).test(pathname)
  )
    return true;
  if (new RegExp(`^operations/branches/${UUID}/finance$`).test(pathname)) {
    const q = new URLSearchParams(search ?? '');
    return (
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
    search === undefined &&
    new RegExp(`^operations/branches/${UUID}/finance/commands$`).test(pathname)
  )
    return true;
  if (new RegExp(`^operations/branches/${UUID}/reconciliation$`).test(pathname)) {
    const q = new URLSearchParams(search ?? '');
    return (
      [...q.keys()].length === 1 &&
      q.getAll('day').length === 1 &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('day') ?? '')
    );
  }
  if (
    search === undefined &&
    new RegExp(`^operations/branches/${UUID}/reconciliation/(?:preview|commands)$`).test(pathname)
  )
    return true;
  // Cutover CC-6: stock v2 report; cutover read views live under ops/<view>.
  if (new RegExp(`^operations/branches/${UUID}/ops/stock$`).test(pathname)) {
    const q = new URLSearchParams(search ?? '');
    // Lane bo-ui2 step 4: the balances and the reorder hint take no dates (the API decides by
    // its flag BACKOFFICE_STOCK_REPORTS_ENABLED).
    if ([...q.keys()].length === 1 && /^(balances|reorder)$/.test(q.get('view') ?? ''))
      return q.getAll('view').length === 1;
    return (
      [...q.keys()].length === 3 &&
      ['view', 'start_date', 'end_date'].every((k) => q.getAll(k).length === 1) &&
      /^(waste|movement|variance|consumption)$/.test(q.get('view') ?? '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('start_date') ?? '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('end_date') ?? '')
    );
  }
  // Cutover CC-7: sales report of an Almaty date window.
  if (new RegExp(`^operations/branches/${UUID}/ops/sales$`).test(pathname)) {
    const q = new URLSearchParams(search ?? '');
    return (
      [...q.keys()].length === 2 &&
      ['start_date', 'end_date'].every((k) => q.getAll(k).length === 1) &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('start_date') ?? '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('end_date') ?? '')
    );
  }
  // Lane bo-ui «Касса»: one Almaty day, optionally one cash desk.
  if (new RegExp(`^operations/branches/${UUID}/ops/pos-day$`).test(pathname)) {
    const q = new URLSearchParams(search ?? '');
    const terminal = q.get('terminal_id');
    return (
      [...q.keys()].every((k) => k === 'date' || k === 'terminal_id') &&
      q.getAll('date').length === 1 &&
      q.getAll('terminal_id').length <= 1 &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') ?? '') &&
      (terminal === null || new RegExp(`^${UUID}$`).test(terminal))
    );
  }
  // Lane bo-ui (audit F10): the order registry of a date window on the server.
  if (new RegExp(`^operations/branches/${UUID}/ops/orders$`).test(pathname))
    return (search?.length ?? 0) <= 300 && ordersQuery(new URLSearchParams(search ?? ''));
  // Lane bo-ui automatic consumption: menu-stock links and the consumption queue.
  if (new RegExp(`^operations/branches/${UUID}/ops/menu-links$`).test(pathname))
    return search === undefined;
  if (new RegExp(`^operations/branches/${UUID}/ops/consumption$`).test(pathname)) {
    const q = new URLSearchParams(search ?? '');
    const state = q.get('state');
    const date = q.get('date');
    return (
      [...q.keys()].every((k) => k === 'state' || k === 'date') &&
      q.getAll('state').length <= 1 &&
      q.getAll('date').length <= 1 &&
      (state === null ||
        /^(pending|previewed|applied|blocked|skipped|not_required)$/.test(state)) &&
      (date === null || /^\d{4}-\d{2}-\d{2}$/.test(date))
    );
  }
  // Lane bo-ui step 6: the manager shift of one Almaty day and the roster of the cash desk.
  if (new RegExp(`^operations/branches/${UUID}/ops/manager-shifts$`).test(pathname)) {
    const q = new URLSearchParams(search ?? '');
    return (
      [...q.keys()].every((k) => k === 'date') &&
      q.getAll('date').length <= 1 &&
      (q.get('date') === null || /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') ?? ''))
    );
  }
  if (new RegExp(`^operations/branches/${UUID}/ops/staff-roster$`).test(pathname))
    return search === undefined;
  // Lane bo-ui step 7: the discounts, or one discount with its revisions.
  if (new RegExp(`^operations/branches/${UUID}/ops/discounts$`).test(pathname)) {
    const q = new URLSearchParams(search ?? '');
    const id = q.get('id');
    return (
      [...q.keys()].every((k) => k === 'id') &&
      q.getAll('id').length <= 1 &&
      (id === null || new RegExp(`^${UUID}$`).test(id))
    );
  }
  // Lane bo-ui2 step 2: the suppliers (one with its prices) and the supply requests of a window.
  if (new RegExp(`^operations/branches/${UUID}/ops/suppliers$`).test(pathname)) {
    const q = new URLSearchParams(search ?? '');
    const id = q.get('id');
    return (
      [...q.keys()].every((k) => k === 'id') &&
      q.getAll('id').length <= 1 &&
      (id === null || new RegExp(`^${UUID}$`).test(id))
    );
  }
  // Lane bo-ui2 step 3: the price imports, or one of them with its report.
  if (new RegExp(`^operations/branches/${UUID}/ops/supplier-imports$`).test(pathname)) {
    const q = new URLSearchParams(search ?? '');
    const id = q.get('id');
    return (
      [...q.keys()].every((k) => k === 'id') &&
      q.getAll('id').length <= 1 &&
      (id === null || new RegExp(`^${UUID}$`).test(id))
    );
  }
  if (new RegExp(`^operations/branches/${UUID}/ops/supply-requests$`).test(pathname)) {
    const q = new URLSearchParams(search ?? '');
    const keys = ['start_date', 'end_date', 'state', 'kind', 'id'];
    const value = (k: string, re: RegExp) => q.get(k) === null || re.test(q.get(k) ?? '');
    return (
      (search?.length ?? 0) <= 200 &&
      [...q.keys()].every((k) => keys.includes(k)) &&
      keys.every((k) => q.getAll(k).length <= 1) &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('start_date') ?? '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('end_date') ?? '') &&
      value('state', /^(draft|submitted|received|cancelled)$/) &&
      value('kind', /^(central_kitchen|bakery|household|supplier)$/) &&
      value('id', new RegExp(`^${UUID}$`))
    );
  }
  // Lane bo-ui2 step 5: the staff assignment of one business day (or today), or the intervals of
  // a window (the server checks the 92 days), optionally of one employee or one station.
  if (new RegExp(`^operations/branches/${UUID}/ops/staff-assignments$`).test(pathname))
    return (search?.length ?? 0) <= 200 && assignmentQuery(new URLSearchParams(search ?? ''));
  if (new RegExp(`^operations/branches/${UUID}$`).test(pathname)) return reportQuery(search ?? '');
  return (
    search === undefined &&
    new RegExp(
      `^operations/branches/${UUID}/(?:commands|stops|kiosk-payment-incidents|orders/${UUID}|devices(?:/(?:inventory|pairing-codes|revoke|kitchen-password-reset(?:/events)?|${UUID}/(?:events|inventory-events)))?)$`,
    ).test(pathname)
  );
}
/** The query of GET .../ops/staff-assignments: a day, or a window with optional filters. */
function assignmentQuery(q: URLSearchParams) {
  const keys = ['date', 'start_date', 'end_date', 'employee_id', 'station_code'];
  const day = (k: string) => q.get(k) === null || /^\d{4}-\d{2}-\d{2}$/.test(q.get(k) ?? '');
  if (![...q.keys()].every((k) => keys.includes(k)) || keys.some((k) => q.getAll(k).length > 1))
    return false;
  const range = q.has('start_date') || q.has('end_date');
  return (
    ['date', 'start_date', 'end_date'].every(day) &&
    (range
      ? !q.has('date') && q.has('start_date') && q.has('end_date')
      : !q.has('employee_id') && !q.has('station_code')) &&
    (q.get('employee_id') === null || new RegExp(`^${UUID}$`).test(q.get('employee_id') ?? '')) &&
    (q.get('station_code') === null || /^[a-z][a-z0-9_]{1,39}$/.test(q.get('station_code') ?? ''))
  );
}
export async function staffAuth(action: 'session' | 'login' | 'logout', body?: unknown) {
  const response = await fetch(`/backoffice/auth/${action}`, {
    method: action === 'session' ? 'GET' : 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (response.status === 404 && action === 'session')
    return { enabled: false, authenticated: false };
  if (!response.ok)
    throw new ApiError(
      response.status === 429
        ? 'RATE_LIMITED'
        : response.status === 401
          ? 'LOGIN_FAILED'
          : 'SERVICE_UNAVAILABLE',
      response.status,
    );
  return (await response.json()) as { enabled?: boolean; authenticated?: boolean; ok?: boolean };
}
const errorCodes = [
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INSUFFICIENT_STOCK',
  'NOT_READY',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
];
/**
 * Standard error envelope; a reason-carrying response (catalog, media and stop routes) adds
 * error:{code:<REASON>}. Anything else is an unverifiable response, never a known failure.
 */
export function failure(status: number, value: unknown): ApiError {
  const error = value as Record<string, unknown> | null;
  if (
    !error ||
    typeof error !== 'object' ||
    typeof error.code !== 'string' ||
    !errorCodes.includes(error.code) ||
    error.message_key !== `errors.${error.code.toLowerCase()}` ||
    typeof error.trace_id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(error.trace_id) ||
    typeof error.retryable !== 'boolean' ||
    (status === 401 && (error.code !== 'UNAUTHORIZED' || error.retryable))
  )
    return new ApiError('INVALID_RESPONSE', status);
  const detail = error.error as Record<string, unknown> | null | undefined;
  const reason =
    detail && typeof detail === 'object' && typeof detail.code === 'string'
      ? detail.code
      : undefined;
  return reason !== undefined && /^[A-Z][A-Z_]{0,63}$/.test(reason)
    ? new ApiError(error.code, status, reason)
    : new ApiError(error.code, status);
}
export const transport: Transport = async (path, token, options = {}) => {
  if (
    !(allowedPath(path) || expensesPath(path, options.method ?? 'GET')) ||
    (token !== 'session' && !/^[a-f0-9]{64}$/.test(token))
  )
    throw new ApiError('INVALID_REQUEST');
  let response: Response;
  try {
    response = await fetch(
      (token === 'session' ? '/backoffice/api' : '') +
        (path.startsWith('operations/')
          ? `/v1/admin/backoffice/${path.slice(11)}`
          : `/v1/admin/catalog/${path}`),
      {
        method: options.method ?? 'GET',
        redirect: 'error',
        credentials: token === 'session' ? 'same-origin' : 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
        headers: {
          ...(token === 'session' ? {} : { Authorization: `Bearer ${token}` }),
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      },
    );
  } catch {
    throw new ApiError('NETWORK');
  }
  let value: unknown;
  try {
    if (
      !response.headers.get('content-type')?.includes('application/json') ||
      Number(response.headers.get('content-length') ?? 0) > 1048576 ||
      !response.body
    )
      throw new Error('Invalid response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > 1048576) {
          void reader.cancel().catch(() => undefined);
          throw new Error('Response too large');
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError('INVALID_RESPONSE', response.status);
  }
  if (!response.ok) throw failure(response.status, value);
  return value;
};
/** Raw image types the upload route accepts (the server sniffs the bytes as well). */
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const uuid = new RegExp(`^${UUID}$`);
const sha = /^[a-f0-9]{64}$/;
/** Same-origin URL of a catalog photo rendition (img-src 'self'; the operator proxy serves it). */
export function mediaUrl(
  token: string,
  sha256: string,
  variant: 'card' | 'hero' | 'thumb' = 'card',
) {
  if (!sha.test(sha256)) throw new ApiError('INVALID_REQUEST');
  return `${token === 'session' ? '/backoffice/api' : ''}/v1/media/catalog/${sha256}.${variant}.webp`;
}
export type UploadedAsset = {
  asset_id: string;
  image: { asset_id: string; sha256: string };
  width: number;
  height: number;
};
export type Uploader = (
  token: string,
  branchId: string,
  file: Blob,
  requestId: string,
  onProgress?: (fraction: number) => void,
) => Promise<UploadedAsset>;
/** Only the fields the editor relies on; the card hash must be the product.image hash. */
export function parseUploadedAsset(value: unknown): UploadedAsset {
  const v = value as Record<string, unknown> | null;
  const image = v?.['image'] as Record<string, unknown> | undefined;
  const variants = v?.['variants'] as Record<string, Record<string, unknown>> | undefined;
  if (
    !v ||
    typeof v['asset_id'] !== 'string' ||
    !uuid.test(v['asset_id']) ||
    !image ||
    image['asset_id'] !== v['asset_id'] ||
    typeof image['sha256'] !== 'string' ||
    !sha.test(image['sha256']) ||
    variants?.['card']?.['sha256'] !== image['sha256'] ||
    !Number.isInteger(v['width']) ||
    !Number.isInteger(v['height'])
  )
    throw new ApiError('INVALID_RESPONSE');
  return {
    asset_id: v['asset_id'],
    image: { asset_id: v['asset_id'], sha256: image['sha256'] },
    width: v['width'] as number,
    height: v['height'] as number,
  };
}
/**
 * Raw photo upload with progress (XMLHttpRequest: fetch has no upload progress). The request id
 * is the Idempotency-Key, so a retry after a lost reply returns the same asset.
 */
export const uploadAsset: Uploader = (token, branchId, file, requestId, onProgress) =>
  new Promise((resolve, reject) => {
    if (
      (token !== 'session' && !/^[a-f0-9]{64}$/.test(token)) ||
      !uuid.test(branchId) ||
      !uuid.test(requestId) ||
      !UPLOAD_TYPES.includes(file.type) ||
      file.size < 1 ||
      file.size > UPLOAD_MAX_BYTES
    ) {
      reject(new ApiError('INVALID_REQUEST'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(
      'POST',
      `${token === 'session' ? '/backoffice/api' : ''}/v1/admin/catalog/branches/${branchId}/assets`,
    );
    xhr.timeout = 60000;
    xhr.responseType = 'text';
    xhr.withCredentials = token === 'session';
    if (token !== 'session') xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.setRequestHeader('Idempotency-Key', requestId);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    });
    const network = () => reject(new ApiError('NETWORK'));
    xhr.addEventListener('error', network);
    xhr.addEventListener('timeout', network);
    xhr.addEventListener('abort', network);
    xhr.addEventListener('load', () => {
      let value: unknown;
      try {
        if (
          !xhr.getResponseHeader('content-type')?.includes('application/json') ||
          xhr.responseText.length > 1048576
        )
          throw new Error('Invalid response');
        value = JSON.parse(xhr.responseText);
      } catch {
        reject(new ApiError('INVALID_RESPONSE', xhr.status));
        return;
      }
      if (xhr.status < 200 || xhr.status > 299) {
        reject(failure(xhr.status, value));
        return;
      }
      try {
        onProgress?.(1);
        resolve(parseUploadedAsset(value));
      } catch (error) {
        reject(error);
      }
    });
    xhr.send(file);
  });
const reasons: Record<string, string> = {
  CHANNEL_PRICES_NOT_SUPPORTED:
    'Отдельные цены каналов пока нельзя публиковать: касса, киоск и приложение получают одну базовую цену. Очистите поля «Цены по каналам» и сохраните черновик.',
  UNAVAILABLE_LINKED_PRODUCT:
    'Модификатор ссылается на позицию, скрытую из меню. Покажите связанную позицию в меню или уберите связь у варианта.',
  EDGE_MENU_STATE_UNKNOWN:
    'Касса ещё не сообщила свою версию меню. Проверьте, что кассовый компьютер включён и на связи, и повторите публикацию через минуту.',
  EDGE_DEVICE_INACTIVE:
    'Кассовый узел точки отключён. Публикация на кассу невозможна, пока узел не подключат снова.',
  ASSET_MISSING:
    'Загруженное фото не найдено на сервере. Загрузите фото заново или нажмите «Убрать фото».',
  ASSET_UNSUPPORTED_TYPE: 'Поддерживаются только фотографии JPEG, PNG, WebP или HEIC.',
  ASSET_TOO_LARGE: 'Фото больше 10 МБ. Уменьшите его и загрузите снова.',
  ASSET_INVALID_IMAGE:
    'Сервер не смог прочитать фото. Сохраните его как JPEG (не меньше 32 точек по стороне) и загрузите снова.',
  ASSET_RATE_LIMITED: 'Слишком много загрузок подряд. Подождите 10 минут и повторите.',
  PUBLISH_FORBIDDEN: 'Нет права публиковать. Публиковать меню может только управляющий точки.',
  EDIT_FORBIDDEN: 'Нет права изменять меню. Сохранять черновик может только управляющий точки.',
  UPLOAD_FORBIDDEN: 'Нет права загружать фото. Загружать фото может только управляющий точки.',
  UPLOAD_DISABLED: 'Загрузка фото пока не включена на сервере. Используйте запасное фото.',
  REMOTE_STOPS_DISABLED:
    'Удалённый стоп из кабинета выключен на сервере. Поставьте позицию на стоп на кассе.',
  CATALOG_NOT_PUBLISHED: 'Сначала опубликуйте меню: стоп-лист строится по опубликованной версии.',
  CATALOG_ITEM_NOT_FOUND:
    'Позиции нет в опубликованном меню (или она скрыта из меню). Обновите стоп-лист.',
  EDGE_STOPS_NOT_READY:
    'Касса пока не принимает команды стопа: кассовый узел не на связи или ещё не обновлён.',
  STOP_COMMAND_IN_PROGRESS:
    'По этой позиции уже есть команда, которая ждёт кассу. Дождитесь ответа и повторите.',
  STOP_FORBIDDEN: 'Нет права менять стоп-лист. Ставить на стоп может только управляющий точки.',
  REFUND_ADAPTER_NOT_CONFIGURED:
    'Возврат через банк из кабинета не подключён. Верните деньги в Kaspi Pay и зарегистрируйте ручной возврат.',
  MANUAL_REFUNDS_DISABLED:
    'Регистрация ручного возврата пока не включена на сервере. Сообщите владельцу.',
  REFUND_REFERENCE_ALREADY_USED:
    'Этот номер операции Kaspi уже зарегистрирован. Проверьте номер возврата в Kaspi Pay.',
  REFUND_EXCEEDS_PAYMENT:
    'Сумма больше оплаченной за вычетом уже возвращённого. Проверьте сумму возврата.',
  // Cutover CC-5/CC-6 (servers with BACKOFFICE_ROLES_ENABLED / BACKOFFICE_STOCK_V2_ENABLED).
  ROLE_FORBIDDEN: 'Для вашей роли это действие недоступно. Его может выполнить управляющий точки.',
  REASON_REQUIRED: 'Укажите причину списания.',
  STOCK_V2_DISABLED:
    'Причины списаний и данные накладной пока не включены на сервере. Обновите страницу.',
  // Lane bo-ui stock P1 (servers with capabilities.stock_p1).
  REVERSAL_NOT_ALLOWED:
    'Этот документ не сторнируется: инвентаризацию исправляют новой инвентаризацией, сторно - не отменяют.',
  ALREADY_REVERSED: 'Документ уже сторнирован. Сторно - одно на документ. Обновите страницу.',
  COUNTED_AFTER_DOCUMENT:
    'После документа по его позициям провели инвентаризацию: она уже учла фактический остаток. Исправьте остаток новой инвентаризацией или списанием.',
  RECIPE_POLICY_EXPLODE:
    'Эта техкарта при продаже раскладывается на сырьё, поэтому её не производят партиями. Если заготовку делают заранее, выберите в техкарте «Списывать сам выход».',
  RECIPE_POLICY_UNSET:
    'Выход этой техкарты списывается при продаже по связи меню, а в техкарте не выбран «Выход техкарты при продаже». Если заготовку делают партиями, выберите «Списывать сам выход» и проведите производство снова.',
  // Lane bo-ui step 6 (servers with capabilities.manager_shifts / staff_positions).
  MANAGER_SHIFT_OPEN: 'Смена менеджера уже открыта. Обновите страницу и закройте её.',
  CHECKLIST_INCOMPLETE:
    'Ответьте на все обязательные пункты. «Есть проблема», «Не применимо» и пункты с проблемой по данным требуют комментария.',
  HANDOVER_REQUIRED: 'Заполните передачу смены: минимум 3 символа.',
  LEGACY_JOURNAL_READ_ONLY:
    'Управленческий журнал только для чтения: смены ведутся в блоке «Смена менеджера».',
  POSITION_UNKNOWN: 'Такой должности нет в списке или она выключена. Обновите страницу.',
  POSITION_IN_USE: 'Должность нельзя удалить из списка: её можно только выключить.',
  // Lane bo-ui step 7 (servers with capabilities.discounts).
  DISCOUNT_NAME_TAKEN: 'Скидка с таким названием уже есть. Выберите другое название.',
  DISCOUNT_ARCHIVED: 'Скидка в архиве: её нельзя изменить или включить. Создайте новую.',
  DISCOUNT_PERIOD_ENDED: 'Период скидки уже закончился. Измените даты и включите её снова.',
  // Lane bo-ui2 step 2 (servers with capabilities.supply).
  SUPPLIER_NAME_TAKEN:
    'Поставщик с таким названием уже есть (возможно, в архиве). Выберите другое название.',
  SUPPLIER_INACTIVE:
    'Поставщик в архиве: на него нельзя оформить заявку или новую цену. Верните его из архива или выберите другого.',
  PRICE_UNIT_MISMATCH:
    'Единица цены не подходит к позиции: для граммов - г или кг, для миллилитров - мл или л, для штук - шт.',
  REQUEST_LOCKED:
    'Заявку уже подали, приняли или отменили в другом окне. Обновите список и проверьте её.',
  REQUEST_INCOMPLETE:
    'Чтобы подать заявку, нужны строки, дата «Нужно к» не раньше сегодняшней и, для заявки поставщику, поставщик.',
  // Lane bo-ui2 step 5 (servers with capabilities.staff_assignment).
  STATION_UNKNOWN:
    'Такой станции нет в списке должностей точки или она выключена. Обновите страницу.',
  STATION_NOT_ALLOWED:
    'Эта станция не входит в должность сотрудника. Поставить не по должности может управляющий, указав причину.',
  EMPLOYEE_NOT_WORKING: 'Сотрудник не работает или удалён. Обновите страницу.',
  ASSIGNMENT_TIME:
    'Время не подходит: оно позже текущего больше чем на 5 минут или раньше начала интервала. Время с 00:00 до 05:59 - ночь после дня смены.',
  ASSIGNMENT_OVERLAP:
    'В это время сотрудник уже стоял на станции: интервалы не пересекаются. Укажите время позже начала текущего интервала.',
  ASSIGNMENT_PREVIOUS_DAY:
    'У сотрудника не закрыт интервал прошлого дня смены. Сначала нажмите «Закончить» у этого интервала.',
};
export const reasonMessage = (reason: string | undefined) =>
  reason === undefined ? undefined : reasons[reason];
export const message = (error: unknown): string => {
  const key = error instanceof Error ? error.message : 'UNKNOWN';
  const precise = error instanceof ApiError ? reasonMessage(error.reason) : undefined;
  if (precise) return precise;
  return (
    (
      {
        UNAUTHORIZED: 'Сессия закончилась. Войдите снова, чтобы продолжить работу.',
        LOGIN_FAILED: 'Не удалось войти. Проверьте логин и пароль.',
        RATE_LIMITED: 'Слишком много попыток входа. Попробуйте через 15 минут.',
        FORBIDDEN: 'У вас нет доступа к этой точке.',
        CONFLICT:
          'Черновик изменил другой управляющий. Ваши правки сохранены отдельно и не перезапишут серверную версию.',
        INSUFFICIENT_STOCK:
          'Недостаточно ингредиентов для проведения документа. Проверьте остатки.',
        NOT_READY:
          'Операция пока недоступна. Проверьте статус заказа, подтверждение кухни и техкарты.',
        INVALID_REQUEST:
          'Сервер отклонил данные. Проверьте обязательные поля, ограничения и связанные позиции.',
        NOT_FOUND: 'Запись или точка не найдены.',
        SERVICE_UNAVAILABLE: 'Сервис управления сейчас недоступен.',
        NETWORK:
          'Ответ не получен. Если запрос уже отправлен, проверьте его результат с прежним request ID.',
        INVALID_RESPONSE:
          'Ответ сервера не прошёл проверку. Изменения не будут применены автоматически.',
        INVALID_CREDENTIAL: 'Выберите приватный JSON-файл управляющего, выданный оператором.',
        STORAGE:
          'Браузер не сохранил данные. Проверьте хранилище; если запрос ожидает подтверждения, сначала восстановите его результат.',
        PENDING: 'Сначала проверьте результат предыдущего запроса.',
        DIRTY: 'Сначала сохраните или отмените локальные изменения.',
        CORRUPTED: 'Сохранённый запрос повреждён. Не удаляйте данные до разбора с оператором.',
      } as Record<string, string>
    )[key] ?? key
  );
};
