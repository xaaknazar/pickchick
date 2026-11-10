/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import {
  BODY_BUDGET,
  COUNT_KEYS,
  ISSUE_CATEGORIES,
  ImportError,
  MAX_ROWS,
  PART_PRICES,
  REPORT_SCHEMA,
  SUMMARY_BYTES,
  UsageError,
  applyPlan,
  checkPlan,
  parseArguments,
  parseDay,
  parsePrice,
  parseProfile,
  planImport,
  readPricesFile,
  reportText,
  unitOf,
} from '../../scripts/supplier-prices-import.mjs';
import {
  IMPORT_COUNT_KEYS,
  IMPORT_ISSUE_CATEGORIES,
  IMPORT_PART_PRICES,
  IMPORT_REPORT_SCHEMA,
  IMPORT_ROWS_MAX,
  IMPORT_SUMMARY_BYTES,
  P2Request,
} from '../../packages/backoffice-core/dist/index.js';

/**
 * Lane bo-ui2 step 3 without a database: the price file under its column profile, exact cells,
 * every report category of the plan, the hash, the parts under the API body limit and their
 * bodies parsed by the server schema, and --apply against an in-memory back office (wrong hash,
 * an edited plan, a stale plan, a lost answer, a repeat). Synthetic names and prices only.
 */
const branch = randomUUID();
const file = (...lines) => Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
const iiko = parseProfile('iiko');
const HEAD = 'Поставщик;Товар;Ед. изм.;Цена;Дата';
const ingredient = (name, unit, active = true) => ({ id: randomUUID(), name, unit, active });
/** A small branch: ingredients, two suppliers (one archived) and one price of «Поставщик 1». */
function world() {
  const i = {
    fillet: ingredient('Синтетическое филе', 'g'),
    bun: ingredient('Синтетическая булка', 'pcs'),
    oil: ingredient('Синтетическое масло', 'ml'),
    salt: ingredient('Синтетическая соль', 'g'),
    old: ingredient('Синтетическая старая позиция', 'pcs', false),
    sauceA: ingredient('Синтетический соус', 'ml'),
    sauceB: ingredient('синтетический  соус', 'ml'),
    ezh: ingredient('Синтетический ёж', 'pcs'),
  };
  const s = {
    one: { id: randomUUID(), name: 'Поставщик 1', kind: 'supplier', active: true },
    archived: { id: randomUUID(), name: 'Поставщик 3', kind: 'supplier', active: false },
    twinA: { id: randomUUID(), name: 'Поставщик Ё', kind: 'supplier', active: true },
    twinB: { id: randomUUID(), name: 'Поставщик Е', kind: 'supplier', active: true },
  };
  return {
    i,
    s,
    live: {
      ingredients: Object.values(i),
      suppliers: Object.values(s),
      prices: new Map([
        [
          s.one.id,
          [
            {
              ingredient_id: i.fillet.id,
              unit: 'kg',
              valid_from: '2026-11-01',
              price_minor: '250000',
              import_batch_id: null,
            },
            {
              ingredient_id: i.fillet.id,
              unit: 'g',
              valid_from: '2026-11-01',
              price_minor: '250',
              import_batch_id: null,
            },
          ],
        ],
      ]),
    },
  };
}

test('the script follows the server: report schema, categories, counts and limits', () => {
  assert.equal(REPORT_SCHEMA, IMPORT_REPORT_SCHEMA);
  assert.deepEqual({ ...ISSUE_CATEGORIES }, { ...IMPORT_ISSUE_CATEGORIES });
  assert.deepEqual([...COUNT_KEYS], [...IMPORT_COUNT_KEYS]);
  assert.equal(SUMMARY_BYTES, IMPORT_SUMMARY_BYTES);
  assert.equal(PART_PRICES, IMPORT_PART_PRICES);
  assert.equal(MAX_ROWS, IMPORT_ROWS_MAX);
  assert.ok(BODY_BUDGET < 100 * 1024);
});

