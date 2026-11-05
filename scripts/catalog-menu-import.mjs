#!/usr/bin/env node
/**
 * Real menu import for the 19.11.2026 cutover (contracts CC-1, design-catalog section 3.3).
 *
 *   node scripts/catalog-menu-import.mjs build --dir <sheets> --out <new dir>
 *        [--current <catalog.json>] [--edge <edge-menu.json>]
 *   node scripts/catalog-menu-import.mjs save --manifest <manifest.json> --reviewed-by "<name>"
 *        --branch <uuid> --token-file <credential.json> [--api <base>]
 *   node scripts/catalog-menu-import.mjs publish --manifest <manifest.json> --parity <report.json>
 *        --branch <uuid> --token-file <credential.json> [--api <base>]
 *
 * build    reads the manager's sheets (UTF-8 TSV: positions, groups, rules, components, catalog;
 *          the checked-in starting point is packages/catalog-admin/fixtures/real-menu-2026-11)
 *          and writes payload.json, review.md (Russian report for the manager), manifest.json
 *          (SHA-256 of every input and output, errors[]) and, with --edge, the reviewed list
 *          expected-edge-changes.json for `catalog-edge-parity --allow`. No network, no database.
 *          --current is the catalog published now (admin state, public catalog or bare payload):
 *          the report shows "было -> стало" and every published slug must stay.
 * save     the only step that sets content_reviewed:true: PUT of the built payload as the draft,
 *          request_id derived from the manifest SHA-256. A repeat after success changes nothing.
 * publish  POST publish (confirmation publish_catalog) of exactly that saved draft, only with a
 *          passing `catalog-edge-parity --allow` report for the same payload and edge menu.
 *
 * Money: whole tenge in the sheets, integer tiyn strings in the payload, never floats.
 * The API base is local by default (http://127.0.0.1:3100); plain HTTP only to loopback.
 * The token is read from the private credential file and never printed or written anywhere.
 * Exit 0: done. Exit 1: refused (errors in the sheets, checks or API answer). Exit 2: usage.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_ASSET_KEYS,
  CatalogCredentialSchema,
  CatalogPayloadSchema,
  CatalogStateSchema,
  assertCatalogPublishable,
} from '@pickchick/catalog-admin/contracts';
import { MenuSnapshotSchema } from '@pickchick/contracts';
import { projectCatalogMenu } from '@pickchick/menu-sync';
import {
  ParityInputError,
  catalogEdgeParity,
  catalogInput,
  edgePayloadHash,
  expectedEdgeChanges,
} from './catalog-edge-parity.mjs';

export const MANIFEST_SCHEMA = 'pickchick.catalog-menu-import/v1';
/** Design-catalog risk 2: the payload limit (256 KiB) is also built into installed clients. */
export const PAYLOAD_BUDGET_BYTES = 230 * 1024;
export const DEFAULT_API = 'http://127.0.0.1:3100';
/** Sanity bounds against a value typed in tiyn instead of tenge (x100). */
export const MAX_ITEM_TENGE = 100_000n;
export const MAX_DELTA_TENGE = 10_000n;
/**
 * The 24 slugs of the published mockup menu (v11). Installed kiosk and mobile builds key photos,
 * hits, upsell and the 7+1 gift (pick-combo) on them, and cashier identities are their hashes:
 * none may disappear. Frozen here on purpose: a later seed change must not move the guard.
 */
export const LEGACY_SLUGS = Object.freeze([
  'pick-combo',
  'master-combo',
  'burger-combo',
  'solo-combo',
  'finger-duo',
  'burger-duo',
  'mix-duo',
  'fingers-25',
  'fingers-50',
  'fingers-75',
  'fingers-100',
  'fingers',
  'sauce',
  'sauce-hot',
  'toast',
  'coleslaw',
  'wedges',
  'burger',
  'lemonade',
  'cola',
  'fuse-peach',
  'iced-tea',
  'water',
  'piko',
]);
/**
 * The six categories installed clients understand by their Russian name (kiosk rail, mobile
 * sections; "Соусы" falls into the kiosk extras). Ids keep the v11 ones; payload order is this.
 */
export const CATEGORIES = Object.freeze([
  { id: 'category-1', ru: 'Комбо' },
  { id: 'category-2', ru: 'На двоих' },
  { id: 'category-3', ru: 'На компанию' },
  { id: 'category-4', ru: 'Допы' },
  { id: 'category-6', ru: 'Соусы' },
  { id: 'category-5', ru: 'Напитки' },
]);
export const SHEETS = Object.freeze({
  positions: {
    file: 'positions.tsv',
    title: 'Позиции',
    columns: [
      'slug',
      'iiko_sku',
      'iiko_name',
      'category',
      'kind',
      'name_ru',
      'name_kk',
      'price_tenge',
      'serving_ru',
      'serving_kk',
      'weight_g',
      'volume_ml',
      'kitchen_route',
      'prep_minutes',
      'image_asset_key',
      'photo',
      'description_ru',
      'description_kk',
      'ingredients_ru',
      'ingredients_kk',
      'yandex_price_tenge',
      'glovo_price_tenge',
      'status',
      'unconfirmed',
      'comment',
    ],
  },
  groups: {
    file: 'groups.tsv',
    title: 'Группы выбора',
    columns: [
      'group_id',
      'title_ru',
      'title_kk',
      'option_id',
      'iiko_sku',
      'iiko_name',
      'label_ru',
      'label_kk',
      'delta_tenge',
      'unconfirmed',
      'comment',
    ],
  },
  rules: {
    file: 'rules.tsv',
    title: 'Правила комбо',
    columns: [
      'product_slug',
      'group_id',
      'title_ru',
      'title_kk',
      'min',
      'max',
      'default_option_id',
      'default_qty',
      'unconfirmed',
      'comment',
    ],
  },
  components: {
    file: 'components.tsv',
    title: 'Состав комбо',
    columns: ['product_slug', 'component_slug', 'quantity', 'comment'],
  },
  catalog: { file: 'catalog.tsv', title: 'Каталог', columns: ['key', 'value', 'comment'] },
});
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHOTO = ['есть', 'временное', 'нет'];
const STATUS = ['', 'ок', 'исправить'];
const KINDS = ['item', 'combo', 'set'];
const ROUTES = ['prep', 'assembly_item'];
const CATALOG_KEYS = ['estimated_minutes_min', 'estimated_minutes_max', 'upsell_product_ids'];
/** Branch and release used only to prove the projection when no edge menu is given. */
const CHECK_BRANCH = '00000000-0000-4000-8000-000000000001';
const CHECK_RELEASE = '00000000-0000-4000-8000-000000000000';
const CHECK_PUBLISHED_AT = '2026-11-19T00:00:00.000Z';

