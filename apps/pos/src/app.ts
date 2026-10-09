import {
  orderView,
  kitchenLabel,
  menuChangeText,
  orderNumber,
  confirmationView,
} from './order-view.js';
import { loginView } from './auth-view.js';
import { PosController } from './model.js';
import { transport, errorMessage } from './api.js';
import {
  money,
  lineKey,
  linePrice,
  inputMoney,
  isUuid,
  categoryLabels,
  sortedItems,
  type Item,
  type Selection,
  type CashShift,
} from './types.js';

const root = document.querySelector<HTMLDivElement>('#app')!;
async function lease(scope: string): Promise<() => void> {
  if (!navigator.locks) throw new Error('UNSUPPORTED_BROWSER');
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request(`pickchick.pos.${scope}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          reject(new Error('ACTIVE_TAB'));
          return;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(reject);
  });
}
const sessions = {
  getItem: (key: string) => sessionStorage.getItem(key),
  setItem: (key: string, value: string) => sessionStorage.setItem(key, value),
  removeItem: (key: string) => sessionStorage.removeItem(key),
};
const browserJournal = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
  removeItem: (key: string) => localStorage.removeItem(key),
};
const nativeJournal = () => {
  const bridge = (
    globalThis as typeof globalThis & {
      pickchickPosJournal?: Pick<Storage, 'getItem' | 'setItem'> & { endSession(): void };
    }
  ).pickchickPosJournal;
  if (!bridge || typeof bridge.getItem !== 'function' || typeof bridge.setItem !== 'function')
    throw new Error('STORAGE_UNAVAILABLE');
  return bridge;
};
// The packaged client requires a disk acknowledgement before model.save returns.
// A failed/missing preload must never silently fall back to buffered web storage.
const requiresNativeJournal = Boolean(
  document.querySelector('meta[name="pickchick-pos-storage"][content="native-v1"]'),
);
const journal = requiresNativeJournal
  ? {
      getItem: (key: string) => nativeJournal().getItem(key),
      setItem: (key: string, value: string) => nativeJournal().setItem(key, value),
      removeItem: () => {
        throw new Error('STORAGE_UNAVAILABLE');
      },
    }
  : browserJournal;
const model = new PosController(transport, sessions, journal, () => crypto.randomUUID(), lease);
const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
let view = 'sale',
  category = '',
  search = '',
  page = 0;
let orderFilter = 'all';
let config: { branchLabel: string; categories: Record<string, string>; terminalId?: string } = {
  branchLabel: 'Локальная точка',
  categories: {},
};
let configLoaded = false;
let loginName = '';
const disabled = (condition: unknown) => (condition ? ' disabled' : '');
const idShort = (id: string) => id.slice(0, 8);
const almatyTime = (value: string | number = Date.now()) =>
  new Date(value).toLocaleTimeString('ru-RU', {
    timeZone: 'Asia/Almaty',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
const almatyDate = (value: string | number = Date.now()) =>
  new Date(value).toLocaleDateString('ru-RU', {
    timeZone: 'Asia/Almaty',
    day: 'numeric',
    month: 'long',
  });
let fullscreen = false;
const windowBridge = (
  globalThis as typeof globalThis & {
    pickchickPosWindow?: {
      toggleFullscreen(): Promise<boolean>;
      isFullscreen(): Promise<boolean>;
      onChange?(listener: (value: boolean) => void): () => void;
    };
  }
).pickchickPosWindow;
async function syncFullscreen() {
  try {
    fullscreen = windowBridge
      ? await windowBridge.isFullscreen()
      : Boolean(document.fullscreenElement);
  } catch {
    fullscreen = Boolean(document.fullscreenElement);
  }
  updateClock();
}
function updateClock() {
  const retry = Math.max(0, Math.ceil((model.retryLoginAt - Date.now()) / 1000));
  const submit = root.querySelector<HTMLButtonElement>('[data-testid=pos-sign-in]');
  if (submit) {
    submit.disabled = model.state.busy || !isUuid(config.terminalId) || retry > 0;
    submit.textContent = model.state.busy ? 'Входим...' : retry ? `Подождите ${retry} с` : 'Войти';
    const wait = document.getElementById('login-wait');
    if (wait) wait.textContent = retry ? `Повторить вход через ${retry} с` : '';
  }
  const clock = document.getElementById('pos-clock');
  if (clock) clock.textContent = almatyTime();
  const date = document.getElementById('pos-date');
  if (date) date.textContent = almatyDate() + ' · Алматы';
  const button = document.querySelector<HTMLButtonElement>('[data-action="fullscreen"]');
  if (button) {
    button.textContent = fullscreen ? 'Оконный режим' : 'На весь экран';
    button.setAttribute('aria-pressed', String(fullscreen));
  }
}
async function toggleFullscreen() {
  try {
    if (windowBridge) fullscreen = await windowBridge.toggleFullscreen();
    else if (document.fullscreenElement) {
      await document.exitFullscreen();
      fullscreen = false;
    } else {
      await document.documentElement.requestFullscreen();
      fullscreen = true;
    }
    updateClock();
  } catch {
    /* A denied window action never changes the order or journal. */
  }
}

function notice() {
  const s = model.state;
  return `${s.menuChange ? `<div class="notice" role="status" data-testid="pos-menu-change">${escape(menuChangeText(s.menuChange))}</div>` : ''}${s.error ? `<div class="notice error" role="alert" data-testid="pos-error">${escape(errorMessage(s.error))}</div>` : ''}${s.pending ? `<section class="notice pending" role="status" data-testid="pos-recovery"><div><strong>Проверка сохранённого запроса</strong><p>Результат пока не подтверждён. Новый заказ заблокирован.</p><small>Запрос ${escape(s.pending.key)}</small></div>${s.actor ? `<button data-action="recover"${disabled(s.busy)} data-testid="pos-recover">Проверить результат</button>` : '<p>Войдите под тем же логином, чтобы проверить результат.</p>'}</section>` : ''}`;
}
function login() {
  return loginView({
    name: loginName,
    branchLabel: config.branchLabel,
    configured: isUuid(config.terminalId),
    loaded: configLoaded,
    busy: model.state.busy,
    retrySeconds: Math.max(0, Math.ceil((model.retryLoginAt - Date.now()) / 1000)),
    notice: notice(),
  });
}
function toolbar() {
  const s = model.state,
    actor = s.actor!;
  return `<header class="topbar"><div class="brand"><img src="/logo.png" alt="PickChick" /><div><strong>Касса PickChick</strong><small>${escape(config.branchLabel)}</small></div></div><div class="header-live"><div class="clock-block"><strong class="clock-time" id="pos-clock">${almatyTime()}</strong><small class="clock-date" id="pos-date">${almatyDate()} · Алматы</small></div><button class="shift-pill ${s.shift ? 'open' : 'closed'}" data-view="shifts" data-testid="pos-shift-status"><span class="status-dot"></span><span>${s.operationsAvailable ? (s.shift ? 'Смена открыта' : 'Смена закрыта') : 'Проверка смены'}<small>${s.shift ? `с ${almatyTime(s.shift.opened_at).slice(0, 5)}` : 'Рабочее место кассира'}</small></span></button><div class="header-metric"><strong data-testid="pos-order-count">${s.shift?.order_count ?? '-'}</strong><small>заказов в смене</small></div><button class="subtle fullscreen-button" data-action="fullscreen" aria-pressed="${fullscreen}" data-testid="pos-fullscreen">${fullscreen ? 'Оконный режим' : 'На весь экран'}</button><div class="top-status"><span class="status ${s.connectedAt ? 'online' : 'offline'}" data-testid="pos-connectivity">${s.connectedAt ? 'Локальный узел' : 'Нет связи'}</span><button class="subtle" data-action="logout"${disabled(s.busy)} data-testid="pos-logout">${actor.role === 'shift_manager' ? 'Управляющий' : 'Кассир'} · Выйти</button></div></div></header>`;
}
function navigation() {
  return `<nav class="nav" aria-label="Касса"><button data-view="sale" aria-current="${view === 'sale' ? 'page' : 'false'}">▦<span>Новый заказ</span></button><button data-view="orders" aria-current="${view === 'orders' ? 'page' : 'false'}">≡<span>Заказы</span></button><button data-view="shifts" aria-current="${view === 'shifts' ? 'page' : 'false'}">◷<span>Смена</span></button><button data-view="status" aria-current="${view === 'status' ? 'page' : 'false'}">⚙<span>Настройки</span></button><div class="nav-note">PICK<br />CHICK</div></nav>`;
}
function availableItems() {
  const items = model.state.menu ? sortedItems(model.state.menu) : [];
  return items.filter(
    (i) =>
      (!category || i.category_id === category) &&
      (!search ||
        `${i.name.ru} ${i.name.kk}`
          .toLocaleLowerCase('ru')
          .includes(search.toLocaleLowerCase('ru'))),
  );
}
function product(item: Item) {
  const s = model.state,
    stop = s.stops.get(item.variant_id);
  const blocked = s.busy || s.pending || s.storageBlocked || !stop || stop.stopped;
  const inCart =
    s.draft?.items
      .filter((i) => i.variant_id === item.variant_id)
      .reduce((sum, i) => sum + i.quantity, 0) ?? 0;
  return `<article class="product ${stop?.stopped ? 'stopped' : ''}" data-testid="pos-product-${item.variant_id}"><button class="product-photo" data-add="${item.variant_id}" aria-label="Выбрать ${escape(item.name.ru)}"${disabled(blocked)}>${item.image_url ? `<img class="product-image" src="${escape(item.image_url)}" alt="${escape(item.name.ru)}" loading="lazy" decoding="async" />` : `<span class="product-symbol" aria-hidden="true">${escape(item.name.ru.slice(0, 1))}<small>PICK CHICK</small></span>`}${inCart ? `<span class="in-cart-badge">${inCart} в заказе</span>` : ''}${stop?.stopped ? '<span class="stop-badge">Стоп-лист</span>' : ''}</button><div class="product-body"><small>${escape(categoryLabels(s.menu, config.categories).get(item.category_id) ?? 'Меню')}</small><button class="product-open" data-add="${item.variant_id}"${disabled(blocked)}><h3>${escape(item.name.ru)}</h3></button><div class="product-bottom"><strong>${money(item.price_minor)}</strong><button aria-label="Добавить ${escape(item.name.ru)}" data-add="${item.variant_id}"${disabled(blocked)} data-testid="pos-add-${item.variant_id}">+</button></div><span class="availability">${!stop ? 'Проверяем доступность' : item.modifier_groups?.length ? 'Выберите состав' : 'Готово к выбору'}</span>${s.actor?.role === 'shift_manager' ? `<button class="stop-action" data-stop="${item.variant_id}"${disabled(s.busy || s.pending || !stop)}>${stop?.stopped ? 'Снять стоп' : 'В стоп-лист'}</button>` : ''}</div></article>`;
}
function selectionText(item: Item | undefined, selected: Selection[] = []) {
  return selected
    .map((m) => {
      const name =
        item?.modifier_groups
          ?.find((g) => g.id === m.group_id)
          ?.options.find((o) => o.id === m.option_id)?.name.ru ?? 'Выбранная добавка';
      return `${(m.quantity ?? 1) > 1 ? `${m.quantity} × ` : ''}${name}`;
    })
    .join(' · ');
}
function cart() {
  const s = model.state,
    d = s.draft,
    locked = s.busy || s.pending || s.storageBlocked;
  let estimate = 0n,
    missing = false;
  const lines = (d?.items ?? [])
    .map((line) => {
      const item = s.menu?.items.find((i) => i.variant_id === line.variant_id),
        key = lineKey(line);
      let unit: bigint | null = null;
      try {
        if (item) unit = linePrice(item, line.modifiers);
        else missing = true;
      } catch {
        missing = true;
      }
      if (unit !== null) estimate += unit * BigInt(line.quantity);
      return `<div class="cart-line" data-line-key="${escape(key)}" data-testid="pos-cart-line-${line.variant_id}">${item?.image_url ? `<img class="cart-line-thumb" src="${escape(item.image_url)}" alt="" />` : ''}<div class="cart-line-main"><div class="cart-line-heading"><h3>${escape(item?.name.ru ?? 'Позиция отсутствует в меню')}</h3><button class="remove" data-quantity="${escape(key)}" data-count="0" aria-label="Убрать ${escape(item?.name.ru ?? 'позицию')}"${disabled(locked)}>×</button></div>${line.modifiers?.length ? `<p class="cart-line-modifiers">${escape(selectionText(item, line.modifiers))}</p>` : ''}<small>${unit === null ? 'Проверьте состав блюда' : `${money(unit.toString())} за порцию`}${s.stops.get(line.variant_id)?.stopped ? ' · В стоп-листе' : ''}</small></div><div class="line-controls"><button data-quantity="${escape(key)}" data-count="${line.quantity - 1}" aria-label="Уменьшить количество"${disabled(locked)}>-</button><strong data-testid="pos-quantity-${line.variant_id}">${line.quantity}</strong><button data-quantity="${escape(key)}" data-count="${line.quantity + 1}" aria-label="Увеличить количество"${disabled(locked || line.quantity >= 99 || !item || s.stops.get(line.variant_id)?.stopped !== false)}>+</button>${item?.modifier_groups?.length ? `<button class="cart-edit" data-edit="${escape(key)}"${disabled(locked)}>Состав</button>` : ''}<b>${unit === null ? '-' : money((unit * BigInt(line.quantity)).toString())}</b></div></div>`;
    })
    .join('');
  const q = s.quote,
    expired = q && Date.parse(q.expires_at) <= Date.now();
  const noShift = !model.hasConfirmedOpenShift;
  return `<aside class="cart" data-testid="pos-cart"><header><div class="eyebrow">НОВЫЙ ЗАКАЗ</div><h2>Заказ <span>${d?.items.reduce((n, i) => n + i.quantity, 0) ?? 0}</span></h2><div class="segmented"><button data-mode="dine_in" aria-pressed="${d?.service_mode === 'dine_in'}"${disabled(locked)}>В зале</button><button data-mode="takeaway" aria-pressed="${d?.service_mode === 'takeaway'}"${disabled(locked)}>С собой</button></div></header><div class="cart-lines">${lines || '<div class="empty"><span>＋</span><h3>Добавьте первое блюдо</h3><p>Выберите блюдо в меню.<br />Состав можно изменить в заказе.</p></div>'}</div><footer data-testid="pos-cart-footer"><div class="total-row"><span>${q ? 'Итого по расчёту' : 'Итого предварительно'}</span><strong data-testid="pos-total">${missing ? '-' : estimate > 9223372036854775807n ? 'Лимит суммы' : money(q?.total_minor ?? estimate.toString())}</strong></div>${noShift ? `<button class="subtle" data-view="shifts">${s.operationsAvailable && !s.operationsError ? 'Откройте смену для оформления' : 'Проверьте состояние смены'}</button>` : ''}<button class="primary" data-action="calculate" data-testid="pos-calculate"${disabled(locked || !d?.items.length || !s.menu || !s.ordering?.ordering_enabled || missing || estimate > 9223372036854775807n)}>Проверить заказ</button><p class="fine">${q ? (expired ? 'Расчёт истёк. Пересчитайте заказ.' : `Расчёт до ${almatyTime(q.expires_at).slice(0, 5)}. `) : ''}${s.ordering?.pos_service_mode === 'unpaid_service' ? 'Передача на кухню без оплаты и чека.' : 'Сохранение заказа без оплаты.'}</p></footer></aside>`;
}
function sale() {
  const s = model.state;
  if (s.order) return orderDetail();
  const items = availableItems();
  page = Math.min(page, Math.max(0, Math.ceil(items.length / 36) - 1));
  const labels = categoryLabels(s.menu, config.categories),
    categories = [...labels.keys()];
  return `<section class="sale"><div class="catalog"><div class="section-head"><div><span class="eyebrow">МЕНЮ ТОЧКИ</span><h1>Меню</h1></div><button class="subtle" data-action="refresh"${disabled(s.busy)}>Обновить</button></div><div class="catalog-tools"><label for="search" class="sr-only">Поиск блюда</label><input id="search" data-testid="pos-search" type="search" placeholder="Найти блюдо" value="${escape(search)}" /><div class="categories" aria-label="Категории"><button data-category="" aria-pressed="${!category}">Все блюда</button>${categories.map((id) => `<button data-category="${id}" aria-pressed="${category === id}">${escape(labels.get(id))}</button>`).join('')}</div></div>${s.ordering?.ordering_enabled === false ? '<div class="notice">Приём заказов закрыт. Меню доступно для просмотра и подготовки корзины.</div>' : ''}<div class="products" data-testid="pos-products">${
    items
      .slice(page * 36, page * 36 + 36)
      .map(product)
      .join('') ||
    '<div class="empty"><h3>Блюда не найдены</h3><p>Проверьте поиск или загрузите меню локального узла.</p></div>'
  }</div><div class="pagination"><span>Позиций: ${items.length} · меню v${s.menu?.version ?? '-'}</span>${items.length > 36 ? `<button data-page="${page - 1}"${disabled(!page)}>Назад</button><span>${page + 1} / ${Math.ceil(items.length / 36)}</span><button data-page="${page + 1}"${disabled((page + 1) * 36 >= items.length)}>Дальше</button>` : ''}</div></div>${cart()}</section>`;
}
function orderDetail() {
  const s = model.state;
  return orderView(
    s.order!,
    Boolean(s.busy || s.pending),
    s.operationsAt ? `Обновлено ${almatyTime(s.operationsAt)}` : '',
  );
}
function orders() {
  const s = model.state;
  const visibleOrders = s.orders.filter(
    (order) =>
      orderFilter === 'all' ||
      (orderFilter === 'kitchen' &&
        ['accepted', 'in_production'].includes(order.fulfillment_state)) ||
      (orderFilter === 'ready' && order.fulfillment_state === 'ready') ||
      (orderFilter === 'done' &&
        (order.state === 'cancelled' || order.fulfillment_state === 'handed_over')),
  );

  return `<section class="page"><div class="section-head"><div><span class="eyebrow">ЗАКАЗЫ НА ЛОКАЛЬНОМ УЗЛЕ</span><h1>Заказы</h1></div><button class="subtle" data-action="operations-refresh"${disabled(s.busy)}>Обновить</button></div>${s.operationsError ? `<div class="notice">Ленту не удалось обновить. ${s.operationsAt ? 'Ниже сохранённый результат предыдущего запроса.' : 'Проверьте соединение с сервером.'}</div>` : ''}<div class="order-filters" role="group" aria-label="Статус кухни">${[
    ['all', 'Все'],
    ['kitchen', 'На кухне'],
    ['ready', 'Готовы'],
    ['done', 'Завершены'],
  ]
    .map(
      ([key, label]) =>
        `<button class="subtle" data-order-filter="${key}" aria-pressed="${orderFilter === key}">${label}</button>`,
    )
    .join(
      '',
    )}</div><div class="order-feed" data-testid="pos-order-feed">${visibleOrders.map((o) => `<button class="order-row" data-open="${o.order_id}"${disabled(s.busy || s.pending)}><span class="order-row-main"><strong>Заказ ${orderNumber(o)}</strong><small>${almatyDate(o.created_at)} · ${almatyTime(o.created_at).slice(0, 5)} · ${o.snapshot.service_mode === 'dine_in' ? 'В зале' : 'С собой'}</small></span><span class="order-row-meta"><span class="order-badge ${o.fulfillment_state}">${kitchenLabel(o)}</span><strong>${money(o.snapshot.total_minor)}</strong></span></button>`).join('') || `<div class="empty-state"><h2>${s.operationsAvailable ? 'Пока нет заказов' : 'Загружаем заказы'}</h2><p>Сохранённые сервером заказы появятся здесь.</p></div>`}</div><p class="fine">Последние 100 доступных заказов. ${s.actor?.role === 'shift_manager' ? 'Заказы точки.' : 'Ваши заказы на этом терминале.'}${s.operationsAt ? ` Обновлено ${almatyTime(s.operationsAt)}.` : ''}</p><details class="order-search-details" data-detail-key="order-search"><summary>Найти заказ по номеру UUID</summary><form id="find-order" class="search-order"><label class="sr-only" for="order-id">UUID заказа</label><input id="order-id" placeholder="UUID заказа" required /><button class="primary"${disabled(s.busy || s.pending)}>Открыть</button></form>${s.known.length ? `<p class="fine">Сохранённые ссылки этого рабочего места</p><div class="order-list">${s.known.map((id) => `<button data-open="${id}"${disabled(s.busy || s.pending)}>${escape(id)} →</button>`).join('')}</div>` : ''}</details></section>`;
}
function shiftPanel(shift: CashShift) {
  return `<div class="shift-stats"><div><small>Заказов</small><strong>${shift.order_count}</strong></div><div><small>Ожидают оплаты</small><strong>${shift.awaiting_payment_count}</strong></div><div><small>Отменено</small><strong>${shift.cancelled_count}</strong></div><div><small>Сумма заказов</small><strong>${money(shift.order_total_minor)}</strong></div></div><div class="state-line"><span>Наличные при открытии</span><strong>${money(shift.opening_cash_minor)}</strong></div><div class="state-line"><span>Ожидается в кассе</span><strong>${money(shift.expected_cash_minor)}</strong></div>${shift.counted_cash_minor !== null ? `<div class="state-line"><span>Пересчитано при закрытии</span><strong>${money(shift.counted_cash_minor)}</strong></div><div class="state-line"><span>Расхождение</span><strong>${shift.discrepancy_minor?.startsWith('-') ? '-' : ''}${money((shift.discrepancy_minor ?? '0').replace('-', ''))}</strong></div>` : ''}`;
}
function shifts() {
  const s = model.state,
    shift = s.shift,
    locked = s.busy || s.pending || s.storageBlocked;
  return `<section class="page"><div class="section-head"><div><span class="eyebrow">КАССОВАЯ СМЕНА</span><h1>${shift ? 'Смена открыта' : 'Управление сменой'}</h1></div><button class="subtle" data-action="operations-refresh"${disabled(s.busy)}>Обновить</button></div>${s.operationsError ? '<div class="notice error">Состояние смены не удалось обновить. Проверьте соединение перед действием.</div>' : ''}<section class="panel shift-panel" data-testid="pos-shift-panel"><div class="section-head"><div><h2>${shift ? `Смена ${idShort(shift.shift_id)}` : s.operationsAvailable ? 'Смена закрыта' : 'Проверяем состояние смены'}</h2><p>${shift ? `Открыта ${almatyDate(shift.opened_at)} в ${almatyTime(shift.opened_at)}` : 'Перед работой укажите пересчитанный остаток наличных.'}</p></div><div class="shift-actions">${shift ? `<button class="danger" data-action="close-shift" data-testid="pos-close-shift"${disabled(locked || s.operationsError)}>Закрыть смену</button>` : `<button class="primary" data-action="open-shift" data-testid="pos-open-shift"${disabled(locked || !s.operationsAvailable || s.operationsError)}>Открыть смену</button>`}</div></div>${shift ? shiftPanel(shift) : ''}<p class="fine">Открытие смены сохраняется на сервере. Приём заказов включается отдельно; банк и фискальная смена ККМ пока не подключены.</p></section><h2>Последние смены</h2><div class="order-feed">${s.shifts.map((item) => `<details class="panel shift-history" data-detail-key="${item.shift_id}"><summary><strong>${almatyDate(item.opened_at)} · ${almatyTime(item.opened_at).slice(0, 5)}</strong><span>${item.state === 'open' ? 'Открыта' : 'Закрыта'} · ${item.order_count} заказов</span></summary>${shiftPanel(item)}${item.closing_reason ? `<p>Комментарий: ${escape(item.closing_reason)}</p>` : ''}</details>`).join('') || '<p class="muted">История смен пока пуста.</p>'}</div></section>`;
}
function status() {
  const s = model.state;
  return `<section class="page"><span class="eyebrow">РАБОЧЕЕ МЕСТО</span><h1>Подключение и доступ</h1><div class="status-grid"><section class="panel"><h2>Локальный узел</h2><div class="state-line"><span>Последний ответ</span><strong>${s.connectedAt ? new Date(s.connectedAt).toLocaleTimeString('ru-RU') : 'Не подтверждён'}</strong></div><div class="state-line"><span>Приём заказов</span><strong>${s.ordering ? (s.ordering.ordering_enabled ? 'Открыт' : 'Закрыт') : 'Не проверен'}</strong></div><div class="state-line"><span>Меню</span><strong>${s.menu ? `Версия ${s.menu.version}, ${s.menu.items.length} позиций` : 'Не получено'}</strong></div><button class="primary" data-action="refresh"${disabled(s.busy)}>Проверить узел</button>${s.actor?.role === 'shift_manager' && s.ordering ? `<button class="subtle" data-action="ordering"${disabled(s.busy || s.pending)}>${s.ordering.ordering_enabled ? 'Закрыть' : 'Открыть'} приём неоплаченных заказов</button><p class="fine">Это не открытие или закрытие смены ККМ.</p>` : ''}</section><section class="panel"><h2>Оборудование и сеть</h2>${[
    ['Интернет (WAN)', 'Не измеряется'],
    ['Банк / терминал', 'Не подключён'],
    ['ККМ / принтер', 'Не подключены'],
    [
      'Кухня',
      s.ordering?.pos_service_mode === 'unpaid_service'
        ? 'Передача заказов включена'
        : 'Передача отключена',
    ],
    ['Облачная синхронизация', 'Здесь не измеряется'],
  ]
    .map(([a, b]) => `<div class="state-line"><span>${a}</span><strong>${b}</strong></div>`)
    .join(
      '',
    )}<p class="fine">Доступность локального API не доказывает доступность банка или интернета. При потере LAN новый заказ не завершается.</p></section><section class="panel"><h2>Сессия сотрудника</h2><p>Точка: ${escape(s.actor?.branch_id)}</p><p>Терминал: ${escape(s.actor?.terminal_id)}</p><p>Доступ до ${new Date(s.actor!.expires_at).toLocaleString('ru-RU')}</p><p class="fine">После истечения нужен новый приватный файл сессии. Журнал неизвестного запроса сохранится для того же сотрудника и терминала.</p></section></div></section>`;
}
let renderedView = '';
function render() {
  const nextView = `${model.state.actor?.session_id ?? 'login'}:${view}:${Boolean(model.state.order)}`;
  const preserve = nextView === renderedView;
  const scroll = ['.products', '.categories', '.cart-lines', '.page', '.order-detail'].map(
    (selector) => {
      const node = preserve ? root.querySelector(selector) : null;
      return { selector, top: node?.scrollTop ?? 0, left: node?.scrollLeft ?? 0 };
    },
  );
  const details = preserve
    ? [...root.querySelectorAll<HTMLElement>('[data-detail-key][open]')].map(
        (n) => n.dataset.detailKey,
      )
    : [];
  const inputs = preserve
    ? [
        ...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          'input:not([type="file"]):not([data-sensitive]),textarea',
        ),
      ].map((n) => ({ id: n.id, value: n.value }))
    : [];
  const active = document.activeElement as HTMLInputElement | null;
  const focus = active?.id,
    start = active?.selectionStart,
    end = active?.selectionEnd;
  root.innerHTML = !model.state.actor
    ? login()
    : `${toolbar()}<div class="workspace">${navigation()}<main class="main">${notice()}${view === 'orders' ? orders() : view === 'shifts' ? shifts() : view === 'status' ? status() : sale()}</main></div>`;
  for (const input of inputs) {
    const node = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${input.id}`);
    if (node) node.value = input.value;
  }
  for (const node of root.querySelectorAll<HTMLElement>('[data-detail-key]')) {
    if (details.includes(node.dataset.detailKey)) node.setAttribute('open', '');
  }
  for (const item of scroll) {
    const node = root.querySelector(item.selector);
    if (node) {
      node.scrollTop = item.top;
      node.scrollLeft = item.left;
    }
  }
  renderedView = nextView;
  if (focus) {
    const target = document.getElementById(focus) as HTMLInputElement | null;
    if (target && target.type !== 'file') {
      target.focus({ preventScroll: true });
      if (start !== null && start !== undefined && ['text', 'search'].includes(target.type))
        target.setSelectionRange(start, end ?? start);
    }
  }
}
function loadVisible() {
  const ids = availableItems()
    .slice(page * 36, page * 36 + 36)
    .map((i) => i.variant_id)
    .filter((id) => !model.state.stops.has(id));
  if (ids.length) void model.loadStops(ids);
}
function reasonDialog(title: string, action: (reason: string) => Promise<void>) {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<form method="dialog"><h2>${escape(title)}</h2><label for="reason">Причина</label><textarea id="reason" data-testid="pos-reason" required maxlength="300" rows="3" placeholder="Укажите причину"></textarea><div class="dialog-actions"><button type="button" data-dismiss>Назад</button><button class="danger" type="submit" data-testid="pos-confirm">Подтвердить</button></div></form>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('[data-dismiss]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.querySelector('form')!.addEventListener('submit', (event) => {
    event.preventDefault();
    const reason = dialog.querySelector('textarea')!.value.trim();
    if (reason) {
      dialog.close();
      void action(reason);
    }
  });
}
function reviewDialog() {
  const quote = model.state.quote;
  if (!quote || model.state.pending || model.state.busy) return;
  const admission = model.state.ordering?.pos_service_mode === 'unpaid_service';
  const dialog = document.createElement('dialog');
  dialog.className = 'review-dialog';
  dialog.dataset.testid = 'pos-review';
  dialog.setAttribute('aria-labelledby', 'review-title');
  dialog.innerHTML = confirmationView(quote, admission);
  document.body.append(dialog);
  const update = () => {
    const expired =
      Date.parse(quote.expires_at) <= Date.now() || model.state.quote?.quote_id !== quote.quote_id;
    const button = dialog.querySelector<HTMLButtonElement>('[data-testid=pos-create]')!;
    button.disabled =
      expired || !model.hasConfirmedOpenShift || model.state.busy || Boolean(model.state.pending);
    const message = dialog.querySelector('[data-quote-error]')!;
    message.textContent = expired
      ? 'Расчёт истёк. Вернитесь к заказу и проверьте его ещё раз.'
      : !model.hasConfirmedOpenShift
        ? 'Для передачи заказа нужна подтверждённая открытая смена.'
        : '';
  };
  update();
  const timer = window.setInterval(update, 1000);
  dialog.showModal();
  dialog.querySelector('[data-dismiss]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener(
    'close',
    () => {
      window.clearInterval(timer);
      dialog.remove();
    },
    { once: true },
  );
  dialog.addEventListener('submit', (event) => {
    event.preventDefault();
    update();
    if (dialog.querySelector<HTMLButtonElement>('[data-testid=pos-create]')!.disabled) return;
    dialog.close();
    void model.create(admission);
  });
}
function modifierDialog(item: Item, previousKey?: string) {
  const existing = model.state.draft?.items.find((line) => lineKey(line) === previousKey);
  const groups = [...(item.modifier_groups ?? [])].sort(
    (a, b) => Number(b.min_selected > 0) - Number(a.min_selected > 0),
  );
  let selected: Selection[] = existing?.modifiers
    ? structuredClone(existing.modifiers)
    : groups.flatMap((group) =>
        group.options
          .filter((option) => option.available !== false && (option.default_quantity ?? 0) > 0)
          .map((option) => ({
            group_id: group.id,
            option_id: option.id,
            quantity: option.default_quantity!,
          })),
      );
  let count = existing?.quantity ?? 1;
  const dialog = document.createElement('dialog');
  dialog.className = 'modifier-dialog';
  dialog.setAttribute('aria-labelledby', 'modifier-title');
  dialog.dataset.testid = 'pos-modifier-dialog';
  function groupCount(groupId: string) {
    return selected
      .filter((s) => s.group_id === groupId)
      .reduce((sum, s) => sum + (s.quantity ?? 1), 0);
  }
  function draw(focusId?: string) {
    const scrollTop = dialog.scrollTop;
    let error = selected.length > 100 ? 'В одной позиции допустимо до 100 разных добавок.' : '';
    for (const group of groups) {
      if (groupCount(group.id) < group.min_selected) {
        error = `«${group.name.ru}»: выберите ${group.min_selected === group.max_selected ? group.min_selected : `от ${group.min_selected} до ${group.max_selected}`}.`;
        break;
      }
    }
    let unit = BigInt(item.price_minor);
    for (const selection of selected) {
      const option = groups
        .find((g) => g.id === selection.group_id)
        ?.options.find((o) => o.id === selection.option_id);
      if (!option || option.available === false)
        error = 'Одна из добавок недоступна. Измените состав.';
      if (option) unit += BigInt(option.price_minor) * BigInt(selection.quantity ?? 1);
    }
    const tooLarge = unit * BigInt(count) > 9223372036854775807n;
    if (tooLarge) error = 'Превышен допустимый итог заказа.';
    dialog.innerHTML = `<form method="dialog"><header class="modifier-heading">${item.image_url ? `<img src="${escape(item.image_url)}" alt="" />` : ''}<div><h2 id="modifier-title">${escape(item.name.ru)}</h2><p>Базовая цена ${money(item.price_minor)}. Доплаты показаны у вариантов.</p></div></header>${groups
      .map(
        (group) =>
          `<fieldset class="modifier-group"><legend>${escape(group.name.ru)}</legend><p data-testid="pos-modifier-count-${group.id}">${group.min_selected ? `Обязательно: ${group.min_selected === group.max_selected ? group.min_selected : `${group.min_selected}-${group.max_selected}`}` : `По желанию, до ${group.max_selected}`} · Выбрано ${groupCount(group.id)}</p><div class="modifier-options">${group.options
            .map((option) => {
              const qty =
                selected.find((s) => s.group_id === group.id && s.option_id === option.id)
                  ?.quantity ??
                (selected.some((s) => s.group_id === group.id && s.option_id === option.id)
                  ? 1
                  : 0);
              const max = option.max_quantity ?? 1,
                full = groupCount(group.id) >= group.max_selected;
              return `<div class="modifier-option ${qty ? 'selected' : ''} ${option.available === false ? 'disabled' : ''}" data-testid="pos-modifier-${option.id}"><button class="option-name" type="button" id="option-${option.id}" data-option="${option.id}" data-group="${group.id}" aria-pressed="${qty > 0}"${disabled(option.available === false || (max > 1 && (qty >= max || full)) || (max === 1 && !qty && full && group.max_selected > 1))}><span>${escape(option.name.ru)}</span><small>${option.available === false ? 'Недоступно' : option.price_minor === '0' ? 'Без доплаты' : `+ ${money(option.price_minor)}`}</small></button>${max > 1 ? `<div class="option-quantity"><button type="button" id="minus-${option.id}" data-option="${option.id}" data-group="${group.id}" data-delta="-1" aria-label="Уменьшить ${escape(option.name.ru)}"${disabled(!qty)}>-</button><strong>${qty}</strong><button type="button" id="plus-${option.id}" data-option="${option.id}" data-group="${group.id}" data-delta="1" aria-label="Добавить ${escape(option.name.ru)}"${disabled(qty >= max || full || option.available === false)}>+</button></div>` : ''}</div>`;
            })
            .join('')}</div></fieldset>`,
      )
      .join(
        '',
      )}<div class="modifier-summary"><span>Количество порций</span><div class="line-controls"><button type="button" data-portions="${count - 1}"${disabled(count <= 1)} aria-label="Уменьшить порции">-</button><strong>${count}</strong><button type="button" data-portions="${count + 1}"${disabled(count >= 99)} aria-label="Увеличить порции">+</button></div><strong data-testid="pos-modifier-total">${tooLarge ? '-' : money((unit * BigInt(count)).toString())}</strong></div><div class="modifier-error" role="status">${escape(error)}</div><footer class="dialog-actions"><button type="button" data-dismiss>Назад</button><button class="primary" type="submit" data-testid="pos-modifier-confirm"${disabled(error || model.state.busy || model.state.pending)}>${previousKey ? 'Сохранить состав' : 'Добавить в заказ'}</button></footer></form>`;
    dialog.scrollTop = scrollTop;
    if (focusId) dialog.querySelector<HTMLElement>(`#${focusId}`)?.focus({ preventScroll: true });
  }
  draw();
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener(
    'close',
    () => {
      dialog.remove();
      root.querySelector<HTMLButtonElement>(`[data-add="${item.variant_id}"]`)?.focus();
    },
    { once: true },
  );
  dialog.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-dismiss')) {
      dialog.close();
      return;
    }
    if (button.dataset.portions) {
      count = Number(button.dataset.portions);
      draw();
      return;
    }
    const group = groups.find((g) => g.id === button.dataset.group),
      option = group?.options.find((o) => o.id === button.dataset.option);
    if (!group || !option) return;
    const current = selected.find((s) => s.group_id === group.id && s.option_id === option.id);
    let quantity = (current?.quantity ?? (current ? 1 : 0)) + Number(button.dataset.delta ?? 1);
    if (!button.dataset.delta && (option.max_quantity ?? 1) === 1) {
      quantity = current ? 0 : 1;
      if (group.max_selected === 1) selected = selected.filter((s) => s.group_id !== group.id);
    }
    selected = selected.filter((s) => !(s.group_id === group.id && s.option_id === option.id));
    if (quantity > 0) selected.push({ group_id: group.id, option_id: option.id, quantity });
    draw(button.id);
  });
  dialog.addEventListener('submit', (event) => {
    event.preventDefault();
    if (model.state.busy || model.state.pending) return;
    model.configure(item.variant_id, selected, count, previousKey);
    if (!model.state.error) dialog.close();
    else dialog.querySelector('.modifier-error')!.textContent = errorMessage(model.state.error);
  });
}
function shiftDialog(shift?: CashShift) {
  const dialog = document.createElement('dialog');
  dialog.className = 'shift-dialog';
  dialog.setAttribute('aria-labelledby', 'shift-dialog-title');
  dialog.innerHTML = `<form method="dialog"><div><span class="eyebrow">${shift ? 'ЗАКРЫТИЕ' : 'ОТКРЫТИЕ'} СМЕНЫ</span><h2 id="shift-dialog-title">${shift ? 'Пересчитайте наличные' : 'Остаток в кассе'}</h2></div>${shift ? `<p>Ожидается ${money(shift.expected_cash_minor)}. Заказов в смене: ${shift.order_count}. Неоплаченные заказы сохранят свои статусы.</p>` : '<p>Укажите фактические наличные на начало работы. Открытие смены не включает приём заказов.</p>'}<label for="shift-cash">${shift ? 'Пересчитано наличных, ₸' : 'Наличные при открытии, ₸'}</label><input class="money-input" id="shift-cash" data-testid="pos-shift-cash" inputmode="decimal" type="text" required autocomplete="off" placeholder="0,00" maxlength="19" />${shift ? '<label for="shift-reason">Комментарий к закрытию</label><textarea id="shift-reason" data-testid="pos-shift-reason" required maxlength="300" rows="3" placeholder="Результат пересчёта или причина расхождения"></textarea>' : ''}<div class="modifier-error" role="alert"></div><footer class="dialog-actions"><button type="button" data-dismiss>Назад</button><button type="submit" class="${shift ? 'danger' : 'primary'}" data-testid="pos-shift-confirm">${shift ? 'Закрыть смену' : 'Открыть смену'}</button></footer></form>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('[data-dismiss]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const amount = inputMoney(dialog.querySelector<HTMLInputElement>('#shift-cash')!.value);
      const reason = dialog.querySelector<HTMLTextAreaElement>('#shift-reason')?.value.trim() ?? '';
      if (shift && !reason) throw new Error('INVALID_REQUEST');
      if (model.state.busy || model.state.pending) throw new Error('PENDING');
      dialog.close();
      void (shift ? model.closeShift(shift.shift_id, amount, reason) : model.openShift(amount));
    } catch (error) {
      dialog.querySelector('.modifier-error')!.textContent = errorMessage(error);
    }
  });
}
root.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!button || button.disabled) return;
  if (button.dataset.view) {
    view = button.dataset.view;
    if (view === 'sale' && model.state.order) {
      model.newDraft();
      return;
    }
    render();
    if (view === 'orders' || view === 'shifts') void model.refreshOperations();
    return;
  }
  if (button.dataset.orderFilter) {
    orderFilter = button.dataset.orderFilter;
    render();
    return;
  }
  if (button.dataset.category !== undefined) {
    category = button.dataset.category;
    page = 0;
    render();
    loadVisible();
    return;
  }
  if (button.dataset.page) {
    page = Number(button.dataset.page);
    render();
    loadVisible();
    return;
  }
  if (button.dataset.add) {
    const item = model.state.menu?.items.find((i) => i.variant_id === button.dataset.add);
    if (item?.modifier_groups?.length) modifierDialog(item);
    else if (item)
      model.quantity(
        item.variant_id,
        (model.state.draft?.items.find((i) => lineKey(i) === item.variant_id)?.quantity ?? 0) + 1,
      );
    return;
  }
  if (button.dataset.edit) {
    const line = model.state.draft?.items.find((i) => lineKey(i) === button.dataset.edit);
    const item = model.state.menu?.items.find((i) => i.variant_id === line?.variant_id);
    if (item && line) modifierDialog(item, button.dataset.edit);
    return;
  }
  if (button.dataset.quantity) {
    model.quantity(button.dataset.quantity, Number(button.dataset.count));
    return;
  }
  if (button.dataset.mode) {
    model.mode(button.dataset.mode as 'dine_in' | 'takeaway');
    return;
  }
  if (button.dataset.open) {
    view = 'sale';
    void model.openOrder(button.dataset.open);
    return;
  }
  if (button.dataset.stop) {
    const id = button.dataset.stop,
      stopped = !model.state.stops.get(id)?.stopped;
    reasonDialog(stopped ? 'Добавить в стоп-лист' : 'Снять стоп', (reason) =>
      model.setStop(id, stopped, reason),
    );
    return;
  }
  switch (button.dataset.action) {
    case 'password-toggle': {
      const input = root.querySelector<HTMLInputElement>('#staff-password');
      if (!input) break;
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.textContent = visible ? 'Скрыть' : 'Показать';
      button.setAttribute('aria-label', visible ? 'Скрыть пароль' : 'Показать пароль');
      button.setAttribute('aria-pressed', String(visible));
      input.focus({ preventScroll: true });
      break;
    }
    case 'fullscreen':
      void toggleFullscreen();
      break;
    case 'operations-refresh':
      void model.refreshOperations();
      break;
    case 'open-shift':
      shiftDialog();
      break;
    case 'close-shift':
      if (model.state.shift) shiftDialog(model.state.shift);
      break;
    case 'logout':
      model.logout();
      if (requiresNativeJournal && !model.state.actor) nativeJournal().endSession();
      break;
    case 'refresh':
      void model.refresh();
      break;
    case 'calculate':
      void model.calculate().then(() => {
        if (model.state.quote && !model.state.error) reviewDialog();
      });
      break;
    case 'recover':
      void model.recover();
      break;
    case 'new':
      view = 'sale';
      model.newDraft();
      break;
    case 'cancel':
      reasonDialog('Отменить неоплаченный заказ', (reason) => model.cancel(reason));
      break;
    case 'ordering':
      void model.setOrdering(!model.state.ordering?.ordering_enabled);
      break;
  }
});
root.addEventListener('input', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'staff-login') loginName = input.value;
  if (input.id === 'search') {
    search = input.value;
    page = 0;
    render();
    loadVisible();
  }
});
root.addEventListener('change', async (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'staff-file' && input.files?.[0]) {
    const file = input.files[0];
    input.value = '';
    if (file.size > 10000) {
      await model.login('invalid');
      return;
    }
    let content: string;
    try {
      content = await file.text();
    } catch {
      await model.login('invalid');
      return;
    }
    await model.login(content);
  }
});
root.addEventListener('submit', (event) => {
  if ((event.target as HTMLFormElement).id === 'password-login') {
    event.preventDefault();
    const input = root.querySelector<HTMLInputElement>('#staff-password')!;
    loginName = root.querySelector<HTMLInputElement>('#staff-login')!.value;
    const password = input.value;
    input.value = '';
    input.type = 'password';
    void model.signIn(loginName, password, config.terminalId).then(() => {
      if (!model.state.actor) root.querySelector<HTMLInputElement>('#staff-password')?.focus();
    });
    return;
  }
  if ((event.target as HTMLFormElement).id === 'find-order') {
    event.preventDefault();
    const id = (document.getElementById('order-id') as HTMLInputElement).value.trim();
    view = 'sale';
    void model.openOrder(id);
  }
});
model.subscribe(render);
render();
try {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (response.ok) config = (await response.json()) as typeof config;
} catch {
  /* Display labels do not change branch authority. */
}
configLoaded = true;
await model.boot();
render();

root.addEventListener(
  'error',
  (event) => {
    const image = event.target;
    if (image instanceof HTMLImageElement && image.classList.contains('product-image')) {
      image.hidden = true;
      image.parentElement?.classList.add('photo-unavailable');
    }
  },
  true,
);
windowBridge?.onChange?.((value) => {
  fullscreen = value;
  updateClock();
});
document.addEventListener('fullscreenchange', () => {
  void syncFullscreen();
});
window.addEventListener('focus', () => {
  void syncFullscreen();
});
window.setInterval(updateClock, 1000);
window.setInterval(() => {
  if (!document.hidden) void model.refreshOperations();
}, 15000);
window.setInterval(() => {
  if (!document.hidden) void model.syncMenu();
}, 3000);
void syncFullscreen();
