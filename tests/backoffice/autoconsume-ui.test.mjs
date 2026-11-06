// Lane bo-ui step 5 in the cabinet («Списание по продажам», design-bo-ui 5.3, 5.5): the gates,
// the allowlists of the two views, the commands of the dialogs and the texts of the queue and the
// links table. Pure functions of the built cabinet, no PostgreSQL. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { allowedPath } from '../../apps/backoffice/dist/api.js';
import { allowed } from '../../apps/backoffice/server.mjs';
import {
  RIGHTS_TEXT,
  autoconsumeAvailable,
  commandPermission,
  permitted,
} from '../../apps/backoffice/dist/operations-model.js';
import { auditAction } from '../../apps/backoffice/dist/audit-model.js';
import { documentDetail, stockSalesNotice } from '../../apps/backoffice/dist/inventory-model.js';
import {
  almatyInput,
  approveCommand,
  consumptionView,
  coverageText,
  coverageWarning,
  filterLinks,
  fromAlmatyInput,
  itemDocument,
  itemNeeds,
  itemReason,
  itemTitle,
  linkCommand,
  linkStatus,
  linkTargets,
  linkText,
  menuLinksView,
  modeConsequence,
  modeText,
  outputPolicyText,
  queueActions,
  saleLabel,
  settingsCommand,
  shareText,
  unsetPolicyWarnings,
} from '../../apps/backoffice/dist/autoconsume-model.js';

const branch = randomUUID();
const BUN = '00000000-0000-4000-8000-000000000001';
const PATTY = '00000000-0000-4000-8000-000000000002';
const LONG_DASHES = /[—–]/;

test('allowlists: menu-links takes no query, consumption one optional state and day', () => {
  const cabinet = (path) => allowedPath(`operations/branches/${branch}/ops/${path}`);
  const proxy = (path, method = 'GET') =>
    allowed(method, `/v1/admin/backoffice/branches/${branch}/ops/${path}`);
  for (const ok of [
    'menu-links',
    'consumption',
    'consumption?state=blocked',
    'consumption?date=2026-11-19',
    'consumption?state=applied&date=2026-11-19',
  ]) {
    assert.equal(cabinet(ok), true, ok);
    assert.equal(proxy(ok), true, ok);
  }
  for (const bad of [
    'menu-links?all=1',
    'consumption?state=bogus',
    'consumption?date=19.11.2026',
    'consumption?state=blocked&state=applied',
    'consumption?branch=x',
    'consumption?date=2026-11-19&extra=1',
  ]) {
    assert.equal(cabinet(bad), false, bad);
    assert.equal(proxy(bad), false, bad);
  }
  assert.equal(proxy('consumption', 'POST'), false);
  assert.equal(proxy('menu-links', 'POST'), false);
});

test('gates and rights: the key decides, each command has its permission and words', () => {
  assert.equal(autoconsumeAvailable({ capabilities: { stock_p1: true } }), false);
  assert.equal(autoconsumeAvailable({ capabilities: { stock_autoconsume: false } }), false);
  assert.equal(autoconsumeAvailable({ capabilities: { stock_autoconsume: true } }), true);
  assert.equal(autoconsumeAvailable(null), false);
  assert.deepEqual(
    [
      'menu_link_save',
      'menu_links_approve',
      'stock_settings',
      'consumption_retry',
      'consumption_skip',
    ].map((type) => commandPermission({ type })),
    [
      'menu_links.write',
      'menu_links.approve',
      'stock.settings',
      'consumption.write',
      'consumption.write',
    ],
  );
  // A designated shift manager retries and skips, never edits links or the mode.
  const shift = { role: 'analyst', permissions: ['reports.read', 'consumption.write'] };
  assert.equal(permitted(shift, 'consumption.write'), true);
  assert.equal(permitted(shift, 'stock.settings'), false);
  // Without roles the manager grant decides, as for every other command.
  assert.equal(permitted({ role: 'manager' }, 'menu_links.write'), true);
  assert.equal(permitted({ role: 'analyst' }, 'consumption.write'), false);
  for (const key of [
    'menu_links.write',
    'menu_links.approve',
    'stock.settings',
    'consumption.write',
  ])
    assert.ok(RIGHTS_TEXT[key] && !LONG_DASHES.test(RIGHTS_TEXT[key]), key);
  assert.deepEqual(auditAction('stock_settings'), {
    section: 'Склад',
    text: 'Режим списания по продажам',
  });
  assert.equal(auditAction('consumption_skip').text, 'Пропуск списания по продаже');
});

