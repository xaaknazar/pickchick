import { element as el, button, field, select } from './dom.js';
import { ApiError } from './api.js';
import {
  CONFIRMATION_LABELS,
  FISCAL_KIND_LABELS,
  FISCAL_STATE_LABELS,
  POS_DAY_CHANNELS,
  POS_DAY_METHODS,
  POS_DAY_RULES,
  RECEIPT_STATE_FILTERS,
  REVENUE_KIND_LABELS,
  SHIFT_STATE_LABELS,
  almatyClock,
  channelLabel,
  filterReceipts,
  label,
  methodLabel,
  methodLines,
  shiftKeyLine,
  receiptName,
  receiptsCsv,
  refundKindLabel,
  refundReasonLabel,
  saleStateText,
  staffLabel,
  terminalLabel,
  waitingText,
  webkassaCsv,
  webkassaRows,
  webkassaText,
  zCsv,
  type Data,
  type PosDay,
  type ReceiptFilters,
} from './pos-day-model.js';
import {
  SALES_CHANNEL_LABELS,
  almatyTime,
  dayLabel,
  money,
  salesCsvText,
  type SalesReport,
} from './sales-report-model.js';

/** Calendar day in Asia/Almaty, `days` before now. */
export const almatyDay = (days = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(
    new Date(Date.now() - days * 86400000),
  );
type Loader = (date: string, terminal: string) => Promise<PosDay>;
type Cell = string | Node;

/** A table that becomes labelled cards on a phone (no amount or button off the screen). */
function table(headers: string[], rows: Cell[][], empty: string, testId = '') {
  const wrap = el('div', 'table-wrap pos-table'),
    t = el('table', 'op-table'),
    head = el('thead'),
    tr = el('tr');
  if (testId) wrap.dataset.testid = testId;
  for (const h of headers) tr.append(el('th', '', h));
  head.append(tr);
  const body = el('tbody');
  for (const row of rows) {
    const r = el('tr');
    row.forEach((c, i) => {
      const td = el('td');
      td.dataset.label = headers[i] ?? '';
      // Amounts and times never break inside («1 500 ₸», «19.11.2026 09:30»).
      if (typeof c === 'string' && /(₸|^\d{2}:\d{2}|^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2})$/.test(c))
        td.className = 'pos-nowrap';
      td.append(typeof c === 'string' ? document.createTextNode(c) : c);
      r.append(td);
    });
    body.append(r);
  }
  if (!rows.length) {
    const r = el('tr', 'pos-empty-row'),
      td = el('td', 'op-empty', empty);
    td.colSpan = headers.length;
    r.append(td);
    body.append(r);
  }
  t.append(head, body);
  wrap.append(t);
  return wrap;
}
/**
 * A text with amounts («Продажи 21 000 ₸ - отмены 2 000 ₸»): each amount stays on one line, so
 * a phone never leaves a lone «₸» on the next line (step 8 pass). The text itself is unchanged.
 */
function amountsTogether(host: HTMLElement, text: string) {
  let last = 0;
  for (const m of text.matchAll(/-?\d[\d ]*(?:,\d+)? ₸/g)) {
    host.append(text.slice(last, m.index), el('span', 'pos-amount', m[0]));
    last = m.index + m[0].length;
  }
  host.append(text.slice(last));
  return host;
}
function stats(items: [string, string, string?][], testId = '') {
  const n = el('div', 'stats pos-stats');
  if (testId) n.dataset.testid = testId;
  for (const [name, value, detail] of items) {
    const c = el('div', 'stat');
    c.append(el('span', 'muted', name), el('strong', '', value));
    if (detail) c.append(amountsTogether(el('small', 'muted'), detail));
    n.append(c);
  }
  return n;
}
function notice(text: string, tone: 'info' | 'warn' = 'info', testId = '') {
  const n = el('p', 'notice compact pos-notice' + (tone === 'warn' ? ' pos-warn' : ''), text);
  n.setAttribute('role', tone === 'warn' ? 'alert' : 'status');
  if (testId) n.dataset.testid = testId;
  return n;
}
/** A state written in words, with a tone class only as a second signal. */
function badge(text: string, tone: '' | 'good' | 'bad' = '') {
  return el('span', 'op-badge' + (tone ? ' ' + tone : ''), text);
}
function download(name: string, rows: string[][]) {
  const url = URL.createObjectURL(
    new Blob([salesCsvText(rows)], { type: 'text/csv;charset=utf-8' }),
  );
  const a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function dialog(title: string, sub: string) {
  const d = el('dialog', 'op-dialog pos-dialog'),
    head = el('div', 'panel-head'),
    close = button(
      'Закрыть',
      () => {
        d.close();
        d.remove();
      },
      'button subtle',
      'pos-dialog-close',
    );
  head.append(el('h2', '', title), close);
  d.append(head, el('p', 'op-note', sub));
  document.body.append(d);
  d.showModal();
  d.addEventListener('close', () => d.remove(), { once: true });
  return d;
}
const minor = (v: unknown) => BigInt(String(v ?? '0'));
const when = (day: PosDay, v: unknown) =>
  typeof v !== 'string' || !v
    ? '-'
    : almatyTime(v).slice(0, 10) === dayLabel(day.date)
      ? almatyClock(v)
      : almatyTime(v);
/** «Данные кассы получены в 23:41» (with the date when it is not the viewed day). */
export function freshnessText(day: PosDay) {
  if (!day.coverage.pos_tables)
    return 'Облако ещё не получает продажи кассы. Смены видны по отчётам кассы, чеков и сумм пока нет.';
  const at = day.coverage.last_received_at;
  if (!at) return 'Данные кассы в облако ещё не поступали.';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(
    new Date(day.as_of),
  );
  const atDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date(at));
  return atDay === today
    ? `Данные кассы получены в ${almatyClock(at)}`
    : `Данные кассы получены ${almatyTime(at)}`;
}

