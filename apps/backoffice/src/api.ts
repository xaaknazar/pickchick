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
  let response: Response;
  try {
    response = await fetch(`/v1/admin/catalog/${path}`, {
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
    });
  } catch {
    throw new ApiError('NETWORK');
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiError('INVALID_RESPONSE', response.status);
  }
  if (!response.ok)
    throw new ApiError(
      value && typeof value === 'object' && 'code' in value
        ? String(value.code)
        : 'SERVICE_UNAVAILABLE',
      response.status,
    );
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
        INVALID_REQUEST:
          'Сервер отклонил данные. Проверьте обязательные поля, ограничения и связанные позиции.',
        NOT_FOUND: 'Каталог или точка не найдены.',
        SERVICE_UNAVAILABLE: 'Сервис каталога сейчас недоступен.',
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
