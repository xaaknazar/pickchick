#!/usr/bin/env node
/**
 * Opening stock import of the 19.11.2026 cutover (contracts CC-8, design-backoffice 2 Д5, 4).
 *
 *   node scripts/stock-opening-import.mjs --csv <inventory.csv> --branch <uuid>
 *        --token-file <credential.json> [--api <base>] [--zero-existing] [--plan <plan.json>]
 *   node scripts/stock-opening-import.mjs --csv <inventory.csv> --branch <uuid>
 *        --token-file <credential.json> [--api <base>] [--plan <plan.json>]
 *        --apply --expected-plan <sha256>
 *
 * Dry run (default): reads the inventory CSV of 18.11 and the branch's live stock (GET
 * .../backoffice/branches/:id), writes the plan file (default <csv>.plan.json) and prints the plan
 * SHA-256 with a summary. Nothing is written to the cloud.
 * --apply: sends exactly the reviewed plan file (its SHA-256 must equal --expected-plan and the
 * CSV must be the same bytes) as audited back-office `stock` commands of kind `count`, at most
 * 100 lines each, in order. Every command has a request_id derived from the plan, so a repeat
 * after a lost answer never creates a second document; before sending, each planned balance must
 * be either untouched since the plan or already set by this plan (otherwise nothing is sent),
 * and afterwards every balance is read back and compared with the plan.
 *
 * CSV (UTF-8, «;» «,» or tab, header row): ingredient_id and/or name (Russian aliases: id,
 * наименование, название), quantity (количество), unit (ед, единица: кг, г, л, мл, шт) and
 * total_value_tenge (сумма, стоимость) - the total value of that quantity, required: a positive
 * quantity needs a positive value. Names match only one ingredient (case, spaces and ё ignored);
 * id and name together must agree. A negative iiko quantity is not transferred: the opening
 * balance of that item is 0. Exact decimals only: no rounding of quantities or tiyn.
 *
 * A count sets the balance and takes the CSV value only for an ingredient whose balance is 0
 * (otherwise the count keeps the current average cost). An ingredient with a balance already is
 * therefore refused, unless --zero-existing: then the plan first counts it to 0 (a separate
 * document «обнуление перед начальными остатками») and then sets the CSV quantity and value.
 * Ingredients absent from the CSV are not touched (the plan lists those with a balance).
 *
 * The API base is local by default (http://127.0.0.1:3100); plain HTTP only to loopback. The
 * token comes from the private catalog credential file (chmod 600) and is never printed.
 * Exit 0: done. Exit 1: refused (errors in the file, plan or API answer). Exit 2: usage.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_API, apiBase, readCredential } from './catalog-menu-import.mjs';

export const PLAN_SCHEMA = 'pickchick.stock-opening-import/v1';
/** One back-office stock command takes at most 100 lines (packages/backoffice-core model.ts). */
export const CHUNK_LINES = 100;
export const MAX_ROWS = 5000;
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
/** The API's Amount: at most 15 digits of minimal units. */
const MAX_AMOUNT = 999_999_999_999_999n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** CSV unit -> ingredient unit and decimal places of the minimal unit. */
export const UNITS = Object.freeze({
  кг: ['g', 3],
  г: ['g', 0],
  л: ['ml', 3],
  мл: ['ml', 0],
  шт: ['pcs', 0],
});
export const COLUMNS = Object.freeze({
  ingredient_id: ['ingredient_id', 'id'],
  name: ['name', 'наименование', 'название'],
  quantity: ['quantity', 'количество'],
  unit: ['unit', 'ед', 'единица'],
  total_value_tenge: ['total_value_tenge', 'сумма', 'стоимость'],
});

export class OpeningError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export class UsageError extends Error {}

