# Раздельные бюджеты HTTP admission (long-poll, edge, per-IP)

Аудит: у cloud API был один лимит `HTTP_MAX_IN_FLIGHT=32` почти на все маршруты. Публичные
long-poll (`/v1/customer-checkout/orders/:id/watch`, `/v1/kiosk-checkout/availability?after=`)
держат слот до 20-25 с, поэтому ~32 открытых приложения/киоска или один атакующий занимали
весь лимит: вход, оплата, back office и синхронизация кассы `/internal/v1/edge/*` получали 503.

Реализация: `packages/platform/src/admission.ts`, маршруты помечены декораторами
`@LongPollRoute()` / `@EdgeDeviceRoute()` на handler/классе контроллера. Класс маршрута
определяется по идентичности handler в Nest, а не по пути, query или заголовкам.

## Бюджеты и значения по умолчанию

Все значения — на один процесс API. Defaults работают без изменения конфигурации.

| Переменная                         | Default | Диапазон   | Что ограничивает                                                                                 |
| ---------------------------------- | ------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `HTTP_MAX_IN_FLIGHT`               | 32      | 1-1024     | Обычные запросы (как раньше), включая одно чтение overflow long-poll                             |
| `HTTP_MAX_LONG_POLL`               | 64      | 1-1024     | Long-poll, которые ждут изменения; столько же одновременно получают отложенный ответ (overflow)  |
| `HTTP_MAX_LONG_POLL_PER_IP`        | 16      | 1-1024     | Ждущие и, отдельно, отложенные long-poll одного клиента; IPv6 считается по /64                   |
| `HTTP_LONG_POLL_PER_IP_ENABLED`    | false   | true/false | Включает per-IP лимит (новый путь 429); `true` без `TRUSTED_PROXY_IPS` останавливает запуск API  |
| `HTTP_MAX_EDGE_IN_FLIGHT`          | 16      | 1-256      | Резерв для device-authenticated `/internal/v1/edge/*`; сверх резерва edge занимает обычные слоты |
| `HTTP_LONG_POLL_OVERFLOW_DELAY_MS` | 5000    | 1000-20000 | Пауза перед ответом overflow long-poll (±25% jitter); не держит слот и соединение с БД           |

Без изменений: readiness - 4, TEST `POST /v1/test/orders/watch` - свой бюджет 32,
меню mobile `GET /v1/customer-checkout/availability` (с `after` и без) - свой бюджет 256
(`pickchick_catalog_watches_in_flight`), как в выпущенных mobile-сборках; сверх 256 - 503.

Маршруты:

- long-poll: `KioskCheckoutController.availability` только с `after` (без `after` это обычное
  однократное чтение) и `CustomerCheckoutController.watch` (`/orders/:id/watch`);
- edge: `MenuSyncController` (`/internal/v1/edge/sync/*`), `FulfillmentTransportController`,
  `PosOrderSyncController`, `DeviceAccessTransportController` (`/internal/v1/edge/devices/*`),
  `CatalogMediaController.edge` (`/internal/v1/edge/media/:file`).

Перенос 19.10.2026 (ветка `codex/fix-ops-1019`): ветка `codex/api-capacity` от 09.10 перенесена
на shared `76902fa4`. В shared уже был отдельный бюджет 256 для меню mobile; он сохранён
без изменений, поэтому меню mobile не переведено на long-poll бюджет и per-IP лимит.

## Поведение при заполнении

1. Есть место в long-poll бюджете и (при включённом per-IP) у клиента меньше
   `HTTP_MAX_LONG_POLL_PER_IP` ждущих — запрос ждёт, как раньше. Обычные слоты не занимает.
2. Иначе — overflow: через паузу `HTTP_LONG_POLL_OVERFLOW_DELAY_MS` handler один раз читает
   и возвращает текущее состояние (тот же статус, тело и `X-Availability-Signature`/
   `X-Catalog-Version`, что у ожидания без изменений). Пауза обязательна: установленные
   киоск build 10 повторяет запрос через 0 мс, mobile build 14 — через 100 мс, поэтому
   немедленный ответ превратил бы каждый лишний long-poll в цикл запросов.
3. Только при `HTTP_LONG_POLL_PER_IP_ENABLED=true`: у клиента уже `HTTP_MAX_LONG_POLL_PER_IP`
   отложенных — `429 RATE_LIMITED`,
   `Retry-After` в секундах паузы. Клиенты повторяют с backoff.
4. Отложенных уже `HTTP_MAX_LONG_POLL` (overflow тоже ограничен) или после паузы нет обычного
   слота — `503 SERVICE_UNAVAILABLE`, `Retry-After: 1`, как прежде.

Edge-запросы сначала занимают резерв `HTTP_MAX_EDGE_IN_FLIGHT`, затем свободные обычные
слоты. Публичные запросы резерв занять не могут.

## Адрес клиента и предусловие per-IP

Ключ — Express `request.ip`. `X-Forwarded-For` учитывается только от адресов из
`TRUSTED_PROXY_IPS` (адрес контейнера gateway); заголовок от любого другого узла
игнорируется, ротация `X-Forwarded-For` не обходит лимит. Gateway Caddy сам выставляет
`X-Forwarded-For` клиентским адресом.