test('the file: iiko and csv headers, a custom profile, BOM and delimiters; header errors', () => {
  const read = readPricesFile(
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      file(
        'Контрагент;Номенклатура;Ед.;Цена за ед.;Дата документа;Артикул;Группа',
        'Поставщик 1;Синтетическое филе;кг;2 500,00;01.11.2026;00123;Мясо',
        ';;;;;;',
      ),
    ]),
    iiko,
  );
  assert.equal(read.delimiter, ';');
  assert.deepEqual(read.columns, {
    supplier: 'Контрагент',
    name: 'Номенклатура',
    unit: 'Ед.',
    price: 'Цена за ед.',
    date: 'Дата документа',
  });
  assert.deepEqual(read.ignored, ['Артикул', 'Группа']);
  assert.deepEqual(read.rows, [
    {
      line: 2,
      supplier: 'Поставщик 1',
      code: '',
      name: 'Синтетическое филе',
      unit: 'кг',
      price: '2 500,00',
      date: '01.11.2026',
      kind: '',
    },
  ]);
  const csv = readPricesFile(
    file(
      'supplier,ingredient_id,unit,price_tenge,valid_from,supplier_kind',
      'Пекарня 1,0b000000-0000-4000-8000-000000000001,шт,120,2026-11-01,пекарня',
    ),
    parseProfile('csv'),
  );
  assert.equal(csv.delimiter, ',');
  assert.equal(csv.rows[0].code, '0b000000-0000-4000-8000-000000000001');
  assert.equal(csv.rows[0].kind, 'пекарня');
  // A custom profile for headers of another export.
  const custom = parseProfile(
    JSON.stringify({
      source: 'iiko_export',
      columns: { supplier: 'Кто', name: ['Что'], unit: 'Мера', price: 'Стоимость единицы' },
    }),
  );
  assert.equal(custom.name, 'custom');
  const tab = readPricesFile(file('Кто\tЧто\tМера\tСтоимость единицы', 'А\tБ\tшт\t1'), custom);
  assert.equal(tab.delimiter, '\t');
  assert.equal('date' in tab.columns, false);
  for (const bad of [
    '[]',
    '{"columns":{"supplier":"Кто"},"x":1}',
    '{"source":"excel","columns":{}}',
    '{"columns":{"vendor":"Кто"}}',
    '{"columns":{"supplier":[]}}',
    'не json',
  ])
    assert.throws(
      () => parseProfile(bad),
      (e) => e.code === 'PROFILE_INVALID',
      bad,
    );
  const refused = (bytes, code, profile = iiko) =>
    assert.throws(
      () => readPricesFile(bytes, profile),
      (e) => e instanceof ImportError && e.code === code,
    );
  refused(file('Поставщик;Товар;Ед.;Ед. изм.;Цена', 'а;б;шт;шт;1'), 'FILE_HEADER');
  refused(file('Поставщик;Товар;Ед.', 'а;б;шт'), 'FILE_HEADER');
  refused(file('Товар;Ед.;Цена', 'б;шт;1'), 'FILE_HEADER');
  refused(file('Поставщик;Ед.;Цена', 'а;шт;1'), 'FILE_HEADER');
  refused(file(HEAD), 'FILE_INVALID');
  refused(file(HEAD, 'а;"б;шт;1;01.11.2026'), 'FILE_INVALID');
  refused(Buffer.concat([file(HEAD), Buffer.from([0xcf, 0xee])]), 'FILE_ENCODING');
  refused(
    file(HEAD, ...Array.from({ length: MAX_ROWS + 1 }, () => 'а;б;шт;1;01.11.2026')),
    'FILE_INVALID',
  );
});

test('cells: exact tenge to tiyn, Almaty days, units; never rounded', () => {
  assert.equal(parsePrice('2 500,50'), 250050n);
  assert.equal(parsePrice('2 500.5 ₸'), 250050n);
  assert.equal(parsePrice('120 тг'), 12000n);
  assert.equal(parsePrice('12,500'), 1250n);
  for (const bad of ['', '-5', '0', '0,00', '0,4523', '1.234,50', 'abc', '1e3'])
    assert.throws(() => parsePrice(bad), Error, bad);
  assert.equal(parseDay('01.11.2026'), '2026-11-01');
  assert.equal(parseDay('5.11.2026 10:30'), '2026-11-05');
  assert.equal(parseDay('2026-11-05'), '2026-11-05');
  assert.equal(parseDay('2026-11-05T23:59:00'), '2026-11-05');
  for (const bad of [
    '',
    '05/11/2026',
    '31.02.2026',
    '01.11.2023',
    '45600',
    '2026-11-05Z',
    '1.11.26',
  ])
    assert.throws(() => parseDay(bad), Error, bad);
  assert.match(
    (() => {
      try {
        parseDay('45600');
      } catch (e) {
        return e.message;
      }
    })(),
    /числом/,
  );
  assert.deepEqual(
    ['кг', 'КГ.', 'г', 'гр', 'л', 'мл', 'шт', 'шт.', 'pcs', 'уп', 'порц', ''].map(unitOf),
    ['kg', 'kg', 'g', 'g', 'l', 'ml', 'pcs', 'pcs', 'pcs', null, null, null],
  );
});