const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export const digest = (v) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Deterministic uuid (version 5 layout) of a value. */
export const uuidOf = (v) => {
  const h = digest(v);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const normalizeName = (v) =>
  String(v)
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е');

/** RFC 4180 fields with the given delimiter; quoted fields may hold the delimiter and newlines. */
export function parseCsv(text, delimiter) {
  const rows = [];
  let row = [],
    field = '',
    quoted = false,
    line = 1,
    start = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push({ line: start, cells: row });
      row = [];
      field = '';
      line++;
      start = line;
    } else field += c;
  }
  if (quoted) throw new OpeningError('CSV_INVALID', 'незакрытая кавычка в CSV');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push({ line: start, cells: row });
  }
  return rows;
}

/**
 * Exact decimal -> integer minimal units with `scale` places (no rounding). Spaces as thousands
 * separators and a decimal comma are accepted. Returns a BigInt or throws a row error text.
 */
export function decimalUnits(text, scale) {
  const s = String(text)
    .replace(/\s/g, '') // \s covers no-break and narrow spaces too
    .replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error('не число');
  const negative = s.startsWith('-');
  const [whole, fraction = ''] = (negative ? s.slice(1) : s).split('.');
  if (/[1-9]/.test(fraction.slice(scale)))
    throw new Error(scale ? `больше ${scale} знаков после запятой` : 'нужно целое число');
  const n =
    BigInt(whole) * 10n ** BigInt(scale) +
    BigInt(fraction.slice(0, scale).padEnd(scale, '0') || '0');
  if (n > MAX_AMOUNT) throw new Error('слишком большое число');
  return negative ? -n : n;
}

/** Header and rows of the inventory CSV (see the module comment). */
export function readOpeningCsv(bytes) {
  if (bytes.length > MAX_CSV_BYTES) throw new OpeningError('CSV_INVALID', 'файл больше 5 МБ');
  let text = bytes.toString('utf8');
  if (text.includes('�'))
    throw new OpeningError('CSV_ENCODING', 'файл не в UTF-8: сохраните CSV в кодировке UTF-8');
  if (text.startsWith('﻿')) text = text.slice(1);
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ',';
  const rows = parseCsv(text, delimiter);
  const header = rows.shift();
  if (!header) throw new OpeningError('CSV_INVALID', 'пустой файл');
  const index = {};
  const ignored = [];
  header.cells.forEach((cell, i) => {
    const name = normalizeName(cell);
    const key = Object.keys(COLUMNS).find((k) => COLUMNS[k].includes(name));
    if (!key) {
      if (name) ignored.push(cell.trim());
      return;
    }
    if (key in index) throw new OpeningError('CSV_HEADER', `колонка «${cell.trim()}» дважды`);
    index[key] = i;
  });
  for (const key of ['quantity', 'unit', 'total_value_tenge'])
    if (!(key in index)) throw new OpeningError('CSV_HEADER', `нет колонки ${key}`);
  if (!('ingredient_id' in index) && !('name' in index))
    throw new OpeningError('CSV_HEADER', 'нужна колонка ingredient_id или name');
  const data = rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (!data.length) throw new OpeningError('CSV_INVALID', 'в файле нет строк');
  if (data.length > MAX_ROWS) throw new OpeningError('CSV_INVALID', `больше ${MAX_ROWS} строк`);
  const cell = (r, key) => (key in index ? (r.cells[index[key]] ?? '').trim() : '');
  return {
    delimiter,
    ignored,
    rows: data.map((r) => ({
      line: r.line,
      ingredient_id: cell(r, 'ingredient_id').toLowerCase(),
      name: cell(r, 'name'),
      quantity: cell(r, 'quantity'),
      unit: normalizeName(cell(r, 'unit')).replace(/\.$/, ''),
      total_value_tenge: cell(r, 'total_value_tenge'),
    })),
  };
}

