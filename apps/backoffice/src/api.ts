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
export const transport: Transport = async (path, token, options = {}) => {
  if (
    (!/^branches(?:\/[a-f0-9-]{36}(?:\/(?:draft|draft\/seed|publish))?)?$/.test(path) &&
      !/^operations\/branches\/[a-f0-9-]{36}(?:\/commands|\/orders\/[a-f0-9-]{36}|\?period=(?:day|week|month|quarter))?$/.test(
        path,
      )) ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    throw new ApiError('INVALID_REQUEST');
  let response: Response;
  try {
    response = await fetch(
      path.startsWith('operations/')
        ? `/v1/admin/backoffice/${path.slice(11)}`
        : `/v1/admin/catalog/${path}`,
      {
        method: options.method ?? 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${token}`,
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
        UNAUTHORIZED: 'Доступ отозван или недействителен. Загрузите файл сессии управляющего.',
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
