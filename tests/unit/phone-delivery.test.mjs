import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadableStream } from 'node:stream/web';
import { URLSearchParams } from 'node:url';
import { createPhoneCodeDelivery } from '../../packages/phone-verification/dist/index.js';
import { MobizonCodeDelivery } from '../../packages/phone-verification/dist/mobizon.js';

// Synthetic adapter fixtures only. All transports are injected; no real SMS.
const input = { phoneE164: '+77' + '0'.repeat(9), code: '123456' };
const env = {
  PHONE_DELIVERY_PROVIDER: 'mobizon',
  MOBIZON_API_KEY: 'synthetic-fixture-key',
  MOBIZON_APPROVED_SENDER: 'PickChick',
};
const success = { code: 0, data: { messageId: 42, campaignId: 84, status: 2 } };
const unknown = { kind: 'unknown', reason: 'response' };
const make = (implementation = () => Response.json(success)) => {
  const calls = [];
  return {
    calls,
    adapter: createPhoneCodeDelivery(env, {
      fetch: (...args) => {
        calls.push(args);
        return implementation(...args);
      },
    }),
  };
};

test('delivery is disabled by default and cannot make HTTP calls accidentally', async () => {
  let calls = 0;
  const dependencies = {
    fetch: () => {
      calls++;
      throw new Error('unexpected HTTP');
    },
  };
  for (const configuration of [
    undefined,
    {},
    { ...env, PHONE_DELIVERY_PROVIDER: 'disabled' },
    {
      MOBIZON_API_KEY: env.MOBIZON_API_KEY,
      MOBIZON_APPROVED_SENDER: env.MOBIZON_APPROVED_SENDER,
    },
  ]) {
    const adapter = createPhoneCodeDelivery(configuration, dependencies);
    assert.equal(adapter.provider, 'disabled');
    assert.deepEqual(await adapter.sendCode(input), { kind: 'disabled' });
  }
  assert.equal(calls, 0);
});

