const $ = (selector, context = document) => context.querySelector(selector);
const app = $('#app');
const dialog = $('#task-dialog');
const STATUS = {
  planned: 'В плане',
  active: 'В работе',
  blocked: 'Есть зависимость',
  paused: 'На паузе',
  done: 'Завершено по плану',
};
const OWNERS = {
  development: 'Разработка',
  customer: 'Заказчик',
  joint: 'Совместно',
  provider: 'Поставщик',
};
const RESULTS = { pending: 'Не проверено', passed: 'Пройдено', failed: 'Есть замечания' };
const pluralRules = new Intl.PluralRules('ru');
const countLabel = (count, one, few, many) =>
  `${count} ${{ one, few, many }[pluralRules.select(count)] || many}`;
const FACTS = {
  implemented: 'Реализовано',
  verified: 'Проверено',
  deployed: 'Установлено',
  accepted: 'Принято',
};
const ROUTES = {
  overview: ['Обзор', 'grid'],
  directions: ['Направления', 'layers'],
  plan: ['План запуска', 'timeline'],
  checks: ['Проверки', 'check'],
  customer: ['От заказчика', 'users'],
};
const ICONS = {
  grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  layers: ['m12 3 9 5-9 5-9-5 9-5Z', 'm3 12 9 5 9-5M3 16l9 5 9-5'],
  timeline: ['M4 4v16M9 5h11v4H9zM9 12h7v4H9zM9 20h11'],
  check: ['M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10', 'm8 10 4 4L21 4'],
  users: [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.9M16 3a4 4 0 0 1 0 8',
    'M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  ],
  search: ['M21 21l-5-5', 'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0'],
  arrow: ['M5 12h14m-5-5 5 5-5 5'],
  close: ['m6 6 12 12M6 18 18 6'],
  chevron: ['m9 5 7 7-7 7'],
  external: ['M14 3h7v7M21 3l-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5'],
  info: ['M12 11v6M12 7h.01', 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'],
  clock: ['M12 6v6l4 2', 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'],
};
let data;
let view = 'overview';
let online = true;
let lastFetched;
let loading = false;
let deepTaskId;
let lastTaskTrigger;
let lastTaskTriggerId;
const filters = { search: '', status: '', owner: '', workstream: '', phase: '' };

const visibleChildren = (children) =>
  children.flat(Infinity).filter((child) => child != null && typeof child !== 'boolean');
function renderInto(node, ...children) {
  node.replaceChildren(...visibleChildren(children));
}
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, value);
  }
  for (const child of visibleChildren(children))
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function icon(name, size = 17) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, val] of Object.entries({
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }))
    svg.setAttribute(key, val);
  for (const shape of ICONS[name] || ICONS.layers) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', shape);
    svg.append(path);
  }
  return svg;
}
const brand = () =>
  el(
    'div',
    { class: 'brand' },
    el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'P', el('span', {}, 'C')),
    el('div', {}, el('strong', {}, 'PICKCHICK'), el('small', {}, 'Пульт проекта')),
  );
const button = (text, action, kind = 'secondary-button') =>
  el('button', { type: 'button', class: kind, onclick: action }, text);
const badge = (value, type = 'status') =>
  el('span', { class: `badge ${value}` }, (type === 'result' ? RESULTS : STATUS)[value] || value);
