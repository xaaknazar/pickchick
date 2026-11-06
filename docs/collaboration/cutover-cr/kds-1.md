# CR kds-1 → integration: подключение edge 027 (KDS) к инструментам Windows и копиям

Полоса: kds (ветка `codex/cutover-kds`). Адресат: integration (`codex/cutover-1119`).
Основание: контракт §3.1, §3.2, §5.9, §1.2 (integration: `kds-upgrade-db.mjs`, гранты в `edge-runtime-grants.mjs`, ledger копий, `edge-backup-lib.mjs`).
Состояние полосы: коммиты `e6fe8073` (027, гранты, станции) и `a23728a2` (`kds-switch.mjs`).

## 1. Точные таблицы и права (до 11.11, §5.9)

Миграция: `db/edge/migrations/027_edge_kds_foundation.sql`, SHA-256 на `e6fe8073`:
`41e55b450721646e45be599cf58626fd52328113f5a8165bb8fa5edf1e3a2a97`.
Хеш окончательный только после заморозки DDL 10.11 18:00; при изменении файла полоса kds пришлёт новый.

Новые таблицы (владелец - owner edge, грантов в миграции нет):
`kds_setting_changes`, `kds_layouts`, `kds_settings`, `delivery_handovers`, `courier_incidents`.
Новые функции (триггерные, SECURITY INVOKER): `reject_kds_history_mutation()`, `guard_kds_journal()`, `guard_kds_settings()`.
Последовательностей нет.

Права роли рантайма edge - `infra/windows/kds-grants.mjs`:

| Таблица               | Рантайм          |
| --------------------- | ---------------- |
| `kds_settings`        | `SELECT`         |
| `kds_layouts`         | `SELECT`         |
| `delivery_handovers`  | `SELECT, INSERT` |
| `courier_incidents`   | `SELECT, INSERT` |
| `kds_setting_changes` | нет              |

Воркерам (POS sync, fulfillment, menu-sync) в P0 ничего не нужно (`WORKER_PRIVILEGES` нет; отчёт в облако - P1, 028+).

**Исправлено в CR kds-3:** воркеру fulfillment нужен `SELECT` на `kds_settings` и `kds_layouts` (облачный допуск через `buildKitchenPlan`), см. `docs/collaboration/cutover-cr/kds-3.md`.

Экспорт `kds-grants.mjs`: `MIGRATION`, `KDS_TABLES`, `RUNTIME_PRIVILEGES`, `kdsRuntimeGrantSql(role, schema)` (только GRANT, без REVOKE), `assertKdsRuntimePrivileges(client, role, schema)` (точный набор прав на 5 таблицах, бросает при отличии), `kdsTableGrantees(client, schema)` (кто кроме владельца имеет права на новые таблицы).

## 2. `infra/windows/kds-upgrade-db.mjs` (integration)

Просьба построить по образцу `station-plan-upgrade-db.mjs`:

1. `inspect|apply`, ledger ровно `001…026` (байты файлов), `names[26] === MIGRATION`, отказ при чужом ledger и при уже существующих таблицах KDS.
2. В одной транзакции после применения 027:
   - `kdsRuntimeGrantSql(runtimeRole, schema)`, затем `assertKdsRuntimePrivileges(client, runtimeRole, schema)`;
   - `kdsTableGrantees(client, schema)` должен вернуть ровно `[runtimeRole]`;
   - данные: `provisionKdsStations(client, branchId)` из `@pickchick/edge-fulfillment` (6 станций, права входа `kitchen`, строка `kds_settings` выключена, аудит версии 1). Вернёт `{stations, stationsAdded, kitchenStaffId, grantsAdded, settingsCreated}`; `kitchenStaffId: null` - нет активного входа `kitchen` (тогда `kds-switch enable` откажет, пока его не заведут и не повторят провижининг).
3. Снимок строк, последовательностей и ACL до/после: меняются только `fulfillment_stations` (+6), `fulfillment_station_grants` (+6), новые таблицы KDS.

**Предусловие (важно):** рантайм с исправлением `packages/menu-sync/src/routing.ts` (KDS-2, несколько prep-станций) должен быть установлен до `provisionKdsStations`. Иначе после появления станций 6 и 5 (обе `prep`) публикация меню с новой позицией получит `ROUTING_UNRESOLVED` (`routing.ts:99-101`). Полоса kds сообщит коммит исправления; `inspect` может проверять это по версии рантайма.

## 3. `infra/windows/edge-runtime-grants.mjs` (integration)

`applyEdgeRuntimeGrants` - полный сброс прав. После 027 при `fulfillment: true` добавить, как сделано для 025:

```js
const kds = (
  await client.query(
    `SELECT EXISTS(SELECT 1 FROM ${namespace}.schema_migrations WHERE scope='edge' AND version=$1) AS applied,
     to_regclass($2) IS NOT NULL AS settings`,
    [MIGRATION, `${namespace}.kds_settings`],
  )
).rows[0];
if (kds.applied !== kds.settings) throw new Error('KDS migration objects differ');
if (kds.applied && options.fulfillment) await client.query(kdsRuntimeGrantSql(role, schema));
```

## 4. Копии и пакет Windows

- `infra/windows/native-edge-backup-ledger.json`: запись 027 (хеш выше) после записи 026; `edge-backup-lib.mjs` `EDGE_BACKUP_SCHEMAS`: `schema027: 27`. Сейчас `tests/integration/windows-edge-backup.test.mjs` требует, чтобы закреплённый ledger покрывал все миграции репозитория, и упадёт, пока записи 026/027 нет.
- `scripts/build-windows-edge-runtime.py` `ADMIN_FILES`: добавить `infra/windows/kds-switch.mjs` и `infra/windows/kds-grants.mjs`. `kds-switch.mjs` импортирует `@pickchick/contracts`, `@pickchick/database`, `@pickchick/edge-fulfillment` (есть в пакете рантайма) и `../../scripts/edge-migrate.mjs` (уже в `ADMIN_FILES`).

## 5. Порядок слияния и известные красные тесты ветки kds

- В ветке kds нет 026 (полоса pos), поэтому два корневых unit-теста, требующих сплошной нумерации миграций, красные: `tests/unit/menu-sync-worker-grants.test.mjs` («reviewed migration set contains 018») и `tests/unit/remote-stops-upgrade.test.mjs` («candidate migrations must contain the reviewed 018 and 019»), через `readExpectedMigrations`/`readRemoteStopMigrations` (`name.startsWith(index+1)`). С любым 026 оба зелёные (проверено временным файлом 026). Порядок §8 (pos раньше kds) это закрывает; слияние kds раньше pos оставит их красными.
- `packages/pos-order-sync/tests/restore-upgrade.test.mjs` (полоса pos) ждёт от `migrate()` ровно `['025_edge_kitchen_restore_review.sql']` на полном каталоге - см. CR kds-2.

## 6. Окружение тестов (для сведения)

`loadConfig` (`packages/platform/src/config.ts:68,173`) принимает только `/pickchick_edge` и `/pickchick_cloud`, а `.env` полос указывает на `pickchick_edge_<lane>`. Все наборы, использующие `loadConfig` (`tests/helpers/sync.mjs`, большая часть `tests/integration`), в worktree полосы не запускаются. Новые тесты kds читают `EDGE_DATABASE_URL` сами (локальный хост, имя `pickchick_(edge|test)(_<lane>)?`); `packages/edge-fulfillment/tests/fixture.mjs` принимает те же имена.
