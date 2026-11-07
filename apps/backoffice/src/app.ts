import { DevicesModel } from './devices-model.js';
import { DeviceAccessView } from './components/DeviceAccessView.js';
import { KioskIncidentsModel } from './kiosk-incidents-model.js';
import { KioskIncidentsView } from './components/KioskIncidentsView.js';
import {
  OperationsModel,
  StopsModel,
  discountsAvailable,
  headerRole,
  managerShiftsAvailable,
  permitted,
  posDayAvailable,
  rightsText,
  roleTitle,
  supplyAvailable,
} from './operations-model.js';
import { dirtyDialogOpen } from './dialog-guard.js';
import { cards, dash, ui } from './ui-fixes.js';
import { WorkforceModel } from './workforce-model.js';
import { WorkforceView } from './workforce.js';
import { ManagerShiftView } from './manager-shift.js';
import { DiscountsPage } from './discounts.js';
import { DISCOUNTS_SECTION } from './discounts-model.js';
import { SupplyPage } from './supply.js';
import { SUPPLY_SECTION, suppliersView, supplyRequestsView } from './supply-model.js';
import { staffPositions } from './staff-positions-model.js';
import { FinanceModel } from './finance-model.js';
import { FinanceView } from './finance.js';
import { OperationsView, POS_SECTION, sections } from './operations.js';
import { CatalogModel } from './model.js';
import { ApiError, transport, message, staffAuth } from './api.js';
import {
  aggregatorPriceLine,
  copy,
  deliveryText,
  hasAggregatorPrice,
  money,
  publicationCopy,
} from './domain.js';
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
// Lane bo-ui «Касса»: #pos opens only once the server reports capabilities.pos_day.
let wantPos = location.hash === '#pos';
// Lane bo-ui step 7 «Скидки»: #discounts opens only once the server reports capabilities.discounts.
let wantDiscounts = location.hash === '#discounts';
// Lane bo-ui2 step 2 «Закупки»: #supply opens only once the server reports capabilities.supply.
let wantSupply = location.hash === '#supply';
/**
 * The sections of this server: `sections`, plus «Касса» after «Заказы» while pos_day is on,
 * «Закупки» after «Остатки» while supply is on and «Скидки» after «Промо и баннеры» while
 * discounts is on.
 */