test('mode: words, Almaty input, the command and what it does', () => {
  assert.equal(modeText({ autoconsume_mode: 'off', start_at: null }), 'Выключено');
  assert.equal(
    modeText({ autoconsume_mode: 'on', start_at: '2026-11-18T19:00:00.000Z' }),
    'Включено с 19.11.2026 00:00',
  );
  assert.equal(
    modeText({ autoconsume_mode: 'dry_run', start_at: '2026-11-13T07:30:00.000Z' }),
    'Проверка без списания с 13.11.2026 12:30',
  );
  assert.equal(almatyInput('2026-11-18T19:00:00.000Z'), '2026-11-19T00:00');
  assert.equal(fromAlmatyInput('2026-11-19T00:00'), '2026-11-18T19:00:00.000Z');
  assert.equal(fromAlmatyInput('19.11.2026'), null);
  assert.deepEqual(settingsCommand({ revision: 3 }, 'on', '2026-11-19T00:00'), {
    type: 'stock_settings',
    autoconsume_mode: 'on',
    start_at: '2026-11-18T19:00:00.000Z',
    expected_revision: 3,
  });
  assert.deepEqual(settingsCommand({ revision: 0 }, 'off', ''), {
    type: 'stock_settings',
    autoconsume_mode: 'off',
    start_at: null,
    expected_revision: 0,
  });
  assert.throws(() => settingsCommand({ revision: 0 }, 'dry_run', ''), /Укажите, с какого момента/);
  assert.match(
    modeConsequence('on', '2026-11-19T00:00'),
    /^Продажи с 19\.11\.2026 00:00 будут списываться/,
  );
  assert.match(modeConsequence('dry_run', '2026-11-19T00:00'), /без списания/);
  assert.match(modeConsequence('off', ''), /Уже проведённые документы останутся/);
  // The stock page notice follows the mode.
  assert.match(stockSalesNotice('dry_run', true), /режиме проверки/);
  assert.match(
    stockSalesNotice('on', true, '2026-11-18T19:00:00.000Z'),
    /автоматически с 19\.11\.2026 00:00/,
  );
});

test('coverage: share in words, the 95 % warning with the most frequent missing items', () => {
  assert.equal(shareText(9650), '96,5 %');
  assert.equal(shareText(10000), '100,0 %');
  assert.equal(shareText(null), '-');
  const low = {
    days: 7,
    sold_lines: 200,
    linked_lines: 180,
    share_bp: 9000,
    missing: [{ catalog_key: 'burger-hot', name: 'Синтетический острый бургер', lines: 15 }],
    truncated: false,
  };
  assert.equal(
    coverageText(low),
    'Покрытие за 7 дней: 90,0 % строк продаж со связью (180 из 200).',
  );
  assert.equal(
    coverageWarning(low),
    'Покрытие ниже 95 %: включать списание рано. Без связи чаще всего: Синтетический острый бургер (15).',
  );
  assert.equal(coverageWarning({ ...low, share_bp: 9500 }), null);
  assert.match(coverageText({ ...low, sold_lines: 0, share_bp: null }), /продаж нет/);
});

