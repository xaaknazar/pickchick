/**
 * Kitchen and assembly tickets (22.11 redesign). Industry practice (Toast, Square KDS, Fresh KDS,
 * fast-food lines): a prep screen shows only what that station cooks - order number, dish names,
 * quantities and cooking changes, with a running stopwatch. Drinks and sauces never reach the
 * cook; the assembly (expo) screen shows the whole order, drinks and sauces included, as a
 * checklist. Marketing descriptions of the menu are never shown on a kitchen ticket.
 * Pure HTML builders: every value is escaped; buttons keep the data-command contract of app.ts.
 */
import type { Action, Order, Station, Task } from './types.js';
import { modeChip, sourceLabel, waitClass } from './kds-view.js';

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
type Modifier = Task['details']['modifiers'][number];

/**
 * Modifier groups that belong to assembly, not to the cook: the drink of a combo, extra drinks,
 * drink options (iced tea sweetness, Piko flavour) and sauces. Cloud orders carry the menu slugs
 * (drink, drink-extra, sauce, sauce-paid-*); cashier orders carry hashed ids, so the group title
 * decides there (ru and kk).
 */
const DRINK_ID = /^(drink|iced-tea|piko)/;
const SAUCE_ID = /^sauce/;
const DRINK_TITLE = /напит|сусын|сладост|тәттіл|piko/i;
const SAUCE_TITLE = /соус|тұздық|дип/i;
export function modifierKind(m: Modifier): 'drink' | 'sauce' | 'cook' {
  const titles = `${m.groupTitle.ru} ${m.groupTitle.kk}`;
  if (DRINK_ID.test(m.groupId) || DRINK_TITLE.test(titles)) return 'drink';
  if (SAUCE_ID.test(m.groupId) || SAUCE_TITLE.test(titles)) return 'sauce';
  return 'cook';
}
/** Changes the cook must see (e.g. «Острый», «Без лука»); drinks and sauces are left out. */
export const cookModifiers = (t: Task) =>
  t.details.modifiers.filter((m) => modifierKind(m) === 'cook');

/**
 * What goes into each combo and set, for the cook (owner 22.11: «состав комбо, но без напитков», «соус тоже не добавляй»).
 * From the manager menu sheet 22.11 (catalog-admin fixtures manager-menu-2026-11-22, ingredients),
 * drinks and sauces left out (both go on at assembly). Keyed by menu slug (app and kiosk orders) and by Russian name (cashier orders
 * carry hashed ids). A dish not listed shows no composition, never a guess.
 * Change together with the menu when a combo's contents change.
 */