const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
/** The live stock of the branch from GET .../backoffice/branches/:id. */
function stockOf(snapshot, branch) {
  if (!snapshot || snapshot.branch_id !== branch || !Array.isArray(snapshot.stock))
    throw new OpeningError('SNAPSHOT_INVALID', 'ответ API о складе не разобран');
  const writable = Array.isArray(snapshot.permissions)
    ? snapshot.permissions.includes('stock.count')
    : snapshot.role === 'manager';
  if (!writable)
    throw new OpeningError('FORBIDDEN', 'у этого доступа нет права на инвентаризацию точки');
  return snapshot.stock.map((row) => {
    const p = row.payload ?? {};
    if (
      !UUID.test(row.id) ||
      !text(p.name, 200) ||
      !['g', 'ml', 'pcs'].includes(p.unit) ||
      !/^\d+$/.test(String(row.quantity ?? '0')) ||
      !/^\d+$/.test(String(row.value_minor ?? '0'))
    )
      throw new OpeningError('SNAPSHOT_INVALID', 'ответ API о складе не разобран');
    return {
      id: row.id,
      name: p.name,
      unit: p.unit,
      active: p.active !== false,
      quantity: BigInt(row.quantity ?? '0'),
      value: BigInt(row.value_minor ?? '0'),
      // A balance row appears with the ingredient; revision 0 until its first document.
      revision: Number(row.revision ?? 0),
    };
  });
}

const UNIT_NAMES = { g: 'г', ml: 'мл', pcs: 'шт' };
/**
 * The plan: one entry per CSV row with its target balance, then the count commands in chunks
 * of 100 lines. Pure: the same CSV bytes, snapshot and options give the same plan and SHA-256.
 */
