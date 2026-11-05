# CR cloud-3: подключение ролей бэк-офиса и склада v2 (CC-5, CC-6) вне файлов полосы cloud

Полоса: cloud (шаг 4). Кому: integration. Интерфейсы §5 не меняются: §5.10 реализован как есть.

Что сделано в `codex/cutover-cloud`: миграция `db/cloud/migrations/074_cloud_backoffice_cutover.sql`,
helper прав `infra/staging/backoffice-cutover-grants.mjs`, роли (`packages/backoffice-core/src/roles.ts`,
флаг `BACKOFFICE_ROLES_ENABLED`), склад v2 (`packages/backoffice-core/src/stock-v2.ts`, флаг
`BACKOFFICE_STOCK_V2_ENABLED`), `GET .../ops/stock`, кабинет, `scripts/backoffice-setup.mjs --designation`.
Оба флага читает `backofficeOptions(process.env)` (`packages/backoffice-core/src/stops.ts`), как
прежние `BACKOFFICE_*`. Runbook: `docs/operations/backoffice-cutover.md`.

## 1. Права роли API (`infra/staging/provision.mjs`)

Сразу после `backofficeGrants(...)` (helper сбрасывает только `bo_role_designations` и до 074 ничего
не делает):

```diff
 import { backofficeGrants } from './backoffice-grants.mjs';
+import { backofficeCutoverGrants } from './backoffice-cutover-grants.mjs';
 ...
       await client.query(backofficeGrants('pickchick_app', config.backofficeEnabled === true));
+      // Cutover CC-5: the API reads role designations (cloud074) only with the flag.
+      await client.query(
+        backofficeCutoverGrants('pickchick_app', {
+          backoffice: config.backofficeEnabled === true,
+          roles: process.env.BACKOFFICE_ROLES_ENABLED === 'true',
+        }),
+      );
```

Склад v2 новых прав не требует: `bo_stock_documents.reason_code/meta` покрыты табличными `SELECT,
INSERT` из `backofficeGrants`. Проверка точного набора - `assertBackofficeCutoverPrivileges(client,
role, {backoffice, roles, stockV2})`. Без права чтения назначений API работает: назначения не
действуют (`capabilities.roles=false`), то есть права только сужаются.

## 2. Флаги в окружении (`infra/staging/compose.yaml`, `.env.example`)

В `api` и `provision` рядом с `BACKOFFICE_REMOTE_STOPS_ENABLED`:

```diff
       BACKOFFICE_REMOTE_STOPS_ENABLED: ${BACKOFFICE_REMOTE_STOPS_ENABLED:-false}
+      BACKOFFICE_ROLES_ENABLED: ${BACKOFFICE_ROLES_ENABLED:-false}
+      BACKOFFICE_STOCK_V2_ENABLED: ${BACKOFFICE_STOCK_V2_ENABLED:-false}
```

`.env.example` после `BACKOFFICE_RECONCILIATION_ENABLED=false`:

```diff
+# Cutover CC-5: shift manager / accountant designations over analyst grants (cloud074 and
+# backofficeCutoverGrants on the API role). scripts/backoffice-setup.mjs --designation.
+BACKOFFICE_ROLES_ENABLED=false
+# Cutover CC-6: waste reason codes, receipt supplier and invoice date, GET .../ops/stock (cloud074).
+BACKOFFICE_STOCK_V2_ENABLED=false
```

Если тест релиза сверяет полный список переменных compose (`tests/operations/test_*release*.py`),
добавить туда же.

## 3. OpenAPI (`scripts/contracts.mjs`)

`BackofficeRequest` (новые необязательные `reason_code`, `meta` у команды `stock`) уже регенерирован
в этой ветке (`chore: regenerate openapi`). Маршрута `GET /v1/admin/backoffice/branches/{branchId}/ops/stock`
в `openapi.json` нет: у полосы cloud нет точки вставки в `scripts/contracts.mjs` (§4.2). Предлагаемый
блок сразу после `Object.assign(openapi.paths, {...})` с путями бэк-офиса (`boOperation` уже
добавляет параметр `branchId`):

```js
// cutover:cloud begin
const boStockReport = boOperation('readBackofficeStockReport', 'BackofficeResult');
boStockReport.parameters.push(
  {
    name: 'view',
    in: 'query',
    required: true,
    schema: { type: 'string', enum: ['waste', 'movement'] },
  },
  { name: 'start_date', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
  { name: 'end_date', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
);
openapi.paths['/v1/admin/backoffice/branches/{branchId}/ops/stock'] = { get: boStockReport };
// cutover:cloud end
```

затем `pnpm contracts:generate`. Ответ 404 с `error.code=STOCK_V2_DISABLED`, пока флаг выключен.

## 4. Миграция 074 на стенде

Применяется так же, как 073: `migrate` в `provision.mjs` (или owner-шаг по runbook, как
`stage2-cloud-owner.mjs`) после 073, затем гранты п. 1. Миграция аддитивна: новый рантайм работает
на 073 (проверено тестом `new runtime on a cloud schema without 074`), прежний рантайм - на 074.

## 5. Порядок §6.2 шаг 5

`BACKOFFICE_ROLES_ENABLED=true` + назначения (`backoffice-setup.mjs --designation`),
`BACKOFFICE_STOCK_V2_ENABLED=true`. Оба переключаются независимо и откатываются флагом.
