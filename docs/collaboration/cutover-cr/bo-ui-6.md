# CR bo-ui-6: смена менеджера, должности и состав кассы (шаг 6 полосы bo-ui)

Полоса: bo-ui (шаг 6). Кому: integration и полоса pos (§3). Основание: дополнение контракта для
полосы bo-ui (`BACKOFFICE_MANAGER_SHIFTS_ENABLED`, `BACKOFFICE_STAFF_POSITIONS_ENABLED`, скрипты
`staff-roster-apply.mjs` и `staff-pin-batch.mjs`), `design-bo-ui.md` §3, §4, §5.6, §5.7,
`design-backoffice.md` §2 А8, А10, А11, Д3. Код - только пути полосы: `db/cloud/migrations/075_*`
(дополнение), `packages/backoffice-core/**`, `apps/backoffice/**`, `infra/staging/backoffice-p1-grants.mjs`,
`infra/public-staging/gateway.Caddyfile` (регулярка), `scripts/staff-roster-apply.mjs`,
`scripts/staff-pin-batch.mjs`, `tests/backoffice/**`, `tests/integration/backoffice-p1-*.test.mjs`.
`openapi.json` не менялся: виды идут через общий `GET .../ops/:view`, команды - через общий
`POST .../commands`. Runbook: `docs/operations/backoffice-p1-cutover.md`, разделы «Смена менеджера»
и «Должности и состав кассы».

## 1. Вызов helper P1 в `provision.mjs` - ключ `staffPositions`

К вызову из CR `bo-ui-1` §1 добавить один ключ (необязательный: без него `false`, вызов `bo-ui-1`
остаётся рабочим, но список должностей точки не редактируется):

```diff
       const p1 = {
         backoffice: config.backofficeEnabled === true,
         posDay: config.backofficePosDayEnabled === true,
         stockV2: process.env.BACKOFFICE_STOCK_V2_ENABLED === 'true',
         autoconsume: config.backofficeStockAutoconsumeEnabled === true,
         managerShifts: config.backofficeManagerShiftsEnabled === true,
+        staffPositions: config.backofficeStaffPositionsEnabled === true,
         discounts: config.backofficeDiscountsEnabled === true,
       };
```

Новое право: `SELECT, INSERT` на `bo_branch_templates` при `managerShifts` или `staffPositions` (без
UPDATE и DELETE: версии только добавляются, триггер 075 отказывает в изменении).
`assertBackofficeP1Privileges` проверяет и его. `capabilities.manager_shifts` теперь требует и это
право (без него `false`, смены менеджера не работают).

## 2. Миграция 075 дополнена разделом 8 (до заморозки 10.11)

Тест шага 6 доказал пробел: редактируемый управляющим чек-лист с версиями и редактируемый список
должностей (задача шага) негде хранить - в 075 шаблоны были только кодом. Добавлено в конец файла,
прежние операторы не менялись:

- `bo_branch_templates(branch_id, kind manager_shift|staff_positions, version >= 2, body jsonb,
created_by, created_at, PK(branch_id, kind, version))`, только добавление (`commerce_immutable`);
  версия 1 - встроенные чек-лист и 11 должностей в коде;
- триггер `bo_manager_shifts_template`: смена с `template_version > 1` ссылается на существующую версию.

SHA-256 файла после шага 6: `c3c192ceafd149a9bd9151e3954f4b8d182b6c1886ee627d1a8651c61cc8f786`
(в CR `bo-ui-1` - хеш шага 1). Файл никуда не устанавливался; базы тестов создаются заново.

## 3. Полоса pos: восстановить отозванную учётную запись кассы (операторская функция)

`staff-roster-apply.mjs` пользуется только `provisionStaff` и `revokeStaff`. `provisionStaff` отказывает
(`CONFLICT`), если запись с этим id есть, но `active=false`; функции восстановления нет. Номер на кассе
детерминирован (`edgeStaffId(сотрудник, роль)`), поэтому сотрудник, у которого доступ однажды
отозвали (уволен и вернулся, снят с кассы и снова кассир), больше не может получить запись с тем же
номером. Скрипт показывает такой случай как `blocked: revoked_earlier` и ничего не делает.

Просьба (не к 19.11, если не успевает): операторская функция `reactivateStaff(pool, branchId, staffId)`
в `packages/local-orders/src/staff.ts` - `active=true` и аудит `staff.reactivated`, без смены роли,
имени и PIN; старые сессии остаются отозванными. После неё скрипт заменит `blocked` на действие
`reactivate`. Также нет функции смены имени (`name_differs` в плане только сообщается).

## 4. Решения полосы - подтвердить

1. **Право `manager_shifts.template`** (только управляющий) для версии чек-листа - в таблице §4
   дизайна его не было; открытие и закрытие - `manager_shifts.write` (управляющий и начальник смены).
2. **Список должностей редактируемый** (версии `staff_positions` в `bo_branch_templates`), право
   `staff.positions`. Должность не удаляется (`POSITION_IN_USE`), только выключается.
3. **Поля должности при выключенном флаге не стираются**: сохранение карточки без полей их
   сохраняет; прежний редактор, отправивший их без изменений, не получает отказа. На данных облачной
   полосы (без этих полей) поведение байт в байт прежнее (тест `staff-positions`).
4. **Журнал `bo_records` kind `shift`**: при доступной смене менеджера он только для чтения
   (`NOT_READY/LEGACY_JOURNAL_READ_ONLY`) и читается отдельно, последние 200 записей
   (`limits.shift_records`, `truncated.shift_records`), остальные записи - прежний `LIMIT 2000`. Без
   флага запрос прежний.
5. **Новые причины ошибок** (только при флагах): `MANAGER_SHIFT_OPEN`, `CHECKLIST_INCOMPLETE`,
   `HANDOVER_REQUIRED`, `LEGACY_JOURNAL_READ_ONLY`, `POSITION_UNKNOWN`, `POSITION_IN_USE`.

## 5. Заметки к слиянию

- `tests/integration/backoffice-p1-flags.test.mjs` знает ключи шага 6 (`without()`); строки во всех
  таблицах 075, включая `bo_branch_templates`, при выключенных флагах не видны.
- `packages/backoffice-core/tests/stock-p1.test.mjs` перечисляет все права P1 (теперь восемь).
- `tests/backoffice/audit-fixes-ui.test.mjs` перечисляет коды аудита (добавлены пять кодов шага 6).
- `consumption.test.mjs`: тест прохода закрытия дня зависел от времени суток (падал между 00:00 и
  03:00 Алматы); исправлен в шаге 6 (fbfba6a7).
