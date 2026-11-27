# TipTopPay LIVE - включение на облачном сервере (23.11.2026)

Порядок: [tiptoppay-live-1123.md](../tiptoppay-live-1123.md). Коммит выпуска
`b91278178a86f9c45d18c8cd1980045593d4dfd1` (PR #423). Время - UTC.

Владелец 23.11.2026: «да, включай боевую оплату» (12:05), затем отдельное разрешение на роль
воркера, права, env-файл и завершение включения (env API, воркер, шлюз, Caddy, уведомления в
кабинете, проверки). Секреты в чат, журналы и репозиторий не выводились.

## Что сделано

Первая часть выполнена предыдущей сессией, вторая - этой.

| Время | Шаг                                                                     | Результат                                                                                              |
| ----- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 12:13 | `TIPTOPPAY_TEST_CHECKOUT_ENABLED=false`, пересоздан только API          | тестовая оплата не принимается                                                                         |
| 12:19 | Копия базы `cloud-20261123T121949Z.dump.age`                            | SHA-256 `13b6d179c0d4f39768b74e6bcda31dfd1d0c49c00f8da999640b4ea5c9044450`, 11 176 488 байт, схема 081 |
| 12:19 | Образ `pickchick-api:b9127817…` собран на сервере                       | метка revision совпадает                                                                               |
| 12:20 | Миграция 082                                                            | в журнале, checksum `e119007e…b1ed`                                                                    |
| 12:20 | Счёт провайдера `tiptoppay`                                             | id `6c6b8dcd-1cdf-4e6a-9ace-92516c974e7a`, точка Abay Plaza                                            |
| 12:29 | Роль `pickchick_tiptoppay_worker`, права из `tiptoppay-live-grants.mjs` | одна транзакция; пароль сгенерирован на сервере                                                        |
| 12:29 | `secrets/tiptoppay-worker/tiptoppay-worker.env`                         | каталог 700, файл 600, владелец 1000:1000                                                              |
| 12:34 | API: образ `b9127817`, боевое окружение                                 | здоров за 13 с, 0 перезапусков                                                                         |
| 12:35 | Шлюз: выпуск `public-https/releases/b9127817…`                          | здоров, конфигурация совпадает с кандидатом                                                            |
| 12:35 | Входной Caddy `/opt/idrink/deploy/Caddyfile`                            | `caddy reload`, контейнеры не пересоздавались                                                          |
| 12:38 | Воркер `pickchick-tiptoppay-worker`                                     | работает, 0 перезапусков                                                                               |
| 12:39 | Кабинет TipTopPay, сайт 8194419: Check, Pay, Fail                       | боевые адреса, после перезагрузки страницы сохранены                                                   |

Окружение API изменилось ровно в семи переменных: `TIPTOPPAY_MODE=live`,
`TIPTOPPAY_CHECKOUT_ENABLED=true`, `TIPTOPPAY_WEBHOOKS_ENABLED=true`,
`TIPTOPPAY_TEST_WEBHOOKS_ENABLED=false`, `TIPTOPPAY_ACCOUNT_ID`,
`TIPTOPPAY_CHECKOUT_METHODS=card,apple_pay,google_pay`,
`BACKOFFICE_TIPTOPPAY_REFUNDS_ENABLED=true`. Ключи те же, что были у тестового режима: TipTopPay
перевёл в боевой режим тот же сайт. Кнопка «Обновить» у API-пароля не нажималась.

## Проверки

- Права до применения прогнаны в транзакции с откатом: роль API ничего не теряет и получает
  только права на `commerce_tiptoppay_sessions` и `commerce_checkout_payment_methods`; роли
  `pickchick_owner` и `pickchick_kaspi_worker` не изменились. `log_statement=none`.
- Роль воркера: `LOGIN`, без `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `BYPASSRLS`; вход по
  сохранённому паролю через закрытую сеть.
- Новый образ читает боевое окружение: способы `card, apple_pay, google_pay`, приём новых оплат
  включён, тестовые параметры `null`.
- Воркер `--once` под своей ролью: `checked 0, settled 0, errors 0`, возвраты `sent 0, errors 0`.
  Банк не вызывался.
- `test_tiptoppay_live_gateway.py`: 3 теста. Кандидат шлюза: `caddy validate` - Valid
  configuration; +17 строк, 2 изменённые.
- Входной Caddy: +14 строк; изменились только сайты `pickchick.kz` и `api.pickchick.kz`, сайт
  idrink не изменился.
- Снаружи: `GET /v1/integrations/tiptoppay/3ds` 200; `check`, `pay`, `fail` без подписи 401;
  прочие пути `/v1/integrations/tiptoppay/*` 503; `test-pay` 503; `payments-setup` и
  `orders/<uuid>/tiptoppay` с неверным токеном 401; бэк-офис, каталог и idrink 200.
- Воркер видит `cloud-db:5432` и TLS `api.tiptoppay.kz`.
- Журнал API после переключения без ошибок. Строк в `commerce_tiptoppay_sessions` - 0.

## Не проверено

- Настоящий банк: ни одной боевой оплаты и ни одного возврата. Первая оплата картой владельца,
  заказ на кухне и возврат из бэк-офиса (шаг 10 порядка) - за владельцем.
- Полная Foundation CI на `b9127817`: запущена в 12:30 на ветке `codex/tiptoppay-live-1123`,
  на момент включения не завершилась.
- Apple Pay и Google Pay в боевом режиме.
- Заказ по этой оплате идёт без фискального чека (`deferred_pilot`).

## Отступления от репозитория

Оба нужно внести в код отдельным изменением.

1. `infra/payments/tiptoppay/worker.compose.yaml` подключает одну сеть. База доступна только в
   закрытой сети `pickchick-staging_private` (`internal: true`), а воркеру нужен выход к
   `api.tiptoppay.kz`. Установлен `releases/b9127817…/tiptoppay-worker.json` с двумя сетями:
   `pickchick-staging_private` и `pickchick-staging_ingress`. Портов воркер не публикует.
2. `loadConfig('api')` требует `REDIS_URL` в формате закрытого стенда, хотя воркер Redis не
   использует. В env-файл добавлена заглушка `redis://unused:<64 нуля>@redis-cache:6379/0` -
   без настоящего пароля Redis.

Входной Caddy в репозитории (`infra/domains/pickchick.Caddyfile`) боевого блока не содержит: на
сервере блок `@tiptoppay_live` добавлен перед `@payment_callback` по образцу `@tiptoppay_test`.

## Откат

Материалы в `/opt/pickchick-staging/rehearsal/tiptoppay-live-1123` и
`rehearsal/tiptoppay-test-1120`.

1. API: `docker compose … -f releases/b48fcd38…/infra/staging/compose.yaml up -d --no-deps api`,
   вернуть ссылку `current`.
2. Шлюз: `up` из `public-https/releases/b5f81015…`, вернуть ссылку `current`.
3. Входной Caddy: записать `front.before.Caddyfile` и выполнить `caddy reload`.
4. Воркер: оставить работать, пока есть открытые попытки; затем `docker compose -f
tiptoppay-worker.json down`.
5. Кабинет: вернуть адреса `test-check`, `test-pay`, `test-fail` или выключить уведомления.

Базу не откатывать: миграция 082 совместима с прежним кодом. Права воркера отзываются тем же
модулем с `enabled=false`.

## Наблюдение, не связанное с выпуском

В журнале входного Caddy `GET /kitchen-link/poll` с адреса точки завершается таймаутом 8 с около
12 раз в минуту. Так было и до переключения (с 11:57 без изменений частоты).
