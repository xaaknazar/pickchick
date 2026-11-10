#!/usr/bin/env node
/**
 * Suppliers and purchase prices from the owner's iiko export (Д6; lane bo-ui2 step 3,
 * design-bo-ui.md §9.4, runbook docs/operations/backoffice-supply.md «Импорт цен из iiko»).
 *
 *   node scripts/supplier-prices-import.mjs --file <prices.csv> --branch <uuid>
 *        --token-file <credential.json> [--api <base>] [--profile iiko|csv|<profile.json>]
 *        [--valid-from YYYY-MM-DD] [--plan <plan.json>] [--json]
 *   node scripts/supplier-prices-import.mjs --file <prices.csv> --branch <uuid>
 *        --token-file <credential.json> [--api <base>] [--plan <plan.json>] [--json]
 *        --apply --expected-plan <sha256>
 *
 * Dry run (default): reads the file (CSV in UTF-8; an XLSX is saved from Excel as «CSV UTF-8»),
 * the branch (GET .../backoffice/branches/:id: ingredients, rights, capabilities.supply), its
 * suppliers and the prices of the suppliers named in the file (GET .../ops/suppliers[?id]),
 * writes the plan file (default <file>.plan.json, 0600) and prints a Russian report: matched rows
 * (new prices and prices already there), new suppliers, ingredients not found, ambiguous rows,
 * unit mismatches, duplicate rows, other prices of the same day already in PickChick, archived
 * or switched-off items, unreadable cells. Nothing is written to the cloud.
 * --apply: sends exactly the reviewed plan (its SHA-256 must equal --expected-plan, the file must
 * be the same bytes) as `supplier_prices_import` commands of at most 500 prices each (the API
 * takes 100 KiB of JSON per command): part 1 creates the import batch with the report, every part
 * its new suppliers and prices. Request ids, the batch id and the new supplier ids derive from
 * the plan, so a repeat after a lost answer sends the same commands and nothing is doubled;
 * parts already in are skipped, and afterwards every planned price is read back.
 *
 * Matching (nothing is guessed; every other row goes to the report):
 * - supplier by name: case, spaces and «ё» do not matter; an unknown name is a new supplier
 *   (kind «поставщик», or the kind column: поставщик, цех, пекарня); an archived supplier takes
 *   no prices; two suppliers with the same name are ambiguous;
 * - ingredient by code first - the PickChick ingredient id (uuid) in the code column; a code and
 *   a name together must agree - then by the exact name (case, spaces and «ё» do not matter),
 *   which must fit exactly one ingredient; a switched-off ingredient takes no prices;
 * - unit: кг, г, л, мл, шт (also kg, g, l, ml, pcs); it must measure the ingredient (кг and г
 *   for grams, л and мл for millilitres, шт for pieces);
 * - price: tenge per one unit, at most 2 decimals, never rounded; date: ДД.ММ.ГГГГ or
 *   ГГГГ-ММ-ДД (a time after it is ignored), or --valid-from for a file without a date column;
 * - the same supplier, ingredient, unit and day twice: one row is kept if the prices agree,
 *   none if they differ; a price of that day already in PickChick is never overwritten (same
 *   value - unchanged, another value - a conflict in the report).
 * The import only adds suppliers and prices: it never deletes or changes anything.
 *
 * The API base is local by default (http://127.0.0.1:3100); plain HTTP only to loopback. The
 * token comes from the private catalog credential file (chmod 600) and is never printed.
 * Exit 0: done (also «nothing to load»). Exit 1: refused. Exit 2: usage.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_API, apiBase, readCredential } from './catalog-menu-import.mjs';
import { digest, normalizeName, parseCsv, uuidOf } from './stock-opening-import.mjs';

export const PLAN_SCHEMA = 'pickchick.supplier-prices-import/v1';
/** packages/backoffice-core supplier-import.ts IMPORT_REPORT_SCHEMA and its limits. */
export const REPORT_SCHEMA = 'pickchick.supplier-prices-report/v1';
export const MAX_ROWS = 5000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_PARTS = 50;
export const PART_PRICES = 500;
export const PART_SUPPLIERS = 200;
export const SUMMARY_BYTES = 24 * 1024;
export const SUMMARY_ISSUES = 300;
/** Under the 100 KiB JSON limit of the API (packages/platform/src/http.ts). */
export const BODY_BUDGET = 90 * 1024;
const MAX_MINOR = 999_999_999_999_999n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
export const FIELDS = Object.freeze(['supplier', 'code', 'name', 'unit', 'price', 'date', 'kind']);
/**
 * Column profiles: the header names of each field (compared ignoring case, spaces and «ё»).
 * `iiko` - Russian headers as an iiko export or a hand-made table has them; `csv` - the plain
 * headers of this script. Any other export: --profile <file.json> (see parseProfile).
 */