Per-IP лимит **выключен по умолчанию** (`HTTP_LONG_POLL_PER_IP_ENABLED=false`): это новый
путь отказа 429 для установленных клиентов, а за общим NAT (Wi-Fi ресторана, мобильный CGNAT)
много честных клиентов делят один адрес. Включать только после просмотра метрик и решения
владельца. Без `TRUSTED_PROXY_IPS` все клиенты видны как адрес gateway, поэтому
`HTTP_LONG_POLL_PER_IP_ENABLED=true` без него останавливает запуск API. Long-poll бюджет и
edge-резерв работают независимо от флага. `TRUSTED_PROXY_IPS` добавляет release с customer
auth (`infra/staging/release-server-pilot.py`).

Kiosk `GET /v1/kiosk-checkout/availability` исключён из per-IP лимита
(`@LongPollRoute('after', { perClient: false })`): установленный маршрут gateway
`@kiosk_menu_read` не передаёт `X-Forwarded-For {client_ip}`, поэтому Caddy дописывает адрес
внешнего proxy и `request.ip` у всех киосков одинаковый. Ожидание киоска начинается только
после аутентификации enrolled-устройства, его число ограничено парком киосков. Mobile-маршруты
`@customer_checkout` передают `{client_ip}`.

## Развёртывание

Новых миграций, grants и клиентских сборок нет. Поведение включается обычным выпуском
API-образа с этим коммитом; переменные необязательны.

1. Дождаться завершения текущего выпуска единого меню/киоска; занять `@vps` по
   [collaboration](../collaboration/README.md). Не совмещать с чужим deploy.
2. Выпускать штатным release-скриптом выбранного профиля (проверенный SHA, сборка образа,
   пересоздание только `api`). Общие PostgreSQL/Caddy не перезапускать.
3. На VPS проверить приватные метрики (порт привязан к 127.0.0.1):

   ```sh
   curl -fsS http://127.0.0.1:13100/health/metrics | grep -E 'long_poll|edge_|http_in_flight|rejected'
   ```

   Ожидается `pickchick_http_long_poll_limit 64`, `pickchick_http_edge_limit 16`. При открытых
   приложениях/киосках `pickchick_http_long_poll_in_flight > 0`, а `pickchick_http_in_flight`
   не растёт от них. `pickchick_http_long_poll_clients 0` ожидаемо, пока per-IP выключен.

Включение per-IP (отдельный шаг, после наблюдения `pickchick_http_long_poll_in_flight` под
реальной нагрузкой): добавить в `services.api.environment` установленного compose
`HTTP_LONG_POLL_PER_IP_ENABLED: 'true'` (и при необходимости `HTTP_MAX_LONG_POLL_PER_IP`),
убедиться, что `TRUSTED_PROXY_IPS` задан адресом gateway, пересоздать только `api`. Проверка:
при открытых mobile-приложениях `pickchick_http_long_poll_clients > 0`. Откат: убрать
переменную или `'false'`, пересоздать `api`.

4. Smoke: киоск и mobile получают меню/стопы; касса синхронизирует меню и заказы.

Изменение значений (необязательно): compose передаёт в контейнер только перечисленные
переменные. Добавить в `services.api.environment` нужные строки, например
`HTTP_MAX_LONG_POLL: ${HTTP_MAX_LONG_POLL:-64}`, задать значение в release env и
пересоздать только `api`. Недопустимое значение остановит запуск API с
`Invalid configuration: <имя>` без вывода значения.

Откат: предыдущий образ API. Данные и схема не менялись; старый образ игнорирует новые
переменные.

## Сигналы

- Рост `pickchick_http_long_poll_paced_total`: клиентов больше, чем long-poll бюджет.
  Сначала проверить `pickchick_db_pool_waiting` и CPU (каждый ждущий long-poll читает БД раз
  в 0,5-1 с), затем повышать `HTTP_MAX_LONG_POLL`.
- Рост `pickchick_http_long_poll_client_rejected_total`: один адрес держит много long-poll.
  Отличить злоупотребление от общего NAT (Wi-Fi ресторана, мобильный CGNAT).
- `pickchick_http_edge_borrowed_in_flight > 0`: пики кассового транспорта выше резерва.
- `pickchick_http_rejected_total` — по-прежнему все 503 admission.

## Ограничения

- Бюджеты процесса; при нескольких репликах суммируются.
- Резерв edge — это слоты admission, а не соединения PostgreSQL: общий пул `DB_POOL_MAX`
  по-прежнему один (FIFO), при медленной БД edge ждёт вместе со всеми.
- TEST order watch не переведён на новый бюджет (поведение прежнее).
- Ограничение частоты запросов и защита от распределённых атак остаются задачей ingress.

## Проверки

```sh
pnpm -r --filter "./packages/**" run build && pnpm --filter "./services/**" run build
node --test tests/unit/admission.test.mjs
node --env-file=.env --test --test-concurrency=1 tests/integration/admission-pools.test.mjs tests/integration/admission.test.mjs
```

Integration: 40 одновременных ожиданий (34 меню mobile в своём бюджете + 6 kiosk long-poll)
при `HTTP_MAX_IN_FLIGHT=4` не мешают kiosk quote и edge pull; занятый блокировкой PostgreSQL
единственный обычный слот не мешает edge pull; overflow kiosk long-poll отвечает текущим
состоянием после паузы, kiosk не считается per-IP даже при включённом флаге. Per-IP 429 и
ключи клиентов проверены unit-тестами (`tests/unit/admission.test.mjs`); integration-проверки
per-IP на `orders/:id/watch` нет (нужен вход клиента и заказ).
