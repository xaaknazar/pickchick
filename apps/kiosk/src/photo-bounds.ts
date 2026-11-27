// Visible bounds of photos: types, the fit of a dish into a tile, and the published catalog
// photos measured on 23.11.2026 (catalog v20, 640 x 640 card and 1280 x 1280 hero WebP with a
// clear margin). Pure data and maths: no React Native, so node tests can load it.

/** [width / height, left, top, right, bottom]: the visible box as fractions of the image. */
export type PhotoBounds = readonly [number, number, number, number, number];
/** [left, top, right, bottom] of a square published photo. */
type Box = readonly [number, number, number, number];

/**
 * Published photos by content hash (owner 23.11.2026: «фото комбо стоят разные»). Each is a
 * square canvas with the dish placed anywhere inside it; the card fits the dish itself. A photo
 * published later and not listed here keeps the plain square fit until it is measured (alpha >= 64,
 * the same rule as scripts/kiosk/photo-bounds.py).
 */
const PUBLISHED: Readonly<Record<string, { card: Box; hero: Box }>> = {
  // pick-meal-combo
  '4bc8460055489cba8f3f39cc8e80283021b9e71306649a08bc315ec7825ff7f7': {
    card: [0.153, 0.05, 0.847, 0.95],
    hero: [0.145, 0.05, 0.851, 0.95],
  },
  // chick-burger-combo
  '0b7087d917d4ccb63b85289c61414bc5ce82fcb726ad9e58db0074c0fd3d4c06': {
    card: [0.052, 0.145, 0.95, 0.848],
    hero: [0.051, 0.145, 0.95, 0.848],
  },
  // chick-n-roll-combo
  '500b5331debed6ffc2ecc35d27dd5dfabe427daec06f942e5414978306a5435a': {
    card: [0.05, 0.12, 0.948, 0.878],
    hero: [0.05, 0.121, 0.95, 0.879],
  },
  // chick-n-roll-meal-combo
  '9e67ff99afce9afdbd1edbf2ca457fc80832e158bfc8e3884e93aa738e7ef3f2': {
    card: [0.116, 0.05, 0.883, 0.95],
    hero: [0.116, 0.05, 0.883, 0.95],
  },
  // chick-meal-combo
  a023fd6f1c068593a21689ee3e414f6b210006eea77df0df9f7f806e42b4ecc1: {
    card: [0.12, 0.05, 0.88, 0.95],
    hero: [0.12, 0.05, 0.88, 0.95],
  },
  // chick-burger-duo
  '68be77daf823901f1b881c5236976be3a1a3133a76f542ed7c317a6c5aed9623': {
    card: [0.05, 0.059, 0.944, 0.884],
    hero: [0.05, 0.06, 0.95, 0.941],
  },
  // mix-chick-duo
  '6ac2f1d695e58e1a23814c94bd842d6bd8ff032c6dfdd0b2144066d725cdac9a': {
    card: [0.052, 0.186, 0.95, 0.812],
    hero: [0.052, 0.186, 0.95, 0.812],
  },
  // mix-burger-duo
  '09697c0e95c58ebe8411eb3aa54e0d2e4994b2554242bd1a0c3161a2d3d0448f': {
    card: [0.095, 0.07, 0.948, 0.852],
    hero: [0.052, 0.07, 0.949, 0.852],
  },
  // chick-n-roll
  '2e2c21f24557d7b2e21474c841f2acab1dd4e495c3362f16841027d4abb45b99': {
    card: [0.283, 0.05, 0.717, 0.95],
    hero: [0.284, 0.05, 0.716, 0.95],
  },
  // chick-burger
  e766813bb8e80e8a4566d8f7dba3c2168806e1e89cb8eb9d2012434e688ab324: {
    card: [0.05, 0.169, 0.936, 0.831],
    hero: [0.05, 0.17, 0.938, 0.831],
  },
  // sauce-300
  '844e85940eb51440cd1727d12eb2c4454db4be9b20a3e6aed326522c8d627998': {
    card: [0.053, 0.05, 0.914, 0.948],
    hero: [0.053, 0.05, 0.923, 0.948],
  },
  // sauce-400
  dd442a40a606f156e8939b1eddc49fb61cf607caa54866c732c729acf970c924: {
    card: [0.131, 0.05, 0.839, 0.947],
    hero: [0.131, 0.05, 0.848, 0.947],
  },
  // sauce-500
  '6b8028a291ebaeb5c0fb8102ded2106973a960660069976562ae1f64af21c26c': {
    card: [0.194, 0.052, 0.792, 0.948],
    hero: [0.194, 0.052, 0.795, 0.948],
  },
  // sauce-hot-300
  '199c4618328bbd8554525bc625b04b58582227c91219a080b829185adeff2cf2': {
    card: [0.178, 0.052, 0.808, 0.95],
    hero: [0.178, 0.052, 0.808, 0.95],
  },
  // sauce-hot-400
  '3186e0e61099ae5f7f4be43f0415193211d6c2b03bbcb9bc50a6e2456c880059': {
    card: [0.212, 0.05, 0.78, 0.948],
    hero: [0.212, 0.05, 0.78, 0.948],
  },
  // sauce-hot-500
  e3ecc8e00dde208ad8014ca631d6d40d02efd7aabbebdfd055c913c865d2ec70: {
    card: [0.197, 0.052, 0.792, 0.948],
    hero: [0.196, 0.052, 0.791, 0.948],
  },
  // sauce-cheese
  '8a7a7e638f75b3293f0ce0bc43d8a82d98b7967565702fe6247edf9e5c033873': {
    card: [0.058, 0.195, 0.944, 0.806],
    hero: [0.058, 0.195, 0.945, 0.805],
  },
  // sauce-cheese-300
  b306046e645bcb2b3d5345e5c92ba6a109d3ce2f6b96b9a2d365fb4cef49faa7: {
    card: [0.18, 0.052, 0.812, 0.95],
    hero: [0.18, 0.05, 0.812, 0.95],
  },
  // sauce-cheese-400
  '962208a89441dc6c10a31d3f489d510bc1e546c3252206c34161ccfd7da1c74a': {
    card: [0.202, 0.05, 0.797, 0.95],
    hero: [0.201, 0.05, 0.798, 0.95],
  },
  // sauce-cheese-500
  '80435e6831855c18e59b6b4e1b7b6ce0e9535c7ecfcab9fd21c7913f1413690f': {
    card: [0.205, 0.05, 0.786, 0.947],
    hero: [0.205, 0.05, 0.791, 0.948],
  },
  // cola-bottle
  bc2897a52512c44bbd52a98238a7a078a7b10c8d09f0d30121c001c3287f1f1e: {
    card: [0.308, 0.05, 0.688, 0.948],
    hero: [0.307, 0.05, 0.688, 0.948],
  },
  // cola-zero-can
  '0faff897b36a4528ae00a0198be6f89b5efd29db6f6099bb09ded83420b85068': {
    card: [0.248, 0.05, 0.745, 0.944],
    hero: [0.248, 0.05, 0.747, 0.945],
  },
  // sprite
  '0d649c6ab2bd7789426da2343308eae4dc14a0cb2545aaa2bc46ab77d3c643e8': {
    card: [0.292, 0.05, 0.698, 0.947],
    hero: [0.293, 0.05, 0.699, 0.948],
  },
  // sprite-can
  '8df17982f7207c2fa9a25bd6fddea2493edefe54583022b46fba3225488df415': {
    card: [0.241, 0.05, 0.752, 0.945],
    hero: [0.241, 0.05, 0.752, 0.947],
  },
  // fanta
  '52f7379f2d6244585cf196797d22c4a814e81cd843fc6d673e8a264cf52fb8f2': {
    card: [0.298, 0.05, 0.639, 0.948],
    hero: [0.298, 0.05, 0.639, 0.949],
  },
  // fanta-can
  '1ee7298d09e81034ce250b1edbc506a3ed428797fe2c8a4c443a719376c19f02': {
    card: [0.259, 0.05, 0.731, 0.947],
    hero: [0.259, 0.05, 0.731, 0.946],
  },
  // fuse-berry
  '529a208a3b9095ab12b5c50951e203ecdb9a136acb523c22b20ceb889d1894fb': {
    card: [0.305, 0.05, 0.681, 0.948],
    hero: [0.305, 0.05, 0.684, 0.948],
  },
  // fuse-mango
  '4e45b96bce5d10c42a42f68a873608d6f33a537fc2f297940876fc155260ed9a': {
    card: [0.275, 0.05, 0.702, 0.945],
    hero: [0.275, 0.05, 0.702, 0.946],
  },
  // fuse-mango-pineapple
  f320b6eb784cdb4f53e6a027b261f6b21256a3f9fa1a19a6d1ef3842828e6c60: {
    card: [0.314, 0.05, 0.675, 0.948],
    hero: [0.313, 0.05, 0.675, 0.948],
  },
  // piko
  b2de8a7a5c844dab189901a2377ee344c8a602604485ea6eb50951d0de4c1cce: {
    card: [0.1, 0.05, 0.652, 0.936],
    hero: [0.1, 0.05, 0.709, 0.943],
  },
};

export function publishedPhotoBounds(
  sha256: string | undefined,
  variant: 'card' | 'hero',
): PhotoBounds | undefined {
  const entry = sha256 ? PUBLISHED[sha256] : undefined;
  return entry ? [1, ...entry[variant]] : undefined;
}

/**
 * Where to draw an image so its visible box fills a `width` x `height` stage (contain on the
 * box, never cropping the dish) and sits in its centre. `fill` leaves a margin (1 = edge to edge).
 */
export function fitPhoto(bounds: PhotoBounds, width: number, height: number, fill = 1, bleed = 0) {
  const [ratio, left, top, right, bottom] = bounds;
  // Draw the image `side` points high and `side * ratio` wide. `bleed` lets a wide dish run
  // that share past the side edges (the tile clips it) when the width is what limits it.
  const boxWidth = (right - left) * ratio;
  const boxHeight = bottom - top;
  const side = Math.min((width * (fill + bleed)) / boxWidth, (height * fill) / boxHeight);
  return {
    width: side * ratio,
    height: side,
    left: width / 2 - side * ratio * ((left + right) / 2),
    top: height / 2 - side * ((top + bottom) / 2),
  };
}
