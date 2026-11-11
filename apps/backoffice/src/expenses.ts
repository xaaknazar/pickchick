import { element as el, button } from './dom.js';
import {
  addDays,
  addMonths,
  amountText,
  dayText,
  excel,
  excelAmount,
  explain,
  monthName,
  parseAmount,
  tenge,
  type Analytics,
  type Category,
  type Entry,
  type ExpensesModel,
  type Place,
  type Pnl,
  type Tab,
} from './expenses-model.js';

/**
 * «Расходы» (owner request 11.11.2026): «Ввод» (day or month grid per place, cash desk),
 * «Журнал», «ОПУ», «Аналитика», «Месяцы и доступ» and the former «Финансы» for reading.
 * Every cell is saved as soon as it is entered; the server refuses a closed month.
 */
type Journal = { entries: Entry[]; total_minor: string; truncated: boolean };
type JournalFilter = {
  start_date: string;
  end_date: string;
  location: string;
  category: string;
  source: string;
  search: string;
  group: 'date' | 'pl_month';
  basis: 'date' | 'pl_month';
};
type PnlFilter = {
  from: string;
  to: string;
  columns: 'locations' | 'months';
  cogs: 'ttk' | 'payments';
  allocate: boolean;
  percent: boolean;
};
type Access = { people: { actor_id: string; name: string; role: string | null }[] };
type LogRow = {
  id: string;
  action: string;
  location_id: string | null;
  date: string | null;
  before_value: unknown;
  after_value: unknown;
  created_at: string;
  author: string;
};

const ACTIONS: Record<string, string> = {
  'entry.create': 'Добавил запись',
  'entry.update': 'Изменил запись',
  'entry.delete': 'Удалил запись',
  row: 'Месяц ОПУ / комментарий строки',
  cash: 'Касса',
  'month.close': 'Закрыл месяц',
  'month.open': 'Открыл месяц',
  access: 'Доступ к разделу',
};
const ROLES: Record<string, string> = {
  director: 'Руководитель',
  finance: 'Финансист',
  economist: 'Экономист',
  viewer: 'Только просмотр',
};

