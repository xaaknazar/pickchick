import { KitchenModel, allowedActions, displayWindow } from './model.js';
import { request, apiPrefix, assetPrefix, portalMode, demoMode } from './api.js';
import { createDemo, memoryStorage } from './demo.js';
import { demoTicket } from './ticket-view.js';
import { startRuntime } from './runtime.js';
import { UUID, type Action } from './types.js';
const root = document.querySelector<HTMLDivElement>('#app')!;
const demo = demoMode ? createDemo() : null;
if (demo) document.body.classList.add('ticket-demo');
let autoOrders = true;
let demoNotice = '';
let renderedView = '';
let branch = demo ? 'Демонстрационная точка' : 'Локальная точка';
let boardPage = 0;
let terminalId: string | undefined;
let loginName = '';
let configLoaded = false;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const labels: Record<string, string> = {
  accepted: 'В очереди',
  in_production: 'В работе',
  ready: 'Готов к выдаче',
  handed_over: 'Выдан',
  cancel_requested: 'Остановка заказа',
  cancelled: 'Отменён',
  held: 'Ожидает допуска',
  released: 'Снят',
  queued: 'В очереди',
  in_progress: 'В работе',
  done: 'Готово',
};
const actionLabel: Record<Action['action'], string> = {
  start_task: 'Начать',
  complete_task: 'Готово',
  complete_station: 'Готово - на сборку',
  ready: 'Заказ собран',
  handoff: 'Подтвердить выдачу',
  confirm_stop: 'Приготовление остановлено',
};
const errors: Record<string, string> = {
  CONNECTION_UNKNOWN: 'Нет ответа локального узла. Результат команды неизвестен.',
  EDGE_TIMEOUT: 'Локальный узел не ответил. Результат команды неизвестен.',
  CONFLICT: 'Заказ изменён другим сотрудником. Сверьте актуальное состояние.',
  SESSION_EXPIRED: 'Сессия истекла. Войдите снова под своим логином.',
  INVALID_LOGIN: 'Не удалось войти. Проверьте логин и пароль или обратитесь к управляющему.',
  AUTH_RATE_LIMITED: 'Слишком много попыток входа. Подождите перед следующей попыткой.',
  TERMINAL_NOT_CONFIGURED: 'Рабочее место ещё не привязано к терминалу. Обратитесь к управляющему.',
  UNAUTHORIZED: 'Сессия истекла или отозвана. Войдите снова.',
  UNAUTHENTICATED: 'Доступ отозван или истёк. Требуется вход.',
  FORBIDDEN: 'Нет доступа к этой станции. Требуется вход.',
  OTHER_WINDOW: 'Этот рабочий доступ уже открыт в другом окне. Закройте его.',
  STORAGE_UNAVAILABLE: 'Не удалось сохранить журнал. Действия заблокированы.',
  JOURNAL_INVALID: 'Журнал повреждён. Сохраните данные браузера и обратитесь к администратору.',
  JOURNAL_CHANGED: 'Журнал изменён в другом окне. Новые действия заблокированы.',
  FULFILLMENT_DISABLED: 'Кухня на локальном узле ещё не включена.',
  NO_STATIONS: 'Нет назначенных станций. Обратитесь к управляющему.',
  INVALID_RESPONSE: 'Ответ узла не прошёл проверку. Новые действия не подтверждены.',
  INVALID_CREDENTIAL: 'Файл доступа не подходит для кухни.',
  RECOVERY_REQUIRED: 'Сначала восстановите незавершённую команду.',
  REVIEW_REQUIRED: 'Сначала сверьте состояние заказа.',
  QUEUE_BOUND_EXCEEDED:
    'Очередь превысила безопасный предел загрузки. Обратитесь к администратору; частичный список не опубликован.',
  SCOPE_MISMATCH: 'Ответ относится к другой точке. Действия заблокированы.',
};
function scopedStorage(storage: Storage) {
  const prefix = portalMode ? 'portal.' + portalMode + '.' : '';
  return {
    getItem: (key: string) => storage.getItem(prefix + key),
    setItem: (key: string, value: string) => storage.setItem(prefix + key, value),
    removeItem: (key: string) => storage.removeItem(prefix + key),
  };
}
async function selectInitialScreen() {
  if (!model.state.actor || model.state.pending) return;
  if (portalMode === 'display') await model.selectMode('display');
  else if (portalMode) {
    const station = model.state.stations.find((s) => s.kind === portalMode);
    if (station) await model.selectStation(station.id);
  }
}
const model = new KitchenModel(
  demo?.transport ?? request,
  demo ? memoryStorage() : scopedStorage(sessionStorage),
  demo ? memoryStorage() : scopedStorage(localStorage),
  async (name) => {
    if (demo) return () => {};
    if (!navigator.locks) return null;
    return new Promise((resolve) => {
      void navigator.locks.request(
        'pickchick.kitchen.' + name,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            resolve(null);
            return;
          }
          await new Promise<void>((release) => resolve(release));
        },
      );
    });
  },
  render,
);
function button(text: string, attrs: string, disabled = false) {
  return `<button ${attrs}${disabled ? ' disabled' : ''}>${text}</button>`;
}
function render() {
  const s = model.state;
  const visibleOrders = s.orders.filter((o) => {
    if (!s.wholeTicketActions || o.state === 'cancel_requested') return true;
    if (o.assemblyStationId === s.stationId)
      return o.tasks.every((t) => t.stationId === s.stationId || t.state === 'done');
    return o.tasks.some(
      (t) => t.stationId === s.stationId && ['queued', 'in_progress'].includes(t.state),
    );
  });
  const focus = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';
  const viewKey = `${s.mode}:${s.stationId ?? ''}`;
  const scroll =
    renderedView === viewKey ? (document.querySelector('.workspace')?.scrollTop ?? 0) : 0;
  renderedView = viewKey;
  const blocked = s.busy || !!s.pending || s.storageBlocked || !s.lease || !!s.error;
  const clock = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Almaty',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
  const header = `<header><div class="brand"><img src="${assetPrefix}/logo.png" alt="Pick Chick"></div><div class="heading"><h1>${escape(!s.actor ? 'Кухня PickChick' : s.mode === 'display' ? 'Табло выдачи' : 'Кухня · ' + (s.stations.find((t) => t.id === s.stationId)?.name ?? 'станция'))}</h1><p>${escape(branch)}</p></div>${s.actor && s.mode === 'kitchen' ? `<div class="stat"><span>НА СТРАНИЦЕ</span><strong>${visibleOrders.length}</strong></div><div class="stat"><span>В РАБОТЕ</span><strong>${s.orders.filter((o) => o.state === 'in_production').length}</strong></div>` : ''}<time id="clock">${clock}</time></header>`;
  if (!s.actor) {
    const serviceOpen = root.querySelector<HTMLDetailsElement>('details.login-service')?.open;
    const disabled = s.busy || !terminalId ? ' disabled' : '';
    root.innerHTML =
      header +
      `<main class="login"><section>
      <span class="login-eyebrow">РАБОЧИЙ ЭКРАН PICK CHICK</span><h2>Вход на кухню</h2><p>Войдите под своим логином. Вам будут доступны назначенные станции приготовления, сборки и выдачи.</p>
      ${s.error ? `<p class="error" role="alert">${escape(errors[s.error] ?? 'Не удалось подключиться. Проверьте доступ и локальный узел.')}</p>` : ''}
      ${!configLoaded ? '<p class="setup-notice" role="status">Подключаем рабочее место...</p>' : !terminalId ? '<p class="setup-notice" role="status">Управляющий должен завершить привязку этого терминала перед входом.</p>' : ''}
      <form id="password-login" class="password-login">
        <label for="staff-login">Логин</label><input id="staff-login" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required value="${escape(loginName)}" placeholder="Ваш логин"${disabled}>
        <label for="staff-password">Пароль</label><div class="password-field"><input id="staff-password" name="password" type="password" autocomplete="current-password" maxlength="128" required placeholder="Введите пароль"${disabled}><button type="button" id="password-toggle" aria-label="Показать пароль" aria-pressed="false"${disabled}>Показать</button></div>
        <span id="login-wait" role="status"></span><button class="login-submit" id="sign-in" type="submit"${disabled}>Войти</button>
      </form><p class="muted">Логин и первый пароль выдаёт управляющий. Используйте свою учётную запись.</p>
      <details class="login-service"${serviceOpen ? ' open' : ''}><summary>Обслуживание терминала</summary><p>Вход по файлу для оператора.</p><label class="file">Выбрать файл доступа<input id="credential" type="file" accept="application/json,.json" ${s.busy ? 'disabled' : ''}></label></details>
    </section></main>`;
    document.getElementById('staff-login')?.addEventListener('input', (event) => {
      loginName = (event.target as HTMLInputElement).value;
    });
    document.getElementById('password-toggle')?.addEventListener('click', () => {
      const input = document.querySelector<HTMLInputElement>('#staff-password')!;
      const button = document.getElementById('password-toggle')!;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.textContent = show ? 'Скрыть' : 'Показать';
      button.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
      button.setAttribute('aria-pressed', String(show));
      input.focus();
    });
    document.getElementById('password-login')?.addEventListener('submit', (event) => {
      event.preventDefault();
      loginName = document.querySelector<HTMLInputElement>('#staff-login')!.value;
      const input = document.querySelector<HTMLInputElement>('#staff-password')!;
      const password = input.value;
      input.value = '';
      void model.signInWithPassword(loginName, password, terminalId).then(async () => {
        await selectInitialScreen();
        if (!model.state.actor) document.getElementById('staff-password')?.focus();
      });
    });
    updateLoginWait();
    document
      .querySelector<HTMLInputElement>('#credential')
      ?.addEventListener('change', async (e) => {
        const input = e.target as HTMLInputElement,
          file = input.files?.[0];
        if (file) {
          if (file.size > 4096) {
            await model.importCredential('');
            return;
          }
          await model.importCredential(await file.text());
          await selectInitialScreen();
        }
      });
    return;
  }
  const stations = [...s.stations].sort(
    (a, b) => Number(a.kind === 'assembly') - Number(b.kind === 'assembly'),
  );
  const nav = `<nav aria-label="Рабочий экран">${portalMode === 'display' ? '' : button('Кухня', 'id="mode-kitchen" aria-pressed="' + (s.mode === 'kitchen') + '"', blocked)}${button('Табло', 'id="mode-display" aria-pressed="' + (s.mode === 'display') + '"', blocked)}<span class="connection ${s.error ? 'offline' : ''}" role="status">${s.error ? 'Нет актуального подтверждения связи' : demo ? 'Демо-заказы' : s.lastSync ? 'Связь с локальным узлом' : 'Подключение'}${s.lastSync ? ` · ${new Date(s.lastSync).toLocaleTimeString('ru-RU')}` : ''}</span>${button('Обновить', 'id="refresh"', s.busy)}${demo ? '' : button('Выйти', 'id="logout"')}${s.mode === 'kitchen' ? `<div class="station-switcher" role="group" aria-label="Кухонные станции">${stations.map((station) => button(`<span class="station-kind">${station.kind === 'assembly' ? 'Сборка и выдача' : 'Приготовление'}</span><span class="station-name">${escape(station.name)}</span>`, `id="station-${station.id}" class="station-button" data-station="${station.id}" aria-pressed="${station.id === s.stationId}"`, blocked)).join('')}</div>` : ''}</nav>`;
  const error = s.error
    ? `<aside class="error" role="alert">${escape(errors[s.error] ?? 'Операция не завершена. Проверьте локальный узел и доступ.')} ${s.lastSync ? 'Показаны последние полученные данные.' : ''}</aside>`
    : '';
  const recovery = s.pending
    ? `<aside class="recovery" data-testid="recovery"><h2>${s.conflict ? 'Требуется сверка' : 'Незавершённая команда'}</h2><p>${escape(actionLabel[s.pending.body.action])} · заказ ${escape(s.reviewed?.displayNumber ?? s.pending.orderId)}. Новые действия заблокированы.</p>${s.conflict ? `<p>Состояние на узле: <strong>${escape(s.reviewed ? (labels[s.reviewed.state] ?? s.reviewed.state) : 'не получено')}</strong>${s.reviewed ? ` · версия ${s.reviewed.version}` : ''}. Команда автоматически не повторяется.</p>${button('Перечитать заказ', 'id="review"', s.busy)} ${button('Сверил состояние - продолжить', 'id="acknowledge"', s.busy || !s.reviewed)}` : `<p>Повтор использует исходные действие, версии и ключ. Не выполняйте действие повторно на другом терминале до сверки.</p>${button('Проверить повтором той же команды', 'id="retry"', s.busy || s.storageBlocked)}`}</aside>`
    : '';
  const board = displayWindow(s.display, boardPage);
  const boardPages = board.pages;
  boardPage = board.page;
  const pagination =
    s.mode === 'display'
      ? `<footer class="pagination"><strong>PICK YOUR PEAK</strong><span>Страница ${boardPage + 1} из ${boardPages} · всего ${s.display.length} · смена каждые 8 секунд</span></footer>`
      : `<footer class="pagination">${button('В начало очереди', 'id="first"', s.busy || !s.cursor)}<span>${s.mode === 'kitchen' ? 'Заказы' : 'Номера'}: ${s.mode === 'kitchen' ? s.orders.length : s.display.length}${s.next ? ' · есть следующая страница' : ''}</span>${button('Следующая страница', 'id="next"', s.busy || !s.next)}</footer>`;
  let content: string;
  if (s.mode === 'display') {
    content = `<main class="board workspace" data-testid="display"><section><h2>ГОТОВИТСЯ</h2><div class="numbers">${
      board.preparing
        .map(
          (o) =>
            `<article><strong${o.number.length > 4 ? ' class="long-number"' : ''}>${escape(o.number)}</strong>${o.name ? `<span class="guest-display-name">${escape(o.name)}</span>` : ''}</article>`,
        )
        .join('') || '<p>Новых заказов пока нет</p>'
    }</div></section><section class="ready"><h2>✓ ГОТОВО</h2><div class="numbers">${
      board.ready
        .map(
          (o) =>
            `<article><strong${o.number.length > 4 ? ' class="long-number"' : ''}>${escape(o.number)}</strong>${o.name ? `<span class="guest-display-name">${escape(o.name)}</span>` : ''}</article>`,
        )
        .join('') || '<p>Готовые заказы появятся здесь</p>'
    }</div><p class="take-hint">Подойдите к стойке выдачи и назовите номер заказа</p></section></main>`;
  } else {
    content = `<main class="workspace"><div class="tickets" data-testid="queue">${
      visibleOrders
        .map((o) => {
          if (demo)
            return demoTicket(o, s.stations, s.stationId ?? '', demo.details(o.orderId), blocked);
          const actions = allowedActions(o, s.stationId ?? '', s.wholeTicketActions);
          const prepTicket = s.wholeTicketActions && s.stationId !== o.assemblyStationId;
          const visibleTasks = prepTicket
            ? o.tasks.filter((t) => t.stationId === s.stationId)
            : o.tasks;
          const extras = prepTicket ? o.tasks.filter((t) => t.stationId !== s.stationId) : [];
          return `<article class="ticket ${o.state === 'cancel_requested' ? 'cancel' : ''}" data-order="${o.orderId}"><div class="ticket-head"><strong class="number">${escape(o.displayNumber ?? '-')}</strong><div><span class="mode">${o.serviceMode === 'dine_in' ? 'В ЗАЛЕ' : 'С СОБОЙ'}</span><p class="channel">${o.channel === 'pos' ? 'Касса' : 'Приложение'}</p></div><div class="age"><strong>${Math.max(0, Math.floor((Date.now() - Date.parse(o.createdAt)) / 60000))} мин</strong><small>${escape(labels[o.state] ?? o.state)}</small></div></div>${o.kitchenComment ? `<aside class="order-note"><strong>Комментарий к заказу</strong><p>${escape(o.kitchenComment)}</p></aside>` : ''}<div class="lines">${visibleTasks
            .map((t) => {
              const index = o.tasks.indexOf(t);
              const own = t.stationId === s.stationId;
              const a = actions.find((a) => 'taskId' in a && a.taskId === t.taskId);
              return `<section class="line ${own ? '' : 'other-station'}"><span class="line-number" aria-label="Позиция ${index + 1}">${index + 1}</span><span class="quantity">${t.details.quantity}×</span><div class="line-info"><h3>${escape(t.details.title)}</h3>${t.details.parentTitle && t.details.parentTitle !== t.details.title ? `<p class="parent">${escape(t.details.parentTitle)}</p>` : ''}${t.details.modifiers.length ? `<p class="modifiers">${t.details.modifiers.map((m) => `${escape(m.groupTitle.ru)}: ${escape(m.label.ru)}${m.quantity > 1 ? ' ×' + m.quantity : ''}`).join(' · ')}</p>` : ''}${t.details.description && t.details.description !== o.kitchenComment ? `<p class="description">${escape(t.details.description)}</p>` : ''}<p class="task-state">${own ? 'Эта станция' : escape(s.stations.find((x) => x.id === t.stationId)?.name ?? 'Другая станция')} · ${escape(labels[t.state] ?? t.state)}</p>${a ? button(actionLabel[a.action], `id="task-${t.taskId}" data-command="${escape(JSON.stringify({ orderId: o.orderId, body: a }))}"`, blocked) : ''}</div></section>`;
            })
            .join(
              '',
            )}</div>${extras.length ? `<p class="assembly-extras">На других станциях: ${extras.map((t) => `${escape(t.details.title)} ×${t.details.quantity}`).join(' · ')}</p>` : ''}<div class="ticket-actions">${actions
            .filter((a) => !('taskId' in a))
            .map((a) =>
              button(
                a.action === 'complete_station' && s.stationId === o.assemblyStationId
                  ? 'Заказ собран'
                  : actionLabel[a.action],
                `id="order-${o.orderId}" data-command="${escape(JSON.stringify({ orderId: o.orderId, body: a }))}"`,
                blocked,
              ),
            )
            .join(
              '',
            )}${o.state === 'cancel_requested' ? '<p>Сначала подтвердите остановку своих позиций. Итоговую отмену и остатки сверяет управляющий.</p>' : ''}${!actions.length && o.state !== 'cancel_requested' ? '<p>Ожидание следующей станции</p>' : ''}</div></article>`;
        })
        .join('') ||
      '<div class="empty"><span>✓</span><h2>Очередь пуста</h2><p>Новые допущенные заказы появятся здесь автоматически</p></div>'
    }</div></main>`;
  }
  const demoControls = demo
    ? `<aside class="demo-controls" aria-label="Управление демо"><div><strong>ДЕМО · ПРОВЕРКА ДИЗАЙНА</strong><span>Вымышленные заказы. Касса не нужна. Обновление страницы начинает сценарий заново.</span></div>${button('+ Новый заказ', 'id="demo-add"', blocked)}${button(autoOrders ? 'Поток: каждые 25 с · пауза' : 'Продолжить поток заказов', 'id="demo-auto" aria-pressed="' + autoOrders + '"')}${button('Сбросить демо', 'id="demo-reset"', blocked)}<span role="status">${escape(demoNotice)}</span></aside>`
    : '';
  root.innerHTML = header + demoControls + nav + error + recovery + content + pagination;
  document.getElementById('demo-add')?.addEventListener('click', () => {
    if (demo) {
      demoNotice = demo.add() ? 'Добавлен новый заказ' : 'Очередь заполнена. Сбросьте демо.';
      void model.refresh();
    }
  });
  document.getElementById('demo-auto')?.addEventListener('click', () => {
    autoOrders = !autoOrders;
    render();
  });
  document.getElementById('demo-reset')?.addEventListener('click', () => {
    demo?.reset();
    demoNotice = 'Начальный сценарий восстановлен';
    void model.refresh();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-demo-order]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!demo || blocked || !s.stationId) return;
      demoNotice = demo.completeTicket(b.dataset.demoOrder!, s.stationId, Number(b.dataset.version))
        ? 'Чек подтверждён'
        : 'Заказ уже изменился. Проверьте очередь.';
      void model.refresh();
    }),
  );
  document.querySelector('.workspace')?.scrollTo({ top: scroll });
  for (const [id, fn] of Object.entries({
    'mode-kitchen': () => model.selectMode('kitchen'),
    'mode-display': () => model.selectMode('display'),
    refresh: () => model.refresh(),
    logout: () => model.logout(),
    retry: () => model.retry(),
    review: () => model.reviewConflict(),
    acknowledge: () => model.acknowledgeConflict(),
    first: () => model.page(true),
    next: () => model.page(),
  }))
    document.getElementById(id)?.addEventListener('click', fn);
  document.querySelectorAll<HTMLButtonElement>('[data-station]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.station) void model.selectStation(b.dataset.station);
    }),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((b) =>
    b.addEventListener('click', () => {
      const data = JSON.parse(b.dataset.command!) as { orderId: string; body: Action };
      const o = s.orders.find((x) => x.orderId === data.orderId);
      if (o) void model.command(o, data.body);
    }),
  );
  if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
}
function updateLoginWait() {
  const seconds = Math.max(0, Math.ceil((model.retryLoginAt - Date.now()) / 1000));
  const submit = document.querySelector<HTMLButtonElement>('#sign-in');
  if (submit) {
    submit.disabled = model.state.busy || !terminalId || seconds > 0;
    submit.textContent = model.state.busy
      ? 'Входим...'
      : seconds
        ? `Подождите ${seconds} с`
        : 'Войти';
    document.getElementById('login-wait')!.textContent = seconds
      ? `Повторить вход через ${seconds} с`
      : '';
  }
}
render();
if (!demo) {
  try {
    const response = await fetch(apiPrefix + '/config.json', {
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    const config = (await response.json()) as { branchLabel?: unknown; terminalId?: unknown };
    if (typeof config.branchLabel === 'string') branch = config.branchLabel.slice(0, 120);
    if (typeof config.terminalId === 'string' && UUID.test(config.terminalId))
      terminalId = config.terminalId;
  } catch {
    /* local default */
  }
}
configLoaded = true;
render();
window.setInterval(() => {
  updateLoginWait();
  const clock = document.getElementById('clock');
  if (clock)
    clock.textContent = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Asia/Almaty',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
}, 1000);
if (demo) {
  await model.importCredential(JSON.stringify(demo.credential));
  const view = new URLSearchParams(location.search).get('view');
  if (view === 'display') await model.selectMode('display');
  if (view === 'assembly') await model.selectStation(demo.stations[1].id);
  window.setInterval(() => {
    if (!autoOrders || document.hidden || model.state.busy || model.state.pending) return;
    if (!demo.add()) {
      autoOrders = false;
      demoNotice = 'Очередь заполнена. Сбросьте демо.';
    }
    void model.refresh();
  }, 25000);
} else {
  await model.restore();
  await selectInitialScreen();
}
startRuntime(model, () => {
  boardPage++;
  render();
});
