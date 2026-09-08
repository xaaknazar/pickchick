import { PosController } from './model.js';
import { transport, errorMessage } from './api.js';
import { money, type Item } from './types.js';

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
const journal = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
  removeItem: (key: string) => localStorage.removeItem(key),
};
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
let config: { branchLabel: string; categories: Record<string, string> } = {
  branchLabel: 'Локальная точка',
  categories: {},
};
const disabled = (condition: unknown) => (condition ? ' disabled' : '');
const idShort = (id: string) => id.slice(0, 8);
function notice() {
  const s = model.state;
  return `${s.error ? `<div class="notice error" role="alert" data-testid="pos-error">${escape(errorMessage(s.error))}</div>` : ''}${s.pending ? `<section class="notice pending" role="status" data-testid="pos-recovery"><div><strong>Проверка сохранённого запроса</strong><p>Результат пока не подтверждён. Новый заказ заблокирован.</p><small>Запрос ${escape(s.pending.key)}</small></div><button data-action="recover"${disabled(s.busy)} data-testid="pos-recover">Проверить результат</button></section>` : ''}`;
}
function login() {
  return `<main class="login"><section class="login-brand"><img src="/logo.png" alt="PickChick" /><div class="eyebrow">РАБОЧЕЕ МЕСТО КАССИРА</div><h1>Ваш заказ.<br />Под контролем.</h1><p>Локальная касса PickChick для персонала ресторана.</p><span class="brand-note">НЕОПЛАЧЕННЫЕ ЛОКАЛЬНЫЕ ЗАКАЗЫ</span></section><section class="login-form"><span class="eyebrow">ВХОД СОТРУДНИКА</span><h2>Подключите сессию</h2><p class="muted">Выберите приватный JSON-файл, который выдал оператор локального узла. Пароль и PIN здесь ещё не используются.</p>${notice()}<label class="file-label" for="staff-file">${model.state.busy ? 'Проверяем доступ…' : 'Выбрать файл сессии'}<input id="staff-file" data-testid="pos-staff-file" type="file" accept=".json,application/json"${disabled(model.state.busy)} /></label><p class="fine">Ключ используется только для запросов к локальному узлу. Вход сохраняется в текущей вкладке до выхода или окончания доступа. При завершении работы нажмите «Выйти».</p><div class="quiet-box"><strong>Сейчас доступно</strong><p>Меню → расчёт на сервере → неоплаченный заказ.</p><small>Оплата, чек, смены ККМ и кухня ещё не подключены.</small></div></section></main>`;
}
function toolbar() {
  const s = model.state,
    actor = s.actor!;
  return `<header class="topbar"><div class="brand"><img src="/logo.png" alt="PickChick" /><div><strong>Касса</strong><small>${escape(config.branchLabel)} · ${idShort(actor.branch_id)}</small></div></div><div class="top-status"><span class="status ${s.connectedAt ? 'online' : 'offline'}" data-testid="pos-connectivity">${s.connectedAt ? `Узел ответил в ${new Date(s.connectedAt).toLocaleTimeString('ru-RU')}` : 'Узел не ответил'}</span><span>${actor.role === 'shift_manager' ? 'Начальник смены' : 'Кассир'} · ${idShort(actor.staff_id)}</span><button class="subtle" data-action="logout"${disabled(s.busy)} data-testid="pos-logout">Выйти</button></div></header>`;
}
function navigation() {
  return `<nav class="nav" aria-label="Касса"><button data-view="sale" aria-current="${view === 'sale' ? 'page' : 'false'}">▦<span>Новый заказ</span></button><button data-view="orders" aria-current="${view === 'orders' ? 'page' : 'false'}">≡<span>Заказы</span></button><button data-view="status" aria-current="${view === 'status' ? 'page' : 'false'}">◉<span>Подключение</span></button><div class="nav-note">Локальный этап<br />Оплата выключена</div></nav>`;
}
function availableItems() {
  const items = model.state.menu?.items ?? [];
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
  return `<article class="product ${stop?.stopped ? 'stopped' : ''}" data-testid="pos-product-${item.variant_id}"><div class="product-symbol" aria-hidden="true">${escape(item.name.ru.slice(0, 1))}<span>PC</span></div><div class="product-body"><small>${escape(config.categories[item.category_id] ?? `Категория ${[...new Set(s.menu!.items.map((i) => i.category_id))].indexOf(item.category_id) + 1}`)}</small><h3>${escape(item.name.ru)}</h3><div class="product-bottom"><strong>${money(item.price_minor)}</strong><button aria-label="Добавить ${escape(item.name.ru)}" data-add="${item.variant_id}"${disabled(blocked)} data-testid="pos-add-${item.variant_id}">+</button></div><span class="availability">${stop ? (stop.stopped ? 'В стоп-листе' : 'Доступно') : 'Доступность проверяется'}</span>${s.actor?.role === 'shift_manager' ? `<button class="stop-action" data-stop="${item.variant_id}"${disabled(s.busy || s.pending || !stop)}>${stop?.stopped ? 'Снять стоп' : 'В стоп-лист'}</button>` : ''}</div></article>`;
}
function cart() {
  const s = model.state,
    d = s.draft,
    locked = s.busy || s.pending || s.storageBlocked;
  let estimate = 0n,
    missing = false;
  const lines = (d?.items ?? [])
    .map((line) => {
      const item = s.menu?.items.find((i) => i.variant_id === line.variant_id);
      if (item) estimate += BigInt(item.price_minor) * BigInt(line.quantity);
      else missing = true;
      return `<div class="cart-line" data-testid="pos-cart-line-${line.variant_id}"><div><h3>${escape(item?.name.ru ?? 'Позиция отсутствует в меню')}</h3><small>${item ? money(item.price_minor) : 'Удалите и выберите заново'}${s.stops.get(line.variant_id)?.stopped ? ' · В стоп-листе' : ''}</small></div><div class="line-controls"><button data-quantity="${line.variant_id}" data-count="${line.quantity - 1}" aria-label="Уменьшить количество"${disabled(locked)}>−</button><strong data-testid="pos-quantity-${line.variant_id}">${line.quantity}</strong><button data-quantity="${line.variant_id}" data-count="${line.quantity + 1}" aria-label="Увеличить количество"${disabled(locked || line.quantity >= 99 || !item || s.stops.get(line.variant_id)?.stopped !== false)}>+</button><button class="remove" data-quantity="${line.variant_id}" data-count="0" aria-label="Убрать ${escape(item?.name.ru ?? 'позицию')}"${disabled(locked)}>×</button></div></div>`;
    })
    .join('');
  const q = s.quote,
    expired = q && Date.parse(q.expires_at) <= Date.now();
  return `<aside class="cart" data-testid="pos-cart"><header><div class="eyebrow">КАССА · ЛОКАЛЬНЫЙ ЗАКАЗ</div><h2>Новый заказ <span>${d?.items.reduce((n, i) => n + i.quantity, 0) ?? 0}</span></h2><div class="segmented"><button data-mode="dine_in" aria-pressed="${d?.service_mode === 'dine_in'}"${disabled(locked)}>В зале</button><button data-mode="takeaway" aria-pressed="${d?.service_mode === 'takeaway'}"${disabled(locked)}>С собой</button></div></header><div class="cart-lines">${lines || '<div class="empty"><span>＋</span><h3>Выберите блюда</h3><p>Позиции появятся здесь.<br />Состав и цены проверит локальный сервер.</p></div>'}</div><footer data-testid="pos-cart-footer"><div class="total-row"><span>${q ? 'Итого по расчёту' : 'Предварительно'}</span><strong data-testid="pos-total">${missing ? '-' : estimate > 9223372036854775807n ? 'Лимит суммы' : money(q?.total_minor ?? estimate.toString())}</strong></div><p class="fine">${q ? `Расчёт ${expired ? 'истёк - пересчитайте корзину' : `действует до ${new Date(q.expires_at).toLocaleTimeString('ru-RU')}`}` : 'Окончательную сумму вернёт сервер.'}</p><button class="primary" data-action="calculate" data-testid="pos-calculate"${disabled(locked || !d?.items.length || !s.menu || !s.ordering?.ordering_enabled || missing || estimate > 9223372036854775807n)}>Рассчитать заказ</button>${q ? `<button class="orange" data-action="create" data-testid="pos-create"${disabled(locked || expired)}>Создать неоплаченный заказ</button>` : ''}<p class="fine">Деньги не принимаются. Заказ не отправляется на кухню.</p></footer></aside>`;
}
function sale() {
  const s = model.state;
  if (s.order) return orderDetail();
  const items = availableItems();
  page = Math.min(page, Math.max(0, Math.ceil(items.length / 36) - 1));
  const categories = [...new Set(s.menu?.items.map((i) => i.category_id) ?? [])];
  return `<section class="sale"><div class="catalog"><div class="section-head"><div><span class="eyebrow">МЕНЮ ТОЧКИ</span><h1>Что закажем?</h1></div><button class="subtle" data-action="refresh"${disabled(s.busy)}>Обновить</button></div><div class="catalog-tools"><label for="search" class="sr-only">Поиск блюда</label><input id="search" data-testid="pos-search" type="search" placeholder="Найти блюдо" value="${escape(search)}" /><div class="categories" aria-label="Категории"><button data-category="" aria-pressed="${!category}">Все блюда</button>${categories.map((id, n) => `<button data-category="${id}" aria-pressed="${category === id}">${escape(config.categories[id] ?? `Категория ${n + 1}`)}</button>`).join('')}</div></div>${s.ordering?.ordering_enabled === false ? '<div class="notice">Приём неоплаченных заказов закрыт начальником смены.</div>' : ''}<div class="products" data-testid="pos-products">${
    items
      .slice(page * 36, page * 36 + 36)
      .map(product)
      .join('') ||
    '<div class="empty"><h3>Блюда не найдены</h3><p>Проверьте поиск или загрузите меню локального узла.</p></div>'
  }</div><div class="pagination"><span>${items.length} позиций · меню v${s.menu?.version ?? '-'}</span>${items.length > 36 ? `<button data-page="${page - 1}"${disabled(!page)}>Назад</button><span>${page + 1} / ${Math.ceil(items.length / 36)}</span><button data-page="${page + 1}"${disabled((page + 1) * 36 >= items.length)}>Дальше</button>` : ''}</div></div>${cart()}</section>`;
}
function orderDetail() {
  const s = model.state,
    o = s.order!;
  return `<section class="order-detail" data-testid="pos-order"><div class="section-head"><div><span class="eyebrow">ЗАКАЗ СОХРАНЁН НА ЛОКАЛЬНОМ УЗЛЕ</span><h1>${o.state === 'cancelled' ? 'Заказ отменён' : 'Ожидает оплаты'}</h1></div><button class="subtle" data-action="new"${disabled(s.busy || s.pending)}>Новый заказ</button></div><div class="order-id" data-testid="pos-order-id">${escape(o.order_id)}</div><div class="order-columns"><section class="panel"><h2>Состав заказа</h2><p>${o.snapshot.service_mode === 'dine_in' ? 'В зале' : 'С собой'} · ${new Date(o.created_at).toLocaleString('ru-RU')}</p>${o.snapshot.lines.map((l) => `<div class="review-line"><div><strong>${escape(l.name.ru)}</strong><small>${l.quantity} × ${money(l.unit_price_minor)}</small></div><b>${money(l.total_minor)}</b></div>`).join('')}<div class="total-row"><span>Итого</span><strong>${money(o.snapshot.total_minor)}</strong></div></section><section class="panel"><h2>Что дальше</h2><div class="state-line"><span>Оплата</span><strong>Не начата</strong></div><div class="state-line"><span>Фискальный чек</span><strong>Не запрошен</strong></div><div class="state-line"><span>Кухня</span><strong>Заблокирована</strong></div><div class="notice">${o.state === 'cancelled' ? `Причина отмены: ${escape(o.cancellation_reason)}` : 'Платёжный адаптер ещё не подключён. Этот заказ не является оплаченным и не готовится.'}</div><button class="primary" data-open="${o.order_id}"${disabled(s.busy || s.pending)}>Проверить состояние</button>${o.state === 'awaiting_payment' ? `<button class="danger" data-action="cancel" data-testid="pos-cancel"${disabled(s.busy || s.pending)}>Отменить с причиной</button>` : ''}</section></div></section>`;
}
function orders() {
  return `<section class="page"><span class="eyebrow">ЛОКАЛЬНЫЕ ЗАКАЗЫ</span><h1>Найти заказ</h1><p class="muted">По UUID заказа. Доступ проверяет сервер: кассир видит свои заказы своего терминала, начальник смены - заказы точки.</p><form id="find-order" class="search-order"><label class="sr-only" for="order-id">UUID заказа</label><input id="order-id" placeholder="UUID заказа" required /><button class="primary"${disabled(model.state.busy || model.state.pending)}>Открыть</button></form><h2>Известные этому рабочему месту</h2><p class="fine">До 100 ссылок для этого сотрудника и терминала. Это не общая лента каналов и не полный архив.</p><div class="order-list">${model.state.known.map((id) => `<button data-open="${id}"${disabled(model.state.busy || model.state.pending)}><span>${escape(id)}</span><strong>Открыть →</strong></button>`).join('') || '<p class="muted">Сохранённых ссылок пока нет.</p>'}</div></section>`;
}
function status() {
  const s = model.state;
  return `<section class="page"><span class="eyebrow">РАБОЧЕЕ МЕСТО</span><h1>Подключение и доступ</h1><div class="status-grid"><section class="panel"><h2>Локальный узел</h2><div class="state-line"><span>Последний ответ</span><strong>${s.connectedAt ? new Date(s.connectedAt).toLocaleTimeString('ru-RU') : 'Не подтверждён'}</strong></div><div class="state-line"><span>Приём заказов</span><strong>${s.ordering ? (s.ordering.ordering_enabled ? 'Открыт' : 'Закрыт') : 'Не проверен'}</strong></div><div class="state-line"><span>Меню</span><strong>${s.menu ? `Версия ${s.menu.version}, ${s.menu.items.length} позиций` : 'Не получено'}</strong></div><button class="primary" data-action="refresh"${disabled(s.busy)}>Проверить узел</button>${s.actor?.role === 'shift_manager' && s.ordering ? `<button class="subtle" data-action="ordering"${disabled(s.busy || s.pending)}>${s.ordering.ordering_enabled ? 'Закрыть' : 'Открыть'} приём неоплаченных заказов</button><p class="fine">Это не открытие или закрытие смены ККМ.</p>` : ''}</section><section class="panel"><h2>Оборудование и сеть</h2>${[
    ['Интернет (WAN)', 'Не измеряется'],
    ['Банк / терминал', 'Не подключён'],
    ['ККМ / принтер', 'Не подключены'],
    ['Кухня и облачная синхронизация', 'Не подключены'],
  ]
    .map(([a, b]) => `<div class="state-line"><span>${a}</span><strong>${b}</strong></div>`)
    .join(
      '',
    )}<p class="fine">Доступность локального API не доказывает доступность банка или интернета. При потере LAN новый заказ не завершается.</p></section><section class="panel"><h2>Сессия сотрудника</h2><p>Точка: ${escape(s.actor?.branch_id)}</p><p>Терминал: ${escape(s.actor?.terminal_id)}</p><p>Доступ до ${new Date(s.actor!.expires_at).toLocaleString('ru-RU')}</p><p class="fine">После истечения нужен новый приватный файл сессии. Журнал неизвестного запроса сохранится для того же сотрудника и терминала.</p></section></div></section>`;
}
function render() {
  const active = document.activeElement as HTMLInputElement | null;
  const focus = active?.id,
    start = active?.selectionStart,
    end = active?.selectionEnd;
  root.innerHTML = !model.state.actor
    ? login()
    : `${toolbar()}<div class="workspace">${navigation()}<main class="main">${notice()}${view === 'orders' ? orders() : view === 'status' ? status() : sale()}</main></div>`;
  if (focus) {
    const target = document.getElementById(focus) as HTMLInputElement | null;
    if (target && target.type !== 'file') {
      target.focus();
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
root.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!button || button.disabled) return;
  if (button.dataset.view) {
    view = button.dataset.view;
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
    const id = button.dataset.add;
    model.quantity(
      id,
      (model.state.draft?.items.find((i) => i.variant_id === id)?.quantity ?? 0) + 1,
    );
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
    case 'logout':
      model.logout();
      break;
    case 'refresh':
      void model.refresh();
      break;
    case 'calculate':
      void model.calculate();
      break;
    case 'create':
      void model.create();
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
await model.boot();
render();
