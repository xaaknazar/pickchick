# CR bo-ui2-1: миграция 076, права и флаги второй волны бэк-офиса вне файлов полосы bo-ui2

Полоса: bo-ui2 (шаг 1 из 6, схема). Кому: integration. Основание: решение владельца 06.11 (вторая
волна бэк-офиса - поставщики и их цены, заявки, отчёты склада, расстановка - делается сейчас, за
флагами, которые по умолчанию выключены). Интерфейсы §5 контракта не меняются: всё новое -
дополнительные ключи `capabilities` и будущие виды `ops/<view>` и команды по правилам §5.10.
Дизайн: `docs/architecture/cutover-2026-11/design-bo-ui.md`, раздел «Вторая волна».

Что сделано в `codex/cutover-bo-ui2` (от итога bo-ui `aff89ce6`):

- `db/cloud/migrations/076_cloud_backoffice_supply.sql` - только новые таблицы, функции, триггеры и
  индексы; ничего существующего не меняет;
- `infra/staging/backoffice-supply-grants.mjs` - права роли API на таблицы 076 по флагам и проверка
  точного набора;
- флаги в `packages/platform/src/config.ts`, ключи `capabilities` в `GET branches/:id`.

Тесты: `packages/backoffice-core/tests/p2-schema.test.mjs`, `p2-grants.test.mjs` (оба в
`test:integration` пакета), `tests/integration/backoffice-p2-flags.test.mjs`,
`tests/integration/backoffice-p2-golden.test.mjs`.

## 0. Файл миграции

Имя `076_cloud_backoffice_supply.sql` подходит под `^\d{3}_[a-z_]+\.sql$` (`migrate()`, контракт R11);
тест `076 is applied by migrate()` проверяет имя, отсутствие `ALTER`, `DROP`, `GRANT`, ссылок на
`cloud_pos_*` и то, что все индексы и триггеры висят только на новых таблицах.

SHA-256 на коммите `9335343a`: `436131f9854b5f4c024ab1492c2b7857bd14925e2398dc092548dadc25e693a3`.
DDL заморожен 10.11 18:00: до установки файл может только дополняться, если тест докажет пробел;
окончательный хеш полоса сообщит в отчёте последнего шага. После установки файл не меняется никогда.

## 1. Права роли API (`infra/staging/provision.mjs`) - одна строка вызова сразу после helper-а bo-ui

Helper сбрасывает права только на пять таблиц 076 (`REVOKE ALL`, затем выданный набор) и больше ничего
не трогает, поэтому место - сразу после вызова `backofficeP1Grants` (CR `bo-ui-1` §1, ключ
`staffPositions` - CR `bo-ui-6` §1). До 076 он ничего не делает (`to_regclass`).

```diff
 import { assertBackofficeP1Privileges, backofficeP1Grants } from './backoffice-p1-grants.mjs';
+import {
+  assertBackofficeSupplyPrivileges,
+  backofficeSupplyGrants,
+} from './backoffice-supply-grants.mjs';
 ...
       await client.query(backofficeP1Grants('pickchick_app', p1));
       await assertBackofficeP1Privileges(client, 'pickchick_app', p1);
+      // Cutover bo-ui2 (cloud076): resets only the 076 relations, right after the bo-ui helper.
+      const p2 = {
+        backoffice: config.backofficeEnabled === true,
+        supply: config.backofficeSupplyEnabled === true,
+        stockReports: config.backofficeStockReportsEnabled === true,
+        staffAssignment: config.backofficeStaffAssignmentEnabled === true,
+      };
+      await client.query(backofficeSupplyGrants('pickchick_app', p2));
+      await assertBackofficeSupplyPrivileges(client, 'pickchick_app', p2);
```

