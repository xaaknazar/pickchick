import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const captionPaths = Object.fromEntries(
  ['ru', 'kk', 'en'].map((locale) => [
    locale,
    fileURLToPath(new URL(`../../design/photo-alex/print-caption-${locale}.svg`, import.meta.url)),
  ]),
);

/** Serpentine Floyd-Steinberg, black = 1. Only generated pixels reach ESC/POS. */
export function monochrome(gray, width, height) {
  if (
    !Number.isInteger(width) ||
    width < 8 ||
    width > 576 ||
    width % 8 ||
    !Number.isInteger(height) ||
    height < 1 ||
    height > 1000 ||
    gray.length !== width * height
  )
    throw new Error('INVALID_RASTER');
  const work = Float32Array.from(gray);
  const bits = Buffer.alloc((width * height) / 8);
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    // Alternate direction to avoid the directional streaks of a single left-to-right pass.
    const direction = y % 2 ? -1 : 1;
    for (let x = direction === 1 ? 0 : width - 1; x >= 0 && x < width; x += direction) {
      const i = y * width + x;
      const value = work[i] < 128 ? 0 : 255;
      pixels[i] = value;
      if (!value) bits[i >> 3] |= 0x80 >> (x % 8);
      const error = work[i] - value;
      const ahead = x + direction >= 0 && x + direction < width;
      const behind = x - direction >= 0 && x - direction < width;
      if (ahead) work[i + direction] += (error * 7) / 16;
      if (y + 1 < height) {
        if (behind) work[i + width - direction] += (error * 3) / 16;
        work[i + width] += (error * 5) / 16;
        if (ahead) work[i + width + direction] += error / 16;
      }
    }
  }
  work.fill(0);
  return { bits, pixels };
}

export function escpos(bits, width, height, cut = false) {
  if (
    ![384, 512, 576].includes(width) ||
    !Number.isInteger(height) ||
    height < 1 ||
    height > 1000 ||
    bits.length !== (width / 8) * height
  )
    throw new Error('INVALID_RASTER');
  const bytes = width / 8;
  // Small, complete raster commands also work with clones whose image-height/buffer limit
  // is lower than the full photograph. GS v 0 advances by the stripe height: no LF between.
  const stripes = [];
  for (let row = 0; row < height; row += 24) {
    const rows = Math.min(24, height - row);
    stripes.push(Buffer.from([0x1d, 0x76, 0x30, 0, bytes & 255, bytes >> 8, rows, 0]));
    stripes.push(bits.subarray(row * bytes, (row + rows) * bytes));
  }
  return Buffer.concat([
    Buffer.from([0x1b, 0x40, 0x1b, 0x61, 0]),
    ...stripes,
    Buffer.from([0x1b, 0x64, 3]),
    ...(cut ? [Buffer.from([0x1d, 0x56, 0])] : []),
  ]);
}

/** Same binary pixels are returned for the preview and sent to the printer. No metadata retained. */
export async function preparePhoto(input, logoPath, width = 576, locale = 'ru') {
  if (!Object.hasOwn(captionPaths, locale)) throw new Error('INVALID_LOCALE');
  if (![384, 512, 576].includes(width) || input.length > 5 * 1024 * 1024)
    throw new Error('INVALID_IMAGE');
  const image = sharp(input, { limitInputPixels: 16000000, failOn: 'warning', animated: false });
  const metadata = await image.metadata();
  if (!['jpeg', 'png'].includes(metadata.format) || (metadata.pages ?? 1) !== 1)
    throw new Error('INVALID_IMAGE');
  const margin = 24;
  const photoWidth = width - margin * 2;
  const photoHeight = Math.round((photoWidth * 3) / 4);
  // Contain preserves friends at either edge; no face detection or biometric processing.
  const resized = await image
    .rotate()
    .flatten({ background: '#fff' })
    .resize(photoWidth, photoHeight, { fit: 'contain', background: '#fff' })
    .png()
    .toBuffer();
  // A receipt printer has no continuous grey: dense dots merge on paper. Lift only the
  // photograph's shadows/midtones before dithering; keep the logo and white margins intact.
  // Materialize the resize first so detail enhancement runs at the final print resolution.
  const photoGray = await sharp(resized)
    .grayscale()
    .sharpen({ sigma: 0.7, m1: 0, m2: 1.5, y2: 8, y3: 8 })
    .raw()
    .toBuffer();
  for (let i = 0; i < photoGray.length; i++)
    photoGray[i] = Math.round(255 * (photoGray[i] / 255) ** 0.65);
  const photo = await sharp(photoGray, {
    raw: { width: photoWidth, height: photoHeight, channels: 1 },
  })
    .png()
    .toBuffer();
  resized.fill(0);
  photoGray.fill(0);
  const logo = await sharp(logoPath)
    .resize(144, 132, { fit: 'contain', background: '#fff' })
    .flatten({ background: '#fff' })
    .png()
    .toBuffer();
  const photoTop = margin * 2 + 132;
  const captionTop = photoTop + photoHeight + margin;
  // Outlined lettering includes Kazakh glyphs and needs no printer code page or installed font.
  const caption = await sharp(captionPaths[locale]).resize(photoWidth).png().toBuffer();
  const captionHeight = Math.round((photoWidth * 60) / 336);
  const height = captionTop + captionHeight + margin;
  // Sharp applies colour operations before composite. Materialize first so the photograph
  // and logo, not just the white base, pass through the same grayscale conversion.
  const composed = await sharp({ create: { width, height, channels: 3, background: '#fff' } })
    .composite([
      { input: logo, left: (width - 144) / 2, top: margin },
      { input: photo, left: margin, top: photoTop },
      { input: caption, left: margin, top: captionTop },
    ])
    .png()
    .toBuffer();
  const gray = await sharp(composed).flatten({ background: '#fff' }).grayscale().raw().toBuffer();
  // Isolate error diffusion: photo tones cannot change the mark or the lettering.
  const boundaries = [0, photoTop, captionTop, height];
  const sections = boundaries
    .slice(0, -1)
    .map((start, i) =>
      monochrome(
        gray.subarray(width * start, width * boundaries[i + 1]),
        width,
        boundaries[i + 1] - start,
      ),
    );
  const bits = Buffer.concat(sections.map((section) => section.bits));
  const pixels = Buffer.concat(sections.map((section) => section.pixels));
  for (const section of sections) {
    section.bits.fill(0);
    section.pixels.fill(0);
  }
  caption.fill(0);
  photo.fill(0);
  composed.fill(0);
  gray.fill(0);
  const png = await sharp(pixels, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  pixels.fill(0);
  return { width, height, bits, png };
}
