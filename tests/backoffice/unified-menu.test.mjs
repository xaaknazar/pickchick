/* global Blob, structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  ApiError,
  allowedPath,
  failure,
  mediaUrl,
  message,
  transport,
  uploadAsset,
} from '../../apps/backoffice/dist/api.js';
import {
  deliveryText,
  parseState,
  productIssues,
  publicationCopy,
} from '../../apps/backoffice/dist/domain.js';
import { CatalogModel } from '../../apps/backoffice/dist/model.js';
import {
  StopsModel,
  defaultStopReason,
  stopList,
} from '../../apps/backoffice/dist/operations-model.js';
import { stopRowState } from '../../apps/backoffice/dist/operations.js';
import { allowed, createBackofficeServer, MEDIA_ROUTE } from '../../apps/backoffice/server.mjs';
import { storage } from './helpers.mjs';

const branch = '10000000-0000-4000-8000-000000000003';
const token = 'a'.repeat(64);
const sha = 'b'.repeat(64);
const envelope = (code, reason) => ({
  code,
  message_key: `errors.${code.toLowerCase()}`,
  trace_id: randomUUID(),
  retryable: false,
  ...(reason === undefined ? {} : { error: { code: reason } }),
});

test('client allowlist mirrors the proxy: assets and stops only, never with a query', () => {
  for (const path of [
    `branches/${branch}/assets`,
    `operations/branches/${branch}/stops`,
    `branches/${branch}/publish`,
    `operations/branches/${branch}/commands`,
  ])
    assert.equal(allowedPath(path), true, path);
  for (const path of [
    `branches/${branch}/assets?x=1`,
    `branches/${branch}/assets/${branch}`,
    `operations/branches/${branch}/stops?period=day`,
    `operations/branches/${branch}/stops/${branch}`,
    `branches/${branch}/media`,
    `operations/branches/${branch}/stop`,
  ])
    assert.equal(allowedPath(path), false, path);
  assert.equal(mediaUrl(token, sha), `/v1/media/catalog/${sha}.card.webp`);
  assert.equal(mediaUrl('session', sha), `/backoffice/api/v1/media/catalog/${sha}.card.webp`);
  assert.throws(
    () => mediaUrl(token, 'B'.repeat(64)),
    (e) => e.code === 'INVALID_REQUEST',
  );
});

test('reason envelope becomes a precise Russian message; malformed reasons are ignored', async () => {
  const conflict = failure(409, envelope('CONFLICT', 'EDGE_MENU_STATE_UNKNOWN'));
  assert.equal(conflict.code, 'CONFLICT');
  assert.equal(conflict.reason, 'EDGE_MENU_STATE_UNKNOWN');
  assert.match(message(conflict), /Касса ещё не сообщила свою версию меню/);
  for (const [reason, text] of [
    ['CHANNEL_PRICES_NOT_SUPPORTED', /одну базовую цену/],
    ['UNAVAILABLE_LINKED_PRODUCT', /скрытую из меню/],
    ['ASSET_MISSING', /Загруженное фото не найдено/],
    ['STOP_COMMAND_IN_PROGRESS', /уже есть команда/],
    ['REMOTE_STOPS_DISABLED', /выключен на сервере/],
  ])
    assert.match(message(failure(409, envelope('CONFLICT', reason))), text, reason);
  assert.match(
    message(new ApiError('FORBIDDEN', 403, 'PUBLISH_FORBIDDEN')),
    /Нет права публиковать/,
  );
  // An unknown reason keeps the generic message of its code; a bad one is dropped.
  assert.equal(
    message(failure(409, envelope('CONFLICT', 'SOMETHING_NEW'))),
    message(new ApiError('CONFLICT')),
  );
  assert.equal(failure(409, envelope('CONFLICT', 'lower-case')).reason, undefined);
  assert.equal(failure(409, { ...envelope('CONFLICT'), error: 'x' }).reason, undefined);
  assert.equal(failure(409, { code: 'CONFLICT' }).code, 'INVALID_RESPONSE');
  const original = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url, options) => {
      seen.push([url, options.method]);
      return Response.json(envelope('NOT_FOUND', 'CATALOG_ITEM_NOT_FOUND'), { status: 404 });
    };
    await assert.rejects(
      transport(`operations/branches/${branch}/stops`, token, { method: 'POST', body: {} }),
      (e) => e.code === 'NOT_FOUND' && e.reason === 'CATALOG_ITEM_NOT_FOUND' && e.status === 404,
    );
    await assert.rejects(
      transport(`branches/${branch}/assets`, token),
      (e) => e.code === 'NOT_FOUND',
    );
    assert.deepEqual(seen, [
      [`/v1/admin/backoffice/branches/${branch}/stops`, 'POST'],
      [`/v1/admin/catalog/branches/${branch}/assets`, 'GET'],
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test('cashier delivery copy, 10-minute warning and publication copy per connected channel', () => {
  const base = {
    catalog_version: 3,
    menu_version: 5,
    release_id: randomUUID(),
    device_id: randomUUID(),
    acknowledged_at: null,
  };
  const now = Date.parse('2026-10-08T12:00:00Z');
  assert.deepEqual(deliveryText({ ...base, status: 'applied' }, null, now), {
    text: 'Касса: применено (версия 5)',
    tone: 'good',
    warning: null,
  });
  const fresh = deliveryText({ ...base, status: 'pending' }, '2026-10-08T11:55:00Z', now);
  assert.equal(fresh.text, 'Касса: ожидает');
  assert.equal(fresh.warning, null);
  const late = deliveryText({ ...base, status: 'pending' }, '2026-10-08T11:49:00Z', now);
  assert.match(late.warning, /больше 10 минут/);
  assert.equal(
    deliveryText({ ...base, status: 'rejected', reject_reason: 'MEDIA_UNAVAILABLE' }, null, now)
      .text,
    'Касса: отклонено — касса не смогла загрузить фото',
  );
  assert.match(
    deliveryText({ ...base, status: 'rejected', reject_reason: 'ROUTING_UNRESOLVED' }, null).text,
    /станцию кухни/,
  );
  assert.match(deliveryText({ ...base, status: 'unavailable' }, null).text, /не подключена/);
  const all = publicationCopy({ mobile: true, kiosk: true, pos: true });
  assert.match(all, /мобильное приложение и киоск получат новые цены, фото и состав сразу/);
  assert.match(all, /Касса получит меню после подтверждения/);
  assert.doesNotMatch(all, /Не подключены/);
  assert.match(
    publicationCopy({ mobile: true, kiosk: false, pos: false }),
    /Не подключены: киоск, касса/,
  );
  assert.match(publicationCopy(undefined), /ещё не включена/);
});

function catalogState(extra = {}) {
  return {
    branch: { id: branch, code: 'b', name: 'Точка' },
    draft: null,
    published: null,
    ...extra,
  };
}

test('catalog state keeps channel flags and drops an unreadable cashier delivery', () => {
  const delivery = {
    catalog_version: 1,
    menu_version: 3,
    release_id: randomUUID(),
    device_id: randomUUID(),
    status: 'rejected',
    acknowledged_at: '2026-10-08T10:00:00.000Z',
    reject_reason: 'VERSION_NOT_NEWER',
    edge_active_version: 4,
    observed_at: '2026-10-08T10:00:01.000Z',
  };
  const state = parseState(
    catalogState({
      publication_support: { mobile: true, pos: true, kiosk: false },
      edge_delivery: delivery,
    }),
  );
  assert.deepEqual(state.publication_support, { mobile: true, pos: true, kiosk: false });
  assert.deepEqual(state.edge_delivery, delivery);
  for (const broken of [
    { ...delivery, status: 'exploded' },
    { ...delivery, reject_reason: 'NOPE' },
    { ...delivery, menu_version: 0 },
    'x',
  ])
    assert.equal(parseState(catalogState({ edge_delivery: broken })).edge_delivery, null);
  assert.equal(parseState(catalogState({ edge_delivery: null })).edge_delivery, null);
});

test('product validation accepts a hex image reference and kitchen route only', () => {
  const payload = {
    categories: [{ id: 'main', name: { ru: 'Главное', kk: '' } }],
    products: [],
  };
  const product = {
    id: 'combo',
    sku: 'COMBO',
    name: { ru: 'Комбо', kk: '' },
    description: { ru: '', kk: '' },
    category_id: 'main',
    price_minor: '100000',
    image_asset_key: 'generic-drink',
    available: true,
    prep_required: true,
    prep_minutes: 10,
    serving_label: { ru: '1 порция', kk: '' },
    weight_g: null,
    volume_ml: null,
    ingredients: { ru: '', kk: '' },
    allergens: [],
    allergens_status: 'unknown',
    nutrition: { basis: 'per_serving', energy_kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
    nutrition_status: 'unverified',
    kind: 'item',
    combo_components: [],
    modifier_groups: [],
  };
  const issues = (p) => productIssues(p, { ...payload, products: [p] });
  assert.deepEqual(issues(product), []);
  const image = { asset_id: randomUUID(), sha256: sha, tile_color: '#FF6600', cutout: true };
  assert.deepEqual(issues({ ...product, image, kitchen_route: 'assembly_item' }), []);
  for (const bad of [
    { ...image, sha256: sha.toUpperCase() },
    { ...image, tile_color: '#ff6600' },
    { ...image, cutout: 'yes' },
    { ...image, url: '/x' },
    { asset_id: 'x', sha256: sha },
  ])
    assert.match(issues({ ...product, image: bad }).join(), /Загруженное фото/);
  assert.match(issues({ ...product, kitchen_route: 'grill' }).join(), /станцию кухни/);
});

async function loggedIn(api, uploader) {
  const store = storage();
  const model = new CatalogModel(api, store, () => randomUUID(), uploader);
  assert.equal(await model.login(JSON.stringify({ token })), true);
  return model;
}
const actor = { id: randomUUID(), name: 'Управляющий' };

test('photo upload uses the branch, token and idempotency key and maps role failures', async () => {
  const calls = [];
  let answer = () => ({
    asset_id: randomUUID(),
    image: { asset_id: '', sha256: sha },
    width: 900,
    height: 700,
  });
  const api = async (path) => {
    if (path === 'branches') return { actor, branches: [{ id: branch, code: 'b', name: 'Точка' }] };
    return catalogState();
  };
  const model = await loggedIn(api, async (...args) => {
    calls.push(args);
    return answer();
  });
  const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  const progress = () => undefined;
  const key = randomUUID();
  await model.uploadPhoto(file, progress, key);
  assert.deepEqual(calls[0], [token, branch, file, key, progress]);
  assert.equal(model.mediaUrl(sha), `/v1/media/catalog/${sha}.card.webp`);
  answer = () => {
    throw new ApiError('FORBIDDEN', 403);
  };
  await assert.rejects(model.uploadPhoto(file), (e) => e.reason === 'UPLOAD_FORBIDDEN');
  answer = () => {
    throw new ApiError('SERVICE_UNAVAILABLE', 503);
  };
  await assert.rejects(model.uploadPhoto(file), (e) => e.reason === 'UPLOAD_DISABLED');
  answer = () => {
    throw new ApiError('INVALID_REQUEST', 400, 'ASSET_INVALID_IMAGE');
  };
  await assert.rejects(model.uploadPhoto(file), (e) => e.reason === 'ASSET_INVALID_IMAGE');
  answer = () => {
    throw new ApiError('UNAUTHORIZED', 401);
  };
  await assert.rejects(model.uploadPhoto(file), (e) => e.code === 'UNAUTHORIZED');
  assert.equal(model.actor, null);
});

test('status refresh updates only the cashier delivery; publish 403 and reason conflicts are precise', async () => {
  let state = catalogState({
    publication_support: { mobile: true, pos: true, kiosk: true },
    edge_delivery: null,
  });
  let publish = null;
  const api = async (path, _token, options) => {
    if (path === 'branches') return { actor, branches: [{ id: branch, code: 'b', name: 'Точка' }] };
    if (path.endsWith('/publish')) {
      assert.equal(options.method, 'POST');
      throw publish;
    }
    return structuredClone(state);
  };
  const model = await loggedIn(api);
  assert.equal(model.state.edge_delivery, null);
  const delivery = {
    catalog_version: 1,
    menu_version: 3,
    release_id: randomUUID(),
    device_id: randomUUID(),
    status: 'applied',
    acknowledged_at: '2026-10-08T10:00:00.000Z',
  };
  state = { ...state, edge_delivery: delivery };
  assert.equal(await model.refreshStatus(), true);
  assert.deepEqual(model.state.edge_delivery, delivery);
  // Another manager published meanwhile: an explicit reload picks that up, not the poll.
  state = {
    ...state,
    published: {
      version: 1,
      published_at: '2026-10-08T10:00:00.000Z',
      published_by: actor.id,
      payload: null,
    },
  };
  // parseState rejects a null payload, so a broken poll changes nothing.
  assert.equal(await model.refreshStatus(), false);
  assert.deepEqual(model.state.edge_delivery, delivery);

  // Publish failures: FORBIDDEN without a reason is a missing publish right; a reason-carrying
  // CONFLICT is not a draft revision race.
  model.state = {
    ...model.state,
    draft: { revision: 1, base_version: 0, updated_at: '', updated_by: actor.id, payload: {} },
  };
  const arm = (error) => {
    publish = error;
    model['journal'] = {
      actorId: actor.id,
      branchId: branch,
      revision: 1,
      payload: { content_reviewed: true, products: [] },
      dirty: false,
      pending: null,
    };
    model.payload = { content_reviewed: true, products: [] };
    model.pending = null;
  };
  arm(new ApiError('FORBIDDEN', 403));
  assert.equal(await model.publish(), false);
  assert.equal(model.error.reason, 'PUBLISH_FORBIDDEN');
  assert.match(message(model.error), /Нет права публиковать/);
  assert.equal(model.conflict, false);
  assert.equal(model.pending, null);
  arm(new ApiError('CONFLICT', 409, 'EDGE_MENU_STATE_UNKNOWN'));
  assert.equal(await model.publish(), false);
  assert.equal(model.error.reason, 'EDGE_MENU_STATE_UNKNOWN');
  assert.equal(model.conflict, false);
  arm(new ApiError('CONFLICT', 409));
  assert.equal(await model.publish(), false);
  assert.equal(model.conflict, true);
});

function stopItem(extra = {}) {
  return {
    catalog_ref: { product_id: 'pick-combo' },
    variant_id: randomUUID(),
    kind: 'product',
    name_ru: 'Пик комбо',
    product_name_ru: 'Пик комбо',
    group_name_ru: null,
    listed: true,
    stopped: false,
    version: 3,
    source: null,
    expires_at: null,
    shift_scoped: false,
    sales_blocked: false,
    pending: null,
    last_result: null,
    ...extra,
  };
}
function stopListBody(items, extra = {}) {
  return {
    schema_version: 2,
    branch_id: branch,
    role: 'manager',
    as_of: new Date().toISOString(),
    remote_stops: { enabled: true, edge_ready: true, writable: true },
    catalog: { version: 2, published_at: new Date().toISOString() },
    availability: {
      device_id: randomUUID(),
      revision: '4',
      observed_at: new Date().toISOString(),
      fresh: true,
      stopped_count: 0,
      states_reported: true,
      source: 'edge_transport',
    },
    items,
    unknown_stops: [],
    ...extra,
  };
}

test('stop list v2 parsing, unsupported API fallback and per-row cashier verdicts', async () => {
  const item = stopItem();
  assert.equal(stopList(stopListBody([item]), branch).items.length, 1);
  for (const broken of [
    stopListBody([item], { schema_version: 1 }),
    stopListBody([item], { branch_id: randomUUID() }),
    stopListBody([{ ...item, version: -1 }]),
    stopListBody([{ ...item, catalog_ref: { product_id: 'x', group_id: 'g' } }]),
    stopListBody([{ ...item, pending: { state: 'pending' } }]),
  ])
    assert.throws(
      () => stopList(broken, branch),
      (e) => e.code === 'INVALID_RESPONSE',
    );
  const at = '2026-10-08T07:03:00.000Z';
  const result = (state) => ({
    command_id: randomUUID(),
    stopped: true,
    state,
    result_version: 4,
    actor_label: 'Управляющий',
    created_at: at,
    resolved_at: at,
  });
  assert.match(
    stopRowState(stopItem({ last_result: result('applied') })).text,
    /^Применено кассой /,
  );
  assert.equal(
    stopRowState(stopItem({ last_result: result('conflict') })).text,
    'Касса изменила позицию — обновите',
  );
  assert.equal(
    stopRowState(stopItem({ last_result: result('no_open_shift') })).text,
    'Нет открытой смены',
  );
  assert.equal(
    stopRowState(stopItem({ last_result: result('expired') })).text,
    'Касса не ответила за 2 минуты',
  );
  const waiting = stopRowState(
    stopItem({
      pending: {
        command_id: randomUUID(),
        stopped: true,
        duration: 'hour',
        state: 'delivered',
        actor_label: 'Управляющий',
        created_at: at,
        expires_at: at,
      },
      last_result: result('applied'),
    }),
  );
  assert.equal(waiting.text, 'Ждём подтверждения кассы…');
  assert.equal(stopRowState(stopItem()), null);

  const model = new StopsModel(
    async () => {
      throw new ApiError('NOT_FOUND', 404);
    },
    () => undefined,
  );
  await model.load('actor', branch);
  assert.equal(model.unsupported, true);
  assert.equal(model.data, null);
  const reasoned = new StopsModel(
    async () => {
      throw new ApiError('SERVICE_UNAVAILABLE', 503);
    },
    () => undefined,
  );
  await reasoned.load('actor', branch);
  assert.equal(reasoned.unsupported, false);
  assert.equal(reasoned.error.code, 'SERVICE_UNAVAILABLE');
});

test('stop command sends the row version, a default reason and reuses the id only for an identical retry', async () => {
  const item = stopItem();
  let body = stopListBody([item]);
  const posts = [];
  let fail = null;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const api = async (path, request) => {
    assert.equal(path, `branches/${branch}/stops`);
    if (!request) return structuredClone(body);
    posts.push(request.body);
    if (fail) {
      const error = fail;
      fail = null;
      throw error;
    }
    const pending = {
      command_id: randomUUID(),
      stopped: request.body.stopped,
      duration: request.body.duration,
      state: 'pending',
      actor_label: 'Управляющий',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 120000).toISOString(),
    };
    body = stopListBody([{ ...item, pending }]);
    return {
      command_id: randomUUID(),
      state: 'pending',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 120000).toISOString(),
    };
  };
  let changes = 0;
  const model = new StopsModel(
    api,
    () => changes++,
    () => ids.shift(),
  );
  await model.load('actor', branch);
  assert.equal(model.nextDelay(), 10000);
  // A lost reply keeps the request id for the exact same intent.
  fail = new ApiError('NETWORK');
  await assert.rejects(
    model.request(model.data.items[0], { stopped: true, duration: 'hour', reason: '' }),
    (e) => e.code === 'NETWORK',
  );
  await model.request(model.data.items[0], { stopped: true, duration: 'hour', reason: '  ' });
  assert.equal(posts.length, 2);
  assert.equal(posts[0].request_id, posts[1].request_id);
  assert.deepEqual(posts[1], {
    request_id: posts[0].request_id,
    catalog_ref: { product_id: 'pick-combo' },
    stopped: true,
    duration: 'hour',
    reason: defaultStopReason(true),
    expected_version: 3,
  });
  // The row turns pending at once and the poll speeds up.
  assert.equal(model.data.items[0].pending.state, 'pending');
  assert.equal(model.nextDelay(), 2000);
  await assert.rejects(
    model.request(model.data.items[0], { stopped: true, duration: 'manual', reason: '' }),
    (e) => e.reason === 'STOP_COMMAND_IN_PROGRESS',
  );
  // An unstop always goes without a duration; a changed intent gets a fresh id.
  body = stopListBody([{ ...item, stopped: true, sales_blocked: true }]);
  await model.load('actor', branch);
  fail = new ApiError('CONFLICT', 409, 'STOP_COMMAND_IN_PROGRESS');
  await assert.rejects(
    model.request(model.data.items[0], { stopped: false, duration: 'shift', reason: 'Поставка' }),
    (e) => e.reason === 'STOP_COMMAND_IN_PROGRESS',
  );
  assert.equal(posts[2].duration, 'manual');
  assert.equal(posts[2].reason, 'Поставка');
  assert.notEqual(posts[2].request_id, posts[0].request_id);
  const sent = posts.length;
  body = stopListBody([item], {
    role: 'analyst',
    remote_stops: { enabled: true, edge_ready: true, writable: false },
  });
  await model.load('actor', branch);
  await assert.rejects(
    model.request(model.data.items[0], { stopped: true, duration: 'manual', reason: '' }),
    (e) => e.reason === 'STOP_FORBIDDEN',
  );
  body = stopListBody([item], {
    remote_stops: { enabled: false, edge_ready: true, writable: false },
  });
  await model.load('actor', branch);
  await assert.rejects(
    model.request(model.data.items[0], { stopped: true, duration: 'manual', reason: '' }),
    (e) => e.reason === 'REMOTE_STOPS_DISABLED',
  );
  body = stopListBody([{ ...item, version: null }]);
  await model.load('actor', branch);
  await assert.rejects(
    model.request(model.data.items[0], { stopped: true, duration: 'manual', reason: '' }),
    (e) => e.reason === 'EDGE_STOPS_NOT_READY',
  );
  assert.equal(posts.length, sent, 'refused locally without a request');
  assert.ok(changes > 0);
});

test('raw upload sends exact bytes with idempotency key, reports progress and parses reasons', async () => {
  const original = globalThis.XMLHttpRequest;
  const sent = [];
  let reply;
  class FakeXhr {
    constructor() {
      this.headers = {};
      this.listeners = {};
      this.upload = {
        addEventListener: (name, fn) => {
          this.progress = fn;
        },
      };
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    }
    getResponseHeader(name) {
      return name === 'content-type' ? 'application/json; charset=utf-8' : null;
    }
    send(body) {
      sent.push(this);
      this.body = body;
      this.progress({ lengthComputable: true, loaded: 1, total: 2 });
      Object.assign(this, reply());
      this.listeners.load();
    }
  }
  globalThis.XMLHttpRequest = FakeXhr;
  try {
    const asset = randomUUID();
    reply = () => ({
      status: 200,
      responseText: JSON.stringify({
        asset_id: asset,
        width: 900,
        height: 700,
        image: { asset_id: asset, sha256: sha },
        variants: { card: { sha256: sha } },
      }),
    });
    const file = new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' });
    const key = randomUUID();
    const progress = [];
    const result = await uploadAsset(token, branch, file, key, (f) => progress.push(f));
    assert.deepEqual(result, {
      asset_id: asset,
      image: { asset_id: asset, sha256: sha },
      width: 900,
      height: 700,
    });
    assert.deepEqual(progress, [0.5, 1]);
    const [xhr] = sent;
    assert.equal(xhr.method, 'POST');
    assert.equal(xhr.url, `/v1/admin/catalog/branches/${branch}/assets`);
    assert.deepEqual(xhr.headers, {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'image/jpeg',
      'Idempotency-Key': key,
    });
    assert.equal(xhr.body, file);
    await uploadAsset('session', branch, file, key);
    assert.equal(sent[1].url, `/backoffice/api/v1/admin/catalog/branches/${branch}/assets`);
    assert.equal(sent[1].headers.Authorization, undefined);
    assert.equal(sent[1].withCredentials, true);
    reply = () => ({
      status: 400,
      responseText: JSON.stringify(envelope('INVALID_REQUEST', 'ASSET_INVALID_IMAGE')),
    });
    await assert.rejects(
      uploadAsset(token, branch, file, key),
      (e) => e.code === 'INVALID_REQUEST' && e.reason === 'ASSET_INVALID_IMAGE',
    );
    // The card hash must equal the product reference hash.
    reply = () => ({
      status: 200,
      responseText: JSON.stringify({
        asset_id: asset,
        width: 1,
        height: 1,
        image: { asset_id: asset, sha256: sha },
        variants: { card: { sha256: 'c'.repeat(64) } },
      }),
    });
    await assert.rejects(
      uploadAsset(token, branch, file, key),
      (e) => e.code === 'INVALID_RESPONSE',
    );
    const before = sent.length;
    for (const bad of [
      new Blob([new Uint8Array(1)], { type: 'image/gif' }),
      new Blob([new Uint8Array(1)], { type: 'image/svg+xml' }),
      new Blob([], { type: 'image/jpeg' }),
      new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/jpeg' }),
    ])
      await assert.rejects(
        uploadAsset(token, branch, bad, key),
        (e) => e.code === 'INVALID_REQUEST',
      );
    await assert.rejects(uploadAsset(token, 'x', file, key), (e) => e.code === 'INVALID_REQUEST');
    await assert.rejects(
      uploadAsset(token, branch, file, 'x'),
      (e) => e.code === 'INVALID_REQUEST',
    );
    assert.equal(sent.length, before);
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test('proxy: raw upload limit only on the upload route, stops JSON routes, media GET without credentials', async () => {
  const received = [];
  const webp = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBP'),
    Buffer.alloc(20),
  ]);
  let media = () => ({ status: 200, type: 'image/webp', body: webp });
  const api = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks),
    });
    if (req.url.startsWith('/v1/media/')) {
      const m = media();
      res.writeHead(m.status, {
        'Content-Type': m.type,
        ...(m.length ? { 'Content-Length': m.body.length } : { 'Transfer-Encoding': 'chunked' }),
      });
      res.end(m.body);
      return;
    }
    res.writeHead(req.method === 'POST' && req.url.endsWith('/stops') ? 202 : 200, {
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ ok: true }));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const ui = createBackofficeServer({ apiPort: api.address().port });
  ui.listen(0, '127.0.0.1');
  await once(ui, 'listening');
  const base = `http://127.0.0.1:${ui.address().port}`;
  const auth = { Authorization: 'Bearer ' + token };
  const assets = `/v1/admin/catalog/branches/${branch}/assets`,
    stops = `/v1/admin/backoffice/branches/${branch}/stops`,
    photo = `/v1/media/catalog/${sha}.card.webp`;
  try {
    // Route table (pure).
    assert.equal(allowed('POST', assets), true);
    assert.equal(allowed('GET', assets), true);
    assert.equal(allowed('PUT', assets), false);
    assert.equal(allowed('POST', assets + '?x=1'), false);
    assert.equal(allowed('GET', stops), true);
    assert.equal(allowed('POST', stops), true);
    assert.equal(allowed('PUT', stops), false);
    assert.equal(allowed('GET', stops + '?period=day'), false);
    assert.equal(allowed('POST', `/v1/admin/backoffice/branches/${branch}/stops/x`), false);
    for (const ok of [
      photo,
      `/v1/media/catalog/${sha}.webp`,
      `/v1/media/catalog/${sha}.thumb.webp`,
    ])
      assert.equal(MEDIA_ROUTE.test(ok), true, ok);

    // A 5 MB photo passes only on the upload route, byte-exact, with type and key forwarded.
    const big = Buffer.alloc(5 * 1024 * 1024, 7);
    const key = randomUUID();
    let r = await fetch(base + assets, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'image/jpeg', 'Idempotency-Key': key },
      body: big,
    });
    assert.equal(r.status, 200);
    const upload = received.at(-1);
    assert.equal(upload.url, assets);
    assert.equal(upload.headers['content-type'], 'image/jpeg');
    assert.equal(upload.headers['idempotency-key'], key);
    assert.equal(upload.headers.authorization, auth.Authorization);
    assert.equal(upload.body.equals(big), true);
    let count = received.length;
    for (const [headers, body, status] of [
      [
        { 'Content-Type': 'image/jpeg', 'Idempotency-Key': key },
        Buffer.alloc(10 * 1024 * 1024 + 1),
        413,
      ],
      [{ 'Content-Type': 'image/gif', 'Idempotency-Key': key }, Buffer.alloc(10), 415],
      [{ 'Content-Type': 'image/svg+xml', 'Idempotency-Key': key }, Buffer.alloc(10), 415],
      [{ 'Content-Type': 'application/json', 'Idempotency-Key': key }, '{}', 415],
      [{ 'Content-Type': 'image/jpeg' }, Buffer.alloc(10), 400],
      [{ 'Content-Type': 'image/jpeg', 'Idempotency-Key': 'nope' }, Buffer.alloc(10), 400],
      [{ 'Content-Type': 'image/jpeg', 'Idempotency-Key': key }, Buffer.alloc(0), 400],
    ]) {
      r = await fetch(base + assets, { method: 'POST', headers: { ...auth, ...headers }, body });
      assert.equal(r.status, status, JSON.stringify(headers));
      await r.arrayBuffer();
    }
    // Without a bearer the upload never reaches the API.
    r = await fetch(base + assets, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'Idempotency-Key': key },
      body: Buffer.alloc(10),
    });
    assert.equal(r.status, 401);
    assert.equal(received.length, count);

    // Stops: JSON only, 300 KB cap, raw images refused.
    r = await fetch(base + stops, { headers: auth });
    assert.equal(r.status, 200);
    r = await fetch(base + stops, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: randomUUID() }),
    });
    assert.equal(r.status, 202);
    assert.equal(received.at(-1).method, 'POST');
    count = received.length;
    for (const [type, body, status] of [
      ['application/json', JSON.stringify({ pad: 'x'.repeat(301 * 1024) }), 413],
      ['image/jpeg', Buffer.alloc(10), 415],
    ]) {
      r = await fetch(base + stops, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': type },
        body,
      });
      assert.equal(r.status, status);
    }
    // Other JSON routes keep the 300 KB cap even for image bytes.
    r = await fetch(base + `/v1/admin/catalog/branches/${branch}/publish`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'image/jpeg', 'Idempotency-Key': key },
      body: Buffer.alloc(10),
    });
    assert.equal(r.status, 415);
    assert.equal(received.length, count);

    // Media: GET only, strict names, no credential forwarded, WebP only, size capped.
    r = await fetch(base + photo, { headers: { ...auth, Cookie: 'a=b' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/webp');
    assert.match(r.headers.get('content-security-policy'), /img-src 'self'/);
    assert.equal(Buffer.from(await r.arrayBuffer()).equals(webp), true);
    const forwarded = received.at(-1);
    assert.equal(forwarded.url, photo);
    assert.equal(forwarded.headers.authorization, undefined);
    assert.equal(forwarded.headers.cookie, undefined);
    count = received.length;
    for (const [method, path] of [
      ['POST', photo],
      ['PUT', photo],
      ['DELETE', photo],
      ['GET', `/v1/media/catalog/${sha.toUpperCase()}.card.webp`],
      ['GET', `/v1/media/catalog/${sha}.jpg`],
      ['GET', `/v1/media/catalog/${sha}.full.webp`],
      ['GET', `/v1/media/catalog/${sha.slice(1)}.webp`],
      ['GET', photo + '?x=1'],
      ['GET', `/v1/media/catalog/../admin/catalog/branches`],
      ['GET', `/v1/media/other/${sha}.webp`],
    ]) {
      r = await fetch(base + path, { method });
      assert.equal(r.status, 404, `${method} ${path}`);
      await r.arrayBuffer();
    }
    assert.equal(received.length, count);
    media = () => ({ status: 200, type: 'text/html', body: '<script>1</script>' });
    r = await fetch(base + photo);
    assert.equal(r.status, 404);
    media = () => ({ status: 404, type: 'application/json', body: '{}' });
    assert.equal((await fetch(base + photo)).status, 404);
    media = () => ({ status: 200, type: 'image/webp', body: Buffer.alloc(1500001), length: true });
    assert.equal((await fetch(base + photo)).status, 404);
    media = () => ({ status: 200, type: 'image/webp', body: Buffer.alloc(1500001) });
    assert.equal((await fetch(base + photo)).status, 502);
  } finally {
    await Promise.all([
      new Promise((resolve) => ui.close(resolve)),
      new Promise((resolve) => api.close(resolve)),
    ]);
  }
});

test('staff mode: photo bytes and uploads need the staff session; the bearer stays on the server', async () => {
  const { createStaffAccess, passwordHash } = await import('../../apps/backoffice/staff-auth.mjs');
  const { request } = await import('node:http');
  const password = 'Synthetic-fixture-password-2026';
  const origin = 'https://pickchick.example';
  const staffToken = 'c'.repeat(64);
  const received = [];
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  const api = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, headers: req.headers, size: Buffer.concat(chunks).length });
    if (req.url.startsWith('/v1/media/')) {
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': webp.length });
      res.end(webp);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const ui = createBackofficeServer({
    apiPort: api.address().port,
    staffAccess: createStaffAccess({
      version: 1,
      username: 'ceo',
      origin,
      token: staffToken,
      ...(await passwordHash(password)),
    }),
    staticPrefix: '/backoffice',
  });
  ui.listen(0, '127.0.0.1');
  await once(ui, 'listening');
  const call = (path, { method = 'GET', cookie, headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const r = request(
        {
          host: '127.0.0.1',
          port: ui.address().port,
          path,
          method,
          headers: { host: 'pickchick.example', origin, ...(cookie ? { cookie } : {}), ...headers },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      r.on('error', reject);
      r.end(body);
    });
  try {
    const photo = `/v1/media/catalog/${sha}.card.webp`;
    assert.equal((await call('/backoffice/api' + photo)).status, 401);
    assert.equal((await call(photo)).status, 404);
    assert.equal(received.length, 0);
    const login = await call('/backoffice/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ceo', password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const media = await call('/backoffice/api' + photo, { cookie });
    assert.equal(media.status, 200);
    assert.equal(media.headers['content-type'], 'image/webp');
    assert.equal(media.body.equals(webp), true);
    assert.equal(received.at(-1).url, photo);
    assert.equal(received.at(-1).headers.authorization, undefined);
    const key = randomUUID();
    const upload = await call(`/backoffice/api/v1/admin/catalog/branches/${branch}/assets`, {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'image/png', 'idempotency-key': key },
      body: Buffer.alloc(1024, 1),
    });
    assert.equal(upload.status, 200);
    assert.equal(received.at(-1).headers.authorization, 'Bearer ' + staffToken);
    assert.equal(received.at(-1).headers['idempotency-key'], key);
    assert.equal(received.at(-1).size, 1024);
    const stops = await call(`/backoffice/api/v1/admin/backoffice/branches/${branch}/stops`, {
      cookie,
    });
    assert.equal(stops.status, 200);
    // A cross-origin upload is refused before any byte reaches the API.
    const before = received.length;
    const foreign = await call(`/backoffice/api/v1/admin/catalog/branches/${branch}/assets`, {
      method: 'POST',
      cookie,
      headers: {
        origin: 'https://evil.example',
        'content-type': 'image/png',
        'idempotency-key': key,
      },
      body: Buffer.alloc(16),
    });
    assert.equal(foreign.status, 403);
    assert.equal(received.length, before);
  } finally {
    ui.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => ui.close(resolve)),
      new Promise((resolve) => api.close(resolve)),
    ]);
  }
});
