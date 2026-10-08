import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { PosController } from '../../apps/pos/dist/model.js';
import { ApiError } from '../../apps/pos/dist/api.js';
import { menuChangeText } from '../../apps/pos/dist/order-view.js';
import {
  categoryLabels,
  lineKey,
  menu as parseMenu,
  menuVersion,
  sortedItems,
} from '../../apps/pos/dist/types.js';
import { createPosServer } from '../../apps/pos/server.mjs';

// Two tiny real lossless WebP images (8x8), so hashes differ and browsers can decode them.
const WEBP_A = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvB8ABAAdQrcLXo/+BiOh/AAA=', 'base64');
const WEBP_B = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvB8ABAAdQnlIUuf+BiOh/AAA=', 'base64');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const memory = () => {
  const data = new Map();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
};
const names = (ru) => ({ ru, kk: ru });

/** Synthetic edge: an active menu that tests replace, with real MENU_CHANGED semantics. */
function edge() {
  const actor = {
    session_id: randomUUID(),
    staff_id: randomUUID(),
    terminal_id: randomUUID(),
    branch_id: randomUUID(),
    role: 'cashier',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  const credential = { ...actor, token: 'c'.repeat(64) };
  const category = randomUUID(),
    drinks = randomUUID(),
    group = randomUUID(),
    sauce = randomUUID(),
    spicy = randomUUID();
  const kept = {
    product_id: randomUUID(),
    variant_id: randomUUID(),
    category_id: category,
    name: names('Стрипсы'),
    currency: 'KZT',
    price_minor: '149000',
  };
  const removed = {
    product_id: randomUUID(),
    variant_id: randomUUID(),
    category_id: drinks,
    name: names('Морс'),
    currency: 'KZT',
    price_minor: '59000',
  };
  const composed = {
    product_id: randomUUID(),
    variant_id: randomUUID(),
    category_id: category,
    name: names('Фингерсы'),
    currency: 'KZT',
    price_minor: '199000',
    modifier_groups: [
      {
        id: group,
        name: names('Соус'),
        min_selected: 1,
        max_selected: 1,
        options: [
          { id: sauce, name: names('Сырный'), price_minor: '0' },
          { id: spicy, name: names('Острый'), price_minor: '0' },
        ],
      },
    ],
  };
  const snapshot = (version, items) => ({
    schema_version: 1,
    release_id: randomUUID(),
    branch_id: actor.branch_id,
    version,
    published_at: new Date().toISOString(),
    items,
  });
  const v2 = snapshot(2, [kept, removed, composed]);
  // v3: price change for the kept item, one item withdrawn, one sauce option withdrawn.
  const v3 = snapshot(3, [
    { ...kept, price_minor: '159000' },
    {
      ...composed,
      modifier_groups: [
        {
          ...composed.modifier_groups[0],
          options: [{ ...composed.modifier_groups[0].options[0] }],
        },
      ],
    },
  ]);
  const v4 = snapshot(4, [{ ...kept, price_minor: '169000' }]);
  const state = {
    active: v2,
    versionRoute: true,
    quotes: [],
    calls: [],
    beforeQuote: null,
  };
  const api = async (path, auth, options = {}) => {
    assert.equal(auth.token, credential.token);
    state.calls.push(path);
    const active = state.active;
    if (path === 'session') return actor;
    if (path === 'menu') return globalThis.structuredClone(active);
    if (path === 'menu/version') {
      if (!state.versionRoute) throw new ApiError('NOT_FOUND', 404);
      return { release_id: active.release_id, version: active.version };
    }
    if (path === 'ordering')
      return { branch_id: actor.branch_id, ordering_enabled: true, version: 1 };
    if (path.startsWith('availability/stops/'))
      return { variant_id: path.split('/')[2], stopped: false, version: 0 };
    if (path === 'availability/stops') return { stops: [] };
    if (path === 'checkout/quotes') {
      state.quotes.push(globalThis.structuredClone(options.body));
      await state.beforeQuote?.(state.quotes.length);
      const current = state.active;
      if (options.body.release_id !== current.release_id) throw new ApiError('MENU_CHANGED', 409);
      const lines = options.body.items.map((line) => {
        const item = current.items.find((i) => i.variant_id === line.variant_id);
        if (!item) throw new ApiError('INVALID_REQUEST', 400);
        const total = (BigInt(item.price_minor) * BigInt(line.quantity)).toString();
        return {
          product_id: item.product_id,
          variant_id: item.variant_id,
          name: item.name,
          quantity: line.quantity,
          unit_price_minor: item.price_minor,
          total_minor: total,
          ...(line.modifiers
            ? {
                modifiers: line.modifiers.map((m) => ({
                  ...m,
                  group_name: names('Соус'),
                  name: names('Сырный'),
                  price_minor: '0',
                })),
              }
            : {}),
        };
      });
      const total = lines.reduce((n, l) => n + BigInt(l.total_minor), 0n).toString();
      return {
        quote_id: randomUUID(),
        branch_id: actor.branch_id,
        release_id: current.release_id,
        menu_version: current.version,
        service_mode: options.body.service_mode,
        channel: 'pos',
        lines,
        currency: 'KZT',
        subtotal_minor: total,
        discount_minor: '0',
        total_minor: total,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 120000).toISOString(),
      };
    }
    if (path === 'cash-shifts/current')
      return { shift: null, server_time: new Date().toISOString() };
    if (path === 'cash-shifts') return { shifts: [], server_time: new Date().toISOString() };
    if (path === 'orders') return { orders: [], server_time: new Date().toISOString() };
    throw new Error('Unexpected synthetic path ' + path);
  };
  return {
    actor,
    credential,
    kept,
    removed,
    composed,
    group,
    sauce,
    spicy,
    v2,
    v3,
    v4,
    state,
    api,
  };
}
async function signedIn(e, storage = memory()) {
  const model = new PosController(e.api, memory(), storage, randomUUID);
  await model.login(JSON.stringify(e.credential));
  assert.equal(model.state.error, null);
  return model;
}

