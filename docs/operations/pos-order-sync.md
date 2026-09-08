# Durable синхронизация неоплаченных POS-заказов

Статус: реализован отдельный transport для существующих локальных `order.created`
и `order.cancelled`. Он по умолчанию выключен. VPS, рабочие базы и настройки точки
этим этапом не изменяются. Это не допуск реальных продаж и не синхронизация оплаты.

## Объём и владение

`local_orders` и исходный `outbox_events` остаются на edge. Касса создаёт заказ
со статусами `awaiting_payment / not_started / not_requested / blocked`; отмена
меняет только коммерческую версию с 1 на 2. Worker передаёт исторический envelope
из PostgreSQL, а не реконструирует заказ из изменяемого текущего состояния.

Cloud сохраняет данные только в `pos_order_sync_inbox` и
`pos_order_sync_projection`. Проекция доступна для чтения операторским средствам
БД; отдельного manager HTTP/UI-списка в этом этапе нет. Cloud не становится
владельцем заказа, не создаёт `commerce_orders`, платежи, чеки, бонусы или задания
кухне. Исходное событие не содержит причины отмены; мы не подменяем его новым
форматом и не обещаем это поле в центральной проекции.

## Протокол

- `POST /internal/v1/edge/pos-orders/events`; тот же `DeviceIdentity` и заголовки
  `Authorization: Bearer …`, `X-Device-Id`, что у существующего menu transport.
- Cloud сначала проверяет действующий edge, hash токена, срок и отзыв credential,
  затем точную доверенную привязку organization / branch / device / producer.
  Даже известный replay после отзыва получает 401; выключенная привязка — 403.
- Только строгий формат unpaid POS envelope. Проверяются суммы целых минимальных
  единиц, снимок котировки, branch, order ID и соответствие типа версии. Лимит
  события 96 KiB, receipt 8 KiB, полный HTTP timeout до 5 секунд; redirects запрещены.
- HTTPS с проверкой сертификата обязателен вне явного loopback HTTP для локальных
  тестов. Endpoint отсутствует в public gateway allowlist. Существующий публичный
  HTTPS-адрес staging не является адресом этого private transport.
- Повтор event ID, producer + sequence или order + version возможен лишь с тем же
  каноническим SHA-256 всего envelope. Иной payload возвращает 409. Quote ID также
  уникален: второй order ID не может повторно использовать ту же котировку.
- Для заказа строго `create v1 → cancel v2` с ростом producer sequence, неизменные quote/snapshot/total/owner.
  Cancel до create возвращает 409 и не получает ACK. Между разными заказами
  допускаются gaps и перестановка producer sequence: общий outbox может содержать
  не относящиеся к POS события. Global contiguous sequence не предполагается.
- Worker берёт старейшее неподтверждённое POS-событие своего producer и арендует
  весь branch stream на 30 секунд. Второй worker не обходит создание заказа через
  `SKIP LOCKED`. Пауза сети не мешает edge принимать новые неоплаченные заказы.
- Pending envelope/hash и lease живут в PostgreSQL. После commit на cloud и потери
  ответа worker повторяет тот же envelope. Только точный ACK с совпавшими ID,
  sequence и hash атомарно ставит `acknowledged_at` в исходном outbox.
- Исходный POS envelope, inbox receipts и привязки защищены SQL-триггерами от
  переписывания/удаления. Изменять исходный outbox разрешено только в bookkeeping
  полях доставки. Pending нельзя заменить другим непустым envelope.
- Ошибки сохраняют очередь: exponential backoff 2–60 секунд записан в БД и
  переживает перезапуск. Некорректное событие блокирует свою очередь до операторского
  разбора; автоматического пропуска или удаления нет. SQL-повреждение/409 нельзя
  «исправлять» сбросом hash, удалением inbox или выдачей фиктивного ACK.

## Миграции и включение

Новые файлы: cloud `016_cloud_pos_order_sync.sql`, edge `008_edge_pos_order_sync.sql`.
Номера cloud 015 / edge 007 зарезервированы отдельным этапом cancellation. Перед
каким-либо развёртыванием необходимо включить его миграции в тот же согласованный
release и проверить порядок. Migrator допускает gaps при первом применении, но
запрещает позднее добавлять номер ниже уже применённого. Локальный isolated тест
этой ветки с gaps не является разрешением мигрировать рабочую БД.

