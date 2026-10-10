import { element as el, button, field, select, check } from './dom.js';
import { object, type Data, type Snapshot } from './operations-model.js';
import {
  displayQuantity,
  stockFilter,
  stockPreview,
  inventoryCsv,
  type StockKind,
  type StockLine,
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
/** A draft is reviewed in base units before the existing durable command is submitted. */
export function inventoryEditor(d: HTMLDialogElement, kind: StockKind, stock: Data[]) {
  d.classList.add('inventory-editor');
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
  d.append(
    field(
      'Номер документа',
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
    const parsed = stockPreview(kind, lines, stock);
    if (!reference.trim()) throw new Error('Укажите номер документа.');
    if (!reviewed) throw new Error('Проверьте документ и отметьте подтверждение.');
    return {
      type: 'stock',
      kind,
      reference: reference.trim(),
      lines: parsed.map((r) => r.command),
    };
  };
}
export class InventoryView {
  private tab = 'balances';
  private query = '';
  private filter = 'active';
  private documentKind = '';
  render(
    data: Snapshot,
    callbacks: { stock: (kind: StockKind) => void; records: (kind: string) => HTMLElement },
  ) {
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
    if (data.role === 'manager')
      toolbar.append(
        button('Поставка', () => callbacks.stock('receipt'), 'button primary', 'op-receipt'),
        button('Списание', () => callbacks.stock('waste'), 'button', 'op-waste'),
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