Набор: при `supply` - `SELECT, INSERT, UPDATE` на `bo_suppliers`, `bo_supplier_prices`,
`bo_supply_requests` и `SELECT, INSERT` на `bo_supplier_price_imports` (применённый импорт не
меняется); при `staffAssignment` - `SELECT, INSERT, UPDATE` на `bo_staff_assignments`; для
`stockReports` ничего (отчёты читают таблицы склада, которые уже даёт `backofficeGrants`). DELETE и
TRUNCATE не выдаются нигде. Тест `least privilege` в `p2-grants.test.mjs` вызывает helper bo-ui, потом
этот, и проверяет обе точные проверки (`assertBackofficeP1Privileges` остаётся верной).

`loadConfig('api')` в начале `provision.mjs` уже проверяет флаги (только API, нужен
`BACKOFFICE_ENABLED`, поставки - вместе с `BACKOFFICE_STOCK_V2_ENABLED`, расстановка - вместе с
`BACKOFFICE_STAFF_POSITIONS_ENABLED`). Без вызова API не падает: ключи `capabilities.supply` и
`capabilities.staff_assignment` будут `false`.

## 2. Флаги в окружении (`infra/staging/compose.yaml`, `.env.example`)

В `api` и `provision` рядом с флагами CR `bo-ui-1` §2:

```diff
       BACKOFFICE_DISCOUNTS_ENABLED: ${BACKOFFICE_DISCOUNTS_ENABLED:-false}
+      BACKOFFICE_SUPPLY_ENABLED: ${BACKOFFICE_SUPPLY_ENABLED:-false}
+      BACKOFFICE_STOCK_REPORTS_ENABLED: ${BACKOFFICE_STOCK_REPORTS_ENABLED:-false}
+      BACKOFFICE_STAFF_ASSIGNMENT_ENABLED: ${BACKOFFICE_STAFF_ASSIGNMENT_ENABLED:-false}
```

`.env.example`:

```diff
+# Cutover bo-ui2 (owner decision 06.11, cloud076): back-office second wave, all off by default.
+# Suppliers, supplier prices and their import, supply requests; needs BACKOFFICE_STOCK_V2_ENABLED.
+BACKOFFICE_SUPPLY_ENABLED=false
+# Stock balances, stock turnover and the order hint.
+BACKOFFICE_STOCK_REPORTS_ENABLED=false
+# Staff at stations; needs BACKOFFICE_STAFF_POSITIONS_ENABLED.
+BACKOFFICE_STAFF_ASSIGNMENT_ENABLED=false
```

Если тест релиза сверяет полный список переменных compose (`tests/operations/test_*release*.py`),
добавить туда же.

## 3. Порядок миграций и фикстуры

- Порядок облака: ... → 074 → 075 → **076**. `provision.mjs` применяет весь каталог, поэтому 076
  встаёт сразу после 075 тем же шагом. Совместимость в обе стороны проверена:
  - прежний рантайм bo-ui на 076: тест `upgrade from 075 with data` (каталог - столбцы, умолчания,
    ограничения, индексы, триггеры, права - и тела функций всех прежних объектов, все строки всех
    таблиц и ответы рантайма bo-ui до и после 076 равны); отдельно сборка `aff89ce6` на схеме с 076
    дала ровно записанный эталон (`backoffice-bo-ui-golden.json`, одноразовая проверка шага 1);
  - новый рантайм на 075: эталон на схеме до 075 (`backoffice-p2-golden.test.mjs`) и ключи
    `capabilities` со всеми флагами второй волны (`supply=false`, `staff_assignment=false`,
    `stock_reports=true`, `p2-grants.test.mjs`).
- Охраняемый owner-шаг облачных миграций перехода (если integration закрепляет SHA-256, по образцу
  `infra/staging/stage2-cloud-owner.mjs`): `076_cloud_backoffice_supply.sql` с хешем из п. 0 сразу
  после 075, в тот же шаг. Фикстуры со списками облачных миграций - 076 последней.