test('live menu: a new release mid-draft keeps valid lines, drops withdrawn ones and reprices', async () => {
  const e = edge(),
    storage = memory(),
    model = await signedIn(e, storage);
  model.quantity(e.removed.variant_id, 1);
  model.holdDraft();
  model.quantity(e.kept.variant_id, 2);
  model.quantity(e.removed.variant_id, 1);
  model.configure(e.composed.variant_id, [{ group_id: e.group, option_id: e.sauce }], 1);
  model.configure(e.composed.variant_id, [{ group_id: e.group, option_id: e.spicy }], 1);
  assert.equal(model.state.error, null);
  assert.equal(model.state.draft.items.length, 4);
  // Same release: one cheap version read, no menu reload and no notice.
  const menuReads = e.state.calls.filter((p) => p === 'menu').length;
  assert.equal(await model.syncMenu(), null);
  assert.equal(e.state.calls.filter((p) => p === 'menu').length, menuReads);
  assert.equal(model.state.menuChange, null);

  e.state.active = e.v3;
  const change = await model.syncMenu();
  assert.equal(model.state.error, null);
  assert.equal(model.state.menu.release_id, e.v3.release_id);
  assert.deepEqual(change, model.state.menuChange);
  assert.equal(change.version, 3);
  assert.equal(change.previous_version, 2);
  assert.deepEqual(change.removed.sort(), ['Морс', 'Морс', 'Фингерсы'].sort());
  assert.equal(
    menuChangeText({ version: 3, removed: ['Морс'] }),
    'Меню обновлено: позиция Морс снята',
  );
  assert.equal(menuChangeText({ version: 3, removed: [] }), 'Меню обновлено (версия 3)');
  assert.equal(
    menuChangeText({ version: 3, removed: ['Морс', 'Фингерсы'] }),
    'Меню обновлено: позиции Морс, Фингерсы сняты',
  );
  assert.equal(model.state.draft.release_id, e.v3.release_id);
  assert.deepEqual(
    model.state.draft.items.map((l) => [l.variant_id, l.quantity, l.modifiers?.[0]?.option_id]),
    [
      [e.kept.variant_id, 2, undefined],
      [e.composed.variant_id, 1, e.sauce],
    ],
  );
  assert.deepEqual(
    model.heldDrafts.map((c) => [c.release_id, c.items.length]),
    [[e.v3.release_id, 0]],
  );
  // The moved draft is durable: a restarted POS restores exactly the reconciled cart.
  const restarted = new PosController(e.api, memory(), storage, randomUUID);
  await restarted.login(JSON.stringify(e.credential));
  assert.deepEqual(restarted.state.draft, model.state.draft);
  assert.equal(restarted.state.menuChange, null, 'An already moved draft is not announced twice');
  // The kept line is repriced by the normal server quote.
  await model.calculate();
  assert.equal(model.state.error, null);
  assert.equal(model.state.quote.release_id, e.v3.release_id);
  assert.equal(model.state.quote.total_minor, (159000n * 2n + 199000n).toString());
  assert.equal(e.state.quotes.length, 1);
});

