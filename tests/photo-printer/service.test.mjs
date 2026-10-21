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
    p.bits.subarray(72 * 24, 72 * 156).some((n) => n),
    'logo is not blank',
  );
  await assert.rejects(() => preparePhoto(Buffer.from('<svg/>'), logoPath));
});
test('full-height photograph is encoded in small lossless stripes without inter-stripe paper feeds', () => {
  const width = 576,
    height = 600,
    bits = Buffer.alloc((width * height) / 8);
  for (let i = 0; i < bits.length; i++) bits[i] = i % 256;
  const packet = escpos(bits, width, height);
  let offset = 5,
    rows = 0;
  const images = [];
  while (rows < height) {
    assert.deepEqual([...packet.subarray(offset, offset + 4)], [29, 118, 48, 0]);
    assert.equal(packet.readUInt16LE(offset + 4), width / 8);
    const stripe = packet.readUInt16LE(offset + 6);
    assert(stripe > 0 && stripe <= 24);
    images.push(packet.subarray(offset + 8, offset + 8 + (stripe * width) / 8));
    offset += 8 + (stripe * width) / 8;
    rows += stripe;
  }
  assert.equal(rows, height);
  assert.deepEqual(Buffer.concat(images), bits);
  assert.deepEqual([...packet.subarray(offset)], [27, 100, 3]);
});
test('colour photographs retain distinct lifted tones and the logo remains visible', async () => {
  for (const [color, low, high] of [
    ['#0047BB', 0.48, 0.61],
    ['#FF671F', 0.22, 0.36],
  ]) {
    const input = await sharp({
      create: { width: 128, height: 96, channels: 3, background: color },
    })
      .png()
      .toBuffer();
    const p = await preparePhoto(input, logoPath);
    const density = (x0, y0, width, height) => {
      let black = 0;
      for (let y = y0; y < y0 + height; y++)
        for (let x = x0; x < x0 + width; x++)
          black += !!(p.bits[(y * p.width + x) >> 3] & (128 >> (x % 8)));
      return black / (width * height);
    };
    const photograph = density(30, 186, 516, 370),
      logo = density(216, 24, 144, 132);
    assert(photograph > low && photograph < high, `colour ${color}: ${photograph}`);
    assert(logo > 0.1 && logo < 0.35, `visible, non-solid logo: ${logo}`);
  }
});
test('thermal photo profile opens dark tones without clipping highlights or changing logo density', async () => {
  // Underexposed patches, midtones and bright highlights; no real customer photograph.
  const width = 528,
    height = 396,
    values = [0, 32, 64, 128, 224, 248, 255];
  const inputPixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      inputPixels[y * width + x] = values[Math.min(6, Math.floor(x / (width / 7)))];
  const input = await sharp(inputPixels, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  const p = await preparePhoto(input, logoPath);
  const output = await sharp(p.png).grayscale().raw().toBuffer();
  const means = values.map((_, band) => {
    let total = 0,
      count = 0;
    for (let y = 196; y < 556; y++)
      for (
        let x = 24 + Math.ceil((band * width) / 7) + 8;
        x < 24 + ((band + 1) * width) / 7 - 8;
        x++
      ) {
        total += output[y * p.width + x];
        count++;
      }
    return total / count;
  });
  assert(means[1] > 60 && means[2] > 95 && means[3] > 150, `lift dark/mid tones: ${means}`);
  assert(means[0] < 2 && means[6] > 254, 'preserve black and white anchors');
  for (let i = 1; i < means.length; i++)
    assert(means[i] > means[i - 1] + 1, 'tones remain distinct');
  assert(means[4] < 248 && means[5] < 254, 'bright detail does not become flat white');
  const blank = await sharp({ create: { width, height, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  const whitePhoto = await preparePhoto(blank, logoPath);
  assert.deepEqual(
    p.bits.subarray(0, 72 * 180),
    whitePhoto.bits.subarray(0, 72 * 180),
    'logo unaffected by photo brightness',
  );
  assert.deepEqual(
    p.bits.subarray(72 * 600),
    whitePhoto.bits.subarray(72 * 600),
    'caption unaffected by photo brightness',
  );
});
test('photo framing preserves both edges at every supported paper width', async () => {
  const input = await sharp({
    create: { width: 800, height: 200, channels: 3, background: '#fff' },
  })
    .composite([
      {
        input: await sharp({ create: { width: 50, height: 200, channels: 3, background: '#000' } })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      },
      {
        input: await sharp({ create: { width: 50, height: 200, channels: 3, background: '#000' } })
          .png()
          .toBuffer(),
        left: 750,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  for (const width of [384, 512, 576]) {
    const p = await preparePhoto(input, logoPath, width);
    const pixels = await sharp(p.png).grayscale().raw().toBuffer();
    const y = 180 + Math.floor(((width - 48) * 3) / 8);
    assert.equal(pixels[y * width + 28], 0, 'left friend not cropped');
    assert.equal(pixels[y * width + width - 29], 0, 'right friend not cropped');
    assert.equal(pixels[10 * width + 10], 255, 'margin stays paper-white');
  }
});
test('two readable caption lines follow the photograph at every supported paper width', async () => {
  for (const width of [384, 512, 576]) {
    for (const locale of ['ru', 'kk', 'en']) {
      const p = await preparePhoto(image, logoPath, width, locale);
      assert(p.height <= 1000, 'short souvenir within the existing printer limit');
      const pixels = await sharp(p.png).grayscale().raw().toBuffer();
      const scale = (width - 48) / 336;
      const top = 180 + Math.round(((width - 48) * 3) / 4) + 24;
      for (const baseline of [23, 47]) {
        let dots = 0;
        for (
          let y = top + Math.floor((baseline - 18) * scale);
          y < top + Math.ceil(baseline * scale);
          y++
        )
          for (let x = 24; x < width - 24; x++) dots += pixels[y * width + x] === 0;
        assert(dots > 100, `visible caption line ${baseline} at ${width}`);
      }
      assert.doesNotThrow(() => escpos(p.bits, p.width, p.height));
    }
  }
});
test('HTTP preview uses exactly the selected language and rejects unsupported locales', async (t) => {
  const f = fixture(t);
  const server = http.createServer(handler(f.service));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' };
  const previews = new Set();
  for (const locale of ['ru', 'kk', 'en']) {
    f.advance(2001);
    const response = await fetch(url + '/v1/previews', {
      method: 'POST',
      headers,
      body: JSON.stringify({ image: image.toString('base64'), locale }),
    });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.locale, locale);
    const expected = await preparePhoto(image, logoPath, 576, locale);
    assert.equal(preview.png, expected.png.toString('base64'));
    previews.add(preview.png);
  }
  assert.equal(previews.size, 3, 'each language has its own lettering, not a combined caption');
  const bad = await fetch(url + '/v1/previews', {
    method: 'POST',
    headers,
    body: JSON.stringify({ image: image.toString('base64'), locale: '../ru' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'INVALID_LOCALE');
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
