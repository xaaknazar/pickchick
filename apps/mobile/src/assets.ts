/* Metro requires literal paths to bundle these original, supplied brand assets. */
import type { ImageSourcePropType } from 'react-native';

export const assets = {
  kaspi: require('../assets/payments/kaspi.png') as ImageSourcePropType,
  pickManCover: require('../assets/games/pick-man-cover.png') as ImageSourcePropType,
  pickManChick: require('../assets/games/pick-man-chick.png') as ImageSourcePropType,
  burger: require('../assets/catalog-hd/burger.png') as ImageSourcePropType,
  pickBlocksCover: require('../assets/games/pick-blocks-cover.png') as ImageSourcePropType,
  logo: require('../../../design/prototype/assets/mockup/logo.png') as ImageSourcePropType,
  skyline: require('../../../design/prototype/assets/mockup/skyline.svg') as ImageSourcePropType,
  mix: require('../../../design/prototype/assets/mockup/bg-mix.png') as ImageSourcePropType,
  pickrunRunner: require('../../../design/prototype/assets/mockup/i26.jpg') as ImageSourcePropType,
  blue: require('../../../design/prototype/assets/mockup/bg-blue.png') as ImageSourcePropType,
  orange: require('../../../design/prototype/assets/mockup/bg-orange.png') as ImageSourcePropType,
  poster: require('../../../design/prototype/assets/mockup/hero-poster.jpg') as ImageSourcePropType,
  hero: require('../../../design/prototype/assets/mockup/hero.mp4') as number,
  pickrun:
    require('../../../design/prototype/assets/mockup/pickrun-poster.png') as ImageSourcePropType,
  combo: require('../assets/catalog-hd/pick-combo.png') as ImageSourcePropType,
  fingers: require('../assets/catalog-hd/fingers.png') as ImageSourcePropType,
  wedges: require('../assets/catalog-hd/wedges.png') as ImageSourcePropType,
  drink: require('../assets/catalog-hd/cola.png') as ImageSourcePropType,
  sauce: require('../assets/catalog-hd/sauce.png') as ImageSourcePropType,
};