type Part = readonly [name: string, count: number];
const FRIES: Part = ['Фри', 1];
const WEDGES_DUO: Part = ['Фри', 1.5];
const COMPOSITION: Readonly<Record<string, readonly [string, readonly Part[]]>> = {
  'pick-combo': ['Finger Combo', [['Фингерсы', 4], FRIES, ['Тост', 1], ['Коулслоу', 1]]],
  'master-combo': ['Master Combo', [['Фингерсы', 6], FRIES, ['Тост', 2], ['Коулслоу', 1]]],
  'burger-combo': ['Pick Burger Combo', [['Pick Burger', 1], FRIES]],
  'solo-combo': ['Solo Combo', [['Фингерсы', 3], FRIES, ['Тост', 1]]],
  'pick-meal-combo': ['Pick Meal', [['Pick Burger', 1], ['Фингерсы', 2], FRIES]],
  'chick-burger-combo': ['Chick Burger Combo', [['Chick Burger', 1], FRIES]],
  'chick-n-roll-combo': ['Chick N Roll Combo', [['Ролл', 1], FRIES]],
  'chick-n-roll-meal-combo': ['Chick N Roll Meal', [['Ролл', 1], ['Фингерсы', 2], FRIES]],
  'chick-meal-combo': ['Chick Meal', [['Chick Burger', 1], ['Фингерсы', 2], FRIES]],
  'finger-duo': ['Finger Duo', [['Фингерсы', 8], WEDGES_DUO, ['Тост', 2], ['Коулслоу', 2]]],
  'burger-duo': ['Pick Burger Duo', [['Pick Burger', 2], WEDGES_DUO]],
  'mix-duo': [
    'Mix Duo c Pick Burger',
    [['Pick Burger', 1], ['Фингерсы', 4], WEDGES_DUO, ['Тост', 1]],
  ],
  'chick-burger-duo': ['Chick Burger Duo', [['Chick Burger', 2], WEDGES_DUO]],
  'mix-chick-duo': [
    'Mix Duo c Chick Burger',
    [['Chick Burger', 1], ['Фингерсы', 4], WEDGES_DUO, ['Тост', 1]],
  ],
  'mix-burger-duo': ['Mix Burger Duo', [['Pick Burger', 1], ['Chick Burger', 1], WEDGES_DUO]],
  'fingers-25': ['25 фингерсов', [['Фингерсы', 25]]],
  'fingers-50': ['50 фингерсов', [['Фингерсы', 50]]],
  'fingers-75': ['75 фингерсов', [['Фингерсы', 75]]],
  'fingers-100': ['100 фингерсов', [['Фингерсы', 100]]],
};
/** Single items a cook makes, for the «Всего в работе» strip (same names as in combos). */
const SINGLES: Readonly<Record<string, readonly [string, Part]>> = {
  fingers: ['Фингерс 1 шт', ['Фингерсы', 1]],
  wedges: ['Картофельные дольки', FRIES],
  coleslaw: ['Коул слоу', ['Коулслоу', 1]],
  toast: ['Тост 1 шт', ['Тост', 1]],
  burger: ['Pick Burger', ['Pick Burger', 1]],
  'chick-n-roll': ['Chick N Roll', ['Ролл', 1]],
  'chick-burger': ['Chick Burger', ['Chick Burger', 1]],
};
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const BY_NAME = new Map(Object.values(COMPOSITION).map(([name, parts]) => [norm(name), parts]));
const SINGLE_BY_NAME = new Map(Object.values(SINGLES).map(([name, part]) => [norm(name), part]));
/** Order of the strip: what the fryer needs first. */
const STRIP_ORDER = ['Фингерсы', 'Фри', 'Тост', 'Коулслоу', 'Pick Burger', 'Chick Burger', 'Ролл'];
/**
 * «Всего в работе»: everything this station still has to make across all open orders - combo
 * contents plus single items; anything unknown is counted under its own title. Like the «All Day»
 * count of Toast or a chicken chain's fryer screen: the fryer drops one batch, not one per ticket.
 */
export function allDay(orders: Order[], stationId: string): { name: string; count: number }[] {
  const totals = new Map<string, number>();
  const add = (name: string, n: number) => totals.set(name, (totals.get(name) ?? 0) + n);
  for (const o of orders) {
    if (o.state !== 'accepted' && o.state !== 'in_production') continue;
    for (const t of o.tasks) {
      if (t.stationId !== stationId || (t.state !== 'queued' && t.state !== 'in_progress'))
        continue;
      const parts = composition(t);
      if (parts.length) for (const p of parts) add(p.name, p.count);
      else {
        const single =
          SINGLES[t.details.productId]?.[1] ?? SINGLE_BY_NAME.get(norm(t.details.title));
        if (single) add(single[0], single[1] * t.details.quantity);
        else add(t.details.title, t.details.quantity);
      }
    }
  }
  const rank = (name: string) => {
    const i = STRIP_ORDER.indexOf(name);
    return i < 0 ? STRIP_ORDER.length : i;
  };
  return [...totals]
    .map(([name, count]) => ({ name, count }))
    .sort(
      (a, b) => rank(a.name) - rank(b.name) || b.count - a.count || a.name.localeCompare(b.name),
    );
}
export function allDayStrip(orders: Order[], stationId: string) {
  const list = allDay(orders, stationId);
  return `<section class="all-day" data-testid="all-day"><span class="all-day-title">Всего в работе</span>${
    list.length
      ? list
          .map(
            (p) =>
              `<span class="all-day-item"><strong>${amount(p.count)}</strong> ${escape(p.name)}</span>`,
          )
          .join('')
      : '<span class="all-day-none">ничего</span>'
  }</section>`;
}

