# Полоса «Каталог, цены каналов и реальное меню» - дизайн к переходу 19.11

База: `origin/codex/shared-development` 1a9472f1. Установлено: cloud c3a0fbee/schema 068, edge 020. Трекер: Аг4, М1-М6, Д2, КС7 (связь с КД1-КД4, КС5, К9, П3, Р4, И8, Ск2).

## 1. Текущее состояние

**Опубликованное меню.** Витрина отдаёт catalog v11 (14.10): 24 позиции макета, `content_source:'operator'`, цены тестовые (Pick Combo `9000` тиын, 13 позиций по 1 ₸), у всех комбо `combo_components: []`, у всех опций `linked_product_id: null` (снимок публичного `/v1/customer-checkout/catalog` от 05.11). Касса подтвердила его как menu8 (`docs/project-status.md:597-598`).

**Схема каталога** (`packages/catalog-admin/src/contracts.ts`):

- `products` до 100 (:120), групп до 10 (:108), опций до 20 (:67-68), payload до 256 KiB (:2, :130);
- `weight_g` - только целое (:91), `image_asset_key` только из 24 встроенных ключей (:3-28, :84);
- сумма default должна быть ≥ `min` группы (:174-175). В iiko default у обязательных групп нет (`docs/operations/iiko-menu-details-2026-09-28.md:118`).

**Цены каналов.** `channel_prices_minor` знает только `mobile|pos|kiosk` (:77-83). `assertCatalogPublishable` отклоняет всё, кроме `mobile` при мобильной витрине (:201-209). Проекция на кассу отклоняет любые цены каналов (`packages/menu-sync/src/catalog-projection.ts:129-130`). В бэк-офисе поля «Приложение/Касса/Киоск» есть, но публикацию блокируют (`apps/backoffice/src/editor.ts:139-143, 529-573`). Яндекс/Glovo в контрактах нет совсем. Касса считает только `item.price_minor + option.price_minor` (`packages/local-orders/src/pricing.ts:58-61`). `Quote.channel='pos'`, `discount_minor='0'` - литералы (`packages/contracts/src/index.ts:421,425`).

**Совместимость с установленными клиентами - главное ограничение.**

- Edge 020 разбирает меню строго; новые поля уходят только на кассу, которая заявила `menu_features` (`packages/contracts/src/index.ts:51-56, 311-317`; `packages/menu-sync/src/cloud.ts:23-45`; `worker.ts:29`). Установленный cloud c3a0fbee механизма `menu_features` ещё не имеет (проверено `git show c3a0fbee:packages/menu-sync/src/cloud.ts`).
- Киоск и mobile разбирают каталог строгой схемой; сервер вырезает новые поля в одном месте (`contracts.ts:213-228`; `packages/commerce-core/src/catalog-media.ts:30-37`).
- Клиенты зашивают slug'и и названия категорий:
  - киоск: хиты и бейджи (`apps/kiosk/src/menu-presentation.ts:12-26`), допродажа (`apps/kiosk/src/smartUpsell.ts:22-39`), разделы по RU-названию «Комбо/На двоих/На компанию/Напитки», всё прочее - «Допы» (`apps/kiosk/src/components/categories.ts:15-25`);
  - mobile: фото по id (`apps/mobile/src/product-photo-selection.ts:5-30`, `product-photo.ts:50-62`), комбо = id на `-combo|-duo|fingers-N` (`product-photo-selection.ts:41-42`), разделы по названию (`screens/CatalogScreens.tsx:504-508, 616`), большой соус ищется в группе `size` у `sauce` (`product-photo-selection.ts:147-153`);
  - подарок 7+1 жёстко `pick-combo` (`packages/contracts/src/combo-rewards.ts:8`; `packages/commerce-core/src/combo-reward-ledger.ts:96,153`).
- Идентичности кассы - хэш slug (`packages/menu-sync/src/availability.ts:6-16`, `catalog-projection.ts:194-195`). ID категории - хэш RU-названия (:145-165).

**Кухня.** Маршрут кассы - `prep|assembly_item`, по умолчанию из `prep_required` (`catalog-projection.ts:212-217`). Существующий маршрут продукта при новой публикации не меняется (`packages/menu-sync/src/routing.ts:77-90`). Строки POS уходят на кухню как `kind:'item', components:[]` (`packages/edge-fulfillment/src/local-pos.ts:47-64`): состав комбо для заказов кассы не раскрывается. План станций stage 2 несёт `product_ids` как свободный текст и маршрутизацией не используется (`packages/contracts/src/station-plans.ts:6-8, 28`; `packages/backoffice-core/src/model.ts:132-143`).

