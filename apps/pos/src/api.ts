import type { StaffCredential } from './types.js';
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
  ) {
    super(code);
  }
}
export type Request = { method?: 'GET' | 'POST'; body?: unknown; key?: string };
export type Transport = (
  path: string,
  credential: StaffCredential,
  options?: Request,
) => Promise<unknown>;
export const transport: Transport = async (path, credential, options = {}) => {
  let response: Response;
  try {
    response = await fetch(`/edge/v1/${path}`, {
      method: options.method ?? 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: `Bearer ${credential.token}`,
        'X-Staff-Session-Id': credential.session_id,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.key ? { 'Idempotency-Key': options.key } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError('EDGE_UNREACHABLE');
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError('INVALID_RESPONSE', response.status);
  }
  if (!response.ok) {
    const code =
      payload && typeof payload === 'object' && 'code' in payload
        ? String(payload.code)
        : 'EDGE_ERROR';
    throw new ApiError(code, response.status);
  }
  return payload;
};
export const errorMessage = (error: unknown): string => {
  const code = error instanceof Error ? error.message : 'UNKNOWN';
  return (
    (
      {
        UNAUTHORIZED:
          'Доступ закончился или отозван. Загрузите новую сессию того же сотрудника для восстановления.',
        FORBIDDEN: 'Эта операция недоступна вашей роли.',
        NOT_FOUND: 'Заказ не найден или недоступен этому сотруднику и терминалу.',
        INVALID_CREDENTIAL: 'Выберите JSON-файл сессии, выданный локальным оператором.',
        INVALID_RESPONSE:
          'Ответ или локальные данные не прошли проверку. Операция не будет повторена с новым ключом.',
        STORAGE_UNAVAILABLE:
          'Не удалось сохранить журнал. Новые запросы заблокированы; проверьте доступ к хранилищу.',
        STORAGE_DAMAGED:
          'Локальный журнал повреждён. Не очищайте данные кассы; обратитесь к оператору.',
        EDGE_UNREACHABLE:
          'Локальный узел не ответил. При запросе заказа проверьте результат, не создавайте его заново.',
        EDGE_TIMEOUT: 'Локальный узел не успел ответить. Проверьте результат сохранённого запроса.',
        QUOTE_EXPIRED: 'Расчёт истёк. Пересчитайте корзину.',
        MENU_CHANGED: 'Меню обновилось. Проверьте позиции и пересчитайте корзину.',
        ITEM_STOPPED: 'Блюдо в стоп-листе. Обновите доступность и измените корзину.',
        BRANCH_UNAVAILABLE:
          'Приём закрыт или меню недоступно. Начальник смены должен проверить локальный узел.',
        CONFLICT: 'Состояние изменилось. Обновите данные и проверьте текущий результат.',
        INVALID_REQUEST: 'Проверьте позиции, количество и обязательные поля.',
        INVALID_MODIFIERS: 'Проверьте обязательные варианты и количество добавок.',
        INVALID_CASH_AMOUNT:
          'Введите сумму в тенге: например, 5000 или 5000,50. Не больше двух знаков после запятой.',
        CASH_SHIFT_REQUIRED: 'Сначала откройте кассовую смену, затем создайте заказ.',
        CASH_SHIFT_STATUS_UNKNOWN:
          'Состояние смены не подтверждено. Обновите его перед созданием заказа.',
        WRONG_BRANCH:
          'Сессия и меню относятся к разным точкам. Проверьте настройку рабочего места.',
        PENDING: 'Сначала восстановите результат предыдущего запроса.',
        ACTIVE_TAB:
          'Это рабочее место уже открыто в другом окне. Завершите там работу или закройте окно.',
        UNSUPPORTED_BROWSER:
          'Защита журнала недоступна. Обратитесь к оператору для обновления рабочего места.',
        LIMIT: 'Допустимо до 50 разных блюд и 99 порций одного блюда.',
      } as Record<string, string>
    )[code] ?? 'Не удалось выполнить действие. Проверьте локальный узел и повторите проверку.'
  );
};
