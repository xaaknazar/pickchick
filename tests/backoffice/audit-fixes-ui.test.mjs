// Lane bo-ui audit fixes (design-bo-ui §6, audit F01-F20): the gate, the pure helpers and the
// model behaviour, without PostgreSQL. Every fix is checked twice: with the server's flags off the
// result is exactly the cloud lane's, with them on it is the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { URLSearchParams } from 'node:url';
import {
  OperationsModel,
  auditFixes,
  headerRole,
  rightsText,
  stockFixes,
} from '../../apps/backoffice/dist/operations-model.js';
import {
  almatyDateTime,
  dash,
  isoDay,
  isoMonth,
  tenge,
  ui,
  yearOptions,
} from '../../apps/backoffice/dist/ui-fixes.js';
import {
  NO_FILTER,
  auditAction,
  auditRows,
  auditView,
} from '../../apps/backoffice/dist/audit-model.js';
import { FinanceModel, money as financeMoney } from '../../apps/backoffice/dist/finance-model.js';
import { WorkforceModel } from '../../apps/backoffice/dist/workforce-model.js';
import { ApiError } from '../../apps/backoffice/dist/api.js';
import { stopRowState } from '../../apps/backoffice/dist/operations.js';
import { storage } from './helpers.mjs';

const BRANCH = '6f2a8c1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const ACTOR = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const fixed = (fn) => () => {
  ui.fixes = true;
  try {
    return fn();
  } finally {
    ui.fixes = false;
  }
};

test('the gate: auditFixes is capabilities.pos_day; stock fixes also with stock v2', () => {
  assert.equal(auditFixes(null), false);
  assert.equal(auditFixes({ capabilities: {} }), false);
  assert.equal(auditFixes({ capabilities: { pos_day: true } }), true);
  assert.equal(stockFixes({ capabilities: { stock_v2: true } }), true);
  assert.equal(stockFixes({ capabilities: { pos_day: true } }), true);
  assert.equal(stockFixes({ capabilities: { stock_v2: false, sales_report: true } }), false);
});

test('F09 header role: roles name the role, the fixes name the grant, otherwise nothing', () => {
  assert.equal(headerRole({ role: 'analyst', capabilities: {} }), null);
  assert.equal(headerRole({ role: 'manager', capabilities: {} }), null);
  assert.equal(
    headerRole({ role: 'analyst', effective_role: 'shift_manager', capabilities: {} }),
    'Вы: начальник смены',
  );
  assert.equal(
    headerRole({ role: 'analyst', effective_role: 'accountant', capabilities: {} }),
    'Вы: бухгалтер',
  );
  assert.equal(headerRole({ role: 'analyst', capabilities: { pos_day: true } }), 'Вы: просмотр');
  assert.equal(headerRole({ role: 'manager', capabilities: { pos_day: true } }), 'Вы: управляющий');
});

test('F03, F09 rights in words: the role matrix with roles, the grant with the fixes, else silent', () => {
  assert.equal(rightsText({ capabilities: {} }, 'finance.write'), null);
  assert.equal(
    rightsText({ permissions: ['reports.read'], capabilities: {} }, 'finance.write'),
    'Вносить и исправлять операции могут управляющий и бухгалтер точки.',
  );
  assert.equal(
    rightsText({ permissions: ['reports.read'], capabilities: {} }, 'stock.waste'),
    'Списание проводят управляющий и начальник смены.',
  );
  assert.match(
    rightsText({ capabilities: { pos_day: true } }, 'workforce.write'),
    /только для просмотра.*управляющий точки/,
  );
});

test('F19 helpers are the identity while the fixes are off', () => {
  ui.fixes = false;
  assert.equal(dash('Касса — обновите'), 'Касса — обновите');
  assert.equal(isoDay('2026-11-05'), '2026-11-05');
  assert.equal(isoMonth('2026-11'), '2026-11');
  assert.equal(financeMoney('123456'), `${(1234).toLocaleString('ru-RU')},56 ₸`);
  assert.equal(financeMoney('1167000'), `${(11670).toLocaleString('ru-RU')},00 ₸`);
  assert.equal(
    stopRowState({ last_result: { state: 'conflict' } }).text,
    'Касса изменила позицию — обновите',
  );
});