**Ловушки М2.**

- Связанная опция в облачном расчёте превращается в компонент (`packages/catalog-pricing/src/pricing.ts:130-134`). Компонент с группами модификаторов - `AMBIGUOUS_COMPONENT` (:114).
- Комбо без фиксированного состава, но со связанным напитком, теряет на кухне родительскую задачу: `unexpandedCombo` становится false (`packages/edge-fulfillment/src/model.ts:236-252`).
- Правило стопа уже работает без `linked_product_id`: опция стопится стопом продукта, чей slug равен id опции (`availability.ts:30-40, 50-57`; есть и в c3a0fbee).

**Реальные данные в репозитории.**

- Зал: все 54 позиции AILILLU - артикул, название, цена, вес (`docs/operations/iiko-menu-details-2026-09-28.md:33-114`). Правила 13 комбо и 33 опции с доплатами (:116-184).
- Яндекс 47 и Glovo 52 - только счётчики, 10 строк сравнения и 7 артикулов без цены (`docs/operations/real-menu.md:17-47`). **Полных прайсов доставки в репо нет.**
- ТТК: 165 рецептов с `product_id='ttk:<номер>'`, без привязки к меню (`docs/operations/ttk-import-2026-10-20.md:54-63`; `packages/backoffice-core/src/model.ts:65-80`).
- Скрипт паритета падает на любом изменении цены или удалении опции (`scripts/catalog-edge-parity.mjs:1-19, 73-80`). Для перехода он в нынешнем виде непригоден.

## 2. Целевое поведение по кодам

| Код                       | Поведение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| М1, Д2 (зал), Р4          | Один опубликованный каталог из 54 позиций с ценами AILILLU для кассы, киоска и приложения. Собирается из проверенного управляющим файла импорта. Публикуется штатным API **без изменения кода на установленных cloud/edge**: используются только существующие поля.                                                                                                                                                                                                                        |
| Аг4, Д2 (агрегаторы), КС5 | У продукта есть предложения сторонних каналов `channel_offers.yandex_eda/glovo`: наличие ключа = позиция есть в ассортименте канала; там цена, артикул агрегатора и необязательное название. У опций - необязательная доплата канала. Касса в режиме агрегатора берёт эти цены. Нет предложения - позицию в этом канале не продать (`CHANNEL_PRICES_UNAVAILABLE`, POS lane). Своим каналам (касса, киоск, приложение) - одна базовая цена: решение владельца 25.09 (`real-menu.md:51-52`). |
| М2                        | Опции напитков и соусов называются slug'ами отдельных товаров. Стоп «Кола» закрывает выбор колы во всех комбо через существующее правило, без `linked_product_id`. `combo_components` заполняются только по составу, который подтвердил шеф (P1). Связанные продукты - только после этого.                                                                                                                                                                                                 |
| М3, КД2-КД4               | У продукта `production` = `kitchen_class` + число фингерсов/бургеров/тостов на 1 шт. У группы - `production.kitchen_class` (напитки и соусы видит только выдача). Касса получает их в меню и отдаёт KDS lane. `prep_minutes` - время приготовления.                                                                                                                                                                                                                                        |
| М4                        | Перед публикацией: паритет «касса ↔ новый каталог» со списком ожидаемых изменений. После публикации: паритет «каталог ↔ касса ↔ приложение ↔ киоск» - те же позиции, цены, группы и версии.                                                                                                                                                                                                                                                                                                |
| М5                        | В файле импорта статусы фото, описания, KK и КБЖУ. КБЖУ и аллергены публикуются только `unverified/unknown`.                                                                                                                                                                                                                                                                                                                                                                               |
| М6                        | Стоп реального блюда виден в приложении и киоске сразу. На кассе стоп комбо по компоненту - только на новой кассе с `combo_stops`.                                                                                                                                                                                                                                                                                                                                                         |
| КС7                       | Скидок в каталоге нет. Модель - в п. 4.5, P1.                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 3. Данные и миграции

**Миграции для P0 не нужны.** Каталог хранится в `jsonb` (`db/cloud/migrations/009_cloud_catalog_admin.sql:33-38`), снимок edge - в `menu_snapshots.payload`. P1 cloud-NEXT: `ALTER TABLE edge_menu_state ADD COLUMN menu_features text[] NOT NULL DEFAULT '{}'`, чтобы бэк-офис видел, примет ли касса цены агрегаторов.

### 3.1 Payload каталога (cloud, `CatalogPayloadSchema`, все поля optional)

