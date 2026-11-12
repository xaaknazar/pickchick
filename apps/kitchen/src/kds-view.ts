/**
 * Cutover KDS screens (contracts sections 2.3, 5.4; design-kds section 5). Shown only while the
 * edge KDS layout is on and the open station has a KDS function; everything else keeps today's
 * ticket view. Pure HTML builders: every value is escaped, commands use the existing
 * data-command buttons of app.ts, the courier dialogs open from data-handover/data-incident.
 */
import type {
  Action,
  Breading,
  Delivery,
  Incident,
  IncidentKind,
  IncidentProvider,
  KdsFunction,
  Order,
  Station,
  Task,
} from './types.js';

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const providerName: Record<IncidentProvider, string> = {
  yandex_eda: 'Яндекс Еда',
  glovo: 'Glovo',
  other: 'Другой агрегатор',
};
export const incidentKindName: Record<IncidentKind, string> = {
  number_mismatch: 'Номер не совпал',
  not_accepted_in_app: 'Курьер не нажал «Принял заказ»',
  no_photo: 'Курьер не сфотографировал заказ',
  courier_refused: 'Курьер отказался забирать',
  other: 'Другое',
};
/** "1 заказ", "2 заказа", "5 заказов". */
export function plural(n: number, forms: readonly [string, string, string]) {
  const ten = n % 10,
    hundred = n % 100;
  const form =
    ten === 1 && hundred !== 11
      ? forms[0]
      : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)
        ? forms[1]
        : forms[2];
  return `${n} ${form}`;
}
export const deliveryLabel = (d: Delivery) =>
  `ДОСТАВКА · ${providerName[d.provider]} ${d.externalNumber}`;
/** The same label as markup: the courier number never breaks at its hyphen. */
const deliveryChip = (d: Delivery) =>
  `ДОСТАВКА · ${escape(providerName[d.provider])} <span class="nowrap">${escape(d.externalNumber)}</span>`;
const modeLabel = (o: { serviceMode: Order['serviceMode']; delivery?: Delivery }) =>
  o.delivery ? deliveryLabel(o.delivery) : o.serviceMode === 'dine_in' ? 'В ЗАЛЕ' : 'С СОБОЙ';
/** Chip colour: hall, takeaway and delivery read apart at a glance. */
export const modeClass = (o: { serviceMode: Order['serviceMode']; delivery?: Delivery }) =>
  'mode ' + (o.delivery ? 'mode-delivery' : 'mode-' + o.serviceMode);
/** Minutes a ticket may wait before its head turns amber, then red. */
export const WAIT_WARN_MINUTES = 7;
export const WAIT_LATE_MINUTES = 12;
export function waitClass(createdAt: string | undefined, now: number) {
  const age = (now - Date.parse(createdAt ?? '')) / 60000;
  return age >= WAIT_LATE_MINUTES ? 'wait-late' : age >= WAIT_WARN_MINUTES ? 'wait-warn' : '';
}
const open = (t: Task) => t.state === 'queued' || t.state === 'in_progress';
/** Orders the regular ticket view shows as today: stopping, or held for the restore review. */
const special = (o: Order) =>
  o.state === 'cancel_requested' || (!!o.restoreReview && o.restoreReview.status !== 'resume');

export type KdsScreenInput = {
  fn: KdsFunction;
  stationId: string;
  stations: Station[];
  orders: Order[];
  breading: Breading | null;
  incidents: Incident[];
  now: number;
  /** Number typed at the courier counter (3): filters tiles and sets the first mark. */
  courierNumber: string;
  actions: (o: Order) => Action[];
  blocked: (o: Order) => boolean;
  /** Today's ticket markup (stop confirmation, restore review). */
  ticket: (o: Order) => string;
};

/** Tickets a KDS station works on; the rest of the page is context for other stations. */
export function kdsVisible(fn: KdsFunction, stationId: string, orders: Order[]): Order[] {
  const own = (o: Order) => o.tasks.some((t) => t.stationId === stationId && open(t));
  const mine = (o: Order) => o.tasks.some((t) => t.stationId === stationId);
  return orders.filter((o) => {
    if (special(o)) return mine(o) || o.assemblyStationId === stationId;
    if (fn === 'issue') return o.assemblyStationId === stationId || own(o);
    if (fn === 'delivery_handover') return o.assemblyStationId === stationId;
    return own(o);
  });
}

