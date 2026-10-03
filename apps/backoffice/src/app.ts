import { OperationsModel } from './operations-model.js';
import { OperationsView, sections } from './operations.js';
import { CatalogModel } from './model.js';
import { transport, message } from './api.js';
import { money, copy } from './domain.js';
import { element as el, button, field, select, check, image } from './dom.js';
import { openEditor, emptyProduct } from './editor.js';
const root = document.querySelector<HTMLDivElement>('#app')!,
  model = new CatalogModel(transport, window.sessionStorage);
let page = sections.some((s) => s[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'dash';
const operations = new OperationsModel(
  (path, request) => model.operations(path, request),
  window.sessionStorage,
  render,
);
const operationView = new OperationsView(operations, () => model.payload);
function syncOperations() {
  if (!model.actor) {
    operations.clear();
    document.querySelectorAll<HTMLDialogElement>('.op-dialog').forEach((d) => {
      d.close();
      d.remove();
    });
    return;
  }
  const branch = model.state?.branch.id;
  if (branch && (operations.actor !== model.actor.id || operations.branch !== branch))
    void operations.load(model.actor.id, branch);
}

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
function login() {
  const page = el('main', 'login-page'),
    card = el('section', 'login-card');
  card.append(
    image('logo.png', 'PickChick'),
    el('h1', '', 'Кабинет директора'),
    el(
      'p',
      'muted',
      'Вход по личному файлу доступа управляющего. Список доступных точек проверяет сервер.',
    ),
  );
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
  brand.append(
    image('logo.png', ''),
    el('div', '', 'PickChick'),
    el('small', '', 'Кабинет директора'),
  );
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
          page = id;
          history.replaceState(null, '', '#' + id);
          render();
        },
        `nav-item ${page === id ? 'active' : ''}`,
        'nav-' + id,
      );
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
  secondary.open = !primary.includes(page);
  secondary.append(el('summary', '', 'Другие разделы'));
  appendLinks(
    secondary,
    [...sections].filter((section) => !primary.includes(section[0])),
  );
  navigation.append(daily, secondary);
  sidebar.append(navigation);
  const user = el('div', 'user');
  user.append(
    el('strong', '', model.actor.name),
    el('span', 'muted', 'Управление рестораном'),
    button('Выйти', () => model.logout(), 'button subtle', 'logout'),
  );
  sidebar.append(user);
  const main = el('main', 'workspace'),
    header = el('header', 'topbar'),
    titles = el('div');
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
      if (model.dirty && !window.confirm('Отменить локальные правки перед сменой точки?')) {
        render();
        return;
      }
      void model.selectBranch(id, model.dirty);
    },
    'branch-select',
  );
  branch.querySelector('select')!.disabled =
    model.busy || Boolean(model.pending) || operations.busy || Boolean(operations.pending);
  header.append(branch);
  if (page !== 'items') {
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
    tools.append(
      periods,
      button(
        'Обновить',
        () => void operations.load(operations.actor, operations.branch),
        'button subtle',
        'op-refresh',
      ),
    );
    header.append(tools);
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
  if (page !== 'items') {
    operationView.render(page, content);
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
  content.append(
    notice(
      'Публикация обновляет каталог нового API. Подключение мобильного приложения, киоска и кассы к нему проходит отдельным этапом; текущие TEST-заказы используют прежний каталог.',
      'notice compact',
    ),
  );
  if (!model.payload) {
    const empty = el('section', 'panel empty');
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
      openEditor(emptyProduct(model.payload!), model.payload!, (p) => model.updateProduct(p), true),
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
  for (const text of ['Позиция', 'Категория', 'Цена', 'КБЖУ', 'Доступность', 'Действия'])
    tr.append(el('th', '', text));
  thead.append(tr);
  const tbody = el('tbody');
  tbody.dataset.testid = 'catalog-products';
  table.append(thead, tbody);
  tableWrap.append(table);
  panel.append(tableWrap);
  const count = el('p', 'table-count');
  panel.append(count);
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
      identity.append(image(p.image_asset_key, ''), words);
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
        el('span', `badge ${p.available ? 'good' : 'muted'}`, p.available ? 'Доступна' : 'Скрыта'),
      );
      const controls = el('td'),
        edit = button(
          'Изменить',
          () => openEditor(p, model.payload!, (v) => model.updateProduct(v)),
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
      `Будет создана версия v${(state.published?.version ?? 0) + 1}. До подключения клиентских приложений их TEST-меню останется прежним.`,
    ),
  );
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
  if (model.dirty || model.pending || operations.pending) {
    event.preventDefault();
    event.returnValue = '';
  }
});
render();
void model.boot();

setInterval(() => {
  if (
    page !== 'items' &&
    model.actor &&
    operations.branch &&
    !operations.busy &&
    !operations.pending &&
    !document.querySelector('dialog[open]') &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '')
  )
    void operations.load(operations.actor, operations.branch);
}, 60000);
