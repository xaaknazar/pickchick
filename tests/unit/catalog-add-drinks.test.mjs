/* global structuredClone */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deriveRouting, projectCatalogMenu } from '@pickchick/menu-sync';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { withPikoFlavors } from '../../packages/catalog-admin/dist/piko-flavors.js';
import {
  CatalogPayloadSchema,
  stripStorefrontPayload,
} from '../../packages/catalog-admin/dist/contracts.js';
import {
  BarDrinksSpecSchema,
  catalogDigest,
  describeCatalogDiff,
  formatMinor,
  withBarDrinks,
} from '../../packages/catalog-admin/dist/bar-drinks.js';
import {
  DEFAULT_DATA,
  credentials,
  parse,
  planChange,
  run,
} from '../../infra/staging/catalog-add-drinks.mjs';

const ROOT = new URL('../../', import.meta.url);
const spec = JSON.parse(await readFile(DEFAULT_DATA, 'utf8'));
const IDS = [
  'cola-bottle',
  'cola-zero',
  'sprite',
  'fanta',
  'fuse-berry',
  'fuse-mango',
  'fuse-watermelon',
  'cola-zero-can',
  'sprite-can',
  'fanta-can',
  'fuse-strawberry-melon',
  'fuse-lemon',
  'fuse-mango-pineapple',
];
const NEW_CHOICES = IDS.slice(7);
const COMBOS = [
  'pick-combo',
  'master-combo',
  'burger-combo',
  'solo-combo',
  'finger-duo',
  'burger-duo',
  'mix-duo',
];
/** Same shape as the live publication: operator content, reviewed. */
const live = () => ({
  ...structuredClone(mockupCatalogDraft),
  content_source: 'operator',
  content_reviewed: true,
});
const drinkGroup = (payload, id) =>
  payload.products.find((p) => p.id === id).modifier_groups.find((g) => g.id === 'drink');

test('reviewed data matches the iiko bar menu, combo surcharges and the agreed ids', async () => {
  const doc = await readFile(
    new URL('docs/operations/iiko-menu-details-2026-09-28.md', ROOT),
    'utf8',
  );
  const section = (title) =>
    doc.slice(doc.indexOf(title), doc.indexOf('\n#', doc.indexOf(title) + 1));
  const rows = (text) =>
    new Map(
      [...text.matchAll(/^\| (\d{5}) +\| ([^|]+?) +\| +(\d+) \|/gm)].map((m) => [
        m[1],
        { name: m[2], tenge: m[3] },
      ]),
    );
  const bar = rows(section('### Меню бар'));
  const combo = rows(section('### Напитки к комбо 0,5 зал'));
  assert.equal(bar.size, 19);
  const parsed = BarDrinksSpecSchema.parse(spec);
  assert.equal(
    parsed.approved_by_owner,
    false,
    'owner approval is given only in a reviewed commit',
  );
  assert.equal(parsed.category_name_ru, 'Напитки');
  assert.deepEqual(
    parsed.drinks.map((d) => d.id),
    IDS,
  );
  for (const drink of parsed.drinks) {
    const row = bar.get(drink.iiko_sku);
    assert.ok(row, drink.id);
    assert.equal(row.name, drink.iiko_name, drink.id);
    assert.equal(drink.price_minor, String(Number(row.tenge) * 100), drink.id);
    assert.equal(drink.volume_ml, 500);
    assert.equal(drink.image_asset_key, 'generic-drink');
    assert.equal(drink.kitchen_route, 'assembly_item');
    assert.equal(drink.available, drink.id !== 'fuse-watermelon', drink.id);
    const choice = combo.get(drink.combo_option.iiko_sku);
    assert.ok(choice, drink.id);
    assert.equal(
      drink.combo_option.price_delta_minor,
      String(Number(choice.tenge) * 100),
      drink.id,
    );
    assert.equal(drink.combo_option.available, drink.available, drink.id);
  }
  // The six standalone drinks already sold stay out of the data.
  for (const id of ['lemonade', 'cola', 'fuse-peach', 'iced-tea', 'water', 'piko'])
    assert.ok(!IDS.includes(id));
});

