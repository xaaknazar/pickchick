import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { transport } from '../../apps/backoffice/dist/api.js';

test('public backoffice transport rejects false revocation and limits streamed JSON without credentials in URLs', async () => {
  const original = globalThis.fetch;
  const token = 'a'.repeat(64);
  try {
    globalThis.fetch = async (path, options) => {
      assert.equal(path, '/v1/admin/catalog/branches');
      assert.equal(options.headers.Authorization, 'Bearer ' + token);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      return Response.json({ code: 'UNAUTHORIZED' }, { status: 401 });
    };
    await assert.rejects(transport('branches', token), (e) => e.code === 'INVALID_RESPONSE');
    await assert.rejects(
      transport('branches?secret=' + token, token),
      (e) => e.code === 'INVALID_REQUEST',
    );
    globalThis.fetch = async () =>
      Response.json(
        {
          code: 'UNAUTHORIZED',
          message_key: 'errors.unauthorized',
          trace_id: randomUUID(),
          retryable: false,
        },
        { status: 401 },
      );
    await assert.rejects(transport('branches', token), (e) => e.code === 'UNAUTHORIZED');
    let reads = 0;
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            reads++;
            controller.enqueue(new Uint8Array(524288));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    await assert.rejects(transport('branches', token), (e) => e.code === 'INVALID_RESPONSE');
    assert.ok(reads <= 4);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = original;
  }
});