export class ImportError extends Error {
  constructor(code, detail) {
    super(detail ?? code);
    this.code = code;
    this.detail = detail ?? code;
  }
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/** Same schema-ordered encoding as the cloud draft payload_hash and catalogPayloadHash. */
export const payloadHash = (payload) => sha256(JSON.stringify(CatalogPayloadSchema.parse(payload)));
/** Deterministic request id (UUID v5 layout) for one command of one built manifest. */
export function requestIdFor(manifestSha256, kind) {
  const h = sha256(`${manifestSha256}:${kind}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Whole tenge from a sheet cell to integer tiyn. "3690", "3 690", "3690,00" pass; "3690,5" does not. */
export function tengeToMinor(value, { allowZero = false, max = MAX_ITEM_TENGE } = {}) {
  const text = String(value ?? '').trim();
  const match = /^(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,](\d+))?$/.exec(text);
  if (!match) throw new ImportError('PRICE_INVALID', `«${text}» - не число тенге`);
  const whole = match[1].replace(/[ \u00a0\u202f]/g, '');
  if (match[2] && /[1-9]/.test(match[2]))
    throw new ImportError('PRICE_NOT_WHOLE_TENGE', `«${text}» - только целые тенге`);
  if (whole.length > 1 && whole.startsWith('0'))
    throw new ImportError('PRICE_INVALID', `«${text}» - число с ведущим нулём`);
  const tenge = BigInt(whole);
  if (tenge === 0n && !allowZero) throw new ImportError('PRICE_INVALID', 'цена 0');
  if (tenge > max)
    throw new ImportError('PRICE_IMPLAUSIBLE', `«${text}» ₸ больше ${max} ₸ - цена в тиынах?`);
  return (tenge * 100n).toString();
}

/** C0 control characters and DEL; a tab is allowed only where the caller says so. */
const hasControl = (value, allowTab = false) =>
  [...value].some((char) => {
    const code = char.charCodeAt(0);
    return (code < 0x20 && !(allowTab && code === 0x09)) || code === 0x7f;
  });

/** Tab-separated sheet as exported by Google Sheets or Excel (UTF-8), quoted cells allowed. */
export function parseTsv(input, sheet) {
  const spec = SHEETS[sheet];
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
    throw new ImportError('TSV_ENCODING', `${spec.file}: UTF-16, сохраните лист как UTF-8 TSV`);
  let text = bytes.toString('utf8');
  if (text.startsWith('\ufeff')) text = text.slice(1);
  if (text.includes('\u0000') || text.includes('\ufffd'))
    throw new ImportError('TSV_ENCODING', `${spec.file}: файл не в UTF-8`);
  const records = [];
  let row = [],
    cell = '',
    quoted = false,
    line = 1,
    start = 1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else {
        if (char === '\n') line++;
        cell += char;
      }
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === '\t') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      records.push({ line: start, cells: row });
      row = [];
      cell = '';
      line++;
      start = line;
    } else cell += char;
  }
  if (quoted) throw new ImportError('TSV_ROW', `${spec.file}: незакрытая кавычка`);
  if (cell !== '' || row.length) {
    row.push(cell);
    records.push({ line: start, cells: row });
  }
  const meaningful = records.filter((record) => record.cells.some((value) => value.trim() !== ''));
  const [header, ...rows] = meaningful;
  const names = header?.cells.map((value) => value.trim()) ?? [];
  if (names.join('\t') !== spec.columns.join('\t'))
    throw new ImportError(
      'TSV_HEADER',
      `${spec.file}: заголовок должен быть «${spec.columns.join(', ')}»`,
    );
  return rows.map((record) => {
    if (record.cells.length !== spec.columns.length)
      throw new ImportError(
        'TSV_ROW',
        `${spec.file}, строка ${record.line}: ${record.cells.length} ячеек вместо ${spec.columns.length}`,
      );
    const values = Object.fromEntries(
      spec.columns.map((column, index) => [column, record.cells[index].trim()]),
    );
    // A tab inside a quoted cell is text; any other control character is a broken export.
    if (Object.values(values).some((value) => hasControl(value, true)))
      throw new ImportError('TSV_ROW', `${spec.file}, строка ${record.line}: управляющий символ`);
    return { line: record.line, ...values };
  });
}

const intIn = (value, min, max) => {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
};

/**
 * Pure build from parsed sheets. Returns the payload (or null), every error, the expected edge
 * changes (with an edge menu) and what the review report needs. Never throws on sheet content.
 */
export function buildMenu(sheets, { current = null, edge = null } = {}) {
  const errors = [];
  const fail = (code, at, detail) => errors.push({ code, ...at, detail });
  const capture = (at, run) => {
    try {
      return run();
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
      fail(error.code, at, error.detail);
      return null;
    }
  };
  const where = (sheet, row, field) => ({
    sheet: SHEETS[sheet].file,
    line: row.line,
    ...(field ? { field } : {}),
  });
  const categories = new Map(CATEGORIES.map((category) => [category.ru, category]));
  // Positions
  const products = [],
    bySlug = new Map(),
    skus = new Map();
  for (const row of sheets.positions) {
    const at = (field) => where('positions', row, field);
    if (!SLUG.test(row.slug)) fail('SLUG_INVALID', at('slug'), `«${row.slug}»`);
    else if (bySlug.has(row.slug)) fail('SLUG_DUPLICATE', at('slug'), row.slug);
    if (row.iiko_sku && !/^\d{5}$/.test(row.iiko_sku))
      fail('SKU_INVALID', at('iiko_sku'), `«${row.iiko_sku}»`);
    else if (row.iiko_sku && skus.has(row.iiko_sku))
      fail('SKU_DUPLICATE', at('iiko_sku'), `${row.iiko_sku}: ${skus.get(row.iiko_sku)}`);
    if (row.iiko_sku) skus.set(row.iiko_sku, row.slug);
    if (!categories.has(row.category))
      fail('CATEGORY_UNKNOWN', at('category'), `«${row.category}»`);
    if (!KINDS.includes(row.kind)) fail('KIND_INVALID', at('kind'), `«${row.kind}»`);
    if (row.kind === 'combo' && !/-(combo|duo)$/.test(row.slug))
      fail('COMBO_SUFFIX', at('slug'), `${row.slug}: у комбо slug оканчивается на -combo или -duo`);
    if (!row.name_ru || row.name_ru.length > 150) fail('NAME_INVALID', at('name_ru'), row.slug);
    if (row.name_kk.length > 150) fail('NAME_INVALID', at('name_kk'), row.slug);
    if (!row.serving_ru || row.serving_ru.length > 150 || row.serving_kk.length > 150)
      fail('SERVING_INVALID', at('serving_ru'), row.slug);
    const price = capture(at('price_tenge'), () => tengeToMinor(row.price_tenge));
    const yandex = row.yandex_price_tenge
      ? capture(at('yandex_price_tenge'), () => tengeToMinor(row.yandex_price_tenge))
      : null;
    const glovo = row.glovo_price_tenge
      ? capture(at('glovo_price_tenge'), () => tengeToMinor(row.glovo_price_tenge))
      : null;
    const measure = (field) => {
      if (row[field] === '') return null;
      const value = intIn(row[field], 1, 100000);
      if (value === null)
        fail('MEASURE_INVALID', at(field), `«${row[field]}» - целое число или пусто`);
      return value;
    };
    const weight = measure('weight_g'),
      volume = measure('volume_ml');
    if (!ROUTES.includes(row.kitchen_route))
      fail('ROUTE_INVALID', at('kitchen_route'), `«${row.kitchen_route}»`);
    const prep = intIn(row.prep_minutes, 1, 120);
    if (prep === null) fail('PREP_INVALID', at('prep_minutes'), `«${row.prep_minutes}»`);
    if (!CATALOG_ASSET_KEYS.includes(row.image_asset_key))
      fail('IMAGE_KEY_INVALID', at('image_asset_key'), `«${row.image_asset_key}»`);
    if (!PHOTO.includes(row.photo)) fail('PHOTO_INVALID', at('photo'), `«${row.photo}»`);
    for (const field of ['description_ru', 'description_kk', 'ingredients_ru', 'ingredients_kk'])
      if (row[field].length > 2000) fail('TEXT_TOO_LONG', at(field), row.slug);
    if (!STATUS.includes(row.status)) fail('STATUS_INVALID', at('status'), `«${row.status}»`);
    if (row.status === 'исправить') fail('ROW_MARKED_FIX', at('status'), row.slug);
    const product = {
      row,
      price,
      yandex,
      glovo,
      payload: {
        id: row.slug,
        sku: row.slug,
        name: { ru: row.name_ru, kk: row.name_kk },
        description: { ru: row.description_ru, kk: row.description_kk },
        category_id: categories.get(row.category)?.id ?? 'category-1',
        price_minor: price ?? '0',
        image_asset_key: row.image_asset_key,
        available: true,
        prep_required: row.kitchen_route === 'prep',
        prep_minutes: prep ?? 1,
        serving_label: { ru: row.serving_ru, kk: row.serving_kk },
        weight_g: weight,
        volume_ml: volume,
        ingredients: { ru: row.ingredients_ru, kk: row.ingredients_kk },
        // Design-catalog 3.3: nothing verified is claimed (iiko holds zeros and no allergens).
        allergens: [],
        allergens_status: 'unknown',
        nutrition: { basis: 'per_serving', energy_kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
        nutrition_status: 'unverified',
        kind: KINDS.includes(row.kind) ? row.kind : 'item',
        combo_components: [],
        modifier_groups: [],
      },
    };
    products.push(product);
    if (SLUG.test(row.slug) && !bySlug.has(row.slug)) bySlug.set(row.slug, product);
  }
  if (products.length < 1 || products.length > 100)
    fail('PRODUCT_COUNT', { sheet: SHEETS.positions.file }, `${products.length} позиций (1..100)`);
  // Groups
  const groups = new Map();
  for (const row of sheets.groups) {
    const at = (field) => where('groups', row, field);
    if (!SLUG.test(row.group_id)) {
      fail('GROUP_INVALID', at('group_id'), `«${row.group_id}»`);
      continue;
    }
    let group = groups.get(row.group_id);
    if (!group) {
      group = {
        id: row.group_id,
        title: { ru: row.title_ru, kk: row.title_kk },
        options: [],
        rows: [],
      };
      groups.set(row.group_id, group);
      if (!row.title_ru || row.title_ru.length > 150 || row.title_kk.length > 150)
        fail('GROUP_TITLE_INVALID', at('title_ru'), row.group_id);
    } else if (group.title.ru !== row.title_ru || group.title.kk !== row.title_kk)
      fail(
        'GROUP_TITLE_MISMATCH',
        at('title_ru'),
        `${row.group_id}: у всех строк группы одно название`,
      );
    if (!SLUG.test(row.option_id)) fail('OPTION_INVALID', at('option_id'), `«${row.option_id}»`);
    else if (group.options.some((option) => option.id === row.option_id))
      fail('OPTION_DUPLICATE', at('option_id'), `${row.group_id}/${row.option_id}`);
    if (!row.label_ru || row.label_ru.length > 150 || row.label_kk.length > 150)
      fail('OPTION_LABEL_INVALID', at('label_ru'), `${row.group_id}/${row.option_id}`);
    if (row.iiko_sku && !/^\d{5}$/.test(row.iiko_sku))
      fail('SKU_INVALID', at('iiko_sku'), `«${row.iiko_sku}»`);
    const delta = capture(at('delta_tenge'), () =>
      tengeToMinor(row.delta_tenge, { allowZero: true, max: MAX_DELTA_TENGE }),
    );
    group.options.push({ id: row.option_id, label: { ru: row.label_ru, kk: row.label_kk }, delta });
    group.rows.push(row);
  }
  for (const group of groups.values())
    if (group.options.length > 20)
      fail(
        'GROUP_TOO_LARGE',
        { sheet: SHEETS.groups.file },
        `${group.id}: ${group.options.length} опций (до 20)`,
      );
  // Rules
  const seenRules = new Set();
  for (const row of sheets.rules) {
    const at = (field) => where('rules', row, field);
    const product = bySlug.get(row.product_slug),
      group = groups.get(row.group_id);
    if (!product) {
      fail('RULE_PRODUCT_UNKNOWN', at('product_slug'), `«${row.product_slug}»`);
      continue;
    }
    if (!group) {
      fail('RULE_GROUP_UNKNOWN', at('group_id'), `«${row.group_id}»`);
      continue;
    }
    const key = `${row.product_slug}/${row.group_id}`;
    if (seenRules.has(key)) {
      fail('RULE_DUPLICATE', at('group_id'), key);
      continue;
    }
    seenRules.add(key);
    const min = intIn(row.min, 0, 100),
      max = intIn(row.max, 1, 100),
      quantity = intIn(row.default_qty, 0, 40);
    if (min === null || max === null || min > max) {
      fail('RULE_RANGE', at('min'), `${key}: min ${row.min}, max ${row.max}`);
      continue;
    }
    if (quantity === null) {
      fail('RULE_DEFAULT_INVALID', at('default_qty'), `${key}: «${row.default_qty}»`);
      continue;
    }
    if (
      row.default_option_id &&
      !group.options.some((option) => option.id === row.default_option_id)
    )
      fail('RULE_DEFAULT_UNKNOWN', at('default_option_id'), `${key}: «${row.default_option_id}»`);
    if (!row.default_option_id && quantity > 0)
      fail('RULE_DEFAULT_INVALID', at('default_qty'), `${key}: количество без опции`);
    if (quantity > max) fail('RULE_DEFAULT_INVALID', at('default_qty'), `${key}: больше max`);
    // The schema needs the defaults to satisfy min (iiko has no defaults: design-catalog 3.3).
    if ((row.default_option_id ? quantity : 0) < min)
      fail(
        'RULE_DEFAULT_BELOW_MIN',
        at('default_qty'),
        `${key}: по умолчанию ${quantity}, min ${min}`,
      );
    // Optional per-product title (duo: "Напитки на выбор · 2 шт"); empty keeps the group title.
    if ((!row.title_ru && row.title_kk) || row.title_ru.length > 150 || row.title_kk.length > 150)
      fail('GROUP_TITLE_INVALID', at('title_ru'), key);
    const optionMax = Math.min(max, 40);
    product.payload.modifier_groups.push({
      id: group.id,
      title: row.title_ru ? { ru: row.title_ru, kk: row.title_kk } : group.title,
      min,
      max,
      options: group.options.map((option) => ({
        id: option.id,
        label: option.label,
        price_delta_minor: option.delta ?? '0',
        default_quantity: option.id === row.default_option_id ? quantity : 0,
        max_quantity: optionMax,
        available: true,
        linked_product_id: null,
      })),
    });
    product.rules = [...(product.rules ?? []), { row, group }];
  }
  for (const product of products)
    if (product.payload.modifier_groups.length > 10)
      fail(
        'PRODUCT_TOO_MANY_GROUPS',
        { sheet: SHEETS.rules.file },
        `${product.row.slug}: больше 10 групп`,
      );
  // Fixed combo components (M2, may stay empty for P0)
  for (const row of sheets.components) {
    const at = (field) => where('components', row, field);
    const product = bySlug.get(row.product_slug);
    const quantity = intIn(row.quantity, 1, 1000);
    if (!product || product.payload.kind === 'item')
      fail('COMPONENT_PRODUCT_INVALID', at('product_slug'), `«${row.product_slug}»`);
    else if (!bySlug.has(row.component_slug) || row.component_slug === row.product_slug)
      fail('COMPONENT_UNKNOWN', at('component_slug'), `«${row.component_slug}»`);
    else if (quantity === null) fail('COMPONENT_QUANTITY', at('quantity'), `«${row.quantity}»`);
    else if (product.payload.combo_components.some((c) => c.product_id === row.component_slug))
      fail(
        'COMPONENT_DUPLICATE',
        at('component_slug'),
        `${row.product_slug}/${row.component_slug}`,
      );
    else product.payload.combo_components.push({ product_id: row.component_slug, quantity });
  }
  // Catalog settings
  const settings = new Map();
  for (const row of sheets.catalog) {
    if (!CATALOG_KEYS.includes(row.key) || settings.has(row.key))
      fail('CATALOG_KEY', where('catalog', row, 'key'), `«${row.key}»`);
    else settings.set(row.key, { row, value: row.value });
  }
  for (const key of CATALOG_KEYS)
    if (!settings.has(key)) fail('CATALOG_KEY', { sheet: SHEETS.catalog.file }, `нет ${key}`);
  const etaMin = intIn(settings.get('estimated_minutes_min')?.value ?? '', 1, 120),
    etaMax = intIn(settings.get('estimated_minutes_max')?.value ?? '', 1, 120);
  if (
    settings.size === CATALOG_KEYS.length &&
    (etaMin === null || etaMax === null || etaMin > etaMax)
  )
    fail('CATALOG_ETA', { sheet: SHEETS.catalog.file }, 'estimated_minutes 1..120, min ≤ max');
  const upsell = (settings.get('upsell_product_ids')?.value ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const id of upsell)
    if (!bySlug.has(id)) fail('UPSELL_UNKNOWN', { sheet: SHEETS.catalog.file }, `«${id}»`);
  // Published slugs must stay (installed clients and cashier identities depend on them)
  const currentPayload = current?.payload ?? null;
  const kept = new Set([...LEGACY_SLUGS, ...(currentPayload?.products.map((p) => p.id) ?? [])]);
  for (const slug of kept)
    if (!bySlug.has(slug))
      fail(
        'EXISTING_SLUG_MISSING',
        { sheet: SHEETS.positions.file },
        `${slug} есть в опубликованном меню`,
      );
  if (current?.branchId && edge && current.branchId !== edge.branch_id)
    fail('BRANCH_MISMATCH', {}, 'текущий каталог и меню кассы - разные точки');
  // Assemble and check exactly as the cloud will
  let payload = null,
    bytes = null,
    expected = null,
    projected = null;
  if (!errors.length) {
    const used = new Set(products.map((product) => product.payload.category_id));
    const parsed = CatalogPayloadSchema.safeParse({
      schema_version: 1,
      currency: 'KZT',
      content_source: 'operator',
      content_reviewed: false,
      categories: CATEGORIES.filter((category) => used.has(category.id)).map((category) => ({
        id: category.id,
        name: { ru: category.ru, kk: '' },
      })),
      products: products.map((product) => product.payload),
      estimated_minutes: { min: etaMin, max: etaMax },
      upsell_product_ids: upsell,
    });
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        fail('SCHEMA_INVALID', {}, `${issue.path.join('.') || 'payload'}: ${issue.message}`);
    else {
      payload = parsed.data;
      bytes = Buffer.byteLength(JSON.stringify(payload));
      if (bytes > PAYLOAD_BUDGET_BYTES)
        fail('PAYLOAD_BUDGET', {}, `${bytes} байт больше ${PAYLOAD_BUDGET_BYTES}`);
      try {
        assertCatalogPublishable(payload, false);
      } catch (error) {
        fail('NOT_PUBLISHABLE', {}, error?.reason ?? error?.code ?? 'CONFLICT');
      }
      try {
        projected = projectCatalogMenu(
          payload,
          edge?.branch_id ?? CHECK_BRANCH,
          (edge?.version ?? 0) + 1,
          edge?.published_at ?? CHECK_PUBLISHED_AT,
          CHECK_RELEASE,
        );
      } catch (error) {
        fail('PROJECTION_FAILED', {}, error?.code ?? 'INVALID_MENU');
      }
      if (edge && !errors.length) {
        const report = catalogEdgeParity({ catalog: payload, snapshot: edge }, { detailed: true });
        try {
          expected = expectedEdgeChanges(report, edgePayloadHash(payload));
        } catch (error) {
          if (!(error instanceof ParityInputError)) throw error;
          fail('EDGE_NOT_PUBLISHABLE', {}, report.failures.map((f) => f.code).join(', '));
        }
      }
      if (errors.length) payload = null;
    }
  }
  const unconfirmed = [
    ...sheets.positions
      .filter((row) => row.unconfirmed)
      .map((row) => ({ sheet: 'positions', ref: row.slug, text: row.unconfirmed })),
    ...sheets.groups
      .filter((row) => row.unconfirmed)
      .map((row) => ({
        sheet: 'groups',
        ref: `${row.group_id}/${row.option_id}`,
        text: row.unconfirmed,
      })),
    ...sheets.rules
      .filter((row) => row.unconfirmed)
      .map((row) => ({
        sheet: 'rules',
        ref: `${row.product_slug}/${row.group_id}`,
        text: row.unconfirmed,
      })),
  ];
  const before = new Map((currentPayload?.products ?? []).map((product) => [product.id, product]));
  const summary = {
    products: products.length,
    categories: Object.fromEntries(
      CATEGORIES.map((category) => [
        category.ru,
        products.filter((product) => product.row.category === category.ru).length,
      ]),
    ),
    options: [...groups.values()].reduce((n, group) => n + group.options.length, 0),
    without_kk: products.filter((product) => !product.row.name_kk).length,
    without_photo: products.filter((product) => product.row.photo !== 'есть').length,
    without_yandex_price: products.filter((product) => product.yandex === null).length,
    without_glovo_price: products.filter((product) => product.glovo === null).length,
    unconfirmed: unconfirmed.length,
    new_slugs: products.filter((product) => !kept.has(product.row.slug)).length,
    price_changes: currentPayload
      ? products.filter(
          (product) =>
            before.has(product.row.slug) &&
            before.get(product.row.slug).price_minor !== product.price,
        ).length
      : null,
    errors: errors.length,
  };
  return {
    payload,
    bytes,
    errors,
    expected,
    projectedItems: projected?.items.length ?? null,
    products,
    groups,
    unconfirmed,
    summary,
    current: currentPayload ? { ...current, before } : null,
    edge,
  };
}

const money = (minor) => {
  if (minor === null || minor === undefined) return '-';
  const value = BigInt(minor);
  return `${value / 100n}${value % 100n ? `,${String(value % 100n).padStart(2, '0')}` : ''} ₸`;
};
const cell = (value) =>
  String(value ?? '')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim() || '-';
const table = (headers, rows) =>
  [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');

/** Russian review report for the manager: every price, every UNCONFIRMED mapping marked. */
export function reviewMarkdown(model, meta) {
  const { summary } = model;
  const lines = [
    '# Реальное меню PickChick - проверка управляющим',
    '',
    'Отчёт собран инструментом `scripts/catalog-menu-import.mjs build` из листов импорта. ' +
      'Цены зала - из карточек AILILLU (`docs/operations/iiko-menu-details-2026-09-28.md`), ' +
      'соответствие slug - по таблице `design-catalog.md` 3.3. Публикация меняет цены кассы, ' +
      'киоска и приложения сразу.',
    '',
    '## Итог',
    '',
    `Позиций: ${summary.products}, без KK: ${summary.without_kk}, без фото: ${summary.without_photo}, ` +
      `без цены Яндекс: ${summary.without_yandex_price}, без цены Glovo: ${summary.without_glovo_price}.`,
    '',
    `- Категории: ${Object.entries(summary.categories)
      .map(([name, count]) => `${name} ${count}`)
      .join(', ')}.`,
    `- Опций в группах выбора: ${summary.options}. Отметок UNCONFIRMED: ${summary.unconfirmed}.`,
    `- Новых slug: ${summary.new_slugs}.` +
      (summary.price_changes === null ? '' : ` Цен изменится: ${summary.price_changes}.`),
    `- Ошибок: ${summary.errors}.` +
      (model.bytes === null
        ? ''
        : ` Размер каталога: ${model.bytes} байт из ${PAYLOAD_BUDGET_BYTES} допустимых.`),
    '- КБЖУ публикуются нулями со статусом «не проверено», аллергены - «не указаны» (в iiko их нет).',
    '- Цены Яндекс Еды и Glovo в эту публикацию не входят: прайсов агрегаторов в репозитории нет, ' +
      'колонки заполняет управляющий, их публикует отдельный шаг (цены агрегаторов, CC-3).',
    '',
  ];
  if (model.errors.length) {
    lines.push('## Ошибки - публикация невозможна', '');
    lines.push(
      table(
        ['Код', 'Лист', 'Строка', 'Поле', 'Что не так'],
        model.errors.map((e) => [e.code, e.sheet, e.line, e.field, e.detail]),
      ),
      '',
    );
  }
  lines.push(
    '## Позиции',
    '',
    'Каждую строку отметьте в колонке «Проверено» или опишите правку в колонке «Исправить». ' +
      'UNCONFIRMED - соответствие или данные, которые не подтверждены карточкой iiko или владельцем.',
    '',
  );
  for (const category of CATEGORIES) {
    const rows = model.products.filter((product) => product.row.category === category.ru);
    if (!rows.length) continue;
    lines.push(`### ${category.ru}`, '');
    lines.push(
      table(
        [
          'Артикул iiko',
          'Название iiko',
          'slug',
          'Название RU / KK',
          'Цена',
          'Было (опубликовано)',
          'Порция',
          'Фото',
          'UNCONFIRMED',
          'Примечание',
          'Проверено',
          'Исправить',
        ],
        rows.map((product) => {
          const was = model.current?.before.get(product.row.slug);
          const previous = !model.current
            ? 'не сравнивалось'
            : was
              ? `${money(was.price_minor)}${was.name.ru !== product.row.name_ru ? `, «${was.name.ru}»` : ''}`
              : 'новая позиция';
          return [
            product.row.iiko_sku,
            product.row.iiko_name,
            product.row.slug,
            `${product.row.name_ru} / ${product.row.name_kk || 'без KK'}`,
            money(product.price),
            previous,
            product.row.serving_ru,
            product.row.photo,
            product.row.unconfirmed ? `UNCONFIRMED: ${product.row.unconfirmed}` : '',
            product.row.comment,
            '[ ]',
            '',
          ];
        }),
      ),
      '',
    );
  }
  lines.push('## Группы выбора', '');
  for (const group of model.groups.values()) {
    lines.push(`### ${group.title.ru} (\`${group.id}\`)`, '');
    lines.push(
      table(
        [
          'Артикул iiko',
          'Название iiko',
          'id опции',
          'Название RU / KK',
          'Доплата',
          'UNCONFIRMED',
          'Примечание',
          'Проверено',
        ],
        group.rows.map((row, index) => [
          row.iiko_sku,
          row.iiko_name,
          row.option_id,
          `${row.label_ru} / ${row.label_kk || 'без KK'}`,
          money(group.options[index].delta),
          row.unconfirmed ? `UNCONFIRMED: ${row.unconfirmed}` : '',
          row.comment,
          '[ ]',
        ]),
      ),
      '',
    );
  }
  lines.push('## Правила комбо', '');
  lines.push(
    table(
      ['slug', 'Группа', 'min', 'max', 'По умолчанию', 'UNCONFIRMED', 'Источник', 'Проверено'],
      model.products.flatMap((product) =>
        (product.rules ?? []).map(({ row }) => [
          product.row.slug,
          row.group_id,
          row.min,
          row.max,
          row.default_option_id ? `${row.default_option_id} x ${row.default_qty}` : 'нет',
          row.unconfirmed ? `UNCONFIRMED: ${row.unconfirmed}` : '',
          row.comment,
          '[ ]',
        ]),
      ),
    ),
    '',
  );
  const components = model.products.filter((product) => product.payload.combo_components.length);
  lines.push(
    '## Состав комбо',
    '',
    components.length
      ? `Задан для ${components.length} позиций: это меняет задачи кухни (М2), нужен шеф.`
      : 'Не задан (М2 - P1): кухня получает комбо целиком, как сейчас.',
    '',
  );
  if (model.current) {
    lines.push('## Что уходит из опубликованного меню', '');
    const removed = [];
    for (const product of model.products) {
      const was = model.current.before.get(product.row.slug);
      if (!was) continue;
      for (const group of was.modifier_groups) {
        const next = product.payload.modifier_groups.find((g) => g.id === group.id);
        if (!next) removed.push([product.row.slug, `группа «${group.title.ru}» (${group.id})`]);
        else
          for (const option of group.options)
            if (!next.options.some((o) => o.id === option.id))
              removed.push([
                product.row.slug,
                `опция «${option.label.ru}» (${group.id}/${option.id})`,
              ]);
      }
    }
    lines.push(removed.length ? table(['slug', 'Убирается'], removed) : 'Ничего.', '');
  }
  lines.push('## Касса', '');
  if (!model.edge)
    lines.push('Меню кассы не сравнивалось (сборка без `--edge`): публикация невозможна.', '');
  else if (model.expected) {
    lines.push(
      `Меню кассы v${model.edge.version} (\`${model.edge.release_id}\`). Ожидаемых изменений: ` +
        `${model.expected.changes.length}; их полный список - \`expected-edge-changes.json\`, ` +
        'перед публикацией его проверяет `catalog-edge-parity --allow`.',
      '',
      table(
        ['Изменение', 'Количество'],
        Object.entries(model.expected.counts).map(([code, count]) => [code, count]),
      ),
      '',
    );
    const prices = model.expected.changes.filter((c) => c.code === 'PRICE_CHANGED');
    if (prices.length)
      lines.push(
        '### Цены на кассе',
        '',
        table(
          ['Позиция на кассе', 'Сейчас', 'Станет'],
          prices.map((c) => [c.name, money(c.edge_minor), money(c.catalog_minor)]),
        ),
        '',
      );
  }
  lines.push('## Все отметки UNCONFIRMED', '');
  lines.push(
    model.unconfirmed.length
      ? table(
          ['Лист', 'Строка', 'UNCONFIRMED'],
          model.unconfirmed.map((u) => [SHEETS[u.sheet].title, u.ref, u.text]),
        )
      : 'Нет.',
    '',
  );
  lines.push('## Входные файлы', '');
  lines.push(
    table(
      ['Файл', 'SHA-256'],
      Object.entries(meta.inputs)
        .filter(([, value]) => value)
        .map(([name, value]) => [name, `\`${value.sha256}\``]),
    ),
    '',
  );
  if (model.payload) lines.push(`SHA-256 каталога (payload): \`${meta.payloadSha256}\`.`, '');
  lines.push(
    '## Подпись',
    '',
    'Меню проверено, цены и соответствие позиций подтверждаю.',
    '',
    'Управляющий: ______________________ Дата: ____________ Подпись: ____________',
    '',
  );
  return lines.join('\n');
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readRegular(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit)
    throw new ImportError('INPUT_UNREADABLE', `${basename(path)}: не файл или слишком большой`);
  return readFile(path);
}
const jsonOf = (bytes, name) => {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ImportError('INPUT_UNREADABLE', `${name}: не JSON`);
  }
};

