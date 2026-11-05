import { element as el, button, field, select, check } from './dom.js';
import { object, type Data, type Snapshot, type StockReport } from './operations-model.js';
import {
  SUPPLIER_KINDS,
  WASTE_REASONS,
  almatyDay,
  displayQuantity,
  stockFilter,
  stockPreview,
  stockV2Fields,
  supplierKindLabel,
  wasteReasonLabel,
  inventoryCsv,
  type StockKind,
  type StockLine,
  type StockV2Draft,
} from './inventory-model.js';
const money = (value: unknown) => {
  const n = BigInt(String(value ?? 0)),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${(a / 100n).toLocaleString('ru-RU')},${(a % 100n).toString().padStart(2, '0')} ₸`;
};
const kinds: Record<string, string> = {
  receipt: 'Поступление',
  waste: 'Списание',
  count: 'Инвентаризация',
  production: 'Производство',
  consumption: 'По техкарте',
  transfer: 'Перемещение',
};
const unitLabels: Record<string, string> = { g: 'г', ml: 'мл', pcs: 'шт', kg: 'кг', l: 'л' };
function table(head: string[], rows: (string | Node)[][]) {
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
  return wrap;
}
/**
 * A draft is reviewed in base units before the existing durable command is submitted. With
 * `stockV2` (server capability, cutover CC-6) a waste needs a reason and a receipt records where
 * it came from and the date of the supplier's document.
 */
export function inventoryEditor(
  d: HTMLDialogElement,
  kind: StockKind,
  stock: Data[],
  options: { stockV2?: boolean } = {},
) {
  d.classList.add('inventory-editor');
  const v2: StockV2Draft = {
    reason_code: '',
    supplier_kind: '',
    supplier_name: '',
    document_date: almatyDay(new Date()),
  };
  const lines: StockLine[] = [],
    wrap = el('div', 'inventory-lines'),
    preview = el('div', 'inventory-preview');
  let reference = '',
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
  add();
  return () => {
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
}
export type InventoryCallbacks = {
  stock: (kind: StockKind) => void;
  records: (kind: string) => HTMLElement;
  /** Permission of the signed-in role (operations-model permitted). */
  can: (permission: string) => boolean;
  /** Stock v2 report (GET .../ops/stock); absent while the server has no stock v2. */
  report?: (view: 'waste' | 'movement', start: string, end: string) => Promise<StockReport>;
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
  render(data: Snapshot, callbacks: InventoryCallbacks) {
    const root = el('section', 'inventory'),
      toolbar = el('div', 'inventory-toolbar'),
      tabs = el('nav', 'inventory-tabs'),
      body = el('div');
    tabs.setAttribute('aria-label', 'Разделы складского учёта');
    const draw = () => {
      tabs.replaceChildren();
      body.replaceChildren();
      for (const [key, label] of [
        ['balances', 'Остатки'],
        ['documents', 'Документы'],
        ...(callbacks.report ? [['report', 'Списания и поставки']] : []),
        ['recipe', 'Техкарты'],
        ['ingredient', 'Номенклатура'],
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
      if (this.tab === 'balances') this.balances(body, data);
      else if (this.tab === 'documents') this.documents(body, data);
      else if (this.tab === 'report' && callbacks.report) this.report(body, callbacks.report);
      else {
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
    root.append(
      toolbar,
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
  private balances(body: HTMLElement, data: Snapshot) {
    const controls = el('div', 'inventory-filters'),
      list = el('div'),
      summary = el('p', 'op-note');
    const draw = () => {
      const rows = stockFilter(data.stock, this.query, this.filter);
      summary.textContent = `Показано ${rows.length} из ${data.stock.length}. Стоимость выбранных запасов: ${money(rows.reduce((n, r) => n + BigInt(String(r['value_minor'] ?? 0)), 0n))}.`;
      list.replaceChildren(
        table(
          ['Ингредиент', 'Остаток', 'Минимум', 'До минимума', 'Стоимость', 'Состояние'],
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
            ];
          }),
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
            money(r['value_minor']),
          ];
        });
        const url = URL.createObjectURL(
          new Blob(
            [
              inventoryCsv([
                ['Ингредиент', 'Количество', 'Учётная единица', 'Минимум', 'Стоимость'],
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
      const date = (v: unknown) =>
        new Date(String(v)).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
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
                new Date(String(v['created_at'])).toLocaleString('ru-RU', {
                  timeZone: 'Asia/Almaty',
                }),
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