test('missing drinks are added after the last drink; everything else and the input stay intact', () => {
  const input = live();
  const original = structuredClone(input);
  const { payload, changes, warnings } = withBarDrinks(input, spec, { comboOptions: false });
  assert.deepEqual(input, original);
  assert.deepEqual(warnings, []);
  assert.equal(payload.products.length, 37);
  assert.deepEqual(
    payload.products.slice(0, 24).map((p) => p.id),
    original.products.map((p) => p.id),
  );
  assert.deepEqual(
    payload.products.slice(24).map((p) => p.id),
    IDS,
  );
  for (const before of original.products)
    assert.deepEqual(
      payload.products.find((p) => p.id === before.id),
      before,
    );
  assert.deepEqual(
    changes.map((c) => [c.kind, c.product_id]),
    IDS.map((id) => ['product_added', id]),
  );
  const can = payload.products.find((p) => p.id === 'sprite-can');
  assert.deepEqual(can, {
    id: 'sprite-can',
    sku: 'sprite-can',
    name: { ru: 'Sprite 0.5 л, банка', kk: '' },
    description: { ru: 'Sprite в железной банке, 0,5 л.', kk: '' },
    category_id: 'category-5',
    price_minor: '79000',
    image_asset_key: 'generic-drink',
    kitchen_route: 'assembly_item',
    available: true,
    prep_required: false,
    prep_minutes: 1,
    serving_label: { ru: '500 мл', kk: '' },
    weight_g: null,
    volume_ml: 500,
    ingredients: { ru: 'Sprite в железной банке, 0,5 л.', kk: '' },
    allergens: [],
    allergens_status: 'unknown',
    nutrition: { basis: 'per_serving', energy_kcal: 210, protein_g: 0, fat_g: 0, carbs_g: 53 },
    nutrition_status: 'unverified',
    kind: 'item',
    combo_components: [],
    modifier_groups: [],
  });
  assert.equal(payload.products.find((p) => p.id === 'fuse-watermelon').available, false);
  assert.equal(payload.products.find((p) => p.id === 'cola-zero-can').price_minor, '79000');
  assert.equal(payload.content_reviewed, true, 'review flag is the operator script decision');
});

test('combo choices fill every drink group exactly to the 20-option limit', () => {
  const input = live();
  const { payload, changes } = withBarDrinks(input, spec, { comboOptions: true });
  assert.equal(changes.filter((c) => c.kind === 'combo_option_added').length, 6 * 7);
  for (const id of COMBOS) {
    const before = drinkGroup(input, id),
      after = drinkGroup(payload, id);
    assert.equal(after.options.length, 20, id);
    assert.deepEqual(after.options.slice(0, 14), before.options, id);
    assert.deepEqual(
      after.options.slice(14).map((o) => o.id),
      NEW_CHOICES,
    );
    for (const option of after.options.slice(14)) {
      assert.equal(option.default_quantity, 0);
      assert.equal(option.max_quantity, after.max);
      assert.equal(option.linked_product_id, null);
      assert.equal(option.available, true);
      assert.equal(option.price_delta_minor, option.id.endsWith('-can') ? '10000' : '0');
      assert.equal(option.label.kk, '');
    }
  }
  const sauce = (p) =>
    p.products.find((x) => x.id === 'pick-combo').modifier_groups.find((g) => g.id === 'sauce');
  assert.deepEqual(sauce(payload), sauce(input));
  assert.equal(
    drinkGroup(withBarDrinks(input, spec, { comboOptions: false }).payload, 'pick-combo').options
      .length,
    14,
  );
});

