# CR kds-3 → integration: права воркера fulfillment на раскладку KDS, предусловие 027

Полоса: kds (ветка `codex/cutover-kds`). Адресат: integration (`codex/cutover-1119`).
Основание: контракт §5.2 (облачный путь допуска через `buildKitchenPlan`), §5.9 (`WORKER_PRIVILEGES` «при необходимости»), CR kds-1.
Состояние полосы: коммиты KDS-2 `6c0cd964` (routing.ts), `bbc85c7c` (каскад), `9c52c3f2` (план KDS), `8ededf2c` (HTTP) и коммит этого CR.

## 1. Права воркера fulfillment (исправляет CR kds-1, раздел 1)

В CR kds-1 сказано «воркерам в P0 ничего не нужно». Это неверно для облачного пути допуска: `EdgeFulfillment.acceptCloud` вызывает `packages/fulfillment-transport/src/worker.ts:638` под ролью воркера транспорта (`infra/windows/fulfillment-worker-grants.mjs`), а не под рантаймом. После KDS-2 этот вызов читает выключатель и активную раскладку (`readKdsLayout`, `packages/edge-fulfillment/src/kds-layout.ts`).

Без прав воркер видит `has_table_privilege(...) = false`, и заказ приложения или киоска молча уходит на старые станции «Приготовление»/«Сборка», хотя экраны KDS уже открыты. Ошибки нет, заказ на экранах KDS не появится. `kds-switch enable` этого не видит (не знает роль воркера).

Нужно (только SELECT, меню воркеру не нужно - строки облака уже в slug):

| Таблица               | Воркер fulfillment |
| --------------------- | ------------------ |
| `kds_settings`        | `SELECT`           |
| `kds_layouts`         | `SELECT`           |
| `kds_setting_changes` | нет                |
| `delivery_handovers`  | нет                |
| `courier_incidents`   | нет                |

Новые экспорты `infra/windows/kds-grants.mjs`: `WORKER_PRIVILEGES`, `kdsWorkerGrantSql(role, schema)` (только GRANT), `assertKdsWorkerPrivileges(client, role, schema)` (точный набор на 5 таблицах KDS). Проверено тестом `packages/edge-fulfillment/tests/kds-postgres.test.mjs` («the fulfillment worker admits cloud orders…»): роль с реальным `fulfillmentWorkerGrants` без этих прав даёт старые станции, с ними - план KDS; запись в `kds_settings` и `kds_layouts` запрещена.

Просьба:

1. `kds-upgrade-db.mjs apply`: в той же транзакции после 027 - `kdsWorkerGrantSql(workerRole, schema)` и `assertKdsWorkerPrivileges(client, workerRole, schema)`; `kdsTableGrantees(client, schema)` теперь должен вернуть ровно `[runtimeRole, workerRole]` (отсортировано), а не `[runtimeRole]`.
2. Везде, где права воркера выдаются заново (`fulfillmentWorkerGrants` в `cashier-reports-upgrade-db.mjs`, `remote-stops-upgrade-db.mjs` и подобных): после 027 добавлять `kdsWorkerGrantSql` той же проверкой «миграция применена = таблица есть», что в CR kds-1 раздел 3 для рантайма.
3. `kds-upgrade-db inspect`: отказ, если у роли воркера нет точного набора (иначе включение KDS оставит облачные заказы на старых станциях).

## 2. Предусловие CR kds-1 раздел 2 (routing.ts)

Исправление `packages/menu-sync/src/routing.ts` - коммит `6c0cd964`: новая prep-позиция меню идёт на станцию, на которую указывают все действующие prep-маршруты; без prep-маршрутов - на единственную prep-станцию; маршруты на двух prep-станциях - по-прежнему `ROUTING_UNRESOLVED`. Рантайм с этим коммитом должен стоять до `provisionKdsStations` (станции 6 и 5 - prep).

## 3. Для сведения

- 027 в этом шаге не менялся, SHA-256 прежний (CR kds-1).
- `tests/integration/stage2-cross-lane.test.mjs` («the merged contracts publish all three extensions…») красный уже на D0: ждёт `EdgeMenuFeatureSchema.options = ['combo_stops']`, а D0 добавил `aggregator_prices`. Файл не полосы kds.
- `local-pos.ts` (полоса pos) ещё вызывает `taskPlan`; KDS-план кассы проверен заглушкой порта с `buildKitchenPlan` (`packages/edge-fulfillment/tests/kds-fixture.mjs`, `seamCashierPort`). После слияния pos - прогнать `kds-postgres.test.mjs` и `tests/integration/kds-http.test.mjs` на настоящем `local-pos.ts`.