/**
 * New order signal: a short two-tone chime (Web Audio, no file, no network) and a highlight on
 * the new ticket for a few seconds. The first queue after opening a station never rings.
 */
export const NEW_TICKET_MS = 8000;
export class NewOrders {
  private seen = new Map<string, Set<string>>();
  private since = new Map<string, number>();
  private quietUntil = 0;
  /** A station was just opened: its queue is still loading, so nothing rings for a moment. */
  enter(screen: string, now: number) {
    this.seen.delete(screen);
    this.quietUntil = now + 4000;
  }
  /** Returns true when an order not seen before on this screen appeared. */
  update(screen: string, ids: string[], now: number) {
    const known = now < this.quietUntil ? undefined : this.seen.get(screen);
    let fresh = false;
    if (known)
      for (const id of ids)
        if (!known.has(id)) {
          this.since.set(screen + ':' + id, now);
          fresh = true;
        }
    this.seen.set(screen, new Set(ids));
    return fresh;
  }
  isNew(screen: string, id: string, now: number) {
    const at = this.since.get(screen + ':' + id);
    return at !== undefined && now - at < NEW_TICKET_MS;
  }
}
let audio: AudioContext | null = null;
export function chime() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const start = audio.currentTime + 0.02;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = audio.createOscillator(),
        gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = start + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.5, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0);
      osc.stop(t0 + 0.34);
    }
  } catch {
    /* No audio device: the highlight still shows the new order. */
  }
}
/** A browser keeps audio locked until the first touch; unlock it then (desktop app is free). */
export function unlockAudioOnTouch(target: EventTarget) {
  const unlock = () => {
    try {
      audio ??= new AudioContext();
      void audio.resume();
    } catch {
      /* ignore */
    }
  };
  target.addEventListener('pointerdown', unlock, { once: true });
}

/** Contents of one task for the cook, multiplied by its quantity; [] when unknown. */
export function composition(t: Task): { name: string; count: number }[] {
  const parts = COMPOSITION[t.details.productId]?.[1] ?? BY_NAME.get(norm(t.details.title)) ?? [];
  return parts.map(([name, count]) => ({ name, count: count * t.details.quantity }));
}
const amount = (n: number) => (Number.isInteger(n) ? String(n) : String(n).replace('.', ','));
const compositionList = (t: Task) => {
  const list = composition(t);
  return list.length
    ? `<ul class="composition">${list.map((p) => `<li><strong>${amount(p.count)}</strong> ${escape(p.name)}</li>`).join('')}</ul>`
    : '';
};

/** Running stopwatch since the order came in: 0:07, 4:35, 12:03, 1:02:09. */
export function stopwatch(createdAt: string | undefined, now: number) {
  const start = Date.parse(createdAt ?? '');
  if (!Number.isFinite(start)) return '-';
  const total = Math.max(0, Math.floor((now - start) / 1000));
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
/** Timer markup; app.ts ticks every [data-since] once a second without a full re-render. */
export function timer(createdAt: string, now: number, colour = true) {
  return `<strong class="timer" data-since="${escape(createdAt)}"${colour ? '' : ' data-still=""'}>${stopwatch(createdAt, now)}</strong>`;
}
/** Once a second: new text and wait colour for every visible timer. */
export function tickTimers(root: ParentNode, now: number) {
  root.querySelectorAll<HTMLElement>('.timer[data-since]').forEach((el) => {
    const since = el.dataset.since!;
    const text = stopwatch(since, now);
    if (el.textContent !== text) el.textContent = text;
    if (el.dataset.still !== undefined) return;
    const head = el.closest('.ticket-head');
    if (!head) return;
    const wait = waitClass(since, now);
    head.classList.toggle('wait-warn', wait === 'wait-warn');
    head.classList.toggle('wait-late', wait === 'wait-late');
  });
}
const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Almaty',
      });
};
const qty = (n: number) => `<span class="quantity${n > 1 ? ' many' : ''}">${n}×</span>`;
/**
 * Changes to a dish (e.g. «Без лука», «Острый»): big capital chips, red for a removal, orange for
 * the rest, the way fast-food screens shout exceptions so a cook never makes the standard dish.
 */
