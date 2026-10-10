# Облачный кухонный канал: этап S4 (экраны кухни, оплата, BO)

Решение: [ADR-0014](adr/0014-cloud-kitchen-channel.md), архитектура:
[cloud-kitchen-channel.md](cloud-kitchen-channel.md), предыдущие этапы: [S2](cloud-kitchen-s2.md),
[S3](cloud-kitchen-s3.md). По решению владельца новая схема не зависит от реестра устройств
(cloud 051) и от кассы. В production ничего не включено: все точки в режиме `edge`, флаги
`CLOUD_KITCHEN_API_ENABLED` и `BACKOFFICE_CLOUD_KITCHEN_ENABLED` по умолчанию выключены,
гранты 056 не подключены в provisioning, релиз на VPS не выполнялся.

## Что сделано

### Cloud 056 (`db/cloud/migrations/056_cloud_kitchen_screens.sql`), только добавления

- `cloud_kitchen_screens`: экран точки с ролью `prep`|`assembly`|`display`, станциями (trigger:
  станции этой точки, вид совпадает с ролью, без повторов; у `display` станций нет), имя,
  `generation`, `key_hash` (sha256 ключа, ключ не хранится), отзыв (`revoked_at/by/reason`,
  окончательный), `last_seen_at` (только вперёд). Идентичность неизменяема, удаление запрещено,
  смена ключа только с `generation + 1`.
- `cloud_kitchen_pairing_codes`: одноразовый код `XXXX-XXXXXX` (публичный selector 4 символа +
  секрет 6 символов, алфавит Crockford). Хранится только соль и hash. CHECK: срок не больше
  10 минут, не больше 5 неверных попыток (пятая сжигает код), использован или сожжён - не оба.
  Один открытый код на экран и уникальный открытый selector. Trigger: код одноразовый, после
  использования/сожжения не меняется, счётчик растёт на 1.
- `cloud_kitchen_screen_events`: неизменяемый журнал (`created`, `code_issued`, `paired`,
  `code_burned`, `revoked`) с actor (`bo:<id>` или `owner:<имя>`) и причиной.
- `cloud_channel_orders`: заказ kiosk/mobile, созданный в режиме `cloud` (trigger проверяет режим
  и epoch точки, канал, отсутствие edge-резерва). `fiscal_status` = `deferred_no_receipt`
  (решение владельца: чек пока не выбивается, заказ помечен для последующей сверки), допустим
  только переход в `reconciled` с автором и ссылкой. Существующие `fiscal_policy` (027) не
  трогаются: их CHECK и trigger не допускают такого состояния.
- `cloud_channel_order_registered(uuid)` (SECURITY DEFINER, фиксированный search_path) и новая
  версия guard 046 `commerce_attempt_insert_guard`: заказ без edge-резерва может начать оплату,
  если это облачный заказ. Edge-заказы и kiosk QR проверяются как раньше и первыми, их роли
  функцию не вызывают.

### Экраны кухни (`packages/cloud-kitchen/src/screens.ts`)

- `createScreenInTransaction`, `issuePairingCodeInTransaction` (выпуск сжигает прежний открытый
  код экрана и все просроченные), `revokeScreenInTransaction` (ключ и открытый код перестают
  работать сразу), `listScreens`, `exchangePairingCode` (код -> ключ `pcks_` + 32 случайных байта,
  показывается один раз; неверный секрет коммитится как попытка даже при ошибке; все отказы
  одинаковые), `authenticateScreen` (по hash ключа; с `heartbeat` в том же запросе пишет
  `cloud_kitchen_station_presence` по всем станциям экрана - вход gate `KITCHEN_OFFLINE`).
- Ротация: новый код для живого экрана; старый ключ работает до обмена нового кода, после
  обмена - сразу нет (`generation + 1`).
- Оператор владельца: `infra/staging/cloud-kitchen-screen-owner.mjs`
  (`create|pairing-code|revoke|list`, обязательные `--operator` и `--reason`).

### `/v1/kitchen/*` (`services/api/src/cloud-kitchen-controller.ts`)