```ts
const AggregatorPrices = z.strictObject({ yandex_eda: Minor.optional(), glovo: Minor.optional() });
CatalogChannelOfferSchema = z.strictObject({ price_minor: Minor, external_sku: Sku.optional(), name: Title.optional() });
CatalogProduct += {
  channel_offers?: { yandex_eda?: Offer; glovo?: Offer },     // ключ есть = позиция в ассортименте канала
  production?: { kitchen_class: KitchenClass, fingers?: 1..1000, burgers?: 1..100, toasts?: 1..100 },
}
CatalogModifier += { production?: { kitchen_class } }
CatalogModifier.options[] += { channel_price_delta_minor?: AggregatorPrices }   // пусто = доплата зала
```

Правила `superRefine`:

- `external_sku` уникален внутри канала;
- доплата канала у опции разрешена только при предложении этого канала у продукта;
- у `drink|sauce` нет счётчиков; `kitchen_class:'combo'` только при `kind≠'item'`;
- при непустом `combo_components` счётчики должны совпасть с суммой по компонентам;
- нулей нет: отсутствие поля = 0, так checksum остаётся стабильным.

### 3.2 Меню кассы (`MenuSnapshotSchema`, только кассам с фичей)

```ts
MenuItem += channel_offers?: { yandex_eda?: { price_minor, external_sku?, name? }, glovo?: … }   // фича channel_offers
MenuModifierOption += channel_prices_minor?: { yandex_eda?: Money, glovo?: Money }             // фича channel_offers
MenuItem += production?: { kitchen_class, fingers?, burgers?, toasts? }                         // фича kitchen_production
MenuModifierGroup += production?: { kitchen_class }                                             // фича kitchen_production
```

### 3.3 Файл импорта (проверяет управляющий, публикует Codex)

Таблица (Google/Excel) из 4 листов. Codex выгружает каждый лист в UTF-8 TSV в `.local/menu-import/2026-11/`. Исходник приватный, как ТТК; в Git идут инструмент, синтетические тесты и обезличенный отчёт с SHA-256.

1. **Позиции** (54 строки):
   - `slug`, `iiko_sku`, `category`, `kind`, `name_ru`, `name_kk`, `price_tenge`;
   - `serving_ru`, `weight_g`, `volume_ml`, `prep_minutes`, `kitchen_route`;
   - `kitchen_class`, `fingers`, `burgers`, `toasts`;
   - `image_asset_key`, `photo_file`, `description_ru/kk`, `ttk_no`;
   - `yandex_sku`, `yandex_name`, `yandex_price_tenge`, `glovo_sku`, `glovo_name`, `glovo_price_tenge`;
   - `sort`, `status(ок/исправить)`, `comment`.
2. **Группы выбора**: `group_id`, `title_ru/kk`, `kitchen_class`, `option_id`, `iiko_sku`, `label_ru/kk`, `delta_tenge`, `yandex_delta_tenge`, `glovo_delta_tenge`, `max_quantity`.
3. **Правила комбо**: `product_slug`, `group_id`, `min`, `max`, `default_option_id`, `default_qty` (13×5).
4. **Состав комбо** (М2, к P0 может быть пустым): `product_slug`, `component_slug`, `quantity`.

**Заполнение из репо.**

- Зал, 13 правил и 33 опции - из `iiko-menu-details-2026-09-28.md:33-184`. Тенге ×100 = тиын, только целые тенге.
- Вес iiko с дробью или 0 → `weight_g` пусто, точное значение - в `serving_ru` после подтверждения (`:186-189`).
- КБЖУ = 0 + `unverified`, аллергены `[]` + `unknown`.
- KK - из словаря `docs/translations/mobile-ru-kk-en.md` (например, «Картоп тілімдері»), остальное помечается. Пустое KK касса показывает как `-` (`catalog-projection.ts:144`).
- Колонки Яндекс/Glovo **заполняет управляющий**: из внешних меню iikoWeb 84799/87014 на чтение или из кабинетов агрегаторов. UNCONFIRMED: источника в репо нет.