/** build: read the sheets and optional inputs, write the four outputs into a new directory. */
export async function runBuild({ dir, out, current, edge }) {
  const inputs = {},
    sheets = {};
  for (const [key, spec] of Object.entries(SHEETS)) {
    const bytes = await readRegular(join(dir, spec.file), 2_000_000);
    inputs[spec.file] = { sha256: sha256(bytes), bytes: bytes.length };
    sheets[key] = parseTsv(bytes, key);
  }
  let currentInput = null,
    edgeInput = null;
  if (current) {
    const bytes = await readRegular(current, 5_000_000);
    inputs.current = { sha256: sha256(bytes), bytes: bytes.length };
    try {
      currentInput = catalogInput(jsonOf(bytes, 'current'));
    } catch (error) {
      if (error instanceof ParityInputError)
        throw new ImportError('INPUT_UNREADABLE', error.message);
      throw error;
    }
  } else inputs.current = null;
  if (edge) {
    const bytes = await readRegular(edge, 5_000_000);
    inputs.edge = { sha256: sha256(bytes), bytes: bytes.length };
    const parsed = MenuSnapshotSchema.safeParse(jsonOf(bytes, 'edge'));
    if (!parsed.success) throw new ImportError('INPUT_UNREADABLE', 'edge: меню кассы не разобрано');
    edgeInput = parsed.data;
  } else inputs.edge = null;
  const model = buildMenu(sheets, { current: currentInput, edge: edgeInput });
  await prepareOut(out);
  const outputs = {};
  const write = async (name, text) => {
    const bytes = Buffer.from(text, 'utf8');
    await writeFile(join(out, name), bytes, { flag: 'wx', mode: 0o600 });
    outputs[name] = { sha256: sha256(bytes), bytes: bytes.length };
  };
  const payloadSha256 = model.payload ? payloadHash(model.payload) : null;
  if (model.payload) await write('payload.json', JSON.stringify(model.payload, null, 2) + '\n');
  else outputs['payload.json'] = null;
  if (model.expected)
    await write('expected-edge-changes.json', JSON.stringify(model.expected, null, 2) + '\n');
  else outputs['expected-edge-changes.json'] = null;
  await write('review.md', reviewMarkdown(model, { inputs, payloadSha256 }));
  const manifest = {
    schema: MANIFEST_SCHEMA,
    tool: 'scripts/catalog-menu-import.mjs',
    inputs,
    outputs,
    payload: model.payload
      ? {
          sha256: payloadSha256,
          edge_sha256: edgePayloadHash(model.payload),
          bytes: model.bytes,
          budget_bytes: PAYLOAD_BUDGET_BYTES,
          products: model.payload.products.length,
          categories: model.payload.categories.length,
          content_reviewed: false,
        }
      : null,
    current: currentInput
      ? {
          branch_id: currentInput.branchId,
          version: currentInput.version,
          payload_sha256: payloadHash(currentInput.payload),
        }
      : null,
    edge: edgeInput
      ? {
          branch_id: edgeInput.branch_id,
          release_id: edgeInput.release_id,
          version: edgeInput.version,
        }
      : null,
    summary: model.summary,
    errors: model.errors,
  };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(out, 'manifest.json'), manifestText, { flag: 'wx', mode: 0o600 });
  return { ok: model.errors.length === 0, manifest, manifestSha256: sha256(manifestText) };
}