export function planOpening({
  csvBytes,
  csvName = 'inventory.csv',
  snapshot,
  branch,
  zeroExisting = false,
}) {
  if (!UUID.test(branch)) throw new OpeningError('BRANCH', 'нужен uuid точки');
  const csv = readOpeningCsv(csvBytes);
  const stock = stockOf(snapshot, branch);
  const byId = new Map(stock.map((s) => [s.id, s]));
  const byName = new Map();
  for (const s of stock) {
    const key = normalizeName(s.name);
    byName.set(key, [...(byName.get(key) ?? []), s]);
  }
  const errors = [];
  const issues = [];
  const lines = [];
  const seen = new Map();
  const fail = (row, code, message) => errors.push({ line: row.line, code, message });
  for (const row of csv.rows) {
    let ingredient;
    if (row.ingredient_id) {
      if (!UUID.test(row.ingredient_id)) {
        fail(row, 'ID_INVALID', 'ingredient_id не uuid');
        continue;
      }
      ingredient = byId.get(row.ingredient_id) ?? null;
      if (!ingredient) {
        fail(row, 'NOT_FOUND', 'нет ингредиента с таким ingredient_id');
        continue;
      }
      if (row.name && normalizeName(row.name) !== normalizeName(ingredient.name)) {
        fail(row, 'NAME_MISMATCH', `ingredient_id - это «${ingredient.name}», а не «${row.name}»`);
        continue;
      }
    } else {
      const found = byName.get(normalizeName(row.name)) ?? [];
      if (!row.name) {
        fail(row, 'NAME_REQUIRED', 'нет ни ingredient_id, ни названия');
        continue;
      }
      if (found.length !== 1) {
        fail(
          row,
          found.length ? 'NAME_AMBIGUOUS' : 'NOT_FOUND',
          found.length
            ? `«${row.name}» подходит к ${found.length} ингредиентам: укажите ingredient_id`
            : `нет ингредиента «${row.name}»`,
        );
        continue;
      }
      ingredient = found[0];
    }
    if (!ingredient.active) {
      fail(
        row,
        'INGREDIENT_INACTIVE',
        `«${ingredient.name}» выключен: включите или уберите строку`,
      );
      continue;
    }
    if (seen.has(ingredient.id)) {
      fail(row, 'DUPLICATE', `«${ingredient.name}» уже в строке ${seen.get(ingredient.id)}`);
      continue;
    }
    seen.set(ingredient.id, row.line);
    const unit = UNITS[row.unit];
    if (!unit) {
      fail(row, 'UNIT_INVALID', `единица «${row.unit}»: только кг, г, л, мл, шт`);
      continue;
    }
    if (unit[0] !== ingredient.unit) {
      fail(
        row,
        'UNIT_MISMATCH',
        `«${ingredient.name}» учитывается в ${UNIT_NAMES[ingredient.unit]}, а в файле ${row.unit}`,
      );
      continue;
    }
    let quantity, value;
    try {
      quantity = decimalUnits(row.quantity, unit[1]);
    } catch (error) {
      fail(row, 'QUANTITY_INVALID', `количество «${row.quantity}»: ${error.message}`);
      continue;
    }
    if (row.total_value_tenge === '') {
      fail(row, 'COST_REQUIRED', 'стоимость обязательна');
      continue;
    }
    try {
      value = decimalUnits(row.total_value_tenge, 2);
    } catch (error) {
      fail(row, 'VALUE_INVALID', `стоимость «${row.total_value_tenge}»: ${error.message}`);
      continue;
    }
    const negative = quantity < 0n;
    if (negative) {
      issues.push({
        line: row.line,
        code: 'NEGATIVE_NOT_TRANSFERRED',
        message: `«${ingredient.name}»: отрицательный остаток iiko не переносится, начальный остаток 0`,
      });
      quantity = 0n;
      value = 0n;
    } else if (value < 0n) {
      fail(row, 'VALUE_INVALID', 'отрицательная стоимость при положительном количестве');
      continue;
    } else if (quantity > 0n && value === 0n) {
      fail(row, 'COST_REQUIRED', 'стоимость обязательна: у ненулевого остатка стоимость не 0');
      continue;
    } else if (quantity === 0n && value !== 0n) {
      fail(row, 'VALUE_WITHOUT_QUANTITY', 'стоимость без количества');
      continue;
    }
    if (ingredient.quantity === 0n && ingredient.value !== 0n) {
      fail(
        row,
        'BALANCE_INCONSISTENT',
        `у «${ingredient.name}» стоимость без количества: проверьте склад`,
      );
      continue;
    }
    const unchanged = ingredient.quantity === quantity && ingredient.value === value;
    const existing = !unchanged && ingredient.quantity !== 0n;
    if (existing && !zeroExisting) {
      fail(
        row,
        'EXISTING_BALANCE',
        `у «${ingredient.name}» уже есть остаток: запустите с --zero-existing, чтобы обнулить его перед загрузкой`,
      );
      continue;
    }
    lines.push({
      line: row.line,
      ingredient_id: ingredient.id,
      name: ingredient.name,
      unit: ingredient.unit,
      source: { quantity: row.quantity, unit: row.unit, total_value_tenge: row.total_value_tenge },
      before: {
        quantity: ingredient.quantity.toString(),
        value_minor: ingredient.value.toString(),
        revision: ingredient.revision,
      },
      quantity: quantity.toString(),
      value_minor: value.toString(),
      action: unchanged
        ? 'unchanged'
        : existing
          ? quantity === 0n
            ? 'zero'
            : 'zero_then_set'
          : 'set',
      negative_source: negative,
    });
  }
  const notInFile = stock
    .filter((s) => !seen.has(s.id) && (s.quantity !== 0n || s.value !== 0n))
    .map((s) => ({
      ingredient_id: s.id,
      name: s.name,
      quantity: s.quantity.toString(),
      unit: s.unit,
    }));
  const csvSha256 = sha256(csvBytes);
  const core = {
    schema: PLAN_SCHEMA,
    branch_id: branch,
    csv_sha256: csvSha256,
    zero_existing: zeroExisting,
    lines,
  };
  const coreHash = digest(core);
  const short = coreHash.slice(0, 12);
  const zeroLines = lines.filter((l) => l.action === 'zero' || l.action === 'zero_then_set');
  const setLines = lines.filter((l) => l.action === 'set' || l.action === 'zero_then_set');
  const chunk = (phase, list) => {
    const out = [];
    for (let i = 0; i < list.length; i += CHUNK_LINES) out.push(list.slice(i, i + CHUNK_LINES));
    return out.map((part, n) => {
      const index = n + 1;
      const request_id = uuidOf([branch, coreHash, phase, index]);
      const lineSpan = `${part[0].line}-${part.at(-1).line}`;
      const reference =
        phase === 'zero'
          ? `Обнуление перед начальными остатками ${short} ${index}/${out.length}`
          : `Начальные остатки ${short} ${index}/${out.length}`;
      const reason =
        (phase === 'zero'
          ? 'Обнуление остатков перед загрузкой начальных остатков из инвентаризации. '
          : 'Начальные остатки из инвентаризации. ') +
        `CSV ${csvName}, SHA-256 ${csvSha256}, строки ${lineSpan}. План ${coreHash}.`;
      return {
        phase,
        index,
        request_id,
        lines: part.map((l) => l.line),
        body: {
          request_id,
          reason,
          command: {
            type: 'stock',
            kind: 'count',
            reference,
            lines: part.map((l) => ({
              ingredient_id: l.ingredient_id,
              quantity: phase === 'zero' ? '0' : l.quantity,
              value_minor: phase === 'zero' ? '0' : l.value_minor,
              expected_revision:
                phase === 'set' && l.action === 'zero_then_set'
                  ? l.before.revision + 1
                  : l.before.revision,
            })),
          },
        },
      };
    });
  };
  const chunks = [...chunk('zero', zeroLines), ...chunk('set', setLines)];
  const total = (key) => lines.reduce((a, l) => a + BigInt(l[key]), 0n).toString();
  const summary = {
    rows: csv.rows.length,
    ingredients: lines.length,
    set: lines.filter((l) => l.action === 'set').length,
    zero_then_set: lines.filter((l) => l.action === 'zero_then_set').length,
    zero: lines.filter((l) => l.action === 'zero').length,
    unchanged: lines.filter((l) => l.action === 'unchanged').length,
    negative_not_transferred: lines.filter((l) => l.negative_source).length,
    documents: chunks.length,
    zero_documents: chunks.filter((c) => c.phase === 'zero').length,
    opening_documents: chunks.filter((c) => c.phase === 'set').length,
    total_value_minor: total('value_minor'),
    not_in_file: notInFile.length,
  };
  const plan = {
    ...core,
    csv_file: csvName,
    plan_core_sha256: coreHash,
    chunks,
    summary,
    issues,
    not_in_file: notInFile,
    ignored_columns: csv.ignored,
    errors,
  };
  return { ...plan, plan_sha256: errors.length ? null : planHash(plan) };
}
/** SHA-256 of what --apply sends and checks: the core and every command body. */
export const planHash = (plan) =>
  digest({
    schema: plan.schema,
    branch_id: plan.branch_id,
    csv_sha256: plan.csv_sha256,
    zero_existing: plan.zero_existing,
    lines: plan.lines,
    chunks: plan.chunks,
  });