test(
  'F19 with the fixes: hyphens, DD.MM.YYYY, one money format, sensible years',
  fixed(() => {
    assert.equal(dash('Касса — обновите'), 'Касса - обновите');
    assert.equal(dash('10–20'), '10-20');
    assert.equal(isoDay('2026-11-05'), '05.11.2026');
    assert.equal(isoDay('-'), '-');
    assert.equal(isoMonth('2026-11'), '11.2026');
    assert.equal(tenge('1167000'), '11 670 ₸');
    assert.equal(tenge('9121000'), '91 210 ₸');
    assert.equal(tenge('-123456'), '-1 234,56 ₸');
    assert.equal(financeMoney('9121000'), '91 210 ₸');
    assert.equal(almatyDateTime('2026-11-05T17:34:00Z'), '05.11.2026 22:34');
    assert.equal(almatyDateTime('2026-11-05T19:05:00Z'), '06.11.2026 00:05');
    const years = yearOptions('2026', new Date('2026-11-06T10:00:00Z'));
    assert.deepEqual(years, ['2025', '2026', '2027']);
    assert.deepEqual(yearOptions('2031', new Date('2026-11-06T10:00:00Z')), [
      '2025',
      '2026',
      '2027',
      '2031',
    ]);
    assert.equal(
      stopRowState({ last_result: { state: 'not_found' } }).text,
      'Позиции нет в меню кассы - опубликуйте меню',
    );
  }),
);

test('F08 every action code of the back office has a section and a Russian name', () => {
  const codes = [
    'seeded',
    'saved',
    'published',
    'save:ingredient',
    'save:recipe',
    'save:promo',
    'save:game',
    'save:campaign',
    'save:ticket',
    'save:review',
    'save:station',
    'save:employee',
    'save:shift',
    'publish:promo',
    'publish:game',
    'publish:station',
    'stock:receipt',
    'stock:waste',
    'stock:count',
    'produce',
    'consume',
    // Lane bo-ui stock P1 (stock-p1.ts).
    'stock_reverse',
    'cancel_order',
    'refund',
    'manual_refund',
    'withdraw_refund',
    'revoke_device',
    'kiosk_payment_incident',
    'deliver_station_plan',
    'remote_stop:stop',
    'remote_stop:unstop',
    'cloud_stop:stop',
    'cloud_stop:unstop',
    'cloud_stop:override_cashier',
    'cloud_kitchen:screen_create',
    'cloud_kitchen:pairing_code',
    'cloud_kitchen:screen_revoke',
    'cloud_kitchen:mode',
    'finance.entry',
    'finance.replace',
    'finance.void',
    'finance.account',
    'finance.period',
    'reconciliation.profile',
    'reconciliation.import',
    'reconciliation.void_import',
    'reconciliation.total',
    'reconciliation.void_total',
    'reconciliation.item',
    'reconciliation.accept',
    'reconciliation.close',
    'reconciliation.reopen',
    'workforce.save',
    'workforce.delete',
    'workforce.import',
    'workforce.generate_payroll',
    'workforce.period',
  ];
  for (const code of codes) {
    const a = auditAction(code);
    assert.notEqual(a.section, 'Другое', code);
    // No code shows through (snake_case or dotted names); brand names like Kaspi are fine.
    assert.doesNotMatch(a.text, /[a-z]+[_.:][a-z]/, `${code}: ${a.text}`);
    assert.doesNotMatch(a.text, /Другая операция/, code);
  }
  assert.deepEqual(auditAction('finance.entry'), { section: 'Финансы', text: 'Новая операция' });
  assert.deepEqual(auditAction('save:ticket'), {
    section: 'Обращения и отзывы',
    text: 'Изменение: обращение',
  });
  // A code from a newer server keeps the code, so nothing is hidden.
  assert.deepEqual(auditAction('finance.export'), {
    section: 'Финансы',
    text: 'Другая операция (finance.export)',
  });
});