Существующие archived release-профили, guards и grants VPS не расширяются этим
изменением. Перед rollout нужны отдельные проверенные least-privilege grants для
новых таблиц и authenticated read-locks, backup/restore, runtime/worker supervision,
закрытый HTTPS/VPN ingress и привязка реальной точки. Не использовать migration
owner как production runtime. Windows-служба edge/PG и её установка здесь не
реализованы; worker можно запускать на существующем доверенном локальном узле.

Доверенный оператор уже должен зарегистрировать edge и выдать ему действующий
`DeviceIdentity` существующей процедурой. Setup HTTP/self-registration отсутствует.
Для локального контура после миграций и сборки:

1. Создать приватный JSON с несекретными `organizationId`, `branchId`, `deviceId`.
2. На edge выполнить `pnpm pos:sync:setup edge /absolute/path/edge-binding.json`.
   Setup сохраняет существующий producer из `local_order_streams`; UUID не меняется
   при повторном запуске, в том числе для заказов, созданных до установки worker.
3. Проверенные те же четыре ID, включая возвращённый `producerId`, сохранить в
   отдельный cloud binding JSON. На cloud выполнить
   `pnpm pos:sync:setup cloud /absolute/path/cloud-binding.json`.
   Output содержит служебные `event`/`side`: в JSON для следующего шага нужны только
   четыре ID, нельзя передать output целиком в строгую схему.
4. В отдельной конфигурации cloud задать `CLOUD_POS_ORDER_SYNC_ENABLED=true`.
   В конфигурации edge задать `EDGE_POS_ORDER_SYNC_ENABLED=true`, точные
   `EDGE_BRANCH_ID`, `EDGE_DEVICE_ID` и `EDGE_POS_ORDER_SYNC_CLOUD_ORIGIN`.
   Flags принадлежат своим сервисам; не включать оба в одном env.
5. Существующий private identity-файл `.local/edge-identity.json` должен иметь mode 600. Токен нельзя помещать в URL, Git, UI или логи. Worker перечитывает identity
   при каждом проходе; rotation выполняется существующим trusted setup.
6. `pnpm pos:sync --once` выполняет одну доставку; `pnpm pos:sync` работает постоянно.
   SIGINT/SIGTERM прекращает следующий проход, текущий ограниченный HTTP заканчивается
   commit/retry. Повторный старт восстанавливает pending/lease/backoff из БД.

Readiness с выключенным flag не читает новых таблиц. С включённым flag cloud
требует migration 016 и доступность трёх sync-таблиц; edge требует migration 008
и точное совпадение branch/device. Redis не хранит единственную копию доставки.

Отключение: остановить worker и вернуть flags в `false`. Очередь и проекция
сохраняются; DDL rollback с удалением таблиц не предусмотрен. Возобновление с той
же привязкой продолжает pending. Для расследования достаточно ID событий, времени,
`failure_count`, `retry_after`, `last_error`, возраста и количества pending;
токен и полный пользовательский payload в диагностические логи не выводить.

## Проверки

`pnpm --filter @pickchick/api... --filter @pickchick/edge... build`, целевые
TypeScript/ESLint/Prettier, `pnpm contracts:generate` и `pnpm contracts:check`.
`pnpm test:pos-order-sync` включён в CI job transport. Для произвольного отдельного
локального QA PostgreSQL вызвать Node с приватным env, без печати его содержимого:

```sh
node --env-file=/absolute/private/qa.env --test packages/pos-order-sync/tests/*.test.mjs
```

Тесты создают временные UUID schemas в выделенных локальных `pickchick_cloud` и
`pickchick_edge`, применяют настоящие миграции и запускают реальные cloud/edge HTTP
listeners на случайных loopback портах. Покрыты отключённый WAN → два durable
события → восстановление; replay без дублей; потеря ACK после cloud commit;
конкурентные workers; истёкший lease/pending после сбоя; SIGTERM и реальный перезапуск worker с durable retry; неверный/лишний/изменённый
receipt; ранняя отмена, несовпадение snapshot, повтор quote; token/scope/revocation;
sequence gaps; SQL immutable guards; default-off и public route allowlist.
Никакие тестовые заказы на VPS не создаются.

Для допуска реальных продаж отдельно остаются подтверждённый банковский/терминальный
адаптер, законный ККМ/ОФД режим, оплата с исходящим durable событием, разрешение
кухне для edge-owned POS, возвраты/смены, наблюдаемость и приёмка на Windows железе.
Этот transport не снимает ни один из этих финансовых или аппаратных блокеров.
