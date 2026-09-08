/* Metro requires literal paths to bundle these original, supplied brand assets. */
import type { ImageSourcePropType } from 'react-native';

export const assets = {
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
  combo: require('../../../design/prototype/assets/mockup/i7.jpg') as ImageSourcePropType,
  fingers: require('../../../design/prototype/assets/mockup/i4.jpg') as ImageSourcePropType,
  wedges: require('../../../design/prototype/assets/mockup/i20.jpg') as ImageSourcePropType,
  drink: require('../../../design/prototype/assets/mockup/i2.jpg') as ImageSourcePropType,
  sauce: require('../../../design/prototype/assets/mockup/i18.jpg') as ImageSourcePropType,
};