test('F08 rows carry names, newest first, and the filters narrow them', () => {
  const rows = auditRows(
    [
      {
        id: 'b',
        actor_id: ACTOR,
        actor_name: 'Синтетический управляющий',
        action: 'stock:waste',
        reason: 'Брак',
        created_at: '2026-11-05T18:00:00.000Z',
      },
      {
        id: 'a',
        actor_id: ACTOR,
        actor_name: null,
        action: 'finance.entry',
        reason: 'Аренда',
        created_at: '2026-11-04T05:00:00.000Z',
      },
    ],
    [
      {
        id: 'c',
        actor_id: ACTOR,
        actor_name: 'Синтетический бухгалтер',
        action: 'published',
        created_at: '2026-11-05T20:00:00.000Z',
      },
    ],
  );
  assert.deepEqual(
    rows.map((r) => [r.id, r.author, r.section, r.action, r.day, r.reason]),
    [
      ['c', 'Синтетический бухгалтер', 'Меню', 'Меню опубликовано', '2026-11-06', '-'],
      ['b', 'Синтетический управляющий', 'Склад', 'Списание', '2026-11-05', 'Брак'],
      ['a', 'Автор не найден', 'Финансы', 'Новая операция', '2026-11-04', 'Аренда'],
    ],
  );
  assert.equal(auditView(rows, NO_FILTER).length, 3);
  assert.deepEqual(
    auditView(rows, { ...NO_FILTER, section: 'Склад' }).map((r) => r.id),
    ['b'],
  );
  assert.deepEqual(
    auditView(rows, { ...NO_FILTER, author: 'Синтетический бухгалтер' }).map((r) => r.id),
    ['c'],
  );
  assert.deepEqual(
    auditView(rows, { ...NO_FILTER, from: '2026-11-05', to: '2026-11-05' }).map((r) => r.id),
    ['b'],
  );
});

/** A minimal GET branches/:id snapshot for the model (shape checked by snapshot()). */
function snapshot(period, capabilities, asOf = '2026-11-05T10:00:00.000Z') {
  const arrays = Object.fromEntries(
    [
      'records',
      'stock',
      'orders',
      'pos',
      'chart',
      'finance',
      'refunds',
      'issues',
      'devices',
      'kitchen',
      'guests',
      'audit',
      'catalog_audit',
      'documents',
      'publications',
    ].map((k) => [k, []]),
  );
  return {
    schema_version: 1,
    branch_id: BRANCH,
    role: 'manager',
    as_of: asOf,
    period,
    period_start: '2026-11-04T19:00:00.000Z',
    ...arrays,
    metrics: {},
    capabilities,
  };
}
function fakeApi(capabilities) {
  const calls = [];
  let fail = false;
  let release = null;
  const api = async (path) => {
    calls.push(path);
    if (release) await new Promise((resolve) => (release = resolve));
    if (fail) throw new ApiError('NETWORK');
    const period = new URLSearchParams(path.split('?')[1]).get('period');
    return snapshot(period, capabilities);
  };
  return {
    api,
    calls,
    failNext: (v = true) => (fail = v),
    hold: () => (release = true),
    go: () => {
      const r = release;
      release = null;
      if (typeof r === 'function') r();
    },
  };
}

test('F05 without the fixes: another period empties the data, a lost connection as before', async () => {
  const f = fakeApi({});
  const m = new OperationsModel(f.api, storage(), () => {});
  await m.load(ACTOR, BRANCH);
  assert.equal(m.data.period, 'day');
  assert.equal(m.fixes, false);
  f.hold();
  const week = m.load(ACTOR, BRANCH, 'week');
  assert.equal(m.data, null, 'the old cabinet clears the data while the new period loads');
  f.failNext();
  f.go();
  await week;
  assert.equal(m.data, null);
  assert.equal(m.period, 'week');
  assert.equal(m.error.message, 'NETWORK');
});