test('idempotent; an existing drink only gets the reviewed availability, never a new price', () => {
  const once = withBarDrinks(live(), spec, { comboOptions: true });
  const twice = withBarDrinks(once.payload, spec, { comboOptions: true });
  assert.deepEqual(twice.changes, []);
  assert.deepEqual(twice.warnings, []);
  assert.equal(catalogDigest(twice.payload), catalogDigest(once.payload));
  const edited = structuredClone(once.payload);
  const sprite = edited.products.find((p) => p.id === 'sprite');
  sprite.available = false;
  sprite.price_minor = '100';
  drinkGroup(edited, 'pick-combo').options.find((o) => o.id === 'sprite-can').price_delta_minor =
    '0';
  const result = withBarDrinks(edited, spec, { comboOptions: true });
  assert.deepEqual(result.changes, [
    { kind: 'product_available', product_id: 'sprite', from: false, to: true },
  ]);
  const after = result.payload.products.find((p) => p.id === 'sprite');
  assert.equal(after.available, true);
  assert.equal(after.price_minor, '100');
  assert.equal(result.warnings.length, 2);
  assert.match(
    result.warnings[0],
    /sprite: catalog price 1 ₸ differs from reviewed 690 ₸; not changed/,
  );
  assert.match(result.warnings[1], /pick-combo\/drink\/sprite-can: existing choice/);
});

test('ambiguous catalogs and invalid data are refused', () => {
  const refuse = (payload, pattern, data = spec, comboOptions = true) =>
    assert.throws(() => withBarDrinks(payload, data, { comboOptions }), pattern);
  const missing = live();
  missing.categories[4].name.ru = 'Бар';
  refuse(missing, /Expected one category «Напитки», found 0/);
  const twice = live();
  twice.categories[3].name.ru = 'Напитки';
  refuse(twice, /found 2/);
  const elsewhere = live();
  elsewhere.products.push({
    ...structuredClone(elsewhere.products.find((p) => p.id === 'toast')),
    id: 'sprite',
    sku: 'sprite-x',
  });
  refuse(elsewhere, /Product sprite exists outside/);
  const sku = live();
  sku.products.find((p) => p.id === 'toast').sku = 'fanta';
  refuse(sku, /SKU fanta is already used/);
  const full = live();
  for (let i = 0; full.products.length < 90; i++)
    full.products.push({
      ...structuredClone(full.products.find((p) => p.id === 'toast')),
      id: `extra-${i}`,
      sku: `extra-${i}`,
    });
  refuse(full, /103 products exceed the catalog limit of 100/);
  // Piko flavors (prepared, not yet published) leave room for 5 more choices, not 6.
  const piko = withPikoFlavors(live());
  refuse(piko, /pick-combo\/drink: 21 choices exceed the limit of 20/);
  assert.equal(withBarDrinks(piko, spec, { comboOptions: false }).payload.products.length, 37);
  const data = (change) => {
    const copy = structuredClone(spec);
    change(copy);
    return copy;
  };
  refuse(
    live(),
    /Duplicate drink id/,
    data((d) => d.drinks.push(d.drinks[0])),
  );
  refuse(
    live(),
    /image_asset_key/,
    data((d) => (d.drinks[0].image_asset_key = 'i99.jpg')),
  );
  refuse(
    live(),
    /approved_by_owner/,
    data((d) => delete d.approved_by_owner),
  );
  refuse(
    live(),
    /price_minor/,
    data((d) => (d.drinks[0].price_minor = '690.00')),
  );
});

