import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { preparePhotoSlip } from '../../tools/photo-printer/raster.mjs';
import { measure, slipCopy, slipLayout, stamp } from '../../tools/photo-printer/slip.mjs';
import { createPrintTransport } from '../../tools/photo-printer/printer.mjs';
import { sendWindowsQueue, validQueue } from '../../tools/photo-printer/windows-raw.mjs';

const require = createRequire(new URL('../../tools/photo-printer/package.json', import.meta.url));
const sharp = require('sharp');
const logoPath = fileURLToPath(new URL('../../apps/kiosk/assets/v3/logo.webp', import.meta.url));
const image = await sharp({
  create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 120, b: 160 } },
})
  .jpeg()
  .toBuffer();

test('slip v2 fits the kiosk preview limit for every width and language', async () => {
  for (const width of [384, 512, 576])
    for (const locale of ['ru', 'kk', 'en']) {
      const p = await preparePhotoSlip(image, logoPath, width, locale, { point: 'Abay Plaza' });
      assert.equal(p.width, width);
      assert(p.height <= 1000, `${width}/${locale}: ${p.height}`);
      assert.equal(p.bits.length, (width / 8) * p.height);
    }
});

test('slip v2 preview PNG is exactly the dots sent to the printer', async () => {
  const p = await preparePhotoSlip(image, logoPath, 576, 'ru', { point: 'Abay Plaza' });
  const raw = await sharp(p.png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(raw.info.width, 576);
  for (let i = 0; i < 576 * p.height; i++) {
    const black = (p.bits[i >> 3] & (0x80 >> (i % 8))) !== 0;
    assert.equal(raw.data[i * raw.info.channels] === 0, black);
  }
});

test('slip copy fits one line and the shot time is Almaty time', () => {
  const layout = slipLayout(576);
  for (const copy of Object.values(slipCopy))
    for (const line of copy.title) assert(measure('title', line, 30, 0) < layout.inner, line);
  assert.deepEqual(stamp(new Date('2026-11-26T09:32:00Z')), { date: '26.11.2026', time: '14:32' });
});

test('windows queue transport is chosen by the operator only and maps exit codes', async () => {
  assert(validQueue('PickChick XP-A160M'));
  assert(!validQueue('\\\\server\\share"; rm'));
  await assert.rejects(
    createPrintTransport({ transport: 'windows-queue', printerQueue: 'X' }, { platform: 'darwin' }),
  );
  await assert.rejects(
    createPrintTransport(
      { transport: 'windows-queue', printerQueue: 'X', printerHost: '192.168.1.2' },
      { platform: 'win32' },
    ),
  );
  const calls = [];
  const send = await createPrintTransport(
    { transport: 'windows-queue', printerQueue: 'PickChick XP-A160M', protocolConfirmed: true },
    { platform: 'win32', queue: async (q, b) => (calls.push([q, b.length]), 'sent') },
  );
  assert.equal(await send(Buffer.alloc(16)), 'sent');
  assert.deepEqual(calls, [['PickChick XP-A160M', 16]]);
  const off = await createPrintTransport(
    { transport: 'windows-queue', printerQueue: 'PickChick XP-A160M' },
    { platform: 'win32', queue: async () => assert.fail('disabled') },
  );
  assert.equal(await off(Buffer.alloc(16)), 'failed');

  for (const [code, state] of [
    [0, 'sent'],
    [2, 'failed'],
    [3, 'unknown'],
  ]) {
    let received;
    const launch = (cmd, args) => {
      assert.equal(cmd, 'powershell.exe');
      assert.deepEqual(args.slice(-2), ['-Queue', 'PickChick XP-A160M']);
      const child = new EventEmitter();
      child.kill = () => {};
      child.stdin = new EventEmitter();
      child.stdin.end = (bytes) => {
        received = bytes;
        setImmediate(() => child.emit('close', code));
      };
      return child;
    };
    assert.equal(
      await sendWindowsQueue('PickChick XP-A160M', Buffer.from('ESCPOS..'), { launch }),
      state,
    );
    assert.equal(received.toString(), 'ESCPOS..');
  }
});
