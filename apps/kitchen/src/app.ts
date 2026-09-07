import { KitchenModel, allowedActions, displayWindow } from './model.js';
import { request } from './api.js';
import type { Action } from './types.js';
const root = document.querySelector<HTMLDivElement>('#app')!;
let branch = 'Локальная точка';
let boardPage = 0;
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
  ready: 'Заказ собран',
  handoff: 'Подтвердить выдачу',
  confirm_stop: 'Приготовление остановлено',
};
const errors: Record<string, string> = {
  CONNECTION_UNKNOWN: 'Нет ответа локального узла. Результат команды неизвестен.',
  EDGE_TIMEOUT: 'Локальный узел не ответил. Результат команды неизвестен.',
  CONFLICT: 'Заказ изменён другим сотрудником. Сверьте актуальное состояние.',
  SESSION_EXPIRED: 'Сессия истекла. Импортируйте новый файл доступа.',
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
const model = new KitchenModel(
  request,
  sessionStorage,
  localStorage,
  async (name) => {
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
  const focus = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';
  const scroll = document.querySelector('.workspace')?.scrollTop ?? 0;
  const blocked = s.busy || !!s.pending || s.storageBlocked || !s.lease || !!s.error;
  const clock = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(),
  );
  const header = `<header><div class="brand"><img src="/logo.png" alt="Pick Chick"></div><div class="heading"><h1>${escape(s.mode === 'display' ? 'Табло выдачи' : 'Кухня · ' + (s.stations.find((t) => t.id === s.stationId)?.name ?? 'станция'))}</h1><p>${escape(branch)}</p></div>${s.actor && s.mode === 'kitchen' ? `<div class="stat"><span>НА СТРАНИЦЕ</span><strong>${s.orders.length}</strong></div><div class="stat"><span>В РАБОТЕ</span><strong>${s.orders.filter((o) => o.state === 'in_production').length}</strong></div>` : ''}<time>${clock}</time></header>`;
  if (!s.actor) {
    root.innerHTML =
      header +
      `<main class="login"><section><h2>Доступ сотрудника</h2><p>Импортируйте JSON-файл, выданный управляющим для этой точки и терминала.</p><label class="file">Выбрать файл доступа<input id="credential" type="file" accept="application/json,.json" ${s.busy ? 'disabled' : ''}></label><p class="muted">Кухня работает через локальный узел. Сессия хранится только в этом окне; незавершённая команда сохраняется после выхода.</p>${s.error ? `<p class="error" role="alert">${escape(errors[s.error] ?? 'Не удалось подключиться. Проверьте доступ и локальный узел.')}</p>` : ''}</section></main>`;
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
        }
      });
    return;
  }
  const nav = `<nav aria-label="Рабочий экран">${button('Кухня', 'id="mode-kitchen" aria-pressed="' + (s.mode === 'kitchen') + '"', blocked)}${button('Табло', 'id="mode-display" aria-pressed="' + (s.mode === 'display') + '"', blocked)}${s.mode === 'kitchen' ? `<label>Станция <select id="station" ${blocked ? 'disabled' : ''}>${s.stations.map((t) => `<option value="${t.id}"${t.id === s.stationId ? ' selected' : ''}>${escape(t.name)}</option>`).join('')}</select></label>` : ''}<span class="connection ${s.error ? 'offline' : ''}" role="status">${s.error ? 'Нет актуального подтверждения связи' : s.lastSync ? 'Связь с локальным узлом' : 'Подключение'}${s.lastSync ? ` · ${new Date(s.lastSync).toLocaleTimeString('ru-RU')}` : ''}</span>${button('Обновить', 'id="refresh"', s.busy)}${button('Выйти', 'id="logout"')}</nav>`;
  const error = s.error
    ? `<aside class="error" role="alert">${escape(errors[s.error] ?? 'Операция не завершена. Проверьте локальный узел и доступ.')} ${s.lastSync ? 'Показаны последние полученные данные.' : ''}</aside>`
    : '';
  const recovery = s.pending
    ? `<aside class="recovery" data-testid="recovery"><h2>${s.conflict ? 'Требуется сверка' : 'Незавершённая команда'}</h2><p>${escape(actionLabel[s.pending.body.action])} · заказ ${escape(s.reviewed?.displayNumber ?? s.pending.orderId)}. Новые действия заблокированы.</p>${s.conflict ? `<p>Состояние на узле: <strong>${escape(s.reviewed ? (labels[s.reviewed.state] ?? s.reviewed.state) : 'не получено')}</strong>${s.reviewed ? ` · версия ${s.reviewed.version}` : ''}. Команда автоматически не повторяется.</p>${button('Перечитать заказ', 'id="review"', s.busy)} ${button('Сверил состояние — продолжить', 'id="acknowledge"', s.busy || !s.reviewed)}` : `<p>Повтор использует исходные действие, версии и ключ. Не выполняйте действие повторно на другом терминале до сверки.</p>${button('Проверить повтором той же команды', 'id="retry"', s.busy || s.storageBlocked)}`}</aside>`
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
            `<article><strong${o.number.length > 4 ? ' class="long-number"' : ''}>${escape(o.number)}</strong></article>`,
        )
        .join('') || '<p>Новых заказов пока нет</p>'
    }</div></section><section class="ready"><h2>✓ ГОТОВО</h2><div class="numbers">${
      board.ready
        .map(
          (o) =>
            `<article><strong${o.number.length > 4 ? ' class="long-number"' : ''}>${escape(o.number)}</strong></article>`,
        )
        .join('') || '<p>Готовые заказы появятся здесь</p>'
    }</div><p class="take-hint">Подойдите к стойке выдачи и назовите номер заказа</p></section></main>`;
  } else {
    content = `<main class="workspace"><div class="tickets" data-testid="queue">${
      s.orders
        .map((o) => {
          const actions = allowedActions(o, s.stationId ?? '');
          return `<article class="ticket ${o.state === 'cancel_requested' ? 'cancel' : ''}" data-order="${o.orderId}"><div class="ticket-head"><strong class="number">${escape(o.displayNumber ?? '—')}</strong><div><span class="mode">${o.serviceMode === 'dine_in' ? 'В ЗАЛЕ' : 'С СОБОЙ'}</span><p class="channel">Приложение</p></div><div class="age"><strong>${Math.max(0, Math.floor((Date.now() - Date.parse(o.createdAt)) / 60000))} мин</strong><small>${escape(labels[o.state] ?? o.state)}</small></div></div><div class="lines">${o.tasks
            .map((t) => {
              const own = t.stationId === s.stationId;
              const a = actions.find((a) => 'taskId' in a && a.taskId === t.taskId);
              return `<section class="line ${own ? '' : 'other-station'}"><span class="quantity">${t.details.quantity}×</span><div class="line-info"><h3>${escape(t.details.title)}</h3>${t.details.parentTitle && t.details.parentTitle !== t.details.title ? `<p class="parent">${escape(t.details.parentTitle)}</p>` : ''}${t.details.modifiers.length ? `<p class="modifiers">${t.details.modifiers.map((m) => `${escape(m.groupTitle.ru)}: ${escape(m.label.ru)}${m.quantity > 1 ? ' ×' + m.quantity : ''}`).join(' · ')}</p>` : ''}${t.details.description ? `<p class="description">${escape(t.details.description)}</p>` : ''}<p class="task-state">${own ? 'Эта станция' : escape(s.stations.find((x) => x.id === t.stationId)?.name ?? 'Другая станция')} · ${escape(labels[t.state] ?? t.state)}</p>${a ? button(actionLabel[a.action], `id="task-${t.taskId}" data-command="${escape(JSON.stringify({ orderId: o.orderId, body: a }))}"`, blocked) : ''}</div></section>`;
            })
            .join('')}</div><div class="ticket-actions">${actions
            .filter((a) => !('taskId' in a))
            .map((a) =>
              button(
                actionLabel[a.action],
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
  root.innerHTML = header + nav + error + recovery + content + pagination;
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
  document.querySelector<HTMLSelectElement>('#station')?.addEventListener('change', (e) => {
    void model.selectStation((e.target as HTMLSelectElement).value);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((b) =>
    b.addEventListener('click', () => {
      const data = JSON.parse(b.dataset.command!) as { orderId: string; body: Action };
      const o = s.orders.find((x) => x.orderId === data.orderId);
      if (o) void model.command(o, data.body);
    }),
  );
  if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
}
try {
  const response = await fetch('/config.json', { credentials: 'omit', redirect: 'error' });
  const config = (await response.json()) as { branchLabel?: unknown };
  if (typeof config.branchLabel === 'string') branch = config.branchLabel.slice(0, 120);
} catch {
  /* local default */
}
render();
await model.restore();
setInterval(() => {
  if (model.state.actor && !model.state.busy) void model.refresh();
}, 5000);

setInterval(() => {
  if (model.state.actor && model.state.mode === 'display' && !model.state.busy) {
    boardPage++;
    render();
  }
}, 8000);