test('the plan: every report category, the counts, new suppliers; nothing guessed', () => {
  const { i, s, live } = world();
  const bytes = file(
    `${HEAD};Вид поставщика;ingredient_id`,
    // 2: a price already there with the same value: unchanged
    'Поставщик 1;Синтетическое филе;кг;2 500;01.11.2026;;',
    // 3: new price of an existing supplier (case, spaces and ё of the name do not matter)
    'поставщик  1;СИНТЕТИЧЕСКАЯ булка;шт;120;01.11.2026;;',
    // 4: new supplier (bakery) with a new price
    'Пекарня 1;Синтетическая булка;шт;110;01.11.2026;пекарня;',
    // 5: the same supplier, other kind: a note, the price is loaded
    'Пекарня 1;Синтетический еж;шт;300;01.11.2026;цех;',
    // 6: ingredient not found by name
    'Поставщик 1;Синтетический перец;кг;900;01.11.2026;;',
    // 7: code of no ingredient; 8: code that is not a uuid; 9: code and name disagree
    `Поставщик 1;;кг;900;01.11.2026;;${randomUUID()}`,
    'Поставщик 1;;кг;900;01.11.2026;;00123',
    `Поставщик 1;Синтетическая соль;шт;900;01.11.2026;;${i.bun.id}`,
    // 10: by code: loaded; 11: a name of two ingredients: ambiguous
    `Поставщик 1;;кг;150;01.11.2026;;${i.salt.id}`,
    'Поставщик 1;Синтетический соус;л;900;01.11.2026;;',
    // 12: unit unknown; 13: unit does not measure the ingredient
    'Поставщик 1;Синтетическое масло;уп;900;01.11.2026;;',
    'Поставщик 1;Синтетическое масло;кг;900;01.11.2026;;',
    // 14, 15: the same row twice (one kept); 16, 17: the same key with two prices (none kept)
    'Поставщик 2;Синтетическое масло;л;1 800,50;02.11.2026;;',
    'Поставщик 2;Синтетическое масло;л;1800.50;02.11.2026;;',
    'Поставщик 2;Синтетическая соль;кг;200;02.11.2026;;',
    'Поставщик 2;Синтетическая соль;кг;210;02.11.2026;;',
    // 18: another price of that day already there: a conflict, never overwritten
    'Поставщик 1;Синтетическое филе;г;2,60;01.11.2026;;',
    // 19: switched-off ingredient; 20: archived supplier; 21: two suppliers with this name
    'Поставщик 1;Синтетическая старая позиция;шт;100;01.11.2026;;',
    'Поставщик 3;Синтетическая булка;шт;100;01.11.2026;;',
    'Поставщик Е;Синтетическая булка;шт;100;01.11.2026;;',
    // 22-27: unreadable cells
    ';Синтетическая булка;шт;100;01.11.2026;;',
    `${'П'.repeat(121)};Синтетическая булка;шт;100;01.11.2026;;`,
    'Поставщик 1;Синтетическая булка;шт;0,4523;01.11.2026;;',
    'Поставщик 1;Синтетическая булка;шт;100;05/11/2026;;',
    'Поставщик 1;;шт;100;01.11.2026;;',
    'Поставщик 1;Синтетическая булка;шт;100;01.11.2026;склад;',
  );
  const plan = planImport({
    fileBytes: bytes,
    fileName: 'prices.csv',
    profile: iiko,
    branch,
    live,
  });
  assert.deepEqual(
    plan.issues.map((x) => [x.line, x.code, x.category]),
    [
      [5, 'KIND_IGNORED', 'notes'],
      [6, 'NOT_FOUND', 'not_found'],
      [7, 'CODE_UNKNOWN', 'not_found'],
      [8, 'CODE_INVALID', 'invalid'],
      [9, 'CODE_NAME_MISMATCH', 'ambiguous'],
      [11, 'NAME_AMBIGUOUS', 'ambiguous'],
      [12, 'UNIT_UNKNOWN', 'unit_mismatch'],
      [13, 'UNIT_MISMATCH', 'unit_mismatch'],
      [15, 'DUPLICATE', 'duplicates'],
      [16, 'DUPLICATE_CONFLICT', 'duplicates'],
      [17, 'DUPLICATE_CONFLICT', 'duplicates'],
      [18, 'PRICE_EXISTS', 'conflicts'],
      [19, 'INGREDIENT_INACTIVE', 'inactive'],
      [20, 'SUPPLIER_ARCHIVED', 'inactive'],
      [21, 'SUPPLIER_AMBIGUOUS', 'ambiguous'],
      [22, 'SUPPLIER_REQUIRED', 'invalid'],
      [23, 'SUPPLIER_NAME_INVALID', 'invalid'],
      [24, 'PRICE_INVALID', 'invalid'],
      [25, 'DATE_INVALID', 'invalid'],
      [26, 'NAME_REQUIRED', 'invalid'],
      [27, 'KIND_INVALID', 'invalid'],
    ],
  );
  assert.deepEqual(plan.counts, {
    rows: 26,
    matched: 6,
    new_prices: 5,
    unchanged: 1,
    new_suppliers: 2,
    not_found: 2,
    ambiguous: 3,
    unit_mismatch: 2,
    duplicates: 3,
    conflicts: 1,
    inactive: 2,
    invalid: 7,
    notes: 1,
  });
  // Every row is in exactly one place: a price of the plan, a duplicate kept once, or the report.
  assert.equal(
    plan.counts.matched + plan.issues.filter((x) => x.category !== 'notes').length,
    plan.counts.rows,
  );
  assert.deepEqual(
    plan.prices.map((p) => [p.line, p.supplier, p.ingredient_id, p.unit, p.price_minor, p.action]),
    [
      [2, 'поставщик 1', i.fillet.id, 'kg', '250000', 'unchanged'],
      [3, 'поставщик 1', i.bun.id, 'pcs', '12000', 'create'],
      [4, 'пекарня 1', i.bun.id, 'pcs', '11000', 'create'],
      [5, 'пекарня 1', i.ezh.id, 'pcs', '30000', 'create'],
      [10, 'поставщик 1', i.salt.id, 'kg', '15000', 'create'],
      [14, 'поставщик 2', i.oil.id, 'l', '180050', 'create'],
    ],
  );
  assert.deepEqual(
    plan.suppliers.map((x) => [x.name, x.kind, x.action, x.id]),
    [
      ['Поставщик 1', 'supplier', 'existing', s.one.id],
      ['Пекарня 1', 'bakery', 'create', null],
      ['Поставщик 2', 'supplier', 'create', null],
    ],
  );
  // The report text names each category; one part; its body is what the server parses.
  const text = reportText(plan, { planFile: 'prices.csv.plan.json' });
  for (const words of [
    'новых цен: 5',
    'без изменений): 1',
    'Новых поставщиков: 2',
    'позиция не найдена: 2',
    'неоднозначно: 3',
    'единица не подходит: 2',
    'повторы в файле: 3',
    'на этот день уже другая цена: 1',
    'позиция выключена или поставщик в архиве: 2',
    'ошибка в строке: 7',
    'строка 18, на этот день уже другая цена',
    plan.plan_sha256,
  ])
    assert.ok(text.includes(words), words);
  assert.doesNotMatch(text, /[–—]/);
  assert.equal(plan.parts.length, 1);
  const body = plan.parts[0].body;
  assert.equal(P2Request.safeParse(body).success, true);
  assert.equal(body.command.summary.issues.length, plan.issues.length);
  assert.deepEqual(
    body.command.suppliers.map((x) => [x.name, x.kind]),
    [
      ['Пекарня 1', 'bakery'],
      ['Поставщик 2', 'supplier'],
    ],
  );
  // --valid-from: only for a file without a date column.
  assert.throws(
    () => planImport({ fileBytes: bytes, profile: iiko, branch, live, validFrom: '2026-11-01' }),
    (e) => e.code === 'VALID_FROM',
  );
  const undated = file('Поставщик;Товар;Ед.;Цена', 'Поставщик 1;Синтетическая булка;шт;120');
  assert.throws(
    () => planImport({ fileBytes: undated, profile: iiko, branch, live }),
    (e) => e.code === 'VALID_FROM',
  );
  const dated = planImport({
    fileBytes: undated,
    profile: iiko,
    branch,
    live,
    validFrom: '2026-11-19',
  });
  assert.equal(dated.prices[0].valid_from, '2026-11-19');
});

