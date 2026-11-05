# Дизайн полосы KDS и LAN: станции кухни, маршруты, выдача доставки, локальная сеть

Срез: `origin/codex/shared-development` 1a9472f1 (05.11.2026). Код: КД1-КД5, КД7-КД10, КД12, Аг9, Аг10, Т9, К7, К8.
Ссылки `файл:строка` даны на этот срез. Номера миграций - `edge-NEXT` / `cloud-NEXT`, их назначает лид.

## 1. Текущее состояние

**Модель исполнения на edge**

- Станция имеет `kind IN ('prep','assembly')` (`db/edge/migrations/005_edge_fulfillment.sql:9-15`). Маршрут работает так: один продукт - одна станция, на точку одна станция сборки (`RoutingSchema`, `packages/edge-fulfillment/src/model.ts:52-68`). Задачи создаются при допуске из неизменяемого `task_plan` (`005:49`, `repository.ts:315-318`, `local-pos.ts:115-120`). `UNIQUE(order_id,component_key,station_id,kind,routing_version)` (`005:87`) уже позволяет показать одну позицию на нескольких станциях.
- Заказ проходит `accepted -> in_production -> ready -> handed_over` (`005:142-146`), задача движется только вперёд (`005:152-154`). `ready` и `handoff` выполняет только станция сборки заказа (`assembly_station_id`, `repository.ts:554-563`). `complete_station` этой станции требует, чтобы все чужие задачи были `done` (`packages/fulfillment-state/src/index.ts:191-234`, `planReady` - там же, `:236-245`).
- Касса (unpaid_service) отправляет на кухню строки `kind:'item'`, `components: []`, `linkedProductId: null` (`local-pos.ts:48-66`). Комбо кассы на компоненты не раскладывается. Строки mobile/kiosk приходят по slug и уже с компонентами (`model.ts:248-267`, `menu-sync/src/routing.ts:137-145`). Касса может отменить заказ, только пока все его задачи в `queued` (`local-pos.ts:146-151`).
- Тип заказа бывает только `dine_in|takeaway`: в корзине и чеке POS (`packages/contracts/src/index.ts:390-396,416-420`), в снимке кухни (`model.ts:118`), в ответе edge (`contracts/src/fulfillment.ts:64`), в строгом разборе приложения кухни (`apps/kitchen/src/types.ts:211`). Признака доставки или агрегатора в модели нет.
- Табло показывает `accepted/in_production` как «готовится», `ready` как «готово» (`repository.ts:693-708`).

**План станций этапа 2 (код есть, не установлен)**

- cloud070 / edge024. Роли станций: `prep|assembly|drinks|handoff`. Станция плана привязывается к станции кассы только при `kind===role` (`packages/menu-sync/src/station-plan.ts:149-166`). Поля плана: `device_id`, `product_ids`, `target_seconds` (`contracts/src/station-plans.ts:15-30`). В БД закреплено `schema_version=1` (`024:10`, `070:14`). План «не меняет маршрутизацию» (`docs/operations/stage2-2026-10-24/cfg.md:62-65`).
- Маршруты при публикации меню требуют ровно одну prep-станцию для новой позиции (`menu-sync/src/routing.ts:99-102`), а станции читаются все (`menu-sync/src/edge.ts:260-268`). **Вторая prep-станция сломает публикацию меню с новой позицией (`ROUTING_UNRESOLVED`).**

**Ограничения, которые нельзя нарушить**

- POS kitchen sync принимает 5 типов событий и строгий payload, `taskState` только `in_progress|done` (`packages/pos-order-sync/src/kitchen-model.ts:12-51`). Облачный транспорт тоже строгий, `task_changed` разрешён только в `in_production|cancel_requested` (`packages/fulfillment-transport/src/model.ts:137-187`). Новый тип события или новый ключ в `fulfillment_outbox` остановит синхронизацию.
- Терминал имеет `mode IN ('prep','assembly','display')` (`020_terminal_access.sql:34`). Станция доступна терминалу только своего kind (`services/edge/src/fulfillment-controller.ts:171,225,288-313`). Табло работает по ключу терминала, без сотрудника (`:323-346`).
- Ключ привязки не истекает (`local-orders/src/terminal-access.ts:37-53`), поэтому экраны работают офлайн. ID терминала совпадает с cloud device id (`backoffice-core/src/device-registry.ts:764`).
- Вход кухни общий, по логину `kitchen` (`local-orders/src/kitchen-password-reset.ts:20`). Учёта по отдельным сотрудникам нет.

**LAN**

- Gateway уже принимает до 20 IP (`infra/windows/kitchen-lan-gateway.mjs:64-70,88`). Ограничение в одну кухню задаёт установщик: один `KitchenAddress` в конфиге и в firewall (`install-kitchen-lan.ps1:7,130,152`). Повторную установку он запрещает.
- В allowlist gateway нет `restore-review` (`gateway:31-32`; ср. `apps/kitchen/server.mjs:26`). Это правка С4/279.
- `maxConnections=40` (`gateway:247`), клиент открывает TLS на каждый запрос (`apps/kitchen/server.mjs:88`).
- POS-desktop ходит только на loopback (`apps/pos-desktop/protocol.mjs:9-16,303`).

