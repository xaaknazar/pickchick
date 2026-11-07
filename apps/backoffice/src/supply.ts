import { element as el, button, field, select, check } from './dom.js';
import { ApiError, message } from './api.js';
import { almatyDateTime, labelledCards, tenge } from './ui-fixes.js';
import { displayQuantity, supplierKindLabel } from './inventory-model.js';
import { salesCsvText } from './sales-report-model.js';
import {
  guard,
  mayClose,
  readDraft,
  sessionStore,
  settle,
  writeDraft,
  dropDraft,
} from './dialog-guard.js';
import {
  LINES_MAX,
  NAME_MAX,
  NOTE_MAX,
  RECEIVE_ERRORS,
  REQUEST_KINDS,
  REQUEST_KIND_LABELS,
  REQUEST_STATES,
  REQUEST_STATE_LABELS,
  SUPPLIER_KINDS,
  SUPPLIER_KIND_LABELS,
  SUPPLY_BANNER,
  SUPPLY_ERRORS,
  UNIT_LABELS,
  WINDOW_DAYS,
  IMPORT_ISSUE_LABELS,
  belowMinimumLines,
  cancelCommand,
  differenceText,
  dmy,
  emptyRequestForm,
  hintOf,
  importCountRows,
  importStateText,
  importTitle,
  lineEstimate,
  linesText,
  partial,
  priceSaveCommand,
  pricePayload,
  priceText,
  priceUnits,
  pricesInForce,
  receiveCommand,
  receiveFormOf,
  receivePreview,
  requestActions,
  requestFormOf,
  requestIngredients,
  requestPayload,
  requestSaveCommand,
  requestStateText,
  requestsCsv,
  shiftDay,
  stateClass,
  submitCommand,
  supplierKindFor,
  supplierPayload,
  supplierSaveCommand,
  tengeInput,
  totalText,
  type PriceForm,
  type ReceiveForm,
  type RequestForm,
  type RequestKind,
  type Supplier,
  type SupplierKind,
  type SupplierImportsView,
  type SupplierPrice,
  type SuppliersView,
  type SupplyDifference,
  type SupplyRequest,
  type SupplyRequestsView,
} from './supply-model.js';

type Data = Record<string, unknown>;
export type RequestsQuery = {
  start_date: string;
  end_date: string;
  state?: string;
  kind?: string;
  id?: string;
};
/**
 * What app.ts hands to «Закупки» (lane bo-ui2 step 2). `execute` sends one command with its
 * reason and answers null on success or the error itself (the page says it in words).
 */
export type SupplyCallbacks = {
  suppliers: (id?: string) => Promise<SuppliersView>;
  requests: (q: RequestsQuery) => Promise<SupplyRequestsView>;
  /** Step 3: the price imports, the newest (or `id`) with its report. */
  imports: (id?: string) => Promise<SupplierImportsView>;
  execute: (command: Data, reason: string) => Promise<unknown>;
  can: (permission: string) => boolean;
  rights: (permission: string) => string | null;
  /** The stock rows of the page snapshot (balances, minimums and their revisions). */
  stock: () => Data[];
  /** Reload the page snapshot: fresh balances after a CONFLICT of a receipt. */
  refreshStock: () => Promise<void>;
  /** actor:branch, the key of the editor drafts of this person and branch. */
  scope: () => string;
  changed: () => void;
};
const DRAFT = 'pickchick.backoffice.supply.v1';
/** A supply command error in words: the supply reasons first, then the cabinet's text. */
export function supplyErrorText(error: unknown, rights?: string | null): string {
  if (error instanceof ApiError) {
    if (error.reason === 'ROLE_FORBIDDEN' && rights) return rights;
    const precise = error.reason ? SUPPLY_ERRORS[error.reason] : undefined;
    if (precise) return precise;
    if (!error.reason && SUPPLY_ERRORS[error.code]) return SUPPLY_ERRORS[error.code]!;
  }
  return message(error);
}
const almatyToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date());

