/**
 * Where the food sits inside each uploaded cut-out photo (catalog version 21, 25.11.2026), as
 * fractions of the square image: [left, top, right, bottom]. The server pads every upload to a
 * square, so a wide tray floats in the middle of it; with the box the menu card scales the food
 * itself to the window and lets it rise above the top edge (owner 25.11.2026). Keyed by the
 * photo's content hash: a new upload simply has no entry and uses `defaultCutoutBox`.
 * Generated from /v1/customer-checkout/catalog/media; see assets/menu-cutout/README.md.
 */
export type CutoutBox = readonly [left: number, top: number, right: number, bottom: number];
/** The server's own padding of an upload: 5% on the long side. */
export const defaultCutoutBox: CutoutBox = [0.05, 0.05, 0.95, 0.95];
export const liveCutoutBoxes: Readonly<Record<string, CutoutBox>> = {
  // chick-burger
  e766813bb8e80e8a4566d8f7dba3c2168806e1e89cb8eb9d2012434e688ab324: [0.05, 0.169, 0.95, 0.831],
  // chick-burger-combo
  '0b7087d917d4ccb63b85289c61414bc5ce82fcb726ad9e58db0074c0fd3d4c06': [0.05, 0.144, 0.95, 0.855],
  // chick-burger-duo
  '68be77daf823901f1b881c5236976be3a1a3133a76f542ed7c317a6c5aed9623': [0.05, 0.059, 0.95, 0.941],
  // chick-meal-combo
  a023fd6f1c068593a21689ee3e414f6b210006eea77df0df9f7f806e42b4ecc1: [0.12, 0.05, 0.88, 0.95],
  // chick-n-roll
  '2e2c21f24557d7b2e21474c841f2acab1dd4e495c3362f16841027d4abb45b99': [0.283, 0.05, 0.717, 0.95],
  // chick-n-roll-combo
  '500b5331debed6ffc2ecc35d27dd5dfabe427daec06f942e5414978306a5435a': [0.05, 0.12, 0.95, 0.88],
  // chick-n-roll-meal-combo
  '9e67ff99afce9afdbd1edbf2ca457fc80832e158bfc8e3884e93aa738e7ef3f2': [0.116, 0.05, 0.884, 0.95],
  // cola-bottle
  bc2897a52512c44bbd52a98238a7a078a7b10c8d09f0d30121c001c3287f1f1e: [0.306, 0.05, 0.694, 0.95],
  // cola-zero-can
  '0faff897b36a4528ae00a0198be6f89b5efd29db6f6099bb09ded83420b85068': [0.247, 0.048, 0.752, 0.95],
  // fanta
  '52f7379f2d6244585cf196797d22c4a814e81cd843fc6d673e8a264cf52fb8f2': [0.298, 0.05, 0.702, 0.95],
  // fanta-can
  '1ee7298d09e81034ce250b1edbc506a3ed428797fe2c8a4c443a719376c19f02': [0.259, 0.048, 0.741, 0.95],
  // fuse-berry
  '529a208a3b9095ab12b5c50951e203ecdb9a136acb523c22b20ceb889d1894fb': [0.305, 0.05, 0.695, 0.95],
  // fuse-lemon
  a2f6be5fb596ad505843df15f763cd353d1cd461b31e99b7b0d625453d908c96: [0.361, 0.05, 0.639, 0.95],
  // fuse-mango
  '4e45b96bce5d10c42a42f68a873608d6f33a537fc2f297940876fc155260ed9a': [0.275, 0.05, 0.727, 0.95],
  // fuse-mango-pineapple
  f320b6eb784cdb4f53e6a027b261f6b21256a3f9fa1a19a6d1ef3842828e6c60: [0.312, 0.05, 0.688, 0.95],
  // mix-burger-duo
  '09697c0e95c58ebe8411eb3aa54e0d2e4994b2554242bd1a0c3161a2d3d0448f': [0.05, 0.07, 0.95, 0.853],
  // mix-chick-duo
  '6ac2f1d695e58e1a23814c94bd842d6bd8ff032c6dfdd0b2144066d725cdac9a': [0.05, 0.186, 0.95, 0.814],
  // pick-meal-combo
  '4bc8460055489cba8f3f39cc8e80283021b9e71306649a08bc315ec7825ff7f7': [0.142, 0.05, 0.858, 0.95],
  // piko
  b2de8a7a5c844dab189901a2377ee344c8a602604485ea6eb50951d0de4c1cce: [0.1, 0.05, 0.9, 0.95],
  // sauce-300
  '844e85940eb51440cd1727d12eb2c4454db4be9b20a3e6aed326522c8d627998': [0.052, 0.05, 0.95, 0.95],
  // sauce-400
  dd442a40a606f156e8939b1eddc49fb61cf607caa54866c732c729acf970c924: [0.13, 0.05, 0.87, 0.95],
  // sauce-500
  '6b8028a291ebaeb5c0fb8102ded2106973a960660069976562ae1f64af21c26c': [0.192, 0.05, 0.808, 0.95],
  // sauce-cheese
  '8a7a7e638f75b3293f0ce0bc43d8a82d98b7967565702fe6247edf9e5c033873': [0.05, 0.194, 0.95, 0.806],
  // sauce-cheese-300
  b306046e645bcb2b3d5345e5c92ba6a109d3ce2f6b96b9a2d365fb4cef49faa7: [0.177, 0.05, 0.823, 0.95],
  // sauce-cheese-400
  '962208a89441dc6c10a31d3f489d510bc1e546c3252206c34161ccfd7da1c74a': [0.192, 0.05, 0.808, 0.95],
  // sauce-cheese-500
  '80435e6831855c18e59b6b4e1b7b6ce0e9535c7ecfcab9fd21c7913f1413690f': [0.203, 0.05, 0.797, 0.95],
  // sauce-hot-300
  '199c4618328bbd8554525bc625b04b58582227c91219a080b829185adeff2cf2': [0.178, 0.05, 0.823, 0.95],
  // sauce-hot-400
  '3186e0e61099ae5f7f4be43f0415193211d6c2b03bbcb9bc50a6e2456c880059': [0.209, 0.05, 0.791, 0.95],
  // sauce-hot-500
  e3ecc8e00dde208ad8014ca631d6d40d02efd7aabbebdfd055c913c865d2ec70: [0.195, 0.05, 0.806, 0.95],
  // sprite
  '0d649c6ab2bd7789426da2343308eae4dc14a0cb2545aaa2bc46ab77d3c643e8': [0.292, 0.05, 0.708, 0.95],
  // sprite-can
  '8df17982f7207c2fa9a25bd6fddea2493edefe54583022b46fba3225488df415': [0.241, 0.05, 0.761, 0.95],
};

/** Window shape of a menu card: width / height. */
export const SHOWCASE_ASPECT = 1.3;
// In units of the window's width: how far food may rise above the window, and its bottom gap.
const RISE = 0.16;
const FLOOR = 0.035;
const BLEED = 1.02;

/**
 * Absolute position of a square cut-out inside the card window, in percent of the window, so the
 * food box fills the width or stands RISE above the top edge, whichever comes first, and always
 * rests on the same floor line.
 */
export function showcaseLayout(box: CutoutBox) {
  const [left, top, right, bottom] = box;
  const width = Math.max(right - left, 0.01);
  const height = Math.max(bottom - top, 0.01);
  const windowHeight = 1 / SHOWCASE_ASPECT;
  const side = Math.min(BLEED / width, (windowHeight + RISE - FLOOR) / height);
  const x = 0.5 - ((left + right) / 2) * side;
  const y = windowHeight - FLOOR - bottom * side;
  const pct = (value: number) => `${+(value * 100).toFixed(2)}%` as const;
  return {
    position: 'absolute' as const,
    width: pct(side),
    aspectRatio: 1,
    left: pct(x),
    top: pct(y * SHOWCASE_ASPECT),
  };
}