const stream = (id) => data.workstreams.find((item) => item.id === id);
const taskById = (id) => data.tasks.find((item) => item.id === id);
const review = (task) => data.state?.reviews?.[task.id] || {};
const status = (task) => (STATUS[review(task).status] ? review(task).status : task.status);
const announce = (text) => {
  $('#announcer').textContent = text;
};
const date = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? '-'
    : new Intl.DateTimeFormat('ru-RU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Almaty',
      }).format(parsed);
};
const safeUrl = (value) => {
  try {
    const url = new URL(value, location.href);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};
const sourceUrl = (path) =>
  `https://github.com/xaaknazar/pickchick/blob/${encodeURIComponent(data.meta?.sourceSha || 'main')}/${String(path).split('/').map(encodeURIComponent).join('/')}`;
function link(label, href, className) {
  const url = safeUrl(href);
  return url
    ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: className }, label)
    : el('span', {}, label);
}
function rememberedName() {
  try {
    return localStorage.getItem('pickchick-roadmap-name') || '';
  } catch {
    return '';
  }
}
function rememberName(value) {
  try {
    localStorage.setItem('pickchick-roadmap-name', value);
  } catch {
    /* The session still works when local storage is unavailable. */
  }
}
async function api(path, options = {}) {
  const response = await fetch(`./api/${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    /* Some errors have no JSON response. */
  }
  if (!response.ok) {
    const error = new Error(body.message || body.error || `Ошибка запроса (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}
function routeFromHash() {
  const [name, params] = location.hash.slice(1).split('?');
  view = ROUTES[name] ? name : 'overview';
  const query = new URLSearchParams(params);
  filters.workstream = query.get('stream') || '';
  filters.phase = query.get('phase') || '';
  deepTaskId = query.get('task');
}
function go(name, options = {}) {
  if (dialog.open) dialog.close();
  filters.search = '';
  filters.status = '';
  filters.owner = '';
  const params = new URLSearchParams(options);
  const hash = `#${name}${params.size ? `?${params}` : ''}`;
  if (location.hash === hash) {
    routeFromHash();
    renderPage();
  } else location.hash = hash;
}
function renderAuth(errorText = '') {
  if (dialog.open) dialog.close();
  const message = el('p', { class: 'form-message', role: 'alert' }, errorText);
  const key = el('input', {
    name: 'key',
    id: 'access-key',
    type: 'password',
    required: '',
    autocomplete: 'current-password',
    placeholder: 'Ключ команды',
  });
  const name = el('input', {
    name: 'name',
    id: 'access-name',
    maxlength: '80',
    autocomplete: 'name',
    value: rememberedName(),
    placeholder: 'Как вас зовут',
  });
  const submit = el(
    'button',
    { class: 'primary-button', type: 'submit' },
    'Открыть пульт проекта',
    icon('arrow'),
  );
  const keyFile = el('input', {
    type: 'file',
    accept: '.txt,text/plain',
    id: 'access-file',
    onchange: async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > 4096) {
        message.textContent = 'Выберите небольшой текстовый файл с ключом доступа.';
        return;
      }
      try {
        key.value = (await file.text()).trim();
        message.textContent = 'Ключ из файла подставлен. Нажмите «Открыть пульт проекта».';
      } catch {
        message.textContent = 'Не удалось прочитать файл. Вставьте ключ в поле выше.';
      }
    },
  });
  const form = el(
    'form',
    {
      class: 'auth-form',
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        message.textContent = '';
        try {
          await api('session', { method: 'POST', body: JSON.stringify({ key: key.value }) });
          rememberName(name.value.trim());
          key.value = '';
          await refresh(true);
        } catch (error) {
          message.textContent =
            error.status === 401
              ? 'Ключ не подошёл. Проверьте его и попробуйте ещё раз.'
              : 'Не удалось войти. Проверьте соединение и попробуйте ещё раз.';
        } finally {
          submit.disabled = false;
        }
      },
    },
    el('div', { class: 'eyebrow' }, 'Рабочее пространство команды'),
    el('h2', {}, 'Всё движется к запуску'),
    el('p', {}, 'План, решения и проверки PickChick в одном месте. Вход по общему ключу команды.'),
    el('label', { class: 'field', for: 'access-key' }, 'Ключ доступа', key),
    el(
      'details',
      { class: 'key-file' },
      el('summary', {}, 'Или выбрать файл с ключом'),
      el('label', { class: 'field', for: 'access-file' }, 'Текстовый файл .txt', keyFile),
    ),
    el(
      'label',
      { class: 'field', for: 'access-name' },
      'Ваше имя',
      name,
      el(
        'small',
        {},
        'Будет подставляться в заметки. Это подпись автора, не личная учётная запись.',
      ),
    ),
    submit,
    message,
  );
  renderInto(
    app,
    el(
      'div',
      { class: 'auth-screen' },
      el(
        'section',
        { class: 'auth-story' },
        brand(),
        el('h1', {}, 'Одна команда.', el('br'), 'Один ', el('span', {}, 'план.')),
        el(
          'p',
          {},
          'От разработки до запуска собственной системы. Видим весь проект и понимаем, какой шаг делать дальше.',
        ),
      ),
      el('div', { class: 'auth-form-wrap' }, form),
    ),
  );
  app.setAttribute('aria-busy', 'false');
}
function renderShell() {
  const nav = el(
    'nav',
    { class: 'primary-nav', 'aria-label': 'Разделы проекта' },
    Object.entries(ROUTES).map(([key, [label, symbol]], index) =>
      el(
        'button',
        {
          type: 'button',
          class: `nav-button${view === key ? ' active' : ''}`,
          'data-route': key,
          onclick: () => go(key),
        },
        icon(symbol),
        label,
        el('span', { class: 'nav-number', 'aria-hidden': 'true' }, `0${index + 1}`),
      ),
    ),
  );
  const footer = el(
    'footer',
    { class: 'sidebar-footer' },
    el('div', {}, 'Связано с репозиторием'),
    link('xaaknazar / pickchick ↗', 'https://github.com/xaaknazar/pickchick'),
    el('div', { id: 'source-version' }),
    button(
      'Выйти из пространства',
      async () => {
        try {
          await api('session', { method: 'DELETE' });
          data = null;
          renderAuth();
        } catch {
          announce('Не удалось выйти. Проверьте соединение.');
        }
      },
      'text-button',
    ),
  );
  renderInto(
    app,
    el(
      'div',
      { class: 'app-shell' },
      el(
        'aside',
        { class: 'sidebar' },
        brand(),
        el('div', { class: 'nav-label' }, 'Проект / запуск'),
        nav,
        el(
          'div',
          { class: 'sidebar-note' },
          el('span', { class: 'mini-label' }, 'План запуска: 4 месяца'),
          el(
            'p',
            {},
            data.project?.t0
              ? `Старт T0: ${date(data.project.t0)}. Приёмку подтверждаем отдельно.`
              : 'Дата старта T0 ещё не согласована. План считаем в относительных неделях.',
          ),
        ),
        footer,
      ),
      el(
        'div',
        { class: 'workspace' },
        el(
          'header',
          { class: 'topbar' },
          el(
            'div',
            { class: 'breadcrumb' },
            'Рабочее пространство',
            el('span', { 'aria-hidden': 'true' }, '/'),
            el('strong', { id: 'breadcrumb-current' }, ROUTES[view][0]),
          ),
          el('div', { id: 'sync-status', class: 'connection', role: 'status' }),
        ),
        el('main', { class: 'main', id: 'main', tabindex: '-1' }),
      ),
    ),
  );
  app.setAttribute('aria-busy', 'false');
  renderPage();
  updateSync();
  if (deepTaskId) openTask(deepTaskId);
}
function updateSync() {
  const container = $('#sync-status');
  if (!container || !data) return;
  container.className = `connection${online ? '' : ' offline'}`;
  renderInto(
    container,
    el('i', { 'aria-hidden': 'true' }),
    el(
      'span',
      {},
      online
        ? `Обновлено ${new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Almaty' }).format(lastFetched)}`
        : 'Нет связи. Сохранённый вид',
    ),
    !online && button('Повторить', () => refresh(), 'text-button'),
  );
  const version = $('#source-version');
  if (version)
    version.textContent = `Код ${(data.meta?.sourceSha || '-').slice(0, 7)} · Данные ${date(data.updatedAt)}`;
}
async function refresh(initial = false) {
  if (loading) return;
  loading = true;
  try {
    const incoming = await api('project');
    if (!Array.isArray(incoming.tasks) || !Array.isArray(incoming.workstreams))
      throw new Error('Некорректные данные проекта');
    data = incoming;
    online = true;
    lastFetched = new Date();
    if (initial || !$('#main')) renderShell();
    else {
      renderContent();
      updateSync();
    }
  } catch (error) {
    online = false;
    if (error.status === 401 && dialog.open) {
      showSessionRenewal();
      updateSync();
    } else if (error.status === 401) renderAuth();
    else if (!data) {
      renderInto(
        app,
        el(
          'div',
          { class: 'fatal' },
          el('h1', {}, 'Пульт пока недоступен'),
          el(
            'p',
            {},
            'Не удалось получить данные проекта. Проверьте соединение и попробуйте ещё раз.',
          ),
          button('Повторить загрузку', () => refresh(true)),
        ),
      );
      app.setAttribute('aria-busy', 'false');
    } else updateSync();
  } finally {
    loading = false;
  }
}
function pageHeading(eyebrow, title, description, action) {
  return el(
    'div',
    { class: 'page-heading' },
    el(
      'div',
      {},
      el('div', { class: 'eyebrow' }, eyebrow),
      el('h1', {}, title),
      el('p', {}, description),
    ),
    action,
  );
}
function selectField(label, values, value, onChange, id) {
  const select = el(
    'select',
    { 'aria-label': label, id, onchange: (event) => onChange(event.target.value) },
    Object.entries(values).map(([key, text]) => el('option', { value: key }, text)),
  );
  select.value = value;
  return select;
}
function filterBar() {
  const search = el('input', {
    type: 'search',
    'aria-label': 'Поиск по задачам',
    placeholder: 'Найти задачу, решение или следующий шаг…',
    value: filters.search,
    oninput: (event) => {
      filters.search = event.target.value;
      renderContent();
    },
  });
  const bar = el(
    'div',
    { class: 'filters' },
    el('label', { class: 'search-box' }, icon('search', 17), search),
    selectField('Статус задачи', { '': 'Все статусы', ...STATUS }, filters.status, (value) => {
      filters.status = value;
      renderContent();
    }),
    selectField('Ответственный', { '': 'Вся команда', ...OWNERS }, filters.owner, (value) => {
      filters.owner = value;
      renderContent();
    }),
  );
  if (['directions', 'checks'].includes(view))
    bar.append(
      selectField(
        'Направление',
        {
          '': 'Все направления',
          ...Object.fromEntries(data.workstreams.map((item) => [item.id, item.title])),
        },
        filters.workstream,
        (value) => {
          filters.workstream = value;
          filters.phase = '';
          renderContent();
        },
      ),
    );
  if (filters.phase)
    bar.append(
      button(
        'Сбросить этап ×',
        () => {
          filters.phase = '';
          renderPage();
        },
        'text-button',
      ),
    );
  return bar;
}
function renderPage() {
  if (!data || !$('#main')) return;
  $$('.nav-button').forEach((node) => {
    const active = node.dataset.route === view;
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  $('#breadcrumb-current').textContent = ROUTES[view][0];
  const headings = {
    directions: [
      'Из чего состоит PickChick',
      'Каждое направление на виду',
      'От мобильного приложения до кухни. Внутри - задачи, зависимости, подтверждения и следующий шаг.',
    ],
    plan: [
      'Последовательность запуска',
      'Четыре месяца. Один маршрут.',
      'Этапы связаны зависимостями. Срок в неделях - план, а переход к запуску подтверждаем проверками.',
    ],
    checks: [
      'Проверяем реальный результат',
      'От «сделано» к «работает»',
      'Открывайте доступные экраны, проходите критерии задачи и сохраняйте результаты проверки для команды.',
    ],
    customer: [
      'Решения, данные и согласования',
      'Что нужно от заказчика',
      'Здесь собраны решения и входные данные, от которых зависят следующие шаги разработки и запуска.',
    ],
  };
  renderInto(
    $('#main'),
    view === 'overview' ? hero() : pageHeading(...headings[view]),
    !['overview', 'plan'].includes(view) && filterBar(),
    el('div', { id: 'view-content' }),
  );
  renderContent();
}
function $$(selector) {
  return [...document.querySelectorAll(selector)];
}
function filteredTasks(tasks = data.tasks) {
  const query = filters.search.trim().toLocaleLowerCase('ru');
  return tasks.filter(
    (task) =>
      (!filters.status || status(task) === filters.status) &&
      (!filters.owner || task.owner === filters.owner) &&
      (!filters.workstream || task.workstream === filters.workstream) &&
      (!filters.phase || task.phase === filters.phase) &&
      (!query ||
        [
          task.id,
          task.title,
          task.summary,
          task.nextAction,
          task.customerInput,
          stream(task.workstream)?.title,
        ]
          .join(' ')
          .toLocaleLowerCase('ru')
          .includes(query)),
  );
}
function renderContent() {
  const target = $('#view-content');
  if (!target || !data) return;
  const renderer = { overview: overview, directions, plan, checks, customer }[view];
  renderInto(
    target,
    ...renderer()
      .flat(Infinity)
      .filter((item) => item != null && item !== false),
  );
}
function hero() {
  return el(
    'section',
    { class: 'hero' },
    el(
      'div',
      {},
      el('div', { class: 'eyebrow' }, 'PickChick / от разработки до запуска системы'),
      el('h1', {}, 'Большой проект.', el('br'), 'Понятный ', el('span', {}, 'следующий шаг.')),
      el(
        'p',
        {},
        'Вся экосистема в одном месте: что уже сделано, что двигаем сейчас и что нужно для полноценного запуска.',
      ),
      el(
        'div',
        { class: 'hero-meta' },
        el('span', { class: 'pill' }, icon('clock', 12), 'Горизонт: 4 месяца'),
        el(
          'span',
          { class: 'pill' },
          data.project?.t0 ? `T0: ${date(data.project.t0)}` : 'T0 пока не назначена',
        ),
        el(
          'span',
          { class: 'pill' },
          countLabel(data.workstreams.length, 'направление', 'направления', 'направлений'),
        ),
      ),
    ),
    el(
      'div',
      {
        class: 'system-map',
        'aria-label': 'Общее ядро связывает приложение, кассу, кухню и бэк-офис',
      },
      el(
        'div',
        { class: 'map-core' },
        el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'P', el('span', {}, 'C')),
        el('strong', {}, 'Единое ядро'),
        el('small', {}, 'PickChick ecosystem'),
      ),
      ...['Приложение', 'Касса и оплата', 'Кухня и выдача', 'Бэк-офис'].map((title) =>
        el('span', { class: 'map-node' }, title),
      ),
    ),
  );
}
function sectionHead(title, description, action) {
  return el(
    'div',
    { class: 'section-head' },
    el('div', {}, el('h2', {}, title), description && el('p', {}, description)),
    action,
  );
}
function taskLine(task, index) {
  return el(
    'button',
    {
      type: 'button',
      class: 'task-line',
      'data-task-id': task.id,
      onclick: (event) => openTask(task.id, event.currentTarget),
    },
    index != null && el('span', { class: 'task-number' }, String(index + 1).padStart(2, '0')),
    el(
      'div',
      { class: 'task-line-main' },
      el('h3', {}, task.title),
      el(
        'small',
        {},
        `${stream(task.workstream)?.title || task.workstream} · ${OWNERS[task.owner] || 'Команда'}`,
      ),
    ),
    icon('chevron', 14),
  );
}
function overview() {
  const counts = Object.fromEntries(
    Object.keys(STATUS).map((key) => [
      key,
      data.tasks.filter((task) => status(task) === key).length,
    ]),
  );
  const waiting = data.tasks.filter(
    (task) => (task.customerInput || task.owner === 'customer') && status(task) !== 'done',
  );
  const next = data.tasks
    .filter((task) => ['active', 'blocked'].includes(status(task)))
    .sort((a, b) => (status(a) === 'active' ? 0 : 1) - (status(b) === 'active' ? 0 : 1))
    .slice(0, 4);
  const metrics = el(
    'div',
    { class: 'metrics' },
    ...[
      [data.tasks.length, 'Задач в общем плане', 'По всем направлениям проекта'],
      [counts.active, 'Сейчас в работе', 'Текущий статус по плану'],
      [counts.blocked, 'Ждут зависимостей', 'Нужны решения или доступы'],
      [counts.done, 'Завершены по плану', 'Приёмка учитывается отдельно'],
    ].map(([count, label, note]) =>
      el(
        'div',
        { class: 'metric' },
        el('div', { class: 'metric-label' }, label),
        el('strong', {}, count),
        el('small', {}, note),
      ),
    ),
  );
  const focuses = el(
    'div',
    {},
    sectionHead(
      'Ближайший фокус',
      'Следующие шаги команды',
      button('Все задачи ↗', () => go('directions'), 'text-button'),
    ),
    el(
      'div',
      { class: 'panel focus-list' },
      next.length
        ? next.map(taskLine)
        : el('div', { class: 'empty-state' }, el('p', {}, 'Активные задачи ещё не отмечены.')),
    ),
  );
  const asks = el(
    'div',
    {},
    sectionHead(
      'Двигаем вместе',
      countLabel(waiting.length, 'открытый запрос', 'открытых запроса', 'открытых запросов'),
    ),
    el(
      'div',
      { class: 'panel ask-panel' },
      el('div', { class: 'eyebrow' }, 'Со стороны заказчика'),
      el('h3', {}, waiting[0]?.title || 'Все запросы разобраны'),
      el(
        'p',
        {},
        waiting[0]?.customerInput ||
          waiting[0]?.nextAction ||
          'Новые решения и вопросы появятся здесь, когда понадобятся команде.',
      ),
      el(
        'button',
        { type: 'button', class: 'primary-button', onclick: () => go('customer') },
        'Посмотреть, что нужно',
        icon('arrow', 15),
      ),
    ),
  );
  return [
    metrics,
    el('div', { class: 'overview-columns' }, focuses, asks),
    sectionHead(
      'Все направления',
      'Одна система, несколько параллельных путей',
      button('Открыть план ↗', () => go('plan'), 'text-button'),
    ),
    el(
      'div',
      { class: 'streams-grid' },
      data.workstreams.map((item, index) => {
        const tasks = data.tasks.filter((task) => task.workstream === item.id);
        const active = tasks.filter((task) => status(task) === 'active').length;
        return el(
          'button',
          {
            type: 'button',
            class: 'stream-card',
            onclick: () => go('directions', { stream: item.id }),
          },
          el(
            'div',
            { class: 'stream-top' },
            el(
              'span',
              { class: 'stream-icon' },
              icon(['layers', 'grid', 'check', 'timeline', 'users'][index % 5], 17),
            ),
            String(index + 1).padStart(2, '0'),
          ),
          el('h3', {}, item.title),
          el(
            'div',
            { class: 'stream-foot' },
            el(
              'span',
              {},
              `${countLabel(tasks.length, 'задача', 'задачи', 'задач')}${active ? ` · ${active} в работе` : ''}`,
            ),
            el(
              'span',
              { class: 'status-bar', 'aria-hidden': 'true' },
              tasks.slice(0, 10).map((task) => el('i', { class: status(task) })),
            ),
          ),
        );
      }),
    ),
    el(
      'p',
      { class: 'footnote' },
      'Цвета показывают ход плана. Готовность к работе в ресторане подтверждается отдельно: реализация, проверка, установка и приёмка - в каждой задаче.',
    ),
  ];
}
function factDots(task) {
  return el(
    'span',
    {
      class: 'fact-dots',
      'aria-label': Object.entries(FACTS)
        .map(
          ([key, title]) =>
            `${title}: ${task.checks?.[key] === true ? 'подтверждено' : 'не подтверждено'}`,
        )
        .join(', '),
    },
    Object.keys(FACTS).map((key) =>
      el(
        'i',
        { class: task.checks?.[key] === true ? 'yes' : '', 'aria-hidden': 'true' },
        task.checks?.[key] === true ? '✓' : '',
      ),
    ),
  );
}
function taskRow(task) {
  return el(
    'button',
    {
      type: 'button',
      class: 'task-row',
      'data-task-id': task.id,
      onclick: (event) => openTask(task.id, event.currentTarget),
    },
    el('span', { class: 'task-row-title' }, task.title, el('small', {}, task.id)),
    badge(status(task)),
    el('span', { class: 'owner-label' }, OWNERS[task.owner] || 'Команда'),
    factDots(task),
    icon('chevron', 13),
  );
}
function empty() {
  return el(
    'div',
    { class: 'empty-state' },
    el('h2', {}, 'Такой задачи пока нет'),
    el('p', {}, 'Попробуйте другой запрос или уберите часть фильтров.'),
    button('Сбросить фильтры', () => {
      Object.keys(filters).forEach((key) => {
        filters[key] = '';
      });
      renderPage();
    }),
  );
}
function directions() {
  const tasks = filteredTasks();
  return [
    el(
      'p',
      { class: 'result-count' },
      `Найдено задач: ${tasks.length}${filters.phase ? ` · ${data.phases?.find((phase) => phase.id === filters.phase)?.title || filters.phase}` : ''}`,
    ),
    tasks.length
      ? data.workstreams
          .filter((item) => tasks.some((task) => task.workstream === item.id))
          .map((item, index) =>
            el(
              'section',
              { class: 'workstream-section' },
              el(
                'div',
                { class: 'workstream-header' },
                el('span', { class: 'stream-icon' }, icon('layers', 17)),
                el(
                  'div',
                  {},
                  el('h2', {}, item.title),
                  el(
                    'small',
                    {},
                    item.summary ||
                      item.description ||
                      `Направление ${String(index + 1).padStart(2, '0')}`,
                  ),
                ),
              ),
              el(
                'div',
                { class: 'task-table' },
                tasks.filter((task) => task.workstream === item.id).map(taskRow),
              ),
            ),
          )
      : empty(),
  ];
}
function plan() {
  const phases = data.phases || [];
  return [
    el(
      'div',
      { class: 'info-banner' },
      icon('info'),
      el(
        'p',
        {},
        data.project?.t0
          ? `Старт проекта: ${date(data.project.t0)}. Календарный срок и фактическая готовность учитываются отдельно.`
          : 'Дата старта T0 пока не согласована. Это последовательность работ на 16 недель, а не календарь с уже начавшимся отсчётом.',
      ),
    ),
    el(
      'div',
      {
        class: 'plan-scroll',
        tabindex: '0',
        role: 'region',
        'aria-label': 'План на 16 недель, прокручивается горизонтально',
      },
      el(
        'div',
        { class: 'plan-scale' },
        el('span', {}, 'ЭТАП / НЕДЕЛЯ'),
        Array.from({ length: 16 }, (_, index) => el('span', {}, index + 1)),
      ),
      phases
        .filter((phase) => Number(phase.weeks?.[0]) <= 16)
        .map((phase) => {
          const start = Math.max(1, Math.min(16, Number(phase.weeks?.[0]) || 1));
          const end = Math.max(start, Math.min(16, Number(phase.weeks?.[1]) || start));
          const bar = el(
            'button',
            {
              type: 'button',
              class: 'phase-span',
              onclick: () => go('directions', { phase: phase.id }),
              'aria-label': `${phase.title}, недели ${start}-${end}, открыть задачи`,
            },
            `${start}-${end}`,
          );
          bar.style.gridColumn = `${start} / ${end + 1}`;
          return el(
            'div',
            { class: 'phase-row' },
            el(
              'div',
              { class: 'phase-label' },
              el('strong', {}, phase.title),
              el(
                'small',
                {},
                countLabel(
                  data.tasks.filter((task) => task.phase === phase.id).length,
                  'задача',
                  'задачи',
                  'задач',
                ),
              ),
            ),
            el('div', { class: 'phase-track' }, bar),
          );
        }),
    ),
    sectionHead('Что должно получиться', 'К каждому этапу привязаны задачи и критерии'),
    el(
      'div',
      { class: 'phase-details' },
      phases.map((phase, index) =>
        el(
          'article',
          { class: 'panel phase-card' },
          el(
            'div',
            { class: 'eyebrow' },
            Number(phase.weeks?.[0]) > 16
              ? 'После запуска · отдельное согласование'
              : `Этап ${String(index + 1).padStart(2, '0')} · недели ${(phase.weeks || []).join('-')}`,
          ),
          el('h3', {}, phase.title),
          el('p', {}, phase.summary || ''),
          button('Открыть задачи ↗', () => go('directions', { phase: phase.id }), 'text-button'),
        ),
      ),
    ),
  ];
}
function checks() {
  const tasks = filteredTasks();
  const previews = data.previews || [];
  return [
    el(
      'div',
      { class: 'info-banner' },
      icon('info'),
      el(
        'p',
        {},
        'Результат ручной проверки - запись команды. Он не меняет факты из кода и не подтверждает готовность банковской или фискальной интеграции.',
      ),
    ),
    previews.length > 0 &&
      el(
        'div',
        { class: 'preview-grid' },
        previews.map((preview) =>
          el(
            'article',
            { class: 'panel preview-card' },
            el(
              'span',
              { class: 'eyebrow' },
              {
                design: 'Макет / демонстрация',
                test: 'Тестовая среда',
                live: 'Установленный интерфейс',
              }[preview.kind] || 'Среда проверки',
            ),
            el('h3', {}, preview.title),
            el('p', {}, preview.description || ''),
            link('Открыть в новой вкладке ↗', preview.url, 'secondary-button'),
          ),
        ),
      ),
    sectionHead(
      'Журнал проверок',
      `${countLabel(tasks.length, 'задача', 'задачи', 'задач')} · результат сохраняется для всей команды`,
    ),
    tasks.length
      ? el(
          'div',
          { class: 'panel' },
          tasks.map((task) => {
            const result = review(task);
            return el(
              'button',
              {
                type: 'button',
                class: 'check-row',
                'data-task-id': task.id,
                onclick: (event) => openTask(task.id, event.currentTarget, true),
              },
              el(
                'div',
                {},
                el('h3', {}, task.title),
                el(
                  'p',
                  {},
                  result.updatedAt
                    ? `${result.author || 'Автор не указан'} · ${date(result.updatedAt)}${result.note ? ` · ${result.note.slice(0, 100)}` : ''}`
                    : `${stream(task.workstream)?.title || task.workstream} · ${countLabel(task.acceptance?.length || 0, 'критерий', 'критерия', 'критериев')} приёмки`,
                ),
              ),
              badge(result.result || 'pending', 'result'),
              icon('chevron', 14),
            );
          }),
        )
      : empty(),
  ];
}
function customer() {
  const tasks = filteredTasks(
    data.tasks.filter((task) => task.customerInput || task.owner === 'customer'),
  );
  return [
    el(
      'p',
      { class: 'result-count' },
      `Запросов: ${tasks.length}. Открывайте задачу, чтобы увидеть, какую работу разблокирует ваш ответ.`,
    ),
    tasks.length
      ? tasks.map((task) =>
          el(
            'article',
            { class: 'panel request-card' },
            el(
              'div',
              {},
              el('div', { class: 'eyebrow' }, stream(task.workstream)?.title || task.workstream),
              el('h3', {}, task.title),
              el(
                'p',
                {},
                Array.isArray(task.customerInput)
                  ? task.customerInput.join('\n')
                  : task.customerInput || task.nextAction || task.summary,
              ),
              el('div', { class: 'detail-meta' }, badge(status(task))),
            ),
            button('Разобрать задачу ↗', (event) => openTask(task.id, event.currentTarget)),
          ),
        )
      : empty(),
  ];
}
function showSessionRenewal() {
  if (!dialog.open || $('#session-renewal', dialog)) return;
  const key = el('input', {
    type: 'password',
    name: 'key',
    id: 'renew-key',
    required: '',
    autocomplete: 'current-password',
    placeholder: 'Ключ команды',
  });
  const message = el(
    'p',
    { role: 'status' },
    'Сессия закончилась. Черновик остаётся в форме. Введите ключ команды, чтобы продолжить.',
  );
  const submit = el('button', { type: 'submit', class: 'primary-button' }, 'Войти заново');
  const copy = button(
    'Скопировать заметку',
    async () => {
      const note = $('[name="note"]', dialog);
      try {
        await navigator.clipboard.writeText(note?.value || '');
        copy.textContent = 'Заметка скопирована';
      } catch {
        note?.focus();
        note?.select();
      }
    },
    'text-button',
  );
  const form = el(
    'form',
    {
      id: 'session-renewal',
      class: 'conflict-box session-renewal',
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          await api('session', { method: 'POST', body: JSON.stringify({ key: key.value }) });
          key.value = '';
          form.remove();
          await refresh();
          announce('Сессия восстановлена. Черновик сохранён в форме.');
        } catch {
          message.textContent =
            'Не удалось войти. Проверьте ключ и соединение. Черновик остался в форме.';
          submit.disabled = false;
        }
      },
    },
    message,
    el('label', { class: 'field', for: 'renew-key' }, 'Ключ доступа', key),
    el('div', { class: 'session-actions' }, submit, copy),
  );
  $('.detail-body', dialog)?.prepend(form);
}
function taskHistory(task) {
  const entries = (data.state?.history || [])
    .filter((entry) => entry.taskId === task.id)
    .sort((a, b) => (b.revision || 0) - (a.revision || 0));
  return el(
    'details',
    { class: 'task-history', id: 'task-history', hidden: entries.length ? null : '' },
    el('summary', {}, `История отметок (${entries.length})`),
    el(
      'div',
      { class: 'history-list' },
      entries
        .slice(0, 20)
        .map((entry) =>
          el(
            'article',
            {},
            el('strong', {}, `${entry.author || '-'} · ${date(entry.updatedAt)}`),
            el(
              'div',
              { class: 'detail-meta' },
              entry.status && badge(entry.status),
              entry.result && badge(entry.result, 'result'),
            ),
            el('p', {}, entry.note || 'Без заметки'),
          ),
        ),
    ),
    entries.length > 20 &&
      el('p', { class: 'detail-caption' }, 'Показаны последние 20 отметок по этой задаче.'),
  );
}
function openTask(id, trigger, focusReview = false) {
  const task = taskById(id);
  if (!task) return;
  deepTaskId = id;
  if (trigger) {
    lastTaskTrigger = trigger;
    lastTaskTriggerId = id;
  }
  const [route, query] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  params.set('task', id);
  history.replaceState(null, '', `#${route || view}?${params}`);
  const facts = el(
    'div',
    { class: 'facts-grid' },
    Object.entries(FACTS).map(([key, title]) =>
      el(
        'div',
        { class: `fact-chip${task.checks?.[key] === true ? ' yes' : ''}` },
        el('strong', {}, task.checks?.[key] === true ? '✓' : '○', title),
        task.checks?.[key] === true ? 'Подтверждено' : 'Не подтверждено',
      ),
    ),
  );
  const dependencies = (task.dependsOn || []).map((dependency) => {
    const related = taskById(dependency);
    return button(related?.title || dependency, () => openTask(dependency), 'dependency-button');
  });
  const dependents = data.tasks.filter((item) => item.dependsOn?.includes(id));
  const evidence = (task.evidence || []).map((item) =>
    link(item.label || item.path || 'Источник', item.url || sourceUrl(item.path)),
  );
  const body = el(
    'div',
    { class: 'detail-body' },
    el('h2', { id: 'task-title' }, task.title),
    el('p', { class: 'detail-summary' }, task.summary),
    el(
      'div',
      { class: 'detail-meta' },
      el('span', { id: 'detail-status' }, badge(status(task))),
      el('span', { class: 'owner-label' }, OWNERS[task.owner] || 'Команда'),
    ),
    facts,
    el(
      'p',
      { class: 'detail-caption' },
      'Факты берём из подтверждений в репозитории. Плановый статус и запись проверки ниже учитываются отдельно.',
    ),
    el(
      'div',
      { class: 'next-action' },
      el('div', { class: 'eyebrow' }, 'Следующий шаг'),
      el('p', {}, task.nextAction || 'Следующий шаг ещё не указан.'),
    ),
    task.customerInput &&
      el(
        'section',
        { class: 'detail-section' },
        el('h3', {}, 'Что нужно от заказчика'),
        el(
          'p',
          { class: 'detail-summary' },
          Array.isArray(task.customerInput) ? task.customerInput.join('\n') : task.customerInput,
        ),
      ),
    el(
      'section',
      { class: 'detail-section' },
      el('h3', {}, 'Критерии приёмки'),
      task.acceptance?.length
        ? el(
            'ul',
            { class: 'acceptance-list' },
            task.acceptance.map((item) => el('li', {}, item)),
          )
        : el('p', { class: 'detail-summary' }, 'Критерии ещё нужно согласовать.'),
    ),
    dependencies.length > 0 &&
      el(
        'section',
        { class: 'detail-section' },
        el('h3', {}, 'Сначала должны быть готовы'),
        el('div', { class: 'dependency-list' }, dependencies),
      ),
    dependents.length > 0 &&
      el(
        'section',
        { class: 'detail-section' },
        el('h3', {}, 'Поможет двигаться дальше'),
        el(
          'div',
          { class: 'dependency-list' },
          dependents.map((item) =>
            button(item.title, () => openTask(item.id), 'dependency-button'),
          ),
        ),
      ),
    el(
      'section',
      { class: 'detail-section' },
      el('h3', {}, 'Основания и исходные материалы'),
      evidence.length
        ? el('div', { class: 'evidence-list' }, evidence)
        : el('p', { class: 'detail-summary' }, 'Подтверждающие материалы ещё не добавлены.'),
    ),
    taskHistory(task),
    reviewForm(task),
  );
  const copy = button(
    'Ссылка ↗',
    async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        copy.textContent = 'Скопировано';
        announce('Ссылка на задачу скопирована.');
      } catch {
        const field = el('input', {
          type: 'text',
          readonly: '',
          value: location.href,
          'aria-label': 'Ссылка на задачу',
          class: 'share-link',
        });
        body.prepend(field);
        field.focus();
        field.select();
      }
    },
    'text-button',
  );
  dialog.replaceChildren(
    el(
      'div',
      { class: 'detail-top' },
      el(
        'span',
        { class: 'eyebrow' },
        `${stream(task.workstream)?.title || task.workstream} / ${task.id}`,
      ),
      el(
        'div',
        { class: 'detail-actions' },
        copy,
        el(
          'button',
          {
            class: 'icon-button',
            type: 'button',
            'aria-label': 'Закрыть задачу',
            onclick: () => dialog.close(),
          },
          icon('close', 15),
        ),
      ),
    ),
    body,
  );
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  if (focusReview) {
    $('.review-form', dialog).scrollIntoView({ block: 'start' });
    $('[name="result"]', dialog).focus({ preventScroll: true });
  }
}
function reviewForm(task) {
  const existing = review(task);
  let expectedVersion = existing.version || 0;
  const planStatus = selectField(
    'Статус по плану',
    STATUS,
    status(task),
    () => {},
    'review-status',
  );
  planStatus.name = 'status';
  const result = selectField(
    'Результат ручной проверки',
    RESULTS,
    existing.result || 'pending',
    () => {},
    'review-result',
  );
  result.name = 'result';
  const author = el('input', {
    name: 'author',
    id: 'review-author',
    required: '',
    minlength: '2',
    maxlength: '80',
    value: rememberedName() || existing.author || '',
    autocomplete: 'name',
    placeholder: 'Имя автора записи',
  });
  const note = el(
    'textarea',
    {
      name: 'note',
      id: 'review-note',
      maxlength: '4000',
      rows: '4',
      placeholder: 'Что проверили, какой результат получили, что осталось исправить…',
    },
    existing.note || '',
  );
  const message = el('p', { class: 'form-message', role: 'status' });
  const conflict = el('div');
  const submit = el(
    'button',
    { type: 'submit', class: 'primary-button' },
    'Сохранить для команды',
    icon('check', 15),
  );
  const stamp = el(
    'small',
    {},
    existing.updatedAt
      ? `Последняя запись: ${existing.author || '-'}, ${date(existing.updatedAt)}`
      : 'Пока нет записи команды по этой задаче.',
  );
  const form = el(
    'form',
    {
      class: 'review-form',
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        message.textContent = '';
        conflict.replaceChildren();
        const payload = {
          expectedVersion,
          status: planStatus.value,
          result: result.value,
          author: author.value.trim(),
          note: note.value.trim(),
        };
        if (payload.author.length < 2) {
          message.textContent = 'Укажите имя автора записи (не менее двух символов).';
          submit.disabled = false;
          return;
        }
        if (payload.result !== 'pending' && payload.note.length < 5) {
          message.textContent = 'Опишите результат проверки в заметке (не менее пяти символов).';
          submit.disabled = false;
          note.focus();
          return;
        }
        let conflicted = false;
        try {
          const saved = await api(`reviews/${encodeURIComponent(task.id)}`, {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          data.state ||= { reviews: {} };
          data.state.reviews ||= {};
          data.state.reviews[task.id] = saved.review;
          data.state.revision = saved.revision;
          data.state.history ||= [];
          if (!data.state.history.some((entry) => entry.revision === saved.revision))
            data.state.history.push({ ...saved.review, taskId: task.id, revision: saved.revision });
          const oldHistory = $('#task-history', dialog);
          const newHistory = taskHistory(task);
          newHistory.open = oldHistory?.open || false;
          oldHistory?.replaceWith(newHistory);
          expectedVersion = saved.review.version;
          rememberName(payload.author);
          online = true;
          lastFetched = new Date();
          stamp.textContent = `Последняя запись: ${saved.review.author}, ${date(saved.review.updatedAt)}`;
          $('#detail-status', dialog)?.replaceChildren(badge(status(task)));
          message.className = 'form-message success';
          message.textContent = 'Сохранено. Запись доступна всей команде.';
          announce(message.textContent);
          renderContent();
          updateSync();
        } catch (error) {
          message.className = 'form-message';
          if (error.status === 409) {
            conflicted = true;
            const explanation = el(
              'p',
              {},
              'Другой участник уже изменил запись. Ваш текст сохранён в форме. Сначала посмотрите последнюю версию, затем решите, что сохранить.',
            );
            const compare = button('Показать последнюю запись', async () => {
              compare.disabled = true;
              try {
                const incoming = await api('project');
                const latest = incoming.state?.reviews?.[task.id] || {};
                data = incoming;
                expectedVersion = latest.version || 0;
                explanation.textContent = `Последняя запись: ${latest.author || '-'} · ${date(latest.updatedAt)}\nСтатус: ${STATUS[latest.status] || 'Не указан'} · Проверка: ${RESULTS[latest.result] || 'Не проверено'}\n${latest.note || 'Без заметки'}\n\nВаши поля оставлены без изменений. Сверьте их и нажмите «Сохранить для команды», чтобы обновить запись.`;
                compare.remove();
                submit.disabled = false;
                renderContent();
              } catch {
                explanation.textContent =
                  'Не удалось загрузить последнюю запись. Ваш текст остался в форме. Попробуйте ещё раз.';
                compare.disabled = false;
              }
            });
            conflict.replaceChildren(
              el('div', { class: 'conflict-box', role: 'alert' }, explanation, compare),
            );
          } else {
            if (error.status === 401) showSessionRenewal();
            message.textContent =
              error.status === 401
                ? 'Сессия закончилась. Черновик сохранён в форме. Войдите заново в блоке в начале карточки.'
                : 'Не удалось сохранить. Ваши изменения остались в форме. Проверьте связь и повторите попытку.';
          }
        } finally {
          if (!conflicted) submit.disabled = false;
        }
      },
    },
    el('h3', {}, 'Запись команды'),
    el(
      'p',
      {},
      'Меняйте статус по плану и фиксируйте результат ручной проверки. Имя - указанная вами подпись; доступ к пространству общий.',
    ),
    el(
      'div',
      { class: 'form-grid' },
      el('label', { class: 'field', for: 'review-status' }, 'Статус по плану', planStatus),
      el('label', { class: 'field', for: 'review-result' }, 'Ручная проверка', result),
      el('label', { class: 'field full', for: 'review-author' }, 'Автор записи', author),
      el('label', { class: 'field full', for: 'review-note' }, 'Результат и заметки', note),
    ),
    conflict,
    el('div', { class: 'form-footer' }, stamp, submit),
    message,
  );
  return form;
}
dialog.addEventListener('close', () => {
  deepTaskId = null;
  const [route, query] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  params.delete('task');
  history.replaceState(null, '', `#${route || view}${params.size ? `?${params}` : ''}`);
  const focusTarget = lastTaskTrigger?.isConnected
    ? lastTaskTrigger
    : $$('[data-task-id]').find((node) => node.dataset.taskId === lastTaskTriggerId) || $('#main');
  focusTarget?.focus();
});
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      dialog.close();
  }
});
window.addEventListener('hashchange', () => {
  routeFromHash();
  if (data) {
    renderPage();
    if (deepTaskId) openTask(deepTaskId);
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && data) refresh();
});
setInterval(() => {
  if (!document.hidden && data) refresh();
}, 30000);
routeFromHash();
refresh(true);
