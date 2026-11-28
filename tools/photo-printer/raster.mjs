import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { slipLayout, slipSvg, stamp, viewfinderSvg } from './slip.mjs';

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
    height > 1400 ||
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
    height > 1400 ||
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

/** Thermal print tone curve for the photograph only: lift shadows, keep detail. */
async function thermalPhoto(input, width, height) {
  const resized = await sharp(input, {
    limitInputPixels: 16000000,
    failOn: 'warning',
    animated: false,
  })
    .rotate()
    .flatten({ background: '#fff' })
    .resize(width, height, { fit: 'cover', position: 'attention' })
    .png()
    .toBuffer();
  const gray = await sharp(resized)
    .grayscale()
    .normalise({ lower: 0.5, upper: 99.5 })
    .sharpen({ sigma: 0.8, m1: 0, m2: 1.8, y2: 8, y3: 8 })
    .raw()
    .toBuffer();
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(255 * (gray[i] / 255) ** 0.8);
  const png = await sharp(gray, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  resized.fill(0);
  gray.fill(0);
  return png;
}

/**
 * Souvenir slip v2 (26.11.2026): logo, «ФОТО НА ПАМЯТЬ», framed photograph with viewfinder
 * ticks, the caption in the guest's language, point name, date and time. Same contract as
 * preparePhoto: the returned PNG is exactly the dots sent to the printer.
 */
export async function preparePhotoSlip(input, logoPath, width = 576, locale = 'ru', options = {}) {
  if (!Object.hasOwn(captionPaths, locale)) throw new Error('INVALID_LOCALE');
  if (![384, 512, 576].includes(width) || input.length > 5 * 1024 * 1024)
    throw new Error('INVALID_IMAGE');
  const metadata = await sharp(input, { limitInputPixels: 16000000, failOn: 'warning' }).metadata();
  if (!['jpeg', 'png'].includes(metadata.format) || (metadata.pages ?? 1) !== 1)
    throw new Error('INVALID_IMAGE');
  const layout = slipLayout(width);
  const svg = slipSvg(layout, {
    locale,
    point: options.point ?? '',
    when: stamp(options.now ?? new Date(), options.timeZone ?? 'Asia/Almaty'),
  });
  const base = await sharp(Buffer.from(svg)).png().toBuffer();
  const photo = await thermalPhoto(input, layout.photo.width, layout.photo.height);
  // The orange sticker prints solid black, its white lettering stays paper white.
  const { data: rgba } = await sharp(logoPath)
    .resize(layout.logo.width, layout.logo.height, { fit: 'contain', background: '#0000' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mark = Buffer.alloc(layout.logo.width * layout.logo.height, 255);
  for (let i = 0; i < mark.length; i++) {
    const [r, g, b, a] = rgba.subarray(i * 4, i * 4 + 4);
    if (a > 110 && 0.299 * r + 0.587 * g + 0.114 * b < 205) mark[i] = 0;
  }
  rgba.fill(0);
  const logo = await sharp(mark, {
    raw: { width: layout.logo.width, height: layout.logo.height, channels: 1 },
  })
    .png()
    .toBuffer();
  const composed = await sharp(base)
    .composite([
      { input: logo, left: layout.logo.left, top: layout.logo.top },
      { input: photo, left: layout.photo.left, top: layout.photo.top },
      { input: Buffer.from(viewfinderSvg(svg, layout)), left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
  const gray = await sharp(composed).flatten({ background: '#fff' }).grayscale().raw().toBuffer();
  const { height } = layout;
  // Photo rows are dithered; vector rows (logo, lettering, frame) are thresholded so the
  // edges stay crisp. Rows of the frame that hold the photo go through error diffusion.
  const photoTop = layout.photo.top;
  const photoBottom = layout.photo.top + layout.photo.height;
  const bits = Buffer.alloc((width * height) / 8);
  const pixels = Buffer.alloc(width * height, 255);
  const band = monochrome(
    gray.subarray(width * photoTop, width * photoBottom),
    width,
    photoBottom - photoTop,
  );
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const inPhoto =
        y >= photoTop &&
        y < photoBottom &&
        x >= layout.photo.left &&
        x < layout.photo.left + layout.photo.width;
      const black = inPhoto ? band.pixels[(y - photoTop) * width + x] === 0 : gray[i] < 140;
      if (black) {
        pixels[i] = 0;
        bits[i >> 3] |= 0x80 >> (x % 8);
      }
    }
  band.bits.fill(0);
  band.pixels.fill(0);
  photo.fill(0);
  composed.fill(0);
  gray.fill(0);
  const png = await sharp(pixels, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  pixels.fill(0);
  return { width, height, bits, png };
}
