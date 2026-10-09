import { OperationsModel, StopsModel } from './operations-model.js';
import { FinanceModel } from './finance-model.js';
import { FinanceView } from './finance.js';
import { DevicesModel } from './devices-model.js';
import { DevicesView } from './devices.js';
import { OperationsView, sections } from './operations.js';
import { CatalogModel } from './model.js';
import { transport, message, staffAuth } from './api.js';
import { money, copy, deliveryText, publicationCopy } from './domain.js';
import {
  element as el,
  button,
  field,
  select,
  check,
  image,
  productPhoto,
  navigationIcon,
} from './dom.js';
import { openEditor, emptyProduct, type EditorContext } from './editor.js';
const root = document.querySelector<HTMLDivElement>('#app')!,
  model = new CatalogModel(transport, window.sessionStorage);
let page = sections.some((s) => s[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'dash';
/** «Другие разделы» opened by the user stays open across re-renders (stop list polling). */
let secondaryOpen = false;
const operations = new OperationsModel(
  (path, request) => model.operations(path, request),
  window.sessionStorage,
  render,
);
let renderOnBlur = false;
/** Background refreshes never steal focus from a field the manager is typing in. */
function softRender() {
  const active = document.activeElement;
  if (active && root.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) {
    if (!renderOnBlur) {
      renderOnBlur = true;
      root.addEventListener(
        'focusout',
        () =>
          setTimeout(() => {
            renderOnBlur = false;
            render();
          }, 0),
        { once: true },
      );
    }
    return;
  }
  render();
}
const stops = new StopsModel((path, request) => model.operations(path, request), softRender);
const operationView = new OperationsView(
  operations,
  () => model.payload,
  (section) => {
    page = section;
    render();
  },
  stops,
);
const finance = new FinanceModel(
  (path, request) => model.operations(path, request),
  window.sessionStorage,
  render,
);
const financeView = new FinanceView(finance, render, () => {
  page = 'settlements';
  history.replaceState(null, '', '#settlements');
  render();
});
const devices = new DevicesModel(
  (path, request) => model.operations(path, request),
  () => {
    devicesView.sync();
    softRender();
  },
);
const devicesView: DevicesView = new DevicesView(devices, () => ({
  rows: operations.data?.devices,
  role: operations.data?.role,
}));
function syncOperations() {
  if (!model.actor) {
    devicesView.close();
    devices.clear();
    finance.clear();
    financeView.clear();
    operations.clear();
    stops.clear();
    document.querySelectorAll<HTMLDialogElement>('.op-dialog').forEach((d) => {
      d.close();
      d.remove();
    });
    return;
  }
  const branch = model.state?.branch.id;
  if (branch) void finance.scope(model.actor.id, branch);
  if (branch && (operations.actor !== model.actor.id || operations.branch !== branch))
    void operations.load(model.actor.id, branch);
  if (branch && page === 'stoplist' && (stops.actor !== model.actor.id || stops.branch !== branch))
    void stops.load(model.actor.id, branch);
  if (
    branch &&
    page === 'devices' &&
    (devices.actor !== model.actor.id || devices.branch !== branch)
  )
    void devices.scope(model.actor.id, branch);
}
/**
 * Devices page: countdown every second; registry refresh every 3 s while a pairing code waits
 * for the iPad, otherwise every 15 s, only while the page is open and the tab is visible.
 */
setInterval(() => {
  const branch = model.state?.branch.id;
  if (page !== 'devices' || !model.actor || !branch || document.visibilityState === 'hidden')
    return;
  devicesView.tick();
  if (
    devices.actor === model.actor.id &&
    devices.branch === branch &&
    !devices.busy &&
    Date.now() - devices.loadedAt >= devices.nextDelay()
  )
    void devices.load();
}, 1000);
/**
 * Stop list polling: every 2 s while a command waits for the cashier, otherwise every 10 s,
 * only while the stop list is open and the tab is visible.
 */
setInterval(() => {
  const branch = model.state?.branch.id;
  if (
    page === 'stoplist' &&
    model.actor &&
    branch &&
    !stops.busy &&
    document.visibilityState !== 'hidden' &&
    Date.now() - stops.loadedAt >= stops.nextDelay()
  )
    void stops.load(model.actor.id, branch);
}, 500);
/** Catalog page: refresh the cashier delivery status while it waits for the cashier. */
setInterval(() => {
  if (
    page === 'items' &&
    model.actor &&
    !model.busy &&
    !model.pending &&
    document.visibilityState !== 'hidden' &&
    model.state?.edge_delivery?.status === 'pending' &&
    !document.querySelector('dialog[open]') &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '')
  )
    void model.refreshStatus();
}, 10000);

let choosingCustom = false;
let customStart = '';
let customEnd = '';
let query = '',
  category = '',
  localError = '';
const action = (fn: () => void) => {
  try {
    localError = '';
    fn();
  } catch (error) {
    localError = message(error);
    render();
  }
};
function notice(text: string, kind = 'notice') {
  const n = el('div', kind, text);
  n.setAttribute('role', kind.includes('error') ? 'alert' : 'status');
  return n;
}
let staffMode: boolean | null = null;
let loginBusy = false;
function login() {
  const page = el('main', 'login-page'),
    card = el('section', 'login-card');
  const intro = el('section', 'login-intro');
  intro.append(
    image('logo.png', 'PickChick'),
    el('h2', '', 'Ресторан под контролем.'),
    el('p', '', 'Финансы, меню и работа команды в одном кабинете.'),
  );
  page.append(intro);
  card.append(
    el('h1', '', 'Кабинет директора'),
    el(
      'p',
      'muted',
      staffMode
        ? 'Войдите в свой аккаунт, чтобы работать с финансами и управлять рестораном.'
        : 'Вход по личному файлу доступа управляющего. Список доступных точек проверяет сервер.',
    ),
  );
  if (staffMode === null) {
    card.append(notice(localError || 'Проверяем подключение…'));
    if (localError) card.append(button('Повторить', () => void bootAccess(), 'button primary'));
    page.append(card);
    root.replaceChildren(page);
    return;
  }
  if (staffMode) {
    const form = el('form', 'login-form');
    const username = el('input');
    username.name = 'username';
    username.autocomplete = 'username';
    username.required = true;
    username.autocapitalize = 'none';
    username.spellcheck = false;
    username.maxLength = 80;
    const password = el('input');
    password.name = 'password';
    password.type = 'password';
    password.autocomplete = 'current-password';
    password.required = true;
    password.maxLength = 256;
    const userLabel = el('label', 'field');
    userLabel.append(el('span', 'field-label', 'Логин'), username);
    const passLabel = el('label', 'field');
    passLabel.append(el('span', 'field-label', 'Пароль'), password);
    const show = button(
      'Показать пароль',
      () => {
        password.type = password.type === 'password' ? 'text' : 'password';
        show.textContent = password.type === 'password' ? 'Показать пароль' : 'Скрыть пароль';
        show.setAttribute('aria-pressed', String(password.type === 'text'));
      },
      'login-reveal',
    );
    show.setAttribute('aria-pressed', 'false');
    const submit = el('button', 'button primary', loginBusy ? 'Входим…' : 'Войти');
    submit.type = 'submit';
    submit.disabled = loginBusy;
    form.append(userLabel, passLabel, show, submit);
    const errorBox = notice('', 'notice error');
    errorBox.hidden = true;
    form.append(errorBox);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (loginBusy) return;
      loginBusy = true;
      submit.disabled = true;
      submit.textContent = 'Входим…';
      errorBox.hidden = true;
      try {
        await staffAuth('login', { username: username.value.trim(), password: password.value });
        password.value = '';
        await model.login(JSON.stringify({ token: 'session' }));
      } catch (error) {
        errorBox.textContent = message(error);
        errorBox.hidden = false;
        password.focus();
      } finally {
        loginBusy = false;
        submit.disabled = false;
        submit.textContent = 'Войти';
        if (!model.actor && !form.isConnected) render();
      }
    });
    card.append(
      form,
      el(
        'p',
        'muted',
        'Доступ только для сотрудников PickChick. После работы на общем устройстве нажмите «Выйти».',
      ),
    );
    if (model.error) card.append(notice(message(model.error), 'notice error'));
    page.append(card);
    root.replaceChildren(page);
    return;
  }
  const label = el('label', 'field');
  label.append(el('span', 'field-label', 'Файл доступа (.json)'));
  const input = el('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.dataset.testid = 'credential-file';
  input.disabled = model.busy;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 20000) {
      localError = 'Файл доступа слишком большой.';
      render();
      return;
    }
    localError = '';
    await model.login(await file.text());
  });
  label.append(input);
  card.append(
    label,
    el(
      'p',
      'muted',
      'Доступ хранится только в этой вкладке браузера. После работы нажмите «Выйти». Токен не добавляется в адрес страницы.',
    ),
  );
  if (model.error || localError)
    card.append(notice(localError || message(model.error), 'notice error'));
  if (model.busy) card.append(notice('Проверяем доступ…'));
  page.append(card);
  root.replaceChildren(page);
}
function render() {
  if (!model.actor) {
    login();
    return;
  }
  const shell = el('div', 'shell'),
    sidebar = el('aside', 'sidebar'),
    brand = el('div', 'brand');
  brand.append(image('logo.png', 'PickChick'), el('small', '', 'Управление рестораном'));
  sidebar.append(brand);
  const primary = ['dash', 'orders', 'items', 'stoplist', 'shifts', 'reports', 'finance'];
  const navigation = el('nav', 'navigation');
  navigation.setAttribute('aria-label', 'Разделы кабинета');
  const appendLinks = (container: HTMLElement, list: (typeof sections)[number][]) => {
    for (const [id, label] of list) {
      const nav = button(
        id === 'items'
          ? 'Меню и цены'
          : id === 'shifts'
            ? 'Смены'
            : id === 'finance'
              ? 'Финансы'
              : label,
        () => {
          if (
            financeView.dirty &&
            !window.confirm('Сохранённый на сервере журнал останется. Отменить незавершённый ввод?')
          )
            return;
          if (finance.pending && page === 'finance') return;
          financeView.clear();
          page = id;
          secondaryOpen = false;
          history.replaceState(null, '', '#' + id);
          if (id === 'stoplist' && model.actor && model.state)
            void stops.load(model.actor.id, model.state.branch.id);
          if (id === 'devices' && model.actor && model.state)
            void devices.scope(model.actor.id, model.state.branch.id);
          render();
        },
        `nav-item ${page === id ? 'active' : ''}`,
        'nav-' + id,
      );
      nav.prepend(navigationIcon(id));
      if (page === id) nav.setAttribute('aria-current', 'page');
      container.append(nav);
    }
  };
  const daily = el('div', 'nav-primary');
  appendLinks(
    daily,
    [...sections]
      .filter((section) => primary.includes(section[0]))
      .sort((a, b) => primary.indexOf(a[0]) - primary.indexOf(b[0])),
  );
  const secondary = el('details', 'nav-secondary');
  secondary.open = !primary.includes(page) || secondaryOpen;
  secondary.addEventListener('toggle', () => {
    if (secondary.isConnected) secondaryOpen = secondary.open;
  });
  secondary.append(el('summary', '', 'Другие разделы'));
  appendLinks(
    secondary,
    [...sections].filter((section) => !primary.includes(section[0])),
  );
  navigation.append(daily, secondary);
  navigation.id = 'cabinet-navigation';
  const menuToggle = button(
    'Разделы кабинета',
    () => {
      const open = navigation.classList.toggle('is-open');
      menuToggle.setAttribute('aria-expanded', String(open));
    },
    'mobile-navigation-toggle',
    'navigation-toggle',
  );
  menuToggle.prepend(navigationIcon('items'));
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-controls', navigation.id);
  sidebar.append(menuToggle, navigation);
  const user = el('div', 'user');
  user.append(
    el('strong', '', model.actor.name),
    el('span', 'muted', 'Управление рестораном'),
    button(
      'Выйти',
      async () => {
        if (financeView.dirty && !window.confirm('Отменить несохранённый ввод и выйти?')) return;
        try {
          if (staffMode) await staffAuth('logout');
          model.logout();
        } catch (error) {
          localError = message(error);
          render();
        }
      },
      'button subtle',
      'logout',
    ),
  );
  sidebar.append(user);
  const main = el('main', 'workspace'),
    header = el('header', 'topbar'),
    titles = el('div', 'page-title');
  titles.append(
    el('h1', '', sections.find((s) => s[0] === page)?.[1] ?? 'PickChick'),
    el('p', 'muted', sections.find((s) => s[0] === page)?.[2] ?? ''),
  );
  header.append(titles);
  const branch = select(
    'Точка',
    model.state?.branch.id ?? '',
    model.branches.map((b) => ({ value: b.id, label: b.name })),
    (id) => {
      if (
        financeView.dirty &&
        !window.confirm('Отменить несохранённую финансовую операцию перед сменой точки?')
      ) {
        render();
        return;
      }
      financeView.clear();
      if (model.dirty && !window.confirm('Отменить локальные правки перед сменой точки?')) {
        render();
        return;
      }
      void model.selectBranch(id, model.dirty);
    },
    'branch-select',
  );
  branch.querySelector('select')!.disabled =
    model.busy ||
    Boolean(model.pending) ||
    operations.busy ||
    Boolean(operations.pending) ||
    finance.busy ||
    Boolean(finance.pending);
  header.append(branch);
  if (page !== 'items' && page !== 'finance' && page !== 'devices') {
    const periods = el('div', 'op-periods');
    for (const [id, label] of [
      ['day', 'Сегодня'],
      ['yesterday', 'Вчера'],
      ['week', 'Неделя'],
      ['month', 'Месяц'],
      ['quarter', 'Квартал'],
      ['year', 'Год'],
      ['custom', 'Период'],
    ]) {
      const b = button(
        label!,
        () => {
          if (id === 'custom') {
            if (!choosingCustom) {
              customStart = operations.filters.startDate ?? '';
              customEnd = operations.filters.endDate ?? '';
            }
            choosingCustom = true;
            render();
          } else {
            choosingCustom = false;
            void operations.load(operations.actor, operations.branch, id, {});
          }
        },
        operations.period === id ? 'selected' : '',
        'period-' + id,
      );
      b.setAttribute('aria-pressed', String(operations.period === id));
      b.disabled = operations.busy || Boolean(operations.pending);
      periods.append(b);
    }
    const tools = el('div', 'header-tools');
    const refresh = button(
      operations.busy ? 'Обновляем...' : 'Обновить',
      () => {
        void operations.load(operations.actor, operations.branch);
        if (page === 'stoplist' && model.actor && model.state)
          void stops.load(model.actor.id, model.state.branch.id);
      },
      'button subtle',
      'op-refresh',
    );
    refresh.disabled = operations.busy || Boolean(operations.pending);
    tools.append(periods, refresh);
    header.append(tools);
    if (['dash', 'orders', 'shifts', 'reports', 'settlements'].includes(page)) {
      const shifts = operations.data?.cashier_shifts ?? [];
      if (shifts.length) {
        const chooser = select(
          'Кассовая смена',
          operations.filters.shiftId ?? '',
          [
            { value: '', label: 'Все смены - по календарю' },
            ...shifts.map((shift) => ({
              value: String(shift['id']),
              label:
                new Date(String(shift['opened_at'])).toLocaleString('ru-RU', {
                  timeZone: 'Asia/Almaty',
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                }) +
                (shift['state'] === 'open' ? ' - открыта' : ' - закрыта') +
                ' · ' +
                String(shift['id']).slice(0, 6),
            })),
          ],
          (id) => {
            const filters = { ...operations.filters };
            if (id) filters.shiftId = id;
            else delete filters.shiftId;
            void operations.load(operations.actor, operations.branch, operations.period, filters);
          },
          'cashier-shift-select',
        );
        chooser.querySelector('select')!.disabled = operations.busy || Boolean(operations.pending);
        tools.append(chooser);
      }
      if (operations.filters.shiftId)
        tools.append(
          el('small', 'muted', 'Выбрана вся смена, независимо от календарного периода.'),
        );
    }
    if (choosingCustom || operations.period === 'custom') {
      const dates = el('form', 'date-range');
      const start = field(
        'С даты',
        choosingCustom ? customStart : (operations.filters.startDate ?? ''),
        (value) => {
          customStart = value;
          choosingCustom = true;
        },
        {
          id: 'period-start',
        },
      );
      const end = field(
        'По дату',
        choosingCustom ? customEnd : (operations.filters.endDate ?? ''),
        (value) => {
          customEnd = value;
          choosingCustom = true;
        },
        {
          id: 'period-end',
        },
      );
      const startInput = start.querySelector('input')!;
      const endInput = end.querySelector('input')!;
      startInput.type = endInput.type = 'date';
      startInput.required = endInput.required = true;
      const apply = button(
        'Показать',
        () => {
          endInput.min = startInput.value;
          if (dates.reportValidity())
            void operations.load(operations.actor, operations.branch, 'custom', {
              startDate: startInput.value,
              endDate: endInput.value,
            });
        },
        'button primary',
        'period-apply',
      );
      startInput.disabled =
        endInput.disabled =
        apply.disabled =
          operations.busy || Boolean(operations.pending);
      dates.addEventListener('submit', (event) => {
        event.preventDefault();
        apply.click();
      });
      dates.append(start, end, apply);
      tools.append(dates);
    }
    if (operations.data)
      titles.append(
        el(
          'small',
          'muted',
          'Данные на ' +
            new Date(operations.data.as_of).toLocaleTimeString('ru-RU', {
              timeZone: 'Asia/Almaty',
              hour: '2-digit',
              minute: '2-digit',
            }),
        ),
      );
  }
  main.id = 'workspace';
  main.append(header);
  const content = el('div', 'content');
  main.append(content);
  shell.append(sidebar, main);
  root.replaceChildren(shell);
  if (page === 'finance') {
    financeView.render(content);
    return;
  }
  if (page === 'devices') {
    devicesView.render(content, model.state?.branch.name ?? '');
    return;
  }
  if (page !== 'items') {
    operationView.render(page === 'settlements' ? 'finance' : page, content);
    return;
  }
  if (model.error || localError)
    content.append(notice(localError || message(model.error), 'notice error'));
  if (model.pending) {
    const n = notice(
      'Результат запроса ещё не подтверждён. Правки и исходный request ID сохранены в этой вкладке.',
    );
    const retry = button(
      'Проверить результат',
      () => void model.recover(),
      'button primary',
      'recover',
    );
    retry.disabled = model.busy;
    n.append(retry);
    content.append(n);
  }
  if (model.conflict) {
    const n = notice(
      'На сервере уже другая ревизия. Ваш вариант сохранён в этой вкладке. Можно скопировать правки из карточек или явно загрузить серверный черновик.',
    );
    n.append(
      button(
        'Загрузить серверную версию',
        () => {
          if (
            window.confirm(
              'Отказаться от локальных правок и загрузить актуальный серверный черновик?',
            )
          )
            void model.reload(true);
        },
        'button',
        'resolve-conflict',
      ),
    );
    content.append(n);
  }
  if (!model.state) {
    content.append(
      notice(model.busy ? 'Загружаем каталог…' : 'У этого доступа нет доступных точек.'),
    );
    return;
  }
  const stats = el('div', 'stats');
  for (const [value, label] of [
    [String(model.payload?.products.length ?? 0), 'Позиций в черновике'],
    [String(model.payload?.categories.length ?? 0), 'Категорий'],
    [model.state.draft ? `r${model.state.draft.revision}` : 'Нет', 'Серверный черновик'],
    [model.state.published ? `v${model.state.published.version}` : 'Нет', 'Опубликованная версия'],
  ]) {
    const s = el('div', 'stat');
    s.append(el('span', 'muted', label), el('strong', '', value));
    stats.append(s);
  }
  content.append(stats);
  content.append(channelStatus());
  if (!model.payload) {
    const empty = el('section', 'panel empty');
    if (model.state.publication_support?.mobile) {
      empty.append(
        el('h2', '', 'Действующий каталог недоступен'),
        el(
          'p',
          'muted',
          'Для этой точки нужен явный импорт действующего каталога. Обновите данные или обратитесь к администратору.',
        ),
      );
      content.append(empty);
      return;
    }
    empty.append(
      el('h2', '', 'Черновик ещё не создан'),
      el(
        'p',
        'muted',
        'Создайте исходный каталог из 24 позиций макета. КБЖУ и сведения об аллергенах будут отмечены как непроверенные.',
      ),
    );
    const seed = button(
      'Создать черновик из макета',
      () => void model.seed(),
      'button primary',
      'seed',
    );
    seed.disabled = model.busy || Boolean(model.pending);
    empty.append(seed);
    content.append(empty);
    return;
  }
  const panel = el('section', 'panel'),
    toolbar = el('div', 'panel-toolbar');
  toolbar.append(el('h2', '', 'Позиции'));
  const filters = el('div', 'filters'),
    search = field(
      'Поиск',
      query,
      (v) => {
        query = v;
        rows();
      },
      { id: 'catalog-search', max: 150 },
    );
  search.querySelector('input')!.placeholder = 'Название, артикул или ID';
  filters.append(
    search,
    select(
      'Категория',
      category,
      [
        { value: '', label: 'Все категории' },
        ...model.payload.categories.map((c) => ({ value: c.id, label: c.name.ru })),
      ],
      (v) => {
        category = v;
        rows();
      },
      'category-filter',
    ),
  );
  const add = button(
    'Добавить позицию',
    () =>
      openEditor(
        emptyProduct(model.payload!),
        model.payload!,
        (p) => model.updateProduct(p),
        true,
        editorContext(),
      ),
    'button',
    'add-product',
  );
  add.disabled = model.busy || Boolean(model.pending);
  toolbar.append(add);
  panel.append(toolbar, filters);
  const tableWrap = el('div', 'table-scroll');
  tableWrap.tabIndex = 0;
  tableWrap.setAttribute('aria-label', 'Таблица позиций, горизонтальная прокрутка');
  const table = el('table'),
    thead = el('thead'),
    tr = el('tr');
  for (const text of ['Позиция', 'Категория', 'Цена', 'КБЖУ', 'В меню', 'Действия'])
    tr.append(el('th', '', text));
  thead.append(tr);
  const tbody = el('tbody');
  tbody.dataset.testid = 'catalog-products';
  table.append(thead, tbody);
  tableWrap.append(table);
  panel.append(tableWrap);
  const count = el('p', 'table-count');
  panel.append(
    count,
    el(
      'p',
      'muted table-help',
      '«Скрыта из меню» — позиция не попадёт в следующую публикацию. Если блюдо временно закончилось, поставьте его на «Стоп» в разделе «Стоп-лист»: стоп действует сразу на кассе, в приложении и киоске и не требует публикации.',
    ),
  );
  content.append(panel);
  function rows() {
    tbody.replaceChildren();
    const products = model.payload!.products.filter(
      (p) =>
        (!category || p.category_id === category) &&
        [p.id, p.sku, p.name.ru, p.name.kk]
          .join(' ')
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    );
    for (const p of products) {
      const row = el('tr');
      row.dataset.testid = `product-${p.id}`;
      const name = el('td'),
        identity = el('div', 'product-identity'),
        words = el('div');
      words.append(
        el('strong', '', p.name.ru),
        el('small', 'muted', p.name.kk || 'KZ: перевод не добавлен'),
        el('small', 'muted', p.sku),
      );
      identity.append(
        productPhoto(p, '', (sha) => model.mediaUrl(sha)),
        words,
      );
      name.append(identity);
      const categoryName =
          model.payload!.categories.find((c) => c.id === p.category_id)?.name.ru ?? p.category_id,
        price = el('td', 'price', money(p.price_minor)),
        nutrition = el('td');
      nutrition.append(
        el('span', '', `${p.nutrition.energy_kcal} ккал`),
        el(
          'small',
          'muted',
          `Б ${p.nutrition.protein_g} · Ж ${p.nutrition.fat_g} · У ${p.nutrition.carbs_g}`,
        ),
        el('small', 'muted', p.nutrition.basis === 'per_serving' ? 'На порцию' : 'На 100 г'),
      );
      const availability = el('td');
      availability.append(
        el(
          'span',
          `badge ${p.available ? 'good' : 'muted'}`,
          p.available ? 'В меню' : 'Скрыта из меню',
        ),
      );
      if (p.image) availability.append(el('small', 'muted', 'Своё фото'));
      const controls = el('td'),
        edit = button(
          'Изменить',
          () =>
            openEditor(p, model.payload!, (v) => model.updateProduct(v), false, editorContext()),
          'button small',
          `edit-${p.id}`,
        ),
        remove = button(
          'Удалить',
          () => {
            if (
              window.confirm(
                `Удалить «${p.name.ru}» из черновика? Прошлые заказы и опубликованный каталог не изменятся до новой публикации.`,
              )
            )
              action(() => model.removeProduct(p.id));
          },
          'button small danger',
          `remove-${p.id}`,
        );
      edit.disabled = remove.disabled = model.busy || Boolean(model.pending);
      const rowActions = el('div', 'row-actions');
      rowActions.append(edit, remove);
      controls.append(rowActions);
      row.append(name, el('td', '', categoryName), price, nutrition, availability, controls);
      tbody.append(row);
    }
    count.textContent = `Показано ${products.length} из ${model.payload!.products.length}`;
    if (!products.length) {
      const row = el('tr'),
        cell = el('td', 'empty', 'По запросу ничего не найдено.');
      cell.colSpan = 6;
      row.append(cell);
      tbody.append(row);
    }
  }
  rows();
  const groups = model.payload.products.flatMap((p) => p.modifier_groups.map((g) => ({ p, g })));
  if (groups.length) {
    const modifierPanel = el('section', 'panel modifier-summary');
    modifierPanel.append(
      el('h2', '', 'Группы модификаторов'),
      el('p', 'muted', 'Настраиваются внутри карточки соответствующей позиции.'),
    );
    const cards = el('div', 'group-grid');
    for (const { p, g } of groups.slice(0, 8)) {
      const c = el('article', 'group-card');
      c.append(
        el('h3', '', g.title.ru),
        el('small', 'muted', p.name.ru),
        el('p', '', `${g.options.length} вариантов · выбрать ${g.min}-${g.max}`),
      );
      cards.append(c);
    }
    modifierPanel.append(cards);
    content.append(modifierPanel);
  }
  const footer = el('footer', 'save-bar'),
    status = el('div');
  status.append(
    el(
      'strong',
      '',
      model.pending
        ? 'Ожидается подтверждение запроса'
        : model.dirty
          ? 'Есть локальные правки'
          : 'Серверный черновик сохранён',
    ),
    el(
      'small',
      'muted',
      model.state.published
        ? `Активная версия v${model.state.published.version}; основа черновика v${model.state.draft?.base_version ?? 0}`
        : 'Опубликованной версии пока нет',
    ),
  );
  const actions = el('div', 'save-actions');
  const reload = button(
      'Обновить',
      () => {
        if (
          !model.dirty ||
          window.confirm('Отменить локальные правки и загрузить серверную версию?')
        )
          void model.reload(model.dirty);
      },
      'button',
      'reload',
    ),
    save = button('Сохранить черновик', () => void model.save(), 'button primary', 'save-draft'),
    publish = button('Опубликовать…', publishDialog, 'button', 'publish-open');
  reload.disabled = model.busy || Boolean(model.pending);
  save.disabled = model.busy || Boolean(model.pending) || !model.dirty || model.conflict;
  publish.disabled = model.busy || Boolean(model.pending) || model.dirty || model.conflict;
  actions.append(reload, save, publish);
  footer.append(status, actions);
  main.append(footer);
  const review = check(
    'Я проверил названия, цены, состав, КБЖУ и настройки вариантов для публикации.',
    model.payload.content_reviewed,
    (v) => action(() => model.reviewContent(v)),
    'content-reviewed',
  );
  review.querySelector('input')!.disabled = model.busy || Boolean(model.pending);
  content.append(
    review,
    el(
      'p',
      'muted review-note',
      'Это подтверждение управляющего. Оно не является сертификацией пищевой ценности. Любое изменение карточки снимает отметку проверки.',
    ),
  );
}
function editorContext(): EditorContext {
  return {
    publicationSupport: model.state?.publication_support,
    mediaUrl: (sha) => model.mediaUrl(sha),
    upload: (file, onProgress) => model.uploadPhoto(file, onProgress),
  };
}
/** Connected channels and the cashier's delivery of the latest publication. */
function channelStatus() {
  const state = model.state!,
    support = state.publication_support;
  const box = el('section', 'channel-status');
  box.dataset.testid = 'channel-status';
  const badges = el('div', 'channel-badges');
  for (const [key, label] of [
    ['mobile', 'Приложение'],
    ['kiosk', 'Киоск'],
    ['pos', 'Касса'],
  ] as const) {
    const on = support?.[key] === true;
    const b = el(
      'span',
      `channel-badge ${on ? 'on' : 'off'}`,
      `${label}: ${on ? 'подключено' : 'не подключено'}`,
    );
    b.dataset.testid = 'channel-' + key;
    badges.append(b);
  }
  box.append(badges);
  const delivery = state.edge_delivery;
  if (delivery && state.published && delivery.catalog_version === state.published.version) {
    const view = deliveryText(delivery, state.published.published_at);
    const line = el('div', `delivery delivery-${view.tone}`);
    line.dataset.testid = 'edge-delivery';
    line.setAttribute('role', 'status');
    line.append(el('strong', '', view.text));
    const details = [`каталог v${delivery.catalog_version}`];
    if (delivery.acknowledged_at)
      details.push(
        'ответ кассы ' +
          new Date(delivery.acknowledged_at).toLocaleString('ru-RU', {
            timeZone: 'Asia/Almaty',
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          }),
      );
    if (delivery.edge_active_version)
      details.push(`сейчас на кассе версия ${delivery.edge_active_version}`);
    line.append(el('small', 'muted', details.join(' · ')));
    box.append(line);
    if (view.warning) {
      const w = notice(view.warning, 'notice error');
      w.dataset.testid = 'edge-delivery-warning';
      box.append(w);
    }
    if (delivery.status === 'rejected')
      box.append(
        el(
          'p',
          'muted',
          'Касса продолжает работать на прежнем меню. Исправьте причину и опубликуйте новую версию; приложение и киоск уже получили эту публикацию.',
        ),
      );
  } else if (support?.pos && state.published) {
    const line = el('div', 'delivery delivery-muted');
    line.dataset.testid = 'edge-delivery';
    line.append(el('strong', '', 'Касса: ещё не получала публикаций из кабинета'));
    box.append(line);
  }
  box.append(
    el(
      'p',
      'muted channel-help',
      support?.mobile || support?.kiosk || support?.pos
        ? 'Сохранённый черновик ничего не меняет. После публикации приложение и киоск берут новое меню сразу, касса — после подтверждения кассового узла.'
        : 'Подключение публикаций к приложению, кассе и киоску ещё не включено. Сохранённый черновик сам по себе не меняет действующее меню.',
    ),
  );
  return box;
}
function publishDialog() {
  const dialog = el('dialog', 'confirm-dialog');
  dialog.dataset.testid = 'publish-dialog';
  const payload = copy(model.payload!),
    state = copy(model.state!);
  dialog.append(
    el('h2', '', 'Опубликовать каталог?'),
    el(
      'p',
      '',
      `${state.branch.name} · черновик r${state.draft?.revision} · ${payload.products.length} позиций`,
    ),
    el(
      'p',
      'muted',
      `Будет создана версия v${(state.published?.version ?? 0) + 1}. ` +
        publicationCopy(state.publication_support),
    ),
  );
  dialog.querySelector('p.muted')!.setAttribute('data-testid', 'publish-copy');
  if (!payload.content_reviewed)
    dialog.append(
      notice('Сначала отметьте проверку содержимого и сохраните черновик.', 'notice error'),
    );
  const close = () => {
      dialog.close();
      dialog.remove();
    },
    cancel = button('Вернуться', close, 'button'),
    confirm = button(
      'Опубликовать версию',
      () => {
        close();
        void model.publish();
      },
      'button primary',
      'publish-confirm',
    );
  confirm.disabled = !payload.content_reviewed;
  dialog.append(cancel, confirm);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  document.body.append(dialog);
  dialog.showModal();
}
model.subscribe(() => {
  syncOperations();
  render();
});
window.addEventListener('beforeunload', (event) => {
  if (model.dirty || model.pending || operations.pending || finance.pending || financeView.dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
async function bootAccess() {
  localError = '';
  render();
  try {
    const session = await staffAuth('session');
    staffMode = session.enabled === true;
    if (staffMode) {
      if (session.authenticated) await model.login(JSON.stringify({ token: 'session' }));
    } else await model.boot();
    render();
  } catch {
    localError = 'Не удалось подключиться. Проверьте интернет и попробуйте снова.';
    render();
  }
}
render();
void bootAccess();

setInterval(() => {
  if (
    page !== 'items' &&
    page !== 'finance' &&
    model.actor &&
    operations.branch &&
    !operations.busy &&
    !operations.pending &&
    !document.querySelector('dialog[open]') &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '')
  )
    void operations.load(operations.actor, operations.branch);
}, 60000);
