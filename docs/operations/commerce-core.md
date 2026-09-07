# Коммерческое ядро PostgreSQL

`@pickchick/commerce-core`, migrations `008_cloud_commerce_core.sql` и
`012_cloud_commerce_catalog.sql` — внутренний
репозиторий коммерческих состояний для **cloud-owned mobile** заказов. Это
следующий проверяемый этап после TEST-контура; публичный checkout, настоящие
списания и чеки не включены. Ни одна возможность Kaspi/ККМ не предполагается
по имени провайдера. Пакет не вызывает HTTP и не содержит ключей.

## Что реализовано

- Неизменяемые priced quote и order snapshots: продавец/точка, версия меню,
  валюта, строки, количество, цены, скидки, tax code, названия и описание состава.
  Деньги — PostgreSQL `bigint`, вычисления — `BigInt`, JSON — десятичные строки.
- Сериализованные команды с областью organization/branch/principal/operation/key
  и SHA-256 канонического тела. Повтор возвращает сохранённый результат;
  изменённое тело конфликтует. Один quote потребляется одним заказом.
- Один intent на заказ, отдельные попытки, долговечные неизвестные результаты.
  Истёкший quote нельзя впервые оформить; уже выполненная команда повторяется
  после истечения quote без нового заказа.
- Проверенные внешним адаптером bank/fiscal observations и immutable inbox.
  Повторы события и повторы операции — два отдельных механизма дедупликации.
  Success/issued не откатываются поздними pending/failed.
- Каждое фактическое списание записывается отдельно. Два operation ID означают
  две операции, даже если попытка/сумма совпадают. Лишнее списание, конфликт
  привязки, второе фактическое возвратное действие или второй чек сохраняются
  и создают `commerce_reconciliation_issues` и durable review event.
- Полный/частичный **денежный** возврат конкретного capture: фактически
  возвращённое + pending/unknown резерв не позволяет запросить больше capture.
  Блокируется только строка соответствующего заказа, не сеть целиком.
  Дополнительный trigger проверяет лимит и при прямом SQL INSERT.
- Возврат банка и возвратный чек имеют независимые состояния. Refund intent
  создаётся с причиной и инициатором; реальное подтверждение сохраняется в
  отдельном ledger. Unknown держит резерв, подтверждённый failed освобождает.
  Поздний реальный success после failed всё равно отражается; если замена уже
  зарезервировала деньги, новая неопределённость видна и дальнейшая отправка
  требует разбора.
- Чек sale/refund закреплён за одним настроенным executor account. Его
  request/сумма/родитель неизменяемы. Результат хранит внешний ID, fiscal mark,
  HTTPS receipt URL, occurred/received timestamps. Повторная печать не создаёт
  нового документа. Refund document ожидает issued исходного sale.
- Transactional outbox: резерв точки, запросы адаптерам, повторная проверка
  unknown, review и одна команда допуска кухни. Leasing использует
  `FOR UPDATE SKIP LOCKED`, ACK требует текущего worker/token. Нет TTL удаления
  финансовой истории, inbox или неподтверждённых эффектов.

## Порядок и границы доверия

`CommerceScope = { organizationId, branchId, principalId, role }` создаётся
**после** серверной аутентификации/авторизации. `role` — `sales` или `manager`;
его нельзя брать из тела пользовательского запроса. Обычный principal читает
и оплачивает только свой заказ; manager работает в своей точке. Возвраты и
worker-операции требуют manager scope. Branch/account/юридическое лицо также
проверяются в SQL; один `branchId` из клиента не является доступом.

`TrustedProvider = { organizationId, branchId, accountId }` — внутренний порт
аутентифицированного адаптера. Адаптер проверяет подпись/доверенный status API,
merchant/account, currency, смысл operation ID, статус и сумму по фактическому
контракту **до** вызова `observe*`. У customer нет операции `approve`.
Отключённый account запрещает новые исходящие операции, но принимает проверенные
наблюдения по уже начатым операциям. Идентичность account/ККМ неизменяема;
замена создаёт новый ID и не переписывает старые расчёты.

`TrustedEdge = { organizationId, branchId, deviceId }` — порт устройства,
которое проверено транспортом и в таблице devices: active edge той же точки.
`confirmAdmission` принимает reservation ID и точный quote digest. Подтверждение
означает **долговечный резерв, удерживаемый до явного решения**, а не heartbeat
или короткий lease, который edge свободно удалит во время банковской операции.
Этот реальный edge-протокол ещё предстоит подключить и проверить без WAN.

