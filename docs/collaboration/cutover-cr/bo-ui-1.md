# CR bo-ui-1: миграция 075, права и флаги P1 бэк-офиса вне файлов полосы bo-ui

Полоса: bo-ui (шаг 1). Кому: integration. Основание: решение владельца 05.11 (экраны P1 бэк-офиса
делаются сейчас, за флагами, которые по умолчанию выключены) и дополнение контракта для полосы.
Интерфейсы §5 контракта не меняются: всё новое - дополнительные ключи `capabilities` и новые виды
`ops/<view>` и команд по правилам §5.10. Подробный дизайн: `docs/architecture/cutover-2026-11/design-bo-ui.md`.

Что сделано в `codex/cutover-bo-ui`:

- `db/cloud/migrations/075_cloud_backoffice_ops.sql` - только добавляет, совместима в обе стороны;
- `infra/staging/backoffice-p1-grants.mjs` - права роли API на таблицы 075 по флагам и проверка точного
  набора;
- флаги в `packages/platform/src/config.ts`, ключи `capabilities` в `GET branches/:id`.

Тесты: `packages/backoffice-core/tests/p1-schema.test.mjs`, `p1-grants.test.mjs` (оба в
`test:integration` пакета), `tests/integration/backoffice-p1-flags.test.mjs`.

## 0. Имя файла миграции (отклонение от дополнения)

В дополнении указано `075_cloud_backoffice_p1.sql`. С таким именем файл никогда не применится:
`migrate()` (`packages/database/src/index.ts`) берёт только `^\d{3}_[a-z_]+\.sql$`, а после префикса
цифры запрещены (контракт R11). Файл назван `075_cloud_backoffice_ops.sql` (имя `bo_ops_cutover`
из `design-backoffice.md` §3). Тест `075 is applied by migrate()` проверяет имя.

SHA-256 на коммите `78bf7607`: `8ea645bb311e786ba3818d78f29518dec9ca70996266f3f4027b06682127190d`.
До установки на стенд (окно Cloud-2) файл может только дополняться, если тест докажет пробел;
окончательный хеш полоса сообщит в отчёте к RC-cloud-2. После установки файл не меняется никогда.

## 1. Права роли API (`infra/staging/provision.mjs`) - одна строка вызова в самом конце

Helper сбрасывает права только на шесть таблиц 075 и **добавляет** чтение таблиц 073
(`cloud_pos_*` для «Кассы») и каталога (`catalog_menu_deliveries`, `catalog_publications` для
автосписания), сброс которых делают другие helper-ы. Поэтому вызов идёт последним в транзакции прав:
после `manualRefundGrants`, после `cloudPosSalesGrants` (CR `cloud-2`) и после
`backofficeCutoverGrants` (CR `cloud-3`, `cloud-4`). До 075 он ничего не делает (`to_regclass`).

```diff
 import { manualRefundGrants } from './manual-refund-grants.mjs';
+import { assertBackofficeP1Privileges, backofficeP1Grants } from './backoffice-p1-grants.mjs';
 ...
       await client.query(
         manualRefundGrants(
           'pickchick_app',
           config.backofficeEnabled === true &&
             process.env.BACKOFFICE_MANUAL_REFUNDS_ENABLED === 'true',
         ),
       );
       if (config.testOrderFlowEnabled)
         await client.query('GRANT INSERT ON bo_records TO pickchick_app');
+      // Cutover bo-ui (cloud075): last; resets the 075 relations and adds reads that other helpers reset.
+      const p1 = {
+        backoffice: config.backofficeEnabled === true,
+        posDay: config.backofficePosDayEnabled === true,
+        stockV2: process.env.BACKOFFICE_STOCK_V2_ENABLED === 'true',
+        autoconsume: config.backofficeStockAutoconsumeEnabled === true,
+        managerShifts: config.backofficeManagerShiftsEnabled === true,
+        discounts: config.backofficeDiscountsEnabled === true,
+      };
+      await client.query(backofficeP1Grants('pickchick_app', p1));
+      await assertBackofficeP1Privileges(client, 'pickchick_app', p1);
```

`loadConfig('api')` в начале `provision.mjs` уже проверяет флаги (только API, нужен
`BACKOFFICE_ENABLED`, автосписание только вместе с `BACKOFFICE_STOCK_V2_ENABLED`). Без вызова API не
падает: функции, которым нужны таблицы 075, получают `capabilities.<ключ>=false`.

Почему так безопасно для точных проверок других полос: чтение `cloud_pos_*` совпадает с набором
`cloudPosSalesGrants(role, {backoffice: true})` полосы pos (тест `least privilege` в
`p1-grants.test.mjs` вызывает `assertCloudPosSalesPrivileges` после helper-а). DELETE и TRUNCATE не
выдаются нигде, историю скидок пишет триггер владельца (`SECURITY DEFINER`), роль API её не пишет.

## 2. Флаги в окружении (`infra/staging/compose.yaml`, `.env.example`)

В `api` и `provision` рядом с флагами CR `cloud-3` и `cloud-4`:

```diff
       BACKOFFICE_SALES_REPORT_ENABLED: ${BACKOFFICE_SALES_REPORT_ENABLED:-false}
+      BACKOFFICE_POS_DAY_ENABLED: ${BACKOFFICE_POS_DAY_ENABLED:-false}
+      BACKOFFICE_STOCK_AUTOCONSUME_ENABLED: ${BACKOFFICE_STOCK_AUTOCONSUME_ENABLED:-false}
+      BACKOFFICE_MANAGER_SHIFTS_ENABLED: ${BACKOFFICE_MANAGER_SHIFTS_ENABLED:-false}
+      BACKOFFICE_STAFF_POSITIONS_ENABLED: ${BACKOFFICE_STAFF_POSITIONS_ENABLED:-false}
+      BACKOFFICE_DISCOUNTS_ENABLED: ${BACKOFFICE_DISCOUNTS_ENABLED:-false}
```

`.env.example`:

```diff
+# Cutover bo-ui (owner decision 05.11, cloud075): back-office P1 screens, all off by default.
+# «Касса» (GET .../ops/pos-day) and the new «Главная».
+BACKOFFICE_POS_DAY_ENABLED=false
+# Stock consumption by sales: the worker and bo_stock_settings; needs BACKOFFICE_STOCK_V2_ENABLED.
+BACKOFFICE_STOCK_AUTOCONSUME_ENABLED=false
+# Manager shift checklists (bo_manager_shifts).
+BACKOFFICE_MANAGER_SHIFTS_ENABLED=false
+# Positions, extra stations, POS access and the cashier roster export.
+BACKOFFICE_STAFF_POSITIONS_ENABLED=false
+# Discount editor only; the POS does not apply discounts yet and nothing goes to the edge.
+BACKOFFICE_DISCOUNTS_ENABLED=false
```

Если тест релиза сверяет полный список переменных compose (`tests/operations/test_*release*.py`),
добавить туда же.

## 3. Порядок миграций и фикстуры

- Порядок облака: 072 → 073 → 074 → **075**. `provision.mjs` применяет весь каталог, поэтому 075
  встаёт сразу после 074 тем же шагом. Новый рантайм работает на 074 без 075 (тест на схеме без 075
  в `p1-grants.test.mjs`), прежний рантайм облачной полосы - на 075 (тест `upgrade from 074 with data`
  и все наборы полосы cloud на полной схеме).
- Если интеграция делает охраняемый owner-шаг для облачных миграций перехода (по образцу
  `infra/staging/stage2-cloud-owner.mjs` с закреплёнными SHA-256), добавить `075_cloud_backoffice_ops.sql`
  с хешем из п. 0 сразу после 074, в тот же шаг.
- Фикстуры со списками облачных миграций: в `tests/operations` и `tests/integration` списков 072+
  сейчас нет; если интеграция их добавит (например, `cutover-*` или проверка ledger на стенде), 075
  идёт последней.
- Три теста облачной полосы закрепляли точный список, который применяет `migrate()` после схемы без
  073/074 (`packages/backoffice-core/tests/roles.test.mjs`, `sales-report.test.mjs`,
  `stock-v2.test.mjs`), и с 075 падали. Коммит полосы bo-ui `526fd1c7` заменяет список на
  `migrationsFrom(<первый>)`: все файлы каталога от ожидаемого, и он первый. При слиянии cloud → bo-ui
  берётся версия bo-ui этих трёх мест (если облачная полоса после 43806cf4 меняла эти тесты - объединить
  вручную). Следующая облачная миграция (076+) их больше не ломает.

## 4. Порядок установки (контракт §6.2, §3.1, §2.4, §6.1)

- §3.1: строка `db/cloud/migrations/075_cloud_backoffice_ops.sql` | bo-ui | владелец облака по runbook,
  гранты `infra/staging/backoffice-p1-grants.mjs`. Резерв «cloud 075+» из §3.1 этим занят; следующий
  номер облака - 076.
- §6.2 шаг 8 (ночь 17→18.11, Cloud-2): копия БД и проверка восстановления → **075** → гранты
  (`provision.mjs`, п. 1) → API с выключенными флагами P1 → smoke прежних разделов кабинета
  (`GET branches/:id` без новых ключей). Включение флагов P1 - отдельными шагами runbook
  `docs/operations/backoffice-p1-cutover.md` (появится в следующих шагах полосы), не в окне.
- §2.4 и §6.1: решение владельца 05.11 возвращает флаги `BACKOFFICE_STOCK_AUTOCONSUME_ENABLED` и
  `BACKOFFICE_MANAGER_SHIFTS_ENABLED` (в §2.4 они в списке «сняты») и добавляет
  `BACKOFFICE_POS_DAY_ENABLED`, `BACKOFFICE_STAFF_POSITIONS_ENABLED`, `BACKOFFICE_DISCOUNTS_ENABLED`:
  env API, по умолчанию `false`, владелец bo-ui, откат - `false`.

## 5. Что придёт следующими CR полосы

- блоки маршрутов `ops/*` и новых команд для `scripts/contracts.mjs` (как CR `cloud-3` §3);
- запуск воркера автосписания (`services/api/src/stock-consumption-worker.ts`, `--once`) в compose
  или systemd на стенде;
- строки runbook в мастер-runbook ДП1/ДП3.