test('the plan: same input, same hash; parts under the body limit; the report fits its budget', () => {
  const { live } = world();
  const many = [];
  for (let n = 1; n <= 1400; n++) {
    const item = ingredient(`Синтетическая позиция ${String(n).padStart(4, '0')}`, 'g');
    live.ingredients.push(item);
    many.push(`Поставщик ${10 + (n % 40)};${item.name};кг;${n},5;0${1 + (n % 9)}.11.2026`);
  }
  // 400 rows of the report with long names.
  for (let n = 1; n <= 400; n++)
    many.push(
      `Поставщик 9;Синтетическая неизвестная позиция с длинным названием ${n};кг;10;01.11.2026`,
    );
  const bytes = file(HEAD, ...many);
  const plan = planImport({ fileBytes: bytes, fileName: 'big.csv', profile: iiko, branch, live });
  const again = planImport({ fileBytes: bytes, fileName: 'big.csv', profile: iiko, branch, live });
  assert.equal(plan.plan_sha256, again.plan_sha256);
  assert.deepEqual(plan.parts, again.parts);
  assert.equal(plan.counts.new_prices, 1400);
  assert.equal(plan.counts.new_suppliers, 40);
  assert.ok(plan.parts.length >= 3, String(plan.parts.length));
  const ids = new Set();
  let total = 0;
  const introduced = new Map();
  for (const p of plan.parts) {
    const size = Buffer.byteLength(JSON.stringify(p.body));
    assert.ok(size <= BODY_BUDGET, `part ${p.part}: ${size}`);
    const parsed = P2Request.safeParse(p.body);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 2)));
    assert.equal(p.body.command.parts, plan.parts.length);
    assert.equal(p.body.command.batch_id, plan.batch_id);
    assert.ok(p.body.command.prices.length <= PART_PRICES);
    ids.add(p.request_id);
    total += p.body.command.prices.length;
    for (const x of p.body.command.suppliers) introduced.set(x.id, p.part);
    // A new supplier comes with the first part that prices it.
    for (const price of p.body.command.prices)
      if (plan.suppliers.find((x) => x.id === price.supplier_id) === undefined)
        assert.ok(introduced.get(price.supplier_id) <= p.part);
  }
  assert.equal(ids.size, plan.parts.length);
  assert.equal(total, 1400);
  const summary = plan.parts[0].body.command.summary;
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= SUMMARY_BYTES);
  assert.equal(summary.issues_total, 400);
  assert.ok(summary.issues.length > 0 && summary.issues.length < 400);
  // Another file name or another live price gives another plan.
  assert.notEqual(
    planImport({ fileBytes: bytes, fileName: 'other.csv', profile: iiko, branch, live })
      .plan_sha256,
    plan.plan_sha256,
  );
});