**Предлагаемое соответствие slug** (сохраняем все 24 slug'а макета: фото, хиты, 7+1, стопы и маршруты кассы остаются):

| iiko                                                                  | slug                                                                                                                                       | Категория   | Кухня (предложение, утверждает шеф)  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------ |
| 00144 Finger Combo                                                    | `pick-combo` (подарок 7+1)                                                                                                                 | Комбо       | combo, fingers ?                     |
| 00145 Master / 00147 Solo                                             | `master-combo` / `solo-combo`                                                                                                              | Комбо       | combo, ?                             |
| 00146 Pick Burger Combo                                               | `burger-combo` (UNCONFIRMED: Pick или Chick)                                                                                               | Комбо       | combo, burgers 1, ?                  |
| 00399 Pick Meal / 00437 Chick Burger Combo / 00438 Chick Meal         | `pick-meal-combo` / `chick-burger-combo` / `chick-meal-combo` (новые, суффикс для mobile)                                                  | Комбо       | combo, ?                             |
| 00232 Finger Duo / 00441 Pick Burger Duo / 00242 Mix Duo c Pick       | `finger-duo` / `burger-duo` / `mix-duo` (UNCONFIRMED)                                                                                      | На двоих    | combo, ?                             |
| 00241 Chick Burger Duo / 00440 Mix Duo c Chick / 00442 Mix Burger Duo | `chick-burger-duo` / `mix-chick-duo` / `mix-burger-duo`                                                                                    | На двоих    | combo, ?                             |
| 00162-00165 фингерсы 25-100                                           | `fingers-25..100` (`kind:'set'`)                                                                                                           | На компанию | fingers 25/50/75/100 (UNCONFIRMED)   |
| 00150 Куриный фингерс                                                 | `fingers`                                                                                                                                  | Допы        | fingers 1 (в ТТК 5 шт - UNCONFIRMED) |
| 00194 Pick Burger / 00434 Chick Burger                                | `burger` / `chick-burger`                                                                                                                  | Допы        | burger, burgers 1, fingers ?         |
| 00148 тост / 00149 коул-слоу / 00151 дольки                           | `toast` / `coleslaw` / `wedges`                                                                                                            | Допы        | toast 1 / side / side                |
| 12 соусов: фирменный, острый, сырный × 60/300/400/500                 | `sauce`, `sauce-300`..`sauce-500`, `sauce-hot`, `sauce-hot-300`.., `sauce-cheese`..                                                        | Соусы       | sauce                                |
| колы: 00159 / 00209 жб / 00231 зеро / 00414 зеро жб                   | `cola-bottle` / `cola` (было «банка») / `cola-zero` / `cola-zero-can`                                                                      | Напитки     | drink                                |
| 00161/00210, 00160/00211                                              | `sprite`/`sprite-can`, `fanta`/`fanta-can`                                                                                                 | Напитки     | drink                                |
| 7 Fuse                                                                | `fuse-peach`, `fuse-berry`, `fuse-mango` (манго-ромашка), `fuse-mango-pineapple`, `fuse-watermelon`, `fuse-lemon`, `fuse-strawberry-melon` | Напитки     | drink                                |
| 00158 / 00197 / 00195 / 00198                                         | `lemonade` / `water` / `piko` (вкусы сохраняются) / `iced-tea`                                                                             | Напитки     | drink                                |

**Группы комбо.** Сохраняем id `drink` и `sauce`: их UUID на кассе не меняются.

- `drink` - 20 опций, id = slug напитков; `piko-apple`/`piko-orange` вместо «-сок 0,2».
- `sauce` (бесплатный дип) - `sauce`, `sauce-hot`, `sauce-cheese`, `ketchup`, `bbq`.
- Три платные группы `sauce-paid-signature|cheese|hot`. id опций `sauce-300` и т.д. - только после подтверждения шефа (`iiko-menu-details:184`); до того - `sauce-plus-790`.
- Группа `extras` и `size` у соусов удаляются.

Шесть категорий: «Комбо», «На двоих», «На компанию», «Допы», «Соусы», «Напитки». Их понимают киоск и mobile. «Соусы» в киоске попадают в «Допы».

## 4. API и контракты

**4.1 HTTP.** Новых маршрутов в P0 нет.

- `PUT /v1/admin/catalog/branches/:id/draft` и `POST …/publish` (`services/api/src/catalog-admin-controller.ts:91-104`) несут новые поля. Публикация с `channel_offers`, пока выключен флаг, - `409 CHANNEL_PRICES_NOT_SUPPORTED` (как сейчас).
- `GET /edge/v1/menu` (`services/edge/src/index.ts:24-34`) отдаёт поля, если они есть в применённом меню.
- Публичный `GET /v1/branches/:id/menu` вырезает все кассовые поля (`services/api/src/index.ts:138-152`).
- `CatalogState.publication_support += { channel_offers: boolean, production: boolean }`.

**4.2 Перечисления** (`packages/contracts/src/sales-channels.ts`, новый, общий с POS lane):

```ts
SalesChannelSchema = z.enum(['hall', 'yandex_eda', 'glovo']);
AggregatorChannelSchema = SalesChannelSchema.exclude(['hall']);
KitchenClassSchema = z.enum([
  'combo',
  'fingers',
  'burger',
  'toast',
  'side',
  'drink',
  'sauce',
  'other',
]);
EdgeMenuFeatureSchema = z.enum(['combo_stops', 'channel_offers', 'kitchen_production']);
```

**4.3 Доставка меню.** `deliveredForm(event, features)` (`cloud.ts:40-45`) обобщается:

- для каждой незаявленной фичи применяется свой стриппер: `withoutComboStopLinks`, `withoutChannelOffers`, `withoutProduction`;
- каждый возвращает тот же объект, если вырезать нечего, - байт-в-байт как сейчас.

`acknowledgeMenu` (`cloud.ts:254-261`) принимает checksum любой из 8 форм (подмножества `KNOWN_FEATURES`). Касса новой сборки заявляет `EDGE_MENU_FEATURES = ['combo_stops','channel_offers','kitchen_production']` (`worker.ts:29`); это только разбор, поведения нет. Событие `menu.published` и его конверт не меняются.

**4.4 Цена канала.** Чистые функции в `packages/menu-sync/src/channel-offers.ts`, вызывает их `priceCart` (POS lane):

```ts
channelItemPriceMinor(item, ch): string|null    // hall → item.price_minor; агрегатор → offer?.price_minor ?? null
channelOptionPriceMinor(option, ch): string     // hall → option.price_minor; агрегатор → option.channel_prices_minor?.[ch] ?? option.price_minor
```

Правило «доплата агрегатора = доплата зала, если не задана» - UNCONFIRMED (вопрос 5).

**Учёт и офлайн.** Цена фиксируется в строке quote. Quote ссылается на `release_id`/`menu_version`, публикации неизменяемы (`009:91`), значит прайс любой продажи восстанавливается. В облако идут обычные строки заказа и `sales_channel` (POS lane). Без WAN касса продаёт по последнему применённому меню, включая цены агрегаторов. Публикация требует WAN.

**Идемпотентность.** `save` берёт `request_id` из SHA-256 manifest. Повтор возвращает квитанцию (`packages/catalog-admin/src/index.ts:299-312`). `publish` защищён `expected_published_version`. Применение на кассе идемпотентно по `release_id`/checksum.

**4.5 Скидки (КС7, P1, после И8).** Каталог не меняется.

- Запись бэк-офиса `discount`: `{name_ru, kind:'percent'|'amount', value, scope:'order'|'products', product_slugs[], channels:['hall'], requires_manager:true, active, window, stackable:false}`.
- Доставка на кассу - тем же протоколом версий и квитанций, что план станций (070/024).
- Касса заполняет `discount_minor` в quote. Подтверждение менеджера - approvals POS lane.
- Агрегаторам скидки PickChick не применяются.

## 5. Интерфейс (RU)

**Бэк-офис, карточка товара** (`apps/backoffice/src/editor.ts`):

- Раздел «Цены агрегаторов» (при `publication_support.channel_offers`):
  - флажки «Продаётся в Яндекс Еде» и «Продаётся в Glovo»;
  - поля «Цена в Яндекс Еде, ₸», «Артикул Яндекс Еды», «Название в Яндекс Еде» (и так же для Glovo);
  - подсказка: «Цены зала, киоска и приложения - базовая цена. Здесь только заказы, которые кассир вводит с планшета агрегатора.»;
  - ошибка: «Укажите цену в Яндекс Еде или снимите отметку «Продаётся в Яндекс Еде».».
- У опции: «Доплата в Яндекс Еде, ₸» и «Доплата в Glovo, ₸», пусто = «как в зале».
- Раздел «Кухня»:
  - «Тип позиции для кухни»: Комбо / Фингерсы / Бургер / Тост / Гарнир / Напиток / Соус / Другое;
  - «Фингерсов в 1 шт», «Бургеров в 1 шт», «Тостов в 1 шт»;
  - у группы: «Кто видит выбор»: «Только выдача (напитки, соусы)» / «Сборка и выдача»;
  - подсказка: «Экран панировки считает фингерсы по этому числу. Напитки и соусы видит только выдача.».
- Пока флаг выключен, старый текст про блокировку публикации (`editor.ts:568-571`) остаётся.
- Список товаров: колонки «Яндекс» и «Glovo» с ценой или `-` (обычный дефис).

**Касса** (реализует POS lane, тексты - отсюда):

- в режиме агрегатора плитка показывает цену канала и вторую строку «Яндекс: <название>, арт. <sku>»;
- позиция без предложения неактивна: «Нет в меню Яндекс Еды» / «Нет в меню Glovo».

**Файл импорта и отчёт для управляющего** (`review.md`, по-русски):

- по каждой позиции: «было (v11) → стало»;
- колонки «Проверено» и «Исправить»;
- итог: «Позиций: 54, без KK: N, без фото: N, без цены Яндекс/Glovo: N».

Киоск и приложение в P0 не меняются.

## 6. Изменения по файлам

- `packages/contracts/src/sales-channels.ts` (новый): enum'ы из 4.2.
- `packages/contracts/src/index.ts`: `MenuChannelOfferSchema`, optional поля из 3.2, расширение `EdgeMenuFeatureSchema`.
- `packages/catalog-admin/src/contracts.ts`:
  - схемы из 3.1;
  - `CATALOG_STOREFRONT_STRIPPED_FIELDS += channel_offers, production`;
  - `stripStorefrontPayload` также чистит `options[].channel_price_delta_minor` и `modifier_groups[].production`;
  - `assertCatalogPublishable(payload, {mobile, channelOffers})`.
- `packages/catalog-admin/src/index.ts`: флаги `CATALOG_CHANNEL_OFFERS_ENABLED` и `CATALOG_EDGE_PRODUCTION_ENABLED` в `catalogAdminOptions` (:52-90), `publication_support`, проброс опций проекции (:396-403).
- `packages/menu-sync/src/catalog-projection.ts`: опции `{channelOffers, production}`, проекция полей (ID опций - те же UUID), `withoutChannelOffers`, `withoutProduction`, `withoutEdgeOnlyFields`.
- `packages/menu-sync/src/cloud.ts`: `deliveredForm` по фичам, ACK по 8 формам.
- `packages/menu-sync/src/worker.ts`: `EDGE_MENU_FEATURES`.
- `packages/menu-sync/src/channel-offers.ts` (новый) + `index.ts`: функции из 4.4.
- `services/api/src/index.ts:151`: `withoutEdgeOnlyFields`.
- `packages/commerce-core/src/catalog-media.ts`: без изменения API, проверка теста строгой схемы.
- `apps/backoffice/src/editor.ts`, `domain.ts` (:121-134): разделы из п. 5 и валидация.
- `scripts/catalog-menu-import.mjs` (новый):
  - `build --dir --current <admin-state.json> --edge <edge-menu.json> --out` → `payload.json`, `review.md`, `expected-edge-changes.json`, `manifest.json` (SHA-256 входов и выходов, `errors[]`);
  - `save --manifest --reviewed-by "<ФИО>"` - единственное место, где ставится `content_reviewed:true`;
  - `publish --manifest` с `confirmation:'publish_catalog'`;
  - бюджет payload ≤ 230 KiB.
- `scripts/catalog-edge-parity.mjs`: `--allow <expected-edge-changes.json>` - проходит, только если фактические отличия совпадают со списком.
- `scripts/catalog-channel-parity.mjs` (новый): `--catalog --edge --mobile [--kiosk]`. Сверяет наборы, `name.ru`, цены, группы и опции, версии (`edge_delivery.status='applied'`), предложения и `production` у кассы. Exit 0/1/2.
- `packages/test-fixtures`: фикстура реального меню (54 позиции, цены из docs).
- Документы: `docs/operations/real-menu-cutover-2026-11.md` (runbook), `docs/02-data-and-api.md`, `docs/operations/menu-sync.md` (фичи), `docs/project-status.md`, `docs/roadmap/project.json`.

## 7. Флаги и безопасный выпуск

| Флаг                                        | Где         | По умолчанию | Что включает                                                                                                                   |
| ------------------------------------------- | ----------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `CATALOG_CHANNEL_OFFERS_ENABLED`            | API         | `false`      | Публикация с `channel_offers`/доплатами канала, проекция их на кассу. Выкл: черновик хранит, публикация 409, проекция без них. |
| `CATALOG_EDGE_PRODUCTION_ENABLED`           | API         | `false`      | `production` в проекции. Выкл: релиз байт-в-байт прежний.                                                                      |
| фичи `channel_offers`, `kitchen_production` | сборка edge | заявляются   | Только разбор. Использование - флаги POS (`pos_sale`) и KDS.                                                                   |

Порядок:

1. **06-10.11, без деплоя.** М1 на установленных c3a0fbee/edge 020:
   - `build`, затем отчёт управляющему и подпись (Р4 08.11);
   - `catalog-edge-parity --allow`;
   - `save`, затем `publish`;
   - касса применяет (новые позиции получают маршрут `prep|assembly_item`);
   - `catalog-channel-parity`;
   - М6.

   Цены в приложении и киоске меняются **в момент публикации**.

2. **Деплой cloud + edge** вместе со stage 2 и POS/KDS lane (флаги выкл). Проверить: меню применено, релиз прежний.
3. **До Т7 (16.11).**
   - Включить оба флага, опубликовать v+1 (данные агрегаторов и М3 уже в черновике).
   - Проверить: касса заявляет фичи; `/edge/v1/menu` содержит `channel_offers`; паритет чистый.
   - Касса продолжает работать, пока POS/KDS флаги выключены.

**Откат.** Флаги в `false` и повторная публикация: касса получает релиз без новых полей. POS-агрегатор показывает «нет цен канала». Витрины всё время получают тот же вырезанный payload. Откат самого меню - публикация v11-копии через `save`/`publish` (новая версия, история неизменна).

## 8. Тесты

**Новые:**

- `tests/unit/catalog-menu-import.test.mjs`:
  - тенге→тиын, отказ от дробных тенге;
  - default ≥ min, 20 опций, 100 позиций, 230 KiB;
  - суффикс `-combo|-duo` у `kind:'combo'`, отсутствие v11-slug = ошибка;
  - категории;
  - строка агрегатора без цены → `CHANNEL_PRICE_MISSING`;
  - детерминированный manifest и `request_id`.
- `tests/unit/catalog-channel-offers.test.mjs`: схема, уникальность `external_sku`, доплата без предложения, счётчики vs компоненты, публикация 409 при выкл. флаге.
- `tests/unit/channel-menu-publication.test.mjs` (+): с выкл. флагами проекция реального меню **байт-в-байт** равна проекции без новых полей; с флагами - поля на своих местах.
- `tests/unit/menu-sync.test.mjs` (+): `deliveredForm` для всех 8 подмножеств; ACK каждой формы; чужой checksum → CONFLICT.
- `tests/integration/menu-sync-channel-offers.test.mjs` (по образцу `menu-sync-combo-stops.test.mjs`): касса без фич применяет вырезанную форму, касса с фичами - полную.
- Строгий клиент: замороженная копия схемы c3a0fbee разбирает `storefrontPayload` реального меню (киоск и mobile).
- `tests/unit/menu-routing.test.mjs` (+): реальное меню на кассе с 2 станциями, `deriveRouting` без `ROUTING_UNRESOLVED`.
- `tests/unit/catalog-edge-parity.test.mjs` (+): `--allow` (лишнее или недостающее отличие = exit 1).
- `tests/unit/catalog-channel-parity.test.mjs`.
- `catalog-pricing` (+): реальное меню без `AMBIGUOUS_COMPONENT`; 9 контрольных корзин из `iiko-menu-details:195-209`.

**Существующие наборы:**

- `pnpm test` (unit);
- `pnpm test:integration` (catalog-_, channel-_, menu-_, kiosk-unified-menu, unified-menu-_, existing-stops-_, remote-stops-_, combo-rewards-owner);
- `test:commerce`, `test:pos`, `test:kiosk`, `test:mobile`, `test:fulfillment`, `test:backoffice`;
- typecheck/lint/format, `pnpm contracts`.

## 9. Зависимости и общие файлы

**POS lane (КС5).**

- Она: `sales_channel` в Cart/Quote, `priceCart`, ошибка `CHANNEL_PRICES_UNAVAILABLE`.
- Я: enum в `sales-channels.ts` и функции из 4.4.
- Общие файлы: `packages/contracts/src/index.ts`, `packages/local-orders/src/pricing.ts` (меняет POS lane).
- Эвристика визарда `/соус/` (`apps/pos/src/v2/app.js:739`) возьмёт первую группу с «соус». Порядок групп в импорте: `drink`, `sauce`, платные.

**KDS lane (КД1-КД5).**

- Потребляет `production` и `modifier_groups[].production`.
- Правило видимости по умолчанию (контракт, KDS может уточнить через `product_ids` плана станций): выдача - всё; сборка - `kitchen_class ∉ {drink,sauce}`; панировка - `fingers>0`; тосты/бургеры - `burgers+toasts>0`.
- `product_ids` плана станций = slug каталога.
- Новые станции маршрутизирует KDS lane. `deriveRouting` не переносит существующие маршруты.

**Stage 2.** Общие `cloud.ts`, `worker.ts`, `catalog-projection.ts` (combo_stops). Деплой cloud 069-072/edge 021-025 нужен для п. 7.2.

**Склад (Ск2).** Колонка `ttk_no` - таблица соответствий для `Recipe.product_id` (slug вместо `ttk:<номер>`).

**Киоск К9 и mobile П3 (P1).** Обновить списки slug в `smartUpsell.ts`/`menu-presentation.ts` (новые комбо, Chick Burger). Фото и скриншоты - после М1.

## 10. Приоритеты

**P0 (к 19.11):**

- P0-1 импорт и публикация реального меню (М1, Д2);
- P0-2 паритет перехода и трёх каналов (М4, М6);
- P0-3 `channel_offers` от начала до конца (Аг4, данные Д2);
- P0-4 `production` + данные шефа о классе, бургерах и тостах (М3, КД2, КД3);
- P0-5 runbook и операция публикации.

**P1:**

- фингерсы по позициям (КД4);
- `combo_components` и связи (М2);
- фото, описания и KK (М5, К9);
- `edge_menu_state.menu_features` и индикатор в бэк-офисе;
- `hidden_channels` для своих каналов, если владелец решит;
- доступность опций по каналу;
- скидки (КС7).

**P2:**

- адаптеры Аг7/Аг8 на `external_sku`;
- собственные цены кассы и киоска;
- проверенные КБЖУ и аллергены;
- допродажа по `kitchen_class` в новых сборках.

## 11. Оценка P0 (инженеро-дни)

| Пункт                                                                                    | Дни     |
| ---------------------------------------------------------------------------------------- | ------- |
| P0-1 импорт (`build/save/publish`, отчёт, фикстура, тесты)                               | 1.5     |
| P0-2 `--allow` + `catalog-channel-parity` + тесты                                        | 1.0     |
| P0-3 схемы, флаг, проекция, `deliveredForm`/ACK, стрипперы, функции цен, бэк-офис, тесты | 2.0     |
| P0-4 `production` (схема, проекция, редактор, валидация, тесты)                          | 0.75    |
| P0-5 runbook, публикация с управляющим, документы                                        | 0.75    |
| **Итого**                                                                                | **6.0** |

## 12. Риски и вопросы владельцу

**Риски:**

1. Публикация М1 сразу меняет цены в приложении. Оно принимает реальные Kaspi-деньги (`docs/project-status.md:506-507`) по ценам v11: 13 позиций по 1 ₸, Pick Combo 90 ₸ (Р4). Окно публикации - решение владельца.
2. Payload реального меню - около 160 KB, с KK-подписями до ~200 KB при лимите 256 KiB, который зашит и в установленных клиентах. Бюджет 230 KiB - в инструменте.
3. `linked_product_id` в комбо без состава убирает родительскую задачу кухни для заказов из облака (`edge-fulfillment/src/model.ts:236-252`). Пока нет М2, не ставить.
4. На edge 020 стоп компонента не закрывает комбо на кассе (нужна `combo_stops`). М6 на кассе - только после деплоя.
5. Новые slug'и (Chick, Meal, Duo) не знают захардкоженные списки киоска: допродажа и хиты деградируют мягко. Большой соус в mobile пропадёт при отказе от группы `size`.
6. Прайсы Яндекса и Glovo не найдены в репо. Без них Аг4 = только код.

**Вопросы:**

1. Сопоставление: `pick-combo` = Finger Combo 00144? Название «Pick Combo» или «Finger Combo»? `burger-combo`, `burger-duo`, `mix-duo` - Pick или Chick?
2. Соусы: 12 отдельных товаров (рекомендация: как в iiko и у агрегаторов, свой артикул и списание) или выбор объёма?
3. Напиток и дип по умолчанию в обязательных группах. Схема требует default; предлагаю колу и фирменный соус. Убрать группу `extras` из комбо?
4. Полные списки Яндекс 47 и Glovo 52 с ценами и доплатами - кто и к 09.11? Цены 7 позиций без цены (00280, 00293-00298)?
5. Доплаты опций у агрегаторов = как в зале, если не указано?
6. Холодный чай сладкий/несладкий и вкусы Piko: сохраняем?
7. Фингерсов в «Куриный фингерс»: 1 или 5 (ТТК)? Сколько фингерсов, бургеров и тостов в каждом комбо (шеф, М3)?
8. ChocoFood - цены зала (UNCONFIRMED)?
9. Кто переводит KK-названия?
10. Свой ассортимент для киоска или приложения нужен (например, без 500 мл соусов)?