test('queue: sale, reason with names and shortages, needs, document, actions', () => {
  const blocked = {
    source: 'pos',
    order_id: randomUUID(),
    display_number: '12',
    state: 'blocked',
    reason: 'NO_LINK',
    revision: 2,
    detail: {
      problems: [
        { code: 'NO_LINK', catalog_key: 'burger-hot', name: 'Бургер Острый', ingredient_id: null },
      ],
      shortages: [{ ingredient_id: BUN, name: 'Булка', unit: 'pcs', need: '2', have: '0' }],
    },
  };
  assert.equal(saleLabel(blocked), 'Касса №12');
  assert.equal(
    itemReason(blocked),
    'нет связи: Бургер Острый · не хватает: Булка (нужно 2 шт, есть 0 шт)',
  );
  assert.deepEqual(queueActions(blocked, 'on'), { retry: true, skip: true });
  assert.deepEqual(queueActions(blocked, 'off'), { retry: false, skip: true });
  const applied = {
    source: 'cloud',
    order_id: 'abcdef12-0000-4000-8000-000000000000',
    display_number: null,
    state: 'applied',
    reason: null,
    reversed: true,
    refunded: true,
    detail: {
      needs: [
        { ingredient_id: BUN, name: 'Булка', unit: 'pcs', quantity: '1', absorbed_by_count: true },
        {
          ingredient_id: PATTY,
          name: 'Мясо',
          unit: 'g',
          quantity: '240',
          absorbed_by_count: false,
        },
      ],
    },
  };
  assert.equal(saleLabel(applied), 'Заказ abcdef12');
  assert.equal(itemNeeds(applied), 'Булка 1 шт (учтено подсчётом), Мясо 0,24 кг');
  assert.match(
    itemDocument(applied),
    /^Списано, затем сторно\. Возврат после начала приготовления/,
  );
  assert.deepEqual(queueActions(applied, 'on'), { retry: false, skip: false });
  assert.equal(
    itemReason({ state: 'not_required', reason: 'CANCELLED_BEFORE_KITCHEN', detail: {} }),
    'отменён до начала приготовления',
  );
  // Review BOUI-R1: the recipe without a chosen policy is named in the queue.
  assert.equal(
    itemReason({
      state: 'blocked',
      reason: 'RECIPE_POLICY_UNSET',
      detail: {
        problems: [
          {
            code: 'RECIPE_POLICY_UNSET',
            catalog_key: null,
            name: 'Котлета маринованная',
            ingredient_id: PATTY,
          },
        ],
      },
    }),
    'в техкарте «Котлета маринованная» не выбран «Выход техкарты при продаже»',
  );
  assert.equal(
    itemReason({ state: 'skipped', reason: 'Отдали как замену', detail: {} }),
    'Причина: Отдали как замену',
  );
  for (const text of [itemReason(blocked), itemDocument(applied)])
    assert.doesNotMatch(text, LONG_DASHES);
  const view = consumptionView(
    {
      schema_version: 1,
      branch_id: branch,
      settings: { autoconsume_mode: 'dry_run', start_at: '2026-11-13T07:30:00.000Z', revision: 2 },
      items: [blocked],
      counts: { blocked: 1 },
      coverage: { days: 7, sold_lines: 1, linked_lines: 0, share_bp: 0, missing: [] },
      truncated: { items: false },
    },
    branch,
  );
  assert.equal(view.counts.applied, 0);
  assert.equal(view.settings.revision, 2);
  assert.throws(() =>
    consumptionView({ schema_version: 1, branch_id: randomUUID(), items: [] }, branch),
  );
});