**Прочее**

- **Печать (КД8):** в PickChick её нет совсем (`apps/pos/src/app.ts:304`: «ККМ / принтер - Не подключены»).
- **Демо (Т9):** `/kitchen-demo/` показывает вымышленные заказы в памяти вкладки и не синхронизирует устройства (`apps/kitchen/src/demo.ts:1`, `docs/operations/kitchen-design-demo.md`). Для учения на нескольких экранах не подходит.
- **ТТК:** рецепты не связаны с товарами меню (`product_id=ttk:<номер>`, `docs/operations/ttk-import-2026-10-20.md:60-69`). Число фингерсов из техкарт автоматически не получить.
- **Облачный кухонный канал (ADR-0014):** не включён. При запуске должен остаться выключенным, иначе очередь kiosk/mobile раздвоится.

## 2. Целевое поведение по кодам трекера

| Код         | Поведение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| КД1         | На edge 6 новых станций: «Панировка (6)» prep; «Тосты и бургеры (5)» prep; «Сборка - зал (4.1)», «Сборка - доставка (4.2)», «Выдача (2)», «Выдача доставки (3)» - assembly. Экран открывает свою станцию сам по привязке терминала (`device_id` станции плана).                                                                                                                                                                                                                                                                                                                                                                  |
| КД2         | Раскладка задаётся планом станций (поле `kds`) и вычисляется при допуске (`kdsTaskPlan`). Позиции сборки идут на 4.1 (зал и с собой) или 4.2 (доставка). Напитки и соусы (товар есть в `product_ids` выдачи и отсутствует на столах сборки) получают задачу только на выдаче. Выбор напитка или соуса в комбо скрыт на сборке (`issueOnlyOptionIds`). Тост или бургер получает задачу на станции 5 с `upstreamOf` = стол. Панировка задач не получает: её экран строится из позиций, отмеченных `breading`. Позиция без раскладки уходит на стол с отметкой «Нет в раскладке». **Заказ из-за раскладки никогда не отклоняется.** |
| КД2 (поток) | Завершающая станция заказа (`assembly_station_id`): Выдача (2) для зала и с собой, Выдача доставки (3) для доставки. Зал: тост «Готово» -> стол «Собран» (сам закрывает тосты заказа) -> выдача «Готов - позвать гостя» (`ready`: табло и приложение показывают «Можно забирать») -> «Выдан».                                                                                                                                                                                                                                                                                                                                    |
| КД3         | Экран 5: карточки заказов и строка итогов «Тостов: N · Бургеров: M» по незакрытым задачам с разбивкой по позициям.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| КД4         | Экран 6 - проекция «ещё не собранных» заказов: названия позиций (как в регламенте) и, если шеф задал `count`, «Фингерсов: N» по заказу и в сумме.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| КД5         | `kds_settings.shift_mode` = `morning`, `normal` или `peak`, переключает менеджер. Утро: на экранах 4.1 и 2 общий вид сборка + выдача, «Готов» закрывает стол и тосты (`cascade`). Зашив: на экране 4.2 колонка «Бургеры (все заказы)», строки закрываются действием `complete_lines`. Режим меняет только состав экранов, маршрут не меняется.                                                                                                                                                                                                                                                                                   |
| КД7         | Gateway различает профили клиентов `kitchen`, `display` и `pos` по IP. Список из N клиентов, firewall и проверки задаются новым скриптом обновления, без переустановки.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| КД9         | На выдаче (2/3) есть кнопка «Вернуть на сборку» с причиной: появляется задача `rework` на том же столе и запись в `fulfillment_returns`. Учёт ошибок ведётся по столу (4.1/4.2) и по дню. По людям - только через расстановку смены (общий логин `kitchen`).                                                                                                                                                                                                                                                                                                                                                                     |
| КД10        | Номер переходит в «готово» по `ready` от выдачи. Заказы доставки не показываются на табло. Табло - отдельный терминал `display`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Аг9         | Экран 3 показывает заказы доставки по номеру агрегатора: «Собирается», затем «Принять от сборки» (`ready`), затем «Передать курьеру». Передача возможна только с тремя отметками (`handover`), это проверяет edge. «Отказ по протоколу» записывает инцидент и показывает на выдаче (2) баннер «Менеджер вызван».                                                                                                                                                                                                                                                                                                                 |
| Аг10        | Журнал `courier_incidents` (время, заказ, агрегатор, номер, вид, описание). Менеджер отмечает «на месте», «передано в поддержку», «решено». Синхронизация в облако - P1.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| КД8         | Печати нет, проектируется с нуля. P2 после ответа владельца (Р18) и описи принтера (КД6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Т9          | Демо подходит только для тренировки одного экрана. Учение проводится на реальном edge с тестовыми заказами кассы. Скрипт `kds-drill.mjs` - P1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 3. Модель данных и миграции

**Существующие таблицы не меняются.** Новое поведение хранится в трёх местах:

- **`details.kds`** задачи (jsonb, без DDL): `{function, upstreamOf?, breading?, fingers?, units?, unit?, burger?, issueOnlyOptionIds?, unmapped?}`. Значения закрепляются при допуске, поэтому заказ ведёт себя одинаково, даже если план позже изменится.
- **`kds` станции плана** (JSON в `bo_publications` и в payload плана, без DDL): `schema_version` остаётся 1. Ключ необязательный. Старый runtime с 024 отклонит такой план кодом `INVALID_PLAN`, и предыдущий план останется действующим.
- **Признак доставки** берётся из снимка заказа: `snapshot.delivery = {provider, externalNumber}`. Поле вводит полоса КС5 (раздел 9).

**edge-NEXT `kds_foundation`** - только добавочные таблицы. Записи неизменяемы, кроме однократного `reported_at` (триггер по образцу `024:60-76`). DELETE запрещён.

```sql
kds_settings(branch_id PK->branch_config, layout_enabled bool NOT NULL DEFAULT false,
  shift_mode text CHECK IN('morning','normal','peak') DEFAULT 'normal', version int>0, updated_at)
kds_setting_changes(command_id PK, branch_id, version, field CHECK IN('layout_enabled','shift_mode'),
  value, actor CHECK IN('operator','shift_manager'), staff_id NULL->local_staff, terminal_id,
  reason 3..300, request_hash, recorded_at, reported_at, UNIQUE(branch_id,version))
delivery_handovers(order_id PK->fulfillment_reservations, branch_id, command_id UNIQUE,
  provider, external_number, number_matched/courier_accepted/photo_taken bool CHECK(true),
  station_id, staff_id, terminal_id, handed_over_at, reported_at)
courier_incidents(incident_id PK (=Idempotency-Key), branch_id, order_id NULL->reservations,
  provider CHECK IN('yandex_eda','glovo','other'), claimed_number 1..40 NULL,
  kind CHECK IN('number_mismatch','not_accepted_in_app','no_photo','courier_refused','other'),
  description 3..500, station_id, staff_id, terminal_id, request_hash, recorded_at, reported_at)
courier_incident_updates(update_id PK, incident_id FK,
  status CHECK IN('manager_on_site','sent_to_aggregator','resolved'),
  note<=500, aggregator_ticket<=60, staff_id, request_hash, recorded_at, reported_at)
fulfillment_returns(return_id PK, branch_id, order_id FK, order_version, from_station_id,
  to_station_id, rework_task_id NULL->fulfillment_tasks,
  reason CHECK IN('missing_item','wrong_item','appearance','packaging','other'), note<=300,
  line_ids jsonb array, staff_id, terminal_id, request_hash, recorded_at, reported_at)
-- индексы: (branch_id,recorded_at DESC) и частичные WHERE reported_at IS NULL
```

**Права роли runtime** (additive helper `kds-grants.mjs`, по образцу `kitchen-restore-review-grants.mjs:2-25`):

- `SELECT` на `station_plan_active` и `station_plan_snapshots`;
- `SELECT` на `kds_settings` и `UPDATE(shift_mode,version,updated_at)` на неё (`layout_enabled` меняет только owner-инструмент);
- `INSERT/SELECT` на 5 таблиц журнала.

Роль `pickchick_menu_sync` получает `SELECT` и `UPDATE(reported_at)` - это нужно для отправки в облако в P1.

**Данные, не DDL.** Охраняемый инструмент добавляет 6 строк `fulfillment_stations`, выдаёт права станций активному `kitchen` и создаёт строку `kds_settings` (выключено, `normal`). Runtime определяет готовность схемы через `to_regclass` и `has_table_privilege`, как в `records.ts:108-113`. Без схемы работает прежнее поведение.

**cloud-NEXT (P1) `kds_edge_events`**: `(event_id PK, branch_id, device_id, type, payload jsonb, payload_hash, occurred_at, received_at)`, неизменяемая. Права выдаёт helper `infra/staging/kds-grants.mjs`. Для P0 облачная миграция не нужна.

## 4. API и контракты

**Контракты** (`packages/contracts`):

- `station-plans.ts`: `KdsFunctionSchema = enum('breading','toasts','assembly_hall','assembly_delivery','assembly_burgers','issue','delivery_handover')` и `KdsStationSchema = {function, counts?: [{product_id: slug, count: 1..100, unit: 'finger'|'toast'|'burger'}] ≤100}`. В `StationPlanStationSchema` добавляется `kds?`.
- `fulfillment.ts`, новые необязательные поля:
  - `FulfillmentTaskSchema.details.kds?`;
  - `FulfillmentKitchenOrderSchema.delivery?: {provider, externalNumber}`;
  - действия: `ready` и `handoff` разделяются, у `handoff` появляется `handover?: {numberMatched:true, courierAccepted:true, photoTaken:true}`, у `complete_station` - `cascade?: true` (P1).
- Новые действия (P1): `return_to_assembly {expectedVersion, stationId, reason, note?, lineIds[1..50]}`, `complete_lines {expectedVersion, stationId, taskIds[1..50]}`.
- Новые схемы: `FulfillmentLayoutSchema`, `BreadingViewSchema`, `CourierIncidentInput/List/UpdateSchema`, `KdsModeCommandSchema`. Затем `openapi.json` пересобирается.

**Правило раскладки** - чистая функция `kdsTaskPlan(parts, slug, layout)`. Части строк берутся из того же разбора, что и в `taskPlan` (`model.ts:248-267`, выносится в `orderParts`).

- **Тип заказа:** `delivery`, если есть `snapshot.delivery`, иначе зал. Стол = 4.2 для доставки (если 4.2 нет - 4.1), иначе 4.1. Завершающая станция = 3 для доставки (если 3 нет - 2), иначе 2.
- **Каждая часть строки** с количеством `q`:
  - товар есть в `issue.product_ids` и отсутствует на столах -> задача `assembly_item` на выдаче (напитки и соусы доставки по умолчанию тоже на 2, это вопрос владельцу);
  - иначе -> задача `assembly_item` на столе с флагами `breading`, `fingers = q*count`, `burger`, `unmapped`;
  - если товар есть у станции 5 -> дополнительно задача `prep` на 5 с `units = q*count` (по умолчанию `q`), `unit` и `upstreamOf = стол`.
- **Модификаторы:** для POS slug связанного товара выводится из `linked_variant_id` меню (поле pcs). Без него модификатор виден и на сборке (UNCONFIRMED до М2).
- **Ключ и пределы:** `component_key = прежний ключ + ':' + function`. Пределы прежние: не больше 2000 задач, ограничение `digest`.
- **Прежняя проверка сохраняется:** `taskPlan` по старому маршруту выполняется как раньше, `ROUTING_MISSING` не меняется. `routing_version` - действующая прежняя версия (FK).

**Машина состояний** (`fulfillment-state`):

- `planCompleteStation` получает `cascade` - задачи «выше по потоку». Стол закрывает задачи с `upstreamOf = стол`. Выдача утром закрывает стол и тосты, только при `shift_mode='morning'`.
- Каждое закрытие - обычный шаг `task_changed` со `stationId` самой задачи. **Форма событий не меняется.** Возврат на сборку (P1) вставляет задачу без события и без повышения версии заказа.

**HTTP edge** (новый `services/edge/src/kds-controller.ts`; действия - в существующем контроллере):

| Метод, путь                                                                                                                | Кто                                  | Суть                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/edge/v1/fulfillment/layout`                                                                                          | kitchen, manager                     | `{enabled, reason?, planVersion, mode, modeVersion, stations[{id,name,kind,function}], screen{view, stationIds} - для этого терминала и режима, deliveryProtocol}`. 404 или `enabled:false` - клиент работает по-старому. |
| GET `/edge/v1/fulfillment/kds/breading`                                                                                    | терминал prep + доступ к станции 6   | Заказы `accepted/in_production`, у которых не закрыта задача стола с `breading`. Строки и `fingers`, итог. Предел 200 заказов.                                                                                            |
| POST `.../orders/:id/actions`                                                                                              | как сейчас                           | `handoff` заказа доставки с `details.kds` без трёх отметок -> 400 `INVALID_REQUEST`. С отметками -> `handed_over` и `delivery_handovers` в одной транзакции. Повтор идемпотентен через `fulfillment_commands`.            |
| POST `/edge/v1/fulfillment/incidents`                                                                                      | kitchen, manager (терминал assembly) | `Idempotency-Key` = `incident_id`. Тот же body возвращает сохранённый ответ, другой body -> 409.                                                                                                                          |
| GET `/edge/v1/fulfillment/incidents?status=open\|today`                                                                    | kitchen, manager                     | Баннер и журнал.                                                                                                                                                                                                          |
| POST `.../incidents/:id/updates` (P1), POST `/edge/v1/fulfillment/mode` (P1), GET `/edge/v1/fulfillment/returns?day=` (P1) | только manager                       | Обновление инцидента: `expectedVersion` + `Idempotency-Key`.                                                                                                                                                              |

**Синхронизация в облако.** Состояния исполнения уходят в облако существующими потоками без изменений. Для бухгалтерии ничего нового нет: KDS денег не касается. Возвраты, передачи, инциденты и смены режима отправляет в P1 шаг `kds_report` воркера меню (режим `auto` по правам, как в cfg) на `POST /internal/v1/edge/kds/events` (`@EdgeDeviceRoute`, идемпотентно по `event_id`).

## 5. Изменения UI (тексты RU, дефис «-»)

- **Общее.** Заголовок экрана - название станции. Переключатель станций остаётся только у менеджера. Метки заказа: «В ЗАЛЕ», «С СОБОЙ», «ДОСТАВКА · Яндекс Еда Я-123 / Glovo G-456». Позиция без раскладки - красная метка «Нет в раскладке - сообщите менеджеру».
- **Панировка (6).** Шапка: «В очереди: N заказов» и «Фингерсов: N», если заданы `count`. Карточка показывает названия и модификаторы. Кнопок нет, заказ уходит с экрана после «Собран».
- **Тосты и бургеры (5).** Полоса итогов «Нужно сейчас: Тосты 7 · Бургеры 3» и разбивка по позициям. Карточки с кнопкой «Готово». Если стол закрыл заказ раньше: «Отмечено сборкой».
- **Сборка (4.1 / 4.2).** Строки без напитков и соусов. Состояние тоста: «Тост: готов ✓ / в работе / ждём». Подсказка «Напитки и соусы - на выдаче». Кнопка «Собран».
- **Сборка в зашив (P1).** Колонка «Бургеры (все заказы)» с кнопкой «Бургер собран».
- **Выдача (2).** Колонки «Собирается» и «Готов к выдаче». В карточке весь заказ, блок «Подготовить на выдаче: напитки, соусы» и «Сборка: собран ✓». Кнопки:
  - «Готов - позвать гостя», затем «Выдан»;
  - для доставки - «Напитки переданы»;
  - (P1) «Вернуть на сборку» с причинами «Нет позиции», «Не та позиция», «Внешний вид», «Упаковка», «Другое».
- **Выдача доставки (3).** Плитки по номеру агрегатора и поле «Номер из приложения курьера» для фильтра; совпадение номера ставит первую отметку. Кнопка «Принять от сборки».
  - Диалог «Передача курьеру Я-123» с тремя отметками: «Номер в приложении курьера совпал», «Курьер при мне нажал «Принял заказ»», «Курьер сфотографировал заказ».
  - «Передать курьеру» активна только при трёх отметках.
  - «Отказ по протоколу» с причинами и описанием («Не вводите телефоны»), кнопка «Записать и вызвать менеджера».
  - Баннер «Менеджер вызван · Я-123 · 3 мин» на экранах 2 и 3. Звук - P2.
- **Менеджер (P1).** «Режим смены: Утро до 14:00 / Обычный / Зашив» и «Журнал курьеров». Подтверждение входом менеджера в диалоге: одноразовая сессия `staff/login`, команда и `logout`, без смены сессии станции.
- **Новые ошибки:** «Отметьте все три условия протокола передачи.»; «Раскладка KDS на сервере точки выключена - работает прежний экран.»

## 6. Изменения по файлам

**Контракты и облако**

- `packages/contracts/src/station-plans.ts`, `fulfillment.ts`, `openapi.json` - раздел 4.
- `packages/backoffice-core/src/model.ts:132-144` - `Station.kds?`; проверки: функция и роль (breading/toasts -> prep, остальное -> assembly), `counts` только среди `product_ids`, функции не повторяются.
- `packages/backoffice-core/src/station-plans.ts:37-61` - `kds` попадает в план только при флаге. Ошибка `NOT_READY` / `KDS_LAYOUT_INVALID` (новый `BackofficeErrorReason`, `model.ts:4-20`).
- `packages/platform/src/config.ts`, `services/api/src/station-plan-controller.ts` - флаг `BACKOFFICE_KDS_LAYOUT_ENABLED` и `capabilities.kds_layout`.
- `apps/backoffice/src/operations.ts:~992-1000`, `operations-model.ts` - выбор функции, таблица `count/unit`, предупреждение «Позиции меню без раскладки: N».

**Edge**

- `packages/fulfillment-state/src/index.ts` - `cascade` в `planCompleteStation`; (P1) `planCompleteLines`, `planReturnToAssembly`, `commandShape`.
- `packages/edge-fulfillment/src/kds.ts` (новый) - `orderParts`, `kdsTaskPlan`, `slugResolver(menu)`.
- `packages/edge-fulfillment/src/kds-layout.ts` (новый) - `readKdsLayout`: настройки, активный план, готовность схемы; кэш по `plan_id`.
- `packages/edge-fulfillment/src/model.ts` - тип `details.kds`; `StaffCommandSchema` (`handover`, `cascade`, P1-поля); `taskPlan` переводится на `orderParts` без изменения результата.
- `packages/edge-fulfillment/src/local-pos.ts:35-121` - `snapshot.delivery`, единый `buildTaskPlan` (прежний или KDS), `assembly_station_id` = завершающая станция.
- `packages/edge-fulfillment/src/repository.ts`:
  - `243-283` - KDS-план при резервировании облачного заказа;
  - `507-564` - `cascade`, отметки передачи, `delivery_handovers`;
  - `698` - фильтр доставки на табло;
  - новые `readBreading`, `recordIncident`, `listIncidents`.
  - `records.ts` не трогается: события прежние.
- `packages/menu-sync/src/routing.ts:99-102` - prep-станция для новых позиций = та, на которую указывают действующие prep-маршруты; иначе требуется единственная prep-станция.
- `packages/menu-sync/src/station-plan.ts:132-166` - `checkedKdsLayout`, нарушение -> `INVALID_PLAN`.
- `services/edge/src/fulfillment-controller.ts:90-123,282-322` - вывод `kds`/`delivery`, терминальные проверки новых действий. Новый `kds-controller.ts` подключается в `services/edge/src/index.ts:74-83`.
- `db/edge/migrations/NEXT_edge_kds.sql`.
- `infra/windows/kds-upgrade-db.mjs` (новый, `inspect|apply`, по образцу `station-plan-upgrade-db.mjs`): миграция, станции, права, строка настроек. Отказывает, если runtime не умеет несколько prep-станций.
- `infra/windows/kds-grants.mjs`; `infra/windows/kds-switch.mjs enable|disable --reason` (owner env).
- `native-edge-backup-ledger.json` и `edge-backup-lib.mjs` (`EDGE_BACKUP_SCHEMAS`) - запись edge-NEXT.

**LAN**

- `infra/windows/lan-route-profiles.mjs` (новый) - три профиля:
  - `kitchen`: прежний список + маршруты KDS + `restore-review`;
  - `display`: `pair`, `session`, `config`, `display`, `healthz`;
  - `pos`: зеркало `apps/pos-desktop/protocol.mjs:9-16`, плюс `media` и `/health/ready`.
- `infra/windows/kitchen-lan-gateway.mjs` - конфиг `clients:[{address,profile,label}]` (старый `clientAddresses` считается профилем kitchen), проверка профиля по `remoteAddress`, `maxConnections` из конфига (64).
- `infra/windows/update-kitchen-lan-clients.ps1` (новый) - сверяет SHA, переписывает приватный конфиг с сохранением ACL, выполняет `Set-NetFirewallRule -RemoteAddress @(...)`, перезапускает и проверяет, пишет `installation.json v2`.
- `kitchen-lan-check.mjs` - проверки по профилям. Документы `kitchen-lan.md`, `docs/operations/lan-kitchen-client.md`.

**Клиент кухни**

- `apps/kitchen/src/types.ts`, `api.ts`, `model.ts` - раскладка, экран по `screen`, итоги, `allowedActions` с учётом `cascade` и `handover`.
- `app.ts`, новый `kds-view.ts`, `styles.css`, `demo.ts` (раскладка в демо, P1).
- `apps/kitchen/server.mjs:11-44,125-152` - allowlist и assets.
- `apps/kitchen-desktop/security.mjs` (`ASSETS`), `scripts/inputs.mjs`, `scripts/verify-package.mjs`; версия 0.2.0.
- `infra/windows/install-kitchen-client.ps1` (новый) - config из публичного файла + `terminalMode`, ACL, проверка SHA сертификата, автозапуск при входе (выключен до 19.11), питание без сна.

**Документы**

- `docs/operations/kds-stations.md` (runbook), `docs/architecture/adr/0015-kds-layout.md` (решение: план задаёт раскладку).
- `docs/project-status.md`, `docs/roadmap/project.json`.

## 7. Флаги, безопасный выпуск, установка

**Ключи включения** - все по умолчанию выключены:

| Ключ                                       | По умолчанию | Что делает                                                                             |
| ------------------------------------------ | ------------ | -------------------------------------------------------------------------------------- |
| `BACKOFFICE_KDS_LAYOUT_ENABLED` (API)      | false        | Включает `kds` в план; нужен `BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED`.               |
| Схема edge-NEXT и права                    | нет          | Ставятся только охраняемым `kds-upgrade-db`.                                           |
| `kds_settings.layout_enabled` (БД edge)    | false        | Меняет только `kds-switch.mjs`. Работает без WAN, это мгновенный выключатель на точке. |
| Старый `clientAddresses` в конфиге gateway | принимается  | Профили действуют только при новом конфиге.                                            |
| Экран кухни                                | прежний      | Новый вид - только при `layout.enabled=true`.                                          |

Слияние и деплой поведения не меняют.

**Порядок выпуска**

1. API с кодом, флаг выключен (после окна С3).
2. Windows. После 024 (К5, 10.11) и 025 (С4, ночь на 15.11) в том же окне: runtime с исправлением `routing.ts`, затем `kds-upgrade-db inspect -> apply`, затем `/health/ready`. Поведение прежнее.
3. LAN. К7 (10-11.11): `update-kitchen-lan-clients` с IP всех экранов (профиль kitchen, текущий код gateway уже принимает N адресов). В окне С4 - gateway с профилями и маршрутами KDS, а также POS-клиенты по LAN.
4. Kitchen 0.2.0 на 5 моноблоков и устройство табло, рядом с iiko, автозапуск выключен (КД12, 14-16.11).
5. Флаг API включён. В кабинете: станции, функции, данные М3, привязка станций кассы и устройств, «Отправить план на кассу» -> «Применено на кассе».
6. Т7/Т9: `kds-switch enable --reason "Т9"` (при необходимости `disable` после учения).
7. 19.11 до открытия: `enable`, КД13.

**Откат**

- `kds-switch disable`: новые заказы идут на прежние станции «Приготовление» и «Сборка» (права `kitchen` на них сохраняются), начатые заказы KDS заканчиваются на своих станциях.
- Флаг API выключить и опубликовать план без `kds`.
- Откат runtime - только после того, как начатые заказы KDS выданы: старый runtime не закрывает тосты автоматически, их закрывают на экране 5.
- Схемы и строки не удаляются.

**Установка и привязка (К3, КД6, К7, К8, КД12)**

1. К3: резерв DHCP для всех моноблоков, табло и сервера .69. Без него allowlist по IP перестанет работать.
2. КД6: на каждом устройстве - build Windows, x64, разрешение, масштаб, сенсор, IP.
3. Сервер: `update-kitchen-lan-clients.ps1` с картой IP -> профиль. Проверка: `healthz` и 401 с каждого клиента, 403 с чужого IP, 404 для маршрута чужого профиля.
4. Каждый экран: установщик Kitchen и `install-kitchen-client.ps1 -Mode prep|assembly|display -PublicConfig <файл> -CertSha256 <хеш>`.
5. Привязка (нужен WAN): менеджер в «Устройства» нажимает «Подключить экран» с названием «Панировка 6», «Тосты 5», «Сборка зал», «Сборка доставка», «Выдача», «Табло». Код вводится на экране. В «Станции и маршруты» выбрать устройство станции и опубликовать. Экран открывает свою станцию, вход общим логином `kitchen`. Табло работает без входа.
6. Проверка: тестовый заказ проходит все экраны, затем отключаем WAN на 10 минут и повторяем.

## 8. Тесты

**Новые**

- **Машина состояний.** `packages/fulfillment-state/tests/state-machine.test.mjs`: векторы `cascade` и запрет каскада вне утреннего режима. Прежние векторы не меняются (`state-machine-vectors.test.mjs`).
- **Раскладка, unit.** `packages/edge-fulfillment/tests/kds-plan.test.mjs`:
  - зал, с собой, доставка, отсутствие 4.2 или 3;
  - комбо кассы (родитель) и облачное комбо (компоненты);
  - напитки и соусы отдельной строкой и выбором в комбо;
  - единицы тостов, флаги и число фингерсов, `unmapped`;
  - эталон: без раскладки `taskPlan` побайтно прежний.
- **Раскладка на PostgreSQL.** `packages/edge-fulfillment/tests/kds-postgres.test.mjs`:
  - выключено - задачи прежние; включено - касса и облако (резерв и допуск) создают KDS-задачи;
  - полный зал; доставка: без отметок отказ, с отметками - запись передачи, отказ -> инцидент;
  - повторы с тем же и с другим телом;
  - гонка «тост» и «стол»; отмена кассой до старта; проверка после восстановления;
  - **каждое событие outbox разбирается `PosKitchenEventSchema` и `EdgeEventPayloadSchema`** - защита строгих потоков.
- **План станций.** `tests/integration/kds-station-plan.test.mjs`: план с `kds` применяется и виден в `/layout`; строгий разбор 024 даёт `INVALID_PLAN`, прежний план остаётся; ошибки раскладки; флаг выключен - `kds` в плане нет.
- **Маршруты меню.** `tests/integration/menu-routing.test.mjs` + случай «3 prep-станции, новая позиция меню применяется».
- **Windows.** `tests/integration/windows-kds.test.mjs`: `inspect/apply` на базе 024/025, точный набор прав, повтор отказывает, другие роли новых таблиц не видят; `kds-switch`.
- **LAN.** `tests/operations/kitchen-lan.test.mjs` и `kitchen-lan-chain.test.mjs`: несколько клиентов, профили, старый конфиг, табло не получает `/kitchen`, профиль pos совпадает с регулярными выражениями pos-desktop (импорт обоих).
- **Клиент кухни.**
  - `apps/kitchen/tests/model|api|gateway.test.mjs`;
  - `tests/kitchen/browser.test.mjs`: сценарий KDS на 5 экранах + Выдача доставки при 1280×800 и 1920×1080;
  - `apps/kitchen-desktop/tests/security|electron.test.mjs`.
- **Кабинет.** `tests/backoffice/station-plan-model.test.mjs` и браузерный тест полей `kds`.

**Существующие наборы:** `pnpm test`, `test:fulfillment`, `test:kitchen`, `test:pos`, `test:pos-order-sync`, `test:fulfillment-transport`, `test:integration` (station-plans, stage2-cross-lane, pos-unpaid-kitchen, edge-fulfillment-http), `test:backoffice`, `contracts:check`, typecheck/lint/format, `python3 -m unittest discover -s tests/operations`, kitchen-desktop `npm test` и `test:electron`. Стенд офлайн (`offline-stand.yml`): LAN-outage и WAN-outage.

## 9. Зависимости и общие файлы

- **КС5 (касса).** Маркировка доставки нужна до 12.11. Предложение: `PosOrderDetailsSchema.aggregator = {provider:'yandex_eda'|'glovo', external_number:/^[A-Za-z0-9-]{1,20}$/}` при `service_mode='takeaway'`; в снимке edge -> `delivery`.
  - Новое значение `service_mode` ломает установленные приложения кухни (`types.ts:211`) и вывод edge (`fulfillment.ts:64`).
  - Облачный разбор POS sync КС5 обновляет первым.
  - Без маркировки нет разделения на 4.1/4.2 и проверки протокола Аг9 (запасной путь - всё на 4.1, протокол на бумаге).
- **Платежи.** Путь оплаченного допуска POS обязан вызывать `buildTaskPlan`. Общие файлы: `local-pos.ts`, `repository.ts`.
- **С4/279.** Общие `kitchen-lan-gateway.mjs` (`restore-review`), ledger копий и `edge-runtime-grants`. Наша edge-NEXT идёт после 025, в одном окне.
- **Этап 2 cfg.** cloud070 и edge024 установлены (С3, К5), флаг доставки плана включён.
- **Меню (М1-М4).** Состав комбо и связанные товары (М2); данные раскладки шефа (М3) вносятся после выпуска API или через шаблон TSV.
- **POS по LAN (касса).** Upstream с закреплённым TLS в `pos-desktop`, использует наш профиль pos.
- **Учёт времени (ZKTeco).** Расстановка смены для учёта ошибок по людям (P2).
- **Общие файлы:** `packages/contracts/src/{fulfillment,station-plans,index}.ts`, `openapi.json`, `packages/edge-fulfillment/src/{local-pos,repository,model}.ts`, `packages/fulfillment-state/src/index.ts`, `packages/menu-sync/src/{routing,station-plan}.ts`, `packages/backoffice-core/src/{model,station-plans}.ts`, `apps/backoffice/src/operations.ts`, `services/edge/src/{index,fulfillment-controller}.ts`, `infra/windows/{kitchen-lan-gateway.mjs,native-edge-backup-ledger.json,edge-backup-lib.mjs}`, `apps/kitchen/server.mjs`, `apps/kitchen-desktop/security.mjs`.

## 10. Приоритеты

**P0 - к 19.11**

- P0-1: раскладка в плане и кабинете (КД1, КД2).
- P0-2: KDS-допуск на edge (КД1, КД2, КД3).
- P0-3: edge-NEXT и охраняемые инструменты.
- P0-4: экраны 6, 5, 4.1, 4.2, 2 (КД1, КД3).
- P0-5: Аг9 с записью отказа (с фильтром доставки на табло, КД10).
- P0-6: КД7 - профили LAN и N клиентов.
- P0-7: установка и привязка (КД12, К7, К8), межполосные тесты.

**P1 - желательно до 19.11:** КД4 (фингерсы), КД5 (режимы), КД9, Аг10 (журнал и действия менеджера), отправка событий KDS в облако (cloud-NEXT), КД10 (устройство табло, второе окно), Т9 (скрипт `kds-drill.mjs` и раскладка в демо).

**P2 - после запуска:** КД8 (печать бегунка: агент печати в main kitchen-desktop через `webContents.print({silent})`, очередь `kds_print_jobs`), КД11, учёт ошибок по людям, звук, предпросмотр раскладки в кабинете.

## 11. Оценка P0 (инженеро-дни)

| Пункт                                                                                            | Дни                                             |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| P0-1 Контракты, `Station.kds`, план, кабинет                                                     | 1,5                                             |
| P0-2 `kdsTaskPlan`, два пути допуска, `cascade`, правка `routing.ts`, `/layout`, `/kds/breading` | 2,5                                             |
| P0-3 Миграция, `kds-upgrade-db`, `kds-switch`, права, ledger                                     | 1,5                                             |
| P0-4 Экраны в приложении кухни, сборка desktop                                                   | 2,5                                             |
| P0-5 Аг9: edge (передача, инциденты) + экран 3 + фильтр табло                                    | 1,5                                             |
| P0-6 Профили gateway, скрипт обновления, firewall, проверки                                      | 1,5                                             |
| P0-7 Установщик клиента, runbook, межполосные тесты, release doc                                 | 1,0                                             |
| **Итого**                                                                                        | **12,0** (3 инженера: edge, клиент, облако+LAN) |

P1 - около 7 дней: КД4 - 0,5; КД5 - 1,5; КД9 - 1,5; Аг10 - 1,0; облако - 1,5; КД10 - 0,5; Т9 - 0,5.

## 12. Риски и вопросы владельцу

**Риски**

- **Окна установки.** К5 (10.11) и С4 (15.11) - единственные окна Windows. КД1-КД3 до 12.11 по трекеру достижимы только в коде; установка возможна в ночь на 15.11, проверка на Т9 (17.11).
- **Маркировка доставки (КС5).** Не придёт - нет разделения на 4.1/4.2 и проверки протокола Аг9.
- **Публикация меню.** Без исправления `routing.ts` новые станции сломают публикацию меню. Inspect инструмента это проверяет.
- **Строгие потоки событий.** Новый тип события остановит POS sync. Защита - контрактный тест.
- **Общий логин `kitchen`.** Не даёт персональной ответственности (КД9).
- **WAN для привязки.** Привязка экранов требует интернета; все экраны и запасной экран привязать до 17.11.
- **LAN.** Смена IP без резерва DHCP отрезает экран. Нужен нагрузочный прогон 8 клиентов через gateway (UNCONFIRMED: `maxConnections` и TLS на каждый запрос).
- **Железо и ПО (UNCONFIRMED).** Модели и сенсор моноблоков, конфликт порта 4178 с iiko, количество касс для POS по LAN.

**Вопросы владельцу**

1. Подтвердить сервер точки 192.168.2.69 (Р19).
2. Станция 3: свой моноблок или вкладка на экране 4.2 (по умолчанию - вкладка)?
3. Напитки и соусы для доставки готовит Выдача (2), как по умолчанию, или Выдача доставки (3)?
4. Какое устройство выводит табло на ТВ: отдельный мини-ПК или второй выход моноблока выдачи?
5. Утром один человек собирает и заказы доставки (стол 2)? Какие позиции считаются «бургерами» для третьего сборщика, и где он смотрит - на экране 4.2?
6. Шеф (М3): фингерсов на 1 шт. каждой позиции и комбо, тост или бургер по позициям 5-й станции, список позиций «только на выдаче».
7. Т9: можно ли проводить учение 17.11 на рабочей кассе с тестовыми заказами? Они попадут в облако до учётного старта 19.11 - бухгалтерия должна исключить их по дате.
8. Есть ли у менеджеров логин с паролем для экранов кухни (режим, инциденты), или эти действия делать на кассе?
9. КД8: что сейчас печатает iiko на поднос, какой принтер и как подключён (Р18, КД6)?