test('new drinks reach the cashier as assembly items and old strict clients still parse them', () => {
  const branch = randomUUID(),
    prep = randomUUID(),
    assembly = randomUUID();
  const stations = [
    { id: prep, kind: 'prep' },
    { id: assembly, kind: 'assembly' },
  ];
  const before = projectCatalogMenu(live(), branch, 2, '2026-10-12T00:00:00.000Z');
  const seedRouting = {
    version: 1,
    assemblyStationId: assembly,
    routes: [{ productId: 'seed', stationId: assembly, kind: 'assembly_item' }],
  };
  const active = deriveRouting(before, seedRouting, stations);
  const { payload } = withBarDrinks(live(), spec, { comboOptions: true });
  const after = projectCatalogMenu(payload, branch, 3, '2026-10-12T00:00:00.000Z');
  const added = after.items.filter((item) => IDS.includes(item.source_id));
  assert.deepEqual(
    added.map((item) => item.source_id),
    IDS.filter((id) => id !== 'fuse-watermelon'),
    'hidden products are not sent to the cashier',
  );
  const drinksCategory = after.categories.find((c) => c.name.ru === 'Напитки').id;
  for (const item of added) {
    assert.deepEqual(item.kitchen, { route: 'assembly_item' });
    assert.equal(item.category_id, drinksCategory);
    assert.equal(item.image_url, undefined, 'generic-drink has no bundled cashier photo');
  }
  const pick = after.items.find((item) => item.source_id === 'pick-combo');
  assert.equal(
    pick.modifier_groups.find((g) => g.name.ru === 'Напиток на выбор').options.length,
    20,
  );
  const next = deriveRouting(after, active, stations);
  assert.equal(next.version, active.version + 1);
  for (const route of active.routes)
    assert.deepEqual(
      next.routes.find((r) => r.productId === route.productId),
      route,
    );
  for (const item of added)
    for (const key of [item.product_id, item.source_id])
      assert.deepEqual(
        next.routes.find((r) => r.productId === key),
        { productId: key, stationId: assembly, kind: 'assembly_item' },
      );
  const stripped = stripStorefrontPayload(payload);
  assert.equal(CatalogPayloadSchema.parse(stripped).products.length, 37);
  assert.ok(stripped.products.every((p) => !('kitchen_route' in p)));
});

test('the diff names each added drink and lists each new combo choice once', () => {
  const before = live();
  const { payload } = withBarDrinks(before, spec, { comboOptions: true });
  const lines = describeCatalogDiff(before, payload);
  assert.equal(lines.length, 13 + 6);
  assert.equal(lines[0], '+ cola-bottle «Coca-Cola 0.5 л, бутылка» 690 ₸, Напитки, в продаже');
  assert.ok(lines.includes('+ fuse-watermelon «Fuse Tea Арбуз 0.5 л» 690 ₸, Напитки, скрыта'));
  assert.ok(
    lines.includes(`+ drink: sprite-can «Sprite 0.5 л, банка» +100 ₸ [${COMBOS.join(', ')}]`),
  );
  assert.deepEqual(describeCatalogDiff(before, before), []);
  const repriced = structuredClone(before);
  repriced.products.find((p) => p.id === 'cola').price_minor = '100';
  assert.deepEqual(describeCatalogDiff(before, repriced), [
    '~ cola «Coca-Cola 0.5 л, банка»: цена 990 ₸ -> 1 ₸',
  ]);
  assert.equal(formatMinor('69050'), '690.50 ₸');
  // jsonb returns keys in its own order; the digest ignores key order.
  const reordered = Object.fromEntries(Object.entries(before).reverse());
  assert.equal(catalogDigest(reordered), catalogDigest(before));
});

const BRANCH = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1';
const ACTOR = '11111111-1111-4111-8111-111111111111';
function state(draft, published, revision = 9, version = 8) {
  return {
    branch: { id: BRANCH, code: 'ABAY-PLAZA', name: 'ТЦ Abay Plaza' },
    publication_support: { mobile: true, pos: true, kiosk: true },
    draft: {
      revision,
      base_version: version,
      updated_at: '2026-10-09T12:01:33.987Z',
      updated_by: ACTOR,
      payload: draft,
    },
    published: {
      version,
      published_at: '2026-10-09T12:01:33.987Z',
      published_by: ACTOR,
      payload: published,
    },
  };
}