test('live menu: busy or pending commands defer the reload and a missing version route is ignored', async () => {
  const e = edge(),
    model = await signedIn(e);
  model.quantity(e.kept.variant_id, 1);
  e.state.active = e.v3;
  e.state.versionRoute = false;
  assert.equal(await model.syncMenu(), null);
  assert.equal(model.state.error, null, 'An older edge without the route is not an error');
  assert.equal(model.state.menu.release_id, e.v2.release_id);
  e.state.versionRoute = true;
  model.state.busy = true;
  assert.equal(await model.syncMenu(), null);
  model.state.busy = false;
  model.state.pending = { kind: 'create' };
  model['journal'].pending = { kind: 'create' };
  const before = e.state.calls.length;
  assert.equal(await model.syncMenu(), null);
  assert.equal(e.state.calls.length, before, 'No edge read while a command result is unknown');
  model['journal'].pending = null;
  model.state.pending = null;
  assert.equal((await model.syncMenu()).version, 3);
});

test('live menu: MENU_CHANGED during a quote reloads, moves the draft and re-quotes exactly once', async () => {
  const e = edge(),
    model = await signedIn(e);
  model.quantity(e.kept.variant_id, 1);
  model.quantity(e.removed.variant_id, 1);
  // The publication lands between the POS menu read and the quote.
  e.state.beforeQuote = (n) => {
    if (n === 1) e.state.active = e.v3;
  };
  await model.calculate();
  assert.equal(model.state.error, null);
  assert.equal(e.state.quotes.length, 2);
  assert.equal(e.state.quotes[0].release_id, e.v2.release_id);
  assert.equal(e.state.quotes[1].release_id, e.v3.release_id);
  assert.deepEqual(
    e.state.quotes[1].items.map((l) => l.variant_id),
    [e.kept.variant_id],
  );
  assert.equal(model.state.quote.total_minor, '159000');
  assert.deepEqual(model.state.menuChange.removed, ['Морс']);

  // Two publications in a row: the second change is shown instead of looping.
  e.state.beforeQuote = (n) => {
    if (n === 3) e.state.active = e.v4;
    if (n === 4) e.state.active = { ...e.v4, release_id: randomUUID(), version: 5 };
  };
  await model.calculate();
  assert.equal(e.state.quotes.length, 4);
  assert.equal(model.state.error.code, 'MENU_CHANGED');
  assert.equal(model.state.quote, null);
});

test('live menu: a shown quote is recalculated once on the new release; a drained draft is not quoted', async () => {
  const e = edge(),
    model = await signedIn(e);
  model.quantity(e.kept.variant_id, 1);
  await model.calculate();
  assert.equal(model.state.quote.release_id, e.v2.release_id);
  e.state.active = e.v3;
  await model.syncMenu();
  assert.equal(model.state.error, null);
  assert.equal(model.state.quote.release_id, e.v3.release_id);
  assert.equal(model.state.quote.total_minor, '159000');
  assert.equal(e.state.quotes.length, 2);

  const f = edge(),
    drained = await signedIn(f);
  drained.quantity(f.removed.variant_id, 1);
  await drained.calculate();
  f.state.active = f.v3;
  await drained.syncMenu();
  assert.equal(drained.state.draft.items.length, 0);
  assert.equal(drained.state.quote, null);
  assert.equal(f.state.quotes.length, 1, 'An emptied draft is never sent for a quote');
  assert.equal(drained.state.menuChange.removed[0], 'Морс');
});

