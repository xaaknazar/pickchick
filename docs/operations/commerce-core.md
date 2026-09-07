# Коммерческое ядро PostgreSQL

`@pickchick/commerce-core`, migration `008_cloud_commerce_core.sql` — внутренний
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
арифметику и принадлежность immutable menu release точке, **но не заменяет**
будущий pricing service: активное меню/часы/стоп-листы, модификаторы, промо,
Чики, налоги и маршруты готовит доверенный server pricing layer. Customer route
сначала вызывает его и только затем этот порт. Бесплатные/смешанные расчёты,
Яндекс external settlement и наличные не реализованы текущей версией.

Фискальный `request` — внутренний snapshot и intent, не формат Webkassa/Kaspi.
Перед настоящим вызовом нужен подтверждённый fiscal adapter и политика
распределения **частичного товарного** возврата по исходным строкам, налогам,
скидкам и Чикам. Текущий финансовый refund по capture не принимает решение о
возвращаемом товаре/количестве и не создаёт его автоматически. Нельзя просто
отправить весь sale snapshot как строки частичного возврата.

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

Локальная проверка 7 сентября 2026: **21/21 PASS** (4 unit + 17 PostgreSQL),
TypeScript build/typecheck и ESLint прошли. Финальный прогон отказных сценариев
занял 4.514 с. Formatter и staged diff проверяются перед коммитом; общие
HTTP/CI проверки после объединения с auth 007 выполняются отдельно.

```sh
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
параллельные outbox leases/stale ACK и ограниченная runtime роль.

## Миграция, права и откат

008 добавляет отдельные `commerce_*` таблицы/триггеры/индексы и не меняет данные
TEST-клиентов. До развёртывания объединить migration 007 и 008 в правильном
порядке: checksum runner запрещает добавлять 007 после уже применённой 008.
На existing deploy сначала fresh backup+restore drill, затем миграции отдельной
ролью. Публичные capability flags и banking workers остаются выключенными до
приёмки интеграционного слоя. Этот этап не развёртывал 008 на VPS.

Runtime не получает DDL, DELETE, UPDATE ledger/snapshot, изменение provider
identity или управление account enabled. Ему нужны SELECT справочников
branches/devices/menu/accounts; SELECT/INSERT коммерческих таблиц кроме
`commerce_provider_accounts`; UPDATE только
orders/intents/attempts/refunds/fiscal_documents/outbox; USAGE sequence outbox.
Точный воспроизводимый grant-набор проверяется в PG suite. Grants выдаёт
deployment layer явным списком после миграции; migration не меняет общие роли.

Rollback приложения сохраняет migration 008 и всю финансовую историю. Не
удалять capture/refund/issued/inbox/outbox и не откатывать деньги восстановлением
старой БД. При восстановлении после настоящих операций сначала сверить журнал
провайдера и pending work, затем возобновлять dispatch. Старое приложение
игнорирует новые таблицы; совместимость PostgreSQL/HTTP существующего контура
проверяется общей suite после объединения веток.

Реальные auth/HTTP routes, provider adapters/certification, worker delivery,
server pricing, edge receiver/KDS, товарные возвраты, бонусы/склад, касса,
регистрация ККМ и эксплуатационная приёмка остаются отдельной разработкой.
Завершение этого пакета не закрывает финансовый Gate C или готовность ресторана.
