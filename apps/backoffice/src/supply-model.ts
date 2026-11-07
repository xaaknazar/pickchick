import { tenge } from './ui-fixes.js';
import { displayQuantity, stockMoney, stockPreview, stockQuantity } from './inventory-model.js';
import { almatyTime, csvTenge, csvTextCell } from './sales-report-model.js';

/**
 * «Закупки» of the cabinet (lane bo-ui2 step 2; design-bo-ui §9.4, design-backoffice Ск6, Ск3):
 * the views of GET .../ops/suppliers and .../ops/supply-requests, the words for a request and a
 * supplier, the forms (request, receipt by a request, supplier, price) with the rules of the
 * server and the commands. Pure functions; the page is supply.ts. Shown only while GET
 * branches/:id reports capabilities.supply (BACKOFFICE_SUPPLY_ENABLED with stock v2 and the
 * cloud076 rights); without it the cabinet has no section and asks for none of this.
 * The system sends nothing to a supplier: the page prints and copies the text.
 */
type Data = Record<string, unknown>;
export type SupplierKind = 'supplier' | 'central_kitchen' | 'bakery';
export type RequestKind = 'central_kitchen' | 'bakery' | 'household' | 'supplier';
export type RequestState = 'draft' | 'submitted' | 'received' | 'cancelled';
export type Supplier = {
  id: string;
  name: string;
  kind: SupplierKind;
  active: boolean;
  revision: number;
  prices: number;
  last_valid_from: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_by_name: string | null;
  updated_at: string;
};
export type SupplierPrice = {
  supplier_id: string;
  ingredient_id: string;
  ingredient_name: string | null;
  ingredient_unit: string | null;
  unit: string;
  price_minor: string;
  valid_from: string;
  in_force: boolean;
  source: 'manual' | 'import';
  revision: number;
  updated_by_name: string | null;
  updated_at: string;
};
export type SuppliersView = {
  schema_version: 1;
  branch_id: string;
  today: string;
  suppliers: Supplier[];
  truncated: { suppliers: boolean };
  id?: string;
  prices?: SupplierPrice[];
  prices_truncated?: boolean;
};
export type RequestLine = {
  ingredient_id: string;
  name: string | null;
  unit: string;
  qty: string;
  balance_at_request: string;
  hint: string | null;
  price_minor: string | null;
};
type RequestCommon = {
  id: string;
  number: number;
  kind: RequestKind;
  state: RequestState;
  supplier: { id: string; name: string; kind: SupplierKind; active: boolean } | null;
  needed_by: string | null;
  note: string | null;
  total_minor: string | null;
  unpriced_lines: number | null;
  receipt_document_id: string | null;
  revision: number;
  created_by_name: string | null;
  created_at: string;
  submitted_by_name: string | null;
  submitted_at: string | null;
  closed_by_name: string | null;
  closed_at: string | null;
  cancel_reason: string | null;
};
export type SupplyRequest = RequestCommon & { lines: RequestLine[] };
export type SupplyRequestRow = RequestCommon & {
  line_count: number;
  line_names: (string | null)[];
};
export type SupplyDifference = {
  ingredient_id: string;
  name: string | null;
  unit: string | null;
  requested: string;
  received: string;
  difference: string;
};
export type SupplyReceipt = {
  id: string;
  reference: string;
  document_date: string | null;
  supplier_kind: string | null;
  supplier_name: string | null;
  created_at: string;
  actor_name: string | null;
  lines: {
    ingredient_id: string;
    name: string | null;
    unit: string | null;
    quantity: string;
    value_minor: string;
  }[];
  total_minor: string;
};
export type SupplyRequestsView = {
  schema_version: 1;
  branch_id: string;
  today: string;
  start_date: string;
  end_date: string;
  requests: SupplyRequestRow[];
  counts: Record<RequestState, number>;
  open: { draft: number; submitted: number };
  truncated: { requests: boolean };
  id?: string;
  request?: SupplyRequest;
  text?: string;
  receipt?: SupplyReceipt | null;
  difference?: SupplyDifference[] | null;
};

