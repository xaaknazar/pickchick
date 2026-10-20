import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PhotoController } from '../../apps/kiosk/src/photobooth/controller.ts';
import { photoErrorCode } from '../../apps/kiosk/src/photobooth/errors.ts';
function fixture(overrides = {}) {
  let pending = null;
  const calls = [];
  const preview = {
    id: randomUUID(),
    png: 'synthetic-png',
    width: 576,
    height: 600,
    locale: 'ru',
    expiresAt: Date.now() + 90000,
  };
  const io = {
    readConfig: async () => ({ url: 'https://photo.example', token: 'a'.repeat(64) }),
    writeConfig: async () => {},
    readPending: async () => pending,
    writePending: async (value) => {
      pending = value;
    },
    uuid: randomUUID,
    now: Date.now,
    request: async (c, path, body, method) => {
      calls.push({ path, body, method });
      if (path === '/v1/status') return { printingEnabled: true };
      if (path === '/v1/previews') return Object.assign(preview, { locale: body.locale });
      if (path === '/v1/jobs') {
        assert.equal(body.id, pending);
        return { ...body, state: 'sent' };
      }
      if (path.startsWith('/v1/jobs/'))
        return { id: pending, previewId: preview.id, state: 'sent' };
      return {};
    },
    ...overrides,
  };
  return { controller: new PhotoController(io), io, preview, calls, pending: () => pending };
}
async function capture(f, locale = 'ru') {
  await f.controller.init();
  f.controller.camera();
  await f.controller.captured('encoded', 'temporary', () => {}, locale);
}
test('the guest language reaches the preview and a wrong-language response cannot be printed', async () => {
  for (const locale of ['ru', 'kk', 'en']) {
    const f = fixture();
    await capture(f, locale);
    assert.equal(f.calls.find((c) => c.path === '/v1/previews').body.locale, locale);
    assert.equal(f.controller.state.preview.locale, locale);
    f.controller.dispose();
  }
  const f = fixture();
  const request = f.io.request;
  f.io.request = async (c, path, body, method) => {
    const response = await request(c, path, body, method);
    return path === '/v1/previews' ? { ...response, locale: 'en' } : response;
  };
  await capture(f, 'kk');
  assert.equal(f.controller.state.preview, null);
  await f.controller.print();
  assert.equal(f.calls.filter((c) => c.path === '/v1/jobs').length, 0);
  f.controller.dispose();
});
test('double tap persists the request before one print, without touching ordering APIs', async () => {
  const f = fixture();
  await capture(f);
  await Promise.all([f.controller.print(), f.controller.print()]);
  assert.equal(f.calls.filter((c) => c.path === '/v1/jobs').length, 1);
  assert.equal(f.controller.state.job.state, 'sent');
  assert(f.calls.every((c) => c.path.startsWith('/v1/')));
  f.controller.dispose();
});
test('lost response and restart reconcile by GET only', async () => {
  const f = fixture();
  const request = f.io.request;
  f.io.request = async (c, p, b, m) => {
    if (p === '/v1/jobs') {
      await request(c, p, b, m);
      throw Error('timeout');
    }
    return request(c, p, b, m);
  };
  await capture(f);
  await f.controller.print();
  assert.equal(f.controller.state.error, 'UNKNOWN');
  await f.controller.print();
  assert.equal(f.calls.filter((c) => c.path === '/v1/jobs').length, 1);
  const restored = new PhotoController(f.io);
  await restored.init();
  // Reconciled by GET only; the final result belongs to the previous visit (finding 3.8): it is
  // acknowledged and the booth opens fresh for the next guest.
  assert.ok(f.calls.some((c) => c.path.startsWith('/v1/jobs/') && !c.body));
  assert.equal(restored.state.phase, 'intro');
  assert.equal(restored.state.job, null);
  assert.equal(f.pending(), null);
  assert.equal(f.calls.filter((c) => c.path === '/v1/jobs').length, 1);
  f.controller.dispose();
  restored.dispose();
});
test('storage failure does not dispatch a print and an expired preview cannot print', async () => {
  const f = fixture({
    writePending: async () => {
      throw Error('storage');
    },
  });
  await capture(f);
  await f.controller.print();
  assert.equal(f.controller.state.error, 'STORAGE');
  assert.equal(f.calls.filter((c) => c.path === '/v1/jobs').length, 0);
  f.preview.expiresAt = 0;
  await f.controller.print();
  assert.equal(f.controller.state.error, 'PREVIEW_EXPIRED');
  f.controller.dispose();
});
test('late preview after exit is deleted and never shown; original is disposed', async () => {
  const f = fixture();
  await f.controller.init();
  f.controller.camera();
  let resolve;
  let disposed = 0;
  const original = f.io.request;
  f.io.request = (c, p, b, m) =>
    p === '/v1/previews'
      ? new Promise((r) => {
          resolve = r;
        })
      : original(c, p, b, m);
  const capture = f.controller.captured('encoded', 'temporary', () => {
    disposed++;
  });
  f.controller.dispose();
  resolve(f.preview);
  await capture;
  assert.equal(f.controller.state.preview, null);
  assert(disposed >= 1);
  assert(f.calls.some((c) => c.method === 'DELETE' && c.path.endsWith(f.preview.id)));
});
test('unconfigured camera allows local preview, never sends a print or saves photograph', async () => {
  const f = fixture({ readConfig: async () => null });
  await capture(f);
  assert.equal(f.controller.state.localUri, 'temporary');
  await f.controller.print();
  assert.equal(f.calls.length, 0);
  assert.equal(f.pending(), null);
  f.controller.dispose();
  assert.equal(f.controller.state.localUri, null);
});
test('pairing rejects insecure or credential-bearing addresses before any request', async () => {
  const f = fixture();
  await f.controller.init();
  const count = f.calls.length;
  for (const url of [
    'http://192.168.3.33:13440',
    'https://user:pass@photo.example',
    'https://photo.example/path',
    'https://photo.example/?token=secret',
  ])
    await f.controller.connect(url, '123456');
  assert.equal(f.calls.length, count);
  assert.equal(f.controller.state.error, 'PAIRING');
  f.controller.dispose();
});

