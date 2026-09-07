# LAN API локальной кухни и служебного табло

Этот этап подключает `@pickchick/edge-fulfillment` к `services/edge`.
HTTP вызывает настоящие PostgreSQL-транзакции локального домена и использует
действующие staff sessions. Это opt-in интерфейс для LAN, выключенный по
умолчанию. Cloud API, публичный VPS, мобильный checkout и TEST-кухня не меняются.
[Домен и границы допуска](edge-fulfillment.md) ·
[OpenAPI](../../packages/contracts/openapi.json).

## Включение и привязка

Для локального edge задать `EDGE_FULFILLMENT_ENABLED=true` и `EDGE_DEVICE_ID`
равный доверенно настроенному `fulfillment_config.device_id`. `EDGE_BRANCH_ID`
должен совпадать с той же локальной привязкой. Нужны edge-миграция
`005_edge_fulfillment.sql`, stations/routing и назначения персонала через
существующие внутренние `provisionFulfillment`/`grantStation`. HTTP не выдаёт
credentials и не позволяет менять эту настройку. Cloud-сервис отклоняет
включённый `EDGE_FULFILLMENT_ENABLED`.

`/health/ready` при включённом флаге проверяет ledger `005`, serving tables,
branch/device и существующую активную routing version. При выключенном флаге
старый POS не зависит от fulfillment schema. Остальные fulfillment routes
возвращают `404`, кроме `GET /edge/v1/fulfillment/config` с `{ "enabled": false }`.
Config содержит только boolean и, как остальные ответы, имеет `Cache-Control:
no-store`. Он отражает флаг, а фактическую готовность показывает readiness.

Сетевой доступ ограничивать локальной доверенной сетью и принятым TLS/proxy
каналом; этот модуль сам не устанавливает сертификаты или firewall.
Существующий loopback-запуск не означает настройку физической ресторанной LAN.
Токены не помещать в URL, логи, публичные ссылки или Git.

## Аутентификация

Все перечисленные ниже routes, кроме config, требуют одновременно:

- `Authorization: Bearer <64 lowercase hex>` — существующий staff secret;
- `X-Staff-Session-Id: <UUID>` — ID той же сессии;
- `X-Terminal-Id: <UUID>` — terminal ID, к которому сессия действительно
  привязана в PostgreSQL. Этот заголовок не заменяет секрет и не доказывает
  физическую идентичность оборудования.

Разрешены только `kitchen` и `shift_manager`. Проверяются branch, active terminal,
active staff, срок и отзыв сессии. `cashier` не получает KDS/LED доступ.
Сотрудник `kitchen` обязан передать назначенный `stationId` при чтении очереди
или одного заказа; manager может читать всю свою точку. Роль из тела или
заголовка клиента не используется. Перед/после чтения проверяются актуальные
сессия, terminal и привязка; домен дополнительно проверяет station в той же
MVCC-транзакции, в которой читает заказ/задачи.

Сборка видит заказ по **закреплённой assembly station**, даже если все его
задачи относятся к приготовлению. Проверка одного заказа учитывает pinned
assembly или наличие задания станции, включая выданные/отменённые заказы.
Текущий routing не переписывает старый допуск.

## Routes и данные

Общий префикс — `/edge/v1/fulfillment`. Branch/device берутся из конфигурации
edge; выбрать другую точку через query/body нельзя. Неизвестные query/body
поля отклоняются. Runtime-схемы находятся в
[`packages/contracts/src/fulfillment.ts`](../../packages/contracts/src/fulfillment.ts).