/**
 * Where each planned balance stands now: `pending` (untouched since the plan), `zeroed` (the
 * zero document of this plan is in) or `done` (its target is set). Anything else means somebody
 * changed the stock after the plan; then nothing may be sent. Returns the chunks still to send.
 */
export function preflight(plan, snapshot) {
  const stock = new Map(stockOf(snapshot, plan.branch_id).map((s) => [s.id, s]));
  const state = new Map();
  for (const l of plan.lines) {
    if (l.action === 'unchanged') continue;
    const s = stock.get(l.ingredient_id);
    if (!s)
      throw new OpeningError(
        'STALE_PLAN',
        `«${l.name}» больше нет на складе: постройте план заново`,
      );
    const at = (revision, quantity, value) =>
      s.revision === revision && s.quantity.toString() === quantity && s.value.toString() === value;
    const r = l.before.revision;
    let where = null;
    if (at(r, l.before.quantity, l.before.value_minor)) where = 'pending';
    else if (l.action === 'zero_then_set' && at(r + 1, '0', '0')) where = 'zeroed';
    else if (l.action === 'zero_then_set' && at(r + 2, l.quantity, l.value_minor)) where = 'done';
    else if (l.action !== 'zero_then_set' && at(r + 1, l.quantity, l.value_minor)) where = 'done';
    if (!where)
      throw new OpeningError(
        'STALE_PLAN',
        `остаток «${l.name}» изменился после плана: ничего не отправлено, постройте план заново`,
      );
    state.set(l.ingredient_id, where);
  }
  const remaining = [];
  for (const c of plan.chunks) {
    const done = c.body.command.lines.map((line) => {
      const where = state.get(line.ingredient_id);
      return c.phase === 'zero' ? where !== 'pending' : where === 'done';
    });
    if (done.every(Boolean)) continue;
    if (done.some(Boolean))
      throw new OpeningError(
        'STALE_PLAN',
        `документ ${c.body.command.reference} применён частично`,
      );
    remaining.push(c);
  }
  return { remaining, state };
}

