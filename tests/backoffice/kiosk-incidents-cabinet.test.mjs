// Release audit 19.10.2026, finding 4.3: a manager releases a kiosk stuck on an unknown QR
// payment from the cabinet. Proxy allow-list, client path guard and the cabinet model; the server
// rules are covered by packages/backoffice-core/tests/kiosk-incidents.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { allowed } from '../../apps/backoffice/server.mjs';
import { ApiError, allowedPath } from '../../apps/backoffice/dist/api.js';
import {
  KioskIncidentsModel,
  incidentAdvice,
  incidentAgeMinutes,
  parseIncidents,
  tenge,
} from '../../apps/backoffice/dist/kiosk-incidents-model.js';

const branch = randomUUID();
const candidate = (operation = true) => ({
  order_id: randomUUID(),
  attempt_id: randomUUID(),
  total_minor: '419000',
  order_state: 'sending',
  attempt_state: 'unknown',
  qr_state: 'unknown',
  has_operation_id: operation,
  issue_started_at: new Date(Date.now() - 20 * 60000).toISOString(),
  created_at: new Date(Date.now() - 21 * 60000).toISOString(),
});
const list = (role = 'manager', candidates = [candidate()]) => ({
  role,
  min_age_minutes: 15,
  candidates,
  accepted: [],
});

test('the cabinet proxy and client allow exactly the incident list and decision', () => {
  const path = `/v1/admin/backoffice/branches/${branch}/kiosk-payment-incidents`;
  assert.equal(allowed('GET', path), true);
  assert.equal(allowed('POST', path), true);
  for (const [method, other] of [
    ['PUT', path],
    ['GET', path + '?all=1'],
    ['GET', path + '/x'],
    ['POST', `/v1/admin/backoffice/branches/not-a-uuid/kiosk-payment-incidents`],
  ])
    assert.equal(allowed(method, other), false, method + ' ' + other);
  assert.equal(allowedPath(`operations/branches/${branch}/kiosk-payment-incidents`), true);
  assert.equal(allowedPath(`operations/branches/${branch}/kiosk-payment-incidents?x=1`), false);
});

test('a decision sends the explicit confirmation and the Kaspi finding, never a payment state', async () => {
  const calls = [];
  const c = candidate(false);
  const model = new KioskIncidentsModel(
    async (path, request) => {
      calls.push({ path, request });
      if (!request) return list('manager', calls.length > 1 ? [] : [c]);
      return { kiosk: 'session_end_allowed', incident: {} };
    },
    () => {},
  );
  await model.load(randomUUID(), branch);
  assert.equal(model.data.candidates.length, 1);
  assert.equal(await model.accept(c, 'payment_found', '  Гость ушёл, оплата есть  '), true);
  const post = calls.find((call) => call.request);
  assert.equal(post.path, `branches/${branch}/kiosk-payment-incidents`);
  assert.equal(post.request.method, 'POST');
  const { request_id: requestId, ...body } = post.request.body;
  assert.match(requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body, {
    order_id: c.order_id,
    attempt_id: c.attempt_id,
    reason: 'bank_identity_lost',
    note: 'Гость ушёл, оплата есть',
    confirm: 'payment_result_remains_unknown',
    kaspi_check: 'payment_found',
  });
  assert.equal(JSON.stringify(body).includes('paid'), false);
  assert.deepEqual(model.last, { order_id: c.order_id, kaspi_check: 'payment_found' });
  // The list is read again: the released kiosk is gone from it.
  assert.equal(model.data.candidates.length, 0);
});

test('a lost answer repeats with the same request id; analysts cannot decide', async () => {
  const c = candidate();
  const bodies = [];
  let fail = true;
  const model = new KioskIncidentsModel(
    async (path, request) => {
      if (!request) return list('manager', [c]);
      bodies.push(request.body);
      if (fail) throw new ApiError('NETWORK', 0);
      return { kiosk: 'session_end_allowed' };
    },
    () => {},
  );
  await model.load(randomUUID(), branch);
  assert.equal(await model.accept(c, 'payment_not_found', 'Оплаты нет'), false);
  assert.equal(model.uncertain, true);
  fail = false;
  assert.equal(await model.accept(c, 'payment_not_found', 'Оплаты нет'), true);
  assert.equal(bodies[0].request_id, bodies[1].request_id);
  assert.equal(bodies[0].reason, 'bank_result_unknown');
  const analyst = new KioskIncidentsModel(
    async () => list('analyst'),
    () => {},
  );
  await analyst.load(randomUUID(), branch);
  await assert.rejects(analyst.accept(c, 'payment_not_found', 'Оплаты нет'), {
    code: 'FORBIDDEN',
  });
});

// Review 19.10: the Kaspi Pay finding is never assumed; nothing is sent without it.
test('a decision without an explicit Kaspi Pay finding is never sent', async () => {
  const c = candidate();
  const posts = [];
  const model = new KioskIncidentsModel(
    async (path, request) => {
      if (request) posts.push(request);
      return request ? { kiosk: 'session_end_allowed' } : list('manager', [c]);
    },
    () => {},
  );
  await model.load(randomUUID(), branch);
  for (const check of ['', undefined, 'paid'])
    await assert.rejects(model.accept(c, check, 'Проверено'), { code: 'INVALID_REQUEST' });
  assert.equal(posts.length, 0);
  const view = readFileSync(
    new URL('../../apps/backoffice/src/components/KioskIncidentsView.ts', import.meta.url),
    'utf8',
  );
  assert.match(view, /let kaspi: KaspiCheck \| '' = ''/);
  assert.match(view, /if \(!kaspi \|\|/);
});

test('responses are checked and the staff texts are plain and honest', () => {
  assert.throws(() => parseIncidents({ ...list(), role: 'owner' }));
  assert.throws(() => parseIncidents({ ...list(), candidates: [{ order_id: 'x' }] }));
  assert.equal(tenge('419000'), '4 190 ₸');
  assert.equal(incidentAgeMinutes(candidate(), Date.now()), 20);
  for (const check of ['payment_found', 'payment_not_found']) {
    const text = incidentAdvice(check);
    assert.doesNotMatch(text, /[–—]/);
    assert.match(text, /сверк|привяжется/);
  }
});
