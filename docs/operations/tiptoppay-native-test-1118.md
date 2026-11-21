# TipTopPay в приложении: карта, Apple Pay, Google Pay (тест, 18.11.2026)

Владелец (Aknazar, 18.11.2026): подключить эквайринг TipTopPay к мобильному приложению, оплату
через Apple Pay на iPhone, Google Pay на Android и банковской картой. TipTopPay открыл тестовый
аккаунт (кабинет `merchant.tiptoppay.kz`, сайт 8194419). На карточке решения владелец выбрал
«Полностью нативно»: родная шторка Apple Pay, родной Google Pay и своя форма карты в стиле
приложения, без страницы TipTopPay.

Это **тестовый** этап. Деньги не списываются, заказ не создаётся, на кухню и в чек ничего не
уходит. Боевая оплата (заказ, кухня, чек Webkassa, возвраты) - следующий этап, после согласия
TipTopPay на LIVE-терминал PickChick.

## Как это работает

1. Корзина читает `/v1/customer-checkout/config` с профилем
   `application/json; profile=pickchick.checkout-wallets-v1`. Сервер с включённым тестом
   отвечает `paymentMethods: ['kaspi', 'card', ...]`, `paymentEnvironment: 'test'` и публичный
   Public ID. Старые сборки профиль не шлют и получают прежний ответ (строгие схемы не ломаются).
2. Приложение показывает способ, только если согласны три стороны
   (`apps/mobile/src/tiptoppay-checkout.ts`):
   - сборка с `EXPO_PUBLIC_TIPTOPPAY_TEST=1` (тестовая сборка TestFlight). Сборка App Store без
     этого флага показывает только Kaspi.kz, даже если сервер в тесте (App Review 2.1);
   - сервер (`paymentMethods`);
   - телефон: есть нативный модуль `PickChickPayments`; для Apple Pay ещё настроенный Wallet и
     Merchant ID сборки (`EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID`), для Google Pay - Android.
3. Нажатие «Оплатить» с таким способом: согласие с условиями, свежий `/config`, новая цена
   (`POST /quotes`, те же стопы, что у Kaspi: подарок, комментарий, изменившиеся цены), затем
   `GET /test-payments-setup` (публичный ключ TipTopPay и шлюз Google Pay).