test('the plan hash pins draft, publication and data; foreign draft edits are surfaced', () => {
  const base = { branchId: BRANCH, spec, specSha256: 'a'.repeat(64), comboOptions: true };
  const clean = planChange({ ...base, state: state(live(), live()) });
  assert.equal(clean.foreign, false);
  assert.equal(clean.live, false);
  assert.equal(clean.diff.length, 19);
  assert.equal(planChange({ ...base, state: state(live(), live()) }).planSha256, clean.planSha256);
  for (const changed of [
    { ...base, state: state(live(), live(), 10) },
    { ...base, state: state(live(), live(), 9, 7) },
    { ...base, specSha256: 'b'.repeat(64), state: state(live(), live()) },
    { ...base, comboOptions: false, state: state(live(), live()) },
  ])
    assert.notEqual(planChange(changed).planSha256, clean.planSha256);
  // A saved-only draft of this plan (content_reviewed=false) is not a foreign edit.
  const saved = {
    ...withBarDrinks(live(), spec, { comboOptions: true }).payload,
    content_reviewed: false,
  };
  const resumed = planChange({ ...base, state: state(saved, live()) });
  assert.equal(resumed.foreign, false);
  assert.equal(resumed.diff.length, 19);
  const foreign = live();
  foreign.products.find((p) => p.id === 'toast').price_minor = '29000';
  const edited = planChange({ ...base, state: state(foreign, live()) });
  assert.equal(edited.foreign, true);
  assert.deepEqual(edited.draftDiff, ['~ toast «Тост, 1 шт»: цена 390 ₸ -> 290 ₸']);
  const done = withBarDrinks(live(), spec, { comboOptions: true }).payload;
  assert.equal(planChange({ ...base, state: state(done, done) }).live, true);
  const restore = planChange({
    branchId: BRANCH,
    restore: live(),
    restoreSha256: 'c'.repeat(64),
    state: state(done, done),
  });
  assert.equal(restore.plan.operation, 'restore');
  assert.equal(restore.diff.length, 19);
  assert.ok(restore.diff.every((line) => line.startsWith('-')));
});

test('arguments: writes need a reviewed plan hash; plain HTTP only for a local API', () => {
  const ok = ['--branch-id', BRANCH, '--auth', 'staff', '--username', 'ceo'];
  assert.equal(parse(ok).baseUrl, 'https://pickchick.kz');
  assert.equal(parse(ok).mode, 'dry-run');
  assert.equal(
    parse(['--branch-id', BRANCH, '--auth', 'token']).baseUrl,
    'https://pickchick.185.129.51.103.nip.io',
  );
  for (const [argv, pattern] of [
    [[...ok, '--publish'], /plan-sha256/],
    [[...ok, '--save', '--publish', '--plan-sha256', 'a'.repeat(64)], /--save or --publish/],
    [['--branch-id', BRANCH, '--auth', 'staff'], /--username/],
    [[...ok, '--base-url', 'http://pickchick.kz'], /HTTPS/],
    [[...ok, '--password', 'x'], /Unknown option/],
    [[...ok, '--restore-from', 'x.json', '--combo-options'], /combo-options/],
    [['--auth', 'token'], /branch-id/],
  ])
    assert.throws(() => parse(argv), pattern);
  assert.equal(
    parse([...ok, '--base-url', 'http://127.0.0.1:3100']).baseUrl,
    'http://127.0.0.1:3100',
  );
});