/**
 * An in-memory back office for --apply: GET branches/:id, ops/suppliers[?id],
 * ops/supplier-imports?id, POST commands with the import rules of supplier-import.ts (bodies
 * parsed by the server schema, replay by request id, stale and already-applied parts refused).
 */
function memoryApi(live, { loseAnswerOf = null } = {}) {
  const suppliers = live.suppliers.map((s) => ({ ...s }));
  const prices = new Map([...live.prices].map(([k, v]) => [k, v.map((p) => ({ ...p }))]));
  const batches = new Map();
  const commands = new Map();
  const posts = [];
  let lost = loseAnswerOf;
  const fail = (status, code, reason) => {
    const e = new ImportError('API_REFUSED', `${status} ${code}/${reason}`);
    e.status = status;
    e.reason = reason;
    throw e;
  };
  const request = async (path, body) => {
    const [route, query] = path.split('?');
    const id = new URLSearchParams(query ?? '').get('id');
    if (body === undefined) {
      if (route === `branches/${branch}`)
        return {
          branch_id: branch,
          role: 'manager',
          permissions: ['reports.read', 'suppliers.write'],
          capabilities: { supply: true },
          stock: live.ingredients.map((i) => ({
            id: i.id,
            payload: { name: i.name, unit: i.unit, active: i.active, minimum: '0' },
          })),
        };
      if (route === `branches/${branch}/ops/suppliers`)
        return {
          branch_id: branch,
          view: 'suppliers',
          suppliers,
          truncated: { suppliers: false },
          ...(id ? { id, prices: prices.get(id) ?? [], prices_truncated: false } : {}),
        };
      if (route === `branches/${branch}/ops/supplier-imports`) {
        const b = batches.get(id);
        if (!b) fail(404, 'NOT_FOUND', null);
        return {
          view: 'supplier-imports',
          import: {
            id,
            plan_sha256: b.plan,
            parts_applied: [...b.parts].sort(),
            complete: b.parts.size === b.total,
          },
        };
      }
      throw new Error('unexpected GET ' + path);
    }
    assert.equal(route, `branches/${branch}/commands`);
    const parsed = P2Request.safeParse(body);
    assert.equal(parsed.success, true);
    posts.push(body.command.part);
    if (commands.has(body.request_id)) return commands.get(body.request_id);
    const c = parsed.data.command;
    const b = batches.get(c.batch_id);
    if (c.part === 1 ? b : !b || b.parts.has(c.part))
      fail(409, 'CONFLICT', b ? 'IMPORT_ALREADY_APPLIED' : 'IMPORT_STALE');
    for (const s of c.suppliers)
      if (suppliers.some((x) => x.id === s.id || x.name.toLowerCase() === s.name.toLowerCase()))
        fail(409, 'CONFLICT', 'IMPORT_STALE');
    let created = 0;
    for (const p of c.prices) {
      const list = prices.get(p.supplier_id) ?? [];
      const now = list.find(
        (x) =>
          x.ingredient_id === p.ingredient_id && x.unit === p.unit && x.valid_from === p.valid_from,
      );
      if (now && now.price_minor !== p.price_minor) fail(409, 'CONFLICT', 'IMPORT_STALE');
    }
    for (const s of c.suppliers) suppliers.push({ ...s, active: true });
    for (const p of c.prices) {
      const list = prices.get(p.supplier_id) ?? [];
      if (
        !list.some(
          (x) =>
            x.ingredient_id === p.ingredient_id &&
            x.unit === p.unit &&
            x.valid_from === p.valid_from,
        )
      ) {
        list.push({ ...p, import_batch_id: c.batch_id });
        created++;
      }
      prices.set(p.supplier_id, list);
    }
    const batch = b ?? { plan: c.plan_sha256, parts: new Set(), total: c.parts };
    batch.parts.add(c.part);
    batches.set(c.batch_id, batch);
    const result = { batch_id: c.batch_id, part: c.part, prices_created: created };
    commands.set(body.request_id, result);
    if (lost === c.part) {
      lost = null;
      throw new ImportError('API_UNREACHABLE', 'API не ответил');
    }
    return result;
  };
  return { request, posts, prices, suppliers, batches };
}

