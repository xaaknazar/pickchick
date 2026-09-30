import {
  TestCatalogSchema,
  TestSessionSchema,
  TestQuoteSchema,
  TestOrderSchema,
  TestOrdersSchema,
  TestKitchenSchema,
  TestDisplaySchema,
  TestServiceShiftCurrentSchema,
  type TestOrder,
  type TestQuote,
} from '@pickchick/test-order-flow/contracts';

export type { TestOrder, TestQuote };
export type Catalog = ReturnType<typeof TestCatalogSchema.parse>;
export type Product = Catalog['products'][number];
export type Session = ReturnType<typeof TestSessionSchema.parse>;
export type Kitchen = ReturnType<typeof TestKitchenSchema.parse>;
export type Display = ReturnType<typeof TestDisplaySchema.parse>;
export type Orders = ReturnType<typeof TestOrdersSchema.parse>;
export type ServiceMode = 'takeaway' | 'dine_in';
export type StaffRole = 'prep' | 'assembly' | 'display' | 'manager';

// Versioned staging endpoint. Real customer/bank operations are not enabled here.
export const API_BASE = 'https://pickchick.185.129.51.103.nip.io/v1/test';
type Decoder<T> = { parse(value: unknown): T };
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}
export function errorText(error: unknown): string {
  if (!(error instanceof ApiError))
    return 'Нет ответа сервера. Проверьте связь и повторите запрос.';
  if (error.status === 401) return 'Срок доступа истёк или ключ не принят. Восстановите доступ.';
  if (error.status === 403) return 'У этого ключа нет прав для выбранного экрана.';
  if (error.code === 'QUOTE_EXPIRED')
    return 'Расчёт заказа истёк. Вернитесь в корзину для нового расчёта.';
  if (error.code === 'SHIFT_CLOSED')
    return 'Смена закрыта. Дождитесь открытия новой смены. Состав заказа сохранён.';
  if (error.status === 409) return 'Заказ уже изменился. Обновите его состояние перед действием.';
  if (error.status === 429) return 'Слишком много запросов. Повторите позднее.';
  if (error.status === 503) return 'Сервис временно недоступен. Повторите запрос позже.';
  return 'Сервер не принял запрос. Обновите данные и проверьте состав заказа.';
}

async function request<T>(
  path: string,
  schema: Decoder<T>,
  token?: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(
      API_BASE + path + (path.includes('?') ? '&' : '?') + 'number_format=daily',
      {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const record = data as { code?: unknown; error?: { code?: unknown } } | null;
      const code = record?.error?.code ?? record?.code;
      throw new ApiError(response.status, typeof code === 'string' ? code : 'REQUEST_FAILED');
    }
    try {
      return schema.parse(data);
    } catch {
      throw new ApiError(502, 'INVALID_RESPONSE');
    }
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export const api = {
  shift: (token: string) => request('/shift', TestServiceShiftCurrentSchema, token),
  changeShift: (
    token: string,
    action: 'open' | 'close',
    current: ReturnType<typeof TestServiceShiftCurrentSchema.parse>['shift'],
    key: string,
  ) =>
    request(
      `/shift/${action}`,
      TestServiceShiftCurrentSchema,
      token,
      {
        previous_shift_id: current?.shift_id ?? null,
        expected_version: current?.version ?? null,
      },
      key,
    ),
  catalog: () => request('/catalog', TestCatalogSchema),
  session: () => request('/sessions', TestSessionSchema, undefined, { channel: 'kiosk' }),
  continueSession: (token: string) => request('/sessions/continue', TestSessionSchema, token, {}),
  orders: (token: string) => request('/orders', TestOrdersSchema, token),
  order: (token: string, id: string) => request(`/orders/${id}`, TestOrderSchema, token),
  quote: (
    token: string,
    body: {
      catalog_version: string;
      service_mode: ServiceMode;
      items: { product_id: string; quantity: number }[];
    },
    key: string,
  ) => request('/quotes', TestQuoteSchema, token, body, key),
  create: (token: string, quote: string, key: string) =>
    request('/orders', TestOrderSchema, token, { quote_id: quote }, key),
  payment: (
    token: string,
    order: TestOrder,
    outcome: 'approved' | 'declined' | 'unknown',
    key: string,
  ) =>
    request(
      `/orders/${order.order_id}/simulated-payment`,
      TestOrderSchema,
      token,
      { expected_version: order.version, outcome },
      key,
    ),
  resolve: (token: string, order: TestOrder, outcome: 'approved' | 'declined', key: string) =>
    request(
      `/orders/${order.order_id}/resolve-payment`,
      TestOrderSchema,
      token,
      { expected_version: order.version, outcome },
      key,
    ),
  cancel: (token: string, order: TestOrder, reason: string, key: string) =>
    request(
      `/orders/${order.order_id}/cancel`,
      TestOrderSchema,
      token,
      { expected_version: order.version, reason },
      key,
    ),
  // Staff reads full mobile selections; the legacy web kiosk keeps its v0.2 catalog.
  kitchen: (token: string) =>
    request('/kitchen?catalog_version=mockup-v0.3', TestKitchenSchema, token),
  complete: (token: string, order: TestOrder, task: string, key: string) =>
    request(
      `/orders/${order.order_id}/tasks/${task}/complete`,
      TestOrderSchema,
      token,
      { expected_version: order.version, complete_station: true },
      key,
    ),
  handoff: (token: string, order: TestOrder, key: string) =>
    request(
      `/orders/${order.order_id}/handoff`,
      TestOrderSchema,
      token,
      { expected_version: order.version },
      key,
    ),
  manager: (token: string) =>
    request('/manager/orders?catalog_version=mockup-v0.3', TestOrdersSchema, token),
  display: (token: string) => request('/display?shift_context=1', TestDisplaySchema, token),
};

export function readSession(): Session | null {
  try {
    return TestSessionSchema.parse(
      JSON.parse(sessionStorage.getItem('pickchick.kiosk.session') ?? 'null'),
    );
  } catch {
    return null;
  }
}

export function money(value: string): string {
  const amount = BigInt(value);
  const whole = (amount / 100n).toLocaleString('ru-RU');
  const cents = amount % 100n;
  return `${whole}${cents ? ',' + cents.toString().padStart(2, '0') : ''} ₸`;
}

export const stateLabels: Record<TestOrder['state'], string> = {
  awaiting_test_payment: 'Ждёт подтверждения',
  preparing: 'Готовится',
  ready: 'Готов к выдаче',
  fulfilled: 'Выдан',
  cancelled: 'Отменён',
};
export const paymentLabels: Record<TestOrder['payment_state'], string> = {
  not_started: 'Без оплаты',
  simulated_unknown: 'Требует уточнения',
  simulated_approved: 'Передан без оплаты',
  simulated_declined: 'Подтверждение отклонено',
};
