# CR pos-1 → integration, cloud (копия kds): подключение 026/073, коды ошибок POS, окружение тестов

Полоса: pos (ветка `codex/cutover-pos`). Адресаты: integration (`codex/cutover-1119`), cloud (`codex/cutover-cloud`), копия kds.
Основание: контракт §3.1-3.3, §4.2, §5.1, §5.6, §5.9.
Состояние полосы: `513985f6` (026, 073, `pos-sales.ts`, `sales-model.ts`, гранты), `d494402b` (тесты).
Облачная полоса берёт `513985f6` целиком через `git cherry-pick` (§4.4).

## 1. integration: edge 026 в инструментах Windows и копиях (§5.9)

Миграция `db/edge/migrations/026_edge_pos_sales.sql`, SHA-256 на `513985f6`:
`9e3ab95a851bae3bb7383e9517d5fcc76f6f0b92bacc98d12f3292309226e8be`.
Хеш окончательный после заморозки DDL 10.11 18:00; при изменении файла полоса pos пришлёт новый.
**Заменён:** 026 изменена по ревью (номер заказа после отмены, чек возврата без чека продажи),
действующий SHA-256 - в [CR pos-5 §2](pos-5.md). Отношения и права ниже не изменились.

Новые отношения (владелец - owner edge, грантов в миграции нет):
`pos_sales_setting_changes` (+ последовательность `pos_sales_setting_changes_change_sequence_seq`), `pos_payment_methods`, `pos_config_fetches`, `local_manager_approvals`, `pos_sales`, `pos_sale_tenders`, `pos_refunds`, `pos_refund_tenders`, `pos_fiscal_receipts`, `pos_shift_reports`, `pos_sale_outbox` (+ `pos_sale_outbox_sequence_seq`), `pos_sale_sync_state`.
Изменения существующих объектов: CHECK `branch_config.pos_service_mode`, CHECK `local_orders` (state, payment_state, execution_mode, причина отмены + три новых), CHECK `fulfillment_reservations.fulfillment_admission_origin`, колонка `local_cash_shifts.sales_mode` (DEFAULT false), функции `guard_local_order_update`, `guard_local_execution_mode`, `guard_local_execution_admission`, `guard_local_cash_shift`, `guard_cash_movement`, `append_cashier_shift_report` (`CREATE OR REPLACE`, для старых строк ответы и payload прежние - тест `pos-sales-upgrade`). Новые триггеры на `branch_config`: `pos_payment_methods_seed` (AFTER INSERT) и `pos_service_mode_change_guard` (BEFORE UPDATE OF pos_service_mode). Существующие строки миграция не меняет; она добавляет 8 строк `pos_payment_methods` (все `enabled=false`) для строки `branch_config`.

Права (`infra/windows/pos-sales-grants.mjs`):

| Отношение                                           | Рантайм edge (HTTP)                                                                                 | POS sync worker                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `pos_payment_methods`                               | `SELECT`                                                                                            | -                                                     |
| `pos_config_fetches`                                | `SELECT, INSERT, UPDATE(staff_id,client_version,last_fetched_at)`                                   | -                                                     |
| `local_manager_approvals`                           | `SELECT, INSERT, UPDATE(consumed_at,consumed_command_key)`                                          | -                                                     |
| `pos_sales`                                         | `SELECT, INSERT`                                                                                    | -                                                     |
| `pos_sale_tenders`                                  | `SELECT, INSERT`                                                                                    | -                                                     |
| `pos_refunds`                                       | `SELECT, INSERT`                                                                                    | -                                                     |
| `pos_refund_tenders`                                | `SELECT, INSERT`                                                                                    | -                                                     |
| `pos_fiscal_receipts`                               | `SELECT, INSERT, UPDATE(state,receipt_number,version,recorded_by_staff_id,recorded_at,approval_id)` | -                                                     |
| `pos_shift_reports`                                 | `SELECT, INSERT`                                                                                    | -                                                     |
| `pos_sale_outbox`                                   | `SELECT, INSERT`                                                                                    | `SELECT, UPDATE(acknowledged_at,attempts,last_error)` |
| `pos_sale_outbox_sequence_seq`                      | `USAGE`                                                                                             | -                                                     |
| `pos_sale_sync_state`                               | -                                                                                                   | `SELECT, INSERT, UPDATE`                              |
| `pos_sales_setting_changes`, его последовательность | - (только owner, `scripts/pos-sales-setup.mjs`)                                                     | -                                                     |

