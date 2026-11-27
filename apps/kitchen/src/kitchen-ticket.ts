/**
 * Kitchen and assembly tickets (22.11 redesign, restaurant TZ 27.11 «Отображение заказов»):
 * both screens keep number, order type, source, timer and status, and show each ordered item by
 * name and quantity only - no marketing descriptions, no combo contents. The kitchen shows nothing
 * else; assembly lists the chosen modifiers (drinks, sauces) one per line under the item, without
 * the group titles («Напиток на выбор», «Соус на выбор»).
 * Earlier notes (22.11): Industry practice (Toast, Square KDS, Fresh KDS,
 * fast-food lines): a prep screen shows only what that station cooks - order number, dish names,
 * quantities and cooking changes, with a running stopwatch. Drinks and sauces never reach the
 * cook; the assembly (expo) screen shows the whole order, drinks and sauces included, as a
 * checklist. Marketing descriptions of the menu are never shown on a kitchen ticket.
 * Pure HTML builders: every value is escaped; buttons keep the data-command contract of app.ts.
 */
import type { Action, Order, Station, Task } from './types.js';
import { channelName, modeChip, waitClass } from './kds-view.js';

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
 * Short kitchen names of single items, used only to name a part on its button when a combo is
 * expanded into one task per component (back office «Компоненты»). Combo contents themselves are
 * no longer shown (TZ 27.11: «расшифровку состава комбо убрать на обоих экранах»).
 */
type Part = readonly [name: string, count: number];
const SINGLES: Readonly<Record<string, readonly [string, Part]>> = {
  fingers: ['Фингерс 1 шт', ['Фингерсы', 1]],
  wedges: ['Картофельные дольки', ['Фри', 1]],
  coleslaw: ['Коул слоу', ['Коулслоу', 1]],
  toast: ['Тост 1 шт', ['Тост', 1]],
  burger: ['Pick Burger', ['Pick Burger', 1]],
  'chick-n-roll': ['Chick N Roll', ['Ролл', 1]],
  'chick-burger': ['Chick Burger', ['Chick Burger', 1]],
};
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const SINGLE_BY_NAME = new Map(Object.values(SINGLES).map(([name, part]) => [norm(name), part]));
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
    for (const g of groupTasks(o.tasks.filter((t) => t.stationId === stationId)))
      if (
        g.kind === 'combo' &&
        !g.base &&
        g.parts.some((t) => t.state === 'queued' || t.state === 'in_progress')
      )
        add(g.title, g.quantity);
    for (const t of o.tasks) {
      if (t.stationId !== stationId || (t.state !== 'queued' && t.state !== 'in_progress'))
        continue;
      // TZ 27.11: combo contents are not decoded; each item counts under its own name. An
      // expanded combo (one task per component) counts once, under the combo.
      if (isComponent(t)) continue;
      add(t.details.title, t.details.quantity);
    }
  }
  return [...totals]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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

/** Three short low beeps: an order is late (different from the new-order chime). */
export function alarm() {
  tones([660, 660, 660], 0.22, 'square', 0.25);
}
/** A rising chime for the guest board: a number is ready. */
export function readyChime() {
  tones([660, 880, 1100], 0.16, 'sine', 0.5);
}
function tones(freqs: number[], step: number, type: OscillatorType, peak: number) {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const start = audio.currentTime + 0.02;
    freqs.forEach((freq, i) => {
      const osc = audio!.createOscillator(),
        gain = audio!.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const t0 = start + i * step;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + step * 0.9);
      osc.connect(gain).connect(audio!.destination);
      osc.start(t0);
      osc.stop(t0 + step);
    });
  } catch {
    /* No audio device: the blinking ticket still shows it. */
  }
}
/**
 * Late orders (owner 27.11): one alarm when an order on this screen passes the red limit, and a
 * reminder every LATE_REPEAT_MS while any order stays late. Opening a screen never rings.
 */
export const LATE_REPEAT_MS = 3 * 60 * 1000;
export class LateAlarm {
  private rung = new Map<string, Set<string>>();
  private last = 0;
  update(screen: string, late: string[], now: number) {
    const known = this.rung.get(screen);
    this.rung.set(screen, new Set(late));
    if (!known) {
      this.last = now;
      return false;
    }
    const fresh = late.some((id) => !known.has(id));
    if (fresh || (late.length > 0 && now - this.last >= LATE_REPEAT_MS)) {
      this.last = now;
      return true;
    }
    return false;
  }
  enter(screen: string) {
    this.rung.delete(screen);
  }
}
/** Guest board: numbers that turned ready a moment ago are highlighted; true when one did. */
export const JUST_READY_MS = 30000;
export class ReadyNumbers {
  private known: Set<string> | null = null;
  private since = new Map<string, number>();
  update(ready: string[], now: number) {
    const before = this.known;
    this.known = new Set(ready);
    let fresh = false;
    if (before)
      for (const n of ready)
        if (!before.has(n)) {
          this.since.set(n, now);
          fresh = true;
        }
    for (const [n, at] of this.since) if (now - at >= JUST_READY_MS) this.since.delete(n);
    return fresh;
  }
  isFresh(number: string, now: number) {
    const at = this.since.get(number);
    return at !== undefined && now - at < JUST_READY_MS;
  }
}

