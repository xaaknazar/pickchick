import type { ImageSourcePropType } from 'react-native';
// Owner 25.11.2026 (menu «Витрина»): transparent cut-outs of the bundled combo photos, drawn over
// the light window so the food rises above its top edge. Used only while the product still shows
// its bundled photo; an uploaded back-office photo keeps the plain window.
export const menuCutouts: Record<string, ImageSourcePropType> = {
  'pick-combo': require('../assets/menu-cutout/pick-combo.webp'),
  'master-combo': require('../assets/menu-cutout/master-combo.webp'),
  'burger-combo': require('../assets/menu-cutout/burger-combo.webp'),
  'solo-combo': require('../assets/menu-cutout/solo-combo.webp'),
  'finger-duo': require('../assets/menu-cutout/finger-duo.webp'),
  'burger-duo': require('../assets/menu-cutout/burger-duo.webp'),
  'mix-duo': require('../assets/menu-cutout/mix-duo.webp'),
  'fingers-25': require('../assets/menu-cutout/fingers-25.webp'),
  'fingers-50': require('../assets/menu-cutout/fingers-50.webp'),
  'fingers-75': require('../assets/menu-cutout/fingers-75.webp'),
  'fingers-100': require('../assets/menu-cutout/fingers-100.webp'),
  burger: require('../assets/menu-cutout/burger.webp'),
  wedges: require('../assets/menu-cutout/wedges.webp'),
  toast: require('../assets/menu-cutout/toast.webp'),
  sauce: require('../assets/menu-cutout/sauce.webp'),
  'sauce-hot': require('../assets/menu-cutout/sauce-hot.webp'),
};