test('apply: wrong hash and edited plans refused, a lost answer, a repeat, a stale plan', async () => {
  const { live } = world();
  const rows = [];
  for (let n = 1; n <= 1100; n++) {
    const item = ingredient(`Синтетическая позиция ${n}`, 'pcs');
    live.ingredients.push(item);
    rows.push(
      `${['Поставщик 1', 'Поставщик 2', 'Поставщик 4'][n % 3]};${item.name};шт;${n};01.11.2026`,
    );
  }
  const bytes = file(HEAD, ...rows);
  const plan = planImport({ fileBytes: bytes, profile: iiko, branch, live });
  assert.ok(plan.parts.length >= 2);
  const api = memoryApi(live, { loseAnswerOf: 2 });
  // A wrong hash and edited plans: nothing sent.
  await assert.rejects(
    applyPlan({ plan, expectedPlan: 'f'.repeat(64), request: api.request }),
    (e) => e.code === 'PLAN_MISMATCH',
  );
  const edited = structuredClone(plan);
  edited.prices[0].price_minor = '1';
  await assert.rejects(
    applyPlan({ plan: edited, expectedPlan: plan.plan_sha256, request: api.request }),
    (e) => e.code === 'PLAN_INVALID',
  );
  const tampered = structuredClone(plan);
  tampered.parts[0].body.command.prices[0].price_minor = '1';
  assert.throws(
    () => checkPlan(tampered, plan.plan_sha256),
    (e) => e.code === 'PLAN_INVALID',
  );
  assert.deepEqual(api.posts, []);
  // The answer of part 2 is lost: the run stops; the same command again sends the rest.
  await assert.rejects(
    applyPlan({ plan, expectedPlan: plan.plan_sha256, request: api.request }),
    (e) => e.code === 'API_UNREACHABLE',
  );
  assert.deepEqual(api.posts, [1, 2]);
  const log = [];
  const done = await applyPlan({
    plan,
    expectedPlan: plan.plan_sha256,
    request: api.request,
    log: (line) => log.push(line),
  });
  assert.deepEqual(
    [done.sent, done.skipped, done.parts, done.verified, done.already_applied],
    [plan.parts.length - 2, 2, plan.parts.length, true, false],
  );
  assert.deepEqual(api.posts, [1, 2, ...plan.parts.slice(2).map((p) => p.part)]);
  assert.equal(log[0].event, 'supplier_prices_import_part');
  // A repeat sends nothing and checks again.
  const repeat = await applyPlan({ plan, expectedPlan: plan.plan_sha256, request: api.request });
  assert.deepEqual([repeat.sent, repeat.already_applied, repeat.verified], [0, true, true]);
  // The same file planned again: everything is already there, nothing to load.
  const live2 = {
    ingredients: live.ingredients,
    suppliers: api.suppliers,
    prices: api.prices,
  };
  const second = planImport({ fileBytes: bytes, profile: iiko, branch, live: live2 });
  assert.deepEqual(
    [second.plan_sha256, second.parts.length, second.counts.unchanged, second.counts.new_prices],
    [null, 0, 1100, 0],
  );
  assert.match(reportText(second), /Загружать нечего: все сопоставленные цены уже есть/);
  assert.throws(
    () => checkPlan(second, 'f'.repeat(64)),
    (e) => e.code === 'PLAN_EMPTY',
  );
  // A stale plan: after the plan somebody entered another price for one of its rows.
  const fresh = world();
  const stalePlan = planImport({
    fileBytes: file(HEAD, 'Поставщик 1;Синтетическая булка;шт;120;01.11.2026'),
    profile: iiko,
    branch,
    live: fresh.live,
  });
  const staleApi = memoryApi(fresh.live);
  staleApi.prices.get(fresh.s.one.id).push({
    ingredient_id: fresh.i.bun.id,
    unit: 'pcs',
    valid_from: '2026-11-01',
    price_minor: '13000',
    import_batch_id: null,
  });
  await assert.rejects(
    applyPlan({ plan: stalePlan, expectedPlan: stalePlan.plan_sha256, request: staleApi.request }),
    (e) => e.code === 'STALE_PLAN' && /постройте план заново/.test(e.message),
  );
  assert.deepEqual(staleApi.posts, []);
});

