// Bundled photos for the installed v1/v2 menu keys (/assets/menu/iN.jpg).
export const photos = {
  '/assets/menu/i7.jpg': '/v2/assets/menu-00.png',
  '/assets/menu/i8.jpg': '/v2/assets/menu-01.png',
  '/assets/menu/i9.jpg': '/v2/assets/menu-02.png',
  '/assets/menu/i10.jpg': '/v2/assets/menu-03.png',
  '/assets/menu/i11.jpg': '/v2/assets/menu-04.png',
  '/assets/menu/i12.jpg': '/v2/assets/menu-05.png',
  '/assets/menu/i13.jpg': '/v2/assets/menu-06.png',
  '/assets/menu/i14.jpg': '/v2/assets/menu-07.png',
  '/assets/menu/i15.jpg': '/v2/assets/menu-08.png',
  '/assets/menu/i16.jpg': '/v2/assets/menu-09.png',
  '/assets/menu/i17.jpg': '/v2/assets/menu-10.png',
  '/assets/menu/i4.jpg': '/v2/assets/menu-11.png',
  '/assets/menu/i18.jpg': '/v2/assets/menu-12.png',
  '/assets/menu/i19.jpg': '/v2/assets/menu-13.jpg',
  '/assets/menu/i5.jpg': '/v2/assets/menu-14.png',
  '/assets/menu/i6.jpg': '/v2/assets/menu-15.png',
  '/assets/menu/i20.jpg': '/v2/assets/menu-16.png',
  '/assets/menu/shot.jpg': '/v2/assets/menu-17.png',
  '/assets/menu/i0.jpg': '/v2/assets/menu-18.png',
  '/assets/menu/i2.jpg': '/v2/assets/menu-19.png',
  '/assets/menu/i1.jpg': '/v2/assets/menu-20.png',
  '/assets/menu/i22.jpg': '/v2/assets/menu-21.png',
  '/assets/menu/i23.jpg': '/v2/assets/menu-22.png',
};
const HASHED = /^\/assets\/menu\/[a-f0-9]{64}\.webp$/;
/** A published photo is content-addressed and loaded through the local edge
 *  (/assets/menu/<sha256>.webp, verified by the local server). The bundled PNGs replace
 *  only the legacy iN.jpg keys; other local paths are served as they are. */
export function photoFor(item) {
  if (item.image && HASHED.test(item.image.url)) return item.image.url;
  if (!item.image_url) return undefined;
  if (Object.hasOwn(photos, item.image_url)) return photos[item.image_url];
  return item.image_url;
}