/**
 * Everything the cloud knows of one cashier receipt: totals, items with options, tenders with
 * change, voids and refunds with who made and who approved them, Webkassa receipts. Also used
 * by the order card of a POS order (`pos_sale`).
 */
export function receiptDetails(
  r: Pick<PosDay, 'terminals' | 'staff'> & { date?: string },
  s: Data,
): Node[] {
  const out: Node[] = [];
  const tiles: [string, string, string?][] = [
    [
      'Сумма',
      money(s['total_minor']),
      ...(s['discount_minor'] !== '0' ? [`Скидка ${money(s['discount_minor'])}`] : []),
    ] as [string, string, string?],
    [
      'Состояние',
      saleStateText(s),
      ...(s['voided_at'] ? [`Отменён ${almatyTime(s['voided_at'])}`] : []),
    ] as [string, string, string?],
    [
      'Касса',
      terminalLabel(r, s['terminal_id']),
      `Кассир: ${staffLabel(r, s['cashier_staff_id'])}`,
    ],
    ['Webkassa', webkassaText(s)],
  ];
  out.push(stats(tiles, 'pos-receipt-tiles'));
  const facts: string[] = [];
  if (s['external_order_ref'])
    facts.push(
      `${(s['tenders'] as Data[]).some((t) => t['method'] === 'chocofood') ? 'Номер заказа ChocoFood' : 'Номер заказа агрегатора'}: ${String(s['external_order_ref'])}`,
    );
  if (s['revenue_kind'] !== 'revenue')
    facts.push(
      `${label(REVENUE_KIND_LABELS, s['revenue_kind'])}: ${String(s['beneficiary'] ?? s['reason'] ?? '-')}` +
        (s['approval_manager_staff_id']
          ? `, разрешил ${staffLabel(r, s['approval_manager_staff_id'])}`
          : ''),
    );
  if (s['of_day'] === false)
    facts.push(`Чек дня ${dayLabel(s['business_date'])}, возврат по нему - в выбранном дне.`);
  for (const f of facts) out.push(el('p', 'op-note', f));
  out.push(
    el('h3', '', 'Позиции'),
    table(
      ['Позиция', 'Кол-во', 'Цена', 'Сумма'],
      (s['lines'] as Data[]).map((l) => {
        const name = el('div');
        name.append(el('strong', '', String(l['name'] || '-')));
        for (const m of (l['modifiers'] as Data[] | undefined) ?? [])
          name.append(
            el(
              'small',
              'muted',
              `${String(m['group'] || 'Опция')}: ${String(m['name'])}${Number(m['quantity']) > 1 ? ' x' + String(m['quantity']) : ''}${minor(m['price_minor']) > 0n ? ' +' + money(m['price_minor']) : ''}`,
            ),
          );
        return [name, String(l['quantity']), money(l['unit_price_minor']), money(l['total_minor'])];
      }),
      'Позиций нет',
      'pos-receipt-lines',
    ),
    el('h3', '', 'Оплата'),
    table(
      ['Способ', 'Сумма', 'Подтверждение', 'Ссылка'],
      (s['tenders'] as Data[]).map((t) => [
        methodLabel(t['method']),
        money(t['amount_minor']),
        label(CONFIRMATION_LABELS, t['confirmation']),
        String(t['reference'] ?? '-'),
      ]),
      'Оплат нет',
      'pos-receipt-tenders',
    ),
  );
  if (s['cash_tendered_minor'] !== null)
    out.push(
      el(
        'p',
        'op-note',
        `Внесено наличными ${money(s['cash_tendered_minor'])}, сдача ${money(s['change_minor'])}.`,
      ),
    );
  out.push(
    el('h3', '', 'Отмены и возвраты'),
    table(
      ['Вид и время', 'Сумма', 'По оплатам', 'Причина', 'Кто'],
      (s['refunds'] as Data[]).map((x) => {
        const kind = el('div', 'pos-receipt-name');
        kind.append(
          el('strong', '', refundKindLabel(x['kind'])),
          el('small', 'muted', almatyTime(x['created_at'])),
        );
        const who = el('div', 'pos-receipt-name');
        who.append(
          el('span', '', `Оформил: ${staffLabel(r, x['staff_id'])}`),
          el('span', '', `Подтвердил: ${staffLabel(r, x['approved_by_staff_id'])}`),
        );
        return [
          kind,
          money(x['amount_minor']),
          ((x['tenders'] as Data[]) ?? [])
            .map((p) => `${methodLabel(p['method'])} ${money(p['amount_minor'])}`)
            .join(', '),
          `${refundReasonLabel(x['reason_code'])}: ${String(x['reason'] ?? '')}`,
          who,
        ];
      }),
      'Отмен и возвратов нет',
      'pos-receipt-refunds',
    ),
    el('h3', '', 'Чеки Webkassa'),
    table(
      ['Вид', 'Номер', 'Состояние', 'Сумма', 'Внёс', 'Когда'],
      (s['fiscal'] as Data[]).map((f) => [
        label(FISCAL_KIND_LABELS, f['kind']),
        String(f['receipt_number'] ?? '-'),
        label(FISCAL_STATE_LABELS, f['state']),
        money(f['amount_minor']),
        f['recorded_by_staff_id'] ? staffLabel(r, f['recorded_by_staff_id']) : '-',
        f['recorded_at'] ? almatyTime(f['recorded_at']) : '-',
      ]),
      'Записей Webkassa нет',
      'pos-receipt-fiscal',
    ),
    el(
      'p',
      'op-note',
      'Отмена, возврат и номер чека Webkassa оформляются только на кассе, по PIN начальника смены.',
    ),
  );
  return out;
}