test('command line: dry run by default, --apply needs the reviewed plan hash', () => {
  const base = ['--file', 'prices.csv', '--branch', branch, '--token-file', 'credential.json'];
  assert.deepEqual(parseArguments(base), {
    '--file': 'prices.csv',
    '--branch': branch,
    '--token-file': 'credential.json',
  });
  assert.equal(
    parseArguments([...base, '--profile', 'csv', '--valid-from', '2026-11-19'])['--profile'],
    'csv',
  );
  assert.equal(
    parseArguments([...base, '--apply', '--expected-plan', 'a'.repeat(64)])['--apply'],
    true,
  );
  for (const bad of [
    ['--branch', branch, '--token-file', 'c'],
    [...base, '--branch', branch],
    [...base.slice(0, 2), '--branch', 'x', '--token-file', 'c'],
    [...base, '--apply'],
    [...base, '--apply', '--expected-plan', 'abc'],
    [...base, '--expected-plan', 'a'.repeat(64)],
    [...base, '--apply', '--expected-plan', 'a'.repeat(64), '--profile', 'csv'],
    [...base, '--valid-from', '19.11.2026'],
    [...base, '--zero-existing'],
    [...base, '--profile'],
  ])
    assert.throws(() => parseArguments(bad), UsageError, bad.join(' '));
});