test('menu parser keeps publication extras leniently; categories and order come from the snapshot', () => {
  const e = edge();
  const digest = sha(WEBP_A);
  const categories = [
    {
      id: e.kept.category_id,
      source_id: 'snacks',
      name: names('Хрустящие закуски'),
      sort_order: 1,
    },
    { id: e.removed.category_id, source_id: 'drinks', name: names('Напитки'), sort_order: 0 },
  ];
  const parsed = parseMenu({
    ...e.v2,
    categories,
    items: [
      {
        ...e.kept,
        source_id: 'strips',
        sort_order: 5,
        kind: 'item',
        sku: 'STR-1',
        description: { ru: 'Хрустящие', kk: '' },
        kitchen: { route: 'prep' },
        image: { sha256: digest, url: `/assets/menu/${digest}.webp` },
        image_url: `/assets/menu/${digest}.webp`,
      },
      { ...e.removed, sort_order: 9 },
      { ...e.composed, sort_order: 2, kind: 'combo' },
    ],
  });
  assert.deepEqual(parsed.categories, categories);
  assert.equal(parsed.items[0].source_id, 'strips');
  assert.equal(parsed.items[0].kind, 'item');
  assert.deepEqual(parsed.items[0].image, { sha256: digest, url: `/assets/menu/${digest}.webp` });
  assert.equal('kitchen' in parsed.items[0], false);
  assert.equal('sku' in parsed.items[0], false);
  // Snapshot names win over operator config, which wins over the neutral fallback.
  const labels = categoryLabels(parsed, { [e.kept.category_id]: 'Из конфига' });
  assert.equal(labels.get(e.kept.category_id), 'Хрустящие закуски');
  assert.equal(labels.get(e.removed.category_id), 'Напитки');
  assert.deepEqual([...labels.keys()], [e.removed.category_id, e.kept.category_id]);
  assert.deepEqual(
    sortedItems(parsed).map((i) => i.name.ru),
    ['Морс', 'Фингерсы', 'Стрипсы'],
  );
  const legacy = parseMenu(e.v2);
  assert.equal(legacy.categories, undefined);
  const fallback = categoryLabels(legacy, { [e.removed.category_id]: 'Напитки из конфига' });
  assert.equal(fallback.get(e.kept.category_id), 'Категория 1');
  assert.equal(fallback.get(e.removed.category_id), 'Напитки из конфига');
  assert.deepEqual(sortedItems(legacy), legacy.items, 'Old snapshots keep their order');
  // Malformed extras are dropped, never trusted and never fatal for the cashier menu.
  const odd = parseMenu({
    ...e.v2,
    categories: [{ ...categories[0], name: 'bad' }],
    items: [
      {
        ...e.kept,
        source_id: 'Not A Slug',
        sort_order: -1,
        kind: 'party',
        image: { sha256: digest, url: 'https://example.invalid/x.webp' },
        image_url: '/assets/menu/i7.jpg',
      },
      {
        ...e.removed,
        image: { sha256: 'A'.repeat(64), url: `/assets/menu/${'A'.repeat(64)}.webp` },
      },
      { ...e.composed },
    ],
  });
  assert.equal(odd.categories, undefined);
  for (const item of odd.items)
    for (const key of ['source_id', 'sort_order', 'kind', 'image'])
      assert.equal(key in item, false);
  // Categories that miss an item category are ignored as a whole.
  assert.equal(parseMenu({ ...e.v2, categories: [categories[0]] }).categories, undefined);
  // The installed regex already admits hash names; foreign image URLs still fail the menu.
  assert.equal(
    parseMenu({ ...e.v2, items: [{ ...e.kept, image_url: `/assets/menu/${digest}.webp` }] })
      .items[0].image_url,
    `/assets/menu/${digest}.webp`,
  );
  assert.throws(() =>
    parseMenu({ ...e.v2, items: [{ ...e.kept, image_url: 'https://example.invalid/a.webp' }] }),
  );
  assert.deepEqual(menuVersion({ release_id: e.v2.release_id, version: 2 }), {
    release_id: e.v2.release_id,
    version: 2,
  });
  assert.throws(() => menuVersion({ release_id: 'x', version: 2 }));
  assert.throws(() => menuVersion({ release_id: e.v2.release_id, version: 0 }));
  assert.equal(lineKey({ variant_id: e.kept.variant_id }), e.kept.variant_id);
});