test('credentials come only from env, a private file or the hidden prompt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drinks-cred-'));
  try {
    const token = 'f'.repeat(64);
    const file = path.join(dir, 'manager.json');
    await writeFile(file, JSON.stringify({ name: 'x', token }), { mode: 0o644 });
    const args = (extra = []) => parse(['--branch-id', BRANCH, '--auth', 'token', ...extra]);
    const never = () => Promise.reject(new Error('no tty'));
    await assert.rejects(
      credentials(args(['--credential-file', file]), { env: {}, prompt: never }),
      /chmod 600/,
    );
    await chmod(file, 0o600);
    assert.deepEqual(
      await credentials(args(['--credential-file', file]), { env: {}, prompt: never }),
      { kind: 'token', token },
    );
    assert.equal(
      (
        await credentials(args(), {
          env: { PICKCHICK_CATALOG_TOKEN: 'e'.repeat(64) },
          prompt: never,
        })
      ).token,
      'e'.repeat(64),
    );
    assert.equal(
      (await credentials(args(), { env: {}, prompt: async () => 'd'.repeat(64) })).token,
      'd'.repeat(64),
    );
    await assert.rejects(credentials(args(), { env: {}, prompt: never }), /No valid catalog token/);
    await assert.rejects(
      credentials(args(), { env: { PICKCHICK_CATALOG_TOKEN: 'short' }, prompt: never }),
      /No valid/,
    );
    const staff = parse(['--branch-id', BRANCH, '--auth', 'staff', '--username', 'ceo']);
    await assert.rejects(
      credentials(staff, { env: {}, prompt: never }),
      /PICKCHICK_BACKOFFICE_PASSWORD/,
    );
    assert.equal(
      (await credentials(staff, { env: { PICKCHICK_BACKOFFICE_PASSWORD: 'pw' }, prompt: never }))
        .password,
      'pw',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** In-memory staff portal + catalog API with the server's revision and receipt rules. */
function fakePortal({ password, published, loseFirstSaveResponse = false }) {
  const cookie = 'c'.repeat(64);
  const db = {
    revision: 9,
    version: 8,
    draft: structuredClone(published),
    published: structuredClone(published),
    receipts: new Map(),
  };
  const calls = [];
  let loggedIn = false,
    lose = loseFirstSaveResponse;
  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  const view = () =>
    state(structuredClone(db.draft), structuredClone(db.published), db.revision, db.version);
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname, headers: init.headers ?? {}, body });
    if (pathname === '/v1/customer-checkout/catalog') return json(200, { version: db.version });
    if (init.headers?.Origin !== 'https://pickchick.kz') return json(403, { code: 'FORBIDDEN' });
    if (pathname === '/backoffice/auth/login') {
      if (body.username !== 'ceo' || body.password !== password)
        return json(401, { code: 'UNAUTHORIZED' });
      loggedIn = true;
      return json(
        200,
        { ok: true },
        {
          'Set-Cookie': `__Host-pickchick_staff=${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict`,
        },
      );
    }
    if (pathname === '/backoffice/auth/logout') {
      loggedIn = false;
      return json(200, { ok: true });
    }
    if (!loggedIn || init.headers.Cookie !== `__Host-pickchick_staff=${cookie}`)
      return json(401, { code: 'UNAUTHORIZED' });
    const route = pathname.replace('/backoffice/api/v1/admin/catalog/branches', '');
    if (route === '' && method === 'GET')
      return json(200, {
        actor: { id: ACTOR, name: 'Владелец' },
        branches: [{ id: BRANCH, code: 'ABAY-PLAZA', name: 'ТЦ Abay Plaza' }],
      });
    if (route === `/${BRANCH}` && method === 'GET') return json(200, view());
    const receipt = db.receipts.get(body?.request_id);
    if (receipt) return json(200, receipt);
    if (body.expected_revision !== db.revision) return json(409, { code: 'CONFLICT' });
    if (route === `/${BRANCH}/draft` && method === 'PUT') {
      db.draft = CatalogPayloadSchema.parse(body.payload);
      db.revision++;
    } else if (route === `/${BRANCH}/publish` && method === 'POST') {
      if (
        !db.draft.content_reviewed ||
        body.expected_published_version !== db.version ||
        body.confirmation !== 'publish_catalog'
      )
        return json(409, { code: 'CONFLICT' });
      db.published = structuredClone(db.draft);
      db.version++;
      db.revision++;
    } else return json(404, { code: 'NOT_FOUND' });
    db.receipts.set(body.request_id, view());
    if (lose && method === 'PUT') {
      lose = false;
      throw new TypeError('fetch failed');
    }
    return json(200, view());
  };
  return { fetchImpl, calls, db };
}

