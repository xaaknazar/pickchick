# Доставка исполнения cloud ↔ edge

Этот этап добавляет работающий HTTP worker между коммерческим облаком и локальной
кухней. Он использует PostgreSQL обеих сторон и существующую `DeviceIdentity`.
По умолчанию транспорт выключен. VPS, ресторанное оборудование, банковские
адаптеры и публичный checkout этим этапом не включаются.

## Граница ответственности

Cloud владеет заказом и денежными эффектами. Edge резервирует исполнение, после
доверенного разрешения создаёт задачи, назначает номер и ведёт кухню/выдачу.
Cloud хранит отдельную проекцию исполнения и историю полученных версий. Событие
выдачи не меняет сумму заказа, capture/refund ledger, чек или бонусы.

Первый поток забирает из `commerce_outbox` только:

- `edge.admission_requested` — неизменяемый заказ/quote/snapshot для резерва;
- `edge.kitchen_admission_requested` — разрешение после существующих денежных и
  фискальных проверок коммерческого ядра.

Обычный commerce worker сохраняет прежнее поведение для точек, которым никогда не назначалась
transport binding. Для назначенной точки два типа принадлежат этому транспорту;
он не забирает и не подтверждает банковские, фискальные или refund эффекты.
`active=false` ставит назначенный транспорт на паузу и не возвращает владение
общему worker; старый generic lease также не даёт права ACK после назначения.
Неоплаченный локальный POS не получает допуска кухни.

Обратный поток принимает `edge.admission_reserved`, `edge.fulfillment_accepted`,
`edge.task_changed`, `edge.fulfillment_ready`, `edge.fulfillment_handed_over`,
`edge.cancellation_requested`, `edge.fulfillment_cancelled`, `edge.admission_released`.
Последние три могут поступить из доверенного внутреннего edge domain port;
новый HTTP transport не выдаёт публичного права инициировать release/cancel.

## Настройка и авторизация

Добавлены аддитивные миграции `014_cloud_fulfillment_transport.sql` и
`006_edge_fulfillment_transport.sql`. Старые 001–013 не меняются. До запуска
нужны обе схемы, существующие cloud organizations/branch/device и локальная
`fulfillment_config` с маршрутизацией. Cloud binding и local config должны иметь
одинаковые organization, branch, device и постоянный cloud producer UUID.
Замена устройства/producer не выполняется автоматически: восстановление и
передача владения требуют отдельной процедуры.

Cloud API включается `CLOUD_FULFILLMENT_TRANSPORT_ENABLED=true` в собственном env.
Edge worker использует свой env с `EDGE_FULFILLMENT_ENABLED=true`,
`EDGE_FULFILLMENT_TRANSPORT_ENABLED=true`, `EDGE_DEVICE_ID`, `EDGE_BRANCH_ID`.
Флаги другого сервиса в его env не включают. Readiness проверяет новую миграцию
и обслуживаемые таблицы; локальный узел также проверяет device/routing binding.

Закрытая команда `scripts/fulfillment-transport-setup.mjs DEVICE_UUID PRODUCER_UUID`
создаёт cloud binding только от существующего активного edge. Organization/branch
она получает из PostgreSQL, не из тела HTTP. Команда не выдаёт и не печатает ключ.
Маршрутизация станций по-прежнему задаётся доверенным `provisionFulfillment`.

Worker читает существующий `.local/edge-identity.json` с правами 0600 через
`scripts/private-identity.mjs`. Применяются фактические срок действия, статус
устройства и hash credentials; отзыв/ротация сериализуются shared lock с приёмом
события. Срок текущей DeviceIdentity — 30 дней; постоянный device credential
этот этап не вводит. Конфигурация/логи не содержат raw токенов, полных событий,
снимков, исходных сетевых исключений или клиентских данных.

`EDGE_FULFILLMENT_CLOUD_ORIGIN` — утверждённый HTTPS origin без credentials,
пути, query и fragment. HTTP разрешён только literal loopback для локальных
проверок/туннеля. Публичный Caddy не меняется и `/internal/` не открывается.
Частная сеть/TLS tunnel между реальными cloud/edge ещё не развёрнуты; запуск
worker на ресторанном оборудовании и его supervisor — отдельное внедрение.

Локально worker запускается через Node с проектным env:

```sh
node --env-file=.env scripts/fulfillment-worker.mjs --once
node --env-file=.env scripts/fulfillment-worker.mjs
```