test('configuration fails closed with static errors and no credential exposure', () => {
  const configurations = [
    { ...env, PHONE_DELIVERY_PROVIDER: 'automatic' },
    { ...env, PHONE_DELIVERY_PROVIDER: '' },
    { ...env, MOBIZON_API_KEY: '' },
    { ...env, MOBIZON_API_KEY: 'bad\nfixture' },
    { ...env, MOBIZON_API_KEY: ' leading-fixture' },
    { ...env, MOBIZON_APPROVED_SENDER: '' },
    { ...env, MOBIZON_APPROVED_SENDER: 'PickChick\r' },
    { PHONE_DELIVERY_PROVIDER: 'mobizon' },
  ];
  for (const configuration of configurations) {
    assert.throws(
      () =>
        createPhoneCodeDelivery(configuration, {
          fetch: () => {
            throw new Error('no HTTP');
          },
        }),
      (error) => {
        assert.equal(error.message, 'PHONE_DELIVERY_CONFIGURATION_INVALID');
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
  assert.throws(
    () =>
      new MobizonCodeDelivery(
        {
          apiKey: env.MOBIZON_API_KEY,
          approvedSender: 'PickChick',
          endpoint: 'https://example.invalid',
        },
        () => {},
      ),
    /PHONE_DELIVERY_CONFIGURATION_INVALID/,
  );
  const { adapter } = make();
  assert.equal(JSON.stringify(adapter).includes(env.MOBIZON_API_KEY), false);
  assert.equal(JSON.stringify(adapter).includes(input.code), false);
});

test('one fixed HTTPS POST uses only form body credentials and a single UCS-2 SMS', async () => {
  const { adapter, calls } = make();
  assert.deepEqual(await adapter.sendCode(input), {
    kind: 'submitted',
    provider: 'mobizon',
    submission: 'accepted',
    messageId: '42',
    campaignId: '84',
  });
  assert.equal(calls.length, 1);
  const [target, options] = calls[0];
  assert.equal(target, 'https://api.mobizon.kz/service/message/sendSmsMessage');
  assert.equal(new URL(target).search, '');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert(options.signal instanceof AbortSignal);
  assert.match(options.headers['Content-Type'], /^application\/x-www-form-urlencoded/);
  assert(!JSON.stringify(options.headers).includes(env.MOBIZON_API_KEY));
  const body = new URLSearchParams(options.body);
  assert.deepEqual([...body.keys()].sort(), [
    'api',
    'apiKey',
    'from',
    'output',
    'recipient',
    'text',
  ]);
  assert.equal(body.get('apiKey'), env.MOBIZON_API_KEY);
  assert.equal(body.get('api'), 'v1');
  assert.equal(body.get('output'), 'json');
  assert.equal(body.get('from'), 'PickChick');
  assert.equal(body.get('recipient'), input.phoneE164.slice(1));
  const text = body.get('text');
  assert.equal(text, 'PickChick: код 123456. Никому не сообщайте.');
  assert(text.length <= 70);
  assert([...text].every((character) => character.codePointAt(0) <= 0xffff));
});

test('moderation and acceptance are submission states, never delivery or verification', async () => {
  for (const [status, submission] of [
    [1, 'pending_moderation'],
    [2, 'accepted'],
  ]) {
    const { adapter, calls } = make(() =>
      Response.json({
        ...success,
        data: { messageId: '18446744073709551615', campaignId: '00042', status },
      }),
    );
    assert.deepEqual(await adapter.sendCode(input), {
      kind: 'submitted',
      provider: 'mobizon',
      submission,
      messageId: '18446744073709551615',
      campaignId: '00042',
    });
    assert.equal(calls.length, 1);
  }
});

test('invalid phone, OTP, unknown fields and hostile getters are blocked before HTTP', async () => {
  const { adapter, calls } = make();
  const invalid = [
    null,
    [],
    {},
    { ...input, phoneE164: input.phoneE164.slice(1) },
    { ...input, phoneE164: '+76' + '0'.repeat(9) },
    { ...input, phoneE164: input.phoneE164 + '0' },
    { ...input, phoneE164: ' ' + input.phoneE164 },
    { ...input, phoneE164: input.phoneE164 + '\n' },
    { ...input, code: '12345' },
    { ...input, code: '1234567' },
    { ...input, code: 123456 },
    { ...input, code: '１２３４５６' },
    { ...input, code: '12345\n' },
    { ...input, code: '123456\n' },
    { ...input, text: 'arbitrary SMS' },
    {
      get phoneE164() {
        throw new Error('sensitive input');
      },
      code: input.code,
    },
  ];
  for (const value of invalid)
    assert.deepEqual(await adapter.sendCode(value), { kind: 'rejected', reason: 'invalid_input' });
  assert.equal(calls.length, 0);
});

test('strict success parsing refuses malformed fields and unsafe or lossy provider IDs', async () => {
  const invalid = [
    null,
    [],
    {},
    { code: '0', data: success.data },
    { code: 0 },
    { ...success, unexpected: true },
    { ...success, message: {} },
    { ...success, data: [] },
    { ...success, data: { ...success.data, status: '2' } },
    { ...success, data: { ...success.data, status: 3 } },
    { ...success, data: { ...success.data, unexpected: true } },
  ];
  for (const id of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '',
    '0',
    '000',
    '1e9',
    '2.5',
    '9'.repeat(21),
    '42\n',
  ]) {
    invalid.push({ ...success, data: { ...success.data, messageId: id } });
    invalid.push({ ...success, data: { ...success.data, campaignId: id } });
  }
  for (const value of invalid) {
    const { adapter, calls } = make(() => Response.json(value));
    assert.deepEqual(await adapter.sendCode(input), unknown);
    assert.equal(calls.length, 1);
  }
});

test('only explicit semantic rejection codes are rejected; uncertain codes never retry', async () => {
  for (const code of [1, 2, 4, 5, 6, 8, 9, 11, 12, 13, 14, 30, 99]) {
    const { adapter, calls } = make(() =>
      Response.json({ code, data: null, message: 'provider internal detail' }),
    );
    assert.deepEqual(await adapter.sendCode(input), {
      kind: 'rejected',
      reason: 'provider_rejected',
      providerCode: code,
    });
    assert.equal(calls.length, 1);
  }
  for (const code of [3, 10, 15, 98, 100, 999, 987654, -1]) {
    const { adapter, calls } = make(() =>
      Response.json({ code, data: { operationId: 123 }, message: 'uncertain background result' }),
    );
    assert.deepEqual(await adapter.sendCode(input), unknown);
    assert.equal(calls.length, 1);
  }
});

test('network errors and raw provider errors expose no phone, OTP, key, cause or logs', async (t) => {
  const logs = ['log', 'warn', 'error', 'debug', 'info'].map((method) =>
    t.mock.method(console, method, () => {}),
  );
  const sensitive = [input.phoneE164, input.code, env.MOBIZON_API_KEY].join(' ');
  for (const implementation of [
    () => {
      throw new Error(sensitive, { cause: new Error(sensitive) });
    },
    () => Response.json({ code: 1, data: { secret: sensitive }, message: sensitive }),
    () => Response.json({ code: 100, data: { secret: sensitive }, message: sensitive }),
  ]) {
    const { adapter, calls } = make(implementation);
    const result = await adapter.sendCode(input);
    for (const value of [input.phoneE164, input.code, env.MOBIZON_API_KEY])
      assert(!JSON.stringify(result).includes(value));
    assert.equal(result.cause, undefined);
    assert.equal(calls.length, 1);
  }
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

test('HTTP failure or redirect cannot turn success JSON into acceptance', async () => {
  for (const [status, body] of [
    [302, success],
    [401, success],
    [429, success],
    [500, success],
    [500, { code: 1, data: null }],
    [502, { code: 2, data: null }],
  ]) {
    const { adapter, calls } = make(() =>
      Response.json(body, { status, headers: { location: 'https://example.invalid/steal' } }),
    );
    assert.deepEqual(await adapter.sendCode(input), unknown);
    assert.equal(calls.length, 1);
  }
  const redirected = Response.json(success);
  Object.defineProperty(redirected, 'redirected', { value: true });
  assert.deepEqual(await make(() => redirected).adapter.sendCode(input), unknown);
  const blocked = make(() => {
    throw new TypeError('redirect mode is set to error');
  });
  assert.deepEqual(await blocked.adapter.sendCode(input), { kind: 'unknown', reason: 'network' });
  assert.equal(blocked.calls.length, 1);
});

test('bad JSON, invalid UTF-8, missing body and broken response stream are unknown', async () => {
  for (const implementation of [
    () => new Response('{"code":0,'),
    () => new Response(Uint8Array.from([0xc3, 0x28])),
    () => new Response(null, { status: 204 }),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('sensitive raw provider stream'));
          },
        }),
      ),
  ]) {
    const { adapter, calls } = make(implementation);
    assert.deepEqual(await adapter.sendCode(input), unknown);
    assert.equal(calls.length, 1);
  }
});