function dialog(title: string, sub: string, testId: string) {
  const d = el('dialog', 'op-dialog sp-dialog'),
    head = el('div', 'panel-head'),
    close = button(
      'Закрыть',
      () => {
        if (!mayClose(d)) return;
        d.close();
        d.remove();
      },
      'button subtle',
      'sp-close',
    );
  d.dataset.testid = testId;
  head.append(el('h2', '', title), close);
  d.append(head);
  if (sub) d.append(el('p', 'op-note', sub));
  document.body.append(d);
  d.showModal();
  d.addEventListener('close', () => d.remove(), { once: true });
  return d;
}
function table(head: readonly string[], rows: (string | Node)[][], empty: string, testId = '') {
  const wrap = el('div', 'inventory-table'),
    t = el('table', 'op-table'),
    h = el('thead'),
    tr = el('tr');
  for (const text of head) {
    const th = el('th', '', text);
    th.scope = 'col';
    tr.append(th);
  }
  h.append(tr);
  const body = el('tbody');
  for (const cells of rows) {
    const row = el('tr');
    for (const cell of cells) {
      const td = el('td');
      td.append(cell);
      row.append(td);
    }
    body.append(row);
  }
  t.append(h, body);
  wrap.append(t);
  if (testId) wrap.dataset.testid = testId;
  if (!rows.length) wrap.append(el('p', 'op-note', empty));
  return labelledCards(wrap, head);
}
function errorBox() {
  const error = el('div', 'notice error op-form-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const show = (lines: string[]) => {
    error.replaceChildren(...lines.map((line) => el('p', '', line)));
    error.hidden = !lines.length;
  };
  return { error, show };
}
function reasonField(value: string, set: (v: string) => void, id: string) {
  return field('Причина или комментарий для журнала', value, set, {
    id,
    max: 500,
    required: true,
  });
}
const REASON_SHORT = 'Укажите причину или комментарий: минимум 3 символа.';
/** A button the role cannot use: disabled, with the reason in words next to it (`noteId`). */
function denied(label: string, why: string, testId: string, noteId = testId + '-why') {
  const b = button(label, () => undefined, 'button subtle', testId);
  b.disabled = true;
  b.title = why;
  b.setAttribute('aria-describedby', noteId);
  return b;
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
async function copyText(text: string, area: HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    area.focus();
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}
/** The print sheet of a request (only it is printed: workforce.css @media print). */
function printRequest(r: SupplyRequest) {
  document.querySelector('.sp-print-root')?.remove();
  const root = el('div', 'sp-print-root');
  root.dataset.testid = 'sp-print-root';
  root.append(
    el('h1', '', `Заявка № ${r.number} - ${REQUEST_KIND_LABELS[r.kind]}`),
    el(
      'p',
      '',
      `Создана ${almatyDateTime(r.created_at)}${r.created_by_name ? ', ' + r.created_by_name : ''}`,
    ),
    el('p', '', `Нужно к: ${dmy(r.needed_by)}`),
    ...(r.supplier ? [el('p', '', `Поставщик: ${r.supplier.name}`)] : []),
    ...(r.note ? [el('p', '', `Примечание: ${r.note}`)] : []),
    el('p', '', `Состояние: ${REQUEST_STATE_LABELS[r.state]}`),
  );
  const t = el('table');
  const head = el('tr');
  for (const h of ['№', 'Позиция', 'Количество', 'Получено']) head.append(el('th', '', h));
  t.append(head);
  r.lines.forEach((l, i) => {
    const row = el('tr');
    for (const cell of [String(i + 1), l.name ?? 'Позиция', displayQuantity(l.qty, l.unit), ''])
      row.append(el('td', '', cell));
    t.append(row);
  });
  root.append(t, el('p', '', 'Принял: ____________________   Подпись: __________'));
  document.body.append(root);
  document.documentElement.classList.add('sp-printing');
  const done = () => {
    document.documentElement.classList.remove('sp-printing');
    root.remove();
  };
  window.addEventListener('afterprint', done, { once: true });
  window.print();
  // Browsers that print without the event (or a cancelled print) leave nothing behind.
  setTimeout(() => {
    if (document.documentElement.classList.contains('sp-printing')) done();
  }, 60000);
}

/**
 * «Закупки» (design-bo-ui §9.4; design-backoffice Ск6, Ск3): «Заявки» - the list by state, kind
 * and dates, the editor of a draft with the balance and the hint «минимум - остаток» per line and,
 * for a supplier, the price in force, submission, cancellation with a reason, the receipt by a
 * request (the stock v2 receipt prefilled from the request, the difference shown), print and
 * «Скопировать текст»; «Поставщики» - the directory (create, edit, archive) and the prices with
 * their history. Who may do what comes from permissions[]; a missing action is a disabled button
 * with the reason in words. Loads its own views.
 */
export class SupplyPage {
  private tab: 'requests' | 'suppliers' = 'requests';
  private start = shiftDay(almatyToday(), -13);
  private end = almatyToday();
  private state = '';
  private kind = '';
  private requests: SupplyRequestsView | null = null;
  private suppliersList: SuppliersView | null = null;
  /** Step 3: the price imports; `importsMissing` - an older server without the view. */
  private imports: SupplierImportsView | null = null;
  private importsMissing = false;
  private importsError = '';
  private importCode = '';
  private error = '';
  private loading = false;
  private loadedFor = '';
  constructor(private cb: SupplyCallbacks) {}
  clear() {
    this.requests = null;
    this.suppliersList = null;
    this.imports = null;
    this.importsMissing = false;
    this.importsError = '';
    this.importCode = '';
    this.error = '';
    this.loadedFor = '';
    this.tab = 'requests';
    this.state = '';
    this.kind = '';
    this.start = shiftDay(almatyToday(), -13);
    this.end = almatyToday();
  }
  private query(extra: Partial<RequestsQuery> = {}): RequestsQuery {
    return {
      start_date: this.start,
      end_date: this.end,
      ...(this.state ? { state: this.state } : {}),
      ...(this.kind ? { kind: this.kind } : {}),
      ...extra,
    };
  }
  async reload() {
    this.loading = true;
    this.cb.changed();
    try {
      const [requests, suppliers] = await Promise.all([
        this.cb.requests(this.query()),
        this.cb.suppliers(),
        this.loadImports(),
      ]);
      this.requests = requests;
      this.suppliersList = suppliers;
      this.error = '';
    } catch (e) {
      this.error =
        e instanceof ApiError && e.code === 'INVALID_REQUEST'
          ? `Проверьте даты: период - не больше ${WINDOW_DAYS} дней, начало не позже конца.`
          : 'Закупки не загрузились. Проверьте связь и нажмите «Обновить».';
    } finally {
      this.loading = false;
      this.cb.changed();
    }
  }
  /**
   * The price imports (step 3). An older server answers 404: the block is not shown; any other
   * failure is said in words and does not stop the rest of the page.
   */
  private async loadImports(id?: string) {
    try {
      this.imports = await this.cb.imports(id);
      this.importsMissing = false;
      this.importsError = '';
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NOT_FOUND' && !id) this.importsMissing = true;
      else this.importsError = 'Импорты цен не загрузились. Нажмите «Обновить».';
    }
  }
  render(host: HTMLElement) {
    const scope = this.cb.scope();
    if (this.loadedFor !== scope && !this.loading) {
      this.loadedFor = scope;
      void this.reload();
    }
    const p = el('section', 'panel supply');
    p.dataset.testid = 'supply';
    const head = el('div', 'panel-head');
    head.append(el('h2', '', 'Закупки'));
    const tools = el('div', 'op-actions');
    tools.append(button('Обновить', () => void this.reload(), 'button subtle', 'sp-refresh'));
    head.append(tools);
    p.append(head);
    const tabs = el('nav', 'inventory-tabs sp-tabs');
    tabs.setAttribute('aria-label', 'Разделы закупок');
    for (const [key, label] of [
      ['requests', 'Заявки'],
      ['suppliers', 'Поставщики и цены'],
    ] as const) {
      const b = button(
        label,
        () => {
          this.tab = key;
          this.cb.changed();
        },
        'button' + (this.tab === key ? ' selected' : ''),
        'sp-tab-' + key,
      );
      b.setAttribute('aria-pressed', String(this.tab === key));
      tabs.append(b);
    }
    p.append(tabs);
    host.append(p);
    if (this.error) {
      const e = el('p', 'notice error', this.error);
      e.setAttribute('role', 'alert');
      p.append(e);
    }
    if (this.tab === 'requests') this.renderRequests(p);
    else this.renderSuppliers(p);
  }

  // ------------------------------------------------------------------------- requests ----

  private renderRequests(p: HTMLElement) {
    const banner = el('p', 'notice sp-banner', SUPPLY_BANNER);
    banner.setAttribute('role', 'status');
    banner.dataset.testid = 'sp-banner';
    p.append(banner);
    const write = this.cb.can('supply.write');
    const bar = el('div', 'sp-bar');
    bar.append(
      field('С', this.start, (v) => (this.start = v), { id: 'sp-start', type: 'date' }),
      field('По', this.end, (v) => (this.end = v), { id: 'sp-end', type: 'date' }),
      select(
        'Состояние',
        this.state,
        [
          { value: '', label: 'Все' },
          ...REQUEST_STATES.map((s) => ({ value: s, label: REQUEST_STATE_LABELS[s] })),
        ],
        (v) => (this.state = v),
        'sp-state-filter',
      ),
      select(
        'Куда',
        this.kind,
        [
          { value: '', label: 'Все' },
          ...REQUEST_KINDS.map((k) => ({ value: k, label: REQUEST_KIND_LABELS[k] })),
        ],
        (v) => (this.kind = v),
        'sp-kind-filter',
      ),
      button('Показать', () => void this.reload(), 'button', 'sp-show'),
    );
    const actions = el('div', 'op-actions sp-list-actions');
    if (write)
      actions.append(
        button('Новая заявка', () => this.editRequest(null), 'button primary', 'sp-new'),
      );
    else {
      const why = this.cb.rights('supply.write') ?? 'Заявки создают управляющий и начальник смены.';
      actions.append(denied('Новая заявка', why, 'sp-new'));
      const n = el('p', 'op-note sp-rights', why);
      n.id = 'sp-new-why';
      n.dataset.testid = 'sp-rights';
      actions.append(n);
    }
    const v = this.requests;
    if (v?.requests.length)
      actions.append(
        button(
          'Скачать CSV',
          () => download(`zayavki-${v.start_date}-${v.end_date}.csv`, requestsCsv(v)),
          'button subtle',
          'sp-csv',
        ),
      );
    p.append(bar, actions);
    if (!v) {
      p.append(el('p', 'op-note', this.loading ? 'Загружаем заявки...' : ''));
      return;
    }
    const counts = el(
      'p',
      'op-note sp-counts',
      REQUEST_STATES.map((s) => `${REQUEST_STATE_LABELS[s]}: ${v.counts[s] ?? 0}`).join(' · '),
    );
    counts.dataset.testid = 'sp-counts';
    p.append(counts);
    const outside =
      v.open.draft + v.open.submitted - (v.counts.draft ?? 0) - (v.counts.submitted ?? 0);
    if (outside > 0 && !this.kind) {
      const n = el(
        'p',
        'notice',
        `Есть открытые заявки вне выбранного периода: ${outside}. Расширьте период, чтобы их увидеть.`,
      );
      n.dataset.testid = 'sp-open-outside';
      p.append(n);
    }
    const rows = v.requests.map((r) => {
      const state = el('span', stateClass(r.state), requestStateText(r, v.today));
      state.dataset.testid = 'sp-state';
      const open = button('Открыть', () => void this.openRequest(r.id), 'button subtle', 'sp-open');
      open.setAttribute('aria-label', `Открыть заявку № ${r.number}`);
      return [
        `№ ${r.number}`,
        `${REQUEST_KIND_LABELS[r.kind]}${r.supplier ? ': ' + r.supplier.name : ''}`,
        dmy(r.needed_by),
        linesText(r),
        totalText(r),
        state,
        open,
      ];
    });
    p.append(
      table(
        ['Заявка', 'Куда', 'Нужно к', 'Позиции', 'Сумма по ценам', 'Состояние', ''],
        rows,
        'Заявок за этот период нет.',
        'sp-requests',
      ),
    );
    if (v.truncated.requests)
      p.append(el('p', 'op-note', 'Показаны последние 200 заявок периода. Сузьте период.'));
  }
  private async loadRequest(id: string): Promise<SupplyRequestsView> {
    return this.cb.requests(this.query({ id }));
  }
  /** The card of one request: lines, state, receipt, text, print and the actions of the role. */
  private async openRequest(id: string) {
    const box = dialog('Заявка', '', 'sp-request');
    const body = el('div', 'sp-request-body');
    body.append(el('p', 'op-note', 'Загружаем заявку...'));
    box.append(body);
    const draw = async () => {
      let v: SupplyRequestsView;
      try {
        v = await this.loadRequest(id);
      } catch (e) {
        body.replaceChildren(el('p', 'notice error', supplyErrorText(e)));
        return;
      }
      const r = v.request!;
      box.querySelector('h2')!.textContent =
        `Заявка № ${r.number} - ${REQUEST_KIND_LABELS[r.kind]}`;
      body.replaceChildren();
      const state = el('span', stateClass(r.state), requestStateText(r, v.today));
      state.dataset.testid = 'sp-request-state';
      const info = el('dl', 'sp-info');
      const item = (k: string, value: string | Node) => {
        const dd = el('dd');
        dd.append(value);
        info.append(el('dt', '', k), dd);
      };
      item('Состояние', state);
      item('Нужно к', dmy(r.needed_by));
      if (r.supplier)
        item('Поставщик', `${r.supplier.name}${r.supplier.active ? '' : ' (в архиве)'}`);
      if (r.note) item('Примечание', r.note);
      item(
        'Создана',
        `${almatyDateTime(r.created_at)}${r.created_by_name ? ', ' + r.created_by_name : ''}`,
      );
      if (r.submitted_at)
        item(
          'Подана',
          `${almatyDateTime(r.submitted_at)}${r.submitted_by_name ? ', ' + r.submitted_by_name : ''}`,
        );
      if (r.closed_at)
        item(
          r.state === 'received' ? 'Принята' : 'Отменена',
          `${almatyDateTime(r.closed_at)}${r.closed_by_name ? ', ' + r.closed_by_name : ''}`,
        );
      if (r.cancel_reason) item('Причина отмены', r.cancel_reason);
      body.append(info);
      body.append(
        el(
          'p',
          'op-note',
          r.state === 'draft'
            ? 'Черновик: остаток и подсказка обновятся в момент подачи.'
            : 'Остаток и подсказка - на момент подачи заявки.',
        ),
      );
      body.append(
        table(
          ['Позиция', 'Количество', 'Остаток при заявке', 'Подсказка', 'Ожидаемая сумма'],
          r.lines.map((l) => [
            l.name ?? 'Позиция',
            displayQuantity(l.qty, l.unit),
            displayQuantity(l.balance_at_request, l.unit),
            l.hint === null ? 'Нет минимума' : displayQuantity(l.hint, l.unit),
            l.price_minor === null ? (r.supplier ? 'Нет цены' : '-') : tenge(l.price_minor),
          ]),
          'Строк нет.',
          'sp-request-lines',
        ),
      );
      const total = el(
        'p',
        'sp-total',
        r.supplier
          ? `Сумма по ценам поставщика: ${totalText(r)}`
          : 'Заявка без поставщика: сумма по ценам не считается.',
      );
      total.dataset.testid = 'sp-request-total';
      body.append(total);
      if (v.receipt) {
        const rc = v.receipt;
        const n = el(
          'p',
          'notice',
          `Поставка проведена: накладная ${rc.reference}${rc.document_date ? ' от ' + dmy(rc.document_date) : ''}, сумма ${tenge(rc.total_minor)}${rc.actor_name ? ', ' + rc.actor_name : ''}.`,
        );
        n.dataset.testid = 'sp-receipt';
        body.append(n);
        if (v.difference) body.append(this.differenceTable(v.difference));
      }
      // Print and copy: the system sends nothing.
      const text = el('textarea', 'sp-text');
      text.readOnly = true;
      text.rows = Math.min(14, (v.text ?? '').split('\n').length + 1);
      text.value = v.text ?? '';
      text.dataset.testid = 'sp-text';
      text.setAttribute('aria-label', 'Текст заявки');
      const copied = el('p', 'op-note', '');
      copied.setAttribute('role', 'status');
      copied.dataset.testid = 'sp-copied';
      const share = el('div', 'op-actions sp-share');
      share.append(
        button(
          'Скопировать текст',
          () =>
            void copyText(text.value, text).then((ok) => {
              copied.textContent = ok
                ? 'Текст скопирован. Отправьте его в мессенджере вручную: система сама ничего не отправляет.'
                : 'Скопировать автоматически не получилось: выделите текст и скопируйте его вручную.';
            }),
          'button',
          'sp-copy',
        ),
        button('Печать', () => printRequest(r), 'button subtle', 'sp-print'),
      );
      body.append(el('h3', '', 'Текст для отправки'), text, share, copied);
      // The actions of this state; the ones the role lacks are disabled with the reason.
      const can = requestActions(r);
      const acts = el('div', 'op-actions sp-request-actions');
      // One note per reason; every disabled button points at the note with its reason.
      const why = new Map<string, string>();
      const add = (
        show: boolean,
        permission: string[],
        label: string,
        testId: string,
        run: () => void,
        cls = 'button',
      ) => {
        if (!show) return;
        const missing = permission.find((x) => !this.cb.can(x));
        if (!missing) acts.append(button(label, run, cls, testId));
        else {
          const text = this.cb.rights(missing) ?? 'Для вашей роли это действие недоступно.';
          if (!why.has(text)) why.set(text, testId + '-why');
          acts.append(denied(label, text, testId, why.get(text)));
        }
      };
      add(can.edit, ['supply.write'], 'Изменить', 'sp-edit', () => {
        box.close();
        this.editRequest(r);
      });
      add(
        can.submit,
        ['supply.write'],
        'Подать',
        'sp-submit',
        () => this.submitDialog(r, draw),
        'button primary',
      );
      add(
        can.receive,
        ['supply.close', 'stock.receipt'],
        'Принять поставку',
        'sp-receive',
        () => this.receiveDialog(r, draw),
        'button primary',
      );
      add(
        can.cancel,
        ['supply.close'],
        'Отменить заявку',
        'sp-cancel',
        () => this.cancelDialog(r, draw),
        'button danger',
      );
      if (acts.childElementCount) body.append(acts);
      for (const [text, id] of why) {
        const n = el('p', 'op-note sp-rights', text);
        n.id = id;
        n.dataset.testid = 'sp-action-rights';
        body.append(n);
      }
    };
    await draw();
  }
  private differenceTable(difference: readonly SupplyDifference[]) {
    const wrap = el('div', 'sp-difference');
    wrap.dataset.testid = 'sp-difference';
    wrap.append(
      el('h3', '', partial(difference) ? 'Получено не так, как заказали' : 'Получено как заказали'),
      table(
        ['Позиция', 'Заказали', 'Получили', 'Разница'],
        difference.map((d) => [
          d.name ?? 'Позиция',
          d.requested === '0' ? 'Не заказывали' : displayQuantity(d.requested, d.unit ?? 'pcs'),
          displayQuantity(d.received, d.unit ?? 'pcs'),
          differenceText(d.difference, d.unit),
        ]),
        'Строк нет.',
      ),
    );
    return wrap;
  }
  private draftKey(id: string) {
    return `${DRAFT}:${this.cb.scope()}:${id}`;
  }
  /**
   * Lane bo-ui2 step 4: a new request prefilled from «К заказу» of «Остатки» (kind, lines with the
   * suggested quantities). Nothing is saved until the person saves it.
   */
  newRequest(form: RequestForm, mixed: boolean) {
    this.editRequest(null, { form, mixed });
  }
  /** Create (r = null) or edit a draft; the input survives a reload of the tab. */
  private editRequest(
    r: SupplyRequest | null,
    prefill: { form: RequestForm; mixed: boolean } | null = null,
  ) {
    const today = almatyToday();
    const store = sessionStore();
    const key = this.draftKey(r ? r.id : prefill ? 'reorder' : 'new');
    type Draft = { id: string; revision: number; form: RequestForm; reason: string };
    const saved = prefill ? null : readDraft<Draft>(store, key);
    const restored = saved && saved.revision === (r?.revision ?? 0) ? saved : null;
    const form: RequestForm =
      restored?.form ??
      (r ? requestFormOf(r) : (prefill?.form ?? emptyRequestForm('bakery', today)));
    const requestId = restored?.id ?? r?.id ?? crypto.randomUUID();
    let reason =
      restored?.reason ??
      (r ? 'Изменение заявки' : prefill ? 'Заявка по подсказке «К заказу»' : 'Новая заявка');
    const box = dialog(
      r ? `Изменить заявку № ${r.number}` : 'Новая заявка',
      'Остаток - по учёту склада сейчас. Подсказка «минимум - остаток» - сколько не хватает до минимального запаса позиции. Без минимума подсказки нет.',
      'sp-editor',
    );
    if (prefill) {
      const n = el(
        'p',
        'notice',
        `Строки и количества подставлены из «К заказу» (для мяса - на 3 дня расхода, иначе до минимума; «Подсказка» в строке ниже - только «минимум - остаток»). Проверьте «Куда» и количества перед сохранением.${
          prefill.mixed
            ? ' Отмеченные позиции приходят из разных мест: выбран вид «Поставщик», поменяйте его или разделите заявку.'
            : ''
        }`,
      );
      n.dataset.testid = 'sp-prefilled';
      box.append(n);
    }
    guard(box, {
      question: 'Закрыть окно? Несохранённые изменения заявки пропадут.',
      store,
      key,
      dirty: restored !== null,
    });
    const persist = () =>
      writeDraft(store, key, { id: requestId, revision: r?.revision ?? 0, form, reason });
    if (restored) {
      const n = el('p', 'notice', 'Восстановлен несохранённый ввод.');
      n.dataset.testid = 'sp-restored';
      box.append(n);
    }
    let prices = new Map<string, SupplierPrice>();
    const suppliers = () =>
      (this.suppliersList?.suppliers ?? []).filter(
        (s) => s.kind === supplierKindFor(form.kind) && (s.active || s.id === form.supplier_id),
      );
    const head = el('div', 'form-grid');
    const supplierHost = el('div');
    const linesHost = el('div', 'sp-lines');
    const drawSupplier = () => {
      const list = suppliers();
      const options = [
        {
          value: '',
          label: form.kind === 'supplier' ? 'Выберите поставщика' : 'Без поставщика (свои силы)',
        },
        ...list.map((s) => ({ value: s.id, label: s.name + (s.active ? '' : ' (в архиве)') })),
      ];
      supplierHost.replaceChildren(
        select(
          form.kind === 'supplier' ? 'Поставщик' : 'Поставщик (необязательно)',
          form.supplier_id,
          options,
          (value) => {
            form.supplier_id = value;
            persist();
            void loadPrices();
          },
          'sp-supplier',
        ),
      );
      if (!list.length && form.kind === 'supplier')
        supplierHost.append(
          el(
            'p',
            'op-note',
            'Поставщиков этого вида нет. Добавьте поставщика во вкладке «Поставщики и цены».',
          ),
        );
    };
    const loadPrices = async () => {
      prices = new Map();
      if (form.supplier_id) {
        try {
          prices = pricesInForce(await this.cb.suppliers(form.supplier_id));
        } catch {
          prices = new Map();
        }
      }
      drawLines();
    };
    if (r) head.append(el('p', 'sp-kind-fixed', `Куда: ${REQUEST_KIND_LABELS[form.kind]}`));
    else
      head.append(
        select(
          'Куда',
          form.kind,
          REQUEST_KINDS.map((k) => ({ value: k, label: REQUEST_KIND_LABELS[k] })),
          (value) => {
            form.kind = value as RequestKind;
            if (!suppliers().some((s) => s.id === form.supplier_id)) form.supplier_id = '';
            persist();
            drawSupplier();
            void loadPrices();
          },
          'sp-kind',
        ),
      );
    head.append(
      supplierHost,
      field(
        'Нужно к',
        form.needed_by,
        (value) => {
          form.needed_by = value;
          persist();
        },
        { id: 'sp-needed-by', type: 'date' },
      ),
    );
    box.append(head);
    box.append(
      field(
        'Примечание (попадёт в текст заявки)',
        form.note,
        (value) => {
          form.note = value;
          persist();
        },
        { id: 'sp-note', max: NOTE_MAX, multiline: true },
      ),
    );
    const items = () => requestIngredients(this.cb.stock());
    const drawLines = () => {
      linesHost.replaceChildren();
      const list = items();
      form.lines.forEach((l, i) => {
        const item = list.find((x) => x.id === l.ingredient_id);
        const row = el('div', 'sp-line');
        row.dataset.testid = 'sp-line';
        const base = item?.unit ?? 'pcs';
        row.append(
          select(
            'Позиция',
            l.ingredient_id,
            [
              { value: '', label: 'Выберите позицию' },
              ...list.map((x) => ({ value: x.id, label: x.name })),
            ],
            (value) => {
              l.ingredient_id = value;
              l.quantity = '';
              l.unit = list.find((x) => x.id === value)?.unit ?? 'pcs';
              persist();
              drawLines();
            },
            'sp-line-item-' + i,
          ),
          field(
            'Количество',
            l.quantity,
            (value) => {
              l.quantity = value;
              persist();
              estimate();
            },
            { id: 'sp-line-qty-' + i },
          ),
          select(
            'Единица',
            l.unit,
            priceUnits(base)
              .reverse()
              .map((u) => ({ value: u, label: UNIT_LABELS[u] ?? u })),
            (value) => {
              l.unit = value;
              persist();
              estimate();
            },
            'sp-line-unit-' + i,
          ),
          button(
            'Убрать',
            () => {
              form.lines.splice(i, 1);
              persist();
              drawLines();
              box.dispatchEvent(new Event('change'));
            },
            'button subtle',
            'sp-line-remove-' + i,
          ),
        );
        const facts = el('p', 'op-note sp-line-facts');
        facts.dataset.testid = 'sp-line-facts';
        const priceNote = el('p', 'op-note sp-line-price');
        priceNote.dataset.testid = 'sp-line-price';
        const estimate = () => {
          const price = prices.get(l.ingredient_id);
          if (!form.supplier_id || !item) {
            priceNote.textContent = '';
            return;
          }
          if (!price) {
            priceNote.textContent = 'Цены этого поставщика на позицию нет.';
            return;
          }
          const amount = lineEstimate(l, base, price);
          priceNote.textContent = `Цена: ${priceText(price)} с ${dmy(price.valid_from)}${amount ? ' · Сумма ≈ ' + tenge(amount) : ''}`;
        };
        if (item) {
          const hint = hintOf(item.minimum, item.balance);
          facts.textContent = `Остаток: ${displayQuantity(item.balance, item.unit)} · Минимум: ${
            item.minimum === '0' ? 'не задан' : displayQuantity(item.minimum, item.unit)
          } · Подсказка: ${hint === null ? 'нет минимума' : displayQuantity(hint, item.unit)}`;
          row.append(facts);
          if (hint && hint !== '0')
            row.append(
              button(
                'Подставить подсказку',
                () => {
                  l.quantity = hint;
                  l.unit = item.unit;
                  persist();
                  drawLines();
                  box.dispatchEvent(new Event('change'));
                },
                'button subtle',
                'sp-line-hint-' + i,
              ),
            );
          row.append(priceNote);
          estimate();
        }
        linesHost.append(row);
      });
      if (!form.lines.length)
        linesHost.append(el('p', 'op-note', 'Строк пока нет. Добавьте позиции заявки.'));
    };
    const lineTools = el('div', 'op-actions');
    lineTools.append(
      button(
        'Добавить строку',
        () => {
          if (form.lines.length >= LINES_MAX) return;
          form.lines.push({ ingredient_id: '', quantity: '', unit: 'pcs' });
          persist();
          drawLines();
          box.dispatchEvent(new Event('change'));
        },
        'button subtle',
        'sp-line-add',
      ),
      button(
        'Добавить всё ниже минимума',
        () => {
          const more = belowMinimumLines(form, this.cb.stock()).slice(
            0,
            LINES_MAX - form.lines.length,
          );
          form.lines.push(...more);
          persist();
          drawLines();
          box.dispatchEvent(new Event('change'));
        },
        'button subtle',
        'sp-line-below',
      ),
    );
    box.append(el('h3', '', 'Строки заявки'), linesHost, lineTools);
    box.append(
      reasonField(
        reason,
        (value) => {
          reason = value;
          persist();
        },
        'sp-reason',
      ),
    );
    const { error, show } = errorBox();
    box.addEventListener('input', () => show([]));
    const run = async (andSubmit: boolean) => {
      const out = requestPayload(form, this.cb.stock(), today, andSubmit);
      const lines = [...out.errors];
      if (reason.trim().length < 3) lines.push(REASON_SHORT);
      if (lines.length || !out.payload) {
        show(lines);
        return;
      }
      show([]);
      saveButton.disabled = submitButton.disabled = true;
      try {
        const failed = await this.cb.execute(
          requestSaveCommand(requestId, r?.revision ?? 0, out.payload),
          reason.trim(),
        );
        if (failed) {
          show([supplyErrorText(failed, this.cb.rights('supply.write'))]);
          return;
        }
        dropDraft(store, key);
        settle(box);
        if (andSubmit) {
          const fresh = (await this.loadRequest(requestId)).request!;
          const sent = await this.cb.execute(
            submitCommand(fresh.id, fresh.revision),
            'Подача заявки',
          );
          if (sent) {
            await this.reload();
            show(['Черновик сохранён, но заявка не подана: ' + supplyErrorText(sent)]);
            return;
          }
        }
        await this.reload();
        box.close();
        void this.openRequest(requestId);
      } finally {
        saveButton.disabled = submitButton.disabled = false;
      }
    };
    const saveButton = button('Сохранить черновик', () => void run(false), 'button', 'sp-save');
    const submitButton = button(
      'Сохранить и подать',
      () => void run(true),
      'button primary',
      'sp-save-submit',
    );
    const footer = el('div', 'op-actions');
    footer.append(saveButton, submitButton);
    box.append(error, footer);
    drawSupplier();
    drawLines();
    // The list of suppliers may still be loading (a reload with a restored draft).
    void (
      this.suppliersList
        ? Promise.resolve()
        : this.cb.suppliers().then((v) => {
            this.suppliersList = v;
          })
    )
      .catch(() => undefined)
      .then(() => {
        drawSupplier();
        void loadPrices();
      });
  }
  private submitDialog(r: SupplyRequest, after: () => Promise<void>) {
    const box = dialog(
      `Подать заявку № ${r.number}`,
      'После подачи строки не меняются, а остаток и подсказка фиксируются на этот момент. Система ничего не отправляет: распечатайте заявку или скопируйте текст.',
      'sp-submit-dialog',
    );
    let reason = 'Подача заявки';
    box.append(reasonField(reason, (v) => (reason = v), 'sp-submit-reason'));
    const { error, show } = errorBox();
    const ok = button(
      'Подать',
      () =>
        void (async () => {
          if (reason.trim().length < 3) return show([REASON_SHORT]);
          ok.disabled = true;
          const failed = await this.cb.execute(submitCommand(r.id, r.revision), reason.trim());
          ok.disabled = false;
          if (failed) return show([supplyErrorText(failed, this.cb.rights('supply.write'))]);
          settle(box);
          box.close();
          await this.reload();
          await after();
        })(),
      'button primary',
      'sp-submit-confirm',
    );
    box.append(error, ok);
  }
  private cancelDialog(r: SupplyRequest, after: () => Promise<void>) {
    const box = dialog(
      `Отменить заявку № ${r.number}`,
      'Отменённую заявку нельзя вернуть. Причина попадёт в журнал и в карточку заявки.',
      'sp-cancel-dialog',
    );
    let reason = '';
    box.append(
      field('Причина отмены', reason, (v) => (reason = v), {
        id: 'sp-cancel-reason',
        max: 500,
        required: true,
      }),
    );
    const { error, show } = errorBox();
    const ok = button(
      'Отменить заявку',
      () =>
        void (async () => {
          if (reason.trim().length < 3) return show(['Укажите причину отмены: минимум 3 символа.']);
          ok.disabled = true;
          const failed = await this.cb.execute(cancelCommand(r.id, r.revision), reason.trim());
          ok.disabled = false;
          if (failed) return show([supplyErrorText(failed, this.cb.rights('supply.close'))]);
          settle(box);
          box.close();
          await this.reload();
          await after();
        })(),
      'button danger',
      'sp-cancel-confirm',
    );
    box.append(error, ok);
  }
  /**
   * «Принять поставку»: the stock receipt of the request, prefilled from it. Where it came from
   * and the supplier are those of the request; the invoice number and date, the actual quantities
   * and the cost of each line are entered here. Partial deliveries are allowed: the difference
   * with the request is shown before posting.
   */
  private receiveDialog(r: SupplyRequest, after: () => Promise<void>) {
    const today = almatyToday();
    const store = sessionStore();
    const key = this.draftKey('receive:' + r.id);
    type Draft = { revision: number; form: ReceiveForm; reason: string };
    const saved = readDraft<Draft>(store, key);
    const restored = saved && saved.revision === r.revision ? saved : null;
    const form: ReceiveForm = restored?.form ?? receiveFormOf(r, today);
    form.reviewed = false;
    let reason = restored?.reason ?? `Поставка по заявке № ${r.number}`;
    const box = dialog(
      `Принять поставку по заявке № ${r.number}`,
      'Проводится обычная поставка склада. Укажите, что пришло фактически: количество и стоимость каждой строки по накладной.',
      'sp-receive-dialog',
    );
    guard(box, {
      question: 'Закрыть окно? Введённая поставка пропадёт.',
      store,
      key,
      dirty: restored !== null,
    });
    const persist = () => writeDraft(store, key, { revision: r.revision, form, reason });
    // «Откуда» of the stock v2 receipt is the kind of the request (the server sets it).
    const from = el(
      'p',
      'sp-from',
      `Откуда: ${supplierKindLabel(r.kind)}${r.supplier ? ' · Поставщик: ' + r.supplier.name : ''}`,
    );
    from.dataset.testid = 'sp-receive-from';
    const meta = el('div', 'form-grid');
    meta.append(
      field(
        'Номер накладной',
        form.reference,
        (v) => {
          form.reference = v;
          persist();
        },
        { id: 'sp-receive-reference', max: 100, required: true },
      ),
      field(
        'Дата накладной',
        form.document_date,
        (v) => {
          form.document_date = v;
          persist();
        },
        { id: 'sp-receive-date', type: 'date', required: true },
      ),
    );
    box.append(from, meta);
    const linesHost = el('div', 'sp-lines');
    const previewHost = el('div', 'sp-receive-preview');
    previewHost.dataset.testid = 'sp-receive-preview';
    const reviewed = check(
      'Проверил количество, стоимость и разницу с заявкой',
      false,
      (on) => (form.reviewed = on),
      'sp-receive-reviewed',
    );
    const refresh = () => {
      form.reviewed = false;
      reviewed.querySelector('input')!.checked = false;
      try {
        const out = receivePreview(form, r, this.cb.stock());
        previewHost.replaceChildren(
          table(
            ['Позиция', 'По учёту', 'Придёт', 'После', 'Стоимость'],
            out.preview.map((p) => [
              p.name,
              displayQuantity(p.before, p.unit),
              displayQuantity(p.delta, p.unit),
              displayQuantity(p.after, p.unit),
              tenge(p.value_delta),
            ]),
            'Строк нет.',
          ),
          this.differenceTable(out.difference),
        );
      } catch (e) {
        previewHost.replaceChildren(
          el('p', 'op-note', e instanceof Error ? e.message : 'Проверьте строки.'),
        );
      }
    };
    const draw = () => {
      linesHost.replaceChildren();
      const list = requestIngredients(this.cb.stock());
      form.lines.forEach((l, i) => {
        const item = list.find((x) => x.id === l.ingredient_id);
        const asked = r.lines.find((x) => x.ingredient_id === l.ingredient_id);
        const row = el('div', 'sp-line');
        row.dataset.testid = 'sp-receive-line';
        row.append(
          select(
            'Позиция',
            l.ingredient_id,
            [
              { value: '', label: 'Выберите позицию' },
              ...list.map((x) => ({ value: x.id, label: x.name })),
            ],
            (value) => {
              l.ingredient_id = value;
              l.quantity = '';
              l.cost = '';
              l.unit = list.find((x) => x.id === value)?.unit ?? 'pcs';
              persist();
              draw();
            },
            'sp-receive-item-' + i,
          ),
          field(
            'Получено',
            l.quantity,
            (v) => {
              l.quantity = v;
              persist();
              refresh();
            },
            { id: 'sp-receive-qty-' + i },
          ),
          select(
            'Единица',
            l.unit,
            priceUnits(item?.unit ?? 'pcs')
              .reverse()
              .map((u) => ({ value: u, label: UNIT_LABELS[u] ?? u })),
            (value) => {
              l.unit = value;
              persist();
              refresh();
            },
            'sp-receive-unit-' + i,
          ),
          field(
            'Стоимость всей строки, ₸',
            l.cost,
            (v) => {
              l.cost = v;
              persist();
              refresh();
            },
            {
              id: 'sp-receive-cost-' + i,
              hint: 'По накладной; 0 - без стоимости.',
            },
          ),
          button(
            'Не пришло',
            () => {
              form.lines.splice(i, 1);
              persist();
              draw();
              box.dispatchEvent(new Event('change'));
            },
            'button subtle',
            'sp-receive-remove-' + i,
          ),
        );
        if (asked)
          row.append(el('p', 'op-note', `Заказали: ${displayQuantity(asked.qty, asked.unit)}`));
        linesHost.append(row);
      });
      refresh();
    };
    box.append(
      el('h3', '', 'Что пришло'),
      linesHost,
      button(
        'Добавить строку',
        () => {
          form.lines.push({ ingredient_id: '', quantity: '', unit: 'pcs', cost: '' });
          persist();
          draw();
        },
        'button subtle',
        'sp-receive-add',
      ),
      el('h3', '', 'Проверка документа'),
      previewHost,
      reviewed,
      reasonField(
        reason,
        (v) => {
          reason = v;
          persist();
        },
        'sp-receive-reason',
      ),
    );
    const { error, show } = errorBox();
    box.addEventListener('input', () => show([]));
    const ok = button(
      'Провести поставку',
      () =>
        void (async () => {
          const lines: string[] = [];
          if (!form.reference.trim()) lines.push(RECEIVE_ERRORS.reference);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(form.document_date)) lines.push(RECEIVE_ERRORS.date);
          let commandLines: Data[] = [];
          try {
            commandLines = receivePreview(form, r, this.cb.stock()).lines;
          } catch (e) {
            lines.push(e instanceof Error ? e.message : 'Проверьте строки.');
          }
          if (!form.reviewed) lines.push(RECEIVE_ERRORS.reviewed);
          if (reason.trim().length < 3) lines.push(REASON_SHORT);
          if (lines.length) return show(lines);
          ok.disabled = true;
          const failed = await this.cb.execute(
            receiveCommand(r.id, r.revision, form, commandLines),
            reason.trim(),
          );
          ok.disabled = false;
          if (failed) {
            // A balance changed since the dialog opened: fresh balances, the input stays.
            if (failed instanceof ApiError && failed.code === 'CONFLICT' && !failed.reason) {
              await this.cb.refreshStock();
              draw();
            }
            return show([supplyErrorText(failed, this.cb.rights('supply.close'))]);
          }
          settle(box);
          box.close();
          await this.reload();
          await after();
        })(),
      'button primary',
      'sp-receive-confirm',
    );
    box.append(error, ok);
    draw();
  }

  // ------------------------------------------------------------------------ suppliers ----

  private renderSuppliers(p: HTMLElement) {
    const write = this.cb.can('suppliers.write');
    const why = write
      ? null
      : (this.cb.rights('suppliers.write') ?? 'Поставщиков ведут управляющий и бухгалтер.');
    const actions = el('div', 'op-actions sp-list-actions');
    if (write)
      actions.append(
        button(
          'Новый поставщик',
          () => this.editSupplier(null),
          'button primary',
          'sp-supplier-new',
        ),
      );
    else {
      actions.append(denied('Новый поставщик', why!, 'sp-supplier-new'));
      const n = el('p', 'op-note sp-rights', why!);
      n.id = 'sp-supplier-new-why';
      n.dataset.testid = 'sp-supplier-rights';
      actions.append(n);
    }
    p.append(
      el(
        'p',
        'op-note',
        'Поставщик - цех, пекарня или внешний поставщик. Название в точке одно (без учёта регистра). Поставщика не удаляют: его отправляют в архив, его цены и заявки остаются.',
      ),
      actions,
    );
    const v = this.suppliersList;
    if (!v) {
      p.append(el('p', 'op-note', this.loading ? 'Загружаем поставщиков...' : ''));
      return;
    }
    const rows = v.suppliers.map((s) => {
      const state = el(
        'span',
        `sp-state ${s.active ? 'sp-state-submitted' : 'sp-state-cancelled'}`,
        s.active ? 'Работает' : 'В архиве',
      );
      const acts = el('div', 'op-actions');
      acts.append(button('Цены', () => void this.openPrices(s), 'button subtle', 'sp-prices'));
      if (write) {
        acts.append(
          button('Изменить', () => this.editSupplier(s), 'button subtle', 'sp-supplier-edit'),
        );
        acts.append(
          button(
            s.active ? 'В архив' : 'Вернуть из архива',
            () => this.archiveSupplier(s),
            'button subtle',
            'sp-supplier-archive',
          ),
        );
      }
      return [
        s.name,
        SUPPLIER_KIND_LABELS[s.kind],
        s.prices ? `${s.prices}, последняя с ${dmy(s.last_valid_from)}` : 'Цен нет',
        state,
        acts,
      ];
    });
    p.append(
      table(
        ['Поставщик', 'Вид', 'Цены', 'Состояние', ''],
        rows,
        'Поставщиков пока нет. Настоящий список загрузим из выгрузки iiko владельца; здесь можно добавить поставщика вручную.',
        'sp-suppliers',
      ),
    );
    if (v.truncated.suppliers) p.append(el('p', 'op-note', 'Показаны первые 500 поставщиков.'));
    this.renderImports(p);
  }
  /**
   * «Импорт цен из iiko» (step 3): the last import (or the chosen one) with its report - what was
   * loaded, every category of rows that were not, those rows with the reason, the suppliers it
   * created or priced, and the prices corrected by hand since. The import itself runs from
   * scripts/supplier-prices-import.mjs (docs/operations/backoffice-supply.md); here it is read.
   */
  private renderImports(p: HTMLElement) {
    if (this.importsMissing) return;
    const box = el('section', 'sp-imports');
    box.dataset.testid = 'sp-imports';
    box.append(el('h3', '', 'Импорт цен из iiko'));
    p.append(box);
    if (this.importsError) {
      const e = el('p', 'notice error', this.importsError);
      e.setAttribute('role', 'alert');
      box.append(e);
    }
    const v = this.imports;
    if (!v) {
      if (this.loading) box.append(el('p', 'op-note', 'Загружаем импорты...'));
      return;
    }
    const one = v.import;
    if (!one) {
      const empty = el(
        'p',
        'op-note',
        'Импортов ещё не было. Поставщиков и цены из выгрузки iiko загружает скрипт по инструкции «Закупки: импорт цен»; после загрузки здесь будет её отчёт.',
      );
      empty.dataset.testid = 'sp-import-empty';
      box.append(empty);
      return;
    }
    if (v.imports.length > 1)
      box.append(
        select(
          'Импорт',
          one.id,
          v.imports.map((i) => ({ value: i.id, label: importTitle(i, almatyDateTime) })),
          (id) => {
            this.importCode = '';
            void this.loadImports(id).then(() => this.cb.changed());
          },
          'sp-import-pick',
        ),
      );
    const state = el(
      'p',
      `sp-state ${one.complete ? 'sp-state-received' : 'sp-state-submitted'}`,
      importStateText(one),
    );
    state.dataset.testid = 'sp-import-state';
    const head = el(
      'p',
      'op-note',
      `${almatyDateTime(one.applied_at)}${one.actor_name ? ', ' + one.actor_name : ''}. Файл: ${one.file_name ?? 'без названия'} (${one.source === 'iiko_export' ? 'выгрузка iiko' : 'CSV'}), строк с данными: ${one.row_count}.`,
    );
    head.dataset.testid = 'sp-import-head';
    const loaded = el(
      'p',
      'sp-total',
      `Загружено новых цен: ${one.prices_created}, новых поставщиков: ${one.suppliers_created}.${one.prices_corrected ? ` Исправлено вручную после импорта: ${one.prices_corrected}.` : ''}`,
    );
    loaded.dataset.testid = 'sp-import-loaded';
    box.append(head, state, loaded);
    if (!one.summary) {
      box.append(el('p', 'op-note', 'Отчёт этого импорта не сохранён.'));
    } else {
      // Label and count side by side, also on a phone: no table headers to repeat in cards.
      const list = el('dl', 'sp-info sp-import-counts');
      list.dataset.testid = 'sp-import-counts';
      for (const [label, value] of importCountRows(one.summary.counts)) {
        const pair = el('div', 'sp-count');
        pair.append(el('dt', '', label), el('dd', '', value));
        list.append(pair);
      }
      box.append(list);
      const issues = one.summary.issues;
      if (issues.length) {
        box.append(el('h3', '', 'Строки, которые не загрузились, и заметки'));
        const codes = [...new Set(issues.map((i) => i.code))];
        box.append(
          select(
            'Показать',
            this.importCode,
            [
              { value: '', label: `Все (${issues.length})` },
              ...codes.map((code) => ({
                value: code,
                label: `${IMPORT_ISSUE_LABELS[code] ?? code} (${issues.filter((i) => i.code === code).length})`,
              })),
            ],
            (code) => {
              this.importCode = code;
              this.cb.changed();
            },
            'sp-import-filter',
          ),
        );
        const shown = issues.filter((i) => !this.importCode || i.code === this.importCode);
        box.append(
          table(
            ['Строка', 'Почему', 'Поставщик', 'Позиция', 'Подробно'],
            shown.map((i) => [
              String(i.line),
              IMPORT_ISSUE_LABELS[i.code] ?? i.code,
              i.supplier ?? '-',
              i.name ?? '-',
              i.text,
            ]),
            '',
            'sp-import-issues',
          ),
        );
        if (one.summary.issues_total > issues.length) {
          const more = el(
            'p',
            'op-note',
            `Показаны первые ${issues.length} из ${one.summary.issues_total} строк. Полный список - в файле плана у того, кто загружал.`,
          );
          more.dataset.testid = 'sp-import-more';
          box.append(more);
        }
      }
    }
    box.append(el('h3', '', 'Поставщики этого импорта'));
    box.append(
      table(
        ['Поставщик', 'Новый', 'Цен из импорта сейчас'],
        one.suppliers.map((s) => [
          `${s.name}${s.active ? '' : ' (в архиве)'}`,
          s.created ? 'Да, создан импортом' : 'Нет, уже был',
          String(s.prices),
        ]),
        'Цен из этого импорта сейчас нет.',
        'sp-import-suppliers',
      ),
    );
    box.append(
      el(
        'p',
        'op-note',
        `SHA-256 файла ${one.file_sha256.slice(0, 12)}…, плана ${one.plan_sha256.slice(0, 12)}…`,
      ),
    );
    if (v.truncated.imports) box.append(el('p', 'op-note', 'В списке - последние 20 импортов.'));
  }
  private editSupplier(s: Supplier | null) {
    const box = dialog(s ? `Изменить: ${s.name}` : 'Новый поставщик', '', 'sp-supplier-editor');
    guard(box, { question: 'Закрыть окно? Несохранённые изменения пропадут.' });
    let name = s?.name ?? '';
    let kind: SupplierKind = s?.kind ?? 'supplier';
    let reason = s ? 'Изменение поставщика' : 'Новый поставщик';
    box.append(
      field('Название', name, (v) => (name = v), {
        id: 'sp-supplier-name',
        max: NAME_MAX,
        required: true,
      }),
    );
    if (s) box.append(el('p', 'op-note', `Вид: ${SUPPLIER_KIND_LABELS[s.kind]} (не меняется).`));
    else
      box.append(
        select(
          'Вид',
          kind,
          SUPPLIER_KINDS.map((k) => ({ value: k, label: SUPPLIER_KIND_LABELS[k] })),
          (v) => (kind = v as SupplierKind),
          'sp-supplier-kind',
        ),
        el(
          'p',
          'op-note',
          'Цех и пекарня принимают свои заявки; поставщик - заявки поставщику и на хозтовары.',
        ),
      );
    box.append(reasonField(reason, (v) => (reason = v), 'sp-supplier-reason'));
    const { error, show } = errorBox();
    const ok = button(
      'Сохранить',
      () =>
        void (async () => {
          const out = supplierPayload(name, kind, s?.active ?? true);
          const lines = [...out.errors];
          if (reason.trim().length < 3) lines.push(REASON_SHORT);
          if (lines.length || !out.payload) return show(lines);
          ok.disabled = true;
          const failed = await this.cb.execute(
            supplierSaveCommand(s?.id ?? crypto.randomUUID(), s?.revision ?? 0, out.payload),
            reason.trim(),
          );
          ok.disabled = false;
          if (failed) return show([supplyErrorText(failed, this.cb.rights('suppliers.write'))]);
          settle(box);
          box.close();
          await this.reload();
        })(),
      'button primary',
      'sp-supplier-save',
    );
    box.append(error, ok);
  }
  private archiveSupplier(s: Supplier) {
    const box = dialog(
      s.active ? `В архив: ${s.name}` : `Вернуть из архива: ${s.name}`,
      s.active
        ? 'На поставщика из архива нельзя оформить заявку и ввести цену. Поданные заявки к нему можно принять. Его цены остаются.'
        : 'Поставщик снова доступен для заявок и цен.',
      'sp-supplier-archive-dialog',
    );
    let reason = s.active ? 'Поставщик больше не работает' : 'Поставщик снова работает';
    box.append(reasonField(reason, (v) => (reason = v), 'sp-archive-reason'));
    const { error, show } = errorBox();
    const ok = button(
      s.active ? 'В архив' : 'Вернуть',
      () =>
        void (async () => {
          if (reason.trim().length < 3) return show([REASON_SHORT]);
          ok.disabled = true;
          const failed = await this.cb.execute(
            supplierSaveCommand(s.id, s.revision, {
              name: s.name,
              kind: s.kind,
              active: !s.active,
            }),
            reason.trim(),
          );
          ok.disabled = false;
          if (failed) return show([supplyErrorText(failed, this.cb.rights('suppliers.write'))]);
          settle(box);
          box.close();
          await this.reload();
        })(),
      'button primary',
      'sp-archive-confirm',
    );
    box.append(error, ok);
  }
  /** The prices of a supplier with their history per ingredient, and the price entry. */
  private async openPrices(s: Supplier) {
    const box = dialog(
      `Цены: ${s.name}`,
      'Цена - за одну закупочную единицу (кг, л или шт) с указанного дня и до следующей цены той же позиции. «В силе» - цена на сегодня.',
      'sp-prices-dialog',
    );
    const body = el('div');
    box.append(body);
    const write = this.cb.can('suppliers.write') && s.active;
    let edit: SupplierPrice | null = null;
    const draw = async () => {
      let v: SuppliersView;
      try {
        v = await this.cb.suppliers(s.id);
      } catch (e) {
        body.replaceChildren(el('p', 'notice error', supplyErrorText(e)));
        return;
      }
      body.replaceChildren();
      const rows = (v.prices ?? []).map((price) => {
        const acts = el('div', 'op-actions');
        if (write)
          acts.append(
            button(
              'Исправить',
              () => {
                edit = price;
                void draw();
              },
              'button subtle',
              'sp-price-fix',
            ),
          );
        const force = el(
          'span',
          price.in_force ? 'sp-state sp-state-submitted' : 'muted',
          price.in_force ? 'В силе' : price.valid_from > v.today ? 'Будет' : 'Прошлая',
        );
        return [
          price.ingredient_name ?? 'Позиция',
          priceText(price),
          dmy(price.valid_from),
          force,
          `${price.source === 'import' ? 'Импорт' : 'Вручную'}${price.revision > 1 ? `, исправлена (версия ${price.revision})` : ''}; ${almatyDateTime(price.updated_at)}${price.updated_by_name ? ', ' + price.updated_by_name : ''}`,
          acts,
        ];
      });
      body.append(
        table(
          ['Позиция', 'Цена', 'С какого дня', 'Сейчас', 'Откуда цена', ''],
          rows,
          'Цен этого поставщика пока нет.',
          'sp-price-table',
        ),
      );
      if (v.prices_truncated) body.append(el('p', 'op-note', 'Показаны первые 1000 цен.'));
      if (!this.cb.can('suppliers.write')) {
        const n = el(
          'p',
          'op-note sp-rights',
          this.cb.rights('suppliers.write') ?? 'Цены вводят управляющий и бухгалтер.',
        );
        n.dataset.testid = 'sp-price-rights';
        body.append(n);
        return;
      }
      if (!s.active) {
        body.append(el('p', 'op-note', 'Поставщик в архиве: новые цены не вводятся.'));
        return;
      }
      body.append(
        this.priceForm(s, edit, v.today, async () => {
          edit = null;
          await draw();
          await this.reload();
        }),
      );
    };
    await draw();
  }
  private priceForm(
    s: Supplier,
    edit: SupplierPrice | null,
    today: string,
    after: () => Promise<void>,
  ) {
    const wrap = el('div', 'sp-price-form');
    wrap.dataset.testid = 'sp-price-form';
    const list = requestIngredients(this.cb.stock());
    const form: PriceForm = edit
      ? {
          ingredient_id: edit.ingredient_id,
          unit: edit.unit,
          price: tengeInput(edit.price_minor),
          valid_from: edit.valid_from,
        }
      : { ingredient_id: '', unit: '', price: '', valid_from: today };
    let reason = edit ? 'Исправление цены' : 'Цена поставщика';
    wrap.append(
      el(
        'h3',
        '',
        edit
          ? `Исправить цену: ${edit.ingredient_name ?? ''} с ${dmy(edit.valid_from)}`
          : 'Новая цена',
      ),
    );
    const grid = el('div', 'form-grid');
    const unitHost = el('div');
    const drawUnit = () => {
      const base = list.find((x) => x.id === form.ingredient_id)?.unit ?? 'pcs';
      const units = priceUnits(base);
      if (!units.includes(form.unit)) form.unit = units[0]!;
      const u = select(
        'За единицу',
        form.unit,
        units.map((x) => ({ value: x, label: '1 ' + (UNIT_LABELS[x] ?? x) })),
        (v) => (form.unit = v),
        'sp-price-unit',
      );
      if (edit) u.querySelector('select')!.disabled = true;
      unitHost.replaceChildren(u);
    };
    const item = select(
      'Позиция',
      form.ingredient_id,
      [
        { value: '', label: 'Выберите позицию' },
        ...list.map((x) => ({ value: x.id, label: x.name })),
      ],
      (v) => {
        form.ingredient_id = v;
        drawUnit();
      },
      'sp-price-item',
    );
    const day = field('С какого дня', form.valid_from, (v) => (form.valid_from = v), {
      id: 'sp-price-from',
      type: 'date',
    });
    if (edit) {
      item.querySelector('select')!.disabled = true;
      day.querySelector('input')!.readOnly = true;
    }
    grid.append(
      item,
      unitHost,
      field('Цена, ₸', form.price, (v) => (form.price = v), {
        id: 'sp-price-value',
        hint: 'Например 2500 или 2 500,50.',
      }),
      day,
    );
    drawUnit();
    wrap.append(
      grid,
      reasonField(reason, (v) => (reason = v), 'sp-price-reason'),
    );
    const { error, show } = errorBox();
    wrap.addEventListener('input', () => show([]));
    const ok = button(
      edit ? 'Сохранить исправление' : 'Сохранить цену',
      () =>
        void (async () => {
          const out = pricePayload(form, this.cb.stock());
          const lines = [...out.errors];
          if (reason.trim().length < 3) lines.push(REASON_SHORT);
          if (lines.length || !out.payload) return show(lines);
          ok.disabled = true;
          const failed = await this.cb.execute(
            priceSaveCommand(s.id, edit?.revision ?? 0, out.payload),
            reason.trim(),
          );
          ok.disabled = false;
          if (failed) {
            // A price of this day exists already: say how to correct it.
            if (failed instanceof ApiError && failed.code === 'CONFLICT' && !edit)
              return show([
                'Цена этой позиции с этого дня уже есть. Нажмите «Исправить» в её строке.',
              ]);
            return show([supplyErrorText(failed, this.cb.rights('suppliers.write'))]);
          }
          await after();
        })(),
      'button primary',
      'sp-price-save',
    );
    wrap.append(error, ok);
    if (edit)
      wrap.append(
        button('Отменить исправление', () => void after(), 'button subtle', 'sp-price-fix-cancel'),
      );
    return wrap;
  }
}