const amount = (n: number) => (Number.isInteger(n) ? String(n) : String(n).replace('.', ','));
type Piece = { name: string; count: number };
/**
 * A component of an expanded combo (the back office «Компоненты» filled): the edge makes one task
 * per component with the combo as parentTitle and the same lineId. Its short kitchen name and
 * count come from the singles table («Фингерс 1 шт» ×4 → 4 Фингерсы), else its own title.
 */
export const isComponent = (t: Task) =>
  t.details.parentTitle !== '' && t.details.parentTitle !== t.details.title;
export function piece(t: Task): Piece {
  const single = SINGLES[t.details.productId]?.[1] ?? SINGLE_BY_NAME.get(norm(t.details.title));
  return {
    name: single ? single[0] : t.details.title,
    count: (single ? single[1] : 1) * t.details.quantity,
  };
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
/** Quantity of the combo line; older edges do not send it, then the common factor of its parts. */
export const lineQuantity = (parts: Task[]) =>
  (parts[0]?.details.lineQuantity ?? parts.reduce((g, t) => gcd(g, t.details.quantity), 0)) || 1;
export type Group =
  | { kind: 'task'; task: Task }
  | {
      kind: 'combo';
      lineId: string;
      title: string;
      quantity: number;
      parts: Task[];
      /** A dish with linked additions: the dish itself; its parts are the additions. */
      base?: Task;
    };
export function groupTasks(tasks: Task[]): Group[] {
  const result: Group[] = [];
  const combos = new Map<string, Extract<Group, { kind: 'combo' }>>();
  const bases = new Map(tasks.filter((t) => !isComponent(t)).map((t) => [t.details.lineId, t]));
  const withParts = new Set(tasks.filter(isComponent).map((t) => t.details.lineId));
  const group = (t: Task) => {
    let g = combos.get(t.details.lineId);
    if (!g) {
      const base = bases.get(t.details.lineId);
      g = {
        kind: 'combo',
        lineId: t.details.lineId,
        title: t.details.parentTitle || t.details.title,
        quantity: 1,
        parts: [],
        ...(base ? { base } : {}),
      };
      combos.set(t.details.lineId, g);
      result.push(g);
    }
    return g;
  };
  for (const t of tasks) {
    if (!isComponent(t)) {
      if (withParts.has(t.details.lineId)) group(t);
      else result.push({ kind: 'task', task: t });
    } else group(t).parts.push(t);
  }
  for (const g of combos.values())
    g.quantity = g.base ? g.base.details.quantity : lineQuantity(g.parts);
  return result;
}

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
    head.classList.toggle('wait-ok', wait === 'wait-ok');
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
 * «Киоск · В очереди»: source and order status under the type chip (TZ 27.11 п.1). The source is
 * a coloured pill (owner 27.11): Касса, Киоск and Приложение read apart at a glance.
 */
function origin(o: Order, stateLabel: (state: string) => string) {
  const known = !o.delivery && !!o.channel && Object.hasOwn(channelName, o.channel);
  const source = known
    ? `<span class="source source-${escape(o.channel)}">${escape(channelName[o.channel])}</span>`
    : '';
  const status = escape(stateLabel(o.state));
  return `<p class="channel"${known ? ` data-source="${escape(o.channel)}"` : ''}>${source}<span class="order-status">${status}</span></p>`;
}
/**
 * Changes the cook must not miss (owner 27.11, over TZ 27.11 п.2): «Без лука», «Острый» and the
 * like, one red line under the dish. Drinks and sauces stay on the assembly screen.
 */
function cookNote(list: Modifier[]) {
  return list.length
    ? `<p class="cook-note">${list
        .map((m) => escape(m.label.ru) + (m.quantity > 1 ? ' ×' + m.quantity : ''))
        .join(' · ')}</p>`
    : '';
}
/** An order comment that speaks of an allergy is shown in red on every screen. */
export const ALLERGY = /аллерг|allerg|аллергия|непереносим/i;
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
  const groupTasksOf = (g: Group) =>
    g.kind === 'task' ? [g.task] : g.base ? [g.base, ...g.parts] : g.parts;
  const groupQty = (g: Group) => (g.kind === 'task' ? g.task.details.quantity : g.quantity);
  /** TZ 27.11: the item by name only; an expanded combo stays one line under the combo name. */
  const title = (g: Group) => (g.kind === 'task' ? g.task.details.title : g.title);
  const allDone = (list: Task[]) => list.every((t) => t.state === 'done');
  const doneMark = (done: boolean) => (done ? '<p class="line-check">✓ Готово</p>' : '');
  /** Task buttons; several tasks of one line (expanded combo) name their part on the button. */
  const lineButtons = (list: Task[]) =>
    list
      .map((t) => {
        const a = taskAction(t);
        if (!a) return '';
        const label =
          list.length > 1 && isComponent(t)
            ? `${input.actionLabel[a.action]} · ${escape(piece(t).name)}`
            : input.actionLabel[a.action];
        return button(label, commandAttrs('task-' + t.taskId, o, a), input.blocked);
      })
      .join('');
  /** Assembly: every chosen modifier on its own line under the item, no group title. */
  const modifierLines = (g: Group) => {
    const first = g.kind === 'task' ? g.task : (g.base ?? g.parts[0]!);
    const list = first.details.modifiers;
    return list.length
      ? `<ul class="line-mods">${list
          .map(
            (m) =>
              `<li class="mod-${modifierKind(m)}">– ${escape(m.label.ru)}${m.quantity > 1 ? ' ×' + m.quantity : ''}</li>`,
          )
          .join('')}</ul>`
      : '';
  };

  let body: string;
  if (!assembly) {
    // Kitchen (TZ 27.11 п.2): only the dish name and quantity. No drinks, sauces or modifiers.
    const own = groupTasks(o.tasks.filter((t) => t.stationId === input.stationId));
    body = `<div class="lines cook-lines">${own
      .map((g) => {
        const list = groupTasksOf(g);
        const done = allDone(list);
        const first = g.kind === 'task' ? g.task : (g.base ?? g.parts[0]!);
        return `<section class="line cook-line${done ? ' line-done' : ''}">${qty(groupQty(g))}<div class="line-info"><h3>${escape(title(g))}</h3>${cookNote(cookModifiers(first))}${doneMark(done)}${lineButtons(list)}</div></section>`;
      })
      .join('')}</div>`;
  } else {
    // Assembly (TZ 27.11 п.3): every item of the order with its chosen modifiers under it, in
    // the order of the order. Kitchen items show their readiness; items made here their button.
    body = `<div class="lines pack-lines">${groupTasks(o.tasks)
      .map((g) => {
        const list = groupTasksOf(g);
        const done = allDone(list);
        const fromKitchen = list.some((t) => t.stationId !== input.stationId);
        const state = !fromKitchen
          ? ''
          : `<span class="line-state${done ? ' done' : ''}">${
              done ? '✓' : escape(input.stateLabel(list.find((t) => t.state !== 'done')!.state))
            }</span>`;
        const here = list.filter((t) => t.stationId === input.stationId);
        return `<section class="line pack-line">${qty(groupQty(g))}<div class="line-info"><h3>${escape(title(g))}</h3>${modifierLines(g)}${lineButtons(here)}</div>${state}</section>`;
      })
      .join('')}</div>`;
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
  return `<article class="ticket kitchen-ticket ${assembly ? 'ticket-assembly' : 'ticket-cook'}${o.state === 'cancel_requested' ? ' cancel' : ''}${ready ? ' is-ready' : ''}${input.isNew ? ' is-new' : ''}${input.offline ? ' owner-offline' : ''}" data-order="${o.orderId}"${input.owner ? ` data-owner="${input.owner}"` : ''}><div class="ticket-head${wait ? ' ' + wait : ''}"><strong class="number">${escape(o.displayNumber ?? '-')}</strong><div class="ticket-origin">${modeChip(o)}${origin(o, input.stateLabel)}${input.badge ?? ''}</div><div class="age">${timer(o.createdAt, input.now, !ready)}<small>принят ${clock(o.createdAt)}</small></div></div>${input.review ?? ''}${o.kitchenComment ? `<aside class="order-note${ALLERGY.test(o.kitchenComment) ? ' allergy' : ''}"><strong>${ALLERGY.test(o.kitchenComment) ? 'Аллергия' : 'Комментарий'}</strong><p>${escape(o.kitchenComment)}</p></aside>` : ''}${body}<div class="ticket-actions">${buttons}${note}</div></article>`;
}
