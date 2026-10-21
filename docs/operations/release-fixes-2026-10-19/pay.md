# Исправления аудита 19.10: оплата Kaspi (линия pay)

Ветка `codex/fix-pay-1019` от `76902fa4` (общий срез `codex/shared-development`).
Источник находок: аудит запуска 19.10 (`findings.json`, id вида `i.j`).
Миграций нет (номера 061-062 линии не использованы). Рукописные контракты
(`packages/contracts/src`) не менялись; сгенерированный `openapi.json` обновлён
`pnpm contracts:generate` из-за новых команд кабинета `manual_refund` и `withdraw_refund`.
Реальные счета, банк, VPS, Telegram и касса не использовались: все проверки на
локальном PostgreSQL со scripted bridge.

## Итог по находкам

| Находка                                          | Статус                                          | Что сделано                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.0 Блокировка всех счетов одной попыткой        | исправлено                                      | Отложенная попытка откладывает только себя (свой lease), выбор по `attempts, sequence`; другие заказы получают счёт в том же цикле. Снятый/отменённый рестораном удерживаемый заказ сразу получает failed `order_not_held`.                                                                                                                                                                                                                                        |
| 0.1 / 5.1 Тихая потеря сессии, вечные попытки    | исправлено                                      | Неудачная проверка сессии = `sessionProblem` с кодом причины; worker сам повторяет read-only проверку (5 с, затем с удвоением до раза в минуту) и продолжает без рестарта; попытка, не отправленная в банк за 600 с, получает failed `invoice_not_sent` (счёт не создаётся, деньги не берутся, подарок 7+1 освобождается); событие `kaspi_remote_attention` не чаще раза в 5 минут и одно событие восстановления; смена состояния сессии сообщается сразу (ревью). |
| 0.3 / 7.1 Возвраты, которые никто не выполняет   | исправлено (включение - владелец)               | Кнопка «Запросить возврат» скрыта и сервер отклоняет команду без адаптера; новая команда «Зарегистрировать ручной возврат»; старые pending-запросы подтверждаются или отзываются. Включается флагом и отдельными правами БД.                                                                                                                                                                                                                                       |
| 0.4 Отмена рестораном при открытом счёте         | исправлено                                      | Счёт отменяется сразу; оплата, успевшая пройти, получает сигнал `PAID_AFTER_RESTAURANT_CANCEL`, на кухню не уходит, видна в карточке заказа кабинета. Ревью: тот же сигнал, если касса отменила удержание уже оплаченного заказа до доставки допуска на кухню.                                                                                                                                                                                                     |
| 0.5 Восстановление счёта с повторяющимся текстом | исправлено                                      | Неоднозначными считаются только попытки с пересекающимся окном отправки; записи истории банка вне окна этой попытки не учитываются. Проверки телефона, суммы и операции прежние. Ручной «приём» неизвестного счёта по номеру операции не добавлялся.                                                                                                                                                                                                               |
| 0.6 Счёт киоска на аккаунте без worker           | исправлено                                      | Способ `kaspi_invoice` в киоске предлагается только если `KIOSK_KASPI_INVOICE_ACCOUNT_ID` = `KASPI_REMOTE_ACCOUNT_ID`; иначе в лог `kiosk_invoice_account_not_served`. QR без изменений.                                                                                                                                                                                                                                                                           |
| 2.1 Заказ, отклонённый на /payment (сервер)      | исправлено (серверная часть)                    | ITEM_STOPPED, RESTAURANT_CLOSED и постоянный NOT_READY отменяют неоплаченный заказ через штатное намерение отмены, ответ с тем же кодом ошибки; GET показывает `failed`; подарок освобождается; TTL 30 минут для заказов без попытки оплаты. Клиентская часть - линия mob.                                                                                                                                                                                         |
| 3.2 Истёкший QR киоска становится unknown        | исправлено                                      | Терминальный статус по своей операции = failed без требования суммы; анонимный ответ без Id и суммы (реальный QrTokenDiscarded 8.10) = failed после истечения QR; pending с своим Id без суммы оставляет QR действующим; чужой Id, чужая сумма, ранний анонимный отказ и Processed без точных Id/суммы остаются unknown. Ревью: пустой Id (null, '', 0) и нулевая сумма ('0.00', '0 ₸') считаются отсутствующими.                                                  |
| 7.2 Рекомендация fiscal `required` для киоска    | исправлено                                      | `release-kiosk-qr.py` (и профили menu/checkout на его основе) отклоняет `required` с понятной причиной; документы исправлены.                                                                                                                                                                                                                                                                                                                                      |
| 7.0 Мобильные продажи без чека                   | серверный выключатель готов; решение - владелец | `CUSTOMER_KASPI_SALES_ENABLED` (по умолчанию true = как сейчас). Фискальный код не менялся.                                                                                                                                                                                                                                                                                                                                                                        |