const cookChanges = (list: Modifier[]) =>
  list.length
    ? `<p class="changes">${list
        .map(
          (m) =>
            `<span class="change${/^(без|не |no )/i.test(m.label.ru.trim()) ? ' change-minus' : ''}">${escape(m.label.ru)}${m.quantity > 1 ? ' ×' + m.quantity : ''}</span>`,
        )
        .join('')}</p>`
    : '';
const mods = (list: Modifier[]) =>
  list.length
    ? `<p class="modifiers">${list.map((m) => escape(m.label.ru) + (m.quantity > 1 ? ' ×' + m.quantity : '')).join(' · ')}</p>`
    : '';

export type TicketInput = {
  order: Order;
  stationId: string;
  stations: Station[];
  actions: Action[];
  blocked: boolean;
  now: number;
  /** wholeTicketActions: one button per station instead of per task. */
  wholeTicket: boolean;
  actionLabel: Record<Action['action'], string>;
  stateLabel: (state: string) => string;
  /** Pre-rendered pieces that need app state: cloud source badge, restore review block. */
  badge?: string;
  review?: string;
  /** A delivery order of the cashier is handed over with the courier marks. */
  courierHandover?: boolean;
  offline?: boolean;
  owner?: string;
  /** Arrived on this screen a moment ago: highlighted. */
  isNew?: boolean;
};

function button(text: string, attrs: string, disabled: boolean) {
  return `<button ${attrs}${disabled ? ' disabled' : ''}>${text}</button>`;
}
const commandAttrs = (id: string, o: Order, a: Action) =>
  `id="${id}" data-command="${escape(JSON.stringify({ orderId: o.orderId, body: a }))}"`;

