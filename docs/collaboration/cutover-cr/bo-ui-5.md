# CR bo-ui-5: автосписание по продажам (шаг 5 полосы bo-ui)

Полоса: bo-ui (шаг 5). Кому: integration. Основание: дополнение контракта для полосы bo-ui
(`BACKOFFICE_STOCK_AUTOCONSUME_ENABLED`: воркер, режим точки, очередь; связи меню - склад v2),
`design-bo-ui.md` §3, §5.3, §5.5, `design-backoffice.md` §2 Ск2, §4, §7. Код - только пути полосы:
`packages/backoffice-core/**`, `services/api/src/stock-consumption-worker.ts`, `apps/backoffice/**`,
`infra/staging/backoffice-p1-grants.mjs`, `infra/public-staging/gateway.Caddyfile` (регулярка),
`tests/backoffice/**`, `tests/integration/backoffice-p1-*.test.mjs`. DDL 075 не менялся, `openapi.json`
не менялся (виды идут через общий `GET .../ops/:view`, команды - через общий `POST .../commands`).
Runbook: `docs/operations/backoffice-p1-cutover.md`, раздел «Списание по продажам».

## 1. Процесс воркера (вне путей полосы) - одна служба

Воркер - отдельный процесс по образцу `customer-notifications-worker`:
`node services/api/dist/stock-consumption-worker.js` (тик 30 с; `--once` - один тик для проверки).
Env - тот же, что у API (`CLOUD_DATABASE_URL` роли API, `BACKOFFICE_ENABLED`,
`BACKOFFICE_STOCK_V2_ENABLED`, `BACKOFFICE_STOCK_AUTOCONSUME_ENABLED`, `APP_ENV`, `REDIS_URL` для
`loadConfig`). Без флага он печатает `{"event":"stock_consumption","state":"disabled"}` и выходит, не
открывая базу; без прав 075 - `not_ready` на каждом тике. Логи - только числа.

Просьба добавить службу в `infra/staging/compose.yaml` рядом с `api` (или unit systemd на VPS):

```diff
+  stock-consumption-worker:
+    <<: *app
+    restart: unless-stopped
+    command: ['node', 'services/api/dist/stock-consumption-worker.js']
+    environment:
+      APP_ENV: staging
+      DB_POOL_MAX: '2'
+      CATALOG_ADMIN_ENABLED: ${CATALOG_ADMIN_ENABLED:-false}
+      BACKOFFICE_ENABLED: ${BACKOFFICE_ENABLED:-false}
+      BACKOFFICE_STOCK_V2_ENABLED: ${BACKOFFICE_STOCK_V2_ENABLED:-false}
+      BACKOFFICE_STOCK_AUTOCONSUME_ENABLED: ${BACKOFFICE_STOCK_AUTOCONSUME_ENABLED:-false}
+      CLOUD_DATABASE_URL: postgresql://pickchick_app:${DB_APP_PASSWORD:?Generate a separate secret}@cloud-db:5432/pickchick_cloud
+      REDIS_URL: redis://default:${REDIS_PASSWORD:?Generate a separate secret}@redis-cache:6379/0
+    depends_on:
+      cloud-db: { condition: service_healthy }
```

Несколько копий безопасны: позиция очереди - одна на заказ (первичный ключ), документ - один на
заказ (уникальный индекс 075 по `source_ref`), обработка позиции - под той же блокировкой точки
`bo:branch:<id>`, что команды (тест «exactly once» с тремя параллельными тиками). Наблюдение
(`ops-watchdog`) - по желанию интеграции: строка `stock_consumption_tick` с `errors>0`.

## 2. Права (дополнение CR `bo-ui-1` §1)

`AUTOCONSUME_READ_TABLES` в helper P1 теперь `cloud_pos_sales`, `cloud_pos_refunds`,
`catalog_menu_deliveries`, `catalog_publications`: воркер не списывает полностью возвращённую до
кухни продажу кассы. `cloud_pos_refunds` входит в набор `POS_DAY_TABLES`, то есть в набор
`cloudPosSalesGrants(role, {backoffice: true})` полосы pos; точная проверка pos с `backoffice: false`
при включённом автосписании расходится так же, как уже расходилась на `cloud_pos_sales` (CR `bo-ui-1`):
передавайте в `cloudPosSalesGrants` и в helper P1 один и тот же переключатель бэк-офиса. Вызов helper
и его место в `provision.mjs` не меняются.

Остальное воркер читает правами `backofficeGrants` (`commerce_orders`, `commerce_captures`,
`commerce_refund_effects`, `cloud_fulfillment_projection`, `pos_kitchen_sync_projection`,
`bo_records`) и пишет `bo_stock_documents`, `bo_stock_movements`, `bo_stock_balances` (как команды).
Тест `consumption.test.mjs` «least privilege» запускает тик под ролью только с
`backofficeGrants` + helper P1.

## 3. Что меняется в ответах и когда (подтвердить)

| Условие                                                               | Что добавляется                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| склад P1 (`BACKOFFICE_STOCK_V2_ENABLED`, 075, helper P1 со `stockV2`) | `GET ops/menu-links`; команды `menu_link_save`, `menu_links_approve`; `permissions[]` + `menu_links.write`, `menu_links.approve`; техкарта принимает `stock_policy`; вкладка «Списание по продажам» со связями                                                                                          |
| + `BACKOFFICE_STOCK_AUTOCONSUME_ENABLED` и права 075 очереди          | `capabilities.stock_autoconsume=true`; `GET ops/consumption`; команды `stock_settings`, `consumption_retry`, `consumption_skip`; `permissions[]` + `stock.settings`, `consumption.write`; `stock_settings` в `GET branches/:id`; ручной `consume` при режиме не `off` - `CONFLICT`/`AUTOCONSUME_ACTIVE` |

Без флагов ответы и кабинет - как у облачной полосы (тесты `backoffice-p1-flags`,
`backoffice-p1-autoconsume`, `consumption.test.mjs` «flags off», браузер `autoconsume-browser` off).

Просьбы:

1. Подтвердить, что связи меню идут со складом P1 (как сторно, §8 в.5), а не отдельным флагом.
   Связи сами ничего не списывают: списание начинается только с режимом «Проверка» или «Включено».
2. Подтвердить, что `capabilities.stock_autoconsume` теперь требует и `stock_p1` (без связей воркеру
   нечего списывать). Ключ шага 1 без `stock_p1` был бы `true` только на базе без helper P1 со
   `stockV2`; тест `p1-grants` это покрывает.
3. Новая причина ошибки `AUTOCONSUME_ACTIVE` - в `BackofficeErrorReasonSchema` ядра, как прежние
   причины бэк-офиса (в `packages/contracts` их нет).

## 4. Изменённые тесты (при слиянии)

- `tests/integration/backoffice-p1-flags.test.mjs`: `menu-links` при складе v2 - вид склада P1, 404
  только без склада v2; помощник `without()` снимает права и `stock_settings` автосписания.
- `tests/backoffice/pos-day-ui.test.mjs`: `ops/consumption` теперь в allowlist прокси и в регулярке
  gateway (шаг 2 проверял, что их нет).
- `packages/backoffice-core/tests/stock-p1.test.mjs`: список `BACKOFFICE_P1_PERMISSIONS` и
  `permissions[]` управляющего при складе P1 (добавлены права связей).

## 5. Не сделано (следующие шаги)

- Отчёты склада `view=consumption` и `view=variance` (шаг 6, с подсчётом ключевых позиций).
- Поле `stock_policy` в редакторе техкарты кабинета (сервер его принимает).
- Учёт канала в связи (упаковка по типу заказа - P1 владельца).