async function prepareOut(out) {
  try {
    const info = await lstat(out);
    if (!info.isDirectory() || (await readdir(out)).length)
      throw new ImportError('OUT_NOT_EMPTY', `${out}: нужна новая пустая папка`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(out, { recursive: true, mode: 0o700 });
  }
}

/** A built manifest with its payload, every file checked against the recorded SHA-256. */
export async function loadManifest(path) {
  const bytes = await readRegular(path, 5_000_000);
  const manifest = jsonOf(bytes, 'manifest');
  if (!isRecord(manifest) || manifest.schema !== MANIFEST_SCHEMA || !isRecord(manifest.outputs))
    throw new ImportError('MANIFEST_INVALID', 'manifest.json: не манифест импорта меню');
  if (!Array.isArray(manifest.errors) || manifest.errors.length || !isRecord(manifest.payload))
    throw new ImportError(
      'MANIFEST_HAS_ERRORS',
      'в сборке есть ошибки: исправьте листы и соберите заново',
    );
  const dir = dirname(resolve(path));
  const files = {};
  for (const name of ['payload.json', 'review.md', 'expected-edge-changes.json']) {
    const recorded = manifest.outputs[name];
    if (recorded === null) continue;
    if (!isRecord(recorded) || typeof recorded.sha256 !== 'string')
      throw new ImportError('MANIFEST_INVALID', `manifest.json: нет записи ${name}`);
    const content = await readRegular(join(dir, name), 5_000_000);
    if (sha256(content) !== recorded.sha256)
      throw new ImportError('OUTPUT_CHANGED', `${name} изменён после сборки`);
    files[name] = content;
  }
  if (!files['payload.json'] || !files['review.md'])
    throw new ImportError('MANIFEST_INVALID', 'manifest.json: нет каталога или отчёта');
  const parsed = CatalogPayloadSchema.safeParse(jsonOf(files['payload.json'], 'payload.json'));
  if (!parsed.success || payloadHash(parsed.data) !== manifest.payload.sha256)
    throw new ImportError('OUTPUT_CHANGED', 'payload.json не совпадает с манифестом');
  if (parsed.data.content_reviewed !== false)
    throw new ImportError('MANIFEST_INVALID', 'собранный каталог уже отмечен проверенным');
  const reviewed = { ...parsed.data, content_reviewed: true };
  return {
    manifest,
    sha256: sha256(bytes),
    dir,
    payload: parsed.data,
    reviewed,
    reviewedSha256: payloadHash(reviewed),
    expected: files['expected-edge-changes.json']
      ? { sha256: sha256(files['expected-edge-changes.json']) }
      : null,
  };
}

/** API base: HTTPS anywhere, plain HTTP only on this computer. */
export function apiBase(value = DEFAULT_API) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ImportError('API_INVALID', 'адрес API не разобран');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
  )
    throw new ImportError('API_INVALID', 'нужен HTTPS или http://127.0.0.1');
  return new URL(url.href.endsWith('/') ? url.href : `${url.href}/`);
}