/** The section of the cabinet (after «Остатки»), only with capabilities.supply. */
export const SUPPLY_SECTION = [
  'supply',
  'Закупки',
  'Заявки в цех, пекарню и поставщикам, поставщики и цены',
] as const;
export const REQUEST_KIND_LABELS: Record<RequestKind, string> = {
  central_kitchen: 'В цех',
  bakery: 'В пекарню',
  household: 'Хозтовары',
  supplier: 'Поставщику',
};
export const REQUEST_KINDS = Object.keys(REQUEST_KIND_LABELS) as RequestKind[];
export const REQUEST_STATE_LABELS: Record<RequestState, string> = {
  draft: 'Черновик',
  submitted: 'Подана',
  received: 'Получена',
  cancelled: 'Отменена',
};
export const REQUEST_STATES = Object.keys(REQUEST_STATE_LABELS) as RequestState[];
export const SUPPLIER_KIND_LABELS: Record<SupplierKind, string> = {
  supplier: 'Поставщик',
  central_kitchen: 'Цех',
  bakery: 'Пекарня',
};
export const SUPPLIER_KINDS = Object.keys(SUPPLIER_KIND_LABELS) as SupplierKind[];
/** Who delivers a request of a kind (the server rule of cloud076). */
export const supplierKindFor = (kind: RequestKind): SupplierKind =>
  kind === 'central_kitchen' || kind === 'bakery' ? kind : 'supplier';
/** The words on top of «Заявки»: the system sends nothing. */
export const SUPPLY_BANNER =
  'Заявка сама ничего не отправляет: после подачи распечатайте её или скопируйте текст и отправьте в мессенджере.';
export const NAME_MAX = 120;
export const NOTE_MAX = 500;
export const LINES_MAX = 100;
/** At most 92 days in one list (the server limit). */
export const WINDOW_DAYS = 92;

const isObject = (v: unknown): v is Data =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);
function invalid(): never {
  throw new Error('INVALID_RESPONSE');
}
/** GET .../ops/suppliers as the page reads it; anything else is an invalid answer. */
export function suppliersView(value: unknown, branch: string): SuppliersView {
  if (
    !isObject(value) ||
    value['schema_version'] !== 1 ||
    value['branch_id'] !== branch ||
    value['view'] !== 'suppliers' ||
    typeof value['today'] !== 'string' ||
    !Array.isArray(value['suppliers']) ||
    !isObject(value['truncated']) ||
    (value['prices'] !== undefined && !Array.isArray(value['prices']))
  )
    invalid();
  for (const s of value['suppliers'] as unknown[])
    if (
      !isObject(s) ||
      typeof s['id'] !== 'string' ||
      typeof s['name'] !== 'string' ||
      !SUPPLIER_KINDS.includes(s['kind'] as SupplierKind) ||
      typeof s['revision'] !== 'number'
    )
      invalid();
  for (const p of (value['prices'] ?? []) as unknown[])
    if (
      !isObject(p) ||
      typeof p['ingredient_id'] !== 'string' ||
      !/^[1-9][0-9]*$/.test(String(p['price_minor'])) ||
      typeof p['valid_from'] !== 'string' ||
      typeof p['revision'] !== 'number'
    )
      invalid();
  return value as SuppliersView;
}
/** GET .../ops/supply-requests as the page reads it; anything else is an invalid answer. */
export function supplyRequestsView(value: unknown, branch: string): SupplyRequestsView {
  if (
    !isObject(value) ||
    value['schema_version'] !== 1 ||
    value['branch_id'] !== branch ||
    value['view'] !== 'supply-requests' ||
    !Array.isArray(value['requests']) ||
    !isObject(value['counts']) ||
    !isObject(value['open']) ||
    (value['request'] !== undefined && !isObject(value['request']))
  )
    invalid();
  for (const r of [
    ...(value['requests'] as unknown[]),
    ...(value['request'] ? [value['request']] : []),
  ])
    if (
      !isObject(r) ||
      typeof r['id'] !== 'string' ||
      typeof r['number'] !== 'number' ||
      !REQUEST_KINDS.includes(r['kind'] as RequestKind) ||
      !REQUEST_STATES.includes(r['state'] as RequestState) ||
      typeof r['revision'] !== 'number'
    )
      invalid();
  const one = value['request'];
  if (isObject(one) && !Array.isArray(one['lines'])) invalid();
  return value as SupplyRequestsView;
}

// ---------------------------------------------------------------------------- words ----