/** Station 5 strip: open toasts and burgers right now, and by product. */
export function toastTotals(orders: Order[], stationId: string) {
  const units = { toast: 0, burger: 0, other: 0 };
  const byTitle = new Map<string, number>();
  for (const o of orders)
    for (const t of o.tasks) {
      if (t.stationId !== stationId || !open(t)) continue;
      const n = t.details.kds?.units ?? t.details.quantity;
      const unit = t.details.kds?.unit;
      units[unit === 'toast' || unit === 'burger' ? unit : 'other'] += n;
      byTitle.set(t.details.title, (byTitle.get(t.details.title) ?? 0) + n);
    }
  return { units, byTitle: [...byTitle].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
}

function button(text: string, attrs: string, disabled: boolean) {
  return `<button ${attrs}${disabled ? ' disabled' : ''}>${text}</button>`;
}
function command(o: Order, a: Action, label: string, blocked: boolean, extra = '') {
  return button(
    label,
    `id="order-${o.orderId}" class="kds-action${extra}" data-command="${escape(JSON.stringify({ orderId: o.orderId, body: a }))}"`,
    blocked,
  );
}
function head(
  o: { displayNumber: string | null; serviceMode: Order['serviceMode']; delivery?: Delivery },
  age: string,
  status = '',
  wait = '',
) {
  return `<div class="ticket-head${wait ? ' ' + wait : ''}"><strong class="number">${escape(o.displayNumber ?? '-')}</strong><div><span class="${modeClass(o)}">${o.delivery ? deliveryChip(o.delivery) : escape(modeLabel(o))}</span></div><div class="age"><strong>${escape(age)}</strong>${status ? `<small>${escape(status)}</small>` : ''}</div></div>`;
}
const minutes = (from: string, now: number) =>
  `${Math.max(0, Math.floor((now - Date.parse(from)) / 60000))} мин`;
function line(t: Task, extra = '', orderComment = '') {
  const d = t.details;
  return `<section class="line kds-line"><span class="quantity${d.quantity > 1 ? ' many' : ''}">${d.quantity}×</span><div class="line-info"><h3>${escape(d.title)}</h3>${d.parentTitle && d.parentTitle !== d.title ? `<p class="parent">${escape(d.parentTitle)}</p>` : ''}${d.modifiers.length ? `<p class="modifiers">${d.modifiers.map((m) => `${escape(m.groupTitle.ru)}: ${escape(m.label.ru)}${m.quantity > 1 ? ' ×' + m.quantity : ''}`).join(' · ')}</p>` : ''}${d.description && d.description !== orderComment ? `<p class="description">${escape(d.description)}</p>` : ''}${d.kds?.unmapped ? '<p class="kds-unmapped" role="note">Нет в раскладке - сообщите менеджеру</p>' : ''}${extra}</div></section>`;
}
const comment = (o: Order) =>
  o.kitchenComment
    ? `<aside class="order-note"><strong>Комментарий к заказу</strong><p>${escape(o.kitchenComment)}</p></aside>`
    : '';
const empty = (title: string, text: string) =>
  `<div class="empty"><span>✓</span><h2>${escape(title)}</h2><p>${escape(text)}</p></div>`;
const stationName = (stations: Station[], id: string | undefined) =>
  stations.find((s) => s.id === id)?.name ?? 'стол сборки';

/** "Менеджер вызван · G-456 · 3 мин" on screens 2 and 3 (open courier incidents). */
export function incidentBanner(items: Incident[], now: number) {
  if (!items.length) return '';
  return `<aside class="kds-banner" role="alert" data-testid="incident-banner">${items
    .slice(0, 4)
    .map(
      (i) =>
        `<p><strong>Менеджер вызван</strong> · ${escape(i.claimedNumber ?? (i.displayNumber ? '№' + i.displayNumber : 'без номера'))} · ${escape(minutes(i.recordedAt, now))} · ${escape(incidentKindName[i.kind])}</p>`,
    )
    .join(
      '',
    )}${items.length > 4 ? `<p>Ещё ${escape(plural(items.length - 4, ['отказ', 'отказа', 'отказов']))}</p>` : ''}</aside>`;
}

function breadingScreen(view: Breading | null, now: number) {
  const orders = view?.orders ?? [];
  const summary = `<section class="kds-summary" data-testid="kds-summary"><p><span>В очереди</span><strong>${escape(plural(orders.length, ['заказ', 'заказа', 'заказов']))}</strong></p>${view?.totalFingers !== undefined ? `<p><span>Фингерсов</span><strong data-testid="total-fingers">${view.totalFingers}</strong></p>` : ''}<p class="kds-hint">Заказ уходит с экрана, когда стол отметит «Собран».</p></section>`;
  const cards = orders
    .map(
      (o) =>
        `<article class="ticket kds-ticket" data-breading="${o.orderId}">${head(o, '')}<div class="lines">${o.lines
          .map(
            (l) =>
              `<section class="line kds-line"><span class="quantity${l.quantity > 1 ? ' many' : ''}">${l.quantity}×</span><div class="line-info"><h3>${escape(l.title)}</h3>${l.fingers !== undefined ? `<p class="kds-count">Фингерсов: ${l.fingers}</p>` : ''}</div></section>`,
          )
          .join(
            '',
          )}</div>${o.fingers !== undefined ? `<p class="kds-total">Фингерсов: <strong>${o.fingers}</strong></p>` : ''}</article>`,
    )
    .join('');
  void now;
  return (
    summary +
    `<div class="tickets" data-testid="queue">${cards || empty('Очередь пуста', 'Заказы для панировки появятся здесь автоматически')}</div>`
  );
}

function toastsScreen(input: KdsScreenInput, visible: Order[]) {
  const totals = toastTotals(visible, input.stationId);
  const parts = [
    ...(totals.units.toast ? [`Тосты <strong>${totals.units.toast}</strong>`] : []),
    ...(totals.units.burger ? [`Бургеры <strong>${totals.units.burger}</strong>`] : []),
    ...(totals.units.other ? [`Позиции <strong>${totals.units.other}</strong>`] : []),
  ];
  const summary = `<section class="kds-summary" data-testid="kds-summary"><p class="kds-now"><span>Нужно сейчас</span><strong>${parts.join(' · ') || '0'}</strong></p>${totals.byTitle.length ? `<p class="kds-breakdown">${totals.byTitle.map(([title, n]) => `${escape(title)} ×${n}`).join(' · ')}</p>` : ''}</section>`;
  const cards = visible
    .map((o) => {
      if (special(o)) return input.ticket(o);
      const own = o.tasks.filter((t) => t.stationId === input.stationId && open(t));
      const a = input.actions(o).find((x) => x.action === 'complete_station');
      return `<article class="ticket kds-ticket" data-order="${o.orderId}">${head(o, minutes(o.createdAt, input.now), '', waitClass(o.createdAt, input.now))}${comment(o)}<div class="lines">${own
        .map((t) =>
          line(
            t,
            `${t.details.kds?.units !== undefined && (t.details.kds.unit || t.details.kds.units !== t.details.quantity) ? `<p class="kds-count">${t.details.kds.unit === 'burger' ? 'Бургеров' : t.details.kds.unit === 'toast' ? 'Тостов' : 'Штук'}: ${t.details.kds.units}</p>` : ''}<p class="task-state">Отдать: ${escape(stationName(input.stations, t.details.kds?.upstreamOf))}</p>`,
            o.kitchenComment,
          ),
        )
        .join(
          '',
        )}</div><div class="ticket-actions">${a ? command(o, a, 'Готово', input.blocked(o)) : '<p>Ожидание стола</p>'}</div></article>`;
    })
    .join('');
  return (
    summary +
    `<div class="tickets" data-testid="queue">${cards || empty('Очередь пуста', 'Тосты и бургеры новых заказов появятся здесь автоматически')}</div>`
  );
}

function tableScreen(input: KdsScreenInput, visible: Order[]) {
  const cards = visible
    .map((o) => {
      if (special(o)) return input.ticket(o);
      const own = o.tasks.filter((t) => t.stationId === input.stationId && open(t));
      const upstream = o.tasks.filter((t) => t.details.kds?.upstreamOf === input.stationId);
      const issue = o.tasks.some((t) => t.details.kds?.function === 'issue');
      const a = input.actions(o).find((x) => x.action === 'complete_station');
      return `<article class="ticket kds-ticket" data-order="${o.orderId}">${head(o, minutes(o.createdAt, input.now), '', waitClass(o.createdAt, input.now))}${comment(o)}<div class="lines">${own
        .map((t) => {
          const toast = upstream.find(
            (u) =>
              u.details.lineId === t.details.lineId && u.details.productId === t.details.productId,
          );
          const word = toast?.details.kds?.unit === 'burger' ? 'Бургер' : 'Тост';
          const state = !toast
            ? ''
            : toast.state === 'done'
              ? `<p class="kds-chip kds-chip-done">${word}: готов ✓</p>`
              : toast.state === 'in_progress'
                ? `<p class="kds-chip">${word}: в работе</p>`
                : `<p class="kds-chip kds-chip-wait">${word}: ждём</p>`;
          return line(
            t,
            `${t.details.kds?.fingers !== undefined ? `<p class="kds-count">Фингерсов: ${t.details.kds.fingers}</p>` : ''}${state}`,
            o.kitchenComment,
          );
        })
        .join(
          '',
        )}</div>${issue ? '<p class="assembly-extras">Напитки и соусы - на выдаче</p>' : ''}<div class="ticket-actions">${a ? command(o, a, 'Собран', input.blocked(o)) : '<p>Ожидание следующей станции</p>'}</div></article>`;
    })
    .join('');
  return `<div class="tickets" data-testid="queue">${cards || empty('Очередь пуста', 'Новые заказы для сборки появятся здесь автоматически')}</div>`;
}

function issueScreen(input: KdsScreenInput, visible: Order[]) {
  const card = (o: Order) => {
    if (special(o)) return input.ticket(o);
    const own = o.tasks.filter((t) => t.stationId === input.stationId);
    const assembly = o.tasks.filter(
      (t) => t.stationId !== input.stationId && t.details.kds?.function !== 'toasts',
    );
    const actions = input.actions(o);
    const hall = o.assemblyStationId === input.stationId;
    const done = o.tasks.every((t) => t.stationId === input.stationId || t.state === 'done');
    const prepare = own.length
      ? `<div class="kds-block"><h4>Подготовить на выдаче: напитки, соусы</h4><div class="lines">${own
          .map((t) =>
            line(
              t,
              t.state === 'done' ? '<p class="kds-chip kds-chip-done">Готово ✓</p>' : '',
              o.kitchenComment,
            ),
          )
          .join('')}</div></div>`
      : '';
    const table = hall
      ? `<div class="kds-block"><h4>${done ? 'Сборка: собран ✓' : 'Сборка: собирается'}</h4><p class="kds-compact">${assembly.map((t) => `${t.details.quantity}× ${escape(t.details.title)}`).join(' · ') || '-'}</p></div>`
      : '';
    let buttons: string;
    if (!hall) {
      const a = actions.find((x) => x.action === 'complete_station');
      buttons = a ? command(o, a, 'Напитки переданы', input.blocked(o)) : '';
    } else if (o.state === 'ready') {
      const a = actions.find((x) => x.action === 'handoff');
      buttons = a ? command(o, a, 'Выдан', input.blocked(o), ' kds-final') : '';
    } else {
      const a = actions.find((x) => x.action === 'complete_station');
      buttons = a
        ? command(o, a, 'Готов - позвать гостя', input.blocked(o))
        : '<p>Ждём сборку со стола</p>';
    }
    return `<article class="ticket kds-ticket${o.state === 'ready' ? ' kds-ready' : ''}" data-order="${o.orderId}">${head(o, minutes(o.createdAt, input.now), o.state === 'ready' ? 'Готов к выдаче' : '', o.state === 'ready' ? '' : waitClass(o.createdAt, input.now))}${comment(o)}${prepare}${table}<div class="ticket-actions">${buttons}</div></article>`;
  };
  const preparing = visible.filter((o) => o.state !== 'ready');
  const ready = visible.filter((o) => o.state === 'ready');
  return `<div class="kds-columns" data-testid="queue"><section class="kds-column" data-column="preparing"><h2>Собирается <span>${preparing.length}</span></h2><div class="tickets">${preparing.map(card).join('') || '<p class="kds-none">Нет заказов</p>'}</div></section><section class="kds-column" data-column="ready"><h2>Готов к выдаче <span>${ready.length}</span></h2><div class="tickets">${ready.map(card).join('') || '<p class="kds-none">Нет готовых заказов</p>'}</div></section></div>`;
}

function counterScreen(input: KdsScreenInput, visible: Order[]) {
  const typed = input.courierNumber.trim().toUpperCase();
  const shown = typed
    ? visible.filter(
        (o) =>
          o.delivery?.externalNumber.includes(typed) || (o.displayNumber ?? '').includes(typed),
      )
    : visible;
  const tile = (o: Order) => {
    if (special(o) || !o.delivery) return input.ticket(o);
    const actions = input.actions(o);
    const others = o.tasks.filter(
      (t) => t.stationId !== input.stationId && t.details.kds?.function !== 'toasts',
    );
    const table = others.filter((t) => t.details.kds?.function !== 'issue');
    const drinks = others.filter((t) => t.details.kds?.function === 'issue');
    const blocked = input.blocked(o);
    let status: string, buttons: string;
    if (o.state === 'ready') {
      status = 'Принят от сборки - ждёт курьера';
      buttons =
        button(
          'Передать курьеру',
          `id="handover-${o.orderId}" class="kds-action kds-final" data-handover="${o.orderId}"`,
          blocked || !actions.some((a) => a.action === 'handoff'),
        ) +
        button(
          'Отказ по протоколу',
          `id="incident-${o.orderId}" class="kds-secondary" data-incident="${o.orderId}"`,
          blocked,
        );
    } else {
      const a = actions.find((x) => x.action === 'complete_station');
      status = a ? 'Собрано - примите от сборки' : 'Собирается';
      buttons = a ? command(o, a, 'Принять от сборки', blocked) : '';
    }
    const progress = [
      table.length
        ? `<p class="kds-chip${table.every((t) => t.state === 'done') ? ' kds-chip-done' : ''}">Стол: ${table.every((t) => t.state === 'done') ? 'собран ✓' : 'собирается'}</p>`
        : '',
      drinks.length
        ? `<p class="kds-chip${drinks.every((t) => t.state === 'done') ? ' kds-chip-done' : ''}">Напитки: ${drinks.every((t) => t.state === 'done') ? 'переданы ✓' : 'на выдаче'}</p>`
        : '',
    ].join('');
    const match = typed && o.delivery.externalNumber === typed;
    return `<article class="ticket courier-tile${match ? ' courier-match' : ''}${o.state === 'ready' ? ' kds-ready' : ''}" data-order="${o.orderId}"><div class="courier-head"><span class="courier-provider">${escape(providerName[o.delivery.provider])}</span><strong class="courier-number">${escape(o.delivery.externalNumber)}</strong><span class="courier-meta">Заказ №${escape(o.displayNumber ?? '-')} · ${escape(minutes(o.createdAt, input.now))}</span></div><p class="courier-status">${escape(status)}</p><div class="kds-progress">${progress}</div><p class="kds-compact">${others
      .concat(o.tasks.filter((t) => t.stationId === input.stationId))
      .map((t) => `${t.details.quantity}× ${escape(t.details.title)}`)
      .join(' · ')}</p><div class="ticket-actions">${buttons}</div></article>`;
  };
  const filter = `<section class="courier-filter"><label for="courier-number">Номер из приложения курьера</label><input id="courier-number" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40" value="${escape(input.courierNumber)}" placeholder="Например G-456">${button('Очистить', 'id="courier-clear" class="kds-secondary"', !input.courierNumber)}${button('Отказ по протоколу', 'id="incident-general" class="kds-secondary" data-incident=""', false)}</section>`;
  return `${filter}<div class="tickets courier-tiles" data-testid="queue">${shown.map(tile).join('') || empty(typed ? 'Заказ с таким номером не найден' : 'Заказов доставки нет', typed ? 'Проверьте номер в приложении курьера или запишите отказ по протоколу' : 'Собранные заказы доставки появятся здесь автоматически')}</div>`;
}

/** The workspace of a KDS station: summary strip, banner, tickets or columns. */
export function kdsScreen(input: KdsScreenInput): string {
  const visible = kdsVisible(input.fn, input.stationId, input.orders);
  const banner =
    input.fn === 'issue' || input.fn === 'delivery_handover'
      ? incidentBanner(input.incidents, input.now)
      : '';
  const body =
    input.fn === 'breading'
      ? breadingScreen(input.breading, input.now)
      : input.fn === 'toasts'
        ? toastsScreen(input, visible)
        : input.fn === 'issue'
          ? issueScreen(input, visible)
          : input.fn === 'delivery_handover'
            ? counterScreen(input, visible)
            : tableScreen(input, visible);
  // The banner stays above the scrolling queue, like the error and recovery panels.
  return `${banner}<main class="workspace kds kds-${input.fn}" data-kds="${input.fn}">${body}</main>`;
}
