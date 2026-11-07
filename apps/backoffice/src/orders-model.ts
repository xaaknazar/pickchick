/*
 * The order registry on the server (audit F10 remainder; lane bo-ui, capabilities.pos_day):
 * GET .../ops/orders searches, sorts and pages every order of the period and totals the whole
 * selection, also by cash desk. Pure helpers of the cabinet; every text is Russian, money in
 * tenge from integer tiyn.
 */
import { tenge } from './ui-fixes.js';

type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
const list = (value: unknown): Data[] => (Array.isArray(value) ? value.map(object) : []);

export type OrdersSort = 'new' | 'old' | 'number' | 'amount';
export type OrdersParams = {
  start_date: string;
  end_date: string;
  q: string;
  channel: string;
  terminal_id: string;
  sort: OrdersSort;
  page: number;
};
const almatyDay = (at: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date(at));
/** The Almaty days of a GET branches/:id period ([period_start, period_end)). */
export function periodDays(periodStart: string, periodEnd: string) {
  return {
    start_date: almatyDay(Date.parse(periodStart)),
    end_date: almatyDay(Date.parse(periodEnd) - 1),
  };
}
/** The query of GET .../ops/orders: empty filters and the defaults are left out. */
export function ordersSearch(p: OrdersParams): string {
  const q = new URLSearchParams({ start_date: p.start_date, end_date: p.end_date });
  const text = p.q.trim();
  if (text) q.set('q', text);
  if (p.channel) q.set('channel', p.channel);
  if (p.terminal_id) q.set('terminal_id', p.terminal_id);
  if (p.sort !== 'new') q.set('sort', p.sort);
  if (p.page > 1) q.set('page', String(p.page));
  return q.toString();
}
/** What the search field may send: a number («№117») or a piece of the order id. */
export const searchAllowed = (value: string) => /^[0-9a-fA-F№ -]{0,40}$/.test(value.trim());

export type OrdersView = {
  rows: Data[];
  page: number;
  pages: number;
  page_size: number;
  totals: {
    orders: number;
    live_orders: number;
    live_total_minor: string;
    by_terminal: { terminal_id: string | null; live_orders: number; live_total_minor: string }[];
  };
  terminals: { terminal_id: string; label: string }[];
};
/** GET .../ops/orders of this branch, checked before the screen trusts it. */
export function ordersView(value: unknown, branch: string): OrdersView {
  const o = object(value);
  const t = object(o['totals']);
  if (o['schema_version'] !== 1 || o['branch_id'] !== branch || !Array.isArray(o['rows']))
    throw new Error('INVALID_RESPONSE');
  return {
    rows: list(o['rows']),
    page: Number(o['page'] ?? 1),
    pages: Number(o['pages'] ?? 1),
    page_size: Number(o['page_size'] ?? 100),
    totals: {
      orders: Number(t['orders'] ?? 0),
      live_orders: Number(t['live_orders'] ?? 0),
      live_total_minor: String(t['live_total_minor'] ?? '0'),
      by_terminal: list(t['by_terminal']).map((d) => ({
        terminal_id: typeof d['terminal_id'] === 'string' ? d['terminal_id'] : null,
        live_orders: Number(d['live_orders'] ?? 0),
        live_total_minor: String(d['live_total_minor'] ?? '0'),
      })),
    },
    terminals: list(o['terminals']).map((d) => ({
      terminal_id: String(d['terminal_id']),
      label: String(d['label']),
    })),
  };
}
/** «Касса 1» by the server's cash desk list; an unknown one by its id. */
export function deskLabel(view: OrdersView, id: string | null) {
  if (!id) return 'Касса не известна';
  return view.terminals.find((t) => t.terminal_id === id)?.label ?? `Касса ${id.slice(0, 4)}`;
}
/**
 * «Итого за период: заказов 217, без отменённых 210 на 1 234 500 ₸. Касса 1: 120, 600 000 ₸ ·
 * Касса 2: 90, 534 500 ₸.» Over every order of the selection, not only the page shown.
 */
export function ordersTotalsText(view: OrdersView): string {
  const t = view.totals;
  // In the order of the cash desk names («Касса 1», «Касса 2»), an unknown desk last.
  const rank = (id: string | null) => {
    const i = view.terminals.findIndex((x) => x.terminal_id === id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const desks = [...t.by_terminal]
    .sort((a, b) => rank(a.terminal_id) - rank(b.terminal_id))
    .filter((d) => d.live_orders > 0)
    .map(
      (d) => `${deskLabel(view, d.terminal_id)}: ${d.live_orders}, ${tenge(d.live_total_minor)}`,
    );
  return (
    `Итого за период: заказов ${t.orders}, без отменённых ${t.live_orders} на ${tenge(t.live_total_minor)}` +
    (desks.length ? `. ${desks.join(' · ')}.` : '.')
  );
}
/** «Страница 2 из 3: заказы 101-200 из 217». */
export function pagerText(view: OrdersView): string {
  if (!view.totals.orders) return 'Заказов нет.';
  const first = (view.page - 1) * view.page_size + 1;
  const last = Math.min(view.page * view.page_size, view.totals.orders);
  return `Страница ${view.page} из ${view.pages}: заказы ${first}-${last} из ${view.totals.orders}`;
}
