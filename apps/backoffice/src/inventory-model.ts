import { object, type Data } from './operations-model.js';
import { csvTenge, csvTextCell } from './sales-report-model.js';
export type StockKind = 'receipt' | 'waste' | 'count';
export type StockLine = { ingredient_id: string; quantity: string; unit: string; cost: string };
const limit = 999999999999999n;
export function stockQuantity(value: string, unit: string, base: string): string {
  if (!(unit === base || (base === 'g' && unit === 'kg') || (base === 'ml' && unit === 'l')))
    throw new Error('Единица не соответствует ингредиенту.');
  const scale = unit === 'kg' || unit === 'l' ? 3 : 0;
  return decimal(
    value,
    scale,
    scale ? 'Не больше трёх знаков после запятой.' : 'Введите целое количество в учётной единице.',
  );
}
function decimal(value: string, scale: number, error: string) {
  const m = value
    .trim()
    .replace(',', '.')
    .match(/^(\d+)(?:\.(\d+))?$/);
  if (!m || (m[2]?.length ?? 0) > scale) throw new Error(error);
  const n = BigInt(m[1]!) * 10n ** BigInt(scale) + BigInt((m[2] ?? '').padEnd(scale, '0') || '0');
  if (n > limit) throw new Error('Количество или стоимость слишком велики.');
  return n.toString();
}
export const stockMoney = (v: string) =>
  decimal(v, 2, 'Введите стоимость в тенге, максимум два знака после запятой.');
