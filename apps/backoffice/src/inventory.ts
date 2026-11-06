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
  type QuickTile,
  type StockKind,
  type StockLine,
  type StockV2Draft,
} from './inventory-model.js';
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
  let reference = typeof draft?.reference === 'string' ? draft.reference : '',
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
  report?: (view: 'waste' | 'movement', start: string, end: string) => Promise<StockReport>;
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
  private p1Results: Record<'waste' | 'movement', StockReport | null> = {
    waste: null,
    movement: null,
  };
  private p1Errors: Record<'waste' | 'movement', string> = { waste: '', movement: '' };
  private sales = new AutoconsumeView();
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
      for (const [key, label] of [
        ['balances', 'Остатки'],
        ['documents', 'Документы'],
        ...(p1
          ? [
              ['waste', 'Списания'],
              ['movement', 'Движение'],
            ]
          : callbacks.report
            ? [['report', 'Списания и поставки']]
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
      if (this.tab === 'balances') this.balances(body, data, Boolean(p1));
      else if (this.tab === 'documents' && p1) this.documentsP1(body, data, p1);
      else if (this.tab === 'documents') this.documents(body, data);
      else if ((this.tab === 'waste' || this.tab === 'movement') && p1 && callbacks.report)
        this.reportP1(body, this.tab, callbacks.report);
      else if (this.tab === 'report' && callbacks.report && !p1)
        this.report(body, callbacks.report);
      else if (this.tab === 'sales' && callbacks.autoconsume)
        body.append(
          this.sales.render(callbacks.autoconsume.stamp, callbacks.autoconsume.callbacks),
        );
      else if (
        this.tab === 'waste' ||
        this.tab === 'movement' ||
        this.tab === 'sales' ||
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
    view: 'waste' | 'movement',
    load: (view: 'waste' | 'movement', start: string, end: string) => Promise<StockReport>,
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
      else
        result.append(
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
      if (view === 'waste')
        files.append(
          button(
            'CSV итогов',
            () => download(`pickchick-waste-${span}.csv`, wasteReportCsv(r)),
            'button',
            'inventory-waste-csv',
          ),
        );
      files.append(
        button(
          'CSV строк документов',
          () =>
            download(
              `pickchick-${view === 'waste' ? 'waste-lines' : 'stock-movement'}-${span}.csv`,
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
    body.append(
      el(
        'p',
        'op-note',
        view === 'waste'
          ? 'Как считается: дни - по времени Алматы, период - до 92 дней. Сумма - стоимость по средней себестоимости на момент документа. Сторно списания уменьшает итоги дня, в который его провели, под причиной и автором исходного списания. Списания до включения склада v2 - строкой «Без кода причины».'
          : 'Все документы периода: поставки, списания, инвентаризации, производство и сторно. Изменение стоимости со знаком: поставка увеличивает запас, списание уменьшает.',
      ),
      controls,
      result,
    );
    show();
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