Существующим таблицам новых прав не нужно (табличные `SELECT/INSERT` на `local_cash_shifts`, `local_orders` покрывают `sales_mode`, `state`, `payment_state`). Без грантов 026 нынешний рантайм работает на 026 (проверено реальным LOGIN с одними `applyEdgeRuntimeGrants`).

Экспорт модуля: `MIGRATION`, `POS_SALES_RELATIONS`, `RUNTIME_PRIVILEGES`, `WORKER_PRIVILEGES`, `parsePrivileges`, `posSalesGrantSql(role, privileges, schema, relations)`, `posSalesRuntimeGrants(role, schema)`, `posSalesWorkerGrants(role, schema)` (только GRANT, без REVOKE), `assertPosSalesPrivileges(client, role, privileges, {schema})` (точный набор на всех 14 отношениях 026, PUBLIC учитывается), `posSalesGrantees(client, {schema})` (кто кроме владельца имеет права).

Просьбы:

1. `infra/windows/edge-runtime-grants.mjs`: после сброса прав, если в ledger есть `026_edge_pos_sales.sql` и `to_regclass('pos_sales')` не NULL (как у 016/019/023), выполнить `posSalesRuntimeGrants(role, schema)`; при расхождении ledger и объектов - отказ.
2. `infra/windows/pos-sync-worker-grants.mjs`: к `posSyncWorkerGrants` добавить `posSalesWorkerGrants` при применённой 026 (отправитель - полоса cloud, CC-4).
3. `infra/windows/pos-sales-upgrade-db.mjs` (`inspect|apply`, по образцу `station-plan-upgrade-db.mjs`): ledger ровно `001…025` (`names.slice(0, 26)`, `names[25] === MIGRATION`), все службы edge остановлены (миграция заменяет функции-охранники), применить 026 и строку ledger, выдать права рантайму и воркеру (если роли есть), `assertPosSalesPrivileges` для обоих, `posSalesGrantees` ⊆ {рантайм, воркер}, снимок строк существующих таблиц до и после равен. CHECK-и пересоздаются с проверкой строк (`local_orders`, `fulfillment_reservations`) - секунды на реальных данных.
4. `native-edge-backup-ledger.json` + `EDGE_BACKUP_SCHEMAS.schema026 = 26` и таблицы 026 в `edge-backup-lib.mjs`. Пока этого нет, на ветке pos падает `tests/integration/windows-edge-backup.test.mjs` (4 теста, `UNREVIEWED_SCHEMA`) - это ожидаемо и закрывается только этим пунктом.
5. `infra/staging/provision.mjs`: последним из хелперов POS вызвать `cloudPosSalesGrants('pickchick_app', { receiver: <CLOUD_POS_SALES_SYNC_ENABLED>, backoffice: <BACKOFFICE_ENABLED> })` из `infra/staging/pos-sales-grants.mjs` (сбрасывает только таблицы 073). Проверка: `assertCloudPosSalesPrivileges(client, role, options, schema)`.
6. Для сведения: `tests/integration/stage2-cross-lane.test.mjs:256` ждёт `EdgeMenuFeatureSchema.options === ['combo_stops']`, а D0 добавил `aggregator_prices` - тест красный на D0 без участия pos.

## 2. cloud: коды ошибок POS в `ErrorSchema` (регион cloud в `packages/contracts/src/index.ts`)

Что: фильтр ошибок (`packages/platform/src/http.ts:68-71`) пропускает только коды из `ErrorSchema.shape.code`; остальные превращаются в `CONFLICT`/`INVALID_REQUEST`, и касса не покажет нужный текст (§5.1). Маршруты облака эти коды не отправляют, приложение и киоск их не увидят.

Diff (после `'ORDER_IN_PRODUCTION',` в перечне `ErrorSchema.code`):

```ts
    // Cashier edge pos_sale routes only (contracts 5.1); cloud routes never send them.
    'METHOD_DISABLED',
    'TENDER_SUM_MISMATCH',
    'CASH_TENDERED_TOO_LOW',
    'TERMINAL_AMOUNT_NOT_WHOLE',
    'CHANNEL_PRICE_UNAVAILABLE',
    'EXTERNAL_REF_REQUIRED',
    'EXTERNAL_REF_DUPLICATE',
    'APPROVAL_REQUIRED',
    'APPROVAL_INVALID',
    'REFUND_LIMIT',
    'REFUND_NOT_SUPPORTED',
    'DRAWER_INSUFFICIENT',
    'FISCAL_PENDING',
```

