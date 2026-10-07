export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
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
function allowedPath(path: string): boolean {
  if (/^branches(?:\/[a-f0-9-]{36}(?:\/(?:draft|draft\/seed|publish))?)?$/.test(path)) return true;
  const [pathname = '', search, extra] = path.split('?');
  if (extra !== undefined || path.includes('#')) return false;
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
    new RegExp(`^operations/branches/${UUID}/(?:commands|orders/${UUID})$`).test(pathname)
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
  if (!response.ok) {
    const error = value as Record<string, unknown> | null;
    const codes = [
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
    if (
      !error ||
      typeof error.code !== 'string' ||
      !codes.includes(error.code) ||
      error.message_key !== `errors.${error.code.toLowerCase()}` ||
      typeof error.trace_id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(error.trace_id) ||
      typeof error.retryable !== 'boolean' ||
      (response.status === 401 && (error.code !== 'UNAUTHORIZED' || error.retryable))
    )
      throw new ApiError('INVALID_RESPONSE', response.status);
    throw new ApiError(error.code, response.status);
  }
  return value;
};
export const message = (error: unknown): string => {
  const key = error instanceof Error ? error.message : 'UNKNOWN';
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