/** The catalog manager credential (provisioned by the owner CLI), private to this user. */
export async function readCredential(path, branch) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 16_000)
    throw new ImportError('TOKEN_FILE', 'файл доступа не найден');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    throw new ImportError('TOKEN_FILE', 'файл доступа читают другие пользователи: chmod 600');
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new ImportError('TOKEN_FILE', 'файл доступа не JSON');
  }
  const parsed = CatalogCredentialSchema.safeParse(value);
  if (!parsed.success) throw new ImportError('TOKEN_FILE', 'файл доступа не разобран');
  if (!parsed.data.branch_ids.includes(branch))
    throw new ImportError('TOKEN_FILE', 'у этого доступа нет такой точки');
  return parsed.data.token;
}

const parsedOrNull = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Minimal JSON client of the catalog admin API; answers are parsed as CatalogState. */
export function catalogApi({ base, token, fetchImpl = globalThis.fetch }) {
  const call = async (method, path, body) => {
    let response;
    try {
      response = await fetchImpl(new URL(path, base), {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ImportError('API_UNREACHABLE', `${method} ${path}: API не ответил`);
    }
    const json = parsedOrNull(await response.text());
    if (!response.ok) {
      const reason =
        isRecord(json?.error) && typeof json.error.code === 'string' ? `/${json.error.code}` : '';
      const code = typeof json?.code === 'string' ? json.code : 'HTTP';
      throw new ImportError(
        'API_REFUSED',
        `${method} ${path}: ${response.status} ${code}${reason}`,
      );
    }
    const state = CatalogStateSchema.safeParse(json);
    if (!state.success)
      throw new ImportError('API_RESPONSE_INVALID', `${method} ${path}: ответ не разобран`);
    return state.data;
  };
  return {
    read: (branch) => call('GET', `v1/admin/catalog/branches/${branch}`),
    save: (branch, body) => call('PUT', `v1/admin/catalog/branches/${branch}/draft`, body),
    publish: (branch, body) => call('POST', `v1/admin/catalog/branches/${branch}/publish`, body),
  };
}

const hashOf = (payload) => (payload ? payloadHash(payload) : null);

function assertBranch(loaded, branch) {
  for (const scope of [loaded.manifest.current, loaded.manifest.edge])
    if (scope?.branch_id && scope.branch_id !== branch)
      throw new ImportError('BRANCH_MISMATCH', 'сборка сделана для другой точки');
}

function assertBase(loaded, state) {
  const { manifest } = loaded;
  // The manager reviewed "было -> стало" against one published version: it must still be head.
  if (
    Number.isInteger(manifest.current?.version) &&
    (state.published?.version ?? null) !== manifest.current.version
  )
    throw new ImportError(
      'PUBLISHED_CHANGED',
      'опубликована другая версия, чем при сборке: соберите отчёт заново',
    );
}

async function writeReceipt(dir, name, receipt) {
  try {
    await writeFile(join(dir, name), JSON.stringify(receipt, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return 'written';
  } catch (error) {
    if (error?.code === 'EEXIST') return 'exists';
    throw error;
  }
}

/** save: the reviewed payload becomes the branch draft (idempotent). */
export async function runSave({ loaded, branch, reviewedBy, api }) {
  const name = String(reviewedBy ?? '').trim();
  if (name.length < 3 || name.length > 100 || hasControl(name))
    throw new ImportError('REVIEWER_INVALID', '--reviewed-by: ФИО проверившего, 3-100 символов');
  assertBranch(loaded, branch);
  const state = await api.read(branch);
  assertBase(loaded, state);
  if (!state.draft) throw new ImportError('DRAFT_MISSING', 'у точки нет черновика каталога');
  const requestId = requestIdFor(loaded.sha256, 'save');
  let saved = state,
    status = 'already_saved';
  if (hashOf(state.draft.payload) !== loaded.reviewedSha256) {
    saved = await api.save(branch, {
      expected_revision: state.draft.revision,
      request_id: requestId,
      payload: loaded.reviewed,
    });
    status = 'saved';
  }
  if (!saved.draft || hashOf(saved.draft.payload) !== loaded.reviewedSha256)
    throw new ImportError('API_RESPONSE_INVALID', 'черновик после сохранения не совпал');
  const receipt = {
    event: 'catalog_menu_saved',
    status,
    branch_id: branch,
    request_id: requestId,
    manifest_sha256: loaded.sha256,
    payload_sha256: loaded.reviewedSha256,
    draft_revision: saved.draft.revision,
    draft_updated_at: saved.draft.updated_at,
    reviewed_by: name,
  };
  return { ...receipt, receipt: await writeReceipt(loaded.dir, 'save-receipt.json', receipt) };
}

/** Checks a `catalog-edge-parity --allow` report against this build and the live state. */
export function assertParityReport(report, loaded, branch, state) {
  if (!loaded.expected)
    throw new ImportError('PARITY_REQUIRED', 'сборка без --edge: нет списка изменений кассы');
  if (
    !isRecord(report) ||
    !isRecord(report.allow) ||
    report.ok !== true ||
    report.allow.ok !== true ||
    report.branch_id !== branch
  )
    throw new ImportError('PARITY_FAILED', 'отчёт catalog-edge-parity --allow не чистый');
  if (
    report.allow.payload_sha256 !== loaded.manifest.payload.edge_sha256 ||
    report.allow.file_sha256 !== loaded.expected.sha256
  )
    throw new ImportError('PARITY_FAILED', 'отчёт паритета сделан для другого каталога или списка');
  const active = state.edge_delivery?.edge_active_version;
  if (
    state.publication_support?.pos === true &&
    typeof active === 'number' &&
    active !== report.edge_version
  )
    throw new ImportError('PARITY_STALE', 'меню кассы изменилось после проверки паритета');
}

/** publish: exactly the saved reviewed draft, after a passing parity --allow report. */
export async function runPublish({ loaded, branch, parity, api }) {
  assertBranch(loaded, branch);
  const state = await api.read(branch);
  const requestId = requestIdFor(loaded.sha256, 'publish');
  let published = state,
    status = 'already_published';
  // A repeat after success only reports: the head and the edge menu have moved on by design.
  if (hashOf(state.published?.payload) !== loaded.reviewedSha256) {
    assertBase(loaded, state);
    assertParityReport(parity, loaded, branch, state);
    if (!state.draft || hashOf(state.draft.payload) !== loaded.reviewedSha256)
      throw new ImportError(
        'DRAFT_DIFFERS',
        'черновик не совпадает с проверенным каталогом: сначала save',
      );
    published = await api.publish(branch, {
      expected_revision: state.draft.revision,
      expected_published_version: state.published?.version ?? 0,
      request_id: requestId,
      confirmation: 'publish_catalog',
    });
    status = 'published';
  }
  if (!published.published || hashOf(published.published.payload) !== loaded.reviewedSha256)
    throw new ImportError('API_RESPONSE_INVALID', 'опубликованный каталог не совпал');
  const receipt = {
    event: 'catalog_menu_published',
    status,
    branch_id: branch,
    request_id: requestId,
    manifest_sha256: loaded.sha256,
    payload_sha256: loaded.reviewedSha256,
    published_version: published.published.version,
    published_at: published.published.published_at,
    edge_delivery: published.edge_delivery ?? null,
  };
  return { ...receipt, receipt: await writeReceipt(loaded.dir, 'publish-receipt.json', receipt) };
}

const COMMANDS = {
  build: { required: ['--dir', '--out'], optional: ['--current', '--edge'] },
  save: {
    required: ['--manifest', '--reviewed-by', '--branch', '--token-file'],
    optional: ['--api'],
  },
  publish: {
    required: ['--manifest', '--parity', '--branch', '--token-file'],
    optional: ['--api'],
  },
};
export class UsageError extends Error {}
export function parseArguments(argv) {
  const [command, ...rest] = argv;
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError('Usage: catalog-menu-import.mjs build|save|publish ...');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index],
      value = rest[index + 1];
    if (
      ![...spec.required, ...spec.optional].includes(flag) ||
      value === undefined ||
      value.startsWith('--') ||
      flag in options
    )
      throw new UsageError(`${command}: ${spec.required.join(' ')} [${spec.optional.join(' ')}]`);
    options[flag] = value;
  }
  for (const flag of spec.required)
    if (!(flag in options)) throw new UsageError(`${command}: ${flag} is required`);
  if (options['--branch'] !== undefined && !UUID.test(options['--branch']))
    throw new UsageError('--branch must be a branch uuid');
  return { command, options };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === 'build') {
    const result = await runBuild({
      dir: options['--dir'],
      out: options['--out'],
      current: options['--current'],
      edge: options['--edge'],
    });
    console.log(
      JSON.stringify({
        event: 'catalog_menu_built',
        ok: result.ok,
        manifest_sha256: result.manifestSha256,
        payload_sha256: result.manifest.payload?.sha256 ?? null,
        summary: result.manifest.summary,
        errors: result.manifest.errors.slice(0, 20),
      }),
    );
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  const branch = options['--branch'];
  const loaded = await loadManifest(options['--manifest']);
  const api = catalogApi({
    base: apiBase(options['--api']),
    token: await readCredential(options['--token-file'], branch),
  });
  const result =
    command === 'save'
      ? await runSave({ loaded, branch, reviewedBy: options['--reviewed-by'], api })
      : await runPublish({
          loaded,
          branch,
          parity: jsonOf(await readRegular(options['--parity'], 20_000_000), 'parity'),
          api,
        });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    const usage = error instanceof UsageError;
    console.error(
      JSON.stringify({
        event: 'catalog_menu_import_failed',
        code: error instanceof ImportError ? error.code : usage ? 'USAGE' : 'UNEXPECTED',
        detail: error instanceof ImportError || usage ? error.message : 'Unexpected error',
      }),
    );
    process.exitCode = usage ? 2 : 1;
  });