Порядок: quote → order+intent+admission outbox одним commit → durable admission
→ payment attempt+outbox → проверенный capture → fiscal request → issued sale
→ единственная `edge.kitchen_admission_requested` запись. При недоплате,
неизвестном/излишнем списании, pending refund или фискальной неопределённости
допуска на кухню нет. Partial capture сохраняется и требует проверки оставшейся
суммы; повторный полный платёж не запускается.

`paid_pending_acceptance` **не означает «готовится»**. Здесь реализован
однократный эффект в PostgreSQL, не сетевое exactly-once и не реальное выполнение
KDS. Edge-получатель должен атомарно сохранить envelope ID в inbox, проверить
reservation/quote/owner, выполнить своё действие и подтвердить commit. Его
fulfillment aggregate не становится владельцем коммерческих полей центра.
POS/kiosk остаются edge-owned по исходному ТЗ и не принимаются этим quote API.

Если kitchen effect уже создан, обычный refund с политикой `not_dispatched`
отклоняется. Manager должен явно передать `fulfillmentPolicy: 'manager_reviewed'`
и причину: это зафиксированное решение после проверки кухонного состояния,
включая возможный потерянный ACK. Оно **не** подделывает подтверждение отмены
на edge, не останавливает уже готовящуюся еду и не возвращает её на склад.

## Внутренний API

| Метод                                                                                  | Назначение                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `issueQuote(scope,key,serverPricedQuote)`                                              | Пересчитать арифметику и сохранить доверенный priced snapshot                        |
| `createOrder(scope,key,{quoteId,fiscalAccountId})`                                     | Зафиксировать order/intent и запросить admission                                     |
| `confirmAdmission(edge,{eventId,orderId,reservationId,quoteDigest})`                   | Принять проверенный durable reserve                                                  |
| `startPaymentAttempt(scope,key,{orderId,providerAccountId})`                           | Одна pending попытка; unknown/partial capture запрещают новую                        |
| `observePayment(provider,event)`                                                       | pending/unknown/failed либо captured с operation ID/суммой                           |
| `requestRefund(manager,key,{orderId,captureId,amountMinor,reason,fulfillmentPolicy?})` | Удержать refundable amount и создать immutable запрос                                |
| `observeRefund(provider,event)`                                                        | pending/unknown/failed/succeeded; фактические effects отдельно                       |
| `observeFiscal(provider,event)`                                                        | pending/unknown/failed/issued; проверенное issued содержит внешний ID/mark/URL/сумму |
| `readOrder(scope,id)`                                                                  | Согласованный снимок внутренних коммерческих данных одного заказа                    |
| `claimOutbox(manager,{workerId,limit,leaseSeconds})`                                   | Ограниченная пачка, аренда и уникальный token                                        |
| `acknowledgeOutbox(manager,{eventId,workerId,leaseToken})`                             | Durable ACK без потери эффекта при повторе                                           |

Типы/валидация находятся в `packages/commerce-core/src/model.ts`. Все суммы
передаются строками, например `'419000'` = 4190 ₸. `customerId` — nullable UUID,
пока без зависимости от auth migration 007; проверку customer/network binding
должен выполнить интеграционный слой. `readOrder` — внутреннее представление,
не готовый безопасный payload для табло или публичного endpoint.

`issueQuote` не принимает недоверенную клиентскую цену. Пакет проверяет
арифметику legacy foundation release либо полностью сверяет результат
`@pickchick/catalog-pricing` с опубликованным меню PostgreSQL. Новый порт
сохраняет выбранные модификаторы и снимок состава. Часы, оперативные складские
стоп-листы, промо, Чики, утверждение налогов и маршруты требуют последующих
интеграций. Будущий customer route принимает только SKU/количество/выбор опций,
вызывает серверный pricing и получает налоговые настройки из доверенного
хранилища перед вызовом этого внутреннего порта. Бесплатные/смешанные расчёты,
Яндекс external settlement и наличные не реализованы текущей версией.

Фискальный `request` — внутренний snapshot и intent, не формат Webkassa/Kaspi.
Перед настоящим вызовом нужен подтверждённый fiscal adapter и политика
распределения **частичного товарного** возврата по исходным строкам, налогам,
скидкам и Чикам. Текущий финансовый refund по capture не принимает решение о
возвращаемом товаре/количестве и не создаёт его автоматически. Нельзя просто
отправить весь sale snapshot как строки частичного возврата.