/**
 * «Касса» (lane bo-ui, iiko-gap P0-1...P0-3): one Almaty day of the cash desks, read only.
 * Tabs «Смены и Z», «Чеки», «Webkassa», a day and a cash desk picker, three CSV exports. Voids,
 * refunds and Webkassa numbers are made on the cash desk by the shift manager's PIN; here they
 * are only shown. Keeps its day, desk, tab, filters and last answer between renders.
 */
export class PosDayView {
  private date = almatyDay();
  private terminal = '';
  private tab: 'shifts' | 'receipts' | 'webkassa' = 'shifts';
  private result: PosDay | null = null;
  private key = '';
  private error = '';
  private busy = false;
  private root: HTMLElement | null = null;
  private load: Loader | null = null;
  private branch = '';
  private filters: ReceiptFilters = { query: '', method: '', channel: '', state: '' };
  render(load: Loader, branch: string): HTMLElement {
    this.load = load;
    if (branch !== this.branch) {
      this.branch = branch;
      this.result = null;
      this.key = '';
      this.terminal = '';
    }
    const root = el('section', 'pos-day');
    root.dataset.testid = 'pos-day';
    this.root = root;
    this.draw();
    if (this.key !== this.want() && !this.busy) void this.fetch();
    return root;
  }
  private want() {
    return `${this.branch}|${this.date}|${this.terminal}`;
  }
  private async fetch() {
    if (!this.load) return;
    const key = this.want();
    this.busy = true;
    this.draw();
    try {
      const value = await this.load(this.date, this.terminal);
      if (key !== this.want()) return;
      this.result = value;
      this.key = key;
      this.error = '';
    } catch (error) {
      if (key !== this.want()) return;
      this.key = key;
      this.error =
        error instanceof ApiError && error.code === 'INVALID_REQUEST'
          ? 'Проверьте дату: нужен один календарный день.'
          : error instanceof ApiError && error.code === 'NOT_FOUND'
            ? 'Раздел «Касса» на сервере выключен. Обновите страницу позже.'
            : error instanceof ApiError && error.code === 'FORBIDDEN'
              ? 'У этой учётной записи нет доступа к данным точки.'
              : 'Данные кассы не загрузились. Проверьте связь и нажмите «Обновить».';
    } finally {
      this.busy = false;
      if (key === this.want()) this.draw();
    }
  }
  private draw() {
    const root = this.root;
    if (!root) return;
    root.replaceChildren();
    const r = this.result;
    const controls = el('div', 'pos-day-controls');
    const date = field(
      'День',
      this.date,
      (v) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
        this.date = v;
        void this.fetch();
      },
      { id: 'pos-day-date', type: 'date' },
    );
    const desks = [
      { value: '', label: 'Все кассы' },
      ...(r?.terminals ?? []).map((t) => ({ value: t.terminal_id, label: t.label })),
    ];
    if (this.terminal && !desks.some((d) => d.value === this.terminal))
      desks.push({ value: this.terminal, label: 'Выбранная касса' });
    const desk = select(
      'Касса',
      this.terminal,
      desks,
      (v) => {
        this.terminal = v;
        void this.fetch();
      },
      'pos-day-terminal',
    );
    const refresh = button(
      this.busy ? 'Загружаем...' : 'Обновить',
      () => {
        this.key = '';
        void this.fetch();
      },
      'button',
      'pos-day-refresh',
    );
    refresh.disabled = this.busy;
    controls.append(date, desk, refresh);
    root.append(controls);
    if (this.error) root.append(notice(this.error, 'warn', 'pos-day-error'));
    if (!r) {
      root.append(
        notice(
          this.busy ? 'Загружаем данные кассы...' : 'Данных пока нет.',
          'info',
          'pos-day-state',
        ),
      );
      return;
    }
    if (this.error) root.append(el('p', 'op-note', 'Ниже - последние полученные данные.'));
    const fresh = notice(
      freshnessText(r),
      r.coverage.pos_tables ? 'info' : 'warn',
      'pos-day-freshness',
    );
    root.append(fresh);
    root.append(
      el(
        'p',
        'op-note',
        `${dayLabel(r.date)} · ${r.terminal_id ? terminalLabel(r, r.terminal_id) : 'все кассы'}`,
      ),
    );
    const tabs = el('nav', 'pos-day-tabs');
    tabs.setAttribute('aria-label', 'Разделы кассы');
    for (const [key, name] of [
      ['shifts', 'Смены и Z'],
      ['receipts', 'Чеки'],
      ['webkassa', 'Webkassa'],
    ] as const) {
      const b = button(
        name,
        () => {
          this.tab = key;
          this.draw();
        },
        'button' + (this.tab === key ? ' selected' : ''),
        'pos-day-tab-' + key,
      );
      b.setAttribute('aria-pressed', String(this.tab === key));
      tabs.append(b);
    }
    root.append(tabs);
    const body = el('div', 'pos-day-body');
    if (this.tab === 'shifts') this.shifts(body, r);
    else if (this.tab === 'receipts') this.receipts(body, r);
    else this.webkassa(body, r);
    root.append(body);
    const rules = el('details', 'pos-day-rules');
    rules.append(el('summary', '', 'Как считается'));
    const ul = el('ul');
    for (const rule of POS_DAY_RULES) ul.append(el('li', '', rule));
    rules.append(ul);
    root.append(rules);
  }

  // ---------------------------------------------------------------- «Смены и Z» ----
  private shifts(body: HTMLElement, r: PosDay) {
    const t = r.totals;
    const head = el('div', 'pos-day-head');
    head.append(el('h2', '', 'Смены и Z-отчёты'));
    const csv = button(
      'Скачать Z-отчёты (CSV)',
      () => download(`pickchick-z-${r.date}.csv`, zCsv(r)),
      'button',
      'pos-day-z-csv',
    );
    csv.disabled = !r.shifts.length;
    head.append(csv);
    body.append(head);
    if (t) {
      const noRevenue = t['no_revenue'] as Data;
      const fiscal = r.fiscal_summary?.['pending'] as Data | undefined;
      body.append(
        stats(
          [
            [
              'Выручка кассы',
              money(t['revenue_minor']),
              `Продажи ${money(t['sales_minor'])} - отмены ${money(t['voids_minor'])} - возвраты ${money(t['refunds_minor'])}`,
            ],
            ['Чеки', String(t['checks']), `Средний чек ${money(t['average_check_minor'])}`],
            [
              'Без выручки',
              money(noRevenue['total_minor']),
              `Питание и маркетинг, чеков: ${String(noRevenue['checks'])}`,
            ],
            [
              'Webkassa не оформлено',
              String(fiscal?.['count'] ?? 0),
              `На сумму ${money(fiscal?.['amount_minor'] ?? '0')}`,
            ],
          ],
          'pos-day-totals',
        ),
      );
      body.append(
        el('h3', '', 'Способы оплаты за день'),
        table(
          ['Способ', 'Оплат', 'Продажи', 'Отмены', 'Возвраты', 'Итого'],
          r.methods.map((m) => [
            methodLabel(m['method']) + (m['revenue'] === false ? ' (без выручки)' : ''),
            String(m['payments']),
            money(m['sales_minor']),
            money(m['voids_minor']),
            money(m['refunds_minor']),
            money(m['net_minor']),
          ]),
          'Оплат за день нет',
          'pos-day-methods',
        ),
      );
    }
    if (!r.shifts.length) {
      body.append(
        notice(
          r.coverage.pos_tables || r.coverage.cashier_reports
            ? 'Кассовых смен за этот день нет.'
            : 'Отчёты кассы в облако не поступают.',
          'info',
          'pos-day-no-shifts',
        ),
      );
      return;
    }
    const list = el('div', 'pos-shifts');
    for (const s of r.shifts) list.append(this.shiftCard(r, s));
    body.append(list);
  }
  private shiftCard(r: PosDay, s: Data) {
    const card = el('article', 'panel op-panel pos-shift');
    card.dataset.testid = 'pos-shift-' + String(s['shift_id']);
    const state = String(s['state']);
    const head = el('div', 'panel-head'),
      title = el('div');
    title.append(
      el(
        'h3',
        '',
        `${terminalLabel(r, s['terminal_id'])} · смена ${String(s['shift_id']).slice(0, 6)}`,
      ),
      el(
        'p',
        'muted',
        [
          s['opened_at'] ? `Открыта ${almatyTime(s['opened_at'])}` : 'Время открытия не известно',
          s['closed_at'] ? `закрыта ${almatyTime(s['closed_at'])}` : '',
        ]
          .filter(Boolean)
          .join(', '),
      ),
    );
    head.append(
      title,
      badge(
        label(SHIFT_STATE_LABELS, state),
        state === 'closed' ? 'good' : state === 'open' ? '' : 'bad',
      ),
    );
    card.append(head);
    const people = [
      s['opened_by_staff_id'] ? `Открыл: ${staffLabel(r, s['opened_by_staff_id'])}` : '',
      (s['cashier_staff_ids'] as string[]).length
        ? `Кассиры: ${(s['cashier_staff_ids'] as string[]).map((id) => staffLabel(r, id)).join(', ')}`
        : '',
    ].filter(Boolean);
    if (people.length) card.append(el('p', 'op-note', people.join(' · ')));
    if (state === 'open')
      card.append(
        notice('Смена открыта. Это не X-отчёт кассы: суммы по чекам, которые уже получило облако.'),
      );
    else if (s['source'] === 'sales')
      card.append(notice('Отчёт смены в облако не поступал. Суммы - по полученным чекам.'));
    else if (s['source'] === 'cashier_report')
      card.append(notice('Z-отчёт ещё не получен. Наличные - по отчёту кассы.'));
    const flags = s['flags'] as Data;
    const cash = s['cash'] as Data | null;
    const terminal = s['terminal'] as Data;
    // Review BOUI-R6: the discrepancies of the shift on top, in one line.
    const key = el('p', 'pos-shift-key', shiftKeyLine(cash, terminal));
    key.dataset.testid = 'pos-shift-key';
    card.append(key);
    if (flags['cash_discrepancy'] === true && cash)
      card.append(
        notice(
          `Расхождение наличных: ${money(cash['discrepancy_minor'])}. Пояснение кассир пишет при закрытии смены на кассе; в облако оно пока не передаётся.`,
          'warn',
        ),
      );
    if (flags['terminal_discrepancy'] === true)
      card.append(
        notice(
          `Kaspi терминал: разница ${money(terminal['discrepancy_minor'])} с итогом кассы.`,
          'warn',
        ),
      );
    if (Number(flags['fiscal_pending']) > 0)
      card.append(
        notice(`Не оформлено чеков Webkassa: ${String(flags['fiscal_pending'])}.`, 'warn'),
      );
    const grid = el('div', 'pos-shift-grid');
    const opt = (v: unknown) => (v === null || v === undefined ? '-' : money(v));
    if (cash) {
      const box = el('div');
      box.append(
        el('h4', '', 'Наличные'),
        table(
          ['Показатель', 'Сумма'],
          [
            ['Разменный фонд', opt(cash['opening_cash_minor'])],
            ['Внесения', opt(cash['cash_in_minor'])],
            ['Изъятия', opt(cash['cash_out_minor'])],
            ['Наличные продажи', opt(cash['cash_sales_minor'])],
            ['Наличные возвраты', opt(cash['cash_refunds_minor'])],
            ['Ожидается в кассе', opt(cash['expected_cash_minor'])],
            ['Пересчитано', opt(cash['counted_cash_minor'])],
            ['Расхождение', opt(cash['discrepancy_minor'])],
          ],
          '-',
          'pos-shift-cash',
        ),
      );
      grid.append(box);
    }
    const kaspi = el('div');
    kaspi.append(
      el('h4', '', 'Kaspi терминал'),
      table(
        ['Показатель', 'Сумма'],
        [
          ['По кассе', opt(terminal['expected_minor'])],
          ['Введено при закрытии', opt(terminal['reported_minor'])],
          ['Разница', opt(terminal['discrepancy_minor'])],
        ],
        '-',
      ),
    );
    grid.append(kaspi);
    card.append(grid);
    const received = s['received'] as Data;
    // A phone shows one line per method that had payments (review BOUI-R6); the table stays
    // for wider screens.
    const short = methodLines(received['methods'] as Data[]);
    const lines = el('ul', 'pos-method-lines');
    lines.dataset.testid = 'pos-shift-method-lines';
    for (const line of short.lines) {
      const li = el('li', '', `${line.label}: `);
      line.parts.forEach((part, i) => {
        if (i) li.append(', ');
        li.append(el('span', 'op-nowrap', part));
      });
      lines.append(li);
    }
    if (!short.lines.length) lines.append(el('li', 'muted', 'Оплат нет.'));
    if (short.idle) lines.append(el('li', 'muted', short.idle));
    card.append(
      el(
        'h4',
        '',
        s['source'] === 'z' ? 'Способы оплаты по Z-отчёту' : 'Способы оплаты по полученным чекам',
      ),
      table(
        ['Способ', 'Оплат', 'Продажи', 'Возвраты и отмены'],
        (received['methods'] as Data[]).map((m) => [
          methodLabel(m['method']),
          String(m['count']),
          money(m['sales_minor']),
          money(m['refunds_minor']),
        ]),
        '-',
        'pos-shift-methods',
      ),
      lines,
    );
    const fiscal = s['fiscal'] as Data;
    card.append(
      el(
        'p',
        'op-note',
        `Чеков: ${String(received['sales_count'])}, отменено: ${String(received['voided_count'])}. ` +
          `Webkassa: не оформлено ${String(fiscal['pending'])}, оформлено ${String(fiscal['recorded'])}, не нужно ${String(fiscal['not_required'])}.`,
      ),
    );
    return card;
  }

  // ----------------------------------------------------------------------- «Чеки» ----
  private receipts(body: HTMLElement, r: PosDay) {
    const head = el('div', 'pos-day-head');
    head.append(el('h2', '', 'Чеки'));
    const csv = button(
      'Скачать чеки (CSV)',
      () => download(`pickchick-receipts-${r.date}.csv`, receiptsCsv(r)),
      'button',
      'pos-day-receipts-csv',
    );
    csv.disabled = !r.sales.length;
    head.append(csv);
    body.append(head);
    if (!r.coverage.pos_tables) {
      body.append(notice('Чеки появятся, когда облако начнёт получать продажи кассы.'));
      return;
    }
    const tools = el('div', 'pos-receipt-filters');
    const result = el('div');
    const count = el('p', 'op-note');
    count.dataset.testid = 'pos-receipts-count';
    const redraw = () => {
      const rows = filterReceipts(r.sales, this.filters);
      count.textContent = `Показано ${rows.length} из ${r.sales.length}`;
      result.replaceChildren(
        table(
          ['Время', 'Чек', 'Кассир', 'Канал', 'Оплата', 'Сумма', 'Состояние', 'Webkassa', ''],
          rows.map((s) => {
            const name = el('div', 'pos-receipt-name');
            name.append(el('strong', '', '№' + String(s['display_number'])));
            name.append(el('small', 'muted', terminalLabel(r, s['terminal_id'])));
            if (s['of_day'] !== true)
              name.append(el('small', 'muted', `чек ${dayLabel(s['business_date'])}`));
            const state = el('div');
            state.append(
              badge(
                saleStateText(s),
                s['state'] === 'voided' ? 'bad' : minor(s['refunded_minor']) > 0n ? '' : 'good',
              ),
            );
            if (s['revenue_kind'] !== 'revenue')
              state.append(el('small', 'muted', label(REVENUE_KIND_LABELS, s['revenue_kind'])));
            const wk = webkassaText(s);
            // The aggregator or ChocoFood number under the channel.
            const channel = el('div', 'pos-receipt-name');
            channel.append(el('span', '', channelLabel(s['channel'])));
            if (s['external_order_ref'])
              channel.append(el('small', 'muted', String(s['external_order_ref'])));
            return [
              when(r, s['sold_at']),
              name,
              staffLabel(r, s['cashier_staff_id']),
              channel,
              (s['tenders'] as Data[]).map((t) => methodLabel(t['method'])).join(' + '),
              money(s['total_minor']),
              state,
              wk === 'не оформлен' ? badge(wk, 'bad') : wk,
              button(
                'Открыть',
                () => this.openReceipt(r, s),
                'button subtle',
                `pos-receipt-open-${String(s['order_id'])}`,
              ),
            ];
          }),
          this.filters.query || this.filters.method || this.filters.channel || this.filters.state
            ? 'По фильтру чеков нет'
            : 'Чеков за этот день нет',
          'pos-receipts',
        ),
      );
    };
    const search = field(
      'Найти чек',
      this.filters.query,
      (v) => {
        this.filters.query = v;
        redraw();
      },
      { id: 'pos-receipt-search', max: 40 },
    );
    search.querySelector('input')!.placeholder = '№ заказа, номер агрегатора или Webkassa';
    tools.append(
      search,
      select(
        'Способ оплаты',
        this.filters.method,
        [
          { value: '', label: 'Все способы' },
          ...POS_DAY_METHODS.map((m) => ({ value: m, label: methodLabel(m) })),
        ],
        (v) => {
          this.filters.method = v;
          redraw();
        },
        'pos-receipt-method',
      ),
      select(
        'Канал',
        this.filters.channel,
        [
          { value: '', label: 'Все каналы' },
          ...POS_DAY_CHANNELS.map((c) => ({ value: c, label: channelLabel(c) })),
        ],
        (v) => {
          this.filters.channel = v;
          redraw();
        },
        'pos-receipt-channel',
      ),
      select(
        'Состояние',
        this.filters.state,
        RECEIPT_STATE_FILTERS.map(([value, name]) => ({ value, label: name })),
        (v) => {
          this.filters.state = v as ReceiptFilters['state'];
          redraw();
        },
        'pos-receipt-state',
      ),
    );
    body.append(tools, count);
    if (r.truncated.sales)
      body.append(
        notice(
          `Показаны последние ${r.limits.sales} чеков дня. Суммы на вкладке «Смены и Z» - по всему дню.`,
          'warn',
        ),
      );
    body.append(result);
    redraw();
  }
  private openReceipt(r: PosDay, s: Data) {
    const d = dialog(
      `Чек ${receiptName(r, s)}`,
      // The hall channel already says «Зал» or «С собой»; aggregators are always takeaway.
      `${almatyTime(s['sold_at'])} · ${channelLabel(s['channel'])}`,
    );
    d.dataset.testid = 'pos-receipt-card';
    d.append(...receiptDetails(r, s));
  }

  // -------------------------------------------------------------------- «Webkassa» ----
  private webkassa(body: HTMLElement, r: PosDay) {
    const head = el('div', 'pos-day-head');
    head.append(el('h2', '', 'Webkassa'));
    const rows = webkassaRows(r);
    const csv = button(
      'Скачать чеки Webkassa (CSV)',
      () => download(`pickchick-webkassa-${r.date}.csv`, webkassaCsv(r)),
      'button',
      'pos-day-webkassa-csv',
    );
    csv.disabled = !rows.length;
    head.append(csv);
    body.append(head);
    const f = r.fiscal_summary;
    if (!f) {
      body.append(notice('Чеки Webkassa появятся, когда облако начнёт получать продажи кассы.'));
      return;
    }
    const pending = f['pending'] as Data,
      recorded = f['recorded'] as Data,
      none = f['not_required'] as Data;
    body.append(
      stats(
        [
          ['Не оформлено', String(pending['count']), `На сумму ${money(pending['amount_minor'])}`],
          [
            'Оформлено',
            String(recorded['count']),
            `Продажи ${money(recorded['sales_minor'])}, возвраты ${money(recorded['refunds_minor'])}`,
          ],
          ['Итого по Webkassa', money(recorded['net_minor']), 'Продажи - возвраты по оформленным'],
          ['Чек не нужен', String(none['count']), `На сумму ${money(none['amount_minor'])}`],
        ],
        'pos-webkassa-totals',
      ),
      el(
        'p',
        'op-note',
        'Сверьте «Итого по Webkassa» с кабинетом Webkassa за этот день. Номер чека исправляется только на кассе, по PIN начальника смены.',
      ),
    );
    if (r.truncated.sales)
      body.append(
        notice('Список ниже - по показанным чекам дня; итоги выше - по всему дню.', 'warn'),
      );
    body.append(
      el('h3', '', 'Не оформлены'),
      table(
        ['Касса', 'Чек', 'Вид', 'Сумма', 'Время операции', 'Ждёт'],
        rows
          .filter((x) => x.receipt['state'] === 'pending')
          .map((x) => [
            terminalLabel(r, x.terminal_id),
            '№' + String(x.sale['display_number']),
            label(FISCAL_KIND_LABELS, x.receipt['kind']),
            money(x.receipt['amount_minor']),
            when(r, x.since),
            waitingText(x.waiting_minutes),
          ]),
        'Все чеки дня оформлены',
        'pos-webkassa-pending',
      ),
      el('h3', '', 'Оформлены'),
      table(
        ['Номер Webkassa', 'Вид', 'Сумма', 'Чек', 'Касса', 'Внёс', 'Когда'],
        rows
          .filter((x) => x.receipt['state'] === 'recorded')
          .map((x) => [
            String(x.receipt['receipt_number']),
            label(FISCAL_KIND_LABELS, x.receipt['kind']),
            money(x.receipt['amount_minor']),
            '№' + String(x.sale['display_number']),
            terminalLabel(r, x.terminal_id),
            staffLabel(r, x.receipt['recorded_by_staff_id']),
            when(r, x.receipt['recorded_at']),
          ]),
        'Оформленных чеков нет',
        'pos-webkassa-recorded',
      ),
      el('h3', '', 'Чек не нужен'),
      table(
        ['Способ оплаты', 'Чеков', 'Сумма'],
        (none['methods'] as Data[]).map((m) => [
          methodLabel(m['method']),
          String(m['count']),
          money(m['amount_minor']),
        ]),
        'Таких чеков нет',
        'pos-webkassa-not-required',
      ),
    );
  }
}