export const UNIT_LABELS: Record<string, string> = {
  g: 'г',
  kg: 'кг',
  ml: 'мл',
  l: 'л',
  pcs: 'шт',
};
/** Purchase units of an ingredient: the larger first (prices are usually per kg or l). */
export function priceUnits(base: string): string[] {
  return base === 'g' ? ['kg', 'g'] : base === 'ml' ? ['l', 'ml'] : ['pcs'];
}
/** «2 500 ₸ за 1 кг». */
export const priceText = (p: { price_minor: string; unit: string }) =>
  `${tenge(p.price_minor)} за 1 ${UNIT_LABELS[p.unit] ?? p.unit}`;
const FACTOR: Record<string, bigint> = { g: 1n, kg: 1000n, ml: 1n, l: 1000n, pcs: 1n };
/** The expected amount of a line in tiyn: quantity × price, half up, once (the server rule). */
export function expectedAmount(qty: string, price: string, unit: string): bigint {
  const factor = FACTOR[unit] ?? 1n;
  return (2n * BigInt(qty) * BigInt(price) + factor) / (2n * factor);
}
/** «минимум - остаток», never below zero; null without a minimum (the server rule). */
export function hintOf(minimum: unknown, balance: unknown): string | null {
  const m = BigInt(/^\d+$/.test(String(minimum ?? '')) ? String(minimum) : '0');
  if (m <= 0n) return null;
  const b = BigInt(/^\d+$/.test(String(balance ?? '')) ? String(balance) : '0');
  return (m > b ? m - b : 0n).toString();
}
/** «20.11.2026» from «2026-11-20». */
export const dmy = (day: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '-';
};
/** The state of a request in words; the colour of the badge only repeats it. */
export function requestStateText(r: Pick<RequestCommon, 'state' | 'needed_by'>, today: string) {
  const label = REQUEST_STATE_LABELS[r.state];
  if (r.state === 'submitted' && r.needed_by && r.needed_by < today)
    return `${label}, срок прошёл ${dmy(r.needed_by)}`;
  return label;
}
export function linesText(r: SupplyRequestRow): string {
  if (!r.line_count) return 'Строк нет';
  const names = r.line_names.map((n) => n ?? 'Позиция').join(', ');
  const more = r.line_count - r.line_names.length;
  return `${r.line_count} поз.: ${names}${more > 0 ? ` и ещё ${more}` : ''}`;
}
/** The expected amount of a request in words, or why there is none. */
export function totalText(r: Pick<RequestCommon, 'total_minor' | 'unpriced_lines' | 'supplier'>) {
  if (!r.supplier) return 'Без поставщика';
  if (r.total_minor === null) return 'Нет цен поставщика';
  return `${tenge(r.total_minor)}${r.unpriced_lines ? `, без цены: ${r.unpriced_lines} поз.` : ''}`;
}
/** «-0,5 кг», «+20 шт», «0 шт». */
export function differenceText(value: string, unit: string | null): string {
  const n = BigInt(value);
  const text = displayQuantity(n < 0n ? -n : n, unit ?? 'pcs');
  return n < 0n ? `-${text}` : n > 0n ? `+${text}` : text;
}
/** The actions a role may see on a request, in order (the page explains the missing ones). */
export function requestActions(r: Pick<RequestCommon, 'state'>) {
  return {
    edit: r.state === 'draft',
    submit: r.state === 'draft',
    receive: r.state === 'submitted',
    cancel: r.state === 'draft' || r.state === 'submitted',
  };
}

// ---------------------------------------------------------------------------- forms ----