test('only the provisioned restaurant HTTPS origin can receive photos or pairing codes', async () => {
  const { approvedEndpoint } = await import('../../apps/kiosk/src/photobooth/endpoint.ts');
  const allowed = 'https://photo.example.test:13440';
  assert.equal(approvedEndpoint(allowed + '/', allowed), true);
  for (const other of [
    'https://guest.example.test:13440',
    'http://photo.example.test:13440',
    'https://photo.example.test:13441',
    allowed + '/upload',
    allowed + '?redirect=elsewhere',
    'https://user:pass@photo.example.test:13440',
  ])
    assert.equal(approvedEndpoint(other, allowed), false);
  assert.equal(approvedEndpoint(allowed, undefined), false);
});

test('automatic return clears the photo only after sent; ambiguous and failed jobs stay visible', async () => {
  const f = fixture();
  await capture(f);
  assert.equal(await f.controller.finishIfSent(), false);
  await f.controller.print();
  const job = f.controller.state.job;
  for (const state of ['sending', 'unknown', 'failed']) {
    f.controller.state = { ...f.controller.state, job: { ...job, state } };
    assert.equal(await f.controller.finishIfSent(), false);
    assert(f.pending());
    assert(f.controller.state.preview);
  }
  f.controller.state = { ...f.controller.state, job };
  assert.equal(await f.controller.finishIfSent(), true);
  assert.equal(f.pending(), null);
  assert.equal(f.controller.state.preview, null);
  f.controller.dispose();
});

test('failed session cleanup after sending never claims the print did not start', async () => {
  const f = fixture();
  const write = f.io.writePending;
  f.io.writePending = async (id) => {
    if (id === null) throw Error('storage');
    await write(id);
  };
  await capture(f);
  await f.controller.print();
  assert.equal(await f.controller.finishIfSent(), false);
  assert.equal(f.controller.state.job.state, 'sent');
  assert.equal(f.controller.state.error, 'CLEANUP');
  assert(f.pending());
  f.controller.dispose();
});

