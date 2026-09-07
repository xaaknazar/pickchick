# Долговечная отмена неоплаченного cloud-заказа

Это отдельный внутренний подэтап поверх fulfillment transport014/edge006.
Он добавляет cloud015/edge007 и отменяет только заказ **без единой попытки
оплаты**. Реальный банк, ККМ, customer/cashier HTTP, публичная отмена, уведомления
и возвраты не подключаются. На VPS этот этап не развёрнут.

## Кто вызывает и что проверяется

Доверенный серверный порт:

```ts
commerce.requestUnpaidCancellation(
  { organizationId, branchId, principalId, role: 'manager' },
  stableCommandKey,
  { orderId, reason },
);
commerce.readUnpaidCancellation(trustedManagerScope, orderId);
```

Scope передаёт внутренний проверенный адаптер. Эти методы сами не аутентифицируют
человека и не опубликованы в HTTP; брать role/organization из клиентского JSON
нельзя. Catalog manager credential не даёт права отменять заказы. Для будущего
публичного подключения ещё нужен отдельный проверенный order-management actor.
Причина обязательна, 1–500 символов; не включать в неё платёжные реквизиты.

В транзакции блокируется order, проверяются организация/точка, активная исторически
назначенная transport binding, отсутствие kitchen effect и attention. Затем
проверяется PostgreSQL: нет payment attempts любого состояния, captures и refunds.
Даже `failed`, `unknown` или ещё не отправленная `pending` попытка запрещает
создание intent. Клиент не передаёт флаг «не оплачен». История не удаляется.

Один intent на order. Общий immutable command receipt проверяется до повторной
оценки состояния: одинаковый key/body возвращает первоначальный ответ, даже если
отмена уже завершилась. Изменённое тело под тем же key и второй key для того же
order дают conflict. `readUnpaidCancellation` отдельно читает текущую проекцию:

```json
{
  "cancellationId": "UUID",
  "orderId": "UUID",
  "state": "waiting_admission | release_pending | cancelled | needs_review",
  "releaseEventId": null,
  "expectedEdgeVersion": null,
  "resultEventId": null,
  "resolutionCode": null
}
```

После создания intent новая payment attempt запрещена и доменным кодом, и
PostgreSQL trigger. Гонка создания attempt и intent сериализуется order lock:
побеждает одна операция. Ранее созданная attempt делает отмену недопустимой;
точный повтор исходной attempt по-прежнему возвращает сохранённый результат.
Intent также блокирует новое формирование и выдачу kitchen authorization.

## Протокол и подтверждение

1. Без подтверждённого admission intent остаётся `waiting_admission`. Он не
   истекает по таймеру. Доставка исходного immutable admission продолжается.
2. Authenticated `edge.admission_reserved` в той же cloud-транзакции закрепляет
   reservation и проекцию. Для `held` создаётся один
   `edge.admission_release_requested`; intent становится `release_pending`.
   Если резерв уже существует, эти проверки выполняются при создании intent.
3. Команда содержит original event ID, order/branch/reservation, quote digest,
   owner=`cloud`, reason и **закреплённый expectedVersion**. Неподтверждённая,
   несовместимая или не held проекция переводит intent в `needs_review`.
4. `EdgeFulfillment.acceptRelease` проверяет device/producer/branch и pinned
   reservation/quote. При совпадении версии и `held` атомарно сохраняет released
   state, прежнее state event, inbox и отдельный immutable applied result.
5. Конфликт версии либо состояние не held сохраняет rejected result с
   `VERSION_CONFLICT` / `NOT_HELD`; order version не повышается. Повтор возвращает
   это же решение. Неизвестный COMMIT или SQL-сбой не превращается в отказ:
   после восстановления повтор находит настоящий commit либо выполняет команду.
6. Новый reverse event `edge.admission_release_result` содержит исходные
   requestEventId/requestDigest, outcome/rejectionCode и pinned edge view.
   Cloud вновь аутентифицирует действующее устройство, сверяет binding,
   оригинальную outbox-команду, digest/owner/quote/reservation/reason/version
   и неизменяемые routing/assembly поля исходного admission.
   Только applied result при сохранённом отсутствии payment history делает
   intent `cancelled`; rejected даёт `needs_review`.