/** One ticket of the classic kitchen screen (layout off): «Приготовление» or «Сборка». */
export function kitchenTicket(input: TicketInput) {
  const o = input.order;
  const assembly = input.stationId === o.assemblyStationId;
  const ready = o.state === 'ready';
  const taskAction = (t: Task) => input.actions.find((a) => 'taskId' in a && a.taskId === t.taskId);
  const taskButton = (t: Task) => {
    const a = taskAction(t);
    return a
      ? button(input.actionLabel[a.action], commandAttrs('task-' + t.taskId, o, a), input.blocked)
      : '';
  };
  const parent = (t: Task) =>
    t.details.parentTitle && t.details.parentTitle !== t.details.title
      ? `<p class="parent">${escape(t.details.parentTitle)}</p>`
      : '';

  let body: string;
  if (!assembly) {
    // Cook: only this station's dishes, cooking changes only. No drinks, sauces, descriptions.
    const own = o.tasks.filter((t) => t.stationId === input.stationId);
    body = `<div class="lines cook-lines">${own
      .map(
        (t) =>
          `<section class="line cook-line${t.state === 'done' ? ' line-done' : ''}">${qty(t.details.quantity)}<div class="line-info"><h3>${escape(t.details.title)}</h3>${parent(t)}${compositionList(t)}${cookChanges(cookModifiers(t))}${t.state === 'done' ? '<p class="line-check">✓ Готово</p>' : ''}${taskButton(t)}</div></section>`,
      )
      .join('')}</div>`;
  } else {
    // Assembly: everything. Kitchen dishes with their readiness, then what to add here.
    const kitchen = o.tasks.filter((t) => t.stationId !== input.stationId);
    const here = o.tasks.filter((t) => t.stationId === input.stationId);
    const kitchenDone = kitchen.every((t) => t.state === 'done');
    const dishes = kitchen
      .map(
        (t) =>
          `<section class="line pack-line">${qty(t.details.quantity)}<div class="line-info"><h3>${escape(t.details.title)}</h3>${parent(t)}${cookChanges(cookModifiers(t))}</div><span class="line-state${t.state === 'done' ? ' done' : ''}">${t.state === 'done' ? '✓' : escape(input.stateLabel(t.state))}</span></section>`,
      )
      .join('');
    // Drinks and sauces chosen inside combos: one checklist line each, total quantity.
    const extras = o.tasks.flatMap((t) =>
      t.details.modifiers
        .filter((m) => modifierKind(m) !== 'cook')
        .map((m) => ({
          kind: modifierKind(m),
          title: m.label.ru,
          quantity: m.quantity * t.details.quantity,
          of: t.details.title,
        })),
    );
    const addLines = [
      ...here.map(
        (t) =>
          `<section class="line add-line">${qty(t.details.quantity)}<div class="line-info"><h3>${escape(t.details.title)}</h3>${mods(t.details.modifiers)}${taskButton(t)}</div></section>`,
      ),
      ...extras
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'drink' ? -1 : 1))
        .map(
          (x) =>
            `<section class="line add-line add-${x.kind}">${qty(x.quantity)}<div class="line-info"><h3>${escape(x.title)}</h3><p class="parent">${x.kind === 'drink' ? 'Напиток' : 'Соус'} · к ${escape(x.of)}</p></div></section>`,
        ),
    ].join('');
    body = `${
      dishes
        ? `<div class="pack-block"><h4>С кухни${kitchenDone ? ' <span class="done">✓ всё готово</span>' : ''}</h4><div class="lines">${dishes}</div></div>`
        : ''
    }${addLines ? `<div class="pack-block pack-add"><h4>Добавить на сборке: напитки, соусы</h4><div class="lines">${addLines}</div></div>` : ''}`;
  }

  const buttons = input.actions
    .filter((a) => !('taskId' in a))
    .map((a) =>
      a.action === 'handoff' && input.courierHandover
        ? button(
            'Передать курьеру',
            `id="handover-${o.orderId}" data-handover="${o.orderId}"`,
            input.blocked,
          )
        : button(
            a.action === 'complete_station' && assembly
              ? 'Заказ собран'
              : input.actionLabel[a.action],
            commandAttrs('order-' + o.orderId, o, a),
            input.blocked,
          ),
    )
    .join('');
  const note =
    o.state === 'cancel_requested'
      ? '<p>Сначала подтвердите остановку своих позиций. Итоговую отмену и остатки сверяет управляющий.</p>'
      : !input.actions.length && !o.restoreReview
        ? `<p>${assembly ? 'Ждём кухню' : 'Ожидание следующей станции'}</p>`
        : '';
  const wait = ready ? '' : waitClass(o.createdAt, input.now);
  return `<article class="ticket kitchen-ticket ${assembly ? 'ticket-assembly' : 'ticket-cook'}${o.state === 'cancel_requested' ? ' cancel' : ''}${ready ? ' is-ready' : ''}${input.isNew ? ' is-new' : ''}${input.offline ? ' owner-offline' : ''}" data-order="${o.orderId}"${input.owner ? ` data-owner="${input.owner}"` : ''}><div class="ticket-head${wait ? ' ' + wait : ''}"><strong class="number">${escape(o.displayNumber ?? '-')}</strong><div class="ticket-origin">${modeChip(o)}${sourceLabel(o)}${input.badge ?? ''}</div><div class="age">${timer(o.createdAt, input.now, !ready)}<small>${ready ? 'Готов к выдаче' : o.state === 'cancel_requested' ? escape(input.stateLabel(o.state)) : 'принят ' + clock(o.createdAt)}</small></div></div>${input.review ?? ''}${o.kitchenComment ? `<aside class="order-note"><strong>Комментарий</strong><p>${escape(o.kitchenComment)}</p></aside>` : ''}${body}<div class="ticket-actions">${buttons}${note}</div></article>`;
}