## Связь с опубликованным каталогом

Есть два взаимоисключающих входа `issueQuote`:

- Legacy `releaseId` + прежние priced lines: совместим с foundation fixtures и
  прежним внутренним контрактом. Это доверенный технический порт, не fallback
  публичного customer API и не обход проверок опубликованного каталога.
- `catalogReference { organizationId, branchId, version, payloadHash, publishedAt }`
  - полный результат `@pickchick/catalog-pricing`, обязательный `taxBinding`
    и `taxCode` каждой строки. Нельзя одновременно передать `releaseId`.

`taxBinding = { legalEntityId, approvalReference, version }` приходит из явно
утверждённой административной конфигурации. Привязка к юридическому лицу точки
проверяется в PostgreSQL. Пакет не назначает налоговые коды, не утверждает их
законность и не принимает их от покупателя. Отсутствие binding/кода даёт `INVALID`,
чужое юридическое лицо — `FORBIDDEN`. До настройки и утверждения налогов real
checkout остаётся закрытым. Значения `SYNTHETIC-TAX` и approval в тестах — только
локальные фикстуры, не настоящие настройки ресторана.

При первом выпуске quote проверяются ordering_enabled точки, область reference,
текущая опубликованная версия, hash и дата публикации. Head блокируется `FOR SHARE`;
публикация использует `FOR UPDATE` той же строки. Поэтому запрос, ожидавший
завершения новой публикации, не выдаст quote по старой версии. PostgreSQL FK
связывает reference со snapshot публикации; trigger проверяет дату и текущий head.
Даты JSON имеют миллисекунды, PostgreSQL сохраняет микросекунды: сравнивается
именно `date_trunc('milliseconds', published_at)`, без ложных конфликтов.

Затем из SKU/количества и выбранных опций восстанавливается cart и повторно
вызывается тот же чистый pricing kernel по **payload из PostgreSQL**. Сравнивается
весь результат: line ID, названия, база, option delta, gross/discount/total,
компоненты, ingredients, declarations аллергенов/КБЖУ, статус достоверности и
итоговые значения. Арифметически согласованная подмена цены или состава также
отклоняется. Tax binding не является частью меню и проверяется отдельно.

Политика фиксации цены: published quote действует ровно 300 секунд с момента
выдачи. Смена публикации не изменяет уже выданный quote; его можно потребить до
expiry с исходной ценой и составом. После смены версии **новый** quote по старому
reference даёт `CONFLICT`. Повтор выполненной команды возвращает тот же результат,
в том числе после смены публикации/истечения времени; это не продлевает срок
первого создания заказа. Заказ всё равно проходит durable admission и финансовые
проверки. Аварийное прекращение приёма уже выданных quote требует отдельной
политики admission/operational stop; изменение меню само по себе таким отзывом
не является.

В quote, order и исходном snapshot sale/refund сохраняются `selectedDetails`,
`taxBinding` и коды строк. Новая публикация не переписывает эти сведения.
`selectedDetails` содержит названия RU/KK, serving/ingredients/вес/объём, image key,
kind, источник, декларации аллергенов и КБЖУ с признаком проверки, выбранные
модификаторы и агрегированные компоненты. Сохранение непроверенной декларации
не делает её проверенной. Refund request содержит **исходный** снимок заказа;
распределение частичного товарного возврата по строкам остаётся отдельной задачей.

## Worker и неопределённость

Пакет не выполняет внешний вызов внутри транзакции. Worker хранит stable
external reference из intent до обращения к банку. Lease/ACK — транспортные
состояния, а не доказательство списания/чека. Если ответ потерян, адаптер
сохраняет unknown и проверяет исходную операцию по контракту; не создаёт новую
попытку. Unknown emits `*.reconcile_requested`. Повторный банковский/фискальный
вызов допустим только при подтверждённой provider idempotency; автоматически
повторять исходящий POST после истечения lease запрещено.

При claim не выдаются завершённые/unknown submit intents, отключённые accounts,
а также новые финансовые/kitchen submit effects заказа с unresolved attention.
Это не отзывает уже полученную внешним участником команду. Разбор reconciliation,
регламент разрешения спорных состояний и возобновления обслуживания должны
предшествовать production-подключению. Автоматического «снять флажок ошибки» нет.