export const PROFILES = Object.freeze({
  iiko: Object.freeze({
    source: 'iiko_export',
    columns: Object.freeze({
      supplier: ['поставщик', 'контрагент'],
      code: ['ingredient_id', 'код pickchick'],
      name: ['товар', 'наименование', 'номенклатура', 'название', 'наименование товара'],
      unit: ['ед. изм.', 'ед.изм.', 'ед изм', 'ед.', 'ед', 'единица', 'единица измерения'],
      price: ['цена', 'цена за единицу', 'цена за ед.', 'цена, тг', 'цена, ₸'],
      date: ['дата', 'дата документа', 'дата накладной', 'действует с', 'дата цены'],
      kind: ['вид поставщика'],
    }),
  }),
  csv: Object.freeze({
    source: 'csv',
    columns: Object.freeze({
      supplier: ['supplier'],
      code: ['ingredient_id'],
      name: ['name'],
      unit: ['unit'],
      price: ['price_tenge'],
      date: ['valid_from'],
      kind: ['supplier_kind'],
    }),
  }),
});
/** File unit -> the purchase unit of bo_supplier_prices. */
export const UNITS = Object.freeze({
  кг: 'kg',
  kg: 'kg',
  г: 'g',
  гр: 'g',
  g: 'g',
  л: 'l',
  l: 'l',
  мл: 'ml',
  ml: 'ml',
  шт: 'pcs',
  pcs: 'pcs',
});
/** The ingredient unit a purchase unit measures (supply.ts PRICE_UNIT_MEASURES). */
export const MEASURES = Object.freeze({ g: 'g', kg: 'g', ml: 'ml', l: 'ml', pcs: 'pcs' });
export const KINDS = Object.freeze({
  поставщик: 'supplier',
  supplier: 'supplier',
  цех: 'central_kitchen',
  central_kitchen: 'central_kitchen',
  пекарня: 'bakery',
  bakery: 'bakery',
});
/** Report category of every issue code (supplier-import.ts IMPORT_ISSUE_CATEGORIES). */
export const ISSUE_CATEGORIES = Object.freeze({
  SUPPLIER_REQUIRED: 'invalid',
  SUPPLIER_NAME_INVALID: 'invalid',
  PRICE_INVALID: 'invalid',
  DATE_INVALID: 'invalid',
  NAME_REQUIRED: 'invalid',
  CODE_INVALID: 'invalid',
  KIND_INVALID: 'invalid',
  NOT_FOUND: 'not_found',
  CODE_UNKNOWN: 'not_found',
  NAME_AMBIGUOUS: 'ambiguous',
  CODE_NAME_MISMATCH: 'ambiguous',
  SUPPLIER_AMBIGUOUS: 'ambiguous',
  UNIT_UNKNOWN: 'unit_mismatch',
  UNIT_MISMATCH: 'unit_mismatch',
  DUPLICATE: 'duplicates',
  DUPLICATE_CONFLICT: 'duplicates',
  PRICE_EXISTS: 'conflicts',
  INGREDIENT_INACTIVE: 'inactive',
  SUPPLIER_ARCHIVED: 'inactive',
  KIND_IGNORED: 'notes',
});
export const COUNT_KEYS = Object.freeze([
  'rows',
  'matched',
  'new_prices',
  'unchanged',
  'new_suppliers',
  'not_found',
  'ambiguous',
  'unit_mismatch',
  'duplicates',
  'conflicts',
  'inactive',
  'invalid',
  'notes',
]);
/** Russian titles of the report categories (also in the cabinet, supply-model.ts). */
export const CATEGORY_TITLES = Object.freeze({
  not_found: 'позиция не найдена',
  ambiguous: 'неоднозначно',
  unit_mismatch: 'единица не подходит',
  duplicates: 'повторы в файле',
  conflicts: 'на этот день уже другая цена',
  inactive: 'позиция выключена или поставщик в архиве',
  invalid: 'ошибка в строке',
  notes: 'заметка',
});

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export class UsageError extends Error {}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value));
const cut = (value, max) => {
  const text = String(value ?? '').replace(new RegExp(CONTROL.source, 'g'), ' ');
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
};
const UNIT_NAMES = { g: 'г', kg: 'кг', ml: 'мл', l: 'л', pcs: 'шт' };

// ------------------------------------------------------------------------- the file ----

/**
 * A column profile: a built-in name (iiko, csv) or the JSON of a profile file:
 * { "source": "iiko_export" | "csv", "columns": { "supplier": "Контрагент", "name": ["Товар"],
 *   "code"?: ..., "unit": ..., "price": ..., "date"?: ..., "kind"?: ... } }.
 */