- Тестовый hook S2 (`CLOUD_KITCHEN_TEST_AUTH`, заголовок actor) удалён. Аутентификация -
  `Authorization: Bearer pcks_...` учётной записи 056 (портал или экран). По умолчанию только
  внутренняя сеть: запросы с заголовками пересылки gateway - `404`. `POST /v1/kitchen/pairing` (`{pairingCode}`) -> ключ;
  любой отказ - один и тот же `401`.
- `prep`/`assembly`: `GET /me`, `/stations`, `/kitchen`, `/display`, `/orders/:id`,
  `POST /commands`. `display`: только `/me`, `/stations`, `/display` (остальное `403`).
  Опрос `/kitchen` - heartbeat станций экрана. Экран никогда не manager: `confirm_cancel`
  остаётся за BO (следующий этап).
- Без `CLOUD_KITCHEN_API_ENABLED=1` все маршруты `404`; `createApi` регистрирует контроллер и
  провайдеры только при флаге.

### Оплата (`packages/commerce-core`)

- `cloud-channel.ts`: чтения с проверкой прав, как gate S3 (нет таблиц 054/056 или нет гранта -
  заказ edge, поведение прежнее); `useCloudKitchenAdmission` - точка подключения облачной кухни
  в процессе (API регистрирует `CloudKitchen` при включённом флаге); `cloudKitchenProjection` -
  проекция облачного заказа в той же форме, что `cloud_fulfillment_projection` для order-view.
- `repository.ts`:
  - создание заказа: kiosk/mobile в режиме `cloud` (под shared-блокировкой режима) -> запись
    `cloud_channel_orders`, состояние `awaiting_payment`, `edge.admission_requested` **не**
    создаётся. В режиме `edge` - прежний код и прежнее событие;
  - начало оплаты облачного заказа: точка всё ещё в `cloud`, есть свободный номер канала, иначе
    `NOT_READY`; привязка кассы и резерв edge не нужны;
  - `reconcile`: для облачного заказа чек не создаётся (`fiscal.submit_requested` нет), при полной
    оплате без возвратов/отмены вызывается `admitCloudChannelOrderInTransaction` в транзакции
    capture через SAVEPOINT: ошибка допуска (номера закончились, нет маршрутизации) не отменяет
    capture, заказ допустит следующий опрос ленты. Если точка ушла из `cloud` до оплаты - заказ
    уходит на проверку (`CLOUD_MODE_CHANGED_BEFORE_ADMISSION`), решение `edge` не пишется.
    `edge.kitchen_admission_requested` для облачных заказов не создаётся;
  - `kaspi-remote.ts` (счёт Kaspi): облачный заказ готов к выставлению без edge-резерва.
- `@pickchick/cloud-kitchen`: `admitCloudChannelOrderInTransaction` (никогда не пишет решение
  `edge` для облачного заказа) и `admitPendingPaid(branch)` - допуск оплаченных облачных заказов,
  которые зафиксировал процесс без hook (воркер Kaspi QR); вызывается при каждом опросе ленты.

### BO (`packages/backoffice-core/src/cloud-kitchen.ts`, `services/api/src/cloud-kitchen-backoffice-controller.ts`)

`/v1/admin/backoffice/branches/:branchId/cloud-kitchen`: `GET` (режим, маршрутизация, станции и
их онлайн, экраны), `POST screens` (экран + первый код), `POST screens/:id/pairing-code`,
`POST screens/:id/revoke` (`requestId`), `GET|POST mode` (`owner`, `expectedEpoch`,
`requestId`, `reason`; в `cloud` только с маршрутизацией), `GET|POST stops`,
`POST stops/override` (сервис `CloudChannelStops` из S3). Запись - только `manager`, причина
обязательна, аудит в `bo_audit` (`cloud_kitchen:*`), идемпотентность через `bo_commands`.
Код сопряжения не повторяется и не хранится. Контроллер регистрируется только при
`BACKOFFICE_CLOUD_KITCHEN_ENABLED=true`, сервисы дополнительно требуют `BACKOFFICE_ENABLED`
(и `BACKOFFICE_CLOUD_STOPS_ENABLED` для стопов).

