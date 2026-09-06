import logo from '../../../design/prototype/assets/mockup/logo.png';
import hero from '../../../design/prototype/assets/mockup/hero.mp4';
import poster from '../../../design/prototype/assets/mockup/hero-poster.jpg';
import bluePattern from '../../../design/prototype/assets/mockup/bg-blue.png';
import combo from '../../../design/prototype/assets/mockup/promo-pick-combo-cut.png';

const images = import.meta.glob(
  [
    '../../../design/prototype/assets/mockup/i7.jpg',
    '../../../design/prototype/assets/mockup/i8.jpg',
    '../../../design/prototype/assets/mockup/i9.jpg',
    '../../../design/prototype/assets/mockup/i10.jpg',
    '../../../design/prototype/assets/mockup/i11.jpg',
    '../../../design/prototype/assets/mockup/i13.jpg',
    '../../../design/prototype/assets/mockup/i14.jpg',
    '../../../design/prototype/assets/mockup/i4.jpg',
    '../../../design/prototype/assets/mockup/i5.jpg',
    '../../../design/prototype/assets/mockup/i2.jpg',
    '../../../design/prototype/assets/mockup/i18.jpg',
  ],
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
) as Record<string, string>;

export const assets = { logo, hero, poster, bluePattern, combo };
export function productImage(id: string): string | undefined {
  return images[`../../../design/prototype/assets/mockup/${id}`];
}