/** Every planned balance equals its target (the read-back after --apply). */
export function verifyApplied(plan, snapshot) {
  const stock = new Map(stockOf(snapshot, plan.branch_id).map((s) => [s.id, s]));
  const wrong = plan.lines.filter((l) => {
    const s = stock.get(l.ingredient_id);
    return !s || s.quantity.toString() !== l.quantity || s.value.toString() !== l.value_minor;
  });
  if (wrong.length)
    throw new OpeningError(
      'VERIFY_FAILED',
      `после загрузки не совпали остатки: ${wrong
        .slice(0, 5)
        .map((l) => l.name)
        .join(', ')}`,
    );
}

/**
 * Applies a reviewed plan through `request(path, body?)` (GET without body, POST with it). Safe
 * to repeat: applied documents are recognised in the live stock and skipped.
 */
export async function applyPlan({ plan, expectedPlan, request, log = () => {} }) {
  if (!plan.plan_sha256 || plan.errors?.length)
    throw new OpeningError('PLAN_INVALID', 'в плане есть ошибки');
  if (planHash(plan) !== plan.plan_sha256)
    throw new OpeningError('PLAN_INVALID', 'файл плана изменён после построения');
  if (plan.plan_sha256 !== expectedPlan)
    throw new OpeningError('PLAN_MISMATCH', 'SHA-256 плана не совпадает с --expected-plan');
  const before = await request(`branches/${plan.branch_id}`);
  const { remaining } = preflight(plan, before);
  let sent = 0;
  for (const c of remaining) {
    await request(`branches/${plan.branch_id}/commands`, c.body);
    sent++;
    log({
      event: 'stock_opening_document',
      reference: c.body.command.reference,
      lines: c.lines.length,
    });
  }
  const after = await request(`branches/${plan.branch_id}`);
  verifyApplied(plan, after);
  return {
    plan_sha256: plan.plan_sha256,
    sent,
    skipped: plan.chunks.length - remaining.length,
    documents: plan.chunks.length,
    verified: true,
  };
}

const parsedOrNull = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
/** JSON client of the back-office API (GET .../branches/:id, POST .../commands). */
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
      throw new OpeningError(
        'API_UNREACHABLE',
        `${method} ${path}: API не ответил; повторите ту же команду - документы не задвоятся`,
      );
    }
    const json = parsedOrNull(await response.text());
    if (!response.ok) {
      const reason =
        json?.error && typeof json.error.code === 'string' ? `/${json.error.code}` : '';
      const code = typeof json?.code === 'string' ? json.code : 'HTTP';
      throw new OpeningError(
        'API_REFUSED',
        `${method} ${path}: ${response.status} ${code}${reason}`,
      );
    }
    if (!json || typeof json !== 'object')
      throw new OpeningError('API_RESPONSE_INVALID', `${method} ${path}: ответ не разобран`);
    return json;
  };
}

