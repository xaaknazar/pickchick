import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { PhotoService, handler } from '../../tools/photo-printer/service.mjs';
import { monochrome, escpos, preparePhoto } from '../../tools/photo-printer/raster.mjs';
import { sendRaster, privateIPv4 } from '../../tools/photo-printer/transport.mjs';
const require = createRequire(new URL('../../tools/photo-printer/package.json', import.meta.url));
const sharp = require('sharp');
const logoPath = resolve('apps/kiosk/assets/v3/logo.webp');
const image = await sharp({
  create: { width: 128, height: 96, channels: 3, background: '#5279ac' },
})
  .jpeg()
  .toBuffer();
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pickchick-photo-'));
  let now = 1800000000000,
    writes = 0;
  const config = {
    database: join(dir, 'jobs.sqlite'),
    logoPath,
    enabled: true,
    now: () => now,
    send: async (bytes) => {
      writes++;
      assert.equal(bytes[0], 27);
      return 'sent';
    },
    ...options,
  };
  const service = new PhotoService(config);
  t.after(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const token = service.pair(service.pairing()).token,
    device = service.authenticate(token);
  return { service, config, token, device, advance: (n) => (now += n), writes: () => writes };
}
test('dither packs black MSB-first and the print packet contains only raster/feed (cut opt-in)', () => {
  const mono = monochrome(Buffer.from([0, 255, 0, 255, 0, 255, 0, 255]), 8, 1);
  assert.equal(mono.bits[0], 0b10101010);
  assert.deepEqual([...mono.pixels], [0, 255, 0, 255, 0, 255, 0, 255]);
  assert.throws(() => monochrome(Buffer.alloc(7), 7, 1));
  const bytes = Buffer.alloc(72);
  bytes[0] = 0x80;
  const packet = escpos(bytes, 576, 1);
  assert.deepEqual([...packet.subarray(5, 13)], [29, 118, 48, 0, 72, 0, 1, 0]);
  assert.equal(packet.length, 13 + 72 + 3);
  assert.equal(escpos(bytes, 576, 1, true).length, packet.length + 3);
});
test('exact preview pixels match printer bits, with real logo and bounded output', async () => {
  const p = await preparePhoto(image, logoPath);
  const { data, info } = await sharp(p.png).grayscale().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 576);
  assert.equal(info.height, p.height);
  assert(p.height <= 1000);
  for (let i = 0; i < data.length; i++)
    assert.equal(data[i], p.bits[i >> 3] & (0x80 >> (i % 8)) ? 0 : 255);
  assert(
    p.bits.subarray(72 * (p.height - 156)).some((n) => n),
    'logo is not blank',
  );
  await assert.rejects(() => preparePhoto(Buffer.from('<svg/>'), logoPath));
});
test('pairing is one-use, expires, and locks after ten wrong attempts', (t) => {
  const f = fixture(t);
  const code = f.service.pairing();
  for (let i = 0; i < 10; i++) assert.throws(() => f.service.pair('wrong'));
  assert.throws(() => f.service.pair(code));
  const fresh = f.service.pairing();
  f.advance(300001);
  assert.throws(() => f.service.pair(fresh));
  const once = f.service.pairing();
  f.service.pair(once);
  assert.throws(() => f.service.pair(once));
  assert.throws(() => f.service.authenticate('0'.repeat(64)));
});
test('double tap and lost response never print a second copy; payload disappears', async (t) => {
  const f = fixture(t);
  const p = await f.service.preview(f.device, image.toString('base64'));
  const id = randomUUID();
  const [a, b] = await Promise.all([
    f.service.print(f.device, id, p.id),
    f.service.print(f.device, id, p.id),
  ]);
  assert.equal(a.state, 'sent');
  assert(['sending', 'sent'].includes(b.state));
  assert.equal(f.writes(), 1);
  assert.equal(f.service.previews.size, 0);
  assert.equal((await f.service.print(f.device, id, p.id)).state, 'sent');
  assert.equal(f.writes(), 1);
  await assert.rejects(() => f.service.print(f.device, randomUUID(), p.id), /ALREADY_SUBMITTED/);
  const columns = f.service.db
    .prepare('PRAGMA table_info(jobs)')
    .all()
    .map((c) => c.name);
  assert.deepEqual(columns, ['id', 'device', 'preview', 'state', 'created_at']);
});
test('unknown transport outcome is durable and not retried; restart recovers sending', async (t) => {
  const f = fixture(t, {
    send: async () => {
      throw Error('lost');
    },
  });
  const p = await f.service.preview(f.device, image.toString('base64')),
    id = randomUUID();
  assert.equal((await f.service.print(f.device, id, p.id)).state, 'unknown');
  f.service.db.prepare("UPDATE jobs SET state='sending' WHERE id=?").run(id);
  const restarted = new PhotoService(f.config);
  assert.equal(restarted.job(f.device, id).state, 'unknown');
  assert.equal((await restarted.print(f.device, id, p.id)).state, 'unknown');
  restarted.close();
});
test('preview is scoped, expires and is wiped on cancellation; offline setup does not print', async (t) => {
  const f = fixture(t);
  const other = f.service.authenticate(f.service.pair(f.service.pairing()).token);
  let p = await f.service.preview(f.device, image.toString('base64'));
  await assert.rejects(() => f.service.print(other, randomUUID(), p.id), /PREVIEW_EXPIRED/);
  const held = f.service.previews.get(p.id);
  f.service.deletePreview(f.device, p.id);
  assert(held.bits.every((n) => n === 0));
  assert(held.png.every((n) => n === 0));
  f.advance(3000);
  p = await f.service.preview(f.device, image.toString('base64'));
  f.advance(90001);
  await assert.rejects(() => f.service.print(f.device, randomUUID(), p.id), /PREVIEW_EXPIRED/);
  f.advance(3000);
  p = await f.service.preview(f.device, image.toString('base64'));
  f.service.enabled = false;
  await assert.rejects(() => f.service.print(f.device, randomUUID(), p.id), /NOT_CONFIGURED/);
  assert.equal(f.writes(), 0);
});
test('network transport writes once to an isolated loopback printer and rejects public config hosts', async (t) => {
  for (const ip of ['192.168.123.100', '10.0.0.1', '172.16.0.1']) assert(privateIPv4(ip));
  for (const ip of ['8.8.8.8', '127.0.0.1', 'printer.example', '192.168.999.1'])
    assert(!privateIPv4(ip));
  let received = Buffer.alloc(0);
  const server = net.createServer((s) =>
    s.on('data', (b) => {
      received = Buffer.concat([received, b]);
    }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const bytes = escpos(Buffer.alloc(72), 576, 1);
  assert.equal(await sendRaster({ host: '127.0.0.1', port: server.address().port }, bytes), 'sent');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(received, bytes);
});
test('HTTP routes require auth, reject foreign origins and malformed input, disable caching', async (t) => {
  const f = fixture(t);
  const server = http.createServer(handler(f.service));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(url + '/v1/status')).status, 401);
  const headers = { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' };
  assert.equal(
    (
      await fetch(url + '/v1/status', {
        headers: { ...headers, Origin: 'https://foreign.invalid' },
      })
    ).status,
    403,
  );
  const status = await fetch(url + '/v1/status', { headers });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal(
    (await fetch(url + '/v1/previews', { method: 'POST', headers, body: '{' })).status,
    400,
  );
  const response = await fetch(url + '/v1/previews', {
    method: 'POST',
    headers,
    body: JSON.stringify({ image: image.toString('base64') }),
  });
  assert.equal(response.status, 200);
  const p = await response.json();
  const id = randomUUID(),
    job = await fetch(url + '/v1/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id, previewId: p.id }),
    });
  assert.equal((await job.json()).state, 'sent');
  assert.equal((await (await fetch(url + '/v1/jobs/' + id, { headers })).json()).state, 'sent');
});