### Гранты (`infra/staging/cloud-kitchen-screen-grants.mjs`)

`cloudKitchenScreenGrants` (API: экраны/коды INSERT и UPDATE только нужных колонок, журнал
append-only, чтение облачных заказов) и `cloudChannelOrderGrants` (commerce и воркеры
оплаты: регистрация и чтение облачных заказов, режим, диапазоны номеров). Для допуска
нужны также `cloud-kitchen-grants.mjs` (054) и `channel-number-grants.mjs` (053). В provisioning
не подключены.

### Ошибка `KITCHEN_OFFLINE`

- Mobile: текст «Кухня сейчас не на связи - заказ оформить нельзя. Попробуйте чуть позже.»
  (`apps/mobile/src/commerce-presentation.ts`), preflight S3 повторяет запрос.
- `packages/platform/src/http.ts`: клиенты без `profile=pickchick.checkout-errors-v1` получают
  `SERVICE_UNAVAILABLE`, как для `AVAILABILITY_STALE`. Сейчас код не входит в `ErrorSchema`,
  поэтому все клиенты уже получают `SERVICE_UNAVAILABLE` (503); после добавления в контракт
  новые клиенты увидят `KITCHEN_OFFLINE`.

## Контракт кухонного портала (уточнение владельца 2026-10-10)

Облачные заказы показываются на существующих страницах портала `/kitchen-live/{prep,assembly,display}`
(`infra/kitchen-portal`, ADR-0011), а не на новой странице. Объединение облачной ленты с лентой
кассы в портале - следующий этап; `infra/kitchen-portal` в S4 не менялся. Механизм «экранов»
056 используется как внутренняя служебная учётная запись портала, привязанная к точке и роли;
отдельные планшеты с кодом сопряжения - вторичный вариант той же записи.

Что ожидается от сервера портала:

1. Учётные данные. Для каждой пары (точка, роль) владелец один раз создаёт запись и код:
   `cloud-kitchen-screen-owner.mjs create --branch <id> --role prep --station <id> ... --name
"Портал: горячий цех" --operator <имя> --reason <причина>`; оператор на VPS обменивает код
   (`POST /v1/kitchen/pairing {"pairingCode":"XXXX-XXXXXX"}`) и кладёт ключ `pcks_...` в
   окружение портала (файл с правами 0600, не в Git и не в логи). Роли: `prep` (станции prep),
   `assembly` (станция сборки), `display` (без станций). Ротация - новый код и обмен (старый ключ
   перестаёт работать в момент обмена), отзыв - `revoke` (сразу). Ключи браузеру не выдаются.
2. Сеть. Портал обращается к API напрямую по внутренней сети VPS (docker-сеть, без публичного
   gateway). `/v1/kitchen/*` не публикуется через gateway; API по умолчанию отвечает `404`
   на любой запрос с `Forwarded`/`X-Forwarded-*`/`X-Real-IP` (флаг `CLOUD_KITCHEN_PUBLIC=1`
   отключает это только для прямых планшетов, порталу не нужен). Включение API -
   `CLOUD_KITCHEN_API_ENABLED=1`.
3. Сессия портала. Портал сам проверяет свою сессию (ADR-0011/0013, как сейчас) и выбирает ключ
   по роли страницы и точке сессии; запросы без действующей сессии портала в API не уходят.
4. Опрос. Страница prep/assembly: `GET /v1/kitchen/kitchen?stationId=<id>&limit=50` с ключом
   своей роли не реже раза в 10 секунд, пока страница открыта и сессия действует. Каждый такой
   запрос записывает heartbeat всех станций ключа (`cloud_kitchen_station_presence`); gate
   `KITCHEN_OFFLINE` открыт, пока за 30 секунд был опрос хотя бы одной станции prep и одной
   assembly. Портал не должен опрашивать ленту, если у него нет открытых страниц кухни (иначе
   gate показывал бы кухню онлайн без людей). Табло: `GET /v1/kitchen/display` с ключом
   `display` (heartbeat не пишет).
