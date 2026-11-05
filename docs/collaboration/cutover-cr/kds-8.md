# CR kds-8 → integration: проверка слияния pos → kds и межполосный тест кассы с раскладкой KDS

Полоса: kds (ветка `codex/cutover-kds`). Адресат: integration (`codex/cutover-1119`, владелец `tests/integration/cutover-*.test.mjs`, §4.1), копия - pos и cloud.
Основание: ревью полосы kds, замечания B2 (корневой `pnpm test`), M2 (`HANDOVER_MARKS_REQUIRED` на проводе) и M4 (допуск кассы с раскладкой проверен только заглушкой `seamCashierPort`).

## 1. Что проверено 05.11 (временный клон, в ветки ничего не записано)

Клон `codex/cutover-kds` (после коммита `073648d8`), слияние `codex/cutover-pos` `b25674d5` без конфликтов (порядок pos → kds, §8), затем в рабочем дереве клона: `git apply docs/collaboration/cutover-cr/kds-4.patch` (CR kds-4) и одна строка `'HANDOVER_MARKS_REQUIRED'` в `ErrorSchema.code` (CR kds-6). Базы - базы полосы kds; для наборов с `loadConfig` - тестовый загрузчик полосы (как в отчётах шагов 2-4).

| Команда                                                                                                                               | Результат                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `heavy pnpm build`                                                                                                                    | exit 0                                                                                                                     |
| `heavy pnpm test` (корневые unit)                                                                                                     | 383 теста: 382 прошли, 0 упали, 1 пропущен (B2 закрывается в коммите слияния: pos раньше kds + патч CR kds-4)              |
| `heavy pnpm --filter @pickchick/edge-fulfillment test:integration`                                                                    | 56/56, в том числе `kds-postgres`, `kds-events` на настоящем `local-pos.ts`                                                |
| `kds-http-compat`, `kds-http`, `kds-migration`, `kds-switch`, `menu-routing`, `pos-sales`, `pos-sales-streams`, `pos-sales-contracts` | 53/53; `kds-http` с CR kds-6 сам проверяет `HANDOVER_MARKS_REQUIRED` (M2)                                                  |
| `tests/kitchen/kds-browser.test.mjs`                                                                                                  | 2/2 (1280x800, 1920x1080)                                                                                                  |
| временный тест «касса с раскладкой» (раздел 2) на настоящем `POST pos/sales`                                                          | прошёл: 16 событий кухни кассы разобраны строгими потоками, события `posSales` обоих заказов разобраны `parsePosSaleEvent` |

## 2. Межполосный тест, который нужен в `tests/integration/cutover-cross-lane.test.mjs` (M4)

Окружение - как `prepareDesk` в `tests/integration/pos-sales.test.mjs` (режим `pos_sale`, все восемь методов, смена кассы). Затем:

1. Новый релиз меню, где у бургера `source_id: 'pick-burger'`, у напитка `'pick-drink'`; `writeKdsLayout` из `packages/edge-fulfillment/tests/kds-fixture.mjs` с раскладкой: `toasts ['pick-burger']` (count burger 1), `assembly_hall` и `assembly_delivery ['pick-burger']`, `issue ['pick-drink']`, `breading []`, `delivery_handover []`; раскладка включена.
2. Продажа Glovo: квота `sales_channel:'glovo'`, `external_order_ref: 'g-4242'` (нижний регистр), оплата `aggregator_glovo` на всю сумму. Ждём: `snapshot.delivery = {provider:'glovo', externalNumber:'G-4242'}`, `assembly_station_id = kdsStationId(branch,'delivery_handover')`, задачи `assembly_delivery` и `toasts`.
3. Продажа зала наличными (бургер и напиток, `dine_in`). Ждём: завершающая станция `issue`, задачи `assembly_hall`, `toasts`, `issue`.
4. По HTTP (`X-Terminal-Id` = терминал сессии): `GET fulfillment/kitchen?stationId=<стол 2>` и `GET fulfillment/orders/<зал>` - тело равно `JSON.stringify` строгой схемы (`FulfillmentKitchenSchema`, `FulfillmentOrderSchema`), у билета Glovo `delivery.externalNumber = 'G-4242'`.
5. Glovo: `complete_station` стола 2 и станции 3 → `ready`; `handoff` без отметок → `400 HANDOVER_MARKS_REQUIRED`; с тремя отметками → `handed_over`, одна строка `delivery_handovers` (`glovo`, `G-4242`, станция 3).
6. Зал: `complete_station` стола 1 и выдачи → `ready` → `handoff` без отметок → `handed_over`.
7. `assertStrictEvents(pool)` (строгие `EdgeEventSchema` и `parseKitchenEvent`) и `parsePosSaleEvent` для событий обоих заказов.

## 3. Что применить в коммите слияния kds

- Слить pos раньше kds.
- `git apply docs/collaboration/cutover-cr/kds-4.patch` (тесты `tests/unit/menu-routing.test.mjs` - без владельца, `tests/unit/catalog-edge-parity.test.mjs` - cloud).
- CR kds-6 (cloud) и `heavy pnpm contracts:generate` отдельным последним коммитом.
- Принять слияние только при `heavy pnpm check` без падений на pos+kds.