test('F05 with the fixes: data stays while loading, a failed period returns to the shown one', async () => {
  const f = fakeApi({ pos_day: true });
  const store = storage();
  const m = new OperationsModel(f.api, store, () => {});
  await m.load(ACTOR, BRANCH);
  assert.equal(m.fixes, true);
  assert.equal(store.getItem(`pickchick.backoffice.audit-fixes.v1:${ACTOR}:${BRANCH}`), '1');
  f.hold();
  const week = m.load(ACTOR, BRANCH, 'week');
  assert.equal(m.data.period, 'day', 'the shown data stays while «Неделя» loads');
  assert.equal(m.busy, true);
  f.failNext();
  f.go();
  await week;
  assert.equal(m.data.period, 'day');
  assert.equal(m.period, 'day', 'the period switch returns to the data on screen');
  assert.equal(m.error.message, 'NETWORK');
  f.failNext(false);
  await m.load(ACTOR, BRANCH, 'week');
  assert.equal(m.data.period, 'week');
  // A reload of the tab knows the fixes before the first snapshot arrives.
  const again = new OperationsModel(f.api, store, () => {});
  f.hold();
  const first = again.load(ACTOR, BRANCH);
  assert.equal(again.data, null);
  assert.equal(again.fixes, true);
  f.go();
  await first;
});

test('F05 the flag-off server leaves no audit-fixes key in the tab storage', async () => {
  const f = fakeApi({});
  const store = storage();
  await new OperationsModel(f.api, store, () => {}).load(ACTOR, BRANCH);
  assert.deepEqual([...store.map.keys()], []);
});

test('F05 finance and workforce: a failed read says «Нет связи» only with the fixes', async () => {
  const offline = async () => {
    throw new ApiError('NETWORK');
  };
  const finance = new FinanceModel(offline, storage(), () => {});
  await finance.scope(ACTOR, BRANCH);
  assert.equal(finance.error, 'Ответ сервера не подтверждён. Повторите проверку результата.');
  const fixedFinance = new FinanceModel(offline, storage(), () => {});
  fixedFinance.fixes = () => true;
  await fixedFinance.scope(ACTOR, BRANCH);
  assert.equal(
    fixedFinance.error,
    'Нет связи с сервером. Проверьте интернет и нажмите «Показать» ещё раз.',
  );
  const forbidden = async () => {
    throw new ApiError('FORBIDDEN', 403);
  };
  const work = new WorkforceModel(forbidden, storage(), () => {});
  work.fixes = () => true;
  await work.scope(ACTOR, BRANCH);
  assert.equal(work.error, 'Нет доступа к графику и табелю этой точки.');
  const oldWork = new WorkforceModel(forbidden, storage(), () => {});
  await oldWork.scope(ACTOR, BRANCH);
  assert.equal(oldWork.error, 'Для записи нужны права управляющего этой точки.');
});

test('the lane files of this step have no long dashes in interface texts', async () => {
  const src = new URL('../../apps/backoffice/src/', import.meta.url);
  for (const name of ['ui-fixes.ts', 'dialog-guard.ts', 'audit-model.ts', 'audit-fixes.css']) {
    const text = await readFile(new URL(name, src), 'utf8');
    // ui-fixes.ts names the characters it replaces inside a regular expression only.
    const lines = text.split('\n').filter((line) => !line.includes('replace(/ ?[—–] ?/g'));
    assert.ok(!lines.some((line) => /[—–]/.test(line)), name);
  }
  // Every long dash left in the sources is wrapped by dash() (shown as a hyphen with the fixes).
  const files = (await readdir(src)).filter((n) => n.endsWith('.ts'));
  for (const name of files) {
    if (name === 'ui-fixes.ts') continue;
    const lines = (await readFile(new URL(name, src), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (!/[—–]/.test(line) || line.trim().startsWith('//') || line.trim().startsWith('*')) return;
      const context = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
      assert.match(context, /dash\(/, `${name}:${i + 1} has a long dash outside dash()`);
    });
  }
});