Флаг false завершает worker со статусом `disabled`, не читая identity и не
открывая PostgreSQL/HTTP. Один turn обрабатывает максимум одно обратное событие
и одну cloud-команду. Успешная очередь опустошается без секундного sleep между
сообщениями; ожидание и ограниченный backoff с jitter есть только при idle,
занятом worker или ошибке. SIGTERM/SIGINT останавливают после текущего turn.
Неподтверждённые записи сохраняются.

## HTTP-контракт

Все три маршрута — `POST /internal/v1/edge/fulfillment/...`, `Cache-Control:
no-store`. Заголовки: `Authorization: Bearer <device token>` и `X-Device-Id`.
Сервер выводит organization/branch/device из настоящей авторизации и binding.
Переданный клиентом principal или другой scope не принимается.

| Маршрут  | Тело                                                                       | Ответ                                                                   |
| -------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `pull`   | `{workerId, leaseSeconds}`; lease 15–120 секунд                            | `{scope, event: null \| {command: {eventId,type,payload}, leaseToken}}` |
| `ack`    | `{eventId, workerId, leaseToken}`                                          | `{eventId, acknowledged:true}`                                          |
| `events` | `{schemaVersion:1,eventId,sequence,orderId,aggregateVersion,type,payload}` | `{eventId, acknowledged:true}`                                          |

`sequence` — положительная десятичная строка PostgreSQL bigint. `payload`
обратного события — разрешённые поля edge view: identity заказа/резерва,
quote hash, version/state, номер, routing version, timestamps и необходимые
поля task/cancel. Клиентские деньги не принимаются. Точные runtime Zod-схемы —
`packages/fulfillment-transport/src/model.ts`; те же схемы генерируют OpenAPI.

HTTP request ограничен 64 KiB, response — 1 300 000 байт. Полный quote идёт
только cloud→edge в одном ответе. Worker ограничивает JSON до разбора, запрещает
redirects и применяет общий дедлайн 5 секунд к fetch и чтению тела. Зависший
cancel потока не может продлить этот дедлайн. История outbox целиком в память
не загружается.

Ошибки: 400 malformed, 401 credential expired/revoked/invalid, 403 wrong binding,
404 disabled/missing, 409 lease/event/version conflict, 413 body limit,
503 dependency unavailable. Неизвестный исход сети означает неопределённость
доставки, а не разрешение создать другой коммерческий эффект.

## Commit, повтор и проекция

1. Worker захватывает локальный lease на 60 секунд без открытой SQL-транзакции
   во время HTTP. Второй процесс получает `busy`. Изолированные направления могут продолжать
   работу, даже если отдельное сообщение другого направления отклонено.
2. Cloud выдаёт один eligible immutable outbox event с lease. Worker сверяет
   scope с локальной конфигурацией и сохраняет pending delivery в PostgreSQL
   до применения команды.
3. `acceptCloud` атомарно фиксирует edge inbox, reservation либо задачи и
   обратный outbox. Только после commit отправляется cloud ACK.
4. Потерянный ACK сохраняет исходный event/worker/lease. Истёкший lease с
   подтверждённым 409 требует повторного claim исходной неизменяемой записи;
   существующий edge inbox предотвращает второй эффект.
5. Обратный outbox арендуется по одной записи. Cloud в одной транзакции
   аутентифицирует устройство, подтверждает admission через commerce domain,
   сохраняет immutable inbox и versioned projection. Только после cloud receipt
   edge помечает запись подтверждённой. Потерянный receipt безопасно повторяется
   с тем же event ID/sequence/body после окончания lease.

Одинаковый event ID с изменённым телом, занятый source sequence или несовместимый
снимок одной aggregate/task version дают conflict. Более старая версия остаётся
в истории, но не понижает текущую проекцию. Таблица observed tasks содержит только
наблюдённые `task_changed`: это **не полная текущая копия кухни**, поскольку
старые accepted/bulk-cancel события не несут всех задач. KDS/LED читают настоящий
локальный домен, а не выводят готовность из этой неполной task-проекции.

Резерв не освобождается по таймеру. При выключенном приёме или неопределённом
исходе pending событие и безопасный код ошибки остаются в
`fulfillment_transport_state`. Только подтверждённый rollback с
`ROUTING_MISSING` атомарно переносит exact command/scope/hash в
`fulfillment_transport_failures` и освобождает локальный pending. Cloud ACK
не отправляется: исходный outbox остаётся, повтор приходит после окончания lease.
Другие корректные SKU продолжают работу. Приоритет минимального числа попыток,
затем sequence не даёт просроченному проблемному A обгонять новый корректный B.
После утверждённого исправления маршрута исходное событие принимается, а failure
помечается resolved без переписывания истории. Изменённый command под тем же ID
не заменяет сохранённую ошибку. UNKNOWN сети/COMMIT таким способом не паркуется.