// Audit 19.10, finding 3.8 (1): NOT_CONFIGURED comes with 503 and means nothing was printed.
test('a known refusal is read at any status; other server errors stay ambiguous', () => {
  assert.equal(photoErrorCode(503, { code: 'NOT_CONFIGURED' }), 'NOT_CONFIGURED');
  assert.equal(photoErrorCode(503, { code: 'PRINTER_DOWN' }), 'CONNECTION');
  assert.equal(photoErrorCode(500, {}), 'CONNECTION');
  assert.equal(photoErrorCode(429, { code: 'BUSY' }), 'BUSY');
  assert.equal(photoErrorCode(404, { code: 'NOT_FOUND' }), 'NOT_FOUND');
  assert.equal(photoErrorCode(409, { code: 'bad code' }), 'CONNECTION');
  assert.equal(photoErrorCode(409, null), 'CONNECTION');
});
test('NOT_CONFIGURED shows «печать недоступна» and keeps no pending job', async () => {
  const f = fixture();
  const request = f.io.request;
  f.io.request = async (c, p, b, m) => {
    if (p === '/v1/jobs') throw Error(photoErrorCode(503, { code: 'NOT_CONFIGURED' }));
    return request(c, p, b, m);
  };
  await capture(f);
  await f.controller.print();
  assert.equal(f.controller.state.error, 'NOT_CONFIGURED');
  assert.equal(f.controller.state.phase, 'preview');
  assert.equal(f.controller.state.printingEnabled, false);
  assert.equal(f.pending(), null);
  f.controller.dispose();
});
// Finding 3.8 (2): the booth closed by its 60 s timeout or the app going to the background.
test('the next guest never sees the previous guest result', async () => {
  for (const state of ['sent', 'failed']) {
    const f = fixture();
    const request = f.io.request;
    f.io.request = async (c, p, b, m) => {
      const answer = await request(c, p, b, m);
      return p.startsWith('/v1/jobs') ? { ...answer, state } : answer;
    };
    await capture(f);
    await f.controller.print();
    assert.equal(f.controller.state.job.state, state);
    // Closed by itself, without «Назад»: the final result is acknowledged.
    await f.controller.close();
    assert.equal(f.pending(), null, state);
    const next = new PhotoController(f.io);
    await next.init();
    assert.equal(next.state.phase, 'intro', state);
    assert.equal(next.state.job, null, state);
    assert.equal(await next.finishIfSent(), false, state);
    next.dispose();
    f.controller.dispose();
  }
});
test('a previous guest final result left by a crash is acknowledged when the booth opens', async () => {
  const f = fixture();
  await capture(f);
  await f.controller.print();
  // The app died before the booth closed: the pending job stays stored.
  assert.ok(f.pending());
  const next = new PhotoController(f.io);
  await next.init();
  assert.equal(next.state.phase, 'intro');
  assert.equal(next.state.job, null);
  assert.equal(f.pending(), null);
  assert.equal(f.calls.filter((c) => c.path === '/v1/jobs').length, 1);
  next.dispose();
});
test('an ambiguous job survives an automatic close and still blocks a second print', async () => {
  const f = fixture();
  const request = f.io.request;
  f.io.request = async (c, p, b, m) => {
    const answer = await request(c, p, b, m);
    return p.startsWith('/v1/jobs') ? { ...answer, state: 'unknown' } : answer;
  };
  await capture(f);
  await f.controller.print();
  await f.controller.close();
  assert.ok(f.pending());
  const next = new PhotoController(f.io);
  await next.init();
  assert.equal(next.state.phase, 'result');
  assert.equal(next.state.job.state, 'unknown');
  next.dispose();
});
test('a job the service never received is not pending for ever', async () => {
  const f = fixture();
  const request = f.io.request;
  let lost = true;
  f.io.request = async (c, p, b, m) => {
    if (p === '/v1/jobs' && lost) throw Error('timeout');
    if (p.startsWith('/v1/jobs/')) throw Error('NOT_FOUND');
    return request(c, p, b, m);
  };
  await capture(f);
  await f.controller.print();
  assert.equal(f.controller.state.error, 'UNKNOWN');
  await f.controller.check();
  assert.equal(f.pending(), null);
  assert.equal(f.controller.state.phase, 'preview');
  lost = false;
  await f.controller.print();
  assert.equal(f.controller.state.job.state, 'sent');
  f.controller.dispose();
});
// Finding 3.6: no exit from the guest flow to iOS Settings.
test('the photo camera never opens iOS Settings', () => {
  const source = readFileSync(
    new URL('../../apps/kiosk/src/components/PhotoCamera.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /openSettings|Linking/);
  assert.match(source, /permissionStaff/);
});