test('staff session end to end: dry-run, refusal without approval, publish, replay after a lost response', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drinks-run-'));
  const password = 'correct horse battery staple 2026';
  try {
    const portal = fakePortal({ password, published: live(), loseFirstSaveResponse: true });
    const lines = [];
    const io = {
      env: { PICKCHICK_BACKOFFICE_PASSWORD: password },
      fetchImpl: portal.fetchImpl,
      out: (l) => lines.push(l),
      prompt: () => Promise.reject(new Error('no tty')),
    };
    const base = [
      '--branch-id',
      BRANCH,
      '--auth',
      'staff',
      '--username',
      'ceo',
      '--combo-options',
      '--evidence-dir',
      path.join(dir, 'evidence'),
    ];
    const dry = await run(base, io);
    assert.equal(dry.mode, 'dry-run');
    assert.ok(lines.includes('  + sprite-can «Sprite 0.5 л, банка» 790 ₸, Напитки, в продаже'));
    assert.ok(lines.some((l) => l.includes('approved_by_owner=false')));
    assert.equal(
      portal.calls.filter((c) => c.method !== 'GET' && !c.pathname.startsWith('/backoffice/auth/'))
        .length,
      0,
      'dry-run writes nothing',
    );
    await assert.rejects(
      run([...base, '--publish', '--plan-sha256', dry.plan_sha256], io),
      /approved_by_owner is false/,
    );
    assert.equal(portal.db.revision, 9);
    const approved = path.join(dir, 'approved.json');
    await writeFile(
      approved,
      JSON.stringify({ ...spec, approved_by_owner: true, approval_note: 'test' }),
    );
    const reviewed = await run([...base, '--data', approved], io);
    assert.notEqual(reviewed.plan_sha256, dry.plan_sha256, 'the data hash is part of the plan');
    await assert.rejects(
      run([...base, '--data', approved, '--publish', '--plan-sha256', dry.plan_sha256], io),
      /Plan changed since review/,
    );
    const published = await run(
      [...base, '--data', approved, '--publish', '--plan-sha256', reviewed.plan_sha256],
      io,
    );
    assert.equal(published.published_version, 9);
    assert.equal(
      portal.db.revision,
      11,
      'one save (replayed after the lost response) and one publication',
    );
    const puts = portal.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 2);
    assert.equal(puts[0].body.request_id, puts[1].body.request_id, 'retry reuses the request id');
    assert.equal(portal.db.published.products.length, 37);
    assert.equal(portal.db.published.content_reviewed, true);
    assert.equal(drinkGroup(portal.db.published, 'mix-duo').options.length, 20);
    assert.ok(lines.includes('Mobile storefront serves version 9.'));
    const again = await run([...base, '--data', approved], io);
    assert.equal(again.live, true);
    assert.equal(
      (
        await run(
          [...base, '--data', approved, '--publish', '--plan-sha256', again.plan_sha256],
          io,
        )
      ).published_version,
      undefined,
    );
    // Every login is followed by a logout; no secret reaches output or evidence.
    const auth = portal.calls
      .filter((c) => c.pathname.startsWith('/backoffice/auth/'))
      .map((c) => c.pathname);
    assert.equal(
      auth.filter((p) => p.endsWith('/login')).length,
      auth.filter((p) => p.endsWith('/logout')).length,
    );
    const evidence = [];
    const walk = async (folder) => {
      for (const entry of await readdir(folder, { withFileTypes: true }))
        if (entry.isDirectory()) await walk(path.join(folder, entry.name));
        else evidence.push(await readFile(path.join(folder, entry.name), 'utf8'));
    };
    await walk(path.join(dir, 'evidence'));
    for (const text of [...lines, ...evidence]) {
      assert.ok(!text.includes(password));
      assert.ok(!text.includes('c'.repeat(64)));
    }
    await assert.rejects(readFile(path.join(dir, 'evidence', '.lock')), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