4. Пакет оплаты собирается на телефоне:
   - карта: номер, срок и CVV шифруются RSA ключом TipTopPay
     (`PAN@ГГММ@CVV@PublicId`, PKCS#1, как в официальном SDK). Номер карты не попадает
     ни на наш сервер, ни в логи; приложение его не сохраняет;
   - Apple Pay: токен из `PKPaymentAuthorizationController` (3-D Secure capability);
   - Google Pay: токен `PAYMENT_GATEWAY` для шлюза TipTopPay (`gatewayMerchantId` = Public ID).
5. `POST /test-payments {quoteId, method, cryptogram}`: сервер один раз списывает **в
   песочнице** (`payments/cards/charge`, `X-Request-ID` = id попытки). Повтор той же цены
   возвращает ту же попытку, без второго списания.
6. Если банк просит 3-D Secure, приложение открывает нашу страницу
   `/v1/integrations/tiptoppay/test-3ds` в защищённом браузере; она отправляет форму банку,
   банк возвращает на `/test-3ds-return`, сервер вызывает `post3ds` и возвращает в приложение
   `pickchick://tiptoppay-return`.
7. Приложение ждёт итог до 45 секунд (`GET /test-payments/:id`) и показывает «Оплата прошла»,
   «Оплата не прошла» (с текстом банка) или «Проверяем оплату». На ошибке есть «Попробовать
   ещё раз» и «Оплатить через Kaspi.kz».
8. Уведомления TipTopPay `test-check`, `test-pay`, `test-fail` подписаны HMAC и сверяются с
   попыткой (сумма, операция, срок). Принимаются только с `TestMode=1`.

## Что сделано в коде

- Сервер: `packages/commerce-core/src/tiptoppay-test-checkout.ts`,
  `services/api/src/customer-checkout-controller.ts`, `services/api/src/tiptoppay-controller.ts`,
  таблица `commerce_tiptoppay_test_payments` (миграция 040, уже в репозитории).
- Нативный модуль: `apps/mobile/modules/pickchick-payments` (Swift: PassKit и Security,
  Kotlin: `play-services-wallet` 19.4.0). Плагин `apps/mobile/plugins/tiptoppay-wallets.js`
  добавляет право `com.apple.developer.in-app-payments` только при заданном Merchant ID.
- Приложение: `CardPaymentSheet` и `TipTopPayResultSheet`
  (`apps/mobile/src/components/TipTopPaySheets.tsx`), поток `useTipTopPayCheckout.tsx`,
  подключение к корзине в `KaspiCheckoutScreen.tsx`. Тексты RU/KK/EN в словаре.

## Проверки (контейнер, 18.11.2026)

- `tests/mobile/*.test.mjs`: 634 PASS, из них 9 новых (`tiptoppay-checkout.test.mjs`).
- PostgreSQL `tiptoppay-test-checkout.postgres.test.mjs`: 3 PASS (списание, 3-D Secure, отказ,
  неизвестный исход, уведомления, права runtime, настройка, кэш ключа).
- `tests/payments/*.test.mjs` и ответ корзины: 39 PASS.
- TypeScript приложения, ESLint, Prettier PASS.
- Нативный код в контейнере не компилируется (нет Xcode/Android SDK). Первая сборка на Mac -
  его первая проверка компилятором.

## Что нужно, чтобы протестировать в TestFlight

От владельца и менеджера TipTopPay:

- Включить на тестовом терминале Apple Pay и Google Pay. Для Apple Pay TipTopPay выдаёт CSR
  (запрос сертификата) для нашего Merchant ID.
- Тестовые карты TipTopPay (успех, отказ, 3-D Secure).
- В кабинете, раздел уведомлений: Check `https://api.pickchick.kz/v1/integrations/tiptoppay/test-check`,
  Pay `.../test-pay`, Fail `.../test-fail`, формат по умолчанию (urlencoded), кодировка UTF-8.
- API Secret терминала передаётся сразу на сервер (Codex), не в чат.

От Codex (подробно в задании `/mnt/project-files/tiptoppay-1118/codex-tiptoppay-test.md`):

- Сервер: переменные `TIPTOPPAY_*`, права runtime, маршруты шлюза и ingress для
  `/v1/customer-checkout/test-payments*` и `/v1/integrations/tiptoppay/test-*` (сейчас ingress
  отвечает 503 на `/v1/integrations/tiptoppay/*`).
- Apple Developer: Merchant ID `merchant.kz.pickchick.app`, Apple Pay в App ID, сертификат
  обработки платежей из CSR TipTopPay, новые профили.
- Сборка TestFlight с `EXPO_PUBLIC_TIPTOPPAY_TEST=1` и Merchant ID.

## Включено 20.11.2026

- API `b48fcd38` на облаке с 21:01 UTC: `TIPTOPPAY_MODE=test`, способы `card,google_pay`,
  ключи сайта 8194419 только на сервере. Foundation 44804971188 зелёная. Копия базы перед
  переключением `cloud-20261120T205939Z.dump.age`; добавлено только право runtime на
  `commerce_tiptoppay_test_payments`.
- Шлюз и Caddy доменов пропускают только `test-3ds`, `test-3ds-return`, `test-check`, `test-pay`,
  `test-fail`; боевые `/check` и `/pay` отвечают 503. Проверено снаружи на обоих доменах.
- Кабинет: уведомления Check, Pay, Fail указывают на `.../test-check`, `.../test-pay`,
  `.../test-fail` (POST, UTF-8, формат по умолчанию).
- Сборка TestFlight: профиль `production-tiptoppay-test` в `scripts/mobile/ios_release.py`
  (= production + `EXPO_PUBLIC_TIPTOPPAY_TEST=1`). Только внутренний TestFlight, не App Review.
  Apple Pay в ней нет, пока не готовы Merchant ID и сертификат по CSR TipTopPay.
- Откат: прежние релизы API и шлюза `bf325a47` сохранены, копия Caddyfile доменов в
  `rehearsal/tiptoppay-test-1120/front.rollback.Caddyfile`. Базу не откатывать.

## Чего этот этап не делает

- Не создаёт заказ, не отправляет на кухню, не печатает и не отправляет чек.
- Не делает возвраты: в тесте возвращать нечего. Возвраты, отмена и сверка - в боевом этапе
  (`payments/refund`, `payments/void`), вместе с автоматическим чеком Webkassa.
- Не меняет сборку App Store и Google Play.