test('declared response over 16 KiB is cancelled without waiting for stream cancellation', async () => {
  for (const length of ['16385', '999999999999999999999', 'not-a-length']) {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    });
    const { adapter, calls } = make(
      () => new Response(body, { headers: { 'content-length': length } }),
    );
    assert.deepEqual(await adapter.sendCode(input), unknown);
    assert.equal(cancelled, true);
    assert.equal(calls.length, 1);
  }
});

test('streamed response limit counts bytes even when content-length is absent or dishonest', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('а'.repeat(8192)));
        controller.enqueue(Buffer.from('а'));
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    });
    const { adapter, calls } = make(() => new Response(body, { headers }));
    assert.deepEqual(await adapter.sendCode(input), unknown);
    assert.equal(cancelled, true);
    assert.equal(calls.length, 1);
  }
  const raw = JSON.stringify(success);
  const bounded = raw + ' '.repeat(16384 - Buffer.byteLength(raw));
  assert.equal(Buffer.byteLength(bounded), 16384);
  assert.equal((await make(() => new Response(bounded)).adapter.sendCode(input)).kind, 'submitted');
});

test('five-second deadline includes fetch even when injected network ignores abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { adapter, calls } = make(() => new Promise(() => {}));
  let settled = false;
  const pending = adapter.sendCode(input).then((result) => {
    settled = true;
    return result;
  });
  t.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { kind: 'unknown', reason: 'timeout' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].signal.aborted, true);
});

test('same five-second deadline covers partial body and a cancellation that never resolves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('{"code":0,'));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  let releaseFetch;
  const { adapter, calls } = make(
    () =>
      new Promise((resolve) => {
        releaseFetch = resolve;
      }),
  );
  let settled = false;
  const pending = adapter.sendCode(input).then((result) => {
    settled = true;
    return result;
  });
  t.mock.timers.tick(4000);
  releaseFetch(new Response(body));
  // Allow the body reader to consume its partial response and await another chunk.
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { kind: 'unknown', reason: 'timeout' });
  assert.equal(cancelled, true);
  assert.equal(calls[0][1].signal.aborted, true);
  assert.equal(calls.length, 1);
});