const allSections = (): readonly (readonly [string, string, string])[] => {
  let list: readonly (readonly [string, string, string])[] = posDayAvailable(operations.data)
    ? [...sections.slice(0, 2), POS_SECTION, ...sections.slice(2)]
    : sections;
  if (supplyAvailable(operations.data)) {
    const at = list.findIndex((s) => s[0] === 'stock') + 1;
    list = [...list.slice(0, at), SUPPLY_SECTION, ...list.slice(at)];
  }
  if (!discountsAvailable(operations.data)) return list;
  const at = list.findIndex((s) => s[0] === 'promo') + 1;
  return [...list.slice(0, at), DISCOUNTS_SECTION, ...list.slice(at)];
};
let cashierJournalOpen = false;
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
const devices = new DevicesModel((path, request) => model.operations(path, request), softRender);
const deviceView = new DeviceAccessView(devices);
// Audit 19.10, finding 4.3: kiosks stuck on an unknown QR payment, on the devices page.
const incidents = new KioskIncidentsModel(
  (path, request) => model.operations(path, request),
  softRender,
);
const incidentView = new KioskIncidentsView(incidents);
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
const workforce = new WorkforceModel(
  (path, request) => model.operations(path, request),
  window.sessionStorage,
  render,
);
const workforceView = new WorkforceView(workforce, render);
// Lane bo-ui: the audit fixes (F05 read errors) and the rights in words (F03, F09); both return
// what the cabinet showed before while the server has neither roles nor the audit fixes.
finance.fixes = workforce.fixes = () => operations.fixes;
financeView.rights = () => rightsText(operations.data, 'finance.write');
workforceView.rights = () => rightsText(operations.data, 'workforce.write');
// Lane bo-ui step 6: staff positions on the «Сотрудники» tab, only with capabilities.staff_positions.
workforceView.positions = () => ({
  list: staffPositions(operations.data),
  may: operations.data !== null && permitted(operations.data, 'staff.positions'),
  rights: rightsText(operations.data, 'staff.positions'),
  roster: () => operations.staffRoster(),
  savePositions: async (command, reason) => {
    try {
      if (await operations.execute(command, reason)) return null;
      return message(operations.error);
    } catch (e) {
      return message(e);
    }
  },
});
// Lane bo-ui step 6 «Смена менеджера» on the «Смены» page, only with capabilities.manager_shifts.
const managerShift = new ManagerShiftView({
  load: (date) => operations.managerShifts(date),
  execute: async (command, reason) => {
    try {
      if (await operations.execute(command, reason)) return null;
      return message(operations.error);
    } catch (e) {
      return message(e);
    }
  },
  can: (permission) => operations.data !== null && permitted(operations.data, permission),
  rights: (permission) => rightsText(operations.data, permission),
  employees: () =>
    (operations.data?.records ?? [])
      .filter((r) => r.kind === 'employee' && r.payload['active'] && !r.payload['deleted'])
      .map((r) => ({ value: r.id, label: String(r.payload['name']) })),
  toStock: () => {
    page = 'stock';
    history.replaceState(null, '', '#stock');
    render();
  },
  scope: () => `${operations.actor}:${operations.branch}`,
  changed: () => softRender(),
});
// Lane bo-ui step 7 «Скидки», only with capabilities.discounts (the POS does not apply them yet).
const discountPage = new DiscountsPage({
  load: (id) => operations.discounts(id),
  execute: async (command, reason) => {
    try {
      if (await operations.execute(command, reason)) return null;
      return operations.error ?? new ApiError('PENDING');
    } catch (e) {
      return e;
    }
  },
  can: (permission) => operations.data !== null && permitted(operations.data, permission),
  rights: (permission) => rightsText(operations.data, permission),
  scope: () => `${operations.actor}:${operations.branch}`,
  changed: () => softRender(),
});
// Lane bo-ui2 step 2 «Закупки», only with capabilities.supply (the system sends nothing).
const supplyPage = new SupplyPage({
  suppliers: async (id) => {
    const out = await operations.opsView('suppliers', id ? { id } : {});
    return suppliersView(out.value, out.branch);
  },
  requests: async (q) => {
    const out = await operations.opsView('supply-requests', q as Record<string, string>);
    return supplyRequestsView(out.value, out.branch);
  },
  execute: async (command, reason) => {
    try {
      if (await operations.execute(command, reason)) return null;
      return operations.error ?? new ApiError('PENDING');
    } catch (e) {
      return e;
    }
  },
  can: (permission) => operations.data !== null && permitted(operations.data, permission),
  rights: (permission) => rightsText(operations.data, permission),
  stock: () => operations.data?.stock ?? [],
  refreshStock: async () => {
    if (model.actor && model.state) await operations.load(model.actor.id, model.state.branch.id);
  },
  scope: () => `${operations.actor}:${operations.branch}`,
  changed: () => softRender(),
});
function syncOperations() {
  if (!model.actor) {
    workforce.clear();
    workforceView.clear();
    managerShift.clear();
    discountPage.clear();
    supplyPage.clear();
    finance.clear();
    financeView.clear();
    operations.clear();
    stops.clear();
    devices.clear();
    document.querySelectorAll<HTMLDialogElement>('.op-dialog').forEach((d) => {
      d.close();
      d.remove();
    });
    return;
  }
  const branch = model.state?.branch.id;
  if (branch && (devices.actor !== model.actor.id || devices.branch !== branch)) devices.clear();
  if (
    branch &&
    page === 'devices' &&
    (devices.actor !== model.actor.id || devices.branch !== branch)
  )
    void devices.load(model.actor.id, branch);
  if (branch && (incidents.actor !== model.actor.id || incidents.branch !== branch))
    incidents.clear();
  if (
    branch &&
    page === 'devices' &&
    (incidents.actor !== model.actor.id || incidents.branch !== branch)
  )
    void incidents.load(model.actor.id, branch);
  // Cutover CC-5: a shift manager sees neither the finance ledger nor rates and payroll.
  const reads = (permission: string) => !operations.data || permitted(operations.data, permission);
  if (branch && reads('finance.read')) void finance.scope(model.actor.id, branch);
  if (branch && (page === 'shifts' || workforce.actor) && reads('workforce.read'))
    void workforce.scope(model.actor.id, branch);
  if (branch && (operations.actor !== model.actor.id || operations.branch !== branch))
    void operations.load(model.actor.id, branch);
  if (branch && page === 'stoplist' && (stops.actor !== model.actor.id || stops.branch !== branch))
    void stops.load(model.actor.id, branch);
}
setInterval(() => {
  const branch = model.state?.branch.id;
  if (
    page === 'devices' &&
    model.actor &&
    branch &&
    !devices.busy &&
    document.visibilityState !== 'hidden'
  )
    void devices.load(model.actor.id, branch);
}, 3000);
setInterval(() => {
  const branch = model.state?.branch.id;
  if (
    page === 'devices' &&
    model.actor &&
    branch &&
    !incidents.busy &&
    document.visibilityState !== 'hidden'
  )
    void incidents.load(model.actor.id, branch);
}, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') devices.hideCode();
});
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
/** Audit F07: the pages whose data follows the header period (with the audit fixes). */
const PERIOD_PAGES = ['dash', 'orders', 'reports', 'shifts'];
function render() {
  if (page !== 'devices') devices.hideCode();
  // Lane bo-ui audit fixes: one switch for every view (ui-fixes.ts), and a root class for CSS.
  ui.fixes = Boolean(model.actor) && operations.fixes;
  document.documentElement.classList.toggle('bo-fixes', ui.fixes);
  if (!model.actor) {
    login();
    return;
  }
  if (wantPos && operations.data) {
    wantPos = false;
    if (posDayAvailable(operations.data)) page = 'pos';
  }
  if (page === 'pos' && operations.data && !posDayAvailable(operations.data)) page = 'dash';
  if (wantDiscounts && operations.data) {
    wantDiscounts = false;
    if (discountsAvailable(operations.data)) page = 'discounts';
  }
  if (page === 'discounts' && operations.data && !discountsAvailable(operations.data))
    page = 'dash';
  if (wantSupply && operations.data) {
    wantSupply = false;
    if (supplyAvailable(operations.data)) page = 'supply';
  }
  if (page === 'supply' && operations.data && !supplyAvailable(operations.data)) page = 'dash';
  const shell = el('div', 'shell'),
    sidebar = el('aside', 'sidebar'),
    brand = el('div', 'brand');
  brand.append(image('logo.png', 'PickChick'), el('small', '', 'Управление рестораном'));
  sidebar.append(brand);
  const primary = ['dash', 'orders', 'pos', 'items', 'stoplist', 'shifts', 'reports', 'finance'];
  const navigation = el('nav', 'navigation');
  navigation.setAttribute('aria-label', 'Разделы кабинета');
  const appendLinks = (container: HTMLElement, list: (readonly [string, string, string])[]) => {
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
          if (workforce.pending) return;
          if (
            workforceView.dirty &&
            !window.confirm('Отменить несохранённый ввод в табеле или графике?')
          )
            return;
          workforceView.clear();
          if (finance.pending && page === 'finance') return;
          financeView.clear();
          page = id;
          if (
            id === 'shifts' &&
            model.actor &&
            model.state &&
            (!operations.data || permitted(operations.data, 'workforce.read'))
          )
            void workforce.scope(model.actor.id, model.state.branch.id);
          history.replaceState(null, '', '#' + id);
          if (id === 'stoplist' && model.actor && model.state)
            void stops.load(model.actor.id, model.state.branch.id);
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
  // Cutover CC-5: sections the role cannot read are not offered (the server answers 403 anyway).
  const visible = (section: readonly [string, string, string]) =>
    section[0] !== 'finance' || !operations.data || permitted(operations.data, 'finance.read');
  appendLinks(
    daily,
    [...allSections()]
      .filter((section) => primary.includes(section[0]) && visible(section))
      .sort((a, b) => primary.indexOf(a[0]) - primary.indexOf(b[0])),
  );
  appendLinks(
    daily,
    [...allSections()].filter((section) => !primary.includes(section[0]) && visible(section)),
  );
  navigation.append(daily);
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
    el('span', 'muted', roleTitle(operations.data) ?? 'Управление рестораном'),
    button(
      'Выйти',
      async () => {
        if (
          workforce.pending &&
          !window.confirm(
            'Результат операции ещё не подтверждён. Запрос сохранён для проверки после следующего входа. Выйти?',
          )
        )
          return;
        if (
          (workforceView.dirty || financeView.dirty) &&
          !window.confirm('Отменить несохранённый ввод и выйти?')
        )
          return;
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
    el(
      'h1',
      '',
      // Audit F17 (with the fixes): the page is called what its menu item is called.
      ui.fixes && page === 'items'
        ? 'Меню и цены'
        : (allSections().find((s) => s[0] === page)?.[1] ?? 'PickChick'),
    ),
    el('p', 'muted', allSections().find((s) => s[0] === page)?.[2] ?? ''),
  );
  header.append(titles);
  // Audit F09: who is signed in, in the header (also on a phone, where the sidebar folds).
  const role = headerRole(operations.data);
  if (role) {
    const chip = el('p', 'header-role', role);
    chip.dataset.testid = 'header-role';
    header.append(chip);
  }
  const branch = select(
    'Точка',
    model.state?.branch.id ?? '',
    model.branches.map((b) => ({ value: b.id, label: b.name })),
    (id) => {
      if (workforce.pending || workforce.busy) return;
      if (
        workforceView.dirty &&
        !window.confirm('Отменить несохранённый ввод в табеле или графике перед сменой точки?')
      ) {
        render();
        return;
      }
      workforceView.clear();
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
    Boolean(finance.pending) ||
    workforce.busy ||
    Boolean(workforce.pending);
  header.append(branch);
  const legacyControls = el('div', 'wf-legacy-controls');
  const periodTarget = page === 'shifts' ? legacyControls : header;
  // «Касса» has its own day and cash desk pickers (audit F07: no period that does nothing);
  // «Скидки» has no period at all.
  if (
    page !== 'items' &&
    page !== 'finance' &&
    page !== 'pos' &&
    page !== 'discounts' &&
    page !== 'supply'
  ) {
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
    const periodField = el('div', 'field header-period');
    periods.setAttribute('role', 'group');
    periods.setAttribute('aria-label', 'Период');
    periodField.append(el('span', 'field-label', 'Период'), periods);
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
    // Audit F07 (with the fixes): no period switch on pages it does not change. Audit F13:
    // «Оплаты и чеки» have one date, the reconciliation day (or their own), not the header one.
    const periodShown = !ui.fixes || PERIOD_PAGES.includes(page);
    if (periodShown) tools.append(periodField);
    else {
      const hint = el(
        'small',
        'muted header-filter-hint',
        page === 'settlements'
          ? 'Дата страницы - день ниже, без выбора периода.'
          : 'Данные на сейчас, без выбора периода.',
      );
      hint.dataset.testid = 'no-period-hint';
      tools.append(hint);
    }
    periodTarget.append(tools);
    if (
      ['dash', 'orders', 'shifts', 'reports', 'settlements'].includes(page) &&
      !(ui.fixes && page === 'settlements')
    ) {
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
        chooser.classList.add('header-shift');
        tools.append(chooser);
      }
    }
    tools.append(refresh);
    if (['dash', 'orders', 'shifts', 'reports', 'settlements'].includes(page)) {
      if (operations.filters.shiftId)
        tools.append(
          el(
            'small',
            'muted header-filter-hint',
            'Выбрана вся смена, независимо от календарного периода.',
          ),
        );
    }
    if (periodShown && (choosingCustom || operations.period === 'custom')) {
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
    if (operations.data && page !== 'shifts')
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
  const hidden = (permission: string) =>
    operations.data !== null && !permitted(operations.data, permission);
  if (page === 'shifts') {
    if (managerShiftsAvailable(operations.data)) managerShift.render(content);
    if (hidden('workforce.read'))
      content.append(
        notice('Табель, ставки и начисления видят управляющий и бухгалтер. Кассовые смены - ниже.'),
      );
    else workforceView.render(content);
    const cashier = el('details', 'panel');
    cashier.open = cashierJournalOpen;
    cashier.addEventListener('toggle', () => {
      if (cashier.isConnected) cashierJournalOpen = cashier.open;
    });
    cashier.append(el('summary', '', 'Кассовые смены и прежний журнал'), legacyControls);
    const cashierContent = el('div');
    operationView.render('shifts', cashierContent);
    cashier.append(cashierContent);
    content.append(cashier);
    return;
  }
  if (page === 'finance') {
    if (hidden('finance.read'))
      content.append(notice('Финансы видят управляющий и бухгалтер точки.', 'notice error'));
    else financeView.render(content);
    return;
  }
  if (page === 'discounts') {
    // A discount command whose answer did not arrive is checked here, before the next one.
    if (operations.pending) {
      const n = notice(
        'Результат прошлой операции ещё не подтверждён. Проверьте его, прежде чем менять скидки.',
      );
      const recover = button(
        'Проверить результат',
        () => void operations.recover().then(() => discountPage.reload()),
        'button primary',
        'dc-recover',
      );
      recover.disabled = operations.busy;
      n.append(recover);
      content.append(n);
    }
    discountPage.render(content);
    return;
  }
  if (page === 'supply') {
    // A command whose answer did not arrive is checked here, before the next one.
    if (operations.pending) {
      const n = notice(
        'Результат прошлой операции ещё не подтверждён. Проверьте его, прежде чем менять заявки и поставщиков.',
      );
      const recover = button(
        'Проверить результат',
        () => void operations.recover().then(() => supplyPage.reload()),
        'button primary',
        'sp-recover',
      );
      recover.disabled = operations.busy;
      n.append(recover);
      content.append(n);
    }
    supplyPage.render(content);
    return;
  }
  if (page === 'devices') {
    deviceView.render(content);
    incidentView.render(content);
    if (!devices.data) operationView.render('devices', content);
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
  const catalogHeads = ['Позиция', 'Категория', 'Цена', 'КБЖУ', 'В меню', 'Действия'];
  for (const text of catalogHeads) tr.append(el('th', '', text));
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
      dash(
        '«Скрыта из меню» — позиция не попадёт в следующую публикацию. Если блюдо временно закончилось, поставьте его на «Стоп» в разделе «Стоп-лист»: стоп действует сразу на кассе, в приложении и киоске и не требует публикации.',
      ),
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
      // Cutover: aggregator prices next to the base price (only where they are in use).
      if (model.state?.publication_support?.aggregator_prices === true || hasAggregatorPrice(p)) {
        const line = el('small', 'muted aggregator-prices', aggregatorPriceLine(p));
        line.dataset.testid = `aggregator-prices-${p.id}`;
        price.append(line);
      }
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
    // Audit F14 (with the fixes): price and buttons stay on a phone screen.
    cards(tableWrap, catalogHeads);
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
        ? dash(
            'Сохранённый черновик ничего не меняет. После публикации приложение и киоск берут новое меню сразу, касса — после подтверждения кассового узла.',
          )
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
  if (
    model.dirty ||
    model.pending ||
    operations.pending ||
    finance.pending ||
    financeView.dirty ||
    workforce.pending ||
    workforceView.dirty ||
    // Audit F01: an open guarded dialog with changes (only with the fixes; see dialog-guard.ts).
    dirtyDialogOpen()
  ) {
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
    page !== 'shifts' &&
    model.actor &&
    operations.branch &&
    !operations.busy &&
    !operations.pending &&
    !document.querySelector('dialog[open]') &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '')
  )
    void operations.load(operations.actor, operations.branch);
}, 60000);
