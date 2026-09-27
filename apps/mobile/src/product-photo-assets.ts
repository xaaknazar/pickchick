import type { ImageSourcePropType } from 'react-native';
export const photoHeroes: Record<string, ImageSourcePropType> = {
  'finger-duo': require('../assets/product-photo/finger-duo.png'),
  burger: require('../assets/product-photo/burger.png'),
};
// Only exact catalog images. Unknown packaging gets an explicit photo placeholder.
export const optionPhotos: Record<string, ImageSourcePropType> = {
  'cola-bottle': require('../assets/product-photo/cola-bottle.png'),
  lemonade: require('../../../design/prototype/assets/mockup/i0.jpg'),
  'cola-can': require('../../../design/prototype/assets/mockup/i2.jpg'),
  'fuse-peach': require('../../../design/prototype/assets/mockup/i1.jpg'),
  'iced-tea-sweet': require('../../../design/prototype/assets/mockup/i22.jpg'),
  'iced-tea-unsweet': require('../../../design/prototype/assets/mockup/i22.jpg'),
  water: require('../../../design/prototype/assets/mockup/i23.jpg'),
  pick: require('../assets/product-photo/signature-sauce.png'),
  hot: require('../../../design/prototype/assets/mockup/i19.jpg'),
};