5. Команды. `POST /v1/kitchen/commands` с `Idempotency-Key` (8-128 символов `[A-Za-z0-9._:-]`,
   уникальный на действие повара; повтор того же действия - тот же ключ) и телом
   `{orderId, expectedVersion, action, stationId?|taskId?, expectedTaskVersion?}`. Ответ -
   новое состояние заказа (`version`); `409 CONFLICT` - перечитать ленту. Журнал команд ведётся
   по устройству = id учётной записи портала (точка+роль). Отмена (`confirm_cancel`) - только
   управляющий через BO, не портал.
6. Объединение. Заказы облака помечены `fulfillmentOwner: "cloud"` и номером 300-599 (kiosk) /
   600-899 (mobile); команды для них портал отправляет только в облако, для заказов кассы - как
   сейчас в кассу через туннель. Дубли по `orderId` отбрасываются.

## Тесты

- `tests/integration/cloud-kitchen-payment.test.mjs` (PostgreSQL, изолированные схемы cloud и
  edge): kiosk в режиме `cloud` при молчащей час кассе - без опроса экранов `KITCHEN_OFFLINE`,
  заказ без `edge.admission_requested`, Kaspi QR, имитация доверенного capture, номер 300-599 в
  той же транзакции, без чека и `fiscal.submit_requested`, экраны с ключами по HTTP проводят
  `start_task` -> `complete_station` -> `ready` -> `handoff`, чужая станция `403`, табло, номер
  освобождён; без hook - допуск при следующем опросе, идемпотентно; смена режима до оплаты -
  `NOT_READY`, во время оплаты - проверка без допуска; режим `edge` - прежние события и чек.
- `tests/integration/cloud-kitchen-screens.test.mjs`: проверка станций/ролей и trigger,
  одноразовость и повтор кода, 5 неверных попыток, истечение 10 минут, ротация и отзыв,
  heartbeat и gate (prep без assembly, `display`, старше 30 с), оператор владельца,
  ограниченная роль с грантами 054 + 056.
- `tests/unit/cloud-kitchen-controller.test.mjs` (flag, 401/403, heartbeat только у ленты,
  pairing), `tests/unit/cloud-kitchen-screen-grants.test.mjs`,
  `tests/mobile/commerce-presentation.test.mjs`.
- `tests/integration/workforce-release.test.mjs`: кандидат релиза workforce ограничен
  миграциями до 052 (как в соседних guard-тестах), иначе guard справедливо отказывал из-за
  053-056.

## Не сделано и заблокировано

- `packages/commerce-core/src/order-view.ts` (занят `tiptoppay-backend`): чтение заказа для
  iPad и приложения должно брать `cloudKitchenProjection(pool, orderId)`, если
  `cloud_fulfillment_projection` пуст, и показывать `receipt: 'deferred'` для облачных заказов.
  Пока экран заказа показывает «оплачен» без номера; номер и статус есть в БД и на табло.
- `packages/contracts/src/index.ts` + `openapi.json` (`openapi.json` занят `inventory`): код
  `KITCHEN_OFFLINE` в `ErrorSchema`.
- `apps/kiosk` (занят `kiosk-build12`): текст KZ/RU/EN, например RU «Кухня сейчас не на связи -
  заказ оформить нельзя. Пригласите сотрудника.»
- `services/api/src/customer-checkout-controller.ts` (занят `mobile-live-fixes`): отдельная
  правка не нужна - ошибка уже отдаётся 503, понижение кода для старых клиентов сделано в
  `http.ts`.
- `packages/commerce-core/src/kiosk-checkout.ts` (занят `kiosk-v3-launch`): готовность киоска
  (`config().enabled`) по-прежнему требует зарегистрированного активного устройства кассы и
  активной привязки (это настройка, не связь). Для режима `cloud` её стоит заменить на
  настроенную облачную кухню.
- Неоплаченная отмена облачного заказа (`requestUnpaidCancellation`) ждёт edge-резерва, которого
  нет; номер облачному заказу выдаётся только при оплате, поэтому он не занимается.
- UI BO, подключение грантов в provisioning, отчётное зеркало (protocol 5) и сверка
  `deferred_no_receipt` - следующие этапы.