ACK подтверждает доставку команды и **не** завершает отмену. Обычное state event
`edge.admission_released` обновляет проекцию исполнения, но само не завершает
этот intent. Отдельный decision не записывается второй строкой той же версии в
`cloud_fulfillment_versions` и не означает готовность кухни. Решения и state
events могут прийти в разном порядке. Общая inbox дедупликация event/sequence
сохраняется. Одинаковый event ID с другим телом конфликтует.

Старый immutable result повторяется после lost response/restart. Release остаётся
доступным повторной доставке даже если released state/result уже принят облаком,
а command ACK потерян; исходные event/hash не меняются. Paused binding не передаёт
владение generic worker. Он не claim/ACK ни один из трёх transport-owned типов.
Существующие parking/fairness и раздельный прогресс направлений сохранены.

## Схема, разрешения, порядок обновления

Новые миграции, существующие 001–014 / 001–006 не редактируются:

- `015_cloud_unpaid_cancellation.sql`: `commerce_cancellation_intents`, immutable
  `commerce_cancellation_results`, ограничения переходов и payment insert fence.
- `007_edge_release_results.sql`: immutable `fulfillment_release_results`.
  Старый UNIQUE(order_id,aggregate_version) outbox заменяется в одной транзакции
  partial UNIQUE с **единственным** исключением `edge.admission_release_result`.
  Уникальность старых state events сохраняется.

В `pull` добавлено optional `protocolVersion:2`. Если поле отсутствует, сервер
выдаёт только два старых типа. Новый worker всегда посылает `protocolVersion: 2` и не делает downgrade.
Облачный014 strict parser это поле отвергает. Поэтому последовательность выпуска:

1. Отдельно проверить и применить cloud015, обновить grants и cloud API.
2. Убедиться в readiness cloud014+015 и совместимости old-worker/new-server.
3. Применить edge007 и обновить worker; его readiness требует006+007, а сам worker
   проверяет007 до чтения очереди или HTTP.
4. Лишь после проверенного обновления обеих сторон подключать доверенный producer
   intent. По умолчанию transport flags остаются false.

`fulfillmentTransportGrants` при enabled даёт транспортному runtime чтение двух
новых таблиц, ограниченный UPDATE lifecycle-полей intent и INSERT результата.
**INSERT intent и изменение reason/actor ему не выдаются**. При false удаляются
новые права целиком; baseline device auth не меняется. Новых npm зависимостей нет.

Откат к API014/старому worker после создания отмен не является прозрачным:
старый код не понимает result/v2 и не завершит intent. Сначала остановить transport
worker, сохранить все pending/inbox/outbox/results и явно оценить outstanding
intents. Не применять старый provision/migrate поверх новой схемы, не удалять015/007
и не восстанавливать дамп автоматически. Безопасное восстановление — исправить
совместимый код и повторить неизменяемые команды. Данный этап не содержит deploy
или автоматизированного rollback на restaurant/VPS.

## Проверки и пределы

Тесты используют временные schema двух локальных PostgreSQL, реальный loopback
HTTP API/worker и локальную LAN-проекцию; факты банка/фискализации только trusted
synthetic fixtures. Проверяются zero-attempt intent, ожидание admission,
cancel/start race, paid/unknown/failed отказ, exact retry, changed body, auth scope,
revocation, ограниченный runtime, state/result reorder, потерянный HTTP/COMMIT,
атомарность SQL rollback, миграции дважды, старая state uniqueness и protocol gates.
Прежние commerce/edge/transport тесты также сохраняются.
Локальный прогон 8 сентября 2026: **108/108 PASS** (commerce — 28, edge — 25,
transport — 55), TypeScript build, ESLint, Prettier и генерация контрактов — PASS.
Это доказательства локального подэтапа; CI и отдельный выпуск ещё не выполнены.

Запуск из установленного workspace с локальными БД:

```sh
node --env-file=.env --test packages/fulfillment-transport/tests/*.test.mjs packages/commerce-core/tests/*.test.mjs packages/edge-fulfillment/tests/*.test.mjs
```

`needs_review` пока читается только внутренним портом; операторского UI для него
нет. Полная отмена до физического создания резерва с edge tombstone, оплаченная
отмена, остановка приготовления, inventory disposition, bank resolution и возврат
требуют следующих отдельных этапов. Уже существующие payment.submit/leased kitchen
commands не становятся безопасными для paid cancel этим изменением. Они исключены
проверкой нулевой истории из нового producer. Доставка отмены по WAN и работа на
реальном оборудовании пока не приняты.
