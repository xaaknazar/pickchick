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

test('director transport accepts calendar filters while rejecting unknown or duplicate parameters before fetch', async () => {
  const original = globalThis.fetch;
  const paths = [];
  const branch = '10000000-0000-4000-8000-000000000003';
  const path = `operations/branches/${branch}`;
  const token = 'a'.repeat(64);
  try {
    globalThis.fetch = async (url) => {
      paths.push(url);
      return Response.json({ ok: true });
    };
    for (const query of [
      '',
      '?period=today',
      '?period=yesterday',
      '?period=year',
      '?period=week',
      '?period=month',
      '?period=quarter',
      '?period=custom&start_date=2024-02-29&end_date=2024-03-01',
      `?shift_id=${branch}&period=day`,
    ]) {
      assert.deepEqual(await transport(path + query, token), { ok: true });
      assert.equal(paths.at(-1), `/v1/admin/backoffice/branches/${branch}` + query);
    }
    const before = paths.length;
    for (const query of [
      '?period=year&period=day',
      '?period=year&%70eriod=day',
      '?period=all',
      '?secret=bad',
      '?period=custom',
      '?period=day&start_date=2026-01-01',
      '?period=custom&start_date=2026-02-30&end_date=2026-03-01',
      '?period=custom&start_date=2026-03-02&end_date=2026-03-01',
      '?period=custom&start_date=2024-01-01&end_date=2026-01-01',
      '?shift_id=bad',
      '?period=year?bad=1',
    ])
      await assert.rejects(transport(path + query, token), (e) => e.code === 'INVALID_REQUEST');
    assert.equal(paths.length, before);
  } finally {
    globalThis.fetch = original;
  }
});
