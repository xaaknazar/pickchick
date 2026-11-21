# TipTopPay TEST - выпуск на сервер 20.11.2026

Решение владельца (20.11.2026): включить тестовую оплату TipTopPay, чтобы платить в TestFlight;
сделать копию базы, выпустить API, открыть адреса в шлюзе и Caddy. Устройство и порядок работы
описаны в [tiptoppay-native-test-1118.md](../tiptoppay-native-test-1118.md).

## Состав

- Исходник API и шлюза: `b48fcd38f1158b9564766c8d594f385598976634` (ветка `codex/cutover-1119`,
  содержит PR400/402/403). [Foundation CI 44804971188](https://github.com/xaaknazar/pickchick/actions/runs/44804971188)
  успешна. Код services/packages/db совпадает с 3cf1b250 (PR400), который до выпуска собран на Mac:
  iOS simulator Release без подписи (модуль PickChickPayments, право in-app-payments) и Android
  `assembleRelease` (`:pickchick-payments:compileReleaseKotlin`) - успешно.
- Миграции не применялись: 039/040 стоят с 07.10.2026, контрольные суммы совпадают с репозиторием.
- Права: `GRANT SELECT, INSERT, UPDATE ON commerce_tiptoppay_test_payments TO pickchick_app`
  (как в `tiptoppay-test-checkout.postgres.test.mjs`).
- API: образ `pickchick-api:b48fcd38…`, окружение отличается от прежнего ровно 7 переменными:
  `TIPTOPPAY_MODE=test`, `TIPTOPPAY_TEST_CHECKOUT_ENABLED=true`,
  `TIPTOPPAY_TEST_WEBHOOKS_ENABLED=true`, `TIPTOPPAY_TEST_CHECKOUT_METHODS=card,google_pay`,
  `TIPTOPPAY_CHECKOUT_ORIGIN=https://api.pickchick.kz/`, `TIPTOPPAY_PUBLIC_ID`,
  `TIPTOPPAY_API_SECRET` (тестовый сайт 8194419). Ключи перенесены из кабинета на сервер без
  вывода в чат и логи; проверены вызовом TipTopPay `/test` (Success). Тома, сети, cloud-db и redis
  без изменений. Apple Pay выключен до Merchant ID и сертификата по CSR TipTopPay.
- Шлюз: `infra/staging/tiptoppay-test-gateway.py`. На установленном конфиге его проверка
  «Data header baseline differs» не прошла: в рабочем файле `/v1/customer-checkout/*` стоит
  в середине строки `@synthetic_surfaces`, а не сразу после `not path`. Применено то же
  преобразование с поправленной проверкой. Дополнительно `test-3ds-return` исключён из общего
  лимита 16 КБ и получил 64 КБ, как ожидает API для PaRes. Остальные 132+ файла веба перенесены
  побайтно.
- Входной Caddy (`/opt/idrink/deploy/Caddyfile`): блок `@tiptoppay_test` из
  `infra/domains/pickchick.Caddyfile` перед прежним 503. Запись в тот же inode, `caddy reload`,
  контейнеры не перезапускались.

## Копии и откат

- До выпуска: `cloud-20261120T205939Z.dump.age`, 2217433 байта, SHA-256
  `38833c5470c4718388925b592569d5f81b26eaca285f3d12de221e855182508d`, schema081.
  Также `cloud-20261120T150121Z.dump.age` (SHA-256 `a1d4f9d5…f58ac`) на VPS и Mac.
  Изолированное восстановление не выполнялось: ключ age на этом Mac не использовался.
- Активных попыток оплаты за 30 минут до переключения не было.
- Откат: прежние `releases/bf325a47…` и `public-https/releases/bf325a47…` сохранены. Вернуть
  указатели `current`, `compose up -d --no-deps api` и `gateway` из старых каталогов,
  записать `rehearsal/tiptoppay-test-1120/front.rollback.Caddyfile` и `caddy reload`.
  Базу не откатывать.

## Проверки результата (21:01-21:05 UTC)

- API и шлюз healthy, перезапусков 0; изменились только эти два контейнера.
- Внутри API `tipTopPayTestOptions` даёт `card, google_pay`, origin `https://api.pickchick.kz`;
  `api.tiptoppay.kz` доступен из контейнера.
- Снаружи на api.pickchick.kz и pickchick.kz: `test-3ds` 200, `test-3ds-return` 200,
  `test-check` без подписи 401, боевые `/check` и `/pay` 503; `test-payments-setup`,
  `POST test-payments`, `GET test-payments/:id` без входа 401.
- Не проверено: ответ `/config` с тестовыми способами (нужен вход клиента), реальное
  тестовое списание, уведомления из кабинета TipTopPay (адреса ещё не прописаны) и
  сборка TestFlight с `EXPO_PUBLIC_TIPTOPPAY_TEST=1`.
