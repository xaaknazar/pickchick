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
export function allowedPath(path: string): boolean {
  if (/^branches(?:\/[a-f0-9-]{36}(?:\/(?:draft|draft\/seed|publish|assets))?)?$/.test(path))
    return true;
  const [pathname = '', search, extra] = path.split('?');
  if (extra !== undefined || path.includes('#')) return false;
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
  if (new RegExp(`^operations/branches/${UUID}$`).test(pathname)) return reportQuery(search ?? '');
  return (
    search === undefined &&
    new RegExp(
      `^operations/branches/${UUID}/(?:commands|stops|orders/${UUID}|devices(?:/(?:pairing-codes|revoke|kitchen-password-reset(?:/events)?|${UUID}/events))?)$`,
    ).test(pathname)
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
  if (!allowedPath(path) || (token !== 'session' && !/^[a-f0-9]{64}$/.test(token)))
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
