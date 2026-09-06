import type { MenuSnapshot } from '@pickchick/contracts';
import type { Product, Locale } from './model';
import type { TestCatalog } from '@pickchick/test-order-flow/contracts';

export const DESIGN_RELEASE = 'mockup-v0.2';
const rows: [string, string, string, string, number][] = [
  [
    'pick-combo',
    'Pick Combo',
    'Комбо',
    '349000',
    require('../../../design/prototype/assets/mockup/i7.jpg'),
  ],
  [
    'master-combo',
    'Master Combo',
    'Комбо',
    '569000',
    require('../../../design/prototype/assets/mockup/i8.jpg'),
  ],
  [
    'burger-combo',
    'Burger Combo',
    'Комбо',
    '629000',
    require('../../../design/prototype/assets/mockup/i9.jpg'),
  ],
  [
    'solo-combo',
    'Solo Combo',
    'Комбо',
    '249000',
    require('../../../design/prototype/assets/mockup/i10.jpg'),
  ],
  [
    'finger-duo',
    'Finger Duo',
    'На двоих',
    '569000',
    require('../../../design/prototype/assets/mockup/i11.jpg'),
  ],
  [
    'mix-duo',
    'Mix Duo',
    'На двоих',
    '629000',
    require('../../../design/prototype/assets/mockup/i13.jpg'),
  ],
  [
    'fingers-25',
    '25 Fingers',
    'На компанию',
    '1299000',
    require('../../../design/prototype/assets/mockup/i14.jpg'),
  ],
  [
    'fingers',
    'Фингерсы',
    'Допы',
    '59000',
    require('../../../design/prototype/assets/mockup/i4.jpg'),
  ],
  ['toast', 'Тост', 'Допы', '29000', require('../../../design/prototype/assets/mockup/i5.jpg')],
  [
    'cola',
    'Coca-Cola',
    'Напитки',
    '69000',
    require('../../../design/prototype/assets/mockup/i2.jpg'),
  ],
  [
    'sauce',
    'Фирменный соус',
    'Соусы',
    '29000',
    require('../../../design/prototype/assets/mockup/i18.jpg'),
  ],
];

export const designProducts: Product[] = rows.map(([id, name, category, priceMinor, image]) => ({
  id,
  name,
  category,
  priceMinor,
  image,
  source: 'design',
  description: 'Пример блюда из мокапа. Состав и цена требуют утверждения.',
}));

export function serverProducts(menu: MenuSnapshot | null, locale: Locale): Product[] {
  return (menu?.items ?? []).map((item) => ({
    id: item.variant_id,
    name: item.name[locale],
    priceMinor: item.price_minor,
    category: 'Меню',
    description: 'Тестовая позиция с сервера. Заказ пока недоступен.',
    image: require('../../../design/prototype/assets/mockup/i7.jpg'),
    source: 'server',
  }));
}

export function connectedProducts(catalog: TestCatalog): Product[] {
  return catalog.products.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    category: item.category,
    priceMinor: item.price_minor,
    image:
      designProducts.find((product) => product.id === item.id)?.image ??
      require('../../../design/prototype/assets/mockup/logo.png'),
    source: 'server',
  }));
}
