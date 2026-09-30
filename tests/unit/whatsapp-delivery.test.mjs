import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadableStream } from 'node:stream/web';
import { inspect } from 'node:util';
import {
  WhatsAppCodeDelivery,
  createPhoneCodeDelivery,
} from '../../packages/phone-verification/dist/index.js';

// Synthetic numbers/credentials; every transport is injected. No messages are sent.
const input = { phoneE164: '+77' + '0'.repeat(9), code: '123456' };
const config = {
  accessToken: 'synthetic-token',
  phoneNumberId: '123',
  apiVersion: 'v25.0',
  approvedTemplate: 'pickchick_login',
  language: 'ru',
};
const success = () => ({
  messaging_product: 'whatsapp',
  contacts: [{ input: input.phoneE164.slice(1), wa_id: input.phoneE164.slice(1) }],
  messages: [{ id: 'wamid.synthetic_123=' }],
});
const unknown = { kind: 'unknown', reason: 'response' };

test('WhatsApp sends a single approved copy-code template with bearer credentials and no redirects', async () => {
  let calls = 0;
  const adapter = new WhatsAppCodeDelivery(config, async (url, options) => {
    calls++;
    assert.equal(url, 'https://graph.facebook.com/v25.0/123/messages');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, `Bearer ${config.accessToken}`);
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.to, input.phoneE164.slice(1));
    assert.equal(body.messaging_product, 'whatsapp');
    assert.equal(body.type, 'template');
    assert.equal(body.template.name, config.approvedTemplate);
    assert.equal(body.template.language.code, 'ru');
    assert.deepEqual(body.template.components, [
      { type: 'body', parameters: [{ type: 'text', text: input.code }] },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: input.code }],
      },
    ]);
    assert.ok(!options.body.includes(config.accessToken));
    return Response.json(success());
  });
  assert.deepEqual(await adapter.sendCode(input), {
    kind: 'submitted',
    provider: 'whatsapp_cloud',
    submission: 'accepted',
    messageId: 'wamid.synthetic_123=',
  });
  assert.equal(calls, 1);
  assert.ok(!inspect(adapter, { showHidden: true }).includes(config.accessToken));
});

test('WhatsApp remains unavailable in public factory until account, channel contract and consent are ready', () => {
  assert.equal(createPhoneCodeDelivery().provider, 'disabled');
  assert.throws(
    () => createPhoneCodeDelivery({ PHONE_DELIVERY_PROVIDER: 'whatsapp_cloud' }),
    /PHONE_DELIVERY_CONFIGURATION_INVALID/,
  );
});

test('WhatsApp rejects malformed configuration and input before any network request', async () => {
  for (const patch of [
    { accessToken: 'x\nAuthorization: y' },
    { accessToken: 'token\n' },
    { phoneNumberId: '123\n' },
    { apiVersion: 'v25.0/../../other' },
    { phoneNumberId: '123?token=x' },
    { approvedTemplate: '../other' },
    { language: 'ru/../' },
    { endpoint: 'https://example.com' },
  ]) {
    assert.throws(
      () => new WhatsAppCodeDelivery({ ...config, ...patch }),
      /PHONE_DELIVERY_CONFIGURATION_INVALID/,
    );
  }
  let calls = 0;
  const adapter = new WhatsAppCodeDelivery(config, async () => {
    calls++;
    return Response.json(success());
  });
  for (const value of [
    null,
    {},
    { ...input, code: '12345' },
    { ...input, phoneE164: '+123' },
    { ...input, text: 'arbitrary message' },
  ]) {
    assert.deepEqual(await adapter.sendCode(value), { kind: 'rejected', reason: 'invalid_input' });
  }
  assert.equal(calls, 0);
});

test('WhatsApp does not accept mismatched recipients, incomplete messages, errors or HTTP failures as submission', async () => {
  const wrong = success();
  wrong.contacts[0].input = '123';
  const held = success();
  held.messages[0].message_status = 'held_for_quality_assessment';
  const variants = [
    Response.json(wrong),
    Response.json(held),
    Response.json({ ...success(), messages: [] }),
    Response.json({ ...success(), error: { message: input.code } }),
    Response.json(success(), { status: 401 }),
    Response.json(success(), { status: 500 }),
    new Response('<html>proxy error</html>'),
    Response.json(success(), { status: 302 }),
    new Response('x'.repeat(16 * 1024 + 1)),
    new Response('{}', { headers: { 'content-length': '999999' } }),
    new Response(new Uint8Array([0xff, 0xfe])),
  ];
  for (const response of variants) {
    let calls = 0;
    const adapter = new WhatsAppCodeDelivery(config, async () => {
      calls++;
      return response;
    });
    assert.deepEqual(await adapter.sendCode(input), unknown);
    assert.equal(calls, 1);
  }
});

test('WhatsApp handles transport failure without retry, SMS fallback or leaking raw errors', async () => {
  let calls = 0;
  const adapter = new WhatsAppCodeDelivery(config, async () => {
    calls++;
    throw new Error(`${config.accessToken} ${input.phoneE164} ${input.code}`);
  });
  assert.deepEqual(await adapter.sendCode(input), { kind: 'unknown', reason: 'network' });
  assert.equal(calls, 1);
});

test('WhatsApp bounds both a hung fetch and hung response stream even if cancellation is ignored', async () => {
  const implementations = [
    () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })),
  ];
  await Promise.all(
    implementations.map(async (fetch) => {
      let calls = 0;
      const start = Date.now();
      const adapter = new WhatsAppCodeDelivery(config, (...args) => {
        calls++;
        return fetch(...args);
      });
      assert.deepEqual(await adapter.sendCode(input), { kind: 'unknown', reason: 'timeout' });
      assert.equal(calls, 1);
      assert.ok(Date.now() - start < 8000);
    }),
  );
});
