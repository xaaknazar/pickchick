# Фотографии напитков владельца - мобильное приложение, 12 октября 2026

Побайтовые копии фотографий владельца, подключённых в киоске 8 октября:
точная обрезка скриншота + альфа-маска, исходный RGB, без генерации и без
изменения размера. Источник, координаты обрезки и SHA256 -
[apps/kiosk/assets/drinks/provenance.json](../../../kiosk/assets/drinks/provenance.json),
описание - [docs/operations/kiosk-drink-photos.md](../../../../docs/operations/kiosk-drink-photos.md).
Пиксели не редактировать; совпадение SHA256 с киоском проверяет
`tests/unit/catalog-images.test.mjs`.

| Файл                     | Товар / выбор напитка (id)  | Источник копии                                                              |
| ------------------------ | --------------------------- | --------------------------------------------------------------------------- |
| fuse-peach.png           | `fuse-peach`, ключ `i1.jpg` | apps/kiosk/assets/drinks                                                    |
| fuse-mango-chamomile.png | `fuse-mango`                | apps/kiosk/assets/drinks                                                    |
| fuse-mango-pineapple.png | `fuse-mango-pineapple`      | docs/operations/images/kiosk-drink-photos/reference-only (вкуса нет в меню) |
| bonaqua-still.png        | `water`, ключ `i23.jpg`     | apps/kiosk/assets/drinks                                                    |
| cola-classic.png         | `cola-bottle` (бутылка)     | apps/kiosk/assets/drinks                                                    |
| cola-zero.png            | `cola-zero` (бутылка)       | apps/kiosk/assets/drinks                                                    |
| sprite.png               | `sprite` (бутылка)          | apps/kiosk/assets/drinks                                                    |
| fanta.png                | `fanta` (бутылка)           | apps/kiosk/assets/drinks                                                    |
| piko-apple.png           | `piko`, `piko-apple`        | apps/kiosk/assets/drinks                                                    |
| piko-orange.png          | `piko-orange`               | apps/kiosk/assets/drinks                                                    |

Сопоставление по id - `src/drink-photos.ts` и `ownerDrinkPhotoIds` в
`src/product-photo.ts`. Фото используется в меню, на странице товара, в выборе
напитка комбо, корзине, рекомендациях и заказах. Загруженное в бэк-офисе фото
важнее. Фото по id применяется, пока опубликованный ключ - исходный ключ товара
или `generic-drink` (так бэк-офис публикует новые напитки); другой выбранный
ключ важнее.

- Piko в каталоге без вкуса: показана упаковка «яблоко», пока владелец не
  выберет иначе. Подготовленные вкусы `piko-apple` / `piko-orange` получают свои фото.
- Только точная упаковка: фото бутылок не используются для банок (`cola`,
  `cola-can`, `cola-zero-can`, `sprite-can`, `fanta-can`).
- Без фото владельца остаются прежние изображения: лимонад, банка Coca-Cola,
  холодный чай, Fuse Tea ягода и арбуз (выбор в комбо). Новые товары без фото
  владельца (`fuse-berry`, `fuse-watermelon`, `fuse-strawberry-melon`, `fuse-lemon`,
  банки) по-прежнему показывают логотип.
- Портретные кадры 320×795 (Piko 310×585) показываются целиком (`contain`) на
  прежних подложках плиток. На странице товара прозрачная бутылка стоит на фоне
  страницы с отступами, без нижнего перехода, который нужен непрозрачным фото.