test('links: titles, statuses, filters, editor and approval commands', () => {
  const items = [
    {
      catalog_key: 'burger',
      catalog_ref: { product_id: 'burger' },
      kind: 'product',
      name_ru: 'Бургер',
      listed: true,
      link: {
        effect: 'consume',
        status: 'approved',
        revision: 2,
        lines: [
          { ingredient_id: BUN, quantity: '1', name: 'Булка', unit: 'pcs' },
          { recipe_output_id: PATTY, quantity: '1', name: 'Котлета', unit: 'pcs' },
        ],
      },
    },
    {
      catalog_key: 'burger:extra:onion',
      catalog_ref: { product_id: 'burger', group_id: 'extra', option_id: 'onion' },
      kind: 'option',
      name_ru: 'Без лука',
      product_name_ru: 'Бургер',
      group_name_ru: 'Добавки',
      listed: true,
      link: { effect: 'none', status: 'draft', revision: 1, lines: [] },
    },
    {
      catalog_key: 'combo',
      catalog_ref: { product_id: 'combo' },
      kind: 'combo',
      name_ru: 'Комбо',
      listed: true,
      from_combo: true,
      covered_without_link: true,
      link: null,
    },
    {
      catalog_key: 'combo:drink:cola',
      catalog_ref: { product_id: 'combo', group_id: 'drink', option_id: 'cola' },
      kind: 'option',
      name_ru: 'Кола',
      product_name_ru: 'Комбо',
      group_name_ru: 'Напиток',
      listed: true,
      linked_product_id: 'cola',
      covered_without_link: true,
      link: null,
    },
    {
      catalog_key: 'fries',
      catalog_ref: { product_id: 'fries' },
      kind: 'product',
      name_ru: 'Фри',
      listed: true,
      link: null,
    },
  ];
  const products = new Map([['cola', 'Кола 0,5']]);
  assert.deepEqual(
    items.map((i) => linkStatus(i, products)),
    ['Утверждено', 'Черновик', 'Из состава комбо', 'Из товара: Кола 0,5', 'Нет связи'],
  );
  assert.equal(itemTitle(items[1]), 'Бургер · Добавки: Без лука');
  assert.equal(linkText(items[0].link), 'Булка 1 шт, Котлета (по ТТК) 1 шт');
  assert.equal(linkText(items[1].link), 'Без списания');
  assert.deepEqual(
    filterLinks(items, 'missing').map((i) => i.catalog_key),
    ['fries'],
  );
  assert.deepEqual(
    filterLinks(items, 'draft').map((i) => i.catalog_key),
    ['burger:extra:onion'],
  );
  assert.deepEqual(linkCommand(items[4], 'consume', [{ target: 'i:' + BUN, quantity: ' 150 ' }]), {
    type: 'menu_link_save',
    catalog_ref: { product_id: 'fries' },
    effect: 'consume',
    lines: [{ ingredient_id: BUN, quantity: '150' }],
    expected_revision: 0,
  });
  assert.deepEqual(
    linkCommand(items[0], 'consume', [
      { target: 'i:' + BUN, quantity: '1' },
      { target: 'r:' + PATTY, quantity: '2' },
    ]).lines,
    [
      { ingredient_id: BUN, quantity: '1' },
      { recipe_output_id: PATTY, quantity: '2' },
    ],
  );
  assert.equal(linkCommand(items[0], 'none', []).expected_revision, 2);
  assert.throws(() => linkCommand(items[4], 'consume', []), /хотя бы одну строку/);
  assert.throws(
    () => linkCommand(items[4], 'consume', [{ target: '', quantity: '1' }]),
    /Выберите позицию/,
  );
  assert.throws(
    () => linkCommand(items[4], 'consume', [{ target: 'i:' + BUN, quantity: '1,5' }]),
    /целое число/,
  );
  assert.throws(
    () =>
      linkCommand(items[4], 'consume', [
        { target: 'i:' + BUN, quantity: '1' },
        { target: 'r:' + BUN, quantity: '2' },
      ]),
    /повторяется/,
  );
  assert.throws(
    () => linkCommand(items[4], 'none', [{ target: 'i:' + BUN, quantity: '1' }]),
    /уберите строки/,
  );
  assert.deepEqual(approveCommand(items), {
    type: 'menu_links_approve',
    keys: ['burger:extra:onion'],
    expected_revisions: { 'burger:extra:onion': 1 },
  });
  assert.throws(() => approveCommand([items[0]]), /Нет черновиков/);
  const targets = linkTargets([
    { kind: 'ingredient', id: BUN, payload: { name: 'Булка', unit: 'pcs' } },
    { kind: 'ingredient', id: PATTY, payload: { name: 'Котлета', unit: 'pcs' } },
    { kind: 'recipe', id: randomUUID(), payload: { output_ingredient_id: PATTY } },
    { kind: 'recipe', id: randomUUID(), payload: { output_ingredient_id: null } },
  ]);
  assert.deepEqual(
    targets.ingredients.map((i) => i.name),
    ['Булка', 'Котлета'],
  );
  assert.deepEqual(
    targets.outputs.map((i) => i.id),
    [PATTY],
  );
  // Review BOUI-R1: each TTK output carries its recipe's policy; none chosen is said in words.
  assert.deepEqual(
    targets.outputs.map((i) => [i.policy, outputPolicyText(i.policy)]),
    [[null, 'способ не выбран']],
  );
  assert.equal(outputPolicyText('explode'), 'на сырьё');
  assert.equal(outputPolicyText('stock'), 'сам выход');
  const named = linkTargets([
    { kind: 'ingredient', id: PATTY, payload: { name: 'Котлета', unit: 'pcs' } },
    {
      kind: 'recipe',
      id: randomUUID(),
      payload: { name: 'Котлета маринованная', output_ingredient_id: PATTY },
    },
  ]);
  const [warning] = unsetPolicyWarnings(named.outputs, [
    { target: 'r:' + PATTY, quantity: '1' },
    { target: 'i:' + PATTY, quantity: '1' },
  ]);
  assert.match(warning, /В техкарте «Котлета маринованная» не выбран «Выход техкарты при продаже»/);
  assert.match(warning, /не спишутся/);
  assert.doesNotMatch(warning, LONG_DASHES);
  const chosen = linkTargets([
    { kind: 'ingredient', id: PATTY, payload: { name: 'Котлета', unit: 'pcs' } },
    {
      kind: 'recipe',
      id: randomUUID(),
      payload: { name: 'Котлета', output_ingredient_id: PATTY, stock_policy: 'stock' },
    },
  ]);
  assert.equal(chosen.outputs[0].policy, 'stock');
  assert.deepEqual(
    unsetPolicyWarnings(chosen.outputs, [{ target: 'r:' + PATTY, quantity: '1' }]),
    [],
  );
  const view = menuLinksView(
    { schema_version: 1, branch_id: branch, catalog: null, items: [], orphans: [], coverage: {} },
    branch,
  );
  assert.equal(view.catalog, null);
  assert.equal(view.coverage.without_link, 0);
  // An automatic consumption document names its sale in «Документы».
  assert.equal(
    documentDetail({ kind: 'consumption', source_ref: 'pos:' + BUN }),
    'Автоматически по продаже кассы',
  );
  assert.equal(documentDetail({ kind: 'consumption', source_ref: null }), '-');
});