type StockRow = Data;
const payloadOf = (row: StockRow) => (isObject(row['payload']) ? row['payload'] : {});
/** Active ingredients of the snapshot, by name (the request editor offers them). */
export function requestIngredients(stock: readonly StockRow[]) {
  return stock
    .filter((r) => payloadOf(r)['active'] === true)
    .map((r) => {
      const p = payloadOf(r);
      return {
        id: String(r['id']),
        name: String(p['name'] ?? ''),
        unit: String(p['unit'] ?? 'pcs'),
        minimum: String(p['minimum'] ?? '0'),
        balance: String(r['quantity'] ?? '0'),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
export type RequestFormLine = { ingredient_id: string; quantity: string; unit: string };
export type RequestForm = {
  kind: RequestKind;
  supplier_id: string;
  needed_by: string;
  note: string;
  lines: RequestFormLine[];
};
export const shiftDay = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export function emptyRequestForm(kind: RequestKind, today: string): RequestForm {
  return { kind, supplier_id: '', needed_by: shiftDay(today, 1), note: '', lines: [] };
}
/** A base quantity as the editor shows it: kg or l when it divides into whole thousandths. */
function editorQuantity(qty: string, base: string): { quantity: string; unit: string } {
  if ((base === 'g' || base === 'ml') && BigInt(qty) >= 1000n) {
    const n = BigInt(qty);
    const fraction = (n % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
    return {
      quantity: `${n / 1000n}${fraction ? ',' + fraction : ''}`,
      unit: base === 'g' ? 'kg' : 'l',
    };
  }
  return { quantity: qty, unit: base };
}
export function requestFormOf(r: SupplyRequest): RequestForm {
  return {
    kind: r.kind,
    supplier_id: r.supplier?.id ?? '',
    needed_by: r.needed_by ?? '',
    note: r.note ?? '',
    lines: r.lines.map((l) => ({
      ingredient_id: l.ingredient_id,
      ...editorQuantity(l.qty, l.unit),
    })),
  };
}
/** Lines for every active ingredient below its minimum that the form does not have yet. */
export function belowMinimumLines(
  form: RequestForm,
  stock: readonly StockRow[],
): RequestFormLine[] {
  const have = new Set(form.lines.map((l) => l.ingredient_id));
  return requestIngredients(stock)
    .filter((i) => !have.has(i.id))
    .map((i) => ({ i, hint: hintOf(i.minimum, i.balance) }))
    .filter(({ hint }) => hint !== null && hint !== '0')
    .map(({ i, hint }) => ({ ingredient_id: i.id, ...editorQuantity(hint!, i.unit) }));
}
export const REQUEST_FORM_ERRORS = {
  line: 'Выберите позицию в каждой строке и укажите количество больше нуля: в граммах, миллилитрах или штуках целым числом, в кг и л - не больше трёх знаков после запятой.',
  repeated: 'Позиция повторяется. Объедините её в одну строку.',
  many: 'В одной заявке - не больше 100 строк.',
  note: 'Примечание - не длиннее 500 символов.',
  date: 'Укажите дату «Нужно к».',
  past: 'Дата «Нужно к» не может быть раньше сегодняшней.',
  supplier: 'Выберите поставщика: это заявка поставщику.',
  empty: 'Добавьте хотя бы одну строку.',
};
/**
 * The supply_request_save payload of the form, or the reasons in words why it is not valid. A
 * draft may be empty and without a date; `submit` also checks what a submission needs.
 */
export function requestPayload(
  form: RequestForm,
  stock: readonly StockRow[],
  today: string,
  submit = false,
): { payload: Data; errors: [] } | { payload: null; errors: string[] } {
  const errors: string[] = [];
  const items = new Map(requestIngredients(stock).map((i) => [i.id, i]));
  const seen = new Set<string>();
  const lines: { ingredient_id: string; qty: string }[] = [];
  let bad = false;
  for (const l of form.lines) {
    const item = items.get(l.ingredient_id);
    if (!item) {
      bad = true;
      continue;
    }
    if (seen.has(item.id)) {
      if (!errors.includes(REQUEST_FORM_ERRORS.repeated)) errors.push(REQUEST_FORM_ERRORS.repeated);
      continue;
    }
    seen.add(item.id);
    try {
      const qty = stockQuantity(l.quantity, l.unit, item.unit);
      if (BigInt(qty) <= 0n) throw new Error('zero');
      lines.push({ ingredient_id: item.id, qty });
    } catch {
      bad = true;
    }
  }
  if (bad) errors.unshift(REQUEST_FORM_ERRORS.line);
  if (form.lines.length > LINES_MAX) errors.push(REQUEST_FORM_ERRORS.many);
  const note = form.note.trim();
  if (note.length > NOTE_MAX) errors.push(REQUEST_FORM_ERRORS.note);
  const neededBy = form.needed_by.trim();
  if (neededBy && neededBy < today) errors.push(REQUEST_FORM_ERRORS.past);
  if (submit) {
    if (!form.lines.length) errors.push(REQUEST_FORM_ERRORS.empty);
    if (!neededBy) errors.push(REQUEST_FORM_ERRORS.date);
    if (form.kind === 'supplier' && !form.supplier_id) errors.push(REQUEST_FORM_ERRORS.supplier);
  }
  if (errors.length) return { payload: null, errors };
  return {
    payload: {
      kind: form.kind,
      supplier_id: form.supplier_id || null,
      needed_by: neededBy || null,
      note: note || null,
      lines,
    },
    errors: [],
  };
}
/** The expected amount of one editor line by a price in force, or null. */
export function lineEstimate(
  line: RequestFormLine,
  base: string,
  price: { price_minor: string; unit: string } | undefined,
): string | null {
  if (!price) return null;
  try {
    const qty = stockQuantity(line.quantity, line.unit, base);
    const amount = expectedAmount(qty, price.price_minor, price.unit);
    return amount > 0n ? amount.toString() : null;
  } catch {
    return null;
  }
}
/** The prices in force of a supplier detail, by ingredient (the newest valid_from wins). */
export function pricesInForce(view: SuppliersView | null): Map<string, SupplierPrice> {
  const out = new Map<string, SupplierPrice>();
  for (const p of view?.prices ?? [])
    if (p.in_force) {
      const old = out.get(p.ingredient_id);
      if (!old || p.valid_from > old.valid_from) out.set(p.ingredient_id, p);
    }
  return out;
}

export type ReceiveForm = {
  reference: string;
  document_date: string;
  lines: { ingredient_id: string; quantity: string; unit: string; cost: string }[];
  reviewed: boolean;
};
/** The receipt dialog of a request: every requested line with its quantity, costs empty. */
export function receiveFormOf(r: SupplyRequest, today: string): ReceiveForm {
  return {
    reference: '',
    document_date: today,
    lines: r.lines.map((l) => ({
      ingredient_id: l.ingredient_id,
      ...editorQuantity(l.qty, l.unit),
      cost: '',
    })),
    reviewed: false,
  };
}
export const RECEIVE_ERRORS = {
  reference: 'Укажите номер накладной.',
  date: 'Укажите дату накладной.',
  reviewed: 'Проверьте документ и отметьте подтверждение.',
};
/**
 * The supply_request_receive lines of the dialog, the stock preview and the difference with the
 * request; throws a Russian message the dialog shows as is (the stock dialog rules).
 */
export function receivePreview(form: ReceiveForm, r: SupplyRequest, stock: readonly StockRow[]) {
  const preview = stockPreview('receipt', form.lines, [...stock]);
  const received = new Map(preview.map((p) => [p.command.ingredient_id, p]));
  const difference: SupplyDifference[] = r.lines.map((l) => {
    const got = received.get(l.ingredient_id);
    const q = got ? BigInt(got.command.quantity) : 0n;
    return {
      ingredient_id: l.ingredient_id,
      name: l.name,
      unit: l.unit,
      requested: l.qty,
      received: q.toString(),
      difference: (q - BigInt(l.qty)).toString(),
    };
  });
  for (const p of preview)
    if (!r.lines.some((l) => l.ingredient_id === p.command.ingredient_id))
      difference.push({
        ingredient_id: p.command.ingredient_id,
        name: p.name,
        unit: p.unit,
        requested: '0',
        received: p.command.quantity,
        difference: p.command.quantity,
      });
  return { preview, difference, lines: preview.map((p) => p.command) };
}
/** Whether a receipt differs from its request (a partial or a changed delivery). */
export const partial = (difference: readonly SupplyDifference[]) =>
  difference.some((d) => d.difference !== '0');

export type PriceForm = { ingredient_id: string; unit: string; price: string; valid_from: string };
export const PRICE_ERRORS = {
  ingredient: 'Выберите позицию.',
  unit: 'Выберите единицу цены.',
  price: 'Цена - больше 0 ₸, не больше двух знаков после запятой.',
  date: 'Укажите, с какого дня действует цена.',
};
export function pricePayload(
  form: PriceForm,
  stock: readonly StockRow[],
): { payload: Data; errors: [] } | { payload: null; errors: string[] } {
  const errors: string[] = [];
  const item =
    requestIngredients(stock).find((i) => i.id === form.ingredient_id) ??
    stock
      .filter((r) => String(r['id']) === form.ingredient_id)
      .map((r) => ({ id: String(r['id']), unit: String(payloadOf(r)['unit'] ?? 'pcs') }))[0];
  if (!item) errors.push(PRICE_ERRORS.ingredient);
  if (item && !priceUnits(item.unit).includes(form.unit)) errors.push(PRICE_ERRORS.unit);
  let price = '';
  try {
    // «2 500,50» as people type it: the spaces of the groups are not part of the number.
    price = stockMoney(form.price.replace(/[\s\u00a0]/g, ''));
    if (BigInt(price) <= 0n) throw new Error('zero');
  } catch {
    errors.push(PRICE_ERRORS.price);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.valid_from)) errors.push(PRICE_ERRORS.date);
  if (errors.length) return { payload: null, errors };
  return {
    payload: {
      ingredient_id: form.ingredient_id,
      unit: form.unit,
      price_minor: price,
      valid_from: form.valid_from,
    },
    errors: [],
  };
}
/** «2 500,50» from 250050 tiyn (the price field of a correction). */
export const tengeInput = (minor: string) => {
  const n = BigInt(minor);
  const part = n % 100n;
  return `${n / 100n}${part ? ',' + part.toString().padStart(2, '0') : ''}`;
};
export const SUPPLIER_ERRORS = {
  name: 'Введите название поставщика: от 1 до 120 символов, в одну строку.',
};
export function supplierPayload(name: string, kind: SupplierKind, active: boolean) {
  const clean = name.replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (!clean || clean.length > NAME_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(clean))
    return { payload: null, errors: [SUPPLIER_ERRORS.name] };
  return { payload: { name: clean, kind, active }, errors: [] as string[] };
}

// ------------------------------------------------------------------------- commands ----

export const supplierSaveCommand = (id: string, revision: number, payload: Data) => ({
  type: 'supplier_save',
  id,
  expected_revision: revision,
  payload,
});
export const priceSaveCommand = (supplier: string, revision: number, payload: Data) => ({
  type: 'supplier_price_save',
  supplier_id: supplier,
  ...payload,
  expected_revision: revision,
});
export const requestSaveCommand = (id: string, revision: number, payload: Data) => ({
  type: 'supply_request_save',
  id,
  expected_revision: revision,
  payload,
});
export const submitCommand = (id: string, revision: number) => ({
  type: 'supply_request_submit',
  id,
  expected_revision: revision,
});
export const cancelCommand = (id: string, revision: number) => ({
  type: 'supply_request_cancel',
  id,
  expected_revision: revision,
});
export const receiveCommand = (
  id: string,
  revision: number,
  form: Pick<ReceiveForm, 'reference' | 'document_date'>,
  lines: Data[],
) => ({
  type: 'supply_request_receive',
  id,
  expected_revision: revision,
  reference: form.reference.trim(),
  document_date: form.document_date,
  lines,
});
/** The server reasons of the supply commands in words (the generic text otherwise). */
export const SUPPLY_ERRORS: Record<string, string> = {
  SUPPLIER_NAME_TAKEN:
    'Поставщик с таким названием уже есть (возможно, в архиве). Выберите другое название.',
  SUPPLIER_INACTIVE:
    'Поставщик в архиве: на него нельзя оформить заявку или новую цену. Верните его из архива или выберите другого.',
  PRICE_UNIT_MISMATCH:
    'Единица цены не подходит к позиции: для граммов - г или кг, для миллилитров - мл или л, для штук - шт.',
  REQUEST_LOCKED:
    'Заявку уже подали, приняли или отменили в другом окне. Обновите список и проверьте её.',
  REQUEST_INCOMPLETE:
    'Чтобы подать заявку, нужны строки, дата «Нужно к» не раньше сегодняшней и, для заявки поставщику, поставщик.',
  CONFLICT: 'Данные изменились в другом окне или остатки уже другие. Обновите и проверьте ещё раз.',
  NOT_FOUND: 'Запись не найдена. Обновите список.',
  NOT_READY: 'Закупки пока недоступны на сервере. Обновите страницу позже.',
  INSUFFICIENT_STOCK: 'Остаток не может стать меньше нуля. Проверьте количества.',
};
/** Statuses with a word and a class (the colour is only an addition). */
export const stateClass = (state: RequestState) => `sp-state sp-state-${state}`;
/** The CSV of the shown list (tenge with the column «Сумма, ₸», like every export). */
export function requestsCsv(view: SupplyRequestsView): string[][] {
  return [
    ['№', 'Создана', 'Куда', 'Поставщик', 'Нужно к', 'Состояние', 'Строк', 'Сумма, ₸'],
    ...view.requests.map((r) => [
      String(r.number),
      almatyTime(r.created_at),
      REQUEST_KIND_LABELS[r.kind],
      csvTextCell(r.supplier?.name ?? ''),
      r.needed_by ? dmy(r.needed_by) : '',
      REQUEST_STATE_LABELS[r.state],
      String(r.line_count),
      r.total_minor === null ? '' : csvTenge(r.total_minor),
    ]),
  ];
}