- `packages/backoffice-core/tests/p1-schema.test.mjs` (bo-ui) ждал, что `migrate()` после схемы без
  075 применит ровно 075; с 076 он падал. Коммит `9335343a` заменяет список на `migrationsFrom(075)`
  (тот же приём, что CR `bo-ui-1` §3 для тестов облачной полосы). При слиянии bo-ui → bo-ui2 брать
  версию bo-ui2.

## 4. Порядок установки (контракт §6.2, §3.1, §2.4, §6.1)

- §3.1: строка `db/cloud/migrations/076_cloud_backoffice_supply.sql` | bo-ui2 | владелец облака по
  runbook, гранты `infra/staging/backoffice-supply-grants.mjs`. Следующий номер облака - 077.
- §6.2 шаг 8 (ночь 17→18.11, Cloud-2): копия БД и проверка восстановления → 076 сразу после 075 (если
  075 уже стоит с Cloud-1 по CR `bo-ui-8` §1 - первым шагом миграций окна) → гранты (`provision.mjs`,
  п. 1) → API с выключенными флагами второй волны → smoke прежних разделов (`GET branches/:id` без
  ключей `supply`, `stock_reports`, `staff_assignment`). Включение флагов - отдельными шагами runbook
  `docs/operations/backoffice-supply.md` (появится в следующих шагах полосы), не в окне.
- §2.4 и §6.1: три новых флага env API, по умолчанию `false`, владелец bo-ui2, откат - `false`.

## 5. Файлы вне списка дополнения и что придёт следующими CR

- `tests/integration/fixtures/backoffice-bo-ui-golden.mjs` и `.json` - эталон тождества, рядом с
  эталоном облачной полосы (тот же вопрос, что CR `bo-ui-9` §1); `docs/architecture/cutover-2026-11/
design-bo-ui.md` - раздел «Вторая волна» (схемы ответов будущих видов).
- Имена видов второй волны (`suppliers`, `supply-requests`, `stock-balances`, `stock-turnover`,
  `order-hint`, `staff-assignments`) - в перечень `view` из предложения CR `bo-ui-8` §2 для
  `scripts/contracts.mjs`, когда виды появятся (шаги 2-4). Allowlist прокси и регулярка шлюза - в
  путях полосы, без CR.
- Шаги операторов для `scripts/supplier-prices-import.mjs` и включение флагов - в runbook и CR
  последнего шага.

## 6. Шаг 2 (поставки): что изменилось для integration

- 076 не менялся: хеш из п. 0 прежний.
- Появились виды `ops/suppliers` и `ops/supply-requests` (только при `BACKOFFICE_SUPPLY_ENABLED`) и
  шесть команд `supplier_save`, `supplier_price_save`, `supply_request_save`, `_submit`, `_cancel`,
  `_receive` через существующий `POST .../commands`. Имена двух видов - в перечень `view` из
  предложения CR `bo-ui-8` §2. Новые причины ошибок только в `BackofficeErrorReasonSchema`
  (`SUPPLIER_NAME_TAKEN`, `SUPPLIER_INACTIVE`, `PRICE_UNIT_MISMATCH`, `REQUEST_LOCKED`,
  `REQUEST_INCOMPLETE`); `packages/contracts` и `openapi.json` не менялись.
- Регулярка `backoffice_get` в `infra/public-staging/gateway.Caddyfile` и allowlist
  `apps/backoffice/server.mjs` дополнены двумя видами (пути полосы). Публичный шлюз стенда
  обновляется вместе с выкладкой кабинета, иначе раздел «Закупки» получит 404 от шлюза при
  включённом флаге.
- Ключ `capabilities.supply` теперь `true` только если роль API ещё и пишет столбцы прихода 074
  (`stockV2Writable`); `backofficeGrants` их даёт, действий не нужно.
- `permissions[]` получает `suppliers.write`, `supply.write`, `supply.close` после всех прав P1 и
  только при `capabilities.supply=true` (тест `backoffice-p2-flags.test.mjs` обновлён).
- Runbook: `docs/operations/backoffice-supply.md` (включение, роли, работа, откат).