/**
 * «Сегодня» at the top of «Главная» while capabilities.pos_day is on (iiko-gap P0-6): revenue,
 * checks, average check and channels from GET .../ops/sales when the sales report is on (every
 * channel), otherwise from the cash desks of ops/pos-day; plus open cash shifts, unrecorded
 * Webkassa receipts and the time the cloud last heard from the cash desks.
 */
export class PosHomeView {
  private day: PosDay | null = null;
  private sales: SalesReport | null = null;
  private loadedAt = 0;
  private key = '';
  private busy = false;
  private error = '';
  private root: HTMLElement | null = null;
  private options: { open: () => void; salesReport: unknown } | null = null;
  render(options: {
    branch: string;
    posDay: Loader;
    salesReport: ((start: string, end: string) => Promise<SalesReport>) | null;
    open: () => void;
  }): HTMLElement {
    const root = el('section', 'panel op-panel pos-home');
    root.dataset.testid = 'pos-home';
    this.root = root;
    this.options = options;
    const today = almatyDay();
    const key = `${options.branch}|${today}|${options.salesReport ? 'sales' : 'pos'}`;
    if (key !== this.key) {
      this.day = null;
      this.sales = null;
      this.loadedAt = 0;
    }
    this.draw(options, today);
    if (!this.busy && (key !== this.key || Date.now() - this.loadedAt > 60000)) {
      this.key = key;
      this.busy = true;
      void Promise.all([
        options.posDay(today, ''),
        options.salesReport ? options.salesReport(today, today) : Promise.resolve(null),
      ])
        .then(([day, sales]) => {
          if (key !== this.key) return;
          this.day = day;
          this.sales = sales;
          this.error = '';
          this.loadedAt = Date.now();
        })
        .catch(() => {
          if (key !== this.key) return;
          this.error = 'Данные кассы не загрузились. Проверьте связь, страница обновится сама.';
          this.loadedAt = Date.now();
        })
        .finally(() => {
          this.busy = false;
          // The page may have been drawn again meanwhile: draw into the newest block.
          this.draw(this.options ?? options, today);
        });
    }
    return root;
  }
  private draw(options: { open: () => void; salesReport: unknown }, today: string) {
    const root = this.root;
    if (!root) return;
    root.replaceChildren();
    const head = el('div', 'panel-head'),
      title = el('div');
    title.append(
      el('h2', '', `Сегодня, ${dayLabel(today)}`),
      el(
        'p',
        'muted',
        this.sales
          ? 'Все каналы: касса, Яндекс Еда, Glovo, приложение и киоск. День по времени Алматы.'
          : 'Только касса: отчёт продаж по всем каналам на сервере выключен.',
      ),
    );
    head.append(title, button('Открыть «Кассу»', options.open, 'button', 'pos-home-open'));
    root.append(head);
    if (this.error) root.append(notice(this.error, 'warn', 'pos-home-error'));
    const d = this.day;
    if (!d) {
      root.append(notice(this.busy ? 'Загружаем данные кассы...' : 'Данных пока нет.'));
      return;
    }
    root.append(
      notice(freshnessText(d), d.coverage.pos_tables ? 'info' : 'warn', 'pos-home-freshness'),
    );
    const open = d.shifts.filter((s) => s['state'] === 'open');
    const pending = d.fiscal_summary?.['pending'] as Data | undefined;
    const s = this.sales;
    const t = s?.totals ?? null;
    const cash = d.totals;
    const revenue: [string, string, string?][] = t
      ? [
          ['Выручка', money(t['revenue_minor']), 'Продажи - отмены - возвраты'],
          ['Чеки', String(t['checks']), `Средний чек ${money(t['average_check_minor'])}`],
          [
            'Без выручки',
            money(t['no_revenue_minor']),
            `Питание и маркетинг, чеков: ${String(t['no_revenue_checks'])}`,
          ],
        ]
      : cash
        ? [
            ['Выручка кассы', money(cash['revenue_minor']), 'Продажи - отмены - возвраты'],
            ['Чеки', String(cash['checks']), `Средний чек ${money(cash['average_check_minor'])}`],
            [
              'Без выручки',
              money((cash['no_revenue'] as Data)['total_minor']),
              `Питание и маркетинг, чеков: ${String((cash['no_revenue'] as Data)['checks'])}`,
            ],
          ]
        : [];
    root.append(
      stats(
        [
          ...revenue,
          [
            'Открытые смены',
            String(open.length),
            open.length
              ? open
                  .map(
                    (x) => `${terminalLabel(d, x['terminal_id'])} с ${almatyClock(x['opened_at'])}`,
                  )
                  .join(', ')
              : 'Все смены закрыты',
          ],
          [
            'Webkassa не оформлено',
            pending ? String(pending['count']) : '-',
            pending ? `На сумму ${money(pending['amount_minor'])}` : 'Нет данных кассы',
          ],
        ],
        'pos-home-tiles',
      ),
    );
    if (s)
      root.append(
        table(
          ['Канал', 'Чеки', 'Выручка'],
          s.channels.map((c) => [
            SALES_CHANNEL_LABELS[String(c['channel'])] ?? String(c['channel']),
            String(c['checks']),
            money(c['revenue_minor']),
          ]),
          'Продаж сегодня нет',
          'pos-home-channels',
        ),
      );
    else if (cash)
      root.append(
        table(
          ['Канал', 'Чеки', 'Выручка'],
          d.channels.map((c) => [
            channelLabel(c['channel']),
            String(c['checks']),
            money(c['revenue_minor']),
          ]),
          'Продаж сегодня нет',
          'pos-home-channels',
        ),
      );
    if (!d.coverage.pos_tables && !t)
      root.append(
        el('p', 'op-note', 'Выручка кассы появится, когда облако начнёт получать продажи кассы.'),
      );
  }
}
