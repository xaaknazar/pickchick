import { element as el, button, field, select, check } from './dom.js';
import { almatyDateTime, cards, labelledCards, tenge, ui } from './ui-fixes.js';
import { csvTenge, salesCsvText } from './sales-report-model.js';
import { object, type Data, type Snapshot, type StockReport } from './operations-model.js';
import { AutoconsumeView, type AutoconsumeCallbacks } from './autoconsume.js';
import {
  SUPPLIER_KINDS,
  WASTE_REASONS,
  addQuickWaste,
  almatyDay,
  almatyStamp,
  displayQuantity,
  documentDetail,
  lastCount,
  reversalBlocker,
  reversalState,
  stockDocumentsCsv,
  stockFilter,
  stockKindLabel,
  stockPreview,
  stockV2Fields,
  supplierKindLabel,
  wasteReasonLabel,
  wasteReasonLabelP1,
  wasteReportCsv,
  inventoryCsv,
  consumptionReportCsv,
  consumptionSourceLabel,
  signedQuantity,
  varianceReportCsv,
  type QuickTile,
  type StockReportView,
  type StockKind,
  type StockLine,
  type StockV2Draft,
} from './inventory-model.js';
import {
  REORDER_STATE_LABELS,
  SUPPLY_KIND_LABELS,
  TURNOVER_KINDS,
  TURNOVER_LABELS,
  balanceRows,
  balanceState,
  balancesCsv,
  daysLeftText,
  defaultSelection,
  perDayText,
  reorderCsv,
  reorderRequest,
  reorderRuleText,
  rowReconciles,
  salesBanner,
  salesSince,
  targetText,
  turnoverCsv,
  turnoverOf,
  type BalanceFilter,
  type StockBalancesView,
  type StockConsumption,
  type StockReorderView,
} from './stock-reports-model.js';
import type { RequestForm } from './supply-model.js';
const money = (value: unknown) => {
  // Lane bo-ui audit F19: one money format with the rest of the cabinet.
  if (ui.fixes) return tenge(value);
  const n = BigInt(String(value ?? 0)),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${(a / 100n).toLocaleString('ru-RU')},${(a % 100n).toString().padStart(2, '0')} ₸`;
};
const when = (value: unknown) =>
  ui.fixes
    ? almatyDateTime(value)
    : new Date(String(value)).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
const kinds: Record<string, string> = {
  receipt: 'Поступление',
  waste: 'Списание',
  count: 'Инвентаризация',
  production: 'Производство',
  consumption: 'По техкарте',
  transfer: 'Перемещение',
};
const unitLabels: Record<string, string> = { g: 'г', ml: 'мл', pcs: 'шт', kg: 'кг', l: 'л' };
/** Stock P1 CSV files: UTF-8 with BOM, «;», every cell quoted (the sales report format). */
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
/** `p1`: a stock P1 table, labelled for the phone without the audit fixes (labelledCards). */
function table(head: string[], rows: (string | Node)[][], p1 = false) {
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
  if (!rows.length) wrap.append(el('p', 'op-note', 'Нет записей по выбранным условиям.'));
  return p1 ? labelledCards(wrap, head) : cards(wrap, head);
}
/**
 * A draft is reviewed in base units before the existing durable command is submitted. With
 * `stockV2` (server capability, cutover CC-6) a waste needs a reason and a receipt records where
 * it came from and the date of the supplier's document.
 */
export function inventoryEditor(
  d: HTMLDialogElement,
  kind: StockKind,
  initial: Data[],
  options: {
    stockV2?: boolean;
    draft?: StockEditorState | null;
    /** Stock P1: the quick waste tiles of the ingredients (waste only). */
    quickWaste?: QuickTile[];
    /** Step 8 «Подсчёт на закрытии»: the first lines and number of a new document (no draft). */
    prefill?: StockLine[];
    reference?: string;
  } = {},
) {
  d.classList.add('inventory-editor');
  // Lane bo-ui (audit F02): the balances can be replaced after a CONFLICT (setStock below).
  let stock = initial;
  const draft = options.draft ?? null;
  const v2: StockV2Draft = {
    reason_code: '',
    supplier_kind: '',
    supplier_name: '',
    document_date: almatyDay(new Date()),
  };
  if (draft?.v2)
    for (const k of ['reason_code', 'supplier_kind', 'supplier_name', 'document_date'] as const)
      if (typeof draft.v2[k] === 'string') v2[k] = draft.v2[k];
  const lines: StockLine[] = [],
    wrap = el('div', 'inventory-lines'),
    preview = el('div', 'inventory-preview');
  let reference =
      typeof draft?.reference === 'string' ? draft.reference : (options.reference ?? ''),
    reviewed = false;
  const review = check(
    'Проверил количество и стоимость перед проведением',
    false,
    (v) => {
      reviewed = v;
    },
    'inventory-reviewed',
  );
  const refresh = () => {
    reviewed = false;
    review.querySelector('input')!.checked = false;
    try {
      const result = stockPreview(kind, lines, stock);
      preview.replaceChildren(
        table(
          ['Ингредиент', 'По учёту', 'Изменение', 'После', 'Стоимость изменения'],
          result.map((r) => [
            r.name,
            displayQuantity(r.before, r.unit),
            displayQuantity(r.delta, r.unit),
            displayQuantity(r.after, r.unit),
            money(r.value_delta),
          ]),
        ),
      );
    } catch (e) {
      preview.replaceChildren(
        el('p', 'op-note', e instanceof Error ? e.message : 'Проверьте строки.'),
      );
    }
  };
  const draw = () => {
    wrap.replaceChildren();
    lines.forEach((l, i) => {
      const b = stock.find((v) => v['id'] === l.ingredient_id),
        p = b ? object(b['payload']) : {},
        base = String(p['unit'] ?? 'pcs');
      const row = el('div', 'inventory-line');
      row.append(
        select(
          'Ингредиент',
          l.ingredient_id,
          [
            { value: '', label: 'Выберите ингредиент' },
            ...stock
              .filter((v) => object(v['payload'])['active'] || v['id'] === l.ingredient_id)
              .map((v) => ({
                value: String(v['id']),
                label: String(object(v['payload'])['name']),
              })),
          ],
          (id) => {
            l.ingredient_id = id;
            l.quantity = '';
            l.cost = '';
            const u = String(
              object(stock.find((v) => v['id'] === id)?.['payload'] ?? {})['unit'] ?? 'pcs',
            );
            l.unit = u;
            draw();
          },
          'op-stock-ingredient-' + i,
        ),
        field(
          kind === 'count' ? 'Фактически посчитано' : 'Количество',
          l.quantity,
          (v) => {
            l.quantity = v;
            refresh();
          },
          { id: 'op-stock-quantity-' + i },
        ),
        select(
          'Единица',
          l.unit,
          [base, ...(base === 'g' ? ['kg'] : base === 'ml' ? ['l'] : [])].map((u) => ({
            value: u,
            label: unitLabels[u] ?? u,
          })),
          (u) => {
            l.unit = u;
            refresh();
          },
          'inventory-unit-' + i,
        ),
      );
      if (kind === 'receipt' || (kind === 'count' && BigInt(String(b?.['quantity'] ?? 0)) === 0n))
        row.append(
          field(
            kind === 'receipt' ? 'Стоимость всей строки, ₸' : 'Стоимость найденного запаса, ₸',
            l.cost,
            (v) => {
              l.cost = v;
              refresh();
            },
            { id: 'op-stock-cost-' + i, hint: 'Укажите 0 только для запаса без стоимости.' },
          ),
        );
      row.append(
        button(
          'Убрать',
          () => {
            lines.splice(i, 1);
            draw();
          },
          'button subtle',
        ),
      );
      wrap.append(row);
    });
    refresh();
  };
  const add = () => {
    lines.push({ ingredient_id: '', quantity: '', cost: '', unit: 'pcs' });
    draw();
  };
  const details: Node[] = [];
  // Stock P1 (design-backoffice 5): one press adds the tile's quantity to its ingredient's line.
  if (kind === 'waste' && options.quickWaste?.length) {
    const tiles = el('div', 'op-quick-waste');
    tiles.dataset.testid = 'quick-waste';
    for (const tile of options.quickWaste) {
      const b = button(
        `${tile.label} +${displayQuantity(tile.quantity, tile.unit)}`,
        () => {
          const next = addQuickWaste(lines, tile);
          lines.splice(0, lines.length, ...next);
          draw();
        },
        'button subtle op-quick-tile',
        'quick-waste-' + tile.ingredient_id,
      );
      tiles.append(b);
    }
    details.push(
      el('h3', '', 'Быстрое списание'),
      el(
        'p',
        'op-note',
        'Каждое нажатие добавляет указанное количество в строку позиции. Проверьте строки и выберите причину.',
      ),
      tiles,
    );
  }
  if (options.stockV2 && kind === 'waste')
    details.push(
      select(
        'Причина списания',
        v2.reason_code,
        [
          { value: '', label: 'Выберите причину' },
          ...WASTE_REASONS.map(([value, label]) => ({ value, label })),
        ],
        (value) => {
          v2.reason_code = value;
        },
        'op-waste-reason',
      ),
      el('p', 'op-note', 'Для «Другое» опишите, что случилось, в поле «Причина изменения» ниже.'),
    );
  if (options.stockV2 && kind === 'receipt')
    details.push(
      select(
        'Откуда поставка',
        v2.supplier_kind,
        [
          { value: '', label: 'Выберите' },
          ...SUPPLIER_KINDS.map(([value, label]) => ({ value, label })),
        ],
        (value) => {
          v2.supplier_kind = value;
        },
        'op-supplier-kind',
      ),
      field(
        'Поставщик',
        v2.supplier_name,
        (value) => {
          v2.supplier_name = value;
        },
        { id: 'op-supplier-name', max: 120, hint: 'Необязательно, например название пекарни.' },
      ),
      field(
        'Дата накладной',
        v2.document_date,
        (value) => {
          v2.document_date = value;
        },
        { id: 'op-document-date', type: 'date' },
      ),
    );
  d.append(
    ...details,
    field(
      options.stockV2 && kind === 'receipt' ? 'Номер накладной' : 'Номер документа',
      reference,
      (v) => {
        reference = v;
      },
      { id: 'op-reference', max: 100 },
    ),
    wrap,
    button('Добавить строку', add),
    el('h3', '', 'Проверка документа'),
    preview,
    review,
  );
  const restored = Array.isArray(draft?.lines)
    ? draft.lines.filter(
        (l) =>
          l &&
          typeof l.ingredient_id === 'string' &&
          typeof l.quantity === 'string' &&
          typeof l.unit === 'string' &&
          typeof l.cost === 'string',
      )
    : [];
  if (restored.length) {
    lines.push(...restored.slice(0, 100).map((l) => ({ ...l })));
    draw();
  } else if (options.prefill?.length) {
    lines.push(...options.prefill.slice(0, 100).map((l) => ({ ...l })));
    draw();
  } else add();
  const build = () => {
    const extra = options.stockV2 ? stockV2Fields(kind, v2) : {};
    const parsed = stockPreview(kind, lines, stock);
    if (!reference.trim()) throw new Error('Укажите номер документа.');
    if (!reviewed) throw new Error('Проверьте документ и отметьте подтверждение.');
    return {
      type: 'stock',
      kind,
      reference: reference.trim(),
      ...extra,
      lines: parsed.map((r) => r.command),
    };
  };
  return Object.assign(build, {
    /** Lane bo-ui (audit F01): the input as it is now, for the sessionStorage draft. */
    state: (): StockEditorState => ({
      reference,
      lines: lines.map((l) => ({ ...l })),
      v2: { ...v2 },
    }),
    /**
     * Lane bo-ui (audit F02): fresh balances after a CONFLICT. The lines stay; «По учёту» and
     * the expected revisions come from the new balances and the check box must be ticked again.
     */
    setStock: (next: Data[]) => {
      stock = next;
      draw();
    },
  });
}
/** What a stock document dialog keeps between a reload and the next opening (audit F01). */
export type StockEditorState = { reference: string; lines: StockLine[]; v2: StockV2Draft };
export type InventoryCallbacks = {
  stock: (kind: StockKind) => void;
  records: (kind: string) => HTMLElement;
  /** Permission of the signed-in role (operations-model permitted). */
  can: (permission: string) => boolean;
  /** Stock v2 report (GET .../ops/stock); absent while the server has no stock v2. */
  report?: (view: StockReportView, start: string, end: string) => Promise<StockReport>;
  /** Lane bo-ui stock fixes (audit F17): «Ингредиенты» instead of a second «Номенклатура». */
  fixes?: boolean;
  /** Why a document kind is not offered to this role, in words (audit F03, F09). */
  rights?: (permission: string) => string | null;
  /** Unfinished stock documents of this tab (audit F01), to continue them. */
  drafts?: { kind: StockKind; label: string; open: () => void }[];
  /**
   * Stock P1 (capabilities.stock_p1): tabs «Списания» and «Движение» with CSV, «Последний подсчёт»
   * per position, storno in «Документы». `reverse` is null when the role may not reverse;
   * `reverseRights` then says who may.
   */
  stockP1?: { reverse: ((document: Data) => void) | null; reverseRights: string | null };
  /** The warning that sales are not written off (stock fixes), or null. */
  salesNotice?: string | null;
  /**
   * Step 5 «Списание по продажам»: menu-stock links (capabilities.stock_p1), the branch mode and
   * the queue (capabilities.stock_autoconsume). `stamp` changes with every page snapshot.
   */
  autoconsume?: { stamp: string; callbacks: AutoconsumeCallbacks };
  /**
   * Step 8 «Подсчёт на закрытии»: a count of the positions marked «Считать каждый день» (stock P1,
   * the role may count, at least one such position). Absent otherwise.
   */
  keyCount?: { open: () => void; items: number };
  /**
   * Lane bo-ui2 step 4 (capabilities.stock_reports): «Остатки» from GET .../ops/stock?view=
   * balances, «Движение» by position (the turnover of view=movement) and «К заказу». With
   * «Закупки» on the server, `createRequest` opens a request prefilled from «К заказу» (null:
   * this role may not create one, `requestRights` says who may); without them there is no button.
   */
  reports?: {
    balances: () => Promise<StockBalancesView>;
    reorder: () => Promise<StockReorderView>;
    today: () => string;
    createRequest?: ((form: RequestForm, mixed: boolean) => void) | null;
    requestRights?: string | null;
  };
};
/**
 * Stock reports (lane bo-ui2 step 4): the banner while sales are not in the numbers, or the time
 * since when they are written off.
 */
function salesState(consumption: StockConsumption, asOf: string, testId: string) {
  const warning = salesBanner(consumption, asOf);
  const since = salesSince(consumption);
  if (!warning && !since) return null;
  const n = el('p', warning ? 'notice op-stock-sales' : 'op-note', warning ?? since ?? '');
  n.setAttribute('role', 'status');
  n.dataset.testid = testId;
  return n;
}
/**
 * «Движение по позициям» of a view=movement answer (opening, in, out, closing and of what), or
 * nothing on a server without the stock reports.
 */
function turnoverBlock(report: unknown): Node[] {
  let moved: ReturnType<typeof turnoverOf>;
  try {
    moved = turnoverOf(report);
  } catch {
    const n = el(
      'p',
      'notice error',
      'Движение по позициям пришло в неверном виде. Обновите страницу.',
    );
    n.setAttribute('role', 'alert');
    return [n];
  }
  if (!moved) return [];
  const { turnover, consumption } = moved;
  const asOf = String((report as Data)['as_of'] ?? '');
  const out: Node[] = [];
  const banner = salesState(consumption, asOf, 'stock-turnover-sales');
  if (banner) out.push(banner);
  out.push(
    el('h3', '', 'Движение по позициям'),
    el(
      'p',
      'op-note',
      'На начало + пришло - ушло = на конец. «На начало» - остаток после последнего документа до периода, «На конец» - после последнего документа периода. Количество - в учётной единице позиции, сумма - по средней себестоимости на момент документа.',
    ),
  );
  if (turnover.mismatches.length) {
    const n = el(
      'p',
      'notice error',
      `У ${turnover.mismatches.length} поз. остаток на конец не сходится с историей документов. Сообщите владельцу: это ошибка учёта, остатки этих позиций проверьте инвентаризацией.`,
    );
    n.setAttribute('role', 'alert');
    n.dataset.testid = 'stock-turnover-mismatch';
    out.push(n);
  }
  const t = turnover.totals;
  const sum = el(
    'p',
    'op-note',
    `Стоимость запасов: на начало ${tenge(t.opening.value_minor)}, пришло ${tenge(t.in.value_minor)}, ушло ${tenge(t.out.value_minor)}, на конец ${tenge(t.closing.value_minor)}.`,
  );
  sum.dataset.testid = 'stock-turnover-totals';
  out.push(sum);
  const wrap = table(
    ['Ингредиент', 'На начало', 'Пришло', 'Ушло', 'На конец', 'Сумма на конец', 'Из чего'],
    turnover.rows.map((r) => [
      String(r.name),
      displayQuantity(r.opening.quantity, r.unit),
      displayQuantity(r.in.quantity, r.unit),
      displayQuantity(r.out.quantity, r.unit),
      displayQuantity(r.closing.quantity, r.unit) + (rowReconciles(r) ? '' : ' (не сходится)'),
      tenge(r.closing.value_minor),
      TURNOVER_KINDS.filter((k) => r[k].quantity !== '0' || r[k].value_minor !== '0')
        .map((k) => `${TURNOVER_LABELS[k]} ${signedQuantity(r[k].quantity, r.unit)}`)
        .join('; ') || '-',
    ]),
    true,
  );
  wrap.dataset.testid = 'stock-turnover';
  out.push(wrap);
  if (turnover.truncated.rows)
    out.push(el('p', 'op-note', 'Показаны первые 2000 позиций. Итоги посчитаны по всем.'));
  return out;
}
const REPORT_TABS: readonly StockReportView[] = ['waste', 'movement', 'variance', 'consumption'];
const isReportTab = (tab: string): tab is StockReportView =>
  (REPORT_TABS as readonly string[]).includes(tab);
/** «Как считается» under each stock P1 report. */
const REPORT_NOTES: Record<StockReportView, string> = {
  waste:
    'Как считается: дни - по времени Алматы, период - до 92 дней. Сумма - стоимость по средней себестоимости на момент документа. Сторно списания уменьшает итоги дня, в который его провели, под причиной и автором исходного списания. Списания до включения склада v2 - строкой «Без кода причины».',
  movement:
    'Все документы периода: поставки, списания, инвентаризации, производство и сторно. Изменение стоимости со знаком: поставка увеличивает запас, списание уменьшает.',
  variance:
    'Как считается: каждая инвентаризация периода (и «Подсчёт на закрытии») сравнивает посчитанное с остатком по учёту в момент подсчёта. «Ожидалось» и «Посчитано» - последнего подсчёта позиции, «Разница» и «Сумма» - всех подсчётов периода, по средней себестоимости. Минус - недостача. Первый ввод остатков (18.11) показывает весь остаток как излишек.',
  consumption:
    'Как считается: документы «По техкарте» периода - списание по продажам кассы, по заказам приложения и киоска и ручное списание по техкартам заказа. Сторно такого документа уменьшает итоги дня, в который его провели. Сумма - по средней себестоимости на момент документа.',
};
export class InventoryView {
  private tab = 'balances';
  private query = '';
  private filter = 'active';
  private documentKind = '';
  private reportView: 'waste' | 'movement' = 'waste';
  private reportStart = almatyDay(new Date(), 6);
  private reportEnd = almatyDay(new Date());
  private reportResult: StockReport | null = null;
  private reportError = '';
  /** Stock P1 reports: one result per tab, the period is shared. */
  private p1Results: Record<StockReportView, StockReport | null> = {
    waste: null,
    movement: null,
    variance: null,
    consumption: null,
  };
  private p1Errors: Record<StockReportView, string> = {
    waste: '',
    movement: '',
    variance: '',
    consumption: '',
  };
  private sales = new AutoconsumeView();
  /** Stock reports (lane bo-ui2 step 4): the last answers, reloaded for every new snapshot. */
  private serverBalances: StockBalancesView | null = null;
  private serverBalancesFor = '';
  private serverBalancesError = '';
  private reorderView: StockReorderView | null = null;
  private reorderFor = '';
  private reorderError = '';
  private reorderSelected: Set<string> | null = null;
  render(data: Snapshot, callbacks: InventoryCallbacks) {
    const root = el('section', 'inventory'),
      toolbar = el('div', 'inventory-toolbar'),
      tabs = el('nav', 'inventory-tabs'),
      body = el('div');
    tabs.setAttribute('aria-label', 'Разделы складского учёта');
    const draw = () => {
      tabs.replaceChildren();
      body.replaceChildren();
      const p1 = callbacks.stockP1 && callbacks.report ? callbacks.stockP1 : null;
      // Lane bo-ui2 step 4: «К заказу» after «Движение» while the stock reports answer.
      const reorder = callbacks.reports ? [['reorder', 'К заказу']] : [];
      for (const [key, label] of [
        ['balances', 'Остатки'],
        ['documents', 'Документы'],
        ...(p1
          ? [
              ['waste', 'Списания'],
              ['movement', 'Движение'],
              ...reorder,
              // Step 8: what the counts found and what the sales wrote off.
              ['variance', 'Расхождения подсчёта'],
              ['consumption', 'Расход по продажам'],
            ]
          : callbacks.report
            ? [['report', 'Списания и поставки'], ...reorder]
            : []),
        ...(callbacks.autoconsume ? [['sales', 'Списание по продажам']] : []),
        ['recipe', 'Техкарты'],
        ['ingredient', callbacks.fixes ? 'Ингредиенты' : 'Номенклатура'],
      ]) {
        const b = button(
          label!,
          () => {
            this.tab = key!;
            draw();
          },
          'button' + (this.tab === key ? ' selected' : ''),
        );
        b.setAttribute('aria-pressed', String(this.tab === key));
        tabs.append(b);
      }
      if (this.tab === 'balances' && callbacks.reports)
        this.balancesReport(body, data, callbacks.reports);
      else if (this.tab === 'balances') this.balances(body, data, Boolean(p1));
      else if (this.tab === 'reorder' && callbacks.reports)
        this.reorderReport(body, data, callbacks.reports);
      else if (this.tab === 'documents' && p1) this.documentsP1(body, data, p1);
      else if (this.tab === 'documents') this.documents(body, data);
      else if (isReportTab(this.tab) && p1 && callbacks.report)
        this.reportP1(body, this.tab, callbacks.report);
      else if (this.tab === 'report' && callbacks.report && !p1)
        this.report(body, callbacks.report);
      else if (this.tab === 'sales' && callbacks.autoconsume)
        body.append(
          this.sales.render(callbacks.autoconsume.stamp, callbacks.autoconsume.callbacks),
        );
      else if (
        isReportTab(this.tab) ||
        this.tab === 'sales' ||
        this.tab === 'reorder' ||
        (this.tab === 'report' && p1)
      ) {
        // The server lost (or gained) stock P1 since the tab was chosen: back to the balances.
        this.tab = 'balances';
        draw();
        return;
      } else {
        if (this.tab === 'recipe')
          body.append(
            el(
              'p',
              'notice',
              'Нормы сырья, выход заготовок, упаковку и состав комбо нужно сверить с действующими техкартами. Наличие записи ещё не означает готовность автоматического списания.',
            ),
          );
        body.append(callbacks.records(this.tab));
      }
    };
    toolbar.append(el('div', '', 'Складской учёт'));
    // Each document kind has its own permission (a shift manager counts, an accountant only
    // receives); servers without roles keep the manager-only rule.
    if (callbacks.can('stock.receipt'))
      toolbar.append(
        button('Поставка', () => callbacks.stock('receipt'), 'button primary', 'op-receipt'),
      );
    if (callbacks.can('stock.waste'))
      toolbar.append(button('Списание', () => callbacks.stock('waste'), 'button', 'op-waste'));
    if (callbacks.can('stock.count'))
      toolbar.append(
        button('Инвентаризация', () => callbacks.stock('count'), 'button', 'op-count'),
      );
    if (callbacks.keyCount)
      toolbar.append(
        button(
          `Подсчёт на закрытии (${callbacks.keyCount.items})`,
          callbacks.keyCount.open,
          'button',
          'op-key-count',
        ),
      );
    // Audit F03, F09: a role that cannot post a kind is told who can, instead of a silent gap.
    const missing = (['stock.receipt', 'stock.waste', 'stock.count'] as const)
      .filter((permission) => !callbacks.can(permission))
      .map((permission) => callbacks.rights?.(permission))
      .filter((text): text is string => Boolean(text));
    const rights = missing.length
      ? el('p', 'op-note op-rights', [...new Set(missing)].join(' '))
      : null;
    if (rights) rights.dataset.testid = 'stock-rights';
    const drafts = el('div', 'op-drafts');
    for (const item of callbacks.drafts ?? []) {
      const n = el('p', 'notice op-draft-waiting', `Есть незавершённый документ «${item.label}».`);
      n.dataset.testid = 'stock-draft-' + item.kind;
      n.append(button('Продолжить ввод', item.open, 'button subtle'));
      drafts.append(n);
    }
    // Stock P1 tables keep words whole in narrow columns (inventory.css).
    if (callbacks.stockP1 && callbacks.report) root.classList.add('inventory-p1');
    // Stock fixes (iiko-gap P0-13): while sales are not written off the page says so plainly.
    const notice = callbacks.salesNotice
      ? el('p', 'notice op-stock-sales', callbacks.salesNotice)
      : null;
    if (notice) notice.dataset.testid = 'stock-sales-notice';
    root.append(
      toolbar,
      ...(rights ? [rights] : []),
      ...(drafts.childElementCount ? [drafts] : []),
      notice ??
        el(
          'p',
          'op-note',
          'Ручной учёт этой точки. Операции iiko и продажи кассы сюда автоматически не перенесены. Перед началом работы сверьте номенклатуру и фактические остатки.',
        ),
      tabs,
      body,
    );
    draw();
    return root;
  }
  private balances(body: HTMLElement, data: Snapshot, p1 = false) {
    const controls = el('div', 'inventory-filters'),
      list = el('div'),
      summary = el('p', 'op-note');
    const draw = () => {
      const rows = stockFilter(data.stock, this.query, this.filter);
      summary.textContent = `Показано ${rows.length} из ${data.stock.length}. Стоимость выбранных запасов: ${money(rows.reduce((n, r) => n + BigInt(String(r['value_minor'] ?? 0)), 0n))}.`;
      list.replaceChildren(
        table(
          [
            'Ингредиент',
            'Остаток',
            'Минимум',
            'До минимума',
            'Стоимость',
            'Состояние',
            ...(p1 ? ['Последний подсчёт'] : []),
          ],
          rows.map((r) => {
            const p = object(r['payload']),
              q = BigInt(String(r['quantity'] ?? 0)),
              min = BigInt(String(p['minimum'] ?? 0)),
              deficit = min > q ? min - q : 0n;
            const state = el(
              'span',
              'op-badge' + (p['active'] && deficit ? ' bad' : ''),
              !p['active']
                ? 'Не используется'
                : q === 0n
                  ? 'Нет запаса'
                  : deficit
                    ? 'Ниже минимума'
                    : 'В наличии',
            );
            return [
              String(p['name']),
              displayQuantity(q, p['unit']),
              displayQuantity(min, p['unit']),
              deficit ? displayQuantity(deficit, p['unit']) : '-',
              money(r['value_minor']),
              state,
              ...(p1 ? [lastCount(r)] : []),
            ];
          }),
          p1,
        ),
      );
    };
    controls.append(
      field(
        'Найти ингредиент',
        this.query,
        (v) => {
          this.query = v;
          draw();
        },
        { id: 'inventory-search', type: 'search' },
      ),
      select(
        'Показать',
        this.filter,
        [
          { value: 'active', label: 'Используемые' },
          { value: 'low', label: 'Ниже минимума' },
          { value: 'zero', label: 'Без остатка' },
          { value: 'inactive', label: 'Не используются' },
          { value: 'all', label: 'Все ингредиенты' },
        ],
        (v) => {
          this.filter = v;
          draw();
        },
        'inventory-filter',
      ),
      button('Скачать CSV', () => {
        const rows = stockFilter(data.stock, this.query, this.filter).map((r) => {
          const p = object(r['payload']);
          return [
            String(p['name']),
            String(r['quantity'] ?? 0),
            unitLabels[String(p['unit'])] ?? '',
            String(p['minimum'] ?? 0),
            ui.fixes ? csvTenge(r['value_minor'] ?? '0') : money(r['value_minor']),
          ];
        });
        const url = URL.createObjectURL(
          new Blob(
            [
              inventoryCsv([
                [
                  'Ингредиент',
                  'Количество',
                  'Учётная единица',
                  'Минимум',
                  ui.fixes ? 'Стоимость, ₸' : 'Стоимость',
                ],
                ...rows,
              ]),
            ],
            { type: 'text/csv;charset=utf-8' },
          ),
        );
        const a = el('a');
        a.href = url;
        a.download = 'pickchick-stock.csv';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
    );
    body.append(
      controls,
      summary,
      list,
      el(
        'p',
        'op-note',
        '«До минимума» - разница с заданным вами минимальным запасом. Это не прогноз закупки: поставки в пути и будущие продажи пока не учитываются.',
      ),
    );
    draw();
  }
  /** Stock v2: waste by reason or every document of a window, with reason and invoice details. */
  private report(
    body: HTMLElement,
    load: (view: 'waste' | 'movement', start: string, end: string) => Promise<StockReport>,
  ) {
    const result = el('div', 'inventory-report');
    result.dataset.testid = 'inventory-report';
    const show = () => {
      result.replaceChildren();
      if (this.reportError) {
        const n = el('p', 'notice error', this.reportError);
        n.setAttribute('role', 'alert');
        result.append(n);
        return;
      }
      const r = this.reportResult;
      if (!r) {
        result.append(el('p', 'op-note', 'Выберите период и нажмите «Показать».'));
        return;
      }
      const date = when;
      const summary = (key: string) =>
        Array.isArray(r.summary[key]) ? (r.summary[key] as Data[]) : [];
      if (r.view === 'waste') {
        result.append(
          el(
            'p',
            'op-note',
            `Списаний: ${String(r.totals['documents'])} на ${money(r.totals['value_minor'])} по средней себестоимости.`,
          ),
          el('h3', '', 'По причинам'),
          table(
            ['Причина', 'Документов', 'Сумма'],
            summary('by_reason').map((v) => [
              wasteReasonLabel(v['reason_code']),
              String(v['documents']),
              money(v['value_minor']),
            ]),
          ),
          el('h3', '', 'По позициям'),
          table(
            ['Ингредиент', 'Списано', 'Сумма'],
            summary('by_ingredient').map((v) => [
              String(v['name']),
              displayQuantity(v['quantity'], v['unit']),
              money(v['value_minor']),
            ]),
          ),
          el('h3', '', 'По сотрудникам'),
          table(
            ['Автор', 'Документов', 'Сумма'],
            summary('by_author').map((v) => [
              String(v['actor_name']),
              String(v['documents']),
              money(v['value_minor']),
            ]),
          ),
        );
      } else
        result.append(
          ...turnoverBlock(r),
          table(
            ['Тип', 'Документов', 'Изменение стоимости'],
            summary('by_kind').map((v) => [
              kinds[String(v['kind'])] ?? String(v['kind']),
              String(v['documents']),
              money(v['value_delta_minor']),
            ]),
          ),
        );
      result.append(
        el('h3', '', 'Документы'),
        table(
          ['Документ', 'Тип', 'Создан', 'Причина или поставщик', 'Автор', 'Основание'],
          r.documents.map((v) => {
            const meta = v['meta'] && typeof v['meta'] === 'object' ? (v['meta'] as Data) : null;
            return [
              String(v['reference']),
              kinds[String(v['kind'])] ?? String(v['kind']),
              date(v['created_at']),
              v['kind'] === 'waste'
                ? wasteReasonLabel(v['reason_code'])
                : meta
                  ? [
                      supplierKindLabel(meta['supplier_kind']),
                      meta['supplier_name'] ? String(meta['supplier_name']) : '',
                      'накладная от ' +
                        new Date(`${String(meta['document_date'])}T00:00:00Z`).toLocaleDateString(
                          'ru-RU',
                          { timeZone: 'UTC' },
                        ),
                    ]
                      .filter(Boolean)
                      .join(', ')
                  : '-',
              String(v['actor_name'] ?? '-'),
              String(v['reason']),
            ];
          }),
        ),
      );
      if (r.truncated)
        result.append(el('p', 'op-note', 'Показаны последние 200 документов периода.'));
    };
    const run = button(
      'Показать',
      () => {
        run.disabled = true;
        load(this.reportView, this.reportStart, this.reportEnd)
          .then((value) => {
            this.reportResult = value;
            this.reportError = '';
          })
          .catch((error: unknown) => {
            this.reportResult = null;
            this.reportError =
              error instanceof Error && error.message === 'INVALID_REQUEST'
                ? 'Проверьте даты: период - не больше 92 дней, начало не позже конца.'
                : 'Отчёт не загрузился. Проверьте связь и повторите.';
          })
          .finally(() => {
            run.disabled = false;
            show();
          });
      },
      'button primary',
      'inventory-report-run',
    );
    const controls = el('div', 'inventory-filters');
    controls.append(
      select(
        'Отчёт',
        this.reportView,
        [
          { value: 'waste', label: 'Списания по причинам' },
          { value: 'movement', label: 'Все документы и поставки' },
        ],
        (v) => {
          this.reportView = v === 'movement' ? 'movement' : 'waste';
        },
        'inventory-report-view',
      ),
      field(
        'С',
        this.reportStart,
        (v) => {
          this.reportStart = v;
        },
        { id: 'inventory-report-start', type: 'date' },
      ),
      field(
        'По',
        this.reportEnd,
        (v) => {
          this.reportEnd = v;
        },
        { id: 'inventory-report-end', type: 'date' },
      ),
      run,
    );
    body.append(
      el(
        'p',
        'op-note',
        'Дни считаются по времени Алматы. Сумма списания - стоимость по средней себестоимости на момент документа.',
      ),
      controls,
      result,
    );
    show();
  }
  /**
   * Stock P1 report tabs: «Списания» (by reason, day, position and author of the waste, net of
   * storno) and «Движение» (every document of the period). Both with CSV in tenge.
   */
  private reportP1(
    body: HTMLElement,
    view: StockReportView,
    load: (view: StockReportView, start: string, end: string) => Promise<StockReport>,
  ) {
    const result = el('div', 'inventory-report');
    result.dataset.testid = 'inventory-report-' + view;
    const day = (d: unknown) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d));
      return m ? `${m[3]}.${m[2]}.${m[1]}` : String(d);
    };
    const show = () => {
      result.replaceChildren();
      const error = this.p1Errors[view];
      if (error) {
        const n = el('p', 'notice error', error);
        n.setAttribute('role', 'alert');
        result.append(n);
        return;
      }
      const r = this.p1Results[view];
      if (!r) {
        result.append(el('p', 'op-note', 'Выберите период и нажмите «Показать».'));
        return;
      }
      const summary = (key: string) =>
        Array.isArray(r.summary[key]) ? (r.summary[key] as Data[]) : [];
      const t = r.totals;
      if (view === 'waste')
        result.append(
          el(
            'p',
            'op-note',
            `Списаний: ${String(t['documents'] ?? 0)}, сторно: ${String(t['reversals'] ?? 0)}. Итого ${tenge(t['value_minor'])} по средней себестоимости.`,
          ),
          el('h3', '', 'По причинам'),
          table(
            ['Причина', 'Документов', 'Сторно', 'Сумма'],
            summary('by_reason').map((v) => [
              wasteReasonLabelP1(v['reason_code']),
              String(v['documents']),
              String(v['reversals'] ?? 0),
              tenge(v['value_minor']),
            ]),
            true,
          ),
          el('h3', '', 'По дням'),
          table(
            ['День', 'Документов', 'Сторно', 'Сумма'],
            summary('by_day').map((v) => [
              day(v['day']),
              String(v['documents']),
              String(v['reversals'] ?? 0),
              tenge(v['value_minor']),
            ]),
            true,
          ),
          el('h3', '', 'По позициям'),
          table(
            ['Ингредиент', 'Списано', 'Сумма'],
            summary('by_ingredient').map((v) => [
              String(v['name']),
              displayQuantity(v['quantity'], v['unit']),
              tenge(v['value_minor']),
            ]),
            true,
          ),
          el('h3', '', 'По сотрудникам'),
          table(
            ['Автор списания', 'Документов', 'Сторно', 'Сумма'],
            summary('by_author').map((v) => [
              String(v['actor_name']),
              String(v['documents']),
              String(v['reversals'] ?? 0),
              tenge(v['value_minor']),
            ]),
            true,
          ),
        );
      else if (view === 'variance')
        result.append(
          el(
            'p',
            'op-note',
            `Подсчётов: ${String(t['documents'] ?? 0)}, позиций: ${String(t['items'] ?? 0)}, с расхождением: ${String(t['lines_with_difference'] ?? 0)}. Недостача ${tenge(t['shortage_value_minor'])}, излишек ${tenge(t['surplus_value_minor'])}, итого ${tenge(t['delta_value_minor'])}.`,
          ),
          el('h3', '', 'По позициям'),
          table(
            [
              'Ингредиент',
              'Подсчётов',
              'Ожидалось',
              'Посчитано',
              'Разница',
              'Сумма',
              'Последний подсчёт',
            ],
            summary('rows').map((v) => [
              String(v['name']),
              String(v['counts']),
              displayQuantity(v['expected'], v['unit']),
              displayQuantity(v['counted'], v['unit']),
              signedQuantity(v['delta_quantity'], v['unit']),
              tenge(v['delta_value_minor']),
              almatyStamp(v['last_counted_at']),
            ]),
            true,
          ),
          el('h3', '', 'По дням'),
          table(
            ['День', 'Подсчётов', 'Позиций', 'Недостача', 'Излишек', 'Итого'],
            summary('by_day').map((v) => [
              day(v['day']),
              String(v['documents']),
              String(v['items']),
              tenge(v['shortage_value_minor']),
              tenge(v['surplus_value_minor']),
              tenge(v['delta_value_minor']),
            ]),
            true,
          ),
        );
      else if (view === 'consumption')
        result.append(
          el(
            'p',
            'op-note',
            `Документов: ${String(t['documents'] ?? 0)}, сторно: ${String(t['reversals'] ?? 0)}. Итого ${tenge(t['value_minor'])} по средней себестоимости.`,
          ),
          el('h3', '', 'По источникам'),
          table(
            ['Источник', 'Документов', 'Сторно', 'Сумма'],
            summary('by_source').map((v) => [
              consumptionSourceLabel(v['source']),
              String(v['documents']),
              String(v['reversals'] ?? 0),
              tenge(v['value_minor']),
            ]),
            true,
          ),
          el('h3', '', 'По дням'),
          table(
            ['День', 'Документов', 'Сторно', 'Сумма'],
            summary('by_day').map((v) => [
              day(v['day']),
              String(v['documents']),
              String(v['reversals'] ?? 0),
              tenge(v['value_minor']),
            ]),
            true,
          ),
          el('h3', '', 'По позициям'),
          table(
            ['Ингредиент', 'Списано', 'Сумма'],
            summary('by_ingredient').map((v) => [
              String(v['name']),
              displayQuantity(v['quantity'], v['unit']),
              tenge(v['value_minor']),
            ]),
            true,
          ),
        );
      else
        result.append(
          // Lane bo-ui2 step 4: opening, movements and closing by position, when the server has it.
          ...turnoverBlock(r),
          el(
            'p',
            'op-note',
            `Документов: ${String(t['documents'] ?? 0)}. Изменение стоимости запасов: ${tenge(t['value_delta_minor'])}.`,
          ),
          el('h3', '', 'По видам документов'),
          table(
            ['Вид', 'Документов', 'Изменение стоимости'],
            summary('by_kind').map((v) => [
              stockKindLabel(v['kind']),
              String(v['documents']),
              tenge(v['value_delta_minor']),
            ]),
            true,
          ),
        );
      result.append(
        el('h3', '', 'Документы'),
        table(
          ['Документ', 'Вид', 'Создан', 'Причина или поставщик', 'Автор', 'Основание', 'Сторно'],
          r.documents.map((v) => [
            String(v['reference']),
            stockKindLabel(v['kind']),
            almatyStamp(v['created_at']),
            documentDetail(v),
            String(v['actor_name'] ?? '-'),
            String(v['reason']),
            reversalState(v),
          ]),
          true,
        ),
      );
      if (r.truncated)
        result.append(
          el(
            'p',
            'op-note',
            'Показаны последние 200 документов периода. Итоги выше посчитаны по всем документам периода.',
          ),
        );
      const files = el('div', 'inventory-filters');
      const span = `${r.start_date}-${r.end_date}`;
      const totals =
        view === 'waste'
          ? wasteReportCsv
          : view === 'variance'
            ? varianceReportCsv
            : view === 'consumption'
              ? consumptionReportCsv
              : null;
      if (totals)
        files.append(
          button(
            'CSV итогов',
            () => download(`pickchick-${view}-${span}.csv`, totals(r)),
            'button',
            `inventory-${view}-csv`,
          ),
        );
      const moved = view === 'movement' ? turnoverOf(r) : null;
      if (moved)
        files.append(
          button(
            'CSV движения по позициям',
            () => download(`pickchick-stock-turnover-${span}.csv`, turnoverCsv(moved.turnover, r)),
            'button',
            'inventory-turnover-csv',
          ),
        );
      files.append(
        button(
          'CSV строк документов',
          () =>
            download(
              `pickchick-${view === 'waste' ? 'waste-lines' : view === 'movement' ? 'stock-movement' : view + '-lines'}-${span}.csv`,
              stockDocumentsCsv(r.documents),
            ),
          'button',
          `inventory-${view}-lines-csv`,
        ),
      );
      result.append(files);
    };
    const run = button(
      'Показать',
      () => {
        run.disabled = true;
        load(view, this.reportStart, this.reportEnd)
          .then((value) => {
            this.p1Results[view] = value;
            this.p1Errors[view] = '';
          })
          .catch((error: unknown) => {
            this.p1Results[view] = null;
            this.p1Errors[view] =
              error instanceof Error && error.message === 'INVALID_REQUEST'
                ? 'Проверьте даты: период - не больше 92 дней, начало не позже конца.'
                : 'Отчёт не загрузился. Проверьте связь и повторите.';
          })
          .finally(() => {
            run.disabled = false;
            show();
          });
      },
      'button primary',
      `inventory-${view}-run`,
    );
    const controls = el('div', 'inventory-filters');
    controls.append(
      field(
        'С',
        this.reportStart,
        (v) => {
          this.reportStart = v;
        },
        { id: `inventory-${view}-start`, type: 'date' },
      ),
      field(
        'По',
        this.reportEnd,
        (v) => {
          this.reportEnd = v;
        },
        { id: `inventory-${view}-end`, type: 'date' },
      ),
      run,
    );
    body.append(el('p', 'op-note', REPORT_NOTES[view]), controls, result);
    show();
  }
  /** The draw of the shown «Остатки» or «К заказу», called again when its answer arrives. */
  private reportsDraw: (() => void) | null = null;
  /**
   * Lane bo-ui2 step 4 «Остатки» from the server: the balance, minimum and its state in words,
   * the last count and movement, the value at average cost and at the last purchase price.
   */
  private balancesReport(
    body: HTMLElement,
    data: Snapshot,
    reports: NonNullable<InventoryCallbacks['reports']>,
  ) {
    const host = el('div', 'inventory-report');
    host.dataset.testid = 'stock-balances';
    const draw = () => {
      host.replaceChildren();
      if (this.serverBalancesError) {
        const n = el('p', 'notice error', this.serverBalancesError);
        n.setAttribute('role', 'alert');
        host.append(n);
        return;
      }
      const v = this.serverBalances;
      if (!v) {
        host.append(el('p', 'op-note', 'Загружаем остатки...'));
        return;
      }
      const banner = salesState(v.consumption, v.as_of, 'stock-balances-sales');
      if (banner) host.append(banner);
      const rows = balanceRows(v, this.query, this.filter as BalanceFilter);
      const atAverage = rows.reduce((n, r) => n + BigInt(r.value_minor), 0n);
      const atLast = rows.reduce((n, r) => n + BigInt(r.value_last_price_minor ?? '0'), 0n);
      const unpriced = rows.filter((r) => r.value_last_price_minor === null && r.quantity !== '0');
      const summary = el(
        'p',
        'op-note',
        `Показано ${rows.length} из ${v.rows.length}. Стоимость выбранных запасов: ${tenge(atAverage)} по средней себестоимости, ${tenge(atLast)} по последней цене закупки${unpriced.length ? ` (без цены закупки: ${unpriced.length} поз.)` : ''}. Ниже минимума: ${v.totals.below_minimum}.`,
      );
      summary.dataset.testid = 'stock-balances-summary';
      host.append(
        summary,
        table(
          [
            'Ингредиент',
            'Остаток',
            'Минимум',
            'Состояние',
            'Последний подсчёт',
            'Последнее движение',
            'Стоимость',
            'По последней цене',
          ],
          rows.map((r) => {
            const state = el('span', 'op-badge' + (r.below_minimum ? ' bad' : ''), balanceState(r));
            return [
              r.name,
              displayQuantity(r.quantity, r.unit),
              r.minimum === '0' ? 'не задан' : displayQuantity(r.minimum, r.unit),
              state,
              v.counted_at_known
                ? r.counted_at
                  ? almatyStamp(r.counted_at)
                  : 'Подсчёта не было'
                : '-',
              r.last_movement_at ? almatyStamp(r.last_movement_at) : 'Движений не было',
              tenge(r.value_minor),
              r.value_last_price_minor === null ? 'нет закупки' : tenge(r.value_last_price_minor),
            ];
          }),
          true,
        ),
        el(
          'p',
          'op-note',
          '«Стоимость» - по средней себестоимости, как её держит склад. «По последней цене» - остаток по цене последней поставки позиции (без сторнированных); без поставки цены нет. «Ниже минимума» - остаток меньше минимального запаса из карточки позиции. Подсказку к заказу смотрите во вкладке «К заказу».',
        ),
      );
      if (v.truncated.rows) host.append(el('p', 'op-note', 'Показаны первые 2000 позиций склада.'));
    };
    const load = () => {
      this.serverBalancesFor = data.as_of;
      reports
        .balances()
        .then((v) => {
          this.serverBalances = v;
          this.serverBalancesError = '';
        })
        .catch(() => {
          this.serverBalances = null;
          this.serverBalancesError =
            'Остатки не загрузились. Проверьте связь и нажмите «Обновить».';
        })
        .finally(() => this.reportsDraw?.());
    };
    this.reportsDraw = draw;
    if (this.serverBalancesFor !== data.as_of) load();
    const controls = el('div', 'inventory-filters');
    controls.append(
      field(
        'Найти ингредиент',
        this.query,
        (v) => {
          this.query = v;
          draw();
        },
        { id: 'inventory-search', type: 'search' },
      ),
      select(
        'Показать',
        this.filter,
        [
          { value: 'active', label: 'Используемые' },
          { value: 'low', label: 'Ниже минимума' },
          { value: 'zero', label: 'Без остатка' },
          { value: 'inactive', label: 'Не используются' },
          { value: 'all', label: 'Все ингредиенты' },
        ],
        (v) => {
          this.filter = v;
          draw();
        },
        'inventory-filter',
      ),
    );
    const actions = el('div', 'op-actions');
    actions.append(
      button(
        'Скачать CSV',
        () => {
          const v = this.serverBalances;
          if (v)
            download(
              `pickchick-stock-${almatyDay(new Date(v.as_of))}.csv`,
              balancesCsv(balanceRows(v, this.query, this.filter as BalanceFilter), v.as_of),
            );
        },
        'button',
        'stock-balances-csv',
      ),
      button(
        'Обновить',
        () => {
          this.serverBalancesFor = '';
          load();
        },
        'button subtle',
        'stock-balances-refresh',
      ),
    );
    body.append(controls, actions, host);
    draw();
  }
  /**
   * Lane bo-ui2 step 4 «К заказу»: what is below or near its target with the average use, the
   * days it lasts, the suggested quantity and its value, the rule in words, CSV and «Создать
   * заявку» (a supply request prefilled from the selected rows; the system sends nothing).
   */
  private reorderReport(
    body: HTMLElement,
    data: Snapshot,
    reports: NonNullable<InventoryCallbacks['reports']>,
  ) {
    const host = el('div', 'inventory-report');
    host.dataset.testid = 'stock-reorder';
    const draw = () => {
      host.replaceChildren();
      if (this.reorderError) {
        const n = el('p', 'notice error', this.reorderError);
        n.setAttribute('role', 'alert');
        host.append(n);
        return;
      }
      const v = this.reorderView;
      if (!v) {
        host.append(el('p', 'op-note', 'Считаем подсказку к заказу...'));
        return;
      }
      const selected = (this.reorderSelected ??= defaultSelection(v));
      const banner = salesState(v.consumption, v.as_of, 'stock-reorder-sales');
      if (banner) host.append(banner);
      const rule = el('p', 'op-note', reorderRuleText(v));
      rule.dataset.testid = 'stock-reorder-rule';
      const totals = el(
        'p',
        'op-note',
        v.rows.length
          ? `Ниже цели: ${v.totals.below}, рядом с минимумом: ${v.totals.near}. Заказать на ${tenge(v.totals.hint_value_minor)} по последним ценам${v.totals.unpriced ? ` (без цены: ${v.totals.unpriced} поз.)` : ''}.`
          : 'Все позиции с минимумом или отметкой «Мясо» выше цели: заказывать нечего.',
      );
      totals.dataset.testid = 'stock-reorder-totals';
      const tools = el('div', 'op-actions');
      if (reports.createRequest) {
        const create = reports.createRequest;
        const count = v.rows.filter((r) => selected.has(r.ingredient_id)).length;
        const b = button(
          `Создать заявку (${count})`,
          () => {
            const out = reorderRequest(v, selected, reports.today());
            create(out.form, out.mixed);
          },
          'button primary',
          'stock-reorder-request',
        );
        b.disabled = count === 0;
        if (!count) b.title = 'Отметьте позиции для заявки.';
        tools.append(b);
      } else if (reports.createRequest === null) {
        const why = reports.requestRights ?? 'Заявки создают управляющий и начальник смены.';
        const b = button(
          'Создать заявку',
          () => undefined,
          'button subtle',
          'stock-reorder-request',
        );
        b.disabled = true;
        b.title = why;
        b.setAttribute('aria-describedby', 'stock-reorder-request-why');
        const note = el('p', 'op-note op-rights', why);
        note.id = 'stock-reorder-request-why';
        tools.append(b, note);
      }
      tools.append(
        button(
          'Скачать CSV',
          () => download(`pickchick-reorder-${v.today}.csv`, reorderCsv(v)),
          'button',
          'stock-reorder-csv',
        ),
        button(
          'Обновить',
          () => {
            this.reorderFor = '';
            load();
          },
          'button subtle',
          'stock-reorder-refresh',
        ),
      );
      host.append(totals, tools);
      host.append(
        table(
          [
            'В заявку',
            'Ингредиент',
            'Остаток',
            'Расход в день (7 / 14 дней)',
            'Хватит на',
            'Цель',
            'Заказать',
            'Состояние',
          ],
          v.rows.map((r) => {
            // A bare checkbox with its name for screen readers (the column says what it does).
            const pick = el('input', 'stock-reorder-pick');
            pick.type = 'checkbox';
            pick.checked = selected.has(r.ingredient_id);
            pick.dataset.testid = 'stock-reorder-pick-' + r.ingredient_id;
            pick.setAttribute('aria-label', `В заявку: ${r.name}`);
            pick.addEventListener('change', () => {
              if (pick.checked) selected.add(r.ingredient_id);
              else selected.delete(r.ingredient_id);
              draw();
            });
            const name = el('div');
            name.append(
              el('strong', '', r.name + (r.meat ? ' (мясо)' : '')),
              el(
                'span',
                'op-note stock-reorder-from',
                `Откуда: ${r.supply_kind ? (SUPPLY_KIND_LABELS[r.supply_kind] ?? r.supply_kind) : 'не задано'}`,
              ),
            );
            const order = el(
              'span',
              '',
              r.hint === '0'
                ? 'ничего'
                : `${displayQuantity(r.hint, r.unit)} · ${
                    r.hint_value_minor === null ? 'нет цены' : tenge(r.hint_value_minor)
                  }`,
            );
            const state = el(
              'span',
              'op-badge' + (r.state === 'below' ? ' bad' : ''),
              REORDER_STATE_LABELS[r.state],
            );
            return [
              pick,
              name,
              displayQuantity(r.balance, r.unit),
              `${perDayText(r.use.d7, r.unit)} / ${perDayText(r.use.d14, r.unit)}`,
              daysLeftText(r.days_left),
              targetText(r, v.rule.meat_days),
              order,
              state,
            ];
          }),
          true,
        ),
        rule,
      );
    };
    const load = () => {
      this.reorderFor = data.as_of;
      reports
        .reorder()
        .then((v) => {
          this.reorderView = v;
          this.reorderSelected = null;
          this.reorderError = '';
        })
        .catch(() => {
          this.reorderView = null;
          this.reorderError =
            'Подсказка к заказу не загрузилась. Проверьте связь и нажмите «Обновить».';
        })
        .finally(() => this.reportsDraw?.());
    };
    this.reportsDraw = draw;
    if (this.reorderFor !== data.as_of) load();
    body.append(host);
    draw();
  }
  /** Stock P1 «Документы»: reason or supplier, storno state and the storno of a whole document. */
  private documentsP1(
    body: HTMLElement,
    data: Snapshot,
    p1: { reverse: ((document: Data) => void) | null; reverseRights: string | null },
  ) {
    const list = el('div');
    const draw = () =>
      list.replaceChildren(
        table(
          ['Документ', 'Вид', 'Создан', 'Причина или поставщик', 'Сторно', 'Подробности'],
          data.documents
            .filter((v) => !this.documentKind || v['kind'] === this.documentKind)
            .map((v) => {
              const details = el('details'),
                summary = el('summary', '', 'Движения и сторно');
              details.append(summary);
              const lines = Array.isArray(v['lines']) ? (v['lines'] as Data[]) : [];
              details.append(
                el(
                  'p',
                  'op-note',
                  `Автор: ${String(v['actor_name'] ?? v['actor_id'] ?? 'не указан')}`,
                ),
                el('p', 'op-note', `Основание: ${String(v['reason'])}`),
                table(
                  ['Ингредиент', 'Изменение', 'Стоимость', 'Остаток после'],
                  lines.map((l) => [
                    String(l['name'] ?? l['ingredient_id']),
                    displayQuantity(l['quantity_delta'], l['unit']),
                    tenge(l['value_delta_minor']),
                    displayQuantity(l['balance_after'], l['unit']),
                  ]),
                  true,
                ),
              );
              const blocker = reversalBlocker(v, data.stock);
              if (blocker) details.append(el('p', 'op-note', blocker));
              else if (p1.reverse) {
                const reverse = p1.reverse;
                details.append(
                  button('Сторно', () => reverse(v), 'button', 'stock-reverse-' + String(v['id'])),
                );
              } else if (p1.reverseRights)
                details.append(el('p', 'op-note op-rights', p1.reverseRights));
              return [
                String(v['reference']),
                stockKindLabel(v['kind']),
                almatyStamp(v['created_at']),
                documentDetail(v),
                reversalState(v),
                details,
              ];
            }),
          true,
        ),
      );
    body.append(
      el(
        'p',
        'op-note',
        'Последние 200 документов точки за всё время. Проведённый документ не меняется и не стирается: ошибку исправляет сторно (обратный документ, исходный остаётся в истории) или новая инвентаризация.',
      ),
      select(
        'Вид документа',
        this.documentKind,
        [
          { value: '', label: 'Все документы' },
          ...['receipt', 'waste', 'count', 'production', 'consumption', 'reversal'].map(
            (value) => ({
              value,
              label: stockKindLabel(value),
            }),
          ),
        ],
        (v) => {
          this.documentKind = v;
          draw();
        },
        'inventory-document-kind',
      ),
      list,
    );
    draw();
  }
  private documents(body: HTMLElement, data: Snapshot) {
    const list = el('div');
    const draw = () =>
      list.replaceChildren(
        table(
          ['Документ', 'Тип', 'Создан', 'Основание', 'Подробности'],
          data.documents
            .filter((v) => !this.documentKind || v['kind'] === this.documentKind)
            .map((v) => {
              const details = el('details'),
                summary = el('summary', '', 'Движения');
              details.append(summary);
              const lines = Array.isArray(v['lines']) ? (v['lines'] as Data[]) : [];
              details.append(
                el(
                  'p',
                  'op-note',
                  `Автор: ${String(v['actor_name'] ?? v['actor_id'] ?? 'не указан')}`,
                ),
                table(
                  ['Ингредиент', 'Изменение', 'Стоимость', 'Остаток после'],
                  lines.map((l) => [
                    String(l['name'] ?? l['ingredient_id']),
                    displayQuantity(l['quantity_delta'], l['unit']),
                    money(l['value_delta_minor']),
                    displayQuantity(l['balance_after'], l['unit']),
                  ]),
                ),
              );
              if (!Array.isArray(v['lines']))
                details.append(el('p', 'op-note', 'Подробности появятся после обновления API.'));
              return [
                String(v['reference']),
                kinds[String(v['kind'])] ?? String(v['kind']),
                when(v['created_at']),
                String(v['reason']),
                details,
              ];
            }),
        ),
      );
    body.append(
      el(
        'p',
        'op-note',
        'Последние 200 документов точки за всё время. Для каждого сохранены автор, основание и движения. Проведённые документы не стираются из истории.',
      ),
      select(
        'Тип документа',
        this.documentKind,
        [
          { value: '', label: 'Все документы' },
          ...Object.entries(kinds).map(([value, label]) => ({ value, label })),
        ],
        (v) => {
          this.documentKind = v;
          draw();
        },
      ),
      list,
    );
    draw();
  }
}