## Решения PM, применённые в линии

- Решение 2: попытка, не отправленная в банк, истекает через 10 минут
  (`KASPI_REMOTE_PENDING_MAX_AGE_SECONDS`, по умолчанию 600) с понятной причиной;
  денег не взято, клиент может повторить.
- Решение 3: возвраты Kaspi делает персонал в Kaspi Pay, PickChick их регистрирует.
  Автоматическая кнопка скрыта, пока нет адаптера возвратов.
- Решение 4: оплаченные мобильные продажи без чека кодом не меняются; добавлен
  серверный выключатель продаж.
- Неоплачиваемый заказ (2.1) отменяется только при постоянной причине. Временные
  (касса не на связи, устаревший heartbeat) оставляют заказ доступным для оплаты.

## Флаги и переменные окружения

| Переменная                             | По умолчанию | Где           | Смысл                                                                                                                                                                                                                                               |
| -------------------------------------- | ------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KASPI_REMOTE_PENDING_MAX_AGE_SECONDS` | 600          | worker счетов | Максимальный возраст неотправленной попытки (60..86400).                                                                                                                                                                                            |
| `CUSTOMER_KASPI_SALES_ENABLED`         | true         | API           | false - новые мобильные оплаты Kaspi закрыты: config отвечает `enabled=false`, новые заказы и попытки оплаты отклоняются (заказ, для которого пришла попытка оплаты, отменяется без оплаты). Уже созданные попытки и счета обрабатываются до конца. |
| `CUSTOMER_UNPAID_ORDER_TTL_MINUTES`    | 30           | API           | Через сколько минут неоплаченный мобильный заказ без попытки оплаты отменяется (0 - выключено, иначе 5..1440).                                                                                                                                      |
| `BACKOFFICE_MANUAL_REFUNDS_ENABLED`    | false        | API           | Включает регистрацию ручного возврата и отзыв старых запросов. Требует `manualRefundGrants`.                                                                                                                                                        |

Плейсхолдеры добавлены в `.env.example` и `infra/payments/kaspi-bridge/kaspi-remote.env.example`.
Недопустимые значения флагов останавливают запуск процесса (как остальные строгие флаги).

## Права БД

Новых таблиц нет. Для ручных возвратов роли API нужен отдельный помощник
`manualRefundGrants(role, true)` из `infra/staging/manual-refund-grants.mjs` (при интеграции вынесен из
`backoffice-grants.mjs`, который закреплён по хешу в `release-finance-ledger.py`):
`INSERT` на `commerce_refund_effects` и `UPDATE(state)` на `commerce_refunds`.
Применять **после** `fulfillmentTransportGrants`, `backofficeGrants` и
`customerCheckoutGrants`: помощник транспорта отзывает у общей роли все права на возвраты.
`infra/staging/provision.mjs` применяет его последним сам: права выдаются, только если
`BACKOFFICE_ENABLED=true` и `BACKOFFICE_MANUAL_REFUNDS_ENABLED=true`, иначе снимаются.
Поэтому общий provision в будущих выпусках не теряет права включённого флага.
Отмена неоплаченного заказа (2.1) использует уже существующие права backoffice
на `commerce_cancellation_intents`; если кабинет выключен и этих прав нет, отмена
тихо не выполняется, заказ остаётся как раньше (ошибка /payment та же).

## Интерфейс для эксплуатации (pay -> ops)

Worker `kaspi-remote-worker` пишет в stderr JSON:

```json
{
  "event": "kaspi_remote_attention",
  "sessionProblem": true,
  "sessionRejected": true,
  "reason": "session_inactive",
  "unknownOverdue": 0,
  "errors": 0,
  "pendingUnsent": 2,
  "oldestUnsentSeconds": 130
}
```

`reason`: `session_inactive`, `bridge_unreachable`, `session_missing`,
`session_rejected` (проблема банка), `unknown_overdue`, `invoice_not_sent`
(клиент ждёт счёт дольше 120 с), `worker_errors`. Не чаще раза в 5 минут, пока
проблема длится; затем один раз в stdout:
`{"event":"kaspi_remote_attention","recovered":true,"sessionProblem":false}`.
Смена самого состояния сессии интервал не ждёт: потеря сессии во время другой тревоги
(например `unknown_overdue`) сообщается сразу строкой с `sessionProblem: true`, а
восстановление сессии при оставшейся другой проблеме - сразу строкой с
`sessionProblem: false` и причиной этой проблемы (watchdog закрывает тревогу сессии
по `sessionProblem: false`).
Поле `sessionRejected` сохранено для старых читателей логов. Телефонов, сумм
и значений сессии в событии нет. Строка `kaspi_remote` (итог цикла) дополнена
полями `deferred`, `notSent`, `pendingUnsent`, `oldestUnsentSeconds`, `sessionReason`.

Причина отказа неотправленной попытки хранится в `commerce_provider_inbox.event_id`:
`kaspi-remote:<attempt>:not-sent:invoice_not_sent` или `...:order_not_held`.

## Ручной возврат Kaspi: порядок для персонала

1. Управляющий открывает заказ в кабинете и проверяет оплату и сигналы сверки.
2. Возврат делается в Kaspi Pay вручную (приложение кассира), по правилам банка.
3. В кабинете: «Зарегистрировать ручной возврат по оплате ...», указать позиции
   (или сумму), номер операции возврата из Kaspi Pay и причину.
4. Возврат сразу виден как «Подтверждено» в заказе и в разделе «Финансы»;
   отметки 7 + 1 снимаются по правилам подтверждённого возврата; запись в журнале аудита.
5. Один номер операции Kaspi регистрируется один раз; сумма не больше оплаченной
   за вычетом уже возвращённого и зарезервированного.
6. Старые запросы, созданные прежней кнопкой (состояние «Ожидает»):
   «Подтвердить ручной возврат по запросу ...» (та же сумма, номер операции) или
   «Отозвать запрос возврата ...», если деньги не возвращались.

Для заказов `deferred_pilot` и облачного канала чек продажи не выдавался, поэтому
сигнал «возврат без чека продажи» не создаётся. Для заказов `required` с чеком
создаётся фискальный документ возврата в очереди (адаптера пока нет).

## Совместимость

- Мобильное 0.2.0 (20): коды ошибок /payment прежние; отменённый заказ читается как
  `failed` (уже финальное состояние для сборки 20, авто-оплата его не повторяет).
- Киоск 21: форма ответа не менялась; QR-путь не менялся, кроме разбора статусов.
- Касса edge021: используются существующие команды освобождения удержания
  (протокол транспорта 2), новых событий нет.
- Старый кабинет в кэше браузера: кнопка «Запросить возврат» может ещё показываться,
  но сервер отвечает `REFUND_ADAPTER_NOT_CONFIGURED`, ничего не создаётся.

## Развёртывание

1. Полная CI точного SHA, штатный lock, зашифрованная копия БД.
2. API и образ worker счетов из одной сборки. Миграций нет.
3. Worker: при желании задать `KASPI_REMOTE_PENDING_MAX_AGE_SECONDS` (иначе 600).
4. API: значения по умолчанию сохраняют текущее поведение продаж; TTL 30 минут
   начинает отменять неоплаченные мобильные заказы без попытки оплаты.
5. Ручные возвраты (по решению владельца): задать `BACKOFFICE_MANUAL_REFUNDS_ENABLED=true`
   в env API и provision, выполнить штатный provision (он применит `manualRefundGrants`
   последним) или вручную `manualRefundGrants(<роль API>, true)` последним, затем
   перезапуск API.
6. После выпуска: в логах worker нет `kaspi_remote_failed`; при проблемах сессии
   появляется `kaspi_remote_attention` с `sessionProblem`.

## Откат

Прежний образ API и worker. Данные совместимы в обе стороны (схема не менялась).
Отменённые заказы и failed-попытки остаются такими (это верные факты). Зарегистрированные
ручные возвраты остаются в учёте; старый кабинет показывает их как подтверждённые возвраты.
Права `manualRefundGrants` снять: `manualRefundGrants(<роль>, false)` или provision с
`BACKOFFICE_MANUAL_REFUNDS_ENABLED=false`. Старый provision этот помощник не знает: после
отката образа права остаются до первого прогона общего provision (он их снимет вместе с
остальными правами на возвраты), команда в старом API всё равно отсутствует.

## Что должен сделать владелец

- Решить с бухгалтером: продолжать ли мобильные продажи Kaspi без фискального чека
  (`deferred_pilot`) или выключить их (`CUSTOMER_KASPI_SALES_ENABLED=false`) до
  подключения Webkassa/ККМ. Опубликовать условия платных заказов с новой версией согласия.
- Решить о включении ручных возвратов (флаг + права) и назначить, кто делает возврат в Kaspi Pay.
- Подключить реальный канал оповещений для `kaspi_remote_attention` (линия ops) и
  дежурство по повторному входу кассира Kaspi.
- Фискальный адаптер (Webkassa) до перевода киоска на `required`.
- На контрольной оплате подтвердить реальные ответы QR (Processed/Expired/QrTokenDiscarded)
  и отмену счёта при отмене заказа рестораном в приложении Kaspi.

## Что не проверено

- Реальные ответы банка (сессия, отмена счёта, история, QR) - только scripted bridge.
- Кабинет в браузере не открывался (проверены сборка, typecheck, lint и unit-логика кнопок).
- Поведение установленных клиентов на устройстве (сборка 20, киоск 21) не проверялось.
- Ручной приём неизвестного счёта по номеру операции Kaspi (часть предложения 0.5)
  не реализован: неизвестные счета по-прежнему решаются вручную.
- Потеря сессии кассира обнаруживается, когда worker пытается выставить счёт или
  проверяет открытый счёт. В простое (нет оплат) отдельной периодической проверки нет:
  частоту обращений к банку не меняли. Первое событие `kaspi_remote_attention`
  появляется с первой оплатой после потери сессии.
- Способ «счёт на телефон» в киоске сверяется с конфигурацией worker
  (`KASPI_REMOTE_ACCOUNT_ID`), а не с его heartbeat: остановленный worker этим не ловится
  (это задача сигналов ops).

## Проверки (20.10, свежая БД линии, `reset-db.sh pay`)

Окружение: Node 24, приватные PostgreSQL линии (cloud 56010, edge 56011),
переменные `*_TEST_DATABASE_URL` указывают на них. Реальный банк, VPS и касса не
использовались.

| Команда                                                                                                                                    | Результат                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `pnpm test:commerce` (unit + integration commerce-core)                                                                                    | unit 47: 46 pass, 1 skip (старый пропуск overlay), 0 fail; integration 156/156 pass |
| `pnpm --filter @pickchick/backoffice-core test`                                                                                            | 5/5 pass                                                                            |
| `pnpm --filter @pickchick/backoffice-core test:integration`                                                                                | 26/26 pass                                                                          |
| `pnpm test` (tests/unit)                                                                                                                   | 244/244 pass                                                                        |
| `node --test tests/backoffice/operations-model.test.mjs`                                                                                   | 5/5 pass                                                                            |
| `python3 -m unittest tests/operations/test_kiosk_qr_release.py`                                                                            | 23/23 OK                                                                            |
| `node --env-file=.env --test tests/payments/kaspi-remote-http.test.mjs tests/payments/kaspi-remote.test.mjs`                               | 25/25 pass                                                                          |
| `node --env-file=.env --test tests/integration/{cloud-kitchen-payment,customer-pilot-orders,storefront-media,kiosk-unified-menu}.test.mjs` | 11/11 pass                                                                          |
| `pnpm test:fulfillment-transport`                                                                                                          | unit 10/10, integration 65/65 pass                                                  |
| backoffice-core `grants.test.mjs` (порядок provision для ручных возвратов)                                                                 | 1/1 pass                                                                            |
| typecheck commerce-core, backoffice-core, api, backoffice                                                                                  | без ошибок                                                                          |
| `pnpm contracts:check` (после регенерации `openapi.json`)                                                                                  | контракты совпадают                                                                 |
| ESLint и Prettier по всем изменённым файлам                                                                                                | без ошибок                                                                          |

Проверка «красный до исправления»: исходники commerce-core базы `76902fa4` с тестами
ветки - 11 ключевых тестов (0.0, 0.1/5.1, 0.4, 0.5, 2.1, 3.2) падают на утверждениях,
воспроизводящих находки (например, счёт B `undefined` вместо `issued`, восстановленный
счёт `unknown` вместо `issued`, истёкший QR `unknown` вместо `failed`); на ветке все проходят.

Тесты по находкам (все проходят на ветке):
0.0 - `one blocked attempt never stalls later ready invoices`, `a stop-listed item defers
only its own order`; 0.1/5.1 - `a lost cashier session is reported and never-sent attempts
expire`, `a recovered session resumes invoices without a worker restart`, `worker attention
is rate-limited`; 0.3/7.1 - `without a refund adapter the old request-refund command is
refused`, `a manual Kaspi Pay refund is recorded once`, `an old pending refund request can
be withdrawn or settled`, `a manual Kaspi Pay refund removes the returned stamp`; 0.4 -
`a restaurant cancellation of a held order cancels its open Kaspi invoice at once`,
`a payment that races the restaurant cancellation is flagged for refund`; 0.5 - `recovery
finds its own invoice although an older invoice had the same readable message`; 0.6 -
`kiosk phone invoice is offered only on the account the invoice worker serves`; 2.1 -
`an order refused at payment for a stopped item is cancelled unpaid`, `... after closing
time`, `... whose held admission the restaurant released`, `a transient payment refusal
keeps the order payable`, `unpaid orders without an attempt expire after the TTL`;
3.2 - `an expired own QR the bank discarded without amount or id fails`, `QR terminal
answers ...`, `QR pending answer with the own id but without amount`; 7.2 -
`test_kiosk_qr_release.py`; 7.0 - `the server sales switch closes new mobile Kaspi payments`.

## Ревью техлида (20.10)

Проверено по каждой находке; красная проверка повторена ревьюером: исходники
commerce-core базы `76902fa4` с тестами ветки - 14 ключевых тестов (0.0 x2, 0.1, 0.4 x3,
0.5, 2.1 x3, TTL, 7.0, 3.2 x2) падают, на ветке проходят. Исправлено ревьюером
(отдельные коммиты, каждый с тестом, который падает на голове инженера `e96cc3e1`):

1. **0.4, оплата до отмены кассой.** Гость заплатил, допуск на кухню ещё в очереди
   (касса была офлайн), кассир отменил удержание. Транспорт такой допуск не доставит,
   заказ не готовится, а сигнала не было. Теперь наблюдение проекции
   (`scheduleUnpaidCancellation`, вызывается транспортом в той же транзакции) и
   `reconcile` ставят `PAID_AFTER_RESTAURANT_CANCEL`, если есть оплата, проекция
   `released`/`cancelled`/`cancel_requested` и допуск на кухню не был доставлен.
   Отмена после доставленного допуска этот сигнал не ставит (другой поток).
   Тесты:
   `a paid order the cashier cancels before its kitchen admission arrives is flagged for refund`,
   контроль
   `a cancellation after the kitchen admission was delivered is not a paid-after-cancel case`.
2. **3.2, пустой идентификатор QR.** Ответ с `Id: null`, `''` или `0` и сумма `'0.00'` /
   `'0 ₸'` считались чужой операцией и оставались `unknown`. Пустые значения теперь
   равны отсутствующим; названный чужой Id и положительная чужая сумма по-прежнему
   `unknown`, деньги - только `Processed` с точными Id и суммой. Тест:
   `kiosk QR status: an empty identity is anonymous, a named foreign one stays unknown (3.2)`.
3. **0.1 / интерфейс ops.** Ограничение «раз в 5 минут» задерживало до 5 минут сообщение
   о потере сессии, если перед этим была другая тревога, и не сообщало о восстановлении
   сессии, пока оставалась другая проблема. Смена `sessionProblem` теперь сообщается
   сразу в обе стороны. Тест:
   `a session change is reported at once even while another attention is rate-limited`.

Остаточные риски (не блокируют выпуск):

- 0.5: в облачном режиме текст счёта - только список позиций. Два одинаковых заказа,
  отправленные в банк в пределах ~25 с, при неопределённом ответе create остаются
  `unknown` (сигнал `unknown_overdue`, ручная проверка в Kaspi Pay). Уникальный текст
  счёта на попытку не вводился: это меняет видимый гостю текст (решение PM/владельца).
- 2.1 и TTL отменяют заказ правами backoffice на `commerce_cancellation_intents`
  (на сервере `BACKOFFICE_ENABLED=true`); без них отмена тихо не выполняется.
- Ответы реального банка не проверялись (только scripted bridge).

Проверки ревьюера (20.10, свежая БД `reset-db.sh pay` перед каждым прогоном):

| Команда                                                                                                                                    | Результат                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `pnpm test:commerce`                                                                                                                       | unit 49: 48 pass, 1 skip; integration 158: все тела тестов проходят (см. ниже)                   |
| `pnpm --filter @pickchick/backoffice-core test` / `test:integration`                                                                       | 5/5, 26/26                                                                                       |
| `pnpm test` (tests/unit)                                                                                                                   | 244/244                                                                                          |
| `node --env-file=.env --test tests/payments/kaspi-remote-http.test.mjs tests/payments/kaspi-remote.test.mjs`                               | 26/26                                                                                            |
| `python3 -m unittest tests/operations/test_kiosk_qr_release.py`                                                                            | 23 OK                                                                                            |
| `node --env-file=.env --test tests/integration/{cloud-kitchen-payment,customer-pilot-orders,storefront-media,kiosk-unified-menu}.test.mjs` | 11/11                                                                                            |
| `pnpm test:fulfillment-transport`                                                                                                          | unit 10/10; integration 65: 59 сразу, 6 упали только на очистке (57014), перезапуск по имени 6/6 |
| `node --env-file=.env --test tests/backoffice/operations-model.test.mjs`                                                                   | 5/5                                                                                              |
| typecheck commerce-core, backoffice-core, api, backoffice; ESLint/Prettier; `pnpm contracts:check`                                         | без ошибок; контракты совпадают                                                                  |

Общий сервер (2 vCPU, 7 линий одновременно) был перегружен: в полном прогоне
integration commerce 38 тестов упали только на очистке фикстуры
(`DROP SCHEMA ... CASCADE` дольше `statement_timeout` 5 с, код 57014), все утверждения тестов прошли.
Эти 38 тестов перезапущены по имени на свежей БД до прохождения (31, затем 6, затем 1):
158/158.

## Ожидаемые пересечения с другими линиями

- mob: `services/api/src/customer-checkout-controller.ts` - текстовый конфликт рядом с
  полями класса (у нас интервал TTL, у mob long poll). Объединить оба блока.
- kio: `.env.example` - обе линии дописали блок в конец файла. Оставить оба.
- ful: правки в `customer-checkout.ts`, `kiosk-checkout.ts`, `repository.ts`
  объединяются без конфликта (проверено `git merge-tree`), но интеграции стоит
  прогнать `pnpm test:commerce` после слияния.
- `packages/contracts/openapi.json` (генерируемый): mob и ful тоже его меняют; сейчас
  слияние текстово чистое, но после объединения всех линий выполнить
  `pnpm contracts:generate` и `pnpm contracts:check`.
- ops: читает `sessionProblem`/`sessionRejected` из `kaspi_remote_attention` - формат
  совместим; новые поля (`reason`, `pendingUnsent`, `oldestUnsentSeconds`) необязательны.
- `mac/codex/kiosk-cart-lines-api-1013`: те же файлы `kiosk-checkout.ts`, `model.ts`
  (ветка на старом срезе, конфликтует с базой и без нас).