export function displayQuantity(value: unknown, base: unknown) {
  const n = BigInt(String(value ?? 0));
  if (base !== 'g' && base !== 'ml') return `${n.toLocaleString('ru-RU')} шт`;
  const a = n < 0n ? -n : n;
  const fraction = (a % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${(a / 1000n).toLocaleString('ru-RU')}${fraction ? ',' + fraction : ''} ${base === 'g' ? 'кг' : 'л'}`;
}
export function stockPreview(kind: StockKind, lines: StockLine[], stock: Data[]) {
  if (!lines.length) throw new Error('Добавьте хотя бы один ингредиент.');
  const seen = new Set<string>();
  return lines.map((line) => {
    if (seen.has(line.ingredient_id))
      throw new Error('Ингредиент повторяется. Объедините его в одну строку.');
    seen.add(line.ingredient_id);
    const b = stock.find((v) => v['id'] === line.ingredient_id);
    if (!b) throw new Error('Выберите ингредиент.');
    const p = object(b['payload']);
    const quantity = stockQuantity(line.quantity, line.unit, String(p['unit']));
    const q = BigInt(String(b['quantity'] ?? 0)),
      v = BigInt(String(b['value_minor'] ?? 0)),
      n = BigInt(quantity);
    if (kind !== 'count' && !n) throw new Error('Количество должно быть больше нуля.');
    const delta = kind === 'receipt' ? n : kind === 'waste' ? -n : n - q;
    if (q + delta < 0n) throw new Error(`${p['name']}: недостаточно остатка для списания.`);
    const explicitCost = kind === 'receipt' || (kind === 'count' && q === 0n && n > 0n);
    const value = explicitCost ? stockMoney(line.cost) : '0';
    const dv =
      delta > 0n
        ? kind === 'count' && q > 0n
          ? (v * delta) / q
          : BigInt(value)
        : delta === -q
          ? -v
          : q
            ? (v * delta) / q
            : 0n;
    if (q + delta > limit || v + dv > limit)
      throw new Error('Итоговый остаток или стоимость слишком велики.');
    return {
      command: {
        ingredient_id: line.ingredient_id,
        quantity,
        value_minor: value,
        expected_revision: Number(b['revision'] ?? 0),
      },
      name: String(p['name']),
      unit: String(p['unit']),
      before: q.toString(),
      after: (q + delta).toString(),
      delta: delta.toString(),
      value_delta: dv.toString(),
    };
  });
}
export function stockFilter(stock: Data[], query: string, mode: string) {
  const search = query.trim().toLocaleLowerCase('ru');
  return stock
    .filter((r) => {
      const p = object(r['payload']),
        q = BigInt(String(r['quantity'] ?? 0));
      return (
        String(p['name']).toLocaleLowerCase('ru').includes(search) &&
        (mode === 'all' ||
          (mode === 'inactive'
            ? !p['active']
            : p['active'] &&
              (mode === 'active' ||
                (mode === 'zero' ? q === 0n : q < BigInt(String(p['minimum'] ?? 0))))))
      );
    })
    .sort((a, b) =>
      String(object(a['payload'])['name']).localeCompare(
        String(object(b['payload'])['name']),
        'ru',
      ),
    );
}
export function inventoryCsv(rows: string[][]) {
  return (
    '\ufeff' +
    rows
      .map((row) =>
        row
          .map((v) => '"' + (/^[\s]*[=+@-]/.test(v) ? "'" + v : v).replaceAll('"', '""') + '"')
          .join(';'),
      )
      .join('\r\n')
  );
}
/**
 * Stock v2 (cutover CC-6; contracts 2.1 StockWasteReason, StockSupplierKind): labels in the order
 * of the contract enums. Sent only to servers that report capabilities.stock_v2.
 */
export const WASTE_REASONS: readonly (readonly [string, string])[] = [
  ['hot_cabinet_expired', 'Тепловой шкаф: старше 50 минут'],
  ['meat_expired', 'Мясо: старше 3 дней'],
  ['defect', 'Брак'],
  ['prep_expired', 'Заготовка: истёк срок'],
  ['damaged', 'Упало / повреждено'],
  ['returned_after_cooking', 'Возврат после приготовления'],
  ['rework', 'Переделка'],
  ['other', 'Другое'],
];
export const SUPPLIER_KINDS: readonly (readonly [string, string])[] = [
  ['central_kitchen', 'Цех'],
  ['bakery', 'Пекарня'],
  ['household', 'Хозтовары'],
  ['supplier', 'Поставщик'],
];
export const wasteReasonLabel = (code: unknown) =>
  code === null || code === undefined
    ? 'Без причины'
    : (WASTE_REASONS.find(([value]) => value === code)?.[1] ?? String(code));
export const supplierKindLabel = (code: unknown) =>
  SUPPLIER_KINDS.find(([value]) => value === code)?.[1] ?? '-';
export type StockV2Draft = {
  reason_code: string;
  supplier_kind: string;
  supplier_name: string;
  document_date: string;
};
function calendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > '2099-12-31')
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** The v2 fields of one stock document; throws a Russian message the dialog shows as is. */
export function stockV2Fields(kind: StockKind, draft: StockV2Draft): Data {
  if (kind === 'waste') {
    if (!WASTE_REASONS.some(([value]) => value === draft.reason_code))
      throw new Error('Укажите причину списания.');
    return { reason_code: draft.reason_code };
  }
  if (kind !== 'receipt') return {};
  if (!SUPPLIER_KINDS.some(([value]) => value === draft.supplier_kind))
    throw new Error('Укажите, откуда пришла поставка.');
  if (!calendarDate(draft.document_date)) throw new Error('Укажите дату накладной.');
  const name = draft.supplier_name.trim();
  if (name.length > 120) throw new Error('Название поставщика - не длиннее 120 символов.');
  return {
    meta: {
      supplier_kind: draft.supplier_kind,
      ...(name ? { supplier_name: name } : {}),
      document_date: draft.document_date,
    },
  };
}
/** Calendar day in Asia/Almaty, `days` before `now` (report windows). */
export function almatyDay(now: Date, days = 0) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(
    new Date(now.getTime() - days * 86400000),
  );
}

/*
 * Stock P1 (lane bo-ui; design-bo-ui 5.2, 5.4; design-backoffice 5 «Остатки»). Used only while
 * the server reports capabilities.stock_p1 (stock v2 with cloud075 and its rights).
 */
/** The old waste of the cloud lane without a reason code, as the report names it. */
export const wasteReasonLabelP1 = (code: unknown) =>
  code === null || code === undefined
    ? 'Без кода причины (до включения склада v2)'
    : wasteReasonLabel(code);
/** Document kinds a storno takes (stock-p1.ts REVERSIBLE_KINDS). */
export const REVERSIBLE_KINDS = ['receipt', 'waste', 'production', 'consumption'] as const;
const KIND_NAMES: Record<string, string> = {
  receipt: 'Поставка',
  waste: 'Списание',
  count: 'Инвентаризация',
  production: 'Производство',
  consumption: 'По техкарте',
  transfer: 'Перемещение',
  reversal: 'Сторно',
};
export const stockKindLabel = (kind: unknown) => KIND_NAMES[String(kind)] ?? String(kind);
const time = (value: unknown) => {
  if (!value) return '-';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Asia/Almaty',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(String(value)))
      .map((p) => [p.type, p.value]),
  );
  return `${parts['day']}.${parts['month']}.${parts['year']} ${parts['hour']}:${parts['minute']}`;
};
/** «19.11.2026 13:05» in Almaty time, «-» without a value. */
export const almatyStamp = time;
/** «Последний подсчёт» of a stock row: the time of the last count, or that there was none. */
export const lastCount = (row: Data) =>
  row['counted_at'] ? time(row['counted_at']) : 'Подсчёта не было';
/**
 * The warning of «Остатки» while sales are not written off (design-backoffice 7, iiko-gap P0-13):
 * balances move only by documents, so they are right right after a count and drift with every sale.
 */
export function stockSalesNotice(
  mode: 'off' | 'dry_run' | 'on' = 'off',
  lastCount = false,
  startAt: string | null = null,
): string | null {
  // Step 5: with the automatic consumption on the page says from when sales are written off.
  if (mode === 'on')
    return startAt
      ? `Продажи списываются со склада автоматически с ${almatyStamp(startAt)} по утверждённым связям меню. Продажи без связи или без остатка ждут во вкладке «Списание по продажам».`
      : null;
  const where = lastCount ? ' - смотрите «Последний подсчёт» у позиции' : '';
  return mode === 'dry_run'
    ? `Списание по продажам работает в режиме проверки: продажи со склада не списываются. Остаток верен только сразу после инвентаризации${where}.`
    : `Продажи пока не списываются со склада автоматически. Остаток верен только сразу после инвентаризации${where}. Расход между подсчётами вносите списанием.`;
}
/** Why a document cannot be reversed, in words, or null when the storno is offered. */
export function reversalBlocker(document: Data, stock: Data[]): string | null {
  const kind = String(document['kind']);
  if (kind === 'reversal') return 'Это сторно. Сторно не отменяется повторным сторно.';
  if (kind === 'count')
    return 'Инвентаризацию не сторнируют: исправьте остаток новой инвентаризацией.';
  if (!(REVERSIBLE_KINDS as readonly string[]).includes(kind))
    return 'Этот вид документа не сторнируется.';
  if (document['reversed_by'])
    return `Документ уже сторнирован ${time(document['reversed_at'])}. Сторно - одно на документ.`;
  const lines = Array.isArray(document['lines']) ? (document['lines'] as Data[]) : [];
  if (!lines.length) return 'В документе нет движений: сторнировать нечего.';
  const created = Date.parse(String(document['created_at']));
  const counted = lines.some((l) => {
    const row = stock.find((s) => s['id'] === l['ingredient_id']);
    return row?.['counted_at'] ? Date.parse(String(row['counted_at'])) > created : false;
  });
  if (counted)
    return 'После документа по его позициям провели инвентаризацию: она уже учла фактический остаток. Исправьте остаток новой инвентаризацией или списанием.';
  return null;
}
export type ReversalLine = {
  ingredient_id: string;
  name: string;
  unit: string;
  before: string;
  delta: string;
  after: string;
  value_delta: string;
  /** The exact opposite fits the balance: never below zero, no value left without quantity. */
  ok: boolean;
};
/**
 * The storno preview: every movement of the document turned around against today's balance, and
 * the command with the balance revisions the dialog showed (CONFLICT if another document moves
 * them first). `error` names the first line the server would refuse with INSUFFICIENT_STOCK.
 */
export function reversalPreview(document: Data, stock: Data[]) {
  const lines = (Array.isArray(document['lines']) ? (document['lines'] as Data[]) : []).map(
    (l): ReversalLine => {
      const row = stock.find((s) => s['id'] === l['ingredient_id']);
      const q = BigInt(String(row?.['quantity'] ?? 0)),
        v = BigInt(String(row?.['value_minor'] ?? 0)),
        dq = -BigInt(String(l['quantity_delta'] ?? 0)),
        dv = -BigInt(String(l['value_delta_minor'] ?? 0));
      const after = q + dq,
        value = v + dv;
      return {
        ingredient_id: String(l['ingredient_id']),
        name: String(l['name'] ?? l['ingredient_id']),
        unit: String(l['unit'] ?? 'pcs'),
        before: q.toString(),
        delta: dq.toString(),
        after: after.toString(),
        value_delta: dv.toString(),
        ok: Boolean(row) && after >= 0n && value >= 0n && (after !== 0n || value === 0n),
      };
    },
  );
  const bad = lines.find((l) => !l.ok);
  return {
    lines,
    error: bad
      ? `${bad.name}: остаток или его стоимость уже меньше, чем добавил документ. Сторно невозможно - проверьте остаток инвентаризацией.`
      : null,
    command: {
      type: 'stock_reverse',
      document_id: String(document['id']),
      expected_balances: Object.fromEntries(
        lines.map((l) => [
          l.ingredient_id,
          Number(stock.find((s) => s['id'] === l.ingredient_id)?.['revision'] ?? 0),
        ]),
      ),
    },
  };
}
/** Quick waste tiles (Ingredient.quick_waste) of the ingredients in use, by label. */
export type QuickTile = { ingredient_id: string; label: string; quantity: string; unit: string };
export function quickWasteTiles(stock: Data[]): QuickTile[] {
  return stock
    .map((row) => {
      const p = object(row['payload']);
      const q =
        p['quick_waste'] && typeof p['quick_waste'] === 'object' ? object(p['quick_waste']) : null;
      if (!p['active'] || !q || typeof q['label'] !== 'string' || typeof q['quantity'] !== 'string')
        return null;
      return {
        ingredient_id: String(row['id']),
        label: q['label'],
        quantity: q['quantity'],
        unit: String(p['unit'] ?? 'pcs'),
      };
    })
    .filter((t): t is QuickTile => t !== null)
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}
/**
 * One press of a tile: adds its quantity (base unit) to the waste line of the ingredient, or opens
 * the line. A line typed in kg or l is converted to the base unit first; an unreadable quantity is
 * replaced by the tile's.
 */
export function addQuickWaste(lines: StockLine[], tile: QuickTile): StockLine[] {
  const i = lines.findIndex((l) => l.ingredient_id === tile.ingredient_id);
  if (i < 0) {
    const empty = lines.length === 1 && !lines[0]!.ingredient_id && !lines[0]!.quantity.trim();
    const line = {
      ingredient_id: tile.ingredient_id,
      quantity: tile.quantity,
      unit: tile.unit,
      cost: '',
    };
    return empty ? [line] : [...lines, line];
  }
  const current = lines[i]!;
  let base: bigint;
  try {
    base = BigInt(stockQuantity(current.quantity, current.unit, tile.unit));
  } catch {
    base = 0n;
  }
  const next = { ...current, unit: tile.unit, quantity: (base + BigInt(tile.quantity)).toString() };
  return lines.map((l, n) => (n === i ? next : l));
}
/** Ingredient editor: the tile fields as typed; both empty removes the tile. */
export function quickWasteField(label: string, quantity: string): Data | null {
  const l = label.trim(),
    q = quantity.trim();
  if (!l && !q) return null;
  if (!l || l.length > 40) throw new Error('Название плитки - от 1 до 40 символов.');
  if (!/^[1-9][0-9]{0,14}$/.test(q))
    throw new Error('Количество плитки - целое число больше нуля в учётной единице ингредиента.');
  return { label: l, quantity: q };
}
/** A quantity of a base unit for a CSV cell: «1,5» with «кг», «12» with «шт». */
export function csvQuantity(value: unknown, base: unknown): [string, string] {
  const n = BigInt(String(value ?? 0));
  if (base !== 'g' && base !== 'ml') return [n.toString(), 'шт'];
  const a = n < 0n ? -n : n;
  const fraction = (a % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return [
    `${n < 0n ? '-' : ''}${(a / 1000n).toString()}${fraction ? ',' + fraction : ''}`,
    base === 'g' ? 'кг' : 'л',
  ];
}
const rowsOf = (summary: Data, key: string) =>
  Array.isArray(summary[key]) ? (summary[key] as Data[]) : [];
/**
 * «Списания» CSV (P1 report, exact over the whole window): one block per table, blocks separated
 * by an empty row, money in tenge under «Сумма, ₸».
 */
export function wasteReportCsv(report: {
  start_date: string;
  end_date: string;
  totals: Data;
  summary: Data;
}): string[][] {
  const day = (d: unknown) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(d);
  };
  const t = report.totals;
  return [
    ['Списания за период', `${day(report.start_date)} - ${day(report.end_date)}`],
    ['Документов списания', 'Сторно', 'Сумма, ₸'],
    [String(t['documents'] ?? 0), String(t['reversals'] ?? 0), csvTenge(t['value_minor'] ?? '0')],
    [],
    ['Причина', 'Документов', 'Сторно', 'Сумма, ₸'],
    ...rowsOf(report.summary, 'by_reason').map((r) => [
      wasteReasonLabelP1(r['reason_code']),
      String(r['documents'] ?? 0),
      String(r['reversals'] ?? 0),
      csvTenge(r['value_minor']),
    ]),
    [],
    ['День', 'Документов', 'Сторно', 'Сумма, ₸'],
    ...rowsOf(report.summary, 'by_day').map((r) => [
      day(r['day']),
      String(r['documents'] ?? 0),
      String(r['reversals'] ?? 0),
      csvTenge(r['value_minor']),
    ]),
    [],
    ['Ингредиент', 'Списано', 'Единица', 'Сумма, ₸'],
    ...rowsOf(report.summary, 'by_ingredient').map((r) => [
      csvTextCell(r['name']),
      ...csvQuantity(r['quantity'], r['unit']),
      csvTenge(r['value_minor']),
    ]),
    [],
    ['Автор списания', 'Документов', 'Сторно', 'Сумма, ₸'],
    ...rowsOf(report.summary, 'by_author').map((r) => [
      csvTextCell(r['actor_name']),
      String(r['documents'] ?? 0),
      String(r['reversals'] ?? 0),
      csvTenge(r['value_minor']),
    ]),
  ];
}
/** Where a document came from or why it was written off, in words (report and documents tab). */
export function documentDetail(document: Data): string {
  const kind = String(document['kind']);
  if (kind === 'waste') return wasteReasonLabelP1(document['reason_code']);
  if (kind === 'reversal') {
    const r =
      document['reverses'] && typeof document['reverses'] === 'object'
        ? (document['reverses'] as Data)
        : null;
    if (!r) return 'Сторно';
    return `Сторно: ${stockKindLabel(r['kind'])} «${String(r['reference'])}» от ${time(r['created_at'])}${
      r['kind'] === 'waste' ? ', ' + wasteReasonLabelP1(r['reason_code']) : ''
    }`;
  }
  const meta =
    document['meta'] && typeof document['meta'] === 'object' ? (document['meta'] as Data) : null;
  if (kind === 'receipt' && meta) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(meta['document_date']));
    return [
      supplierKindLabel(meta['supplier_kind']),
      meta['supplier_name'] ? String(meta['supplier_name']) : '',
      m ? `накладная от ${m[3]}.${m[2]}.${m[1]}` : '',
    ]
      .filter(Boolean)
      .join(', ');
  }
  // Step 5: a consumption written by the automatic consumption names its sale (source_ref).
  if (kind === 'consumption' && typeof document['source_ref'] === 'string')
    return document['source_ref'].startsWith('pos:')
      ? 'Автоматически по продаже кассы'
      : 'Автоматически по заказу приложения или киоска';
  return '-';
}
/** Storno state of a document in words, or «-». */
export const reversalState = (document: Data) =>
  document['reversed_by'] ? `Сторнирован ${time(document['reversed_at'])}` : '-';
/** «Строки документов» CSV of the listed documents (at most 200, the report says when cut). */
export function stockDocumentsCsv(documents: Data[]): string[][] {
  return [
    [
      'Дата',
      'Документ',
      'Вид',
      'Причина или поставщик',
      'Ингредиент',
      'Изменение',
      'Единица',
      'Сумма, ₸',
      'Автор',
      'Основание',
      'Сторно',
    ],
    ...documents.flatMap((d) =>
      (Array.isArray(d['lines']) ? (d['lines'] as Data[]) : []).map((l) => [
        time(d['created_at']),
        csvTextCell(d['reference']),
        stockKindLabel(d['kind']),
        csvTextCell(documentDetail(d)),
        csvTextCell(l['name']),
        ...csvQuantity(l['quantity_delta'], l['unit']),
        csvTenge(l['value_delta_minor']),
        csvTextCell(d['actor_name']),
        csvTextCell(d['reason']),
        reversalState(d),
      ]),
    ),
  ];
}