Обратное направление использует отдельный `fulfillment_transport_reverse_failures`:
ссылку на неизменяемый edge outbox, hash exact envelope, число попыток, безопасный
код, retry-after 2–300 секунд и resolved marker. Ни неизвестный ответ, ни 404 не
означают ACK. Retry-after переживает restart и окончание lease. Ошибочное reverse
сообщение не прерывает forward turn; другие обратные события выбираются отдельно
по attempts/sequence. Поэтому исторический заказ, которого нет в cloud, не
останавливает текущую точку. `unresolvedFailures` и `unresolvedReverseFailures`
остаются в диагностике успешных turn, а не исчезают после следующего success.
Срок повтора при непрерывном поступлении новых заказов этим порядком не гарантирован:
предельная задержка и fair scheduling под нагрузкой требуют отдельного испытания.

Исправление настройки позволяет повторить исходное событие; никакой автоматической
оплаты, возврата или создания нового заказа нет.
Для активной transport binding новая payment attempt требует подтверждённый
`held`; пауза binding и известные released/cancel состояния её блокируют. Точный idempotent
replay уже созданной попытки сохраняет исходный результат.

Это не протокол остановки уже выданного разрешения. Ранее созданный pending
`payment.submit_requested` пока не получает cancellation dispatch fence; уже
арендованное/сохранённое на edge разрешение не отменяется последующим ручным
refund. Поэтому этот этап не открывает публичную отмену оплаченного заказа,
release producer или реальный checkout. Следующему этапу нужны durable cancellation
intent, подтверждённый edge stop/command result и отдельное разрешение денежных
последствий; transport ACK сам по себе не является подтверждением остановки.

## Права и внедрение

`infra/staging/fulfillment-transport-grants.mjs` выдаёт разрешения только при
включённом cloud-флаге. Он не разрешает вставку capture/refund effects, создание
provider accounts, устройств или bindings. Необходимые column UPDATE для
`FOR SHARE` включены отдельно. Внутренней commerce runtime роли также нужны
SELECT на binding/projection и UPDATE(lock_anchor) на binding для нового gate;
это не включает публичную выдачу таких прав при выключенном transport-флаге. Disabled-путь не расширяет права runtime.
Provision включает helper в существующую транзакцию GRANT/REVOKE. Изменение
файлов не означает, что новый provision выполнен на VPS.

Откат API/worker оставляет аддитивную схему, финансовые данные и pending события.
Выключенная binding сохраняет владение сообщениями. Перед их передачей другому worker нужна
сверки текущих leases и edge inbox. Неподтверждённые данные не удаляются, дамп
не восстанавливается поверх текущих продаж автоматически.

## Проверки

Проверки выполняются на двух временных локальных PostgreSQL schema и loopback
HTTP. Fixture payment/fiscal observations передаются в доверенные доменные
порты; провайдеры не вызываются и такие наблюдения не являются банковской
интеграцией. Набор покрывает полный staff LAN цикл, потерю pull/ACK/receipt,
перезапуск, expiry leases, storage failure, конкурирующие workers, отрицательные
денежные гейты, авторизацию, ограничение тела, disabled route, два направления с несколькими проблемными
событиями, expired lease fairness, exact payload conflict и исправление маршрута.
Отдельные PG-проверки проверяют неизменяемые версии, reorder, atomic admission,
отзыв и ограниченную runtime роль. Unit-проверки используют только injected
fetch и не выполняют внешней сети.

Это подтверждение корректности разработанного транспорта на локальном стенде.
В общей рабочей копии прошли `pnpm check`, 40 проверок транспорта, 28 commerce,
22 edge fulfillment, 140 общих PostgreSQL/HTTP и 33 проверки кухни/табло.
[GitHub CI](https://github.com/xaaknazar/pickchick/actions/runs/34157166068) —
все шесть jobs success для source `3b3793dcd155586becc3a727daa260f254608574`.
Следующий VPS-выпуск `93b14e7` также прошёл все шесть jobs и
[фактически установил cloud schema 014](deployments/2026-09-08-transport-foundations.md)
с выключенным транспортом. Edge/worker на ресторанное оборудование ещё не
устанавливались. [Локальный сетевой baseline](transport-capacity-baseline.md)
проверил 1 000 активных заказов через HTTP по десяти изолированным точкам.
Приёмка 1 000 одновременно исполняемых заказов на нескольких физических точках,
реальных сетевых условий, наблюдаемости и восстановления диска остаётся отдельной
нагрузочной и эксплуатационной проверкой.