test('POS server serves hash photos only from the loopback edge after verifying the bytes', async () => {
  const good = sha(WEBP_A),
    tampered = sha(WEBP_B),
    notWebp = Buffer.from('not a webp image at all'),
    plain = sha(notWebp);
  const upstream = [];
  const fake = createServer((req, res) => {
    upstream.push(req.url);
    if (req.url === `/edge/v1/media/${good}.webp`) {
      res.writeHead(200, { 'Content-Type': 'image/webp' });
      res.end(WEBP_A);
    } else if (req.url === `/edge/v1/media/${tampered}.webp`) {
      res.writeHead(200, { 'Content-Type': 'image/webp' });
      res.end(WEBP_A); // Bytes that do not match the requested name.
    } else if (req.url === `/edge/v1/media/${plain}.webp`) {
      res.writeHead(200, { 'Content-Type': 'image/webp' });
      res.end(notWebp);
    } else if (req.url === '/edge/v1/menu/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ release_id: randomUUID(), version: 7 }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"code":"NOT_FOUND"}');
    }
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const pos = createPosServer({ edgePort: fake.address().port });
  await new Promise((r) => pos.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${pos.address().port}`;
  const logo = await (await fetch(`${url}/v2/assets/logo.png`)).arrayBuffer();
  try {
    const photo = await fetch(`${url}/assets/menu/${good}.webp`);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/webp');
    assert.equal(photo.headers.get('cache-control'), 'no-store');
    assert.match(photo.headers.get('content-security-policy'), /img-src 'self'/);
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), WEBP_A);
    // Verified bytes are immutable by name and kept in memory.
    const reads = upstream.length;
    assert.equal((await fetch(`${url}/assets/menu/${good}.webp`)).status, 200);
    assert.equal(upstream.length, reads);
    for (const name of [tampered, plain, 'f'.repeat(64)]) {
      const fallback = await fetch(`${url}/assets/menu/${name}.webp`);
      assert.equal(fallback.status, 200, name);
      assert.equal(fallback.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), Buffer.from(logo));
    }
    // Failures are not cached: the edge is asked again once it may have the photo.
    const before = upstream.length;
    await fetch(`${url}/assets/menu/${tampered}.webp`);
    assert.equal(upstream.length, before + 1);
    const asked = upstream.length;
    for (const path of [
      `/assets/menu/${good.toUpperCase()}.webp`,
      `/assets/menu/${good}.jpg`,
      `/assets/menu/${good.slice(1)}.webp`,
      `/assets/menu/${good}.webp?x=1`,
      `/assets/menu/../${good}.webp`,
      '/assets/menu/i99.jpg',
    ])
      assert.equal((await fetch(url + path)).status, 404, path);
    assert.equal(upstream.length, asked, 'Rejected names never reach the edge');
    const version = await fetch(`${url}/edge/v1/menu/version`);
    assert.equal(version.status, 200);
    assert.equal((await version.json()).version, 7);
    assert.equal(upstream.at(-1), '/edge/v1/menu/version');
    assert.equal((await fetch(`${url}/edge/v1/menu/version?x=1`)).status, 404);
  } finally {
    await new Promise((r) => pos.close(r));
    await new Promise((r) => fake.close(r));
  }
});
