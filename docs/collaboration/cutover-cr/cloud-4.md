# CR cloud-4: подключение отчёта продаж и импорта начальных остатков (CC-7, CC-8) вне файлов полосы cloud

Полоса: cloud (шаг 5). Кому: integration. Интерфейсы §5 не меняются: §5.7 и §5.10 реализованы
как есть.

Что сделано в `codex/cutover-cloud`: отчёт `GET /v1/admin/backoffice/branches/{branchId}/ops/sales`
(`packages/backoffice-core/src/sales-report.ts`, флаг `BACKOFFICE_SALES_REPORT_ENABLED`, его читает
`backofficeOptions(process.env)`), блок «Продажи» в кабинете, регулярка шлюза
(`infra/public-staging/gateway.Caddyfile`), прокси кабинета (`apps/backoffice/server.mjs`),
`scripts/stock-opening-import.mjs`, `catalog-menu-import.mjs restore`. Runbook:
`docs/operations/backoffice-cutover.md` (разделы CC-7, CC-8), `real-menu-cutover-2026-11.md`
(«Откат»). Миграций нет.

## 1. Права чтения `cloud_pos_*` для отчёта (`infra/staging/provision.mjs`)

Отчёт читает `cloud_pos_sales`, `cloud_pos_tenders`, `cloud_pos_refunds`,
`cloud_pos_refund_tenders`, `cloud_pos_shift_reports` ролью API. По контракту §3.2 п. 2 права
чтения на них выдаёт helper 074, если таблицы есть: `backofficeCutoverGrants(apiRole,
{backoffice: true, roles})` (`infra/staging/backoffice-cutover-grants.mjs`, вызов из CR `cloud-3`)
добавляет `GRANT SELECT` на каждую существующую из пяти таблиц (ревью CR-CLOUD-R7). Это
добавление без `REVOKE`: сброс прав таблиц 073 остаётся один, `cloudPosSalesGrants`
(`infra/staging/pos-sales-grants.mjs`, полоса pos). Поэтому порядок в `provision.mjs`:
`backofficeGrants` → `cloudPosSalesGrants` → `backofficeCutoverGrants` → проверки. Параметр
`backoffice` у `cloudPosSalesGrants` - тот же переключатель бэк-офиса: тогда helper 074 ничего не
добавляет сверх набора полосы pos, и её точная проверка `assertCloudPosSalesPrivileges` проходит
после обоих вызовов (тест `packages/backoffice-core/tests/sales-report.test.mjs`). Вызов из CR
`cloud-2` (§2) `cloudPosSalesGrants('pickchick_app', {receiver: true, backoffice: true})` даёт те
же права и сам. После вызовов - проверка:

```diff
+import { assertBackofficeCutoverPrivileges } from './backoffice-cutover-grants.mjs';
 ...
       await client.query(cloudPosSalesGrants('pickchick_app', { receiver: true, backoffice: true }));
+      // The CR cloud-3 call goes here, after the cloud073 reset: it adds SELECT on the report tables.
+      await client.query(
+        backofficeCutoverGrants('pickchick_app', {
+          backoffice: config.backofficeEnabled === true,
+          roles: process.env.BACKOFFICE_ROLES_ENABLED === 'true',
+        }),
+      );
+      await assertBackofficeCutoverPrivileges(client, 'pickchick_app', {
+        backoffice: config.backofficeEnabled === true,
+        roles: process.env.BACKOFFICE_ROLES_ENABLED === 'true',
+        stockV2: process.env.BACKOFFICE_STOCK_V2_ENABLED === 'true',
+        salesReport: process.env.BACKOFFICE_SALES_REPORT_ENABLED === 'true',
+      });
```

`assertBackofficeCutoverPrivileges` (из `infra/staging/backoffice-cutover-grants.mjs`) с
`salesReport: true` проверяет `SELECT` на каждой существующей таблице 073. Без прав API не
падает: отчёт показывает только приложение и киоск (`coverage.pos=false`).

## 2. Флаг в окружении (`infra/staging/compose.yaml`, `.env.example`)

В `api` и `provision` рядом с флагами CR `cloud-3`:

```diff
       BACKOFFICE_STOCK_V2_ENABLED: ${BACKOFFICE_STOCK_V2_ENABLED:-false}
+      BACKOFFICE_SALES_REPORT_ENABLED: ${BACKOFFICE_SALES_REPORT_ENABLED:-false}
```

`.env.example`:

```diff
+# Cutover CC-7: sales report GET .../ops/sales of every channel (cloud073 projections plus app and
+# kiosk payments) and the «Продажи» block of the cabinet.
+BACKOFFICE_SALES_REPORT_ENABLED=false
```

Если тест релиза сверяет полный список переменных compose (`tests/operations/test_*release*.py`),
добавить туда же.

## 3. OpenAPI (`scripts/contracts.mjs`)

Маршрута отчёта в `openapi.json` нет: у полосы cloud нет точки вставки в `scripts/contracts.mjs`
(§4.2). Блок для того же места, что блок CR `cloud-3` (§3), внутри тех же маркеров:

```js
// cutover:cloud begin
const boSalesReport = boOperation('readBackofficeSalesReport', 'BackofficeResult');
boSalesReport.parameters.push(
  { name: 'start_date', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
  { name: 'end_date', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
);
openapi.paths['/v1/admin/backoffice/branches/{branchId}/ops/sales'] = { get: boSalesReport };
// cutover:cloud end
```

затем `pnpm contracts:generate`. Пока флаг выключен - 404 `NOT_FOUND` (как неизвестный вид).

## 4. Импорт начальных остатков

Новых прав и маршрутов нет: инструмент ходит в API тем же доступом управляющего, что кабинет
(`GET .../branches/:id`, `POST .../commands`), через шлюз или локально. Для мастер-runbook
(ДП1/ДП3, §6.2 шаг 9): план, сверка с бухгалтером, `--apply --expected-plan`, повтор той же
командой при обрыве - раздел CC-8 в `docs/operations/backoffice-cutover.md`.

## 5. Порядок §6.2 шаг 8

Cloud-2 (ночь 17→18.11): API с этим кодом, права п. 1, `BACKOFFICE_SALES_REPORT_ENABLED=true`.
Откат - флаг `false` (отчёт ничего не пишет).
