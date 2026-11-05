import type { StaffCredential } from './types.js';
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
    public readonly retryAfterSeconds = 0,
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
  if (response.ok && response.status === 204 && path === 'staff/logout') return null;
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
export type PasswordInput = { login: string; password: string; terminal_id: string };
export type PasswordTransport = (input: PasswordInput) => Promise<unknown>;
export const passwordTransport: PasswordTransport = async (input) => {
  let response: Response;
  try {
    response = await fetch('/edge/v1/staff/login', {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    throw new ApiError('EDGE_UNREACHABLE');
  }
  if (response.status === 401) throw new ApiError('INVALID_LOGIN', 401);
  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After'));
    throw new ApiError(
      'AUTH_RATE_LIMITED',
      429,
      Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60,
    );
  }
  if (!response.ok) throw new ApiError('EDGE_ERROR', response.status);
  try {
    return await response.json();
  } catch {
    throw new ApiError('INVALID_RESPONSE', response.status);
  }
};
export const errorMessage = (error: unknown): string => {
  const code = error instanceof Error ? error.message : 'UNKNOWN';
  return (
    (
      {
        UNAUTHORIZED:
          'Сессия закончилась или отозвана. Войдите снова под своим логином, чтобы продолжить.',
        FORBIDDEN: 'Эта операция недоступна вашей роли.',
        NOT_FOUND: 'Заказ не найден или недоступен этому сотруднику и терминалу.',
        INVALID_CREDENTIAL: 'Выберите JSON-файл сессии, выданный локальным оператором.',
        INVALID_LOGIN: 'Не удалось войти. Проверьте логин и пароль или обратитесь к управляющему.',
        AUTH_RATE_LIMITED: 'Слишком много попыток входа. Подождите перед следующей попыткой.',
        TERMINAL_NOT_CONFIGURED:
          'Касса ещё не привязана к рабочему месту. Обратитесь к управляющему.',
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
        ITEM_STOPPED:
          'Блюдо, его вариант или часть комбо в стоп-листе. Обновите доступность и измените корзину.',
        COMBO_STOPPED:
          'Комбо недоступно: часть его состава в стоп-листе. Выберите другое блюдо или снимите стоп.',
        OPTION_STOPPED: 'Выбранный напиток или соус в стоп-листе. Выберите другой вариант.',
        CHOICE_STOPPED:
          'Все варианты обязательного выбора в стоп-листе. Снимите стоп с одного из них или выберите другое блюдо.',
        BRANCH_UNAVAILABLE:
          'Приём закрыт или меню недоступно. Начальник смены должен проверить локальный узел.',
        CONFLICT:
          'Состояние изменилось, операция не выполнена. Проверьте актуальные данные и при необходимости повторите.',
        INVALID_REQUEST: 'Проверьте позиции, количество и обязательные поля.',
        INVALID_MODIFIERS: 'Проверьте обязательные варианты и количество добавок.',
        INVALID_CASH_AMOUNT:
          'Введите сумму в тенге: например, 5000 или 5000,50. Не больше двух знаков после запятой.',
        CASH_SHIFT_REQUIRED: 'Сначала откройте кассовую смену, затем создайте заказ.',
        CASH_SHIFT_STATUS_UNKNOWN:
          'Состояние смены не подтверждено. Обновите его перед созданием заказа.',
        SERVICE_MODE_DISABLED: 'Передача без оплаты сейчас отключена. Обратитесь к управляющему.',
        KITCHEN_UNAVAILABLE:
          'Кухня не готова принять заказ. Проверьте настройку станций и повторите проверку.',
        ORDER_IN_PRODUCTION: 'Приготовление уже началось. Отмена с кассы недоступна.',
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
/** What a sale error refers to, so one edge code can name the right aggregator or ChocoFood. */
export type SaleErrorContext = {
  channel?: 'hall' | 'yandex_eda' | 'glovo';
  method?: string;
};
/**
 * Cashier texts of the paid-sale mode (contracts section 5.1 and section 00). Codes the sale
 * screens do not know fall back to errorMessage, so the unpaid cashier keeps its texts.
 */
export const saleErrorMessage = (error: unknown, context: SaleErrorContext = {}): string => {
  const code = error instanceof Error ? error.message : 'UNKNOWN';
  const chocofood = context.method === 'chocofood';
  const text: Record<string, string> = {
    SERVICE_MODE_DISABLED: 'Касса не принимает оплату - сообщите менеджеру',
    METHOD_DISABLED: 'Этот способ оплаты выключен',
    TENDER_SUM_MISMATCH: 'Сумма оплат не равна сумме заказа',
    CASH_TENDERED_TOO_LOW: 'Внесено меньше суммы наличными',
    TERMINAL_AMOUNT_NOT_WHOLE: 'На терминале - только целые тенге',
    CHANNEL_PRICE_UNAVAILABLE:
      context.channel === 'glovo' ? 'Нет в меню Glovo' : 'Нет в меню Яндекс Еды',
    EXTERNAL_REF_REQUIRED: chocofood
      ? 'Введите номер заказа ChocoFood'
      : 'Введите номер заказа агрегатора',
    EXTERNAL_REF_DUPLICATE: 'Этот номер заказа уже пробит',
    APPROVAL_REQUIRED: 'Нужен PIN начальника смены',
    APPROVAL_INVALID: 'Подтверждение недействительно или истекло - введите PIN ещё раз',
    ORDER_IN_PRODUCTION: 'Кухня уже начала - оформите возврат',
    REFUND_LIMIT: 'Сумма больше доступной к возврату',
    REFUND_NOT_SUPPORTED: chocofood
      ? 'Возврат ChocoFood оформляется в кабинете ChocoFood'
      : 'Возврат агрегатора оформляется в кабинете агрегатора',
    DRAWER_INSUFFICIENT: 'В кассе недостаточно наличных',
    FISCAL_PENDING: 'Есть неоформленные чеки Webkassa',
    // Checks the cashier screen makes before anything is sent.
    SERVICE_MODE_REQUIRED: 'Выберите: в зале или с собой',
    ORDER_REVIEW_REQUIRED: 'Сначала повторите заказ гостю',
    POS_CONFIG_UNAVAILABLE:
      'Настройки оплаты не получены. Проверьте связь с сервером кассы и повторите.',
    MIX_INVALID:
      'Смешанная оплата - две части из наличных, Kaspi терминала и Kaspi вручную, наличными не больше одной части',
    REFERENCE_INVALID: 'Номер операции - от 1 до 40 символов',
    BENEFICIARY_REQUIRED: 'Укажите, кому питание сотрудника',
    REASON_REQUIRED: 'Укажите причину - от 3 до 300 символов',
    APPROVAL_PIN_REJECTED: 'Неверный PIN или нет прав начальника смены',
    RECEIPT_NUMBER_INVALID: 'Номер чека Webkassa - от 1 до 40 символов',
    RECEIPT_NOT_PENDING: 'Этот чек уже оформлен',
    AGGREGATOR_TAKEAWAY_ONLY: 'Заказ агрегатора - только с собой',
  };
  return text[code] ?? errorMessage(error);
};
