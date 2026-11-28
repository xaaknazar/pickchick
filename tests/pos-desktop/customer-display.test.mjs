import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOMER_ASSETS,
  CUSTOMER_URL,
  createCustomerHandler,
  isAllowedCustomerURL,
  pickCustomerDisplay,
  validateCustomerView,
} from '../../apps/pos-desktop/customer-display.mjs';
import { V2_ASSETS } from '../../apps/pos-desktop/v2-assets.mjs';
import { validateConfig } from '../../apps/pos-desktop/protocol.mjs';

const order = {
  kind: 'order',
  mode: 'take',
  total_minor: '459000',
  lines: [
    { name: 'Комбо Чикен', qty: 1, sum_minor: '329000', mods: 'Кола · Сырный соус' },
    { name: 'Картофель фри', qty: 2, sum_minor: '130000' },
  ],
};

test('the guest screen goes on the first display that is not the cashier one', () => {
  const primary = { id: 1, bounds: { x: 0, y: 0, width: 1366, height: 768 } };
  const second = { id: 7, bounds: { x: 1366, y: 0, width: 1024, height: 600 } };
  assert.equal(pickCustomerDisplay([primary], primary), null);
  assert.equal(pickCustomerDisplay([primary, second], primary), second);
  assert.equal(pickCustomerDisplay([second, primary], primary), second);
  assert.equal(pickCustomerDisplay([primary, second], primary, { customerDisplay: false }), null);
  assert.equal(pickCustomerDisplay(null, primary), null);
});

test('config accepts only a boolean customerDisplay', () => {
  assert.equal(validateConfig({ customerDisplay: false }).customerDisplay, false);
  assert.equal(validateConfig({}).customerDisplay, undefined);
  assert.throws(() => validateConfig({ customerDisplay: 'off' }), /INVALID_POS_CONFIG/);
});

test('views are copied exactly and anything else is refused', () => {
  assert.deepEqual(validateCustomerView({ kind: 'idle' }), { kind: 'idle' });
  assert.deepEqual(validateCustomerView(order), order);
  assert.deepEqual(
    validateCustomerView({
      ...order,
      kind: 'pay',
      method: 'cash',
      tendered_minor: '500000',
      change_minor: '41000',
    }).change_minor,
    '41000',
  );
  assert.deepEqual(validateCustomerView({ kind: 'done', number: '42', total_minor: '459000' }), {
    kind: 'done',
    number: '42',
    total_minor: '459000',
  });
  for (const bad of [
    null,
    [],
    { kind: 'idle', extra: 1 },
    { kind: 'other' },
    { ...order, method: 'cash' },
    { ...order, total_minor: '-1' },
    { ...order, total_minor: 100 },
    { ...order, lines: [{ name: 'x', qty: 0, sum_minor: '1' }] },
    { ...order, lines: [{ name: 'x', qty: 1, sum_minor: '1', html: '<b>' }] },
    { ...order, lines: [{ name: 'x'.repeat(81), qty: 1, sum_minor: '1' }] },
    { ...order, lines: Array(61).fill({ name: 'x', qty: 1, sum_minor: '1' }) },
    { ...order, kind: 'pay', method: 'bitcoin' },
    { kind: 'done', number: '1'.repeat(13), total_minor: '1' },
    { kind: 'done', number: '1' },
  ])
    assert.throws(() => validateCustomerView(bad), /INVALID_CUSTOMER_VIEW/, JSON.stringify(bad));
});

test('the customer window loads only its own fixed assets', async () => {
  assert.equal(isAllowedCustomerURL(CUSTOMER_URL), true);
  for (const url of [
    'pickchick-pos://app/',
    'pickchick-pos://app/config.json',
    'pickchick-pos://app/api/pos/session',
    'pickchick-pos://app/customer.html?x=1',
    'pickchick-pos://other/customer.html',
    'https://pickchick.kz/customer.html',
    'not a url',
  ])
    assert.equal(isAllowedCustomerURL(url), false, url);
  const shipped = new Set(V2_ASSETS.map(([name]) => name));
  for (const [file] of CUSTOMER_ASSETS.values()) assert.ok(shipped.has(file), file);
  const handler = createCustomerHandler({
    assetDir: new URL('../../apps/pos/src/', import.meta.url),
  });
  const page = await handler(new Request(CUSTOMER_URL));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Security-Policy'), /connect-src 'none'/);
  assert.match(await page.text(), /customer\.js/);
  assert.equal((await handler(new Request('pickchick-pos://app/config.json'))).status, 404);
  assert.equal(
    (await handler(new Request(CUSTOMER_URL, { method: 'POST', body: 'x' }))).status,
    404,
  );
});