export function parseProfile(nameOrJson) {
  if (typeof nameOrJson === 'string' && nameOrJson in PROFILES) {
    const p = PROFILES[nameOrJson];
    return { name: nameOrJson, source: p.source, columns: p.columns };
  }
  const value = typeof nameOrJson === 'string' ? parsedOrNull(nameOrJson) : nameOrJson;
  const fail = (why) => {
    throw new ImportError('PROFILE_INVALID', `профиль колонок не разобран: ${why}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('нужен объект JSON');
  for (const key of Object.keys(value))
    if (!['source', 'columns'].includes(key)) fail(`лишний ключ «${key}»`);
  const source = value.source ?? 'iiko_export';
  if (!['iiko_export', 'csv'].includes(source)) fail('source - iiko_export или csv');
  const columns = {};
  if (!value.columns || typeof value.columns !== 'object' || Array.isArray(value.columns))
    fail('нужен объект columns');
  for (const [field, names] of Object.entries(value.columns)) {
    if (!FIELDS.includes(field)) fail(`неизвестное поле «${field}»`);
    const list = Array.isArray(names) ? names : [names];
    if (
      !list.length ||
      list.length > 10 ||
      list.some((n) => typeof n !== 'string' || !n.trim() || n.length > 100)
    )
      fail(`названия колонки «${field}»`);
    columns[field] = list.map(normalizeName);
  }
  return { name: 'custom', source, columns };
}

/** Header and data rows of the price file under a profile (see the module comment). */
export function readPricesFile(bytes, profile) {
  if (bytes.length > MAX_FILE_BYTES) throw new ImportError('FILE_INVALID', 'файл больше 5 МБ');
  let text = bytes.toString('utf8');
  if (text.includes('�'))
    throw new ImportError(
      'FILE_ENCODING',
      'файл не в UTF-8: в Excel сохраните его как «CSV UTF-8 (разделитель - запятая)»',
    );
  if (text.startsWith('﻿')) text = text.slice(1);
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ',';
  let rows;
  try {
    rows = parseCsv(text, delimiter);
  } catch {
    throw new ImportError('FILE_INVALID', 'незакрытая кавычка в файле');
  }
  const header = rows.shift();
  if (!header || !header.cells.some((c) => c.trim()))
    throw new ImportError('FILE_INVALID', 'пустой файл');
  const index = {};
  const columns = {};
  const ignored = [];
  header.cells.forEach((raw, i) => {
    const name = normalizeName(raw);
    const field = FIELDS.find((f) => (profile.columns[f] ?? []).includes(name));
    if (!field) {
      if (name) ignored.push(raw.trim());
      return;
    }
    if (field in index)
      throw new ImportError(
        'FILE_HEADER',
        `колонки «${columns[field]}» и «${raw.trim()}» обе подходят к полю ${field}: укажите профиль колонок`,
      );
    index[field] = i;
    columns[field] = raw.trim();
  });
  const need = { supplier: 'поставщик', unit: 'единица', price: 'цена' };
  for (const [field, title] of Object.entries(need))
    if (!(field in index))
      throw new ImportError('FILE_HEADER', `нет колонки «${title}» (поле ${field} профиля)`);
  if (!('code' in index) && !('name' in index))
    throw new ImportError('FILE_HEADER', 'нужна колонка с названием позиции или её кодом');
  const data = rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (!data.length) throw new ImportError('FILE_INVALID', 'в файле нет строк');
  if (data.length > MAX_ROWS)
    throw new ImportError('FILE_INVALID', `больше ${MAX_ROWS} строк: разделите файл`);
  const cell = (r, field) => (field in index ? (r.cells[index[field]] ?? '').trim() : '');
  return {
    delimiter,
    columns,
    ignored,
    rows: data.map((r) => ({
      line: r.line,
      supplier: cell(r, 'supplier'),
      code: cell(r, 'code'),
      name: cell(r, 'name'),
      unit: cell(r, 'unit'),
      price: cell(r, 'price'),
      date: cell(r, 'date'),
      kind: cell(r, 'kind'),
    })),
  };
}

/** Tenge per unit -> whole tiyn, exactly (at most 2 decimals, never rounded). */
export function parsePrice(text) {
  const s = String(text)
    .replace(/\s/g, '')
    .replace(/(₸|тг\.?|тенге|kzt)$/i, '');
  if (!s) throw new Error('нет цены');
  if (s.startsWith('-')) throw new Error('цена должна быть больше нуля');
  if (s.includes(',') && s.includes('.')) throw new Error('не число: оставьте один знак дроби');
  const v = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error('не число');
  const [whole, fraction = ''] = v.split('.');
  if (/[1-9]/.test(fraction.slice(2)))
    throw new Error(
      'больше двух знаков после запятой: цену за 1 г или 1 мл укажите за 1 кг или 1 л',
    );
  const minor = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  if (minor <= 0n) throw new Error('цена должна быть больше нуля');
  if (minor > MAX_MINOR) throw new Error('слишком большое число');
  return minor;
}
/**
 * ДД.ММ.ГГГГ (also Д.М.ГГГГ) or ГГГГ-ММ-ДД, optionally with a time (ignored) -> YYYY-MM-DD in
 * 2024..2099. A slash date (05/11/2026) is refused: day and month could be either way round.
 */
export function parseDay(text) {
  const s = String(text).trim();
  if (!s) throw new Error('нет даты');
  const time = '(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?)?';
  const dmy = new RegExp(`^(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})${time}$`).exec(s);
  const ymd = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})${time}$`).exec(s);
  const iso = dmy
    ? `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
    : ymd
      ? `${ymd[1]}-${ymd[2]}-${ymd[3]}`
      : null;
  if (!iso)
    throw new Error(
      /^\d+([.,]\d+)?$/.test(s)
        ? 'дата записана числом: в Excel задайте ячейкам формат ДД.ММ.ГГГГ'
        : 'дата не разобрана: нужен формат ДД.ММ.ГГГГ',
    );
  if (new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso)
    throw new Error('такого дня нет');
  if (iso < '2024-01-01' || iso > '2099-12-31') throw new Error('дата вне 2024-2099');
  return iso;
}
export const unitOf = (text) => UNITS[normalizeName(text).replace(/\.$/, '')] ?? null;

// ------------------------------------------------------------------------- the plan ----

const parsedOrNull = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
/**
 * The live data of the branch the plan is checked against: the ingredients (GET branches/:id
 * stock rows), the suppliers and the prices of some of them (GET ops/suppliers?id).
 */
export function liveOf({ branch, snapshot, suppliers, prices }) {
  const invalid = () => {
    throw new ImportError('SNAPSHOT_INVALID', 'ответ API не разобран');
  };
  if (!snapshot || snapshot.branch_id !== branch || !Array.isArray(snapshot.stock)) invalid();
  if (snapshot.capabilities?.supply !== true)
    throw new ImportError(
      'SUPPLY_OFF',
      'закупки выключены на сервере (BACKOFFICE_SUPPLY_ENABLED и права 076): импорт невозможен',
    );
  const writable = Array.isArray(snapshot.permissions)
    ? snapshot.permissions.includes('suppliers.write')
    : snapshot.role === 'manager';
  if (!writable)
    throw new ImportError(
      'FORBIDDEN',
      'у этого доступа нет права вести поставщиков и цены (управляющий или бухгалтер)',
    );
  if (!suppliers || suppliers.branch_id !== branch || !Array.isArray(suppliers.suppliers))
    invalid();
  if (suppliers.truncated?.suppliers)
    throw new ImportError('TRUNCATED', 'у точки больше 500 поставщиков: импорт не проверит их все');
  const ingredients = snapshot.stock.map((row) => {
    const p = row.payload ?? {};
    if (!UUID.test(row.id) || typeof p.name !== 'string' || !['g', 'ml', 'pcs'].includes(p.unit))
      invalid();
    return { id: row.id, name: p.name, unit: p.unit, active: p.active !== false };
  });
  const list = suppliers.suppliers.map((s) => {
    if (!UUID.test(s.id) || typeof s.name !== 'string' || typeof s.active !== 'boolean') invalid();
    return { id: s.id, name: s.name, kind: s.kind, active: s.active };
  });
  const byId = new Map();
  for (const [id, view] of prices ?? new Map()) {
    if (!view || view.id !== id || !Array.isArray(view.prices)) invalid();
    if (view.prices_truncated)
      throw new ImportError(
        'TRUNCATED',
        `у поставщика ${list.find((s) => s.id === id)?.name ?? id} больше 1000 цен: импорт не проверит их все`,
      );
    byId.set(
      id,
      view.prices.map((p) => ({
        ingredient_id: p.ingredient_id,
        unit: p.unit,
        valid_from: p.valid_from,
        price_minor: String(p.price_minor),
        import_batch_id: p.import_batch_id ?? null,
      })),
    );
  }
  return { ingredients, suppliers: list, prices: byId };
}
const priceKey = (supplier, ingredient, unit, day) => [supplier, ingredient, unit, day].join(':');

/**
 * The plan of a price file against the live data (pure: the same bytes, profile, options and
 * live data give the same plan and hash). Answers the plan; plan_sha256 is null when nothing is
 * left to load (every row is already there or in the report).
 */
export function planImport({
  fileBytes,
  fileName = 'prices.csv',
  profile,
  validFrom,
  branch,
  live,
}) {
  if (!UUID.test(branch)) throw new ImportError('BRANCH', 'нужен uuid точки');
  const file = readPricesFile(fileBytes, profile);
  if (file.columns.date && validFrom)
    throw new ImportError('VALID_FROM', 'в файле есть колонка даты: --valid-from не нужен');
  if (!file.columns.date && !validFrom)
    throw new ImportError(
      'VALID_FROM',
      'в файле нет колонки даты: укажите --valid-from ГГГГ-ММ-ДД',
    );
  if (validFrom) parseDay(validFrom);
  const ingredientsById = new Map(live.ingredients.map((i) => [i.id, i]));
  const ingredientsByName = new Map();
  for (const i of live.ingredients) {
    const key = normalizeName(i.name);
    ingredientsByName.set(key, [...(ingredientsByName.get(key) ?? []), i]);
  }
  const suppliersByName = new Map();
  for (const s of live.suppliers) {
    const key = normalizeName(s.name);
    suppliersByName.set(key, [...(suppliersByName.get(key) ?? []), s]);
  }
  const issues = [];
  const issue = (row, code, text) =>
    issues.push({
      line: row.line,
      code,
      category: ISSUE_CATEGORIES[code],
      supplier: row.supplier ? cut(row.supplier, 120) : null,
      name: row.name || row.code ? cut(row.name || row.code, 200) : null,
      text: cut(text, 300),
    });
  const candidates = [];
  for (const row of file.rows) {
    const supplierName = row.supplier.replace(/\s+/g, ' ').trim();
    if (!supplierName) {
      issue(row, 'SUPPLIER_REQUIRED', 'не указан поставщик');
      continue;
    }
    if (supplierName.length > 120 || CONTROL.test(supplierName)) {
      issue(row, 'SUPPLIER_NAME_INVALID', 'название поставщика длиннее 120 знаков');
      continue;
    }
    let kind = null;
    if (row.kind) {
      kind = KINDS[normalizeName(row.kind)] ?? null;
      if (!kind) {
        issue(
          row,
          'KIND_INVALID',
          `вид поставщика «${cut(row.kind, 40)}»: поставщик, цех или пекарня`,
        );
        continue;
      }
    }
    let price, day;
    try {
      price = parsePrice(row.price);
    } catch (error) {
      issue(row, 'PRICE_INVALID', `цена «${cut(row.price, 40)}»: ${error.message}`);
      continue;
    }
    try {
      day = validFrom ?? parseDay(row.date);
    } catch (error) {
      issue(row, 'DATE_INVALID', `дата «${cut(row.date, 40)}»: ${error.message}`);
      continue;
    }
    const unit = unitOf(row.unit);
    if (!unit) {
      issue(row, 'UNIT_UNKNOWN', `единица «${cut(row.unit, 20)}»: только кг, г, л, мл, шт`);
      continue;
    }
    let ingredient;
    if (row.code) {
      const code = row.code.toLowerCase();
      if (!UUID.test(code)) {
        issue(row, 'CODE_INVALID', `код «${cut(row.code, 40)}» не код позиции PickChick (uuid)`);
        continue;
      }
      ingredient = ingredientsById.get(code);
      if (!ingredient) {
        issue(row, 'CODE_UNKNOWN', 'нет позиции с таким кодом');
        continue;
      }
      if (row.name && normalizeName(row.name) !== normalizeName(ingredient.name)) {
        issue(
          row,
          'CODE_NAME_MISMATCH',
          `код - это «${cut(ingredient.name, 120)}», а не «${cut(row.name, 120)}»`,
        );
        continue;
      }
    } else {
      if (!row.name) {
        issue(row, 'NAME_REQUIRED', 'нет ни названия позиции, ни кода');
        continue;
      }
      const found = ingredientsByName.get(normalizeName(row.name)) ?? [];
      if (found.length !== 1) {
        if (found.length)
          issue(row, 'NAME_AMBIGUOUS', `название подходит к ${found.length} позициям: укажите код`);
        else issue(row, 'NOT_FOUND', 'нет позиции с таким названием');
        continue;
      }
      ingredient = found[0];
    }
    if (!ingredient.active) {
      issue(row, 'INGREDIENT_INACTIVE', `позиция «${cut(ingredient.name, 120)}» выключена`);
      continue;
    }
    if (MEASURES[unit] !== ingredient.unit) {
      issue(
        row,
        'UNIT_MISMATCH',
        `«${cut(ingredient.name, 120)}» учитывается в ${UNIT_NAMES[ingredient.unit]}, а цена за ${UNIT_NAMES[unit]}`,
      );
      continue;
    }
    const key = normalizeName(supplierName);
    const known = suppliersByName.get(key) ?? [];
    if (known.length > 1) {
      issue(row, 'SUPPLIER_AMBIGUOUS', `в PickChick ${known.length} поставщика с таким названием`);
      continue;
    }
    if (known.length === 1 && !known[0].active) {
      issue(row, 'SUPPLIER_ARCHIVED', `поставщик «${cut(known[0].name, 120)}» в архиве`);
      continue;
    }
    candidates.push({
      row,
      key,
      supplierName,
      kind,
      existing: known[0] ?? null,
      ingredient,
      unit,
      price: price.toString(),
      day,
    });
  }
  // The same supplier, ingredient, unit and day: one row if the prices agree, none otherwise.
  const groups = new Map();
  for (const c of candidates) {
    const k = priceKey(c.key, c.ingredient.id, c.unit, c.day);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const kept = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const lines = group.map((c) => c.row.line).join(', ');
    if (group.every((c) => c.price === group[0].price)) {
      kept.push(group[0]);
      for (const c of group.slice(1))
        issue(c.row, 'DUPLICATE', `повтор строки ${group[0].row.line}`);
    } else
      for (const c of group)
        issue(
          c.row,
          'DUPLICATE_CONFLICT',
          `в строках ${lines} разные цены за один день: ни одна не загружена`,
        );
  }
  kept.sort((a, b) => a.row.line - b.row.line);
  // Against the prices in PickChick: the same value is unchanged, another one is never replaced.
  const priced = [];
  for (const c of kept) {
    if (c.existing) {
      const now = (live.prices.get(c.existing.id) ?? []).find(
        (p) => p.ingredient_id === c.ingredient.id && p.unit === c.unit && p.valid_from === c.day,
      );
      if (now && now.price_minor !== c.price) {
        issue(
          c.row,
          'PRICE_EXISTS',
          `на ${c.day.split('-').reverse().join('.')} уже цена ${tengeText(now.price_minor)} ₸ за ${UNIT_NAMES[c.unit]}: импорт её не меняет, исправьте вручную при необходимости`,
        );
        continue;
      }
      priced.push({ c, action: now ? 'unchanged' : 'create' });
    } else priced.push({ c, action: 'create' });
  }
  // Suppliers: those with a price of the plan, in the order of the file.
  const suppliers = [];
  const byKey = new Map();
  for (const { c } of priced) {
    let s = byKey.get(c.key);
    if (!s) {
      s = c.existing
        ? {
            key: c.key,
            name: c.existing.name,
            kind: c.existing.kind,
            id: c.existing.id,
            action: 'existing',
          }
        : {
            key: c.key,
            name: c.supplierName,
            kind: c.kind ?? 'supplier',
            id: null,
            action: 'create',
          };
      byKey.set(c.key, s);
      suppliers.push(s);
    }
    if (c.kind && c.kind !== s.kind)
      issue(
        c.row,
        'KIND_IGNORED',
        s.action === 'existing'
          ? 'вид поставщика в файле другой: вид не меняется, цена загружена'
          : 'вид поставщика отличается от первой строки поставщика: взят вид первой строки',
      );
  }
  const prices = priced.map(({ c, action }) => ({
    line: c.row.line,
    supplier: c.key,
    ingredient_id: c.ingredient.id,
    ingredient_name: c.ingredient.name,
    unit: c.unit,
    price_minor: c.price,
    valid_from: c.day,
    action,
  }));
  issues.sort((a, b) => a.line - b.line || a.code.localeCompare(b.code));
  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  counts.rows = file.rows.length;
  counts.matched = prices.length;
  counts.new_prices = prices.filter((p) => p.action === 'create').length;
  counts.unchanged = counts.matched - counts.new_prices;
  counts.new_suppliers = suppliers.filter((s) => s.action === 'create').length;
  for (const i of issues) counts[i.category]++;
  const core = {
    schema: PLAN_SCHEMA,
    branch_id: branch,
    file_name: cut(basename(fileName), 200) || 'prices.csv',
    file_sha256: sha256(fileBytes),
    source: profile.source,
    profile: { name: profile.name, columns: file.columns },
    valid_from: validFrom ?? null,
    ignored_columns: file.ignored,
    suppliers,
    prices,
    issues,
    counts,
  };
  if (!counts.new_prices)
    return { ...core, plan_sha256: null, batch_id: null, summary: null, parts: [] };
  const planSha = digest(core);
  return { ...core, plan_sha256: planSha, ...buildParts(core, planSha) };
}
/** The keys of a plan its SHA-256 covers (everything the commands are built from). */
export const CORE_KEYS = Object.freeze([
  'schema',
  'branch_id',
  'file_name',
  'file_sha256',
  'source',
  'profile',
  'valid_from',
  'ignored_columns',
  'suppliers',
  'prices',
  'issues',
  'counts',
]);
const coreOf = (plan) => Object.fromEntries(CORE_KEYS.map((k) => [k, plan[k]]));
export const tengeText = (minor) => {
  const v = BigInt(minor);
  const whole = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const fraction = (v % 100n).toString().padStart(2, '0');
  return fraction === '00' ? whole : `${whole},${fraction}`;
};
/** The stored report: the counts and the first issues that fit in SUMMARY_BYTES. */
export function summaryOf(core, parts) {
  const summary = {
    schema: REPORT_SCHEMA,
    file_name: core.file_name,
    profile: core.profile.name,
    parts,
    counts: core.counts,
    issues: [],
    issues_total: core.issues.length,
  };
  let size = bytesOf(summary);
  for (const i of core.issues) {
    const item = { line: i.line, code: i.code, supplier: i.supplier, name: i.name, text: i.text };
    const add = bytesOf(item) + 1;
    if (summary.issues.length >= SUMMARY_ISSUES || size + add > SUMMARY_BYTES) break;
    summary.issues.push(item);
    size += add;
  }
  return summary;
}
const reasonOf = (core, planSha, part, parts) =>
  `Импорт цен поставщиков из файла ${core.file_name}, SHA-256 файла ${core.file_sha256.slice(0, 12)}, ` +
  `план ${planSha.slice(0, 12)}, часть ${part}/${parts}.`;
/**
 * The commands of a plan: the batch id, the new supplier ids, the parts (at most 500 prices and
 * under BODY_BUDGET bytes each; part 1 also carries the report) with their request ids.
 */
export function buildParts(core, planSha) {
  const branch = core.branch_id;
  const batch_id = uuidOf([branch, planSha, 'batch']);
  const supplierOf = new Map(
    core.suppliers.map((s) => [
      s.key,
      { ...s, id: s.id ?? uuidOf([branch, planSha, 'supplier', s.key]) },
    ]),
  );
  const command = (part, parts) => ({
    type: 'supplier_prices_import',
    batch_id,
    source: core.source,
    file_sha256: core.file_sha256,
    plan_sha256: planSha,
    row_count: core.counts.rows,
    part,
    parts,
  });
  const base = (first) =>
    bytesOf({
      request_id: batch_id,
      reason: reasonOf(core, planSha, MAX_PARTS, MAX_PARTS),
      command: { ...command(MAX_PARTS, MAX_PARTS), suppliers: [], prices: [] },
    }) + (first ? SUMMARY_BYTES + ',"summary":'.length : 0);
  const groups = [];
  let current = null;
  const introduced = new Set();
  for (const p of core.prices.filter((x) => x.action === 'create')) {
    const s = supplierOf.get(p.supplier);
    const price = {
      supplier_id: s.id,
      ingredient_id: p.ingredient_id,
      unit: p.unit,
      price_minor: p.price_minor,
      valid_from: p.valid_from,
    };
    const fresh = s.action === 'create' && !introduced.has(s.key);
    const supplier = fresh ? { id: s.id, name: s.name, kind: s.kind } : null;
    const add = bytesOf(price) + 1 + (supplier ? bytesOf(supplier) + 1 : 0);
    if (
      !current ||
      current.prices.length >= PART_PRICES ||
      (supplier && current.suppliers.length >= PART_SUPPLIERS) ||
      current.size + add > BODY_BUDGET
    ) {
      current = { prices: [], suppliers: [], lines: [], size: base(!groups.length) };
      groups.push(current);
    }
    current.prices.push(price);
    current.lines.push(p.line);
    if (supplier) {
      current.suppliers.push(supplier);
      introduced.add(s.key);
    }
    current.size += add;
  }
  if (groups.length > MAX_PARTS)
    throw new ImportError('TOO_MANY_PARTS', `больше ${MAX_PARTS} частей: разделите файл`);
  const summary = summaryOf(core, groups.length);
  const parts = groups.map((g, i) => {
    const part = i + 1;
    const request_id = uuidOf([branch, planSha, 'part', part]);
    const body = {
      request_id,
      reason: reasonOf(core, planSha, part, groups.length),
      command: {
        ...command(part, groups.length),
        ...(part === 1 ? { summary } : {}),
        suppliers: g.suppliers,
        prices: g.prices,
      },
    };
    if (bytesOf(body) > BODY_BUDGET)
      throw new ImportError('PART_TOO_LARGE', `часть ${part} больше ${BODY_BUDGET} байт`);
    return {
      part,
      request_id,
      lines: g.lines,
      new_suppliers: g.suppliers.map((s) => s.name),
      body,
    };
  });
  return { batch_id, summary, parts };
}

// ----------------------------------------------------------------------- the report ----

/** The Russian report of a plan (the dry run prints it). */
export function reportText(plan, { planFile = null, limit = 200 } = {}) {
  const c = plan.counts;
  const out = [
    'Импорт цен поставщиков - проверка, в PickChick ничего не записано.',
    `Файл: ${plan.file_name}, строк с данными: ${c.rows}, SHA-256 ${plan.file_sha256}`,
    `Профиль колонок: ${plan.profile.name}; колонки: ${Object.entries(plan.profile.columns)
      .map(([f, h]) => `${h} (${f})`)
      .join(', ')}`,
    ...(plan.valid_from
      ? [`Цены действуют с ${plan.valid_from.split('-').reverse().join('.')}`]
      : []),
    ...(plan.ignored_columns.length
      ? [`Не используются колонки: ${plan.ignored_columns.join(', ')}`]
      : []),
    '',
    `Сопоставлено строк: ${c.matched}`,
    `  новых цен: ${c.new_prices}`,
    `  уже есть с той же ценой (без изменений): ${c.unchanged}`,
    `Новых поставщиков: ${c.new_suppliers}`,
    ...plan.suppliers
      .filter((s) => s.action === 'create')
      .map(
        (s) =>
          `  + ${s.name}${s.kind === 'supplier' ? '' : s.kind === 'bakery' ? ' (пекарня)' : ' (цех)'}`,
      ),
    'По поставщикам:',
    ...plan.suppliers.map((s) => {
      const own = plan.prices.filter((p) => p.supplier === s.key);
      const created = own.filter((p) => p.action === 'create').length;
      return `  ${s.name}${s.action === 'create' ? ' (новый)' : ''}: новых цен ${created}, без изменений ${own.length - created}`;
    }),
    '',
    'Не загрузятся:',
    ...Object.entries(CATEGORY_TITLES)
      .filter(([k]) => k !== 'notes')
      .map(([k, title]) => `  ${title}: ${c[k]}`),
    `Заметки (строка загружена): ${c.notes}`,
  ];
  if (plan.issues.length) {
    out.push(
      '',
      plan.issues.length > limit
        ? `Строки с замечаниями (первые ${limit} из ${plan.issues.length}; все - в файле плана, раздел issues):`
        : 'Строки с замечаниями:',
    );
    for (const i of plan.issues.slice(0, limit))
      out.push(
        `  строка ${i.line}, ${CATEGORY_TITLES[i.category]}: ${i.supplier ?? '-'} / ${i.name ?? '-'} - ${i.text}`,
      );
  }
  out.push('');
  if (!plan.plan_sha256)
    out.push(
      c.matched
        ? 'Загружать нечего: все сопоставленные цены уже есть в PickChick.'
        : 'Загружать нечего: ни одна строка не сопоставлена.',
    );
  else
    out.push(
      `Частей (команд): ${plan.parts.length}`,
      `SHA-256 плана: ${plan.plan_sha256}`,
      ...(planFile ? [`Файл плана: ${planFile}`] : []),
      'Загрузка - та же команда с --apply --expected-plan <SHA-256 плана>.',
    );
  return out.join('\n');
}

// -------------------------------------------------------------------------- the API ----

/** JSON client of the back-office API: request(path, body?) - GET without body, POST with it. */
export function backofficeApi({ base, token, fetchImpl = globalThis.fetch }) {
  return async (path, body) => {
    const method = body === undefined ? 'GET' : 'POST';
    let response;
    try {
      response = await fetchImpl(new URL(`v1/admin/backoffice/${path}`, base), {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ImportError(
        'API_UNREACHABLE',
        `${method} ${path.split('?')[0]}: API не ответил; повторите ту же команду - цены не задвоятся`,
      );
    }
    const json = parsedOrNull(await response.text());
    if (!response.ok) {
      const reason = typeof json?.error?.code === 'string' ? json.error.code : null;
      const code = typeof json?.code === 'string' ? json.code : 'HTTP';
      const error = new ImportError(
        'API_REFUSED',
        `${method} ${path.split('?')[0]}: ${response.status} ${code}${reason ? '/' + reason : ''}`,
      );
      error.status = response.status;
      error.reason = reason;
      throw error;
    }
    if (!json || typeof json !== 'object')
      throw new ImportError(
        'API_RESPONSE_INVALID',
        `${method} ${path.split('?')[0]}: ответ не разобран`,
      );
    return json;
  };
}
/**
 * The live data of the branch for a plan: the snapshot, the suppliers and the prices of the
 * suppliers `wanted(supplier)` picks (by default those the file names).
 */
export async function readLive(request, branch, wanted) {
  const snapshot = await request(`branches/${branch}`);
  // The rights and the flag first: without supply the view below would be a bare 404.
  liveOf({ branch, snapshot, suppliers: { branch_id: branch, suppliers: [] } });
  const suppliers = await request(`branches/${branch}/ops/suppliers`);
  const prices = new Map();
  for (const s of suppliers.suppliers ?? [])
    if (wanted(s))
      prices.set(
        s.id,
        await request(`branches/${branch}/ops/suppliers?id=${encodeURIComponent(s.id)}`),
      );
  return liveOf({ branch, snapshot, suppliers, prices });
}
/** The batch of a plan as GET ops/supplier-imports?id answers it, or null before part 1. */
export async function readBatch(request, branch, batch) {
  try {
    const view = await request(
      `branches/${branch}/ops/supplier-imports?id=${encodeURIComponent(batch)}`,
    );
    if (view?.view !== 'supplier-imports' || view.import?.id !== batch)
      throw new ImportError('API_RESPONSE_INVALID', 'ответ об импорте не разобран');
    return view.import;
  } catch (error) {
    if (error instanceof ImportError && error.status === 404) return null;
    throw error;
  }
}

// ------------------------------------------------------------------------ the apply ----

/** The plan file is the one reviewed: its hash, the expected hash and the rebuilt commands. */
export function checkPlan(plan, expectedPlan) {
  if (!plan || plan.schema !== PLAN_SCHEMA)
    throw new ImportError('PLAN_INVALID', 'файл плана не разобран');
  if (!plan.plan_sha256) throw new ImportError('PLAN_EMPTY', 'в плане нечего загружать');
  if (digest(coreOf(plan)) !== plan.plan_sha256)
    throw new ImportError('PLAN_INVALID', 'файл плана изменён после построения');
  if (plan.plan_sha256 !== expectedPlan)
    throw new ImportError('PLAN_MISMATCH', 'SHA-256 плана не совпадает с --expected-plan');
  const rebuilt = buildParts(coreOf(plan), plan.plan_sha256);
  if (
    digest(rebuilt.parts) !== digest(plan.parts) ||
    rebuilt.batch_id !== plan.batch_id ||
    digest(rebuilt.summary) !== digest(plan.summary)
  )
    throw new ImportError('PLAN_INVALID', 'команды в файле плана изменены после построения');
}
/**
 * The parts still to send: those the batch does not have yet, after checking that each of them
 * still fits the live data (new supplier names free, suppliers working, ingredients switched on,
 * no other price on the same day). Anything else means the data changed after the plan.
 */
export function preflight(plan, live, batch) {
  if (batch && batch.plan_sha256 !== plan.plan_sha256)
    throw new ImportError('STALE_PLAN', 'идентификатор импорта занят другим планом');
  const done = new Set(batch?.parts_applied ?? []);
  const remaining = plan.parts.filter((p) => !done.has(p.part));
  if (batch === null && remaining.length !== plan.parts.length)
    throw new ImportError('STALE_PLAN', 'ответ об импорте не разобран');
  const stale = (why) => {
    throw new ImportError('STALE_PLAN', `${why}: ничего не отправлено, постройте план заново`);
  };
  const suppliersById = new Map(live.suppliers.map((s) => [s.id, s]));
  const suppliersByName = new Map(live.suppliers.map((s) => [normalizeName(s.name), s]));
  const ingredients = new Map(live.ingredients.map((i) => [i.id, i]));
  const created = new Set();
  for (const part of plan.parts) {
    const pending = !done.has(part.part);
    for (const s of part.body.command.suppliers) {
      if (pending) {
        if (suppliersById.has(s.id)) stale(`поставщик «${s.name}» уже есть`);
        const same = suppliersByName.get(normalizeName(s.name));
        if (same) stale(`поставщик «${s.name}» уже заведён в PickChick`);
      }
      created.add(s.id);
    }
    if (!pending) continue;
    for (const p of part.body.command.prices) {
      if (!created.has(p.supplier_id)) {
        const s = suppliersById.get(p.supplier_id);
        if (!s) stale('поставщика из плана больше нет');
        if (!s.active) stale(`поставщик «${s.name}» в архиве`);
        const now = (live.prices.get(p.supplier_id) ?? []).find(
          (x) =>
            x.ingredient_id === p.ingredient_id &&
            x.unit === p.unit &&
            x.valid_from === p.valid_from,
        );
        if (now && now.price_minor !== p.price_minor)
          stale(`у «${s.name}» на ${p.valid_from} уже другая цена`);
      }
      const i = ingredients.get(p.ingredient_id);
      if (!i) stale('позиции из плана больше нет');
      if (!i.active) stale(`позиция «${i.name}» выключена`);
      if (MEASURES[p.unit] !== i.unit) stale(`у позиции «${i.name}» другая единица`);
    }
  }
  return remaining;
}
/** After --apply: the batch is complete and every planned price is in PickChick. */
export function verifyApplied(plan, live, batch) {
  if (!batch || batch.complete !== true)
    throw new ImportError('VERIFY_FAILED', 'импорт загружен не полностью: повторите ту же команду');
  const supplierOf = (key) => {
    const s = plan.suppliers.find((x) => x.key === key);
    return s.id ?? uuidOf([plan.branch_id, plan.plan_sha256, 'supplier', key]);
  };
  const wrong = plan.prices.filter((p) => {
    const now = (live.prices.get(supplierOf(p.supplier)) ?? []).find(
      (x) =>
        x.ingredient_id === p.ingredient_id && x.unit === p.unit && x.valid_from === p.valid_from,
    );
    return !now || now.price_minor !== p.price_minor;
  });
  if (wrong.length)
    throw new ImportError(
      'VERIFY_FAILED',
      `после загрузки не совпали цены: ${wrong
        .slice(0, 5)
        .map((p) => `строка ${p.line}`)
        .join(', ')}`,
    );
}
/** The supplier ids a plan touches (existing and new). */
const planSupplierIds = (plan) =>
  new Set(
    plan.suppliers.map(
      (s) => s.id ?? uuidOf([plan.branch_id, plan.plan_sha256, 'supplier', s.key]),
    ),
  );
/**
 * Applies a reviewed plan through `request(path, body?)`. Safe to repeat: parts already in are
 * recognised by the batch and skipped; the same part again is answered from bo_commands.
 */
export async function applyPlan({ plan, expectedPlan, request, log = () => {} }) {
  checkPlan(plan, expectedPlan);
  const branch = plan.branch_id;
  const ids = planSupplierIds(plan);
  const before = await readBatch(request, branch, plan.batch_id);
  const live = await readLive(request, branch, (s) => ids.has(s.id));
  const remaining = preflight(plan, live, before);
  let sent = 0;
  for (const part of remaining) {
    await request(`branches/${branch}/commands`, part.body);
    sent++;
    log({
      event: 'supplier_prices_import_part',
      part: part.part,
      parts: plan.parts.length,
      prices: part.body.command.prices.length,
      new_suppliers: part.new_suppliers.length,
    });
  }
  const after = await readBatch(request, branch, plan.batch_id);
  verifyApplied(plan, await readLive(request, branch, (s) => ids.has(s.id)), after);
  return {
    plan_sha256: plan.plan_sha256,
    batch_id: plan.batch_id,
    parts: plan.parts.length,
    sent,
    skipped: plan.parts.length - remaining.length,
    already_applied: remaining.length === 0,
    verified: true,
  };
}

// ------------------------------------------------------------------- the operator ----

async function readRegular(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit)
    throw new ImportError('FILE', `${path}: не файл или слишком большой`);
  return readFile(path);
}
/** The profile of --profile: a built-in name or a JSON file. */
export async function loadProfile(value = 'iiko') {
  if (value in PROFILES) return parseProfile(value);
  return parseProfile((await readRegular(value, 64 * 1024)).toString('utf8'));
}
/** Dry run: the plan file and the report. Writes only the plan file. */
export async function runPlan({ file, branch, request, profile, validFrom, planPath }) {
  const fileBytes = await readRegular(file, MAX_FILE_BYTES);
  const parsed = readPricesFile(fileBytes, profile);
  const names = new Set(parsed.rows.map((r) => normalizeName(r.supplier.replace(/\s+/g, ' '))));
  const live = await readLive(request, branch, (s) => names.has(normalizeName(s.name)));
  const plan = planImport({
    fileBytes,
    fileName: basename(file),
    profile,
    validFrom,
    branch,
    live,
  });
  await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
  return { plan, planPath };
}
/** --apply: the reviewed plan file for the same file bytes and branch. */
export async function runApply({ file, branch, request, planPath, expectedPlan, log }) {
  const fileBytes = await readRegular(file, MAX_FILE_BYTES);
  const plan = parsedOrNull((await readRegular(planPath, 64 * 1024 * 1024)).toString('utf8'));
  if (!plan || plan.schema !== PLAN_SCHEMA)
    throw new ImportError('PLAN_INVALID', 'файл плана не разобран');
  if (plan.branch_id !== branch) throw new ImportError('PLAN_MISMATCH', 'план другой точки');
  if (plan.file_sha256 !== sha256(fileBytes))
    throw new ImportError('PLAN_MISMATCH', 'файл изменён после плана: постройте план заново');
  return applyPlan({ plan, expectedPlan, request, log });
}

const FLAGS = {
  values: [
    '--file',
    '--branch',
    '--token-file',
    '--api',
    '--plan',
    '--expected-plan',
    '--profile',
    '--valid-from',
  ],
  switches: ['--apply', '--json'],
};
export function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag in options) throw new UsageError(`${flag} twice`);
    if (FLAGS.switches.includes(flag)) options[flag] = true;
    else if (FLAGS.values.includes(flag)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--'))
        throw new UsageError(`${flag} needs a value`);
      options[flag] = value;
    } else throw new UsageError(`unknown argument ${flag}`);
  }
  for (const flag of ['--file', '--branch', '--token-file'])
    if (!(flag in options)) throw new UsageError(`${flag} is required`);
  if (!UUID.test(options['--branch'])) throw new UsageError('--branch must be a branch uuid');
  if (options['--apply'] && !/^[0-9a-f]{64}$/.test(options['--expected-plan'] ?? ''))
    throw new UsageError('--apply needs --expected-plan <sha256 of the reviewed plan>');
  if (!options['--apply'] && options['--expected-plan'])
    throw new UsageError('--expected-plan only with --apply');
  for (const flag of ['--profile', '--valid-from'])
    if (options['--apply'] && options[flag])
      throw new UsageError(`${flag} belongs to the plan (dry run), not to --apply`);
  if (options['--valid-from'] && !/^\d{4}-\d{2}-\d{2}$/.test(options['--valid-from']))
    throw new UsageError('--valid-from must be YYYY-MM-DD');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const branch = options['--branch'];
  const json = options['--json'] === true;
  const request = backofficeApi({
    base: apiBase(options['--api'] ?? DEFAULT_API),
    token: await readCredential(options['--token-file'], branch),
  });
  const planPath = options['--plan'] ?? `${options['--file']}.plan.json`;
  if (options['--apply']) {
    const result = await runApply({
      file: options['--file'],
      branch,
      request,
      planPath,
      expectedPlan: options['--expected-plan'],
      log: (line) => console.error(JSON.stringify(line)),
    });
    console.log(
      json
        ? JSON.stringify({ event: 'supplier_prices_import_applied', ...result })
        : result.already_applied
          ? `План ${result.plan_sha256} уже загружен: ничего не отправлено, цены сверены.`
          : `Загружено частей: ${result.sent} из ${result.parts}${result.skipped ? ` (уже были: ${result.skipped})` : ''}. Цены сверены с планом. Импорт ${result.batch_id} виден в бэк-офисе: «Закупки» -> «Поставщики и цены» -> «Импорт цен».`,
    );
    return;
  }
  const { plan } = await runPlan({
    file: options['--file'],
    branch,
    request,
    profile: await loadProfile(options['--profile']),
    validFrom: options['--valid-from'],
    planPath,
  });
  console.log(
    json
      ? JSON.stringify({
          event: 'supplier_prices_import_planned',
          ok: true,
          plan_sha256: plan.plan_sha256,
          plan_file: planPath,
          parts: plan.parts.length,
          counts: plan.counts,
          new_suppliers: plan.suppliers.filter((s) => s.action === 'create').map((s) => s.name),
          issues: plan.issues.slice(0, 50),
          ignored_columns: plan.ignored_columns,
        })
      : reportText(plan, { planFile: planPath }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    const usage = error instanceof UsageError;
    console.error(
      JSON.stringify({
        event: 'supplier_prices_import_failed',
        code: usage ? 'USAGE' : (error.code ?? 'ERROR'),
        message: String(error.message ?? error),
      }),
    );
    process.exitCode = usage ? 2 : 1;
  });
