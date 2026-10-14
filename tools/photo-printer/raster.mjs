import sharp from 'sharp';

/** Floyd-Steinberg, black = 1. Only application-generated pixels reach ESC/POS. */
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
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const value = work[i] < 128 ? 0 : 255;
      pixels[i] = value;
      if (!value) bits[i >> 3] |= 0x80 >> (x % 8);
      const error = work[i] - value;
      if (x + 1 < width) work[i + 1] += (error * 7) / 16;
      if (y + 1 < height) {
        if (x) work[i + width - 1] += (error * 3) / 16;
        work[i + width] += (error * 5) / 16;
        if (x + 1 < width) work[i + width + 1] += error / 16;
      }
    }
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
export async function preparePhoto(input, logoPath, width = 576) {
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
  const photo = await image
    .rotate()
    .flatten({ background: '#fff' })
    .resize(photoWidth, photoHeight, { fit: 'contain', background: '#fff' })
    .png()
    .toBuffer();
  const logo = await sharp(logoPath)
    .resize(144, 132, { fit: 'contain', background: '#fff' })
    .flatten({ background: '#fff' })
    .png()
    .toBuffer();
  const height = photoHeight + 132 + margin * 3;
  // Sharp applies colour operations before composite. Materialize first so the photograph
  // and logo, not just the white base, pass through the same grayscale conversion.
  const composed = await sharp({ create: { width, height, channels: 3, background: '#fff' } })
    .composite([
      { input: photo, left: margin, top: margin },
      { input: logo, left: (width - 144) / 2, top: photoHeight + margin * 2 },
    ])
    .png()
    .toBuffer();
  const gray = await sharp(composed).flatten({ background: '#fff' }).grayscale().raw().toBuffer();
  const { bits, pixels } = monochrome(gray, width, height);
  composed.fill(0);
  gray.fill(0);
  const png = await sharp(pixels, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  return { width, height, bits, png };
}