function download(name: string, rows: (string | number)[][]) {
  const a = el('a');
  const url = URL.createObjectURL(new Blob([excel(rows)], { type: 'text/csv;charset=utf-8' }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function input(value: string, attrs: Record<string, string> = {}) {
  const i = el('input');
  i.value = value;
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
  return i;
}
function labelled(label: string, control: HTMLElement) {
  const l = el('label', 'field');
  l.append(el('span', '', label), control);
  return l;
}
function choose(value: string, options: [string, string][], attrs: Record<string, string> = {}) {
  const s = el('select');
  for (const [v, label] of options) {
    const o = el('option', '', label);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  return s;
}
const sum = (values: string[]) => values.reduce((a, v) => a + BigInt(v || '0'), 0n).toString();
const percentOf = (a: string, b: string) => {
  const x = BigInt(a || '0'),
    y = BigInt(b || '0');
  if (y === 0n) return '';
  const q = (x * 2000n + (y > 0n ? y : -y)) / (2n * y);
  return `${q / 10n},${(q < 0n ? -q : q) % 10n}%`;
};

export class ExpensesView {
  /** Renders the former «Финансы» (read-only reference) inside the tab «Прежний учёт». */
  legacy: ((target: HTMLElement) => void) | null = null;
  private groupsOpen = new Set<string>(['__all']);
  private onlyFilled = false;
  private search = '';
  private drafts = new Map<string, string>();
  private cellError = '';
  private dialog: { entry: Entry | null; values: Record<string, string> } | null = null;
  private dialogError = '';
  private journal: Journal | null = null;
  private journalFilter: JournalFilter;
  private journalBusy = false;
  private pnl: Pnl | null = null;
  private pnlFilter: PnlFilter;
  private pnlBusy = false;
  private analytics: Analytics | null = null;
  private analyticsRange: { from: string; to: string };
  private access: Access | null = null;
  private log: LogRow[] | null = null;
  private notice = '';
  private focusKey = '';
  /** The field being typed in when a redraw comes (kept with its caret). */
  private typing: { key: string; value: string; start: number | null; end: number | null } | null =
    null;

  constructor(
    private m: ExpensesModel,
    private changed: () => void,
  ) {
    this.journalFilter = {
      start_date: '',
      end_date: '',
      location: 'all',
      category: '',
      source: '',
      search: '',
      group: 'date',
      basis: 'date',
    };
    this.pnlFilter = {
      from: '',
      to: '',
      columns: 'locations',
      cogs: 'payments',
      allocate: false,
      percent: false,
    };
    this.analyticsRange = { from: '', to: '' };
    this.seed(m.date);
  }

  /** Periods start at the server's «today» (Almaty), not the browser clock. */
  private seededFrom = '';
  private seed(today: string) {
    if (this.seededFrom === today) return;
    const month = today.slice(0, 7);
    this.seededFrom = today;
    this.journalFilter = { ...this.journalFilter, start_date: month + '-01', end_date: today };
    this.pnlFilter = { ...this.pnlFilter, from: month, to: month };
    this.analyticsRange = { from: addMonths(month, -5), to: month };
  }
  private seededServer = false;

  /** A pending typed value would be lost: the cabinet asks before leaving. */
  get dirty() {
    return this.drafts.size > 0 || this.m.saving > 0;
  }

  render(target: HTMLElement) {
    if (!this.seededServer && this.m.meta) {
      this.seededServer = true;
      this.seed(this.m.meta.today);
    }
    const m = this.m;
    const area = el('div', 'expenses-workspace');
    target.append(area);
    if (!m.meta) {
      area.append(el('div', 'notice', 'Загружаю раздел «Расходы»…'));
      return;
    }
    const tabs = el('nav', 'finance-tabs expenses-tabs');
    tabs.setAttribute('aria-label', 'Разделы расходов');
    const list: [Tab, string][] = [
      ['entry', 'Ввод'],
      ['journal', 'Журнал'],
      ['pnl', 'ОПУ'],
      ['analytics', 'Аналитика'],
      ['months', m.can.close ? 'Месяцы и доступ' : 'Месяцы'],
    ];
    if (this.legacy) list.push(['legacy', 'Прежние «Финансы»']);
    for (const [id, label] of list) {
      const b = button(label, () => this.open(id), m.tab === id ? 'button selected' : 'button');
      b.dataset.testid = 'expenses-tab-' + id;
      b.setAttribute('aria-current', m.tab === id ? 'page' : 'false');
      tabs.append(b);
    }
    const state = el(
      'span',
      'expenses-save-state' + (m.saveError ? ' error' : ''),
      m.saving ? 'Сохраняю…' : m.saveError ? m.saveError : 'Всё сохранено',
    );
    state.setAttribute('role', 'status');
    state.dataset.testid = 'expenses-save-state';
    tabs.append(state);
    area.append(tabs);
    if (this.notice) {
      const n = el('div', 'notice compact', this.notice);
      n.setAttribute('role', 'status');
      area.append(n);
    }
    if (m.error) {
      const n = el('div', 'notice error', m.error);
      n.setAttribute('role', 'alert');
      area.append(n);
    }
    if (m.tab === 'entry') this.entry(area);
    else if (m.tab === 'journal') this.journalTab(area);
    else if (m.tab === 'pnl') this.pnlTab(area);
    else if (m.tab === 'analytics') this.analyticsTab(area);
    else if (m.tab === 'months') this.monthsTab(area);
    else if (m.tab === 'legacy' && this.legacy) {
      area.append(
        el(
          'div',
          'notice compact',
          'Прежний учёт «Финансы» только для справки. Новые расходы вносятся во вкладке «Ввод».',
        ),
      );
      this.legacy(area);
    }
    this.restoreFocus(area);
  }

  open(tab: Tab) {
    this.m.tab = tab;
    this.notice = '';
    this.m.error = '';
    if (tab === 'entry') void this.m.loadScreen();
    if (tab === 'journal') void this.loadJournal();
    if (tab === 'pnl') void this.loadPnl();
    if (tab === 'analytics') void this.loadAnalytics();
    if (tab === 'months') void this.loadMonths();
    this.changed();
  }
  /** Before a redraw: what is being typed now, so the redraw keeps it. */
  capture() {
    const a = document.activeElement;
    if (a instanceof HTMLInputElement && a.dataset.key && a.closest('.expenses-workspace')) {
      this.focusKey = a.dataset.key;
      let start: number | null = null,
        end: number | null = null;
      try {
        start = a.selectionStart;
        end = a.selectionEnd;
      } catch {
        // month inputs have no selection
      }
      this.typing = { key: a.dataset.key, value: a.value, start, end };
    } else this.typing = null;
  }
  private typed(key: string, fallback: string) {
    return this.typing?.key === key ? this.typing.value : fallback;
  }
  /** Keeps the cursor in the grid across the redraws that follow each saved cell. */
  private restoreFocus(area: HTMLElement) {
    if (!this.focusKey) return;
    const key = this.focusKey,
      typing = this.typing;
    this.typing = null;
    // After the cabinet has put the new page into the document.
    setTimeout(() => {
      const next = area.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(key)}"]`);
      if (!next || document.activeElement === next || !next.isConnected) return;
      next.focus();
      try {
        if (typing?.key === key && typing.start !== null)
          next.setSelectionRange(typing.start, typing.end ?? typing.start);
        else next.select?.();
      } catch {
        // month inputs have no selection
      }
    }, 0);
  }

  // ---------------------------------------------------------------- «Ввод»
  private entry(area: HTMLElement) {
    const m = this.m,
      meta = m.meta!;
    const bar = el('div', 'expenses-toolbar');
    const kind = el('div', 'segmented');
    kind.setAttribute('role', 'group');
    kind.setAttribute('aria-label', 'Период ввода');
    for (const [id, label] of [
      ['day', 'За день'],
      ['month', 'За месяц'],
    ] as const) {
      const b = button(
        label,
        () => {
          m.period = id;
          void m.loadScreen();
        },
        m.period === id ? 'button selected' : 'button',
      );
      b.setAttribute('aria-pressed', String(m.period === id));
      kind.append(b);
    }
    bar.append(kind);
    if (m.period === 'day') {
      const prev = button('‹', () => this.shiftDay(-1), 'button small');
      prev.setAttribute('aria-label', 'Предыдущий день');
      const date = input(m.date, { type: 'date', max: meta.today, 'aria-label': 'Дата' });
      date.addEventListener('change', () => {
        if (date.value && date.value <= meta.today) {
          m.date = date.value;
          void m.loadScreen();
        }
      });
      const next = button('›', () => this.shiftDay(1), 'button small');
      next.setAttribute('aria-label', 'Следующий день');
      next.disabled = m.date >= meta.today;
      const today = button(
        'Сегодня',
        () => {
          m.date = meta.today;
          void m.loadScreen();
        },
        'button small',
      );
      bar.append(prev, date, next, today);
    } else {
      const prev = button('‹', () => this.shiftMonth(-1), 'button small');
      prev.setAttribute('aria-label', 'Предыдущий месяц');
      const month = input(m.month, {
        type: 'month',
        max: meta.today.slice(0, 7),
        'aria-label': 'Месяц',
      });
      month.addEventListener('change', () => {
        if (month.value && month.value <= meta.today.slice(0, 7)) {
          m.month = month.value;
          void m.loadScreen();
        }
      });
      const next = button('›', () => this.shiftMonth(1), 'button small');
      next.setAttribute('aria-label', 'Следующий месяц');
      next.disabled = m.month >= meta.today.slice(0, 7);
      bar.append(prev, month, next);
      bar.append(
        el(
          'span',
          'muted',
          'Суммы, которые приходят раз в месяц: выписка банка, аренда, коммунальные, итоги месяца.',
        ),
      );
    }
    area.append(bar);
    const s = m.screen;
    if (!s) {
      area.append(el('div', 'notice', m.loading ? 'Загружаю…' : 'Нет данных.'));
      if (!m.loading && !m.error) void m.loadScreen();
      return;
    }
    if (s.closed) area.append(el('div', 'notice', 'Месяц закрыт, данные только для просмотра.'));
    const layout = el('div', 'expenses-layout');
    area.append(layout);
    // Left: places with their status.
    const side = el('aside', 'expenses-places');
    const progress = el('div', 'expenses-progress');
    progress.append(el('strong', '', `Заполнено ${s.filled} из ${s.total} точек`));
    const meter = el('div', 'expenses-meter');
    const fill = el('span');
    fill.style.width = s.total ? `${Math.round((s.filled / s.total) * 100)}%` : '0';
    meter.append(fill);
    progress.append(meter);
    side.append(progress);
    if (m.place === undefined) m.place = s.locations[0]?.id ?? '';
    for (const p of s.locations) {
      const key = p.id ?? '';
      const b = el('button', 'expenses-place' + (m.place === key ? ' active' : ''));
      b.type = 'button';
      b.dataset.testid = 'expenses-place-' + (p.id ?? 'company');
      const mark = el(
        'span',
        'expenses-status ' + p.status,
        p.status === 'mismatch' ? '!' : p.status === 'filled' ? '✓' : '',
      );
      mark.setAttribute(
        'aria-label',
        p.status === 'mismatch'
          ? 'Касса не сходится'
          : p.status === 'filled'
            ? 'Расходы внесены'
            : 'Ничего не внесено',
      );
      const text = el('span', 'expenses-place-text');
      text.append(el('strong', '', p.name));
      text.append(
        el(
          'small',
          '',
          `Расходы ${tenge(p.expenses_minor)}` +
            (p.revenue ? ` · Выручка ${tenge(p.revenue.total_minor)}` : ''),
        ),
      );
      b.append(mark, text);
      b.addEventListener('click', () => {
        m.place = key;
        this.focusKey = '';
        this.changed();
      });
      if (p.id === null) side.append(el('hr'));
      side.append(b);
    }
    layout.append(side);
    const place = s.locations.find((p) => (p.id ?? '') === m.place) ?? s.locations[0]!;
    const main = el('section', 'expenses-main');
    layout.append(main);
    main.append(el('h2', '', place.name));
    if (place.id) main.append(this.revenueBlock(place));
    if (place.id && m.period === 'day') main.append(this.cashBlock(place, s.closed));
    main.append(this.grid(place, s.closed));
    main.append(this.counterparties(place, s.closed));
    main.append(this.dayTotal(place));
    if (this.dialog) area.append(this.entryDialog());
  }
  private shiftDay(n: number) {
    const next = addDays(this.m.date, n);
    if (next > this.m.meta!.today) return;
    this.m.date = next;
    void this.m.loadScreen();
  }
  private shiftMonth(n: number) {
    const next = addMonths(this.m.month, n);
    if (next > this.m.meta!.today.slice(0, 7)) return;
    this.m.month = next;
    void this.m.loadScreen();
  }
  private revenueBlock(p: Place) {
    const meta = this.m.meta!;
    const box = el('div', 'expenses-revenue');
    const r = p.revenue!;
    const tiles = el('div', 'expenses-tiles');
    const tile = (label: string, value: string, hint = '') => {
      const t = el('div', 'expenses-tile');
      t.append(el('small', '', label), el('strong', '', value));
      if (hint) t.append(el('small', 'muted', hint));
      tiles.append(t);
    };
    tile('Выручка за ' + (this.m.period === 'day' ? 'день' : 'месяц'), tenge(r.total_minor));
    for (const t of meta.revenue_types)
      if (r.by_type[t.code]) tile(t.name, tenge(r.by_type[t.code]));
    if (r.manual_minor !== '0') tile('Выручка вручную', tenge(r.manual_minor));
    if (p.cogs_ttk_minor !== null)
      tile(
        'Себестоимость по ТТК',
        tenge(p.cogs_ttk_minor),
        p.foodcost_percent ? `фудкост ${p.foodcost_percent.replace('.', ',')}%` : '',
      );
    box.append(tiles);
    if (!meta.revenue_available)
      box.append(
        el(
          'small',
          'muted',
          'Выручки с кассы на сервере пока нет. Пока работает iiko, внесите её статьёй «Выручка вручную».',
        ),
      );
    return box;
  }

  private rowsFor(place: Place) {
    const m = this.m,
      meta = m.meta!;
    return meta.categories.filter(
      (c) => c.kind !== 'revenue_auto' && (place.id !== null || c.company),
    );
  }
  private grid(place: Place, closed: boolean) {
    const m = this.m,
      meta = m.meta!;
    const writable = m.can.write && !closed;
    const wrap = el('div', 'expenses-grid-wrap');
    const tools = el('div', 'expenses-grid-tools');
    const find = input(this.search, {
      type: 'search',
      placeholder: 'Поиск статьи',
      'aria-label': 'Поиск статьи',
    });
    find.addEventListener('input', () => {
      this.search = find.value;
      this.focusKey = 'search';
      this.changed();
    });
    find.dataset.key = 'search';
    const only = el('label', 'check');
    const box = input('', { type: 'checkbox' });
    box.checked = this.onlyFilled;
    box.addEventListener('change', () => {
      this.onlyFilled = box.checked;
      this.changed();
    });
    only.append(box, el('span', '', 'Только заполненные'));
    const all = button(
      this.groupsOpen.has('__all') ? 'Свернуть группы' : 'Развернуть группы',
      () => {
        if (this.groupsOpen.has('__all')) this.groupsOpen.clear();
        else this.groupsOpen = new Set(['__all', ...meta.groups.map((g) => g.code)]);
        this.changed();
      },
      'button small subtle',
    );
    const add = button(
      'Добавить с контрагентом',
      () => this.openDialog(null, place),
      'button small',
    );
    add.disabled = !writable;
    add.dataset.testid = 'expenses-add-counterparty';
    tools.append(find, only, all, add);
    if (this.cellError) {
      const err = el('span', 'expenses-cell-error', this.cellError);
      err.setAttribute('role', 'alert');
      tools.append(err);
    }
    wrap.append(tools);
    const scroll = el('div', 'table-scroll');
    const table = el('table', 'expenses-grid');
    const head = el('tr');
    head.append(el('th', '', 'Статья'));
    for (const s of meta.sources) head.append(el('th', 'num', s.short));
    head.append(el('th', 'num', 'Итого'), el('th', '', 'Месяц ОПУ'), el('th', '', 'Комментарий'));
    const thead = el('thead');
    thead.append(head);
    table.append(thead);
    const body = el('tbody');
    table.append(body);
    const cells = place.entries.filter((e) => e.cell);
    const rows = this.rowsFor(place);
    const q = this.search.trim().toLowerCase();
    const visibleRows: Category[] = [];
    for (const g of meta.groups) {
      const inGroup = rows.filter(
        (c) =>
          c.group === g.code &&
          (!q || c.name.toLowerCase().includes(q)) &&
          (!this.onlyFilled ||
            cells.some((e) => e.category === c.code) ||
            place.entries.some((e) => e.category === c.code)),
      );
      if (!inGroup.length) continue;
      const open = this.groupsOpen.has('__all') || this.groupsOpen.has(g.code) || !!q;
      const groupTotal = sum(
        place.entries
          .filter((e) => inGroup.some((c) => c.code === e.category))
          .map((e) => e.amount_minor),
      );
      const gr = el('tr', 'expenses-group');
      const th = el('th');
      th.colSpan = meta.sources.length + 4;
      const toggle = button(
        `${open ? '▾' : '▸'} ${g.name}`,
        () => {
          if (open) {
            this.groupsOpen.delete('__all');
            for (const x of meta.groups) if (x.code !== g.code) this.groupsOpen.add(x.code);
            this.groupsOpen.delete(g.code);
          } else this.groupsOpen.add(g.code);
          this.changed();
        },
        'expenses-group-toggle',
      );
      toggle.setAttribute('aria-expanded', String(open));
      th.append(toggle, el('span', 'muted', groupTotal !== '0' ? ' ' + tenge(groupTotal) : ''));
      gr.append(th);
      body.append(gr);
      if (!open) continue;
      for (const c of inGroup) {
        visibleRows.push(c);
        const tr = el('tr');
        const name = el('td', 'expenses-article', c.name);
        tr.append(name);
        for (const s of meta.sources) {
          const td = el('td', 'num');
          const entry = cells.find((e) => e.category === c.code && e.source === s.code);
          const key = `${place.id ?? 'company'}|${c.code}|${s.code}`;
          const value = this.typed(
            key,
            this.drafts.get(key) ?? amountText(entry?.amount_minor ?? null),
          );
          const cell = input(value, {
            inputmode: 'decimal',
            'aria-label': `${c.name}, ${s.short}`,
            autocomplete: 'off',
          });
          cell.className = 'expenses-cell';
          cell.dataset.key = key;
          cell.dataset.row = c.code;
          cell.dataset.col = s.code;
          cell.readOnly = !writable;
          const original = value;
          cell.addEventListener('focus', () => (this.focusKey = key));
          cell.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') {
              cell.value = amountText(entry?.amount_minor ?? null);
              this.drafts.delete(key);
              this.cellError = '';
              cell.blur();
            } else if (ev.key === 'Enter') {
              ev.preventDefault();
              const at = visibleRows.findIndex((r) => r.code === c.code);
              const nextRow = visibleRows[at + 1];
              this.focusKey = nextRow ? `${place.id ?? 'company'}|${nextRow.code}|${s.code}` : key;
              // Move first: the redraw that the save starts keeps the cursor where it went.
              body
                .querySelector<HTMLInputElement>(`[data-key="${CSS.escape(this.focusKey)}"]`)
                ?.focus();
              this.commit(cell, key, place, c, s.code, original);
            }
          });
          cell.addEventListener('change', () => this.commit(cell, key, place, c, s.code, original));
          td.append(cell);
          tr.append(td);
        }
        const rowEntries = place.entries.filter((e) => e.category === c.code);
        const total = sum(rowEntries.map((e) => e.amount_minor));
        tr.append(el('td', 'num expenses-total', total === '0' ? '' : amountText(total)));
        const meta0 = place.rows.find((r) => r.category === c.code);
        const rowMonth =
          meta0?.pl_month ??
          cells.find((e) => e.category === c.code)?.pl_month ??
          (this.m.period === 'day' ? this.m.date.slice(0, 7) : this.m.month);
        const monthTd = el('td');
        const plm = input(rowMonth, { type: 'month', 'aria-label': `${c.name}: месяц ОПУ` });
        plm.readOnly = !writable || this.m.period === 'month';
        plm.disabled = !writable || this.m.period === 'month';
        plm.dataset.key = key0(place, c.code, 'pl');
        plm.addEventListener('change', () => {
          if (!/^\d{4}-\d{2}$/.test(plm.value)) return;
          void this.m.row(place.id, c.code, plm.value, meta0?.comment ?? '');
        });
        monthTd.append(plm);
        const commentTd = el('td');
        const comment = input(this.typed(key0(place, c.code, 'comment'), meta0?.comment ?? ''), {
          'aria-label': `${c.name}: комментарий`,
          maxlength: '1000',
        });
        comment.readOnly = !writable;
        comment.dataset.key = key0(place, c.code, 'comment');
        comment.addEventListener('focus', () => (this.focusKey = comment.dataset.key!));
        comment.addEventListener(
          'change',
          () => void this.m.row(place.id, c.code, rowMonth, comment.value.trim()),
        );
        comment.addEventListener('keydown', (ev) => {
          if (ev.key === 'Escape') {
            comment.value = meta0?.comment ?? '';
            comment.blur();
          }
        });
        commentTd.append(comment);
        tr.append(monthTd, commentTd);
        body.append(tr);
      }
    }
    if (!body.children.length) {
      const tr = el('tr');
      const td = el('td', 'empty', 'Нет статей по этому фильтру.');
      td.colSpan = meta.sources.length + 4;
      tr.append(td);
      body.append(tr);
    }
    scroll.append(table);
    wrap.append(scroll);
    return wrap;
  }
  private commit(
    cell: HTMLInputElement,
    key: string,
    place: Place,
    c: Category,
    source: string,
    original: string,
  ) {
    if (cell.value === original && !this.drafts.has(key)) return;
    // Enter sends, and the change that follows the move to the next row must not send it again.
    if (cell.dataset.sent === cell.value) return;
    let amount: string | null;
    try {
      amount = parseAmount(cell.value);
    } catch (e) {
      this.cellError = (e as Error).message;
      cell.setAttribute('aria-invalid', 'true');
      this.changed();
      return;
    }
    this.cellError = '';
    cell.removeAttribute('aria-invalid');
    cell.dataset.sent = cell.value;
    this.drafts.set(key, cell.value);
    void this.m.cell(place.id, c.code, source, amount).then((error) => {
      if (!error) this.drafts.delete(key);
      else this.cellError = `${c.name}: ${error}`;
      this.changed();
    });
  }

  private counterparties(place: Place, closed: boolean) {
    const m = this.m;
    const list = place.entries.filter((e) => !e.cell);
    const box = el('div', 'expenses-counterparties');
    if (!list.length) return box;
    box.append(el('h3', '', 'Записи с контрагентом'));
    const t = el('table', 'expenses-list');
    const h = el('tr');
    for (const v of ['Статья', 'Источник', 'Сумма', 'Месяц ОПУ', 'Контрагент', 'Комментарий', ''])
      h.append(el('th', '', v));
    t.append(h);
    for (const e of list) {
      const tr = el('tr');
      tr.append(
        el('td', '', m.category(e.category)?.name ?? e.category),
        el('td', '', m.meta!.sources.find((s) => s.code === e.source)?.short ?? e.source),
        el('td', 'num', amountText(e.amount_minor)),
        el('td', '', monthName(e.pl_month)),
        el('td', '', e.counterparty),
        el('td', '', e.comment),
      );
      const td = el('td');
      const edit = button(
        m.can.write && !closed ? 'Изменить' : 'Открыть',
        () => this.openDialog(e, place),
        'button small subtle',
      );
      td.append(edit);
      tr.append(td);
      t.append(tr);
    }
    box.append(t);
    return box;
  }
  private dayTotal(place: Place) {
    const m = this.m,
      meta = m.meta!;
    const box = el('div', 'expenses-day-total');
    box.append(el('h3', '', m.period === 'day' ? 'Итог дня' : 'Итог месяца (записи «за месяц»)'));
    const dl = el('dl');
    const pair = (k: string, v: string) => dl.append(el('dt', '', k), el('dd', '', v));
    if (place.revenue) pair('Выручка', tenge(place.revenue.total_minor));
    pair('Расходы', tenge(place.expenses_minor));
    if (place.revenue)
      pair(
        'Расходы к выручке',
        place.expense_percent ? place.expense_percent.replace('.', ',') + '%' : '-',
      );
    for (const s of meta.sources)
      if (place.expenses_by_source[s.code])
        pair(`  ${s.name}`, tenge(place.expenses_by_source[s.code]));
    box.append(dl);
    const link = button(
      'Открыть записи в журнале',
      () => {
        const day = m.period === 'day' ? m.date : m.month + '-01';
        this.journalFilter = {
          ...this.journalFilter,
          start_date: day,
          end_date: m.period === 'day' ? m.date : addDays(addMonths(m.month, 1) + '-01', -1),
          location: place.id ?? 'company',
          category: '',
          source: '',
          search: '',
          basis: 'date',
        };
        this.open('journal');
      },
      'button small subtle',
    );
    box.append(link);
    return box;
  }

  // ---------------------------------------------------------------- касса
  private cashBlock(place: Place, closed: boolean) {
    const m = this.m;
    const c = place.cash;
    const box = el('details', 'expenses-cash' + (c?.mismatch ? ' mismatch' : ''));
    box.open = !!c?.mismatch || c?.counted_minor === null || true;
    const summary = el('summary');
    summary.append(
      el('strong', '', 'Сверка кассы'),
      el(
        'span',
        c?.mismatch ? 'expenses-cash-diff bad' : 'expenses-cash-diff',
        !c
          ? ''
          : c.difference_minor === null
            ? ' · остаток по отчёту кассира не введён'
            : c.mismatch
              ? ` · разница ${tenge(c.difference_minor)}`
              : ' · сходится',
      ),
    );
    box.append(summary);
    if (!c) return box;
    const writable = m.can.write && !closed;
    const table = el('table', 'expenses-cash-table');
    const line = (label: string, value: string, sign = '') => {
      const tr = el('tr');
      tr.append(el('td', '', label), el('td', 'num', sign + tenge(value)));
      table.append(tr);
    };
    line(
      c.opening_source === 'manual'
        ? 'Сальдо на начало дня (введено вручную)'
        : c.opening_source === 'previous'
          ? `Сальдо на начало дня (по отчёту кассира за ${dayText(c.previous_date ?? '')})`
          : 'Сальдо на начало дня (нет данных, 0)',
      c.opening_minor,
    );
    line('Наличная выручка', c.cash_revenue_minor, '+ ');
    line('Прочие поступления наличными', c.cash_income_minor, '+ ');
    line('Снятие со счёта', c.withdrawal_minor, '+ ');
    line('Расходы наличными', c.cash_expenses_minor, '− ');
    line('Инкассация', c.collection_minor, '− ');
    const exp = el('tr', 'total');
    exp.append(el('td', '', 'Должно быть в кассе'), el('td', 'num', tenge(c.expected_minor)));
    table.append(exp);
    box.append(table);
    const form = el('div', 'expenses-cash-form');
    const opening = input(c.opening_source === 'manual' ? amountText(c.opening_minor) : '', {
      inputmode: 'decimal',
      placeholder: 'пусто = по отчёту за прошлый день',
    });
    const counted = input(amountText(c.counted_minor), {
      inputmode: 'decimal',
      'data-testid': 'expenses-cash-counted',
    });
    const comment = input(c.comment, { maxlength: '1000' });
    for (const i of [opening, counted, comment]) i.readOnly = !writable;
    const save = button(
      'Сохранить кассу',
      () => {
        let o: string | null, k: string | null;
        try {
          o = parseAmount(opening.value);
          k = counted.value.trim() === '' ? null : (parseAmount(counted.value) ?? '0');
        } catch (e) {
          this.cellError = (e as Error).message;
          this.changed();
          return;
        }
        void m.cash(place.id!, o, k, comment.value.trim());
      },
      'button small primary',
    );
    save.disabled = !writable;
    form.append(
      labelled('Сальдо на начало вручную', opening),
      labelled('По отчёту кассира', counted),
      labelled('Комментарий', comment),
      save,
    );
    box.append(form);
    if (c.difference_minor !== null) {
      const diff = el(
        'p',
        c.mismatch ? 'expenses-cash-result bad' : 'expenses-cash-result',
        c.mismatch
          ? `Разница: ${tenge(c.difference_minor)} (по отчёту кассира − должно быть). Внесите недостачу или излишек статьёй «Недостача / излишек по кассе» или найдите неучтённый расход.`
          : 'Касса сходится.',
      );
      box.append(diff);
    }
    return box;
  }

  // ---------------------------------------------------------------- запись с контрагентом
  private openDialog(entry: Entry | null, place: Place | null) {
    const m = this.m;
    const day = m.period === 'day' ? m.date : m.month + '-01';
    this.dialogError = '';
    this.dialog = {
      entry,
      values: entry
        ? {
            location: entry.location_id ?? '',
            date: entry.date,
            category: entry.category,
            source: entry.source,
            amount: amountText(entry.amount_minor).replace('−', '-'),
            pl_month: entry.pl_month,
            monthly: entry.monthly ? '1' : '',
            counterparty: entry.counterparty,
            comment: entry.comment,
          }
        : {
            location: place?.id ?? '',
            date: day,
            category: 'suppliers',
            source: 'cash',
            amount: '',
            pl_month: day.slice(0, 7),
            monthly: m.period === 'month' ? '1' : '',
            counterparty: '',
            comment: '',
          },
    };
    this.changed();
  }
  private entryDialog() {
    const m = this.m,
      meta = m.meta!,
      d = this.dialog!,
      v = d.values;
    const closed = m.isClosed(v.date!.slice(0, 7)) || m.isClosed(v.pl_month!);
    const writable = m.can.write && !closed;
    const shade = el('div', 'expenses-dialog-shade');
    const box = el('div', 'expenses-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', d.entry ? 'Запись' : 'Добавить с контрагентом');
    box.append(
      el('h3', '', d.entry ? (writable ? 'Изменить запись' : 'Запись') : 'Добавить с контрагентом'),
    );
    if (closed)
      box.append(el('div', 'notice compact', 'Месяц закрыт, данные только для просмотра.'));
    const set = (k: string) => (e: Event) => (v[k] = (e.target as HTMLInputElement).value);
    const place = choose(v.location!, [
      ...meta.locations.map((l) => [l.id, l.name] as [string, string]),
      ['', 'Общие расходы компании'],
    ]);
    place.addEventListener('change', set('location'));
    const date = input(v.date!, { type: 'date', max: meta.today });
    date.addEventListener('change', set('date'));
    const groups = meta.groups;
    const cat = el('select');
    for (const g of groups) {
      const og = el('optgroup');
      og.label = g.name;
      for (const c of meta.categories.filter(
        (c) => c.group === g.code && c.kind !== 'revenue_auto',
      )) {
        const o = el('option', '', c.name);
        o.value = c.code;
        og.append(o);
      }
      if (og.children.length) cat.append(og);
    }
    cat.value = v.category!;
    cat.addEventListener('change', set('category'));
    const source = choose(
      v.source!,
      meta.sources.map((s) => [s.code, s.name]),
    );
    source.addEventListener('change', set('source'));
    const amount = input(v.amount!, {
      inputmode: 'decimal',
      'data-testid': 'expenses-dialog-amount',
    });
    amount.addEventListener('input', set('amount'));
    const pl = input(v.pl_month!, { type: 'month' });
    pl.addEventListener('change', set('pl_month'));
    const monthly = input('', { type: 'checkbox' });
    monthly.checked = v.monthly === '1';
    monthly.addEventListener('change', () => (v.monthly = monthly.checked ? '1' : ''));
    const counterparty = input(v.counterparty!, { maxlength: '200' });
    counterparty.addEventListener('input', set('counterparty'));
    const comment = input(v.comment!, { maxlength: '1000' });
    comment.addEventListener('input', set('comment'));
    for (const c of [place, date, cat, source, amount, pl, monthly, counterparty, comment])
      (c as HTMLInputElement).disabled = !writable;
    const monthlyLabel = el('label', 'check');
    monthlyLabel.append(monthly, el('span', '', 'Расход за месяц (дата = последний день месяца)'));
    box.append(
      labelled('Точка', place),
      labelled('Дата', date),
      labelled('Статья', cat),
      labelled('Источник', source),
      labelled('Сумма, ₸', amount),
      labelled('Месяц ОПУ', pl),
      monthlyLabel,
      labelled('Контрагент', counterparty),
      labelled('Комментарий', comment),
    );
    if (this.dialogError) {
      const err = el('div', 'notice error', this.dialogError);
      err.setAttribute('role', 'alert');
      box.append(err);
    }
    const actions = el('div', 'expenses-dialog-actions');
    const save = button(
      'Сохранить',
      async () => {
        let minor: string | null;
        try {
          minor = parseAmount(v.amount ?? '');
        } catch (e) {
          this.dialogError = (e as Error).message;
          this.changed();
          return;
        }
        if (!minor) {
          this.dialogError = 'Введите сумму.';
          this.changed();
          return;
        }
        const body = {
          location_id: v.location || null,
          date: v.date,
          category: v.category,
          source: v.source,
          amount_minor: minor,
          pl_month: v.pl_month,
          monthly: v.monthly === '1',
          counterparty: (v.counterparty ?? '').trim(),
          comment: (v.comment ?? '').trim(),
        };
        const error = await m.saveEntry(d.entry?.id ?? null, body);
        if (error) this.dialogError = error;
        else {
          this.dialog = null;
          if (m.tab === 'journal') await this.loadJournal();
        }
        this.changed();
      },
      'button primary',
    );
    save.disabled = !writable;
    save.dataset.testid = 'expenses-dialog-save';
    actions.append(save);
    if (d.entry) {
      const remove = button(
        'Удалить',
        async () => {
          if (!window.confirm('Удалить запись? Действие попадёт в журнал действий.')) return;
          const error = await m.deleteEntry(d.entry!.id);
          if (error) this.dialogError = error;
          else {
            this.dialog = null;
            if (m.tab === 'journal') await this.loadJournal();
          }
          this.changed();
        },
        'button danger',
      );
      remove.disabled = !writable;
      actions.append(remove);
    }
    actions.append(
      button('Закрыть', () => {
        this.dialog = null;
        this.changed();
      }),
    );
    box.append(actions);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.dialog = null;
        this.changed();
      }
    });
    shade.append(box);
    return shade;
  }

  // ---------------------------------------------------------------- «Журнал»
  async loadJournal() {
    this.journalBusy = true;
    this.changed();
    try {
      const f = this.journalFilter;
      this.journal = await this.m.read<Journal>('journal', {
        start_date: f.start_date,
        end_date: f.end_date,
        location: f.location,
        category: f.category,
        source: f.source,
        search: f.search,
        group: f.group,
        basis: f.basis,
      });
      this.m.error = '';
    } catch (e) {
      this.m.error = explain(e);
    } finally {
      this.journalBusy = false;
      this.changed();
    }
  }
  private journalTab(area: HTMLElement) {
    const m = this.m,
      meta = m.meta!,
      f = this.journalFilter;
    const form = el('form', 'expenses-toolbar');
    const start = input(f.start_date, { type: 'date' });
    const end = input(f.end_date, { type: 'date' });
    const place = choose(f.location, [
      ['all', 'Все точки и общие'],
      ...meta.locations.map((l) => [l.id, l.name] as [string, string]),
      ['company', 'Общие расходы компании'],
    ]);
    const cat = choose(f.category, [
      ['', 'Все статьи'],
      ...meta.categories
        .filter((c) => c.kind !== 'revenue_auto')
        .map((c) => [c.code, c.name] as [string, string]),
    ]);
    const source = choose(f.source, [
      ['', 'Все источники'],
      ...meta.sources.map((s) => [s.code, s.short] as [string, string]),
    ]);
    const search = input(f.search, {
      type: 'search',
      placeholder: 'Комментарий, контрагент, автор',
      maxlength: '80',
    });
    const group = choose(f.group, [
      ['date', 'Группировать по дате'],
      ['pl_month', 'Группировать по месяцу ОПУ'],
    ]);
    const basis = choose(f.basis, [
      ['date', 'Период по дате операции'],
      ['pl_month', 'Период по месяцу ОПУ'],
    ]);
    const apply = button(
      'Показать',
      () => {
        this.journalFilter = {
          start_date: start.value,
          end_date: end.value,
          location: place.value,
          category: cat.value,
          source: source.value,
          search: search.value.trim(),
          group: group.value as JournalFilter['group'],
          basis: basis.value as JournalFilter['basis'],
        };
        void this.loadJournal();
      },
      'button primary',
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      apply.click();
    });
    form.append(
      labelled('С даты', start),
      labelled('По дату', end),
      labelled('Точка', place),
      labelled('Статья', cat),
      labelled('Источник', source),
      labelled('Поиск', search),
      labelled('Группировка', group),
      labelled('Период', basis),
      apply,
    );
    area.append(form);
    const j = this.journal;
    if (!j) {
      area.append(el('div', 'notice', this.journalBusy ? 'Загружаю…' : 'Нажмите «Показать».'));
      return;
    }
    const head = el('div', 'expenses-toolbar');
    head.append(
      el(
        'strong',
        '',
        `Записей: ${j.entries.length}${j.truncated ? ' (показаны первые 2000)' : ''} · сумма ${tenge(j.total_minor)}`,
      ),
    );
    const add = button(
      'Добавить с контрагентом',
      () => this.openDialog(null, null),
      'button small',
    );
    add.disabled = !m.can.write;
    const xls = button(
      'Выгрузить в Excel',
      () =>
        download(`Журнал расходов ${f.start_date} - ${f.end_date}.csv`, [
          [
            'Дата',
            'Месяц ОПУ',
            'Точка',
            'Группа',
            'Статья',
            'Источник',
            'Сумма',
            'За месяц',
            'Контрагент',
            'Комментарий',
            'Автор',
            'Изменено',
          ],
          ...j.entries.map((e) => {
            const c = m.category(e.category);
            return [
              dayText(e.date),
              e.pl_month,
              m.locationName(e.location_id),
              meta.groups.find((g) => g.code === c?.group)?.name ?? '',
              c?.name ?? e.category,
              meta.sources.find((s) => s.code === e.source)?.name ?? e.source,
              excelAmount(e.amount_minor),
              e.monthly ? 'да' : '',
              e.counterparty,
              e.comment,
              e.author ?? '',
              e.updated_at
                ? new Date(e.updated_at).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })
                : '',
            ];
          }),
        ]),
      'button small',
    );
    head.append(add, xls);
    area.append(head);
    const scroll = el('div', 'table-scroll');
    const t = el('table', 'expenses-list');
    const h = el('tr');
    for (const v of [
      'Дата',
      'Месяц ОПУ',
      'Точка',
      'Статья',
      'Источник',
      'Сумма',
      'Контрагент',
      'Комментарий',
      'Автор',
    ])
      h.append(el('th', v === 'Сумма' ? 'num' : '', v));
    t.append(h);
    let current = '';
    for (const e of j.entries) {
      const g = f.group === 'date' ? e.date : e.pl_month;
      if (g !== current) {
        current = g;
        const groupSum = sum(
          j.entries
            .filter((x) => (f.group === 'date' ? x.date : x.pl_month) === g)
            .map((x) => x.amount_minor),
        );
        const gr = el('tr', 'expenses-group');
        const th = el(
          'th',
          '',
          `${f.group === 'date' ? dayText(g) : monthName(g)} · ${tenge(groupSum)}`,
        );
        th.colSpan = 9;
        gr.append(th);
        t.append(gr);
      }
      const tr = el('tr', 'expenses-clickable');
      tr.tabIndex = 0;
      tr.append(
        el('td', '', dayText(e.date) + (e.monthly ? ' (за месяц)' : '')),
        el('td', '', monthName(e.pl_month)),
        el('td', '', m.locationName(e.location_id)),
        el('td', '', m.category(e.category)?.name ?? e.category),
        el('td', '', meta.sources.find((s) => s.code === e.source)?.short ?? e.source),
        el('td', 'num', amountText(e.amount_minor)),
        el('td', '', e.counterparty),
        el('td', '', e.comment),
        el('td', '', e.author ?? ''),
      );
      const openIt = () => this.openDialog(e, null);
      tr.addEventListener('click', openIt);
      tr.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') openIt();
      });
      t.append(tr);
    }
    if (!j.entries.length) {
      const tr = el('tr');
      const td = el('td', 'empty', 'Записей нет.');
      td.colSpan = 9;
      tr.append(td);
      t.append(tr);
    }
    scroll.append(t);
    area.append(scroll);
    if (this.dialog) area.append(this.entryDialog());
  }

  // ---------------------------------------------------------------- «ОПУ»
  async loadPnl() {
    this.pnlBusy = true;
    this.changed();
    try {
      const f = this.pnlFilter;
      this.pnl = await this.m.read<Pnl>('pnl', {
        from: f.from,
        to: f.to,
        columns: f.columns,
        cogs: f.cogs,
        allocate: String(f.allocate),
      });
      this.m.error = '';
    } catch (e) {
      this.m.error = explain(e);
    } finally {
      this.pnlBusy = false;
      this.changed();
    }
  }
  private pnlTab(area: HTMLElement) {
    const m = this.m,
      meta = m.meta!,
      f = this.pnlFilter;
    const now = meta.today.slice(0, 7);
    const quick = el('div', 'expenses-toolbar');
    for (const [label, from, to] of [
      ['Этот месяц', now, now],
      ['Прошлый месяц', addMonths(now, -1), addMonths(now, -1)],
      ['3 месяца', addMonths(now, -2), now],
      ['С начала года', now.slice(0, 4) + '-01', now],
    ] as const) {
      const b = button(
        label,
        () => {
          this.pnlFilter = { ...f, from, to };
          void this.loadPnl();
        },
        f.from === from && f.to === to ? 'button small selected' : 'button small',
      );
      quick.append(b);
    }
    const from = input(f.from, { type: 'month', 'aria-label': 'С месяца' });
    const to = input(f.to, { type: 'month', 'aria-label': 'По месяц' });
    const show = button(
      'Показать',
      () => {
        if (!from.value || !to.value || from.value > to.value) return;
        this.pnlFilter = { ...f, from: from.value, to: to.value };
        void this.loadPnl();
      },
      'button small primary',
    );
    quick.append(labelled('С месяца', from), labelled('По месяц', to), show);
    area.append(quick);
    const opts = el('div', 'expenses-toolbar');
    const columns = choose(f.columns, [
      ['locations', 'Колонки: по точкам'],
      ['months', 'Колонки: по месяцам'],
    ]);
    columns.addEventListener('change', () => {
      this.pnlFilter = { ...f, columns: columns.value as PnlFilter['columns'] };
      void this.loadPnl();
    });
    const cogs = choose(f.cogs, [
      ['payments', 'Себестоимость: по оплатам поставщикам и цеху'],
      ['ttk', 'Себестоимость: по ТТК (проданное)'],
    ]);
    cogs.addEventListener('change', () => {
      this.pnlFilter = { ...f, cogs: cogs.value as PnlFilter['cogs'] };
      void this.loadPnl();
    });
    const allocate = el('label', 'check');
    const a = input('', { type: 'checkbox' });
    a.checked = f.allocate;
    a.disabled = f.columns !== 'locations';
    a.addEventListener('change', () => {
      this.pnlFilter = { ...f, allocate: a.checked };
      void this.loadPnl();
    });
    allocate.append(
      a,
      el('span', '', 'Разнести общие расходы компании по точкам (по доле выручки)'),
    );
    const pct = el('label', 'check');
    const p = input('', { type: 'checkbox' });
    p.checked = f.percent;
    p.addEventListener('change', () => {
      this.pnlFilter = { ...f, percent: p.checked };
      this.changed();
    });
    pct.append(p, el('span', '', 'Показывать % от выручки'));
    opts.append(columns, cogs, allocate, pct);
    area.append(opts);
    const r = this.pnl;
    if (!r) {
      area.append(el('div', 'notice', this.pnlBusy ? 'Считаю…' : 'Нет данных.'));
      return;
    }
    if (f.cogs === 'ttk' && !r.cogs_available)
      area.append(
        el(
          'div',
          'notice compact',
          'Себестоимости по ТТК за этот период нет: автосписание по техкартам ещё не работает. Строка показывает 0.',
        ),
      );
    if (r.unallocated_months.length)
      area.append(
        el(
          'div',
          'notice compact',
          `Нет выручки, общие расходы не разнесены: ${r.unallocated_months.map(monthName).join(', ')}.`,
        ),
      );
    const tiles = el('div', 'expenses-tiles');
    const tile = (label: string, value: string) => {
      const t = el('div', 'expenses-tile');
      t.append(el('small', '', label), el('strong', '', value));
      tiles.append(t);
    };
    const pc = (v: string) => (v ? v.replace('.', ',') + '%' : '-');
    tile('Выручка', tenge(r.tiles.revenue_minor));
    tile('Фудкост', pc(r.tiles.foodcost_percent ?? ''));
    tile('ФОТ', pc(r.tiles.payroll_percent ?? ''));
    tile('Аренда', pc(r.tiles.rent_percent ?? ''));
    tile('Себестоимость и расходы', tenge(r.tiles.expenses_minor));
    tile('EBITDA', tenge(r.tiles.ebitda_minor));
    tile('Рентабельность', pc(r.tiles.margin_percent ?? ''));
    area.append(tiles);
    const colName = (c: string) =>
      c === 'total'
        ? 'Итого'
        : c === 'company'
          ? 'Общие'
          : f.columns === 'months'
            ? monthName(c)
            : m.locationName(c);
    const scroll = el('div', 'table-scroll');
    const t = el('table', 'expenses-pnl');
    const h = el('tr');
    h.append(el('th', '', 'Статья'));
    for (const c of r.columns) h.append(el('th', 'num', colName(c)));
    t.append(h);
    const revenue = r.lines.find((l) => l.key === 'revenue')!;
    for (const line of r.lines) {
      const tr = el('tr', 'pnl-' + line.kind);
      tr.append(el('th', '', line.label));
      for (const c of r.columns) {
        const td = el('td', 'num');
        const v = line.values[c] ?? '0';
        if (line.kind === 'percent') td.textContent = v ? v.replace('.', ',') + '%' : '-';
        else {
          const amount = el(
            line.categories && v !== '0' ? 'button' : 'span',
            'pnl-amount',
            v === '0' ? '-' : amountText(v),
          );
          if (amount instanceof HTMLButtonElement) {
            amount.type = 'button';
            amount.title = 'Открыть записи';
            amount.addEventListener('click', () => this.drill(line.categories!, c));
          }
          td.append(amount);
          if (f.percent && line.kind !== 'reference' && line.key !== 'revenue') {
            const share = percentOf(v, revenue.values[c] ?? '0');
            if (share) td.append(el('small', 'pnl-share', share));
          }
        }
        tr.append(td);
      }
      t.append(tr);
    }
    scroll.append(t);
    area.append(scroll);
    area.append(
      button(
        'Выгрузить ОПУ в Excel',
        () => {
          download(`ОПУ ${f.from} - ${f.to}.csv`, [
            ['Статья', ...r.columns.map(colName)],
            ...r.lines.map((l) => [
              l.label,
              ...r.columns.map((c) =>
                l.kind === 'percent'
                  ? (l.values[c] ?? '').replace('.', ',')
                  : excelAmount(l.values[c]),
              ),
            ]),
          ]);
        },
        'button small',
      ),
    );
    area.append(el('h3', '', 'Фудкост по блюдам'));
    if (!r.dishes.length)
      area.append(
        el(
          'p',
          'muted',
          'Данных по блюдам нет: нужны продажи с кассы и автосписание по техкартам.',
        ),
      );
    else {
      const dt = el('table', 'expenses-list');
      const dh = el('tr');
      for (const v of ['Блюдо', 'Выручка', 'Себестоимость по ТТК', 'Фудкост'])
        dh.append(el('th', v === 'Блюдо' ? '' : 'num', v));
      dt.append(dh);
      for (const d of r.dishes) {
        const tr = el('tr');
        tr.append(
          el('td', '', d.name),
          el('td', 'num', amountText(d.revenue_minor)),
          el('td', 'num', amountText(d.cogs_minor)),
          el('td', 'num', d.foodcost_percent ? d.foodcost_percent.replace('.', ',') + '%' : '-'),
        );
        dt.append(tr);
      }
      const ds = el('div', 'table-scroll');
      ds.append(dt);
      area.append(ds);
    }
  }
  /** A click on an amount of the P&L: the records it was made of, by the P&L month. */
  private drill(categories: string[], column: string) {
    const f = this.pnlFilter;
    const months = f.columns === 'months' && column !== 'total' ? [column, column] : [f.from, f.to];
    this.journalFilter = {
      ...this.journalFilter,
      start_date: months[0] + '-01',
      end_date: addDays(addMonths(months[1]!, 1) + '-01', -1),
      location: f.columns === 'locations' && column !== 'total' ? column : 'all',
      category: categories.join(','),
      source: '',
      search: '',
      basis: 'pl_month',
      group: 'pl_month',
    };
    if (f.allocate && f.columns === 'locations')
      this.notice =
        'Общие расходы, разнесённые на точку, в журнале видны в «Общие расходы компании».';
    this.m.tab = 'journal';
    void this.loadJournal();
  }

  // ---------------------------------------------------------------- «Аналитика»
  async loadAnalytics() {
    try {
      this.analytics = await this.m.read<Analytics>('analytics', this.analyticsRange);
      this.m.error = '';
    } catch (e) {
      this.m.error = explain(e);
    }
    this.changed();
  }
  private analyticsTab(area: HTMLElement) {
    const m = this.m,
      meta = m.meta!;
    const bar = el('div', 'expenses-toolbar');
    const from = input(this.analyticsRange.from, { type: 'month' });
    const to = input(this.analyticsRange.to, { type: 'month' });
    bar.append(
      labelled('С месяца', from),
      labelled('По месяц', to),
      button(
        'Показать',
        () => {
          if (!from.value || !to.value || from.value > to.value) return;
          this.analyticsRange = { from: from.value, to: to.value };
          void this.loadAnalytics();
        },
        'button small primary',
      ),
    );
    area.append(bar);
    const a = this.analytics;
    if (!a) {
      area.append(el('div', 'notice', 'Загружаю…'));
      return;
    }
    const SERIES: [string, string][] = [
      ['cogs', 'Себестоимость'],
      ['payroll', 'ФОТ'],
      ['location', 'Расходы на точку'],
      ['commissions', 'Комиссии'],
      ['other', 'Прочее'],
    ];
    area.append(el('h3', '', 'Динамика расходов по месяцам'));
    const max = a.series.reduce((x, s) => {
      const total = SERIES.reduce((t, [k]) => t + BigInt(s[k] ?? '0'), 0n);
      return total > x ? total : x;
    }, 1n);
    const chart = el('div', 'expenses-chart');
    for (const s of a.series) {
      const col = el('div', 'expenses-chart-col');
      const stack = el('div', 'expenses-chart-stack');
      for (const [k, label] of SERIES) {
        const v = BigInt(s[k] ?? '0');
        if (v <= 0n) continue;
        const seg = el('span', 'series-' + k);
        seg.style.height = `${Number((v * 1000n) / max) / 10}%`;
        seg.title = `${label}: ${tenge(String(v))}`;
        stack.append(seg);
      }
      col.append(stack, el('small', '', monthName(s.month!).replace(/ \d+$/, '')));
      chart.append(col);
    }
    area.append(chart);
    const legend = el('div', 'expenses-legend');
    for (const [k, label] of SERIES) {
      const i = el('span');
      i.append(el('i', 'series-' + k), document.createTextNode(label));
      legend.append(i);
    }
    area.append(legend);
    const st = el('table', 'expenses-list');
    const sh = el('tr');
    sh.append(el('th', '', 'Месяц'));
    for (const [, label] of SERIES) sh.append(el('th', 'num', label));
    st.append(sh);
    for (const s of a.series) {
      const tr = el('tr');
      tr.append(el('td', '', monthName(s.month!)));
      for (const [k] of SERIES) tr.append(el('td', 'num', amountText(s[k] ?? '0') || '-'));
      st.append(tr);
    }
    area.append(st);
    area.append(el('h3', '', 'Структура расходов по статьям'));
    const total = sum(a.structure.map((s) => s.amount_minor));
    const bars = el('div', 'expenses-bars');
    for (const s of a.structure.slice(0, 15)) {
      const row = el('div', 'expenses-bar');
      const fill = el('span');
      fill.style.width =
        total !== '0'
          ? `${Math.max(0, Number((BigInt(s.amount_minor) * 1000n) / BigInt(total)) / 10)}%`
          : '0';
      row.append(
        el('span', 'label', m.category(s.category)?.name ?? s.category),
        el('span', 'track'),
        el('span', 'value', `${tenge(s.amount_minor)} · ${percentOf(s.amount_minor, total)}`),
      );
      row.querySelector('.track')!.append(fill);
      bars.append(row);
    }
    if (!a.structure.length) bars.append(el('p', 'muted', 'Расходов за период нет.'));
    area.append(bars);
    area.append(el('h3', '', 'Сравнение точек'));
    const ct = el('table', 'expenses-list');
    const chh = el('tr');
    for (const v of ['Точка', 'Выручка', 'Себестоимость', 'Расходы', 'EBITDA', 'Рентабельность'])
      chh.append(el('th', v === 'Точка' ? '' : 'num', v));
    ct.append(chh);
    for (const c of a.compare) {
      const tr = el('tr');
      tr.append(
        el('td', '', m.locationName(c.location === 'company' ? null : c.location!)),
        el('td', 'num', amountText(c.revenue_minor!) || '-'),
        el('td', 'num', amountText(c.cogs_minor!) || '-'),
        el('td', 'num', amountText(c.expenses_minor!) || '-'),
        el('td', 'num', amountText(c.ebitda_minor!) || '-'),
        el('td', 'num', c.margin_percent ? c.margin_percent.replace('.', ',') + '%' : '-'),
      );
      ct.append(tr);
    }
    area.append(ct);
    area.append(el('h3', '', `Движение денег по источникам за ${monthName(a.sources_month)}`));
    const mt = el('table', 'expenses-list');
    const mh = el('tr');
    for (const v of ['Источник', 'Поступления', 'Расходы', 'Снятие со счёта', 'Инкассация'])
      mh.append(el('th', v === 'Источник' ? '' : 'num', v));
    mt.append(mh);
    for (const s of a.sources) {
      const tr = el('tr');
      tr.append(
        el('td', '', meta.sources.find((x) => x.code === s.source)?.name ?? s.source!),
        el('td', 'num', amountText(s.income_minor!) || '-'),
        el('td', 'num', amountText(s.expenses_minor!) || '-'),
        el('td', 'num', amountText(s.withdrawal_minor!) || '-'),
        el('td', 'num', amountText(s.collection_minor!) || '-'),
      );
      mt.append(tr);
    }
    area.append(mt);
  }

  // ---------------------------------------------------------------- «Месяцы и доступ»
  async loadMonths() {
    try {
      await this.m.reloadMeta();
      if (this.m.meta?.role === 'director') this.access = await this.m.readPlain<Access>('access');
      this.log = (await this.m.read<{ actions: LogRow[] }>('log', { page: '0' })).actions;
      this.m.error = '';
    } catch (e) {
      this.m.error = explain(e);
    }
    this.changed();
  }
  private monthsTab(area: HTMLElement) {
    const m = this.m,
      meta = m.meta!;
    area.append(el('h3', '', 'Закрытие месяцев'));
    area.append(
      el(
        'p',
        'muted',
        'В закрытом месяце нельзя добавлять, менять и удалять записи и кассу. Закрывать и открывать месяц может только руководитель.',
      ),
    );
    const t = el('table', 'expenses-list');
    const h = el('tr');
    for (const v of ['Месяц', 'Состояние', '']) h.append(el('th', '', v));
    t.append(h);
    const now = meta.today.slice(0, 7);
    for (let i = 0; i < 12; i++) {
      const month = addMonths(now, -i);
      const closed = meta.closed_months.find((c) => c.month === month);
      const tr = el('tr');
      tr.append(
        el('td', '', monthName(month)),
        el(
          'td',
          closed ? 'closed' : '',
          closed
            ? `Закрыт · ${closed.closed_by}, ${new Date(closed.closed_at).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}`
            : 'Открыт',
        ),
      );
      const td = el('td');
      if (m.can.close) {
        const b = button(
          closed ? 'Открыть' : 'Закрыть',
          async () => {
            if (
              !window.confirm(
                closed
                  ? `Открыть ${monthName(month)}? Записи снова можно будет менять.`
                  : `Закрыть ${monthName(month)}? Записи и касса станут только для просмотра.`,
              )
            )
              return;
            const error = await m.write(
              `expenses/months/${month}/${closed ? 'open' : 'close'}`,
              {},
              false,
            );
            this.notice =
              error || (closed ? `${monthName(month)} открыт.` : `${monthName(month)} закрыт.`);
            await this.loadMonths();
          },
          closed ? 'button small' : 'button small primary',
        );
        b.dataset.testid = `expenses-month-${month}`;
        td.append(b);
      }
      tr.append(td);
      t.append(tr);
    }
    area.append(t);
    if (m.meta?.role === 'director') {
      area.append(el('h3', '', 'Доступ к разделу'));
      area.append(
        el(
          'p',
          'muted',
          'Руководитель закрывает месяцы и выдаёт доступ. Финансист и экономист вносят и меняют записи. Просмотр только читает.',
        ),
      );
      const at = el('table', 'expenses-list');
      for (const p of this.access?.people ?? []) {
        const tr = el('tr');
        const role = choose(
          p.role ?? '',
          [
            ['', 'Нет доступа'],
            ...Object.entries(ROLES).map(([k, v]) => [k, v] as [string, string]),
          ],
          { 'aria-label': `Доступ: ${p.name}` },
        );
        role.addEventListener('change', async () => {
          const error = await m.write(
            'expenses/access',
            { actor_id: p.actor_id, role: role.value || null },
            false,
          );
          this.notice = error || `Доступ сотрудника «${p.name}» изменён.`;
          await this.loadMonths();
        });
        tr.append(el('td', '', p.name), el('td', '', ''));
        tr.lastElementChild!.append(role);
        at.append(tr);
      }
      area.append(at);
    }
    area.append(el('h3', '', 'Журнал действий'));
    const lt = el('table', 'expenses-list');
    const lh = el('tr');
    for (const v of ['Когда', 'Кто', 'Действие', 'Точка', 'Дата', 'Подробно'])
      lh.append(el('th', '', v));
    lt.append(lh);
    for (const l of this.log ?? []) {
      const tr = el('tr');
      tr.append(
        el('td', '', new Date(l.created_at).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })),
        el('td', '', l.author),
        el('td', '', ACTIONS[l.action] ?? l.action),
        el(
          'td',
          '',
          l.action.startsWith('month') || l.action === 'access'
            ? ''
            : m.locationName(l.location_id),
        ),
        el('td', '', l.date ? dayText(l.date.slice(0, 10)) : ''),
        el('td', 'muted', this.describe(l)),
      );
      lt.append(tr);
    }
    if (!this.log?.length) {
      const tr = el('tr');
      const td = el('td', 'empty', 'Действий пока нет.');
      td.colSpan = 6;
      tr.append(td);
      lt.append(tr);
    }
    const ls = el('div', 'table-scroll');
    ls.append(lt);
    area.append(ls);
  }
  private describe(l: LogRow) {
    const v = (l.after_value ?? l.before_value) as Record<string, unknown> | null;
    if (!v) return '';
    if (l.action.startsWith('entry')) {
      const before = l.before_value as Record<string, string> | null;
      const after = l.after_value as Record<string, string> | null;
      const c = this.m.category(String(v['category']))?.name ?? String(v['category']);
      const amount = (x: Record<string, string> | null) =>
        x ? amountText(x['amount_minor']) : '-';
      return l.action === 'entry.update'
        ? `${c}: ${amount(before)} → ${amount(after)}`
        : `${c}: ${amount(after ?? before)}`;
    }
    if (l.action === 'access') return `${ROLES[String(v['role'])] ?? 'Нет доступа'}`;
    if (l.action === 'cash')
      return `по отчёту кассира ${amountText((v['counted_minor'] as string) ?? null) || '-'}`;
    if (l.action === 'row')
      return `месяц ОПУ ${String(v['pl_month'] ?? '')}${v['comment'] ? ', ' + String(v['comment']) : ''}`;
    return '';
  }
}
const key0 = (place: Place, category: string, what: string) =>
  `${place.id ?? 'company'}|${category}|${what}`;
