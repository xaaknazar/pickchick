# TipTopPay LIVE - боевая оплата заказа в приложении (23.11.2026)

Владелец 23.11.2026: TipTopPay перевёл терминал в боевой режим; «делай сейчас и чтобы было готово
это все». Загруженные сертификаты Apple Pay для боевого режима подходят (новый CSR не нужен).
Включение на сервере и выпуск в App Store - только после отдельного «да» владельца.

Тестовый режим (песочница без заказа) описан в [tiptoppay-native-test-1118.md](tiptoppay-native-test-1118.md).

## Как устроено

1. Клиент нажимает «Оплатить» картой, Apple Pay или Google Pay. Приложение пересчитывает корзину
   (`POST /quotes`), создаёт заказ той же командой, что и Kaspi (`POST /orders`): заказ держит
   допуск на кухню до оплаты (`deferred_pilot`, без фискального счёта).
2. `GET /payments-setup` даёт публичный id и ключ боевого терминала. Карта шифруется на телефоне
   (криптограмма), кошельки дают свой токен. Номер карты к нам не попадает, криптограмма не
   хранится.
3. `POST /orders/:id/tiptoppay {method, cryptogram}` - сервер открывает попытку оплаты
   (`startTipTopPayAttempt`, ключ `customer-tiptoppay`), и в той же транзакции вызывает
   `/payments/cards/charge` (`InvoiceId` = id попытки, `AccountId` = id клиента,
   `X-Request-ID` = id попытки, повтор в течение часа не списывает второй раз).
4. Ответ банка записывается как наблюдение провайдера:
   - `Completed` с той же суммой -> `captured` -> `reconcile()` -> заказ уходит на кухню;
   - нужен 3-D Secure -> ссылка `/v1/integrations/tiptoppay/3ds`, возврат на
     `/3ds-return` -> `/payments/cards/post3ds`;
   - `Declined` -> `failed` с текстом банка; повторное нажатие платит тот же заказ новой попыткой;
   - потерянный ответ, чужая сумма или `TestMode: true` -> `unknown`, заказ показывает
     «Проверяем оплату».
5. Подписанные уведомления TipTopPay `check`, `pay`, `fail` (HMAC боевого API-пароля)
   подтверждают то же самое независимо от телефона.
6. Воркер `services/api/src/tiptoppay-worker.ts` каждые 2 с:
   - сверяет попытки без ответа через `POST /payments/find {InvoiceId}` с растущей паузой;
     «не найдено» через 20 минут -> `failed`, после 12 запросов без ясности -> `unknown`
     (решает человек); попытка, не ушедшая в банк 15 минут, -> `failed`;
   - отправляет возвраты: `refund.submit_requested` по счёту `tiptoppay` ->
     `POST /payments/refund {TransactionId, Amount}` с `X-Request-ID` = id возврата.
     Потерянный ответ -> возврат `unknown`, повторно не отправляется.
7. Бэк-офис: «Вернуть деньги» для оплат TipTopPay (флаг
   `BACKOFFICE_TIPTOPPAY_REFUNDS_ENABLED=true`); «Подтвердить возврат TipTopPay по запросу» -
   только для возврата `unknown` после проверки в кабинете. Отзыв (withdraw) возврата TipTopPay
   запрещён.
8. Приложение после оплаты чистит корзину, запоминает способ оплаты и открывает экран заказа
   (номер, готовится, готов) - тот же, что у Kaspi.

Боевой и тестовый режимы взаимоисключающие: при `TIPTOPPAY_CHECKOUT_ENABLED=true` тестовые
адреса не принимают новых оплат.

## Что проверено

В контейнере на PostgreSQL 16: 13 сценариев боевого режима
(`packages/commerce-core/tests/tiptoppay-live-checkout.postgres.test.mjs`: оплата -> кухня,
отказ и повтор, 3-D Secure, потерянный ответ -> find, чужая сумма, «не найдено», неотправленная
попытка, Kaspi блокирует, возврат, потерянный возврат, подписанные Check/Fail, права ролей),
регрессия Kaspi и тестового режима, тест возвратов бэк-офиса, 643 мобильных теста, TypeScript,
ESLint, Prettier. Банк не вызывался: ответы TipTopPay подменены.

