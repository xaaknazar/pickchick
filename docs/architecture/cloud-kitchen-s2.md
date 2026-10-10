# Облачный кухонный канал: этап S2

Решение: [ADR-0014](adr/0014-cloud-kitchen-channel.md), архитектура:
[cloud-kitchen-channel.md](cloud-kitchen-channel.md). Этап S2 добавляет облачное выполнение
kiosk/mobile как код и схему, но ничего не включает в production: режим всех точек `edge`,
admission не вызывается из оплаты, `/v1/kitchen/*` выключен флагом и не зарегистрирован в
`createApi`.

## Что сделано

- Cloud 054 (`db/cloud/migrations/054_cloud_kitchen_fulfillment.sql`):
  - `branch_channel_modes` (`cloud_channels_owner` `edge`|`cloud`, `epoch`; нет строки =
    `edge`) и неизменяемая история `branch_channel_mode_changes`. Смена только через
    `cloud_kitchen_set_mode(branch, owner, actor, reason)`: epoch +1, повтор того же режима -
    ошибка `55000`.
  - `cloud_kitchen_stations`, `cloud_kitchen_routing` (неизменяемые версии),
    `cloud_kitchen_config` - доверенная настройка владельцем, как edge 005.
  - `cloud_kitchen_admissions` - владелец выполнения заказа, фиксируется один раз при
    admission и не меняется при смене режима (неизменяемая таблица).
  - `cloud_kitchen_orders`/`cloud_kitchen_tasks`: заказ создаётся сразу в `accepted`, номер -
    активный hold из cloud 053 того же заказа; триггеры запрещают менять идентичность, номер,
    snapshot, пропускать версии и выходить из терминальных состояний.
  - `cloud_kitchen_commands` - журнал команд по `(branch, device, Idempotency-Key)` с hash
    тела и результатом; `cloud_kitchen_outbox` - одно событие на версию заказа.
  - `cloud_kitchen_station_presence` - последний опрос ленты устройством по станции
    (вход для будущего gate `KITCHEN_OFFLINE`, S4).
- Права: `infra/staging/cloud-kitchen-grants.mjs` (конфигурация и режим только чтение,
  журналы только INSERT, без DELETE/TRUNCATE). Номера - `channel-number-grants.mjs` (053).
  В provisioning пока не подключены.
- Пакет `@pickchick/cloud-kitchen`:
  - все переходы через `@pickchick/fulfillment-state` (тот же набор команд и порядок проверок,
    что edge);
  - `taskPlan` перенесён из edge без изменений (edge не менялся), равенство проверяется
    векторами;
  - `admitPaidOrder(orderId)` / `admitPaidOrderInTransaction(client, orderId)`;
  - `requestCancel` - доверенная отмена (как `edge.fulfillment_cancel_requested`), без HTTP;
  - `act`, `readOrder`, `listKitchen`, `listStations`, `readDisplay`, `stationPresence`.
- `services/api/src/cloud-kitchen-controller.ts`: `GET /v1/kitchen/stations`, `/kitchen`,
  `/display`, `/orders/:id`, `POST /v1/kitchen/commands` (`Idempotency-Key`).

## Правила admission

1. Повтор по заказу возвращает первое решение (`edge` или существующий облачный заказ).
2. Заказ должен быть kiosk/mobile, оплачен полностью (`commerce_captures` = сумма), без
   возвратов, намерения отмены и `attention_required` - те же условия, при которых commerce
   сейчас создаёт `edge.kitchen_admission_requested`. Иначе `NOT_READY`/`NOT_PAID`.
3. Режим читается под shared-блокировкой режима точки: параллельная смена режима ждёт, epoch в
   решении - действующий.
4. Режим `edge`: записывается решение `edge`, облачный заказ и номер не создаются.
5. Режим `cloud`: активная маршрутизация (`ROUTING_MISSING` без неё), задачи по `taskPlan`,
   номер через `channel_number_allocate` (номер, выделенный до оплаты, возвращается как
   `existing`); все 300 номеров заняты - `NOT_READY`/`NUMBERS_EXHAUSTED`, ничего не
   записывается.
6. Номер освобождается `channel_number_release` в той же транзакции, что `handed_over` или
   `cancelled`.

## Точка подключения для S5

Не подключено в S2. В `packages/commerce-core/src/repository.ts`, функция `reconcile`: в ветке,
где при полной оплате эмитируется `edge.kitchen_admission_requested`, вызвать
`admitPaidOrderInTransaction(client, orderId)` в той же транзакции фиксации capture. Для
решения `cloud` событие edge не создавать. Номер нужно выделять до открытия оплаты (ADR-0014:
нет свободного номера - оплата не открывается), admission переиспользует его. Файл занят
задачами `kiosk-v3-launch`/`kaspi-qr-pending` по смежным путям - согласовать в S5.

## Флаги контроллера

- `CLOUD_KITCHEN_API_ENABLED=1` - иначе все маршруты `404`.
- Аутентификации устройств ещё нет (cloud 056, отдельный этап): при включённом API без
  тестового hook все запросы `401`.
- Тестовый hook: `CLOUD_KITCHEN_TEST_AUTH=1` и окружение не `staging`; actor передаётся
  заголовком `X-PickChick-Test-Kitchen-Actor` (base64url JSON). Ни одна переменная не задана в
  compose staging, unit-тест это проверяет.
- Регистрация в `createApi` (`services/api/src/index.ts`, занят `workforce`) и зависимость
  `services/api/package.json` (занят `unified-menu-release`) не менялись: контроллер принимает
  структурный порт, сервис подключается при регистрации.

## Не сделано

Стопы облачных каналов и gate `KITCHEN_OFFLINE` (S4), подключение к оплате и BO-переключение
режима (S5), учётные данные кухонных устройств, gateway, renderer, табло (S6), зеркало
protocol 5 и публикатор outbox (S7). Регистрация grants в provisioning и релиз на VPS не
выполнялись.