## Проверки и запуск

Проверка после catalog bridge: **28/28 PASS** (6 unit + 22 PostgreSQL),
TypeScript build/typecheck, ESLint, formatter и staged diff прошли. Общие HTTP/CI
проверки объединённой ветки выполняются отдельно.

```sh
pnpm --filter @pickchick/catalog-pricing... build
pnpm --filter @pickchick/commerce-core build
pnpm --filter @pickchick/commerce-core test
pnpm --filter @pickchick/commerce-core test:integration
```

PG suite использует новый `commerce_<uuid>` schema в локальной dev-БД,
применяет настоящие миграции, создаёт только synthetic fixtures и удаляет свой
schema в `finally`. URL из приватного `.env` не читается. По умолчанию используется
локальный cloud PostgreSQL из `.env.example`; override —
`COMMERCE_TEST_DATABASE_URL`, только localhost. Одна проверка создаёт временную
NOLOGIN роль, выдаёт scoped DML и удаляет её; нужен локальный migration admin.
VPS, SMS, банк, ККМ, Apple и реальные клиенты этими тестами не затрагиваются.

Покрытие: параллельные команды/callback/refunds, повтор с другим телом, expiry,
чужой principal/branch/account, unknown/stale statuses, двойной реальный capture,
partial capture, полный/частичный денежный refund, поздний refund success,
повторный фактический чек, immutable guards, полный rollback позднего сбоя,
параллельные outbox leases/stale ACK и ограниченная runtime роль. Для catalog
bridge дополнительно проверены concurrent issuance/publication lock, старый
reference и pinned TTL, подмена цены/описания/КБЖУ, nullable foundation reference,
точный перенос состава в sale/refund, налоговый binding, timestamp guard и
откат quote вместе с command receipt.

## Миграция, права и откат

008 добавляет отдельные `commerce_*` таблицы/триггеры/индексы и не меняет данные
TEST-клиентов. 012 расширяет quote reference, добавляет FK/guards и безопасный
lock_anchor на catalog head, сохраняя старые foundation quotes. Применять полный
последовательный набор миграций, включая 009, 010, 011 перед 012; checksum runner
запрещает позднее добавление более старых версий.
На existing deploy сначала fresh backup+restore drill, затем миграции отдельной
ролью. Публичные capability flags и banking workers остаются выключенными до
приёмки интеграционного слоя. Этот этап не развёртывал новые миграции на VPS.

Runtime не получает DDL, DELETE, UPDATE ledger/snapshot, изменение provider
identity или управление account enabled. Ему нужны SELECT справочников
branches/devices/menu/accounts; SELECT/INSERT коммерческих таблиц кроме
`commerce_provider_accounts`; UPDATE только
orders/intents/attempts/refunds/fiscal_documents/outbox; USAGE sequence outbox.
Для published reference дополнительно нужны SELECT catalog_publications и
catalog_branch_heads, UPDATE(lock_anchor) **только этого столбца** на head.
UPDATE публикации, published_version и draft_revision commerce runtime не нужны.
Точный воспроизводимый grant-набор проверяется в PG suite. Grants выдаёт
deployment layer явным списком после миграции; migration не меняет общие роли.

Rollback приложения сохраняет migrations 008/012 и всю финансовую историю.
Legacy issueQuote продолжает работать с nullable release_id схемой. Уже созданные
published quotes нельзя преобразовывать в выдуманные foundation release UUID;
старый runtime не должен впервые оформлять новые published quotes без этой
проверки каталога. Закрыть новый checkout до проверки совместимости при откате. Не
удалять capture/refund/issued/inbox/outbox и не откатывать деньги восстановлением
старой БД. При восстановлении после настоящих операций сначала сверить журнал
провайдера и pending work, затем возобновлять dispatch. Старое приложение
игнорирует новые таблицы; совместимость PostgreSQL/HTTP существующего контура
проверяется общей suite после объединения веток.

Реальные auth/HTTP routes, provider adapters/certification, worker delivery,
server pricing, edge receiver/KDS, товарные возвраты, бонусы/склад, касса,
регистрация ККМ и эксплуатационная приёмка остаются отдельной разработкой.
Завершение этого пакета не закрывает финансовый Gate C или готовность ресторана.
