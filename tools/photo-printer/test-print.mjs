// Operator check: prints one synthetic slip (no guest photo) through the configured transport.
// Usage: node tools/photo-printer/test-print.mjs C:/ProgramData/PickChickPhoto/config.json [ru|kk|en] [--preview out.png]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createPrintTransport } from './printer.mjs';
import { escpos, preparePhotoSlip } from './raster.mjs';

const sharp = createRequire(import.meta.url)('sharp');
const config = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
const locale = ['ru', 'kk', 'en'].includes(process.argv[3]) ? process.argv[3] : 'ru';
const width = config.width ?? 576;
// A soft gradient with a test card instead of people: shows tone, frame and lettering.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient></defs>
<rect width="800" height="600" fill="url(#g)"/><circle cx="400" cy="300" r="170" fill="#ff6900"/>
<circle cx="400" cy="300" r="90" fill="#0047bb"/></svg>`;
const image = await sharp(Buffer.from(svg)).jpeg().toBuffer();
const logo = fileURLToPath(new URL('../../apps/kiosk/assets/v3/logo.webp', import.meta.url));
const slip = await preparePhotoSlip(image, logo, width, locale, {
  point: config.point ?? '',
  timeZone: config.timeZone ?? 'Asia/Almaty',
});
const at = process.argv.indexOf('--preview');
if (at > 0) {
  writeFileSync(process.argv[at + 1], slip.png);
  console.log('Preview written:', slip.width, 'x', slip.height);
} else {
  const send = await createPrintTransport(config);
  console.log(
    'Print result:',
    await send(escpos(slip.bits, slip.width, slip.height, config.cut === true)),
  );
}