async function readRegular(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit)
    throw new OpeningError('FILE', `${path}: не файл или слишком большой`);
  return readFile(path);
}
/** Dry run: the plan file and its summary. Writes only the plan file. */
export async function runPlan({ csv, branch, request, zeroExisting = false, planPath }) {
  const csvBytes = await readRegular(csv, MAX_CSV_BYTES);
  const snapshot = await request(`branches/${branch}`);
  const plan = planOpening({ csvBytes, csvName: basename(csv), snapshot, branch, zeroExisting });
  const ok = plan.errors.length === 0;
  if (ok) await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
  return {
    event: 'stock_opening_planned',
    ok,
    plan_sha256: plan.plan_sha256,
    plan_file: ok ? planPath : null,
    summary: plan.summary,
    errors: plan.errors.slice(0, 50),
    issues: plan.issues.slice(0, 50),
    not_in_file: plan.not_in_file.slice(0, 50).map((i) => i.name),
    ignored_columns: plan.ignored_columns,
  };
}
/** --apply: the reviewed plan file for the same CSV bytes and branch. */
export async function runApply({ csv, branch, request, planPath, expectedPlan, log }) {
  const csvBytes = await readRegular(csv, MAX_CSV_BYTES);
  const plan = parsedOrNull((await readRegular(planPath, 50 * 1024 * 1024)).toString('utf8'));
  if (!plan || plan.schema !== PLAN_SCHEMA)
    throw new OpeningError('PLAN_INVALID', 'файл плана не разобран');
  if (plan.branch_id !== branch) throw new OpeningError('PLAN_MISMATCH', 'план другой точки');
  if (plan.csv_sha256 !== sha256(csvBytes))
    throw new OpeningError('PLAN_MISMATCH', 'CSV изменён после плана: постройте план заново');
  return {
    event: 'stock_opening_applied',
    ...(await applyPlan({ plan, expectedPlan, request, log })),
  };
}

const FLAGS = {
  values: ['--csv', '--branch', '--token-file', '--api', '--plan', '--expected-plan'],
  switches: ['--zero-existing', '--apply'],
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
  for (const flag of ['--csv', '--branch', '--token-file'])
    if (!(flag in options)) throw new UsageError(`${flag} is required`);
  if (!UUID.test(options['--branch'])) throw new UsageError('--branch must be a branch uuid');
  if (options['--apply'] && !/^[0-9a-f]{64}$/.test(options['--expected-plan'] ?? ''))
    throw new UsageError('--apply needs --expected-plan <sha256 of the reviewed plan>');
  if (!options['--apply'] && options['--expected-plan'])
    throw new UsageError('--expected-plan only with --apply');
  if (options['--apply'] && options['--zero-existing'])
    throw new UsageError('--zero-existing belongs to the plan (dry run), not to --apply');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const branch = options['--branch'];
  const request = backofficeApi({
    base: apiBase(options['--api'] ?? DEFAULT_API),
    token: await readCredential(options['--token-file'], branch),
  });
  const planPath = options['--plan'] ?? `${options['--csv']}.plan.json`;
  const result = options['--apply']
    ? await runApply({
        csv: options['--csv'],
        branch,
        request,
        planPath,
        expectedPlan: options['--expected-plan'],
        log: (line) => console.error(JSON.stringify(line)),
      })
    : await runPlan({
        csv: options['--csv'],
        branch,
        request,
        zeroExisting: options['--zero-existing'] === true,
        planPath,
      });
  console.log(JSON.stringify(result));
  if (result.ok === false) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    const usage = error instanceof UsageError;
    console.error(
      JSON.stringify({
        event: 'stock_opening_import_failed',
        code: usage ? 'USAGE' : (error.code ?? 'ERROR'),
        message: String(error.message ?? error),
      }),
    );
    process.exitCode = usage ? 2 : 1;
  });
