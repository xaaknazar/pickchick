import {
  TestCatalogSchema,
  TEST_BRANCH_ID,
  TEST_CATALOG_VERSION,
  TEST_NAMESPACE,
} from './contracts.js';

// Approved only as synthetic design fixtures. Never a production price/menu publication.
const rows: [string, string, string, string, string, boolean][] = [
  ['pick-combo', 'Pick Combo', 'Комбо', '349000', 'i7.jpg', true],
  ['master-combo', 'Master Combo', 'Комбо', '569000', 'i8.jpg', true],
  ['burger-combo', 'Burger Combo', 'Комбо', '629000', 'i9.jpg', true],
  ['solo-combo', 'Solo Combo', 'Комбо', '249000', 'i10.jpg', true],
  ['finger-duo', 'Finger Duo', 'На двоих', '569000', 'i11.jpg', true],
  ['mix-duo', 'Mix Duo', 'На двоих', '629000', 'i13.jpg', true],
  ['fingers-25', '25 Fingers', 'На компанию', '1299000', 'i14.jpg', true],
  ['fingers', 'Фингерсы', 'Допы', '59000', 'i4.jpg', true],
  ['toast', 'Тост', 'Допы', '29000', 'i5.jpg', true],
  ['cola', 'Coca-Cola', 'Напитки', '69000', 'i2.jpg', false],
  ['sauce', 'Фирменный соус', 'Соусы', '29000', 'i18.jpg', false],
];
export const testCatalog = TestCatalogSchema.parse({
  synthetic: true,
  namespace: TEST_NAMESPACE,
  branch_id: TEST_BRANCH_ID,
  catalog_version: TEST_CATALOG_VERSION,
  currency: 'KZT',
  products: rows.map(([id, name, category, price_minor, image_id, prep_required]) => ({
    id,
    name,
    category,
    price_minor,
    image_id,
    prep_required,
    description: 'Тестовое блюдо из мокапа Pick Chick. Не предложение реального ресторана.',
  })),
});
