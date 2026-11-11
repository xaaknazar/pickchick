// Lane bo-ui2 step 3 «Импорт цен из iiko» in the cabinet (design-bo-ui §9.4): the allowlists of
// ops/supplier-imports in the cabinet, the operator proxy and the gateway, the parser of the view
// and the words of the report (every code and count of the server has its Russian label). Pure
// functions of the built cabinet and the core, no PostgreSQL. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { allowedPath } from '../../apps/backoffice/dist/api.js';
import { allowed } from '../../apps/backoffice/server.mjs';
import {
  IMPORT_COUNT_LABELS,
  IMPORT_ISSUE_LABELS,
  importCountRows,
  importStateText,
  importTitle,
  supplierImportsView,
} from '../../apps/backoffice/dist/supply-model.js';
import {
  IMPORT_COUNT_KEYS,
  IMPORT_ISSUE_CODES,
} from '../../packages/backoffice-core/dist/index.js';
import { CATEGORY_TITLES, ISSUE_CATEGORIES } from '../../scripts/supplier-prices-import.mjs';

const LONG_DASH = /[–—]/;
const branch = randomUUID();
const counts = (extra = {}) => ({
  ...Object.fromEntries(IMPORT_COUNT_KEYS.map((k) => [k, 0])),
  rows: 12,
  matched: 9,
  new_prices: 8,
  unchanged: 1,
  new_suppliers: 1,
  ...extra,
});
const row = (extra = {}) => ({
  id: randomUUID(),
  source: 'iiko_export',
  file_name: 'prices.csv',
  profile: 'iiko',
  file_sha256: 'a'.repeat(64),
  plan_sha256: 'b'.repeat(64),
  row_count: 12,
  actor_name: 'Синтетический управляющий',
  applied_at: '2026-11-07T09:05:00.000Z',
  parts: 2,
  parts_applied: [1, 2],
  complete: true,
  suppliers_created: 1,
  prices_created: 8,
  unchanged: 0,
  counts: counts({ not_found: 2, duplicates: 1 }),
  ...extra,
});
const view = (one) => ({
  schema_version: 1,
  branch_id: branch,
  view: 'supplier-imports',
  timezone: 'Asia/Almaty',
  as_of: '2026-11-07T10:00:00.000Z',
  imports: one ? [row({ id: one.id })] : [],
  limits: { imports: 20 },
  truncated: { imports: false },
  import: one,
});
const detail = (extra = {}) => ({
  ...row(),
  summary: {
    schema: 'pickchick.supplier-prices-report/v1',
    file_name: 'prices.csv',
    profile: 'iiko',
    parts: 2,
    counts: counts({ not_found: 2, duplicates: 1 }),
    issues: [
      {
        line: 4,
        code: 'NOT_FOUND',
        supplier: 'Поставщик 1',
        name: 'Синтетическая соль',
        text: 'нет позиции с таким названием',
      },
    ],
    issues_total: 3,
  },
  suppliers: [
    {
      id: randomUUID(),
      name: 'Поставщик 1',
      kind: 'supplier',
      active: true,
      created: true,
      prices: 8,
    },
  ],
  prices_kept: 8,
  prices_corrected: 0,
  ...extra,
});

