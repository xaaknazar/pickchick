import type { ImageSourcePropType } from 'react-native';
export const photoHeroes: Record<string, ImageSourcePropType> = {
  'burger-duo': require('../assets/product-photo/burger-duo-blue.png'),
  'finger-duo': require('../assets/product-photo/finger-duo.png'),
  burger: require('../assets/product-photo/burger.png'),
};
// Retouched catalog references. Unknown packaging gets an explicit photo placeholder.
export const optionPhotos: Record<string, ImageSourcePropType> = {
  'cola-bottle': require('../assets/product-photo/cola-bottle.png'),
  lemonade: require('../assets/product-photo/lemonade-hd.png'),
  'cola-can': require('../assets/product-photo/cola-can-hd.png'),
  'fuse-peach': require('../assets/product-photo/fuse-peach-hd.png'),
  'iced-tea-sweet': require('../assets/product-photo/iced-tea-hd.png'),
  'iced-tea-unsweet': require('../assets/product-photo/iced-tea-hd.png'),
  water: require('../../../design/prototype/assets/mockup/i23.jpg'),
  pick: require('../assets/product-photo/signature-sauce.png'),
  hot: require('../../../design/prototype/assets/mockup/i19.jpg'),
};