**Не проверено и обязательно до включения:** адреса `/payments/find` и `/payments/refund` взяты из
документации CloudPayments (TipTopPay - её форк); в журнале изменений TipTopPay 05.11.2026 убраны
«неактуальные API». Перед включением проверить оба вызова на тестовом терминале (find по
известному InvoiceId, refund тестовой оплаты). Если путь другой - поправить
`tipTopPayCall` в `packages/commerce-core/src/tiptoppay-test-checkout.ts`.

## Включение (после «да» владельца)

Порядок, каждый шаг с копией базы перед изменениями:

1. Копия облачной базы (`cloud-<время>.dump.age`), записать SHA-256.
2. Миграция `db/cloud/migrations/082_cloud_tiptoppay_live_checkout.sql` (несколько попыток на
   заказ, колонки `method`, `next_check_at`, индексы).
3. Права: выполнить SQL из `infra/staging/tiptoppay-live-grants.mjs` -
   `tipTopPayApiGrants('pickchick_app', true)` и `tipTopPayWorkerGrants(<роль воркера>, true)`. Выключение (`false`) отзывает права на таблицы
   сессий и сохранённых способов.
4. Счёт провайдера: строка `provider='tiptoppay'`, `external_reference` = боевой Public ID;
   её id идёт в `TIPTOPPAY_ACCOUNT_ID`.
5. Окружение API (ключи переносятся из кабинета на сервер без вывода в чат и логи; кнопку
   «Обновить» у API-пароля в кабинете не нажимать):
   `TIPTOPPAY_MODE=live`, `TIPTOPPAY_CHECKOUT_ENABLED=true`, `TIPTOPPAY_WEBHOOKS_ENABLED=true`,
   `TIPTOPPAY_PUBLIC_ID`, `TIPTOPPAY_API_SECRET`, `TIPTOPPAY_ACCOUNT_ID`,
   `TIPTOPPAY_CHECKOUT_ORIGIN=https://api.pickchick.kz/`,
   `TIPTOPPAY_CHECKOUT_METHODS=card,apple_pay,google_pay`,
   `TIPTOPPAY_APPLE_PAY_CERTIFICATE_READY=true`, `TIPTOPPAY_GOOGLE_PAY_GATEWAY`;
   тестовые `TIPTOPPAY_TEST_*_ENABLED` выключить. Бэк-офис:
   `BACKOFFICE_TIPTOPPAY_REFUNDS_ENABLED=true`.
6. Воркер: `infra/payments/tiptoppay/worker.compose.yaml`.
7. Шлюз: `infra/staging/tiptoppay-live-gateway.py` (payments-setup, orders/<uuid>/tiptoppay,
   блок `@tiptoppay_live` для 3ds/3ds-return/check/pay/fail перед `@tiptoppay_test`). Проверить
   `test_tiptoppay_live_gateway.py`.
8. Входной Caddy (`infra/domains`, `pickchick-ingress`, `backoffice-login`): сейчас
   `/v1/integrations/tiptoppay/*` кроме тестовых отвечает 503 - открыть боевые адреса тем же
   способом, что `@tiptoppay_test` 20.11.
9. Кабинет TipTopPay, боевой сайт, уведомления:
   `https://api.pickchick.kz/v1/integrations/tiptoppay/check`, `.../pay`, `.../fail`.
10. Проверка: снаружи `check` без подписи 401, `3ds` 200; одна боевая оплата на малую сумму
    картой владельца -> заказ на кухне -> возврат из бэк-офиса -> деньги вернулись.

Откат: вернуть прежние релизы API и шлюза, `TIPTOPPAY_CHECKOUT_ENABLED=false`, Caddy с 503.
Базу не откатывать (миграция 082 совместима с прежним кодом).

## Приложение

Боевые способы видны в любой сборке, когда `/config` отвечает `paymentEnvironment: 'live'`
(`connectedTipTopPayMethods`). Сборки с боевой оплатой до отдельного «да» владельца идут только в
TestFlight «PickChick Internal»; App Store - после его решения.