test('allowlists: ops/supplier-imports with at most one id, in the cabinet, the proxy and the gateway', async () => {
  const id = randomUUID();
  for (const [path, ok] of Object.entries({
    'supplier-imports': true,
    [`supplier-imports?id=${id}`]: true,
    'supplier-imports?id=x': false,
    [`supplier-imports?id=${id}&id=${id}`]: false,
    'supplier-imports?file=x': false,
    'supplier-imports/x': false,
    'supplier-import': false,
  })) {
    assert.equal(allowedPath(`operations/branches/${branch}/ops/${path}`), ok, 'cabinet ' + path);
    assert.equal(
      allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/${path}`),
      ok,
      'proxy ' + path,
    );
  }
  assert.equal(
    allowed('POST', `/v1/admin/backoffice/branches/${branch}/ops/supplier-imports`),
    false,
  );
  const caddy = await readFile(
    new URL('../../infra/public-staging/gateway.Caddyfile', import.meta.url),
    'utf8',
  );
  const regex = new RegExp(/path_regexp backoffice_get (\S+)/.exec(caddy)[1]);
  assert.equal(regex.test(`/v1/admin/backoffice/branches/${branch}/ops/supplier-imports`), true);
  assert.equal(regex.test(`/v1/admin/backoffice/branches/${branch}/ops/supplier-imports/x`), false);
  // The script's batch ids (uuid version 5) pass the cabinet's id pattern.
  assert.equal(
    allowedPath(
      `operations/branches/${branch}/ops/supplier-imports?id=0b1c2d3e-4f50-5a6b-a7c8-9d0e1f2a3b4c`,
    ),
    true,
  );
});

test('the view: a full import, an empty branch, anything else is an invalid answer', () => {
  const one = detail();
  assert.equal(supplierImportsView(view(one), branch).import.id, one.id);
  assert.equal(supplierImportsView(view(null), branch).import, null);
  // A batch without a report of this schema (summary null) is still shown.
  assert.equal(
    supplierImportsView(view(detail({ summary: null, counts: null })), branch).import.summary,
    null,
  );
  for (const bad of [
    { ...view(one), branch_id: randomUUID() },
    { ...view(one), view: 'suppliers' },
    { ...view(one), schema_version: 2 },
    { ...view(one), imports: [{ ...row(), complete: 'yes' }] },
    { ...view(one), imports: [{ ...row(), counts: { rows: 1 } }] },
    { ...view(one), import: { ...one, suppliers: null } },
    { ...view(one), import: { ...one, summary: { ...one.summary, issues: [{ line: 'x' }] } } },
    { ...view(one), truncated: null },
    null,
  ])
    assert.throws(() => supplierImportsView(bad, branch), /INVALID_RESPONSE/);
});

test('words: every server code and count has its label; state, title and the count rows', () => {
  for (const code of IMPORT_ISSUE_CODES) assert.ok(IMPORT_ISSUE_LABELS[code], code);
  assert.deepEqual(Object.keys(IMPORT_ISSUE_LABELS).sort(), [...IMPORT_ISSUE_CODES].sort());
  assert.deepEqual(
    IMPORT_COUNT_LABELS.map(([k]) => k),
    [...IMPORT_COUNT_KEYS],
  );
  // The cabinet and the script name the categories the same way.
  for (const category of new Set(Object.values(ISSUE_CATEGORIES)))
    assert.equal(
      IMPORT_COUNT_LABELS.find(([k]) => k === category)[1].toLowerCase(),
      category === 'notes' ? 'заметки (строка загружена)' : CATEGORY_TITLES[category],
      category,
    );
  assert.equal(importStateText(row()), 'Загружен полностью');
  assert.equal(
    importStateText(row({ complete: false, parts: 3, parts_applied: [1, 2] })),
    'Загружен не полностью: частей 2 из 3. Повторите загрузку тем же планом.',
  );
  assert.match(
    importStateText(row({ complete: false, parts: null, parts_applied: [1] })),
    /без отчёта/,
  );
  assert.equal(
    importTitle(row(), () => '07.11.2026 14:05'),
    '07.11.2026 14:05, prices.csv',
  );
  assert.deepEqual(importCountRows(counts({ not_found: 2, duplicates: 1 })), [
    ['Строк в файле', '12'],
    ['Сопоставлено строк', '9'],
    ['Новых цен', '8'],
    ['Уже были с той же ценой', '1'],
    ['Новых поставщиков', '1'],
    ['Позиция не найдена', '2'],
    ['Повторы в файле', '1'],
  ]);
  for (const text of [
    ...Object.values(IMPORT_ISSUE_LABELS),
    ...IMPORT_COUNT_LABELS.map(([, label]) => label),
    importStateText(row({ complete: false, parts: 3, parts_applied: [1] })),
  ])
    assert.doesNotMatch(text, LONG_DASH, text);
});