(`SERVICE_MODE_DISABLED` и `ORDER_IN_PRODUCTION` уже есть.) Полный перечень и тексты - `PosErrorCodeSchema`, `posErrorTextRu` в `packages/contracts/src/pos-sales.ts`. Нужно полосе pos к шагу POS-2 (маршруты `pos/*`); до этого pos кодирует против перечня и проверяет коды в тестах сервиса напрямую.

## 3. cloud: что зафиксировано в 073 и `sales-model.ts` для приёмника и отправителя (CC-4, CC-7)

- Таблицы и столбцы - ровно `db/cloud/migrations/073_cloud_pos_sales_sync.sql`. Сверх перечня §3.3 (все необязательные, кроме ключей связей): `cloud_pos_sales` - `cash_tendered_minor`, `change_minor`, `beneficiary`, `reason`, `approval_id`, `received_at`; `cloud_pos_tenders`, `cloud_pos_refunds`, `cloud_pos_fiscal_receipts`, `cloud_pos_refund_tenders` - `branch_id` (FK `branches`), у `cloud_pos_refund_tenders` ещё `order_id` (составные FK на продажу/оплату/возврат, метод возврата = метод оплаты); `cloud_pos_refunds` - `approval_id`, `terminal_id`; `cloud_pos_fiscal_receipts` - `recorded_by_staff_id`. FK на `devices` - составной `(device_id, branch_id)` там, где есть `device_id`.
- Изменяемость (триггеры): `cloud_pos_sales` - только `state` (`paid` → `voided` один раз), `voided_at`, `last_sequence` (строго растёт); `cloud_pos_fiscal_receipts` - только более новая `version`, `recorded` не возвращается в `pending`, `not_required` неизменна; остальные таблицы и `cloud_pos_sale_inbox` - только INSERT.
- Права API-роли: `infra/staging/pos-sales-grants.mjs` (`RUNTIME_PRIVILEGES` приёмника: INSERT/SELECT и UPDATE только перечисленных столбцов; `BACKOFFICE_PRIVILEGES` - SELECT; `WORKER_PRIVILEGES` пуст).
- Старые проекции: `pos_order_sync_projection` принимает `state='paid'`, `payment_state='captured'`, `execution_mode='pos_sale'` (версия 1) и отмену v2; `pos_kitchen_sync_projection` - `execution_mode='pos_sale'`, если коммерческая проекция того же режима. Код `kitchen-cloud.ts:77` / `model.ts` (pos) расширяется в POS-6.
- Wire (`packages/pos-order-sync/src/sales-model.ts`): `POS_SALES_SYNC_PATH`, `PosSaleEventSchema` (+ схемы payload пяти видов), `PosSaleBatchSchema` (`{events: 0..50}`, пустой - проба), `PosSaleBatchResultSchema` (`rejected.code`: `CONFLICT` | `INVALID_EVENT`), `parsePosSaleEvent` (схема, канонические байты, ≤ 96 KiB, инварианты одного события), `parsePosSaleBatch` (одна ветка, уникальные события, строго растущий `sequence`, ≤ 96 KiB тела - под лимит 100 KiB API), `posSalePayloadHash`, `posSaleReceiptFor`. Лимиты возвратов по каждой оплате и по продаже приёмник проверяет по своим строкам.
- Векторы: `packages/pos-order-sync/tests/fixtures/pos-sale-vectors.json` (14 событий всех видов и всех восьми методов, синтетические, с закреплённым `payload_hash`) - их можно подавать в тесты приёмника.

## 4. kds (ответ на CR kds-2)

- §1 сделано в `d494402b`: тест 279 применяет только 001-025.
- §2 принято: в POS-2 касса кладёт в снимок кухни агрегатора `delivery: {provider: 'yandex_eda'|'glovo', externalNumber}`, где `externalNumber` = `pos_sales.external_order_ref` (в БД CHECK `^[A-Z0-9-]{3,40}$`, верхний регистр); ChocoFood - канал зала, без `delivery`.

## 5. Окружение тестов (для сведения)

Как в CR kds-1 §6: `loadConfig` принимает только базы `/pickchick_edge` и `/pickchick_cloud`, поэтому наборы через `tests/helpers/sync.mjs` не идут на базах полосы `pickchick_*_pos`. Полоса pos гоняла их на собственной паре PostgreSQL 16 только для этой полосы (127.0.0.1:55462/55463, каталог `/tmp/pickchick-pg-pos`, те же синтетические учётные данные, что `.env.example`), чужие базы не трогала. Команды и результаты - в отчёте шага.