| Метод и путь                    | Запрос                                                     | Ответ                                                                                                |
| ------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /config`                   | Без credentials                                            | `{ enabled }`                                                                                        |
| `GET /stations`                 | Staff headers                                              | `{ branchId, items: [{ id, kind, name }] }`; назначенные станции сотрудника либо все станции manager |
| `GET /kitchen`                  | `stationId?`, `afterOrderId?`, `limit=1..100` (default 50) | `{ items: KitchenOrder[], nextAfterOrderId: UUID \| null }`                                          |
| `GET /orders/:orderId`          | `stationId?`                                               | `Order`                                                                                              |
| `POST /orders/:orderId/actions` | Staff headers, `Idempotency-Key: UUID`, команда ниже       | Неизменяемый `Summary` результата этой команды                                                       |
| `GET /display`                  | `afterNumber?`, `limit=1..100` (default 50)                | `{ items: [{ number: string, state: preparing \| ready }], nextAfterNumber: string \| null }`        |

`Summary` содержит только `orderId`, `branchId`, `version`, `state`,
`displayNumber`, `routingVersion`, `createdAt`, `updatedAt`. В `KitchenOrder`
добавлены `assemblyStationId`, `channel`, `serviceMode`, `tasks`. `Order` также
содержит `cancellationReason` и `inventoryDisposition`.

Задание содержит `taskId`, `stationId`, `version`, `state`, `kind`, `details`:
`lineId`, `productId`, `title`, `parentTitle`, `description`, `quantity`,
`modifiers`. У модификатора разрешены только `groupId`, `groupTitle`, `optionId`,
`label`, `quantity`, `linkedProductId`. Отбрасываются passthrough-поля, цены,
quote/customer/owner/device snapshot и ненужные внутренние идентификаторы.
Возвращаются все задания доступного заказа, чтобы сборка видела состав и
состояние приготовления; действие на задачу отдельно требует прав её станции.

Все ответы проходят runtime Zod allowlist. Максимум ответа — 3 MiB, максимум
одного входящего JSON — 16 KiB. Домен ограничивает страницу примерно 2 MiB
данных, но может вернуть меньше `limit`; клиент обязан дочитать cursor до null.
После этого следующий poll начинается с начала. Нельзя считать первую
страницу всей кухней или превращать исчезновение строки в подтверждение выдачи.
Один заказ допускает до 2 000 задач. Display number — строковое PostgreSQL
bigint, не трёхзначное число; afterNumber ограничен `9223372036854775807`.

## Команды и восстановление

Каждая команда требует `expectedVersion` заказа. `orderId` берётся из пути,
`commandId` — из `Idempotency-Key`; их нельзя подменить в JSON.

| `action`                                      | Дополнительные обязательные поля                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `start_task`, `complete_task`, `confirm_stop` | `taskId`, `expectedTaskVersion`                                                                          |
| `ready`, `handoff`                            | Нет                                                                                                      |
| `confirm_cancel`                              | `reason` (1–500 символов), `inventoryDisposition` = `requires_inventory_review` или `recorded_elsewhere` |

Сначала клиент сохраняет ключ и точное намерение, затем делает HTTP. При потере
ответа повторяет тот же ключ и body. Точный replay возвращает **первоначальный**
результат, который может быть старше текущего заказа; актуальное состояние
читается отдельным GET. Receipt, созданный прежней доменной версией без
`assemblyStationId`, также читается: POST summary не требует этого нового поля.
JSON receipt не переписывается при обновлении программы.

Гонка разных действий с одной версией даёт одного победителя. `409 CONFLICT`
означает конфликт версии, изменённый body под прежним ключом или недопустимый
переход (`NOT_READY` внутри домена); требуется чтение состояния, а не автоматический
повтор с новой версией. `401` — недействующая сессия; `403` — role/station/terminal;
`400` — недопустимые поля; `404` — выключенный модуль/нет ресурса;
`413` — размер тела; `503` — недоступная привязка/сервис. Формат общий `ErrorSchema`.

HTTP **не создаёт допуск** и не инициирует cloud cancellation. Для начала
cancel/stop workflow нужна доверенная внутренняя команда домена; после неё
станция подтверждает остановку, manager — итоговое решение. Нет routes
`reserve`, `authorize`, `paid`, `provision`, outbox lease/ACK или банковских
вызовов. Существующий неоплаченный POS остаётся `fulfillment_state=blocked`,
и эти actions не превращают его в кухонный заказ. Остатки/возвраты денег не
изменяются подтверждением остановки.

## Служебное LED-чтение и оставшаяся работа

Display получает только номер/статус/cursor и требует ту же реальную
kitchen/manager session с её terminal. В ответе нет имени, телефона, суммы,
состава, customer/order ID или персонала. Это **служебный доступ со сроком
staff session**, а не постоянный unattended device credential. Постоянный канал
табло, физическая регистрация устройств и их автономное сопровождение требуют
отдельного этапа. Здесь также не реализован authenticated cloud↔edge транспорт,
worker, фоновая сверка или UI ресторанного оборудования.

## Проверки

```sh
pnpm --filter @pickchick/edge... build
node --test tests/integration/edge-fulfillment-http.test.mjs
```

12 настоящих локальных PostgreSQL+HTTP сценариев проверяют disabled flag,
реальные staff/session/terminal/station/branch/revoke, неизменяемый replay после
рестарта, параллельные действия, приготовление→сборку→выдачу, подтверждение
отмены, whitelist ответов и LED, пределы JSON/страниц и полную пагинацию,
readiness `005`/device и отсутствие допуска неоплаченному POS. Старые receipt
и rich orders по 200 задач покрыты отдельно. Fixtures создают случайные schemas
на loopback PostgreSQL; admission вызывается только из доверенного repository
в тесте. Сами HTTP-тесты не публикуют cloud ingress и не отправляют SMS, платежи
или чеки. VPS и реальные данные не используются.

Совместный локальный прогон после интеграции: **47/47 PASS** — 12 LAN HTTP,
22 доменных fulfillment и 13 прежних POS/order сценариев. TypeScript, ESLint,
Prettier и проверка соответствия сгенерированного OpenAPI прошли. Проверка
физической LAN, installation/tokens устройства и эксплуатационный пилот не
подменяются этими результатами.
