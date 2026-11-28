# CR pos-8 → integration: `terminal_release` в `ManagerApprovalActionSchema`, миграция точки 030, оплаченная на терминале продажа при закрытом приёме

Полоса: pos (ветка `codex/p0-paid-terminal-release`, поверх `codex/p0-edge-paid-terminal-sale` = PR #444).
Адресат: integration (`codex/cutover-1119`) - файл `packages/contracts/src/cutover-enums.ts` принадлежит
интеграции (§2); client (касса, этап 3) - §5.
Основание: решения владельца 28.11.2026 (не обсуждаются), аудит 28.11 P0-1, [ADR-0017](../../architecture/adr/0017-kaspi-smart-pos-adapter.md),
[CR pos-7](pos-7.md) (образец оформления).

## 1. Решения владельца 28.11.2026

1. Если гость оплатил на терминале Kaspi, заказ оформляется (закрытый приём и выключенный способ
   `kaspi_terminal` продажу не отклоняют); что приготовить нельзя - возврат вручную на терминале.
2. Снятие оплаты «без заказа» с кассы и подтверждение ручного возврата делает начальник смены
   тем же PIN, что для отмен и возвратов: «PIN: тот же PIN начальника смены, что для отмен и возвратов.»
   Существующий механизм одобрения (`POST staff/approvals`, `consumeApproval`), новое действие
   `terminal_release`.

## 2. Что нужно от integration (контракт)

`packages/contracts/src/cutover-enums.ts`, `ManagerApprovalActionSchema` - одно новое значение в конец списка:

```diff
   'kds_mode',
   'courier_incident_update',
+  // Edge schema030 (owner decision 28.11.2026, CR pos-8): release of a paid Kaspi attempt without an order.
+  'terminal_release',
 ]);
```

Зачем: таблица `local_manager_approvals` (026) закрепляет список действий CHECK-ом; 030 пересоздаёт его
под прежним именем `local_manager_approvals_action_check` с теми же десятью действиями и
`terminal_release`. Тест `kaspi-pos-release.test.mjs` сверяет список CHECK с этим enum. Без значения в
enum `POST staff/approvals` отклонит действие на разборе запроса (400), хотя база его примет.

Правка уже внесена в рабочую копию pos (файл в списке изменённых этапа 1) - integration переносит её как есть.
Остальные контрактные правки лежат в полосе pos (`pos-sales.ts`, `index.ts`, `scripts/contracts.mjs`,
`openapi.json`); `index.ts` - только строка `TERMINAL_UNSOLD_PAYMENTS` в `ErrorSchema.code`
(без неё фильтр ошибок точки ответил бы голым `CONFLICT`).

## 3. Что сделано (полоса pos)

### 3.1 `db/edge/migrations/030_edge_kaspi_pos_release.sql`

SHA-256 - в `tests/integration/edge-migration-order.test.mjs` (`CUTOVER_EDGE`); после коммита файл не меняется.
Аддитивная, ничего не включает; ставится только после 029.

- CHECK действий одобрения + `terminal_release` (§2).
- Таблица `kaspi_pos_attempt_releases` (только добавление): отдельная таблица, а не новое состояние
  попытки - CHECK-и 029 и `guard_kaspi_pos_attempt` «только вперёд» не тронуты, касса 0.6.3 разбирает
  `state` по закрытому списку и не видит нового значения. В таблице две кассы: `attempt_terminal_id` -
  касса попытки, `terminal_id` и `shift_id` - касса и смена, где начальник смены ввёл PIN (решение
  техлида: сломанная или выведенная из работы касса с оплатой без заказа иначе навсегда держала бы
  свою смену). Триггер `kaspi_pos_attempt_release_guard`: только добавление строк (изменение, удаление
  и очистка таблицы отклоняются); попытка блокируется `FOR UPDATE` и должна быть `success`, без заказа,
  кассы `attempt_terminal_id`, той же суммы, номера операции и кассира; нужна открытая смена продаж
  СНИМАЮЩЕЙ кассы; потреблённое одобрение `terminal_release` снимающей кассы названного начальника
  (`pos_approval_consumed`, как в `pos_refunds`), чей субъект `{quote_id, amount_minor}` равен котировке
  и сумме попытки (сравнение jsonb `subject`, как его записал `requestManagerApproval`).
- Частичный индекс `kaspi_pos_attempts_unsold_idx` (`state='success' AND order_id IS NULL`) под список
  оплаченных без заказа, проверку закрытия смены и снятие.
- Триггер `kaspi_pos_attempt_released_guard` на `kaspi_pos_attempts` (до `UPDATE OF order_id`, только когда
  заказ ставится): снятая попытка не привязывается к заказу (23514). Его функция - единственная с
  `SECURITY DEFINER` (`search_path = pg_catalog, <схема>, pg_temp`, `REVOKE EXECUTE ... FROM PUBLIC`, как
  023 и 025): её выполняет каждая терминальная продажа, и рантайму не нужно право чтения таблицы снятий
  ради неё.
- `guard_local_execution_mode` (до вставки заказа `pos_sale`): при закрытом приёме заказ вставляется, если
  у его котировки есть подтверждённая неиспользованная неснятая попытка той же кассы на всю сумму
  заказа. `pos_service_mode<>'pos_sale'` остаётся отказом.
- `pos_sale_assert_complete` (на COMMIT): тело 026 дословно, кроме проверки способов - в неё добавлена
  проверка `ordering_enabled`, которой в 026 здесь не было (там приём проверялся только при вставке
  заказа). Закрытый приём или выключенный способ не отклоняют продажу, только если часть оплаты ровно
  одна, это `kaspi_terminal` с `attempt_id`, чья попытка `success`, `order_id` = этот заказ, сумма та
  же. Иначе прежние отказы; продажа не терминалом при закрытом приёме отклоняется.
- Таблицы Kaspi читаются только во вложенных ветках (закрытый приём, выключенный способ, привязка заказа
  к попытке); обычная продажа их не читает.
- GRANT в миграции нет: права выдают инструменты точки (этап 2).

### 3.2 Сервер и контракт

- `createPosSale`: `paidOnTerminal` - ровно одна часть `kaspi_terminal` с `attempt_id` на всю сумму котировки;
  при установленной 030 закрытый приём и выключенный способ обходятся, в аудит
  `pos_sale.paid_override|...|checks=` попадают `branch_closed,menu_changed,item_stopped,method_disabled`
  (в этом порядке). На базе без 030 - прежние чистые `BRANCH_UNAVAILABLE` и `METHOD_DISABLED`.
- `POST pos/terminal-payments/{attemptId}/release` (200, `Idempotency-Key`): `{ reason, refunded_on_terminal: true,
approval }`; ответ - попытка (`PosTerminalPaymentSchema`) с `released_at`. Попытка любого кассира и
  ЛЮБОЙ кассы точки (база точки хранит одну точку: `branch_config` - singleton, попытка «другой точки»
  невозможна, незнакомый id - `NOT_FOUND`); не `success`, есть заказ, уже снята -
  `TERMINAL_ATTEMPT_INVALID`; нет открытой смены продаж у СНИМАЮЩЕЙ кассы - `CASH_SHIFT_REQUIRED`; без
  одобрения - `APPROVAL_REQUIRED`; одобрение должно быть введено на снимающей кассе.
- `GET pos/terminal-payments/open?scope=other_desks` (только начальник смены, иначе 403): оплаченные без
  заказа и не снятые попытки ДРУГИХ касс точки - чтобы было что снимать с этой кассы. Без параметра - как
  раньше, свои попытки кассы.
- `GET cash-shifts/{shiftId}/terminal-releases` (no-store): `{ shift_id, count, amount_minor, items }`, права
  как у отчётов смены; снятие попадает в смену снимающей кассы, в строке - `attempt_terminal_id`. `PosShiftReportSchema` и замороженный Z НЕ менялись (Z уходит в облако и разбирается
  той же strictObject-схемой).
- `GET pos/terminal-payments/open`: оплаченные без заказа и не снятые - без срока давности; остальные
  незавершённые - за 24 ч, как раньше.
- Закрытие смены продаж с оплатой без заказа и не снятой СВОЕЙ кассы - 409 `TERMINAL_UNSOLD_PAYMENTS`
  (новый код); оплата другой кассы эту смену не держит.
- Новый код `TERMINAL_UNSOLD_PAYMENTS` в `PosErrorCodeSchema` и `ErrorSchema`; текст: «На кассе есть оплаты на
  терминале без заказа - оформите их или снимите по PIN начальника смены».

## 4. Совместимость

- Касса 0.6.3 с новым сервером: `PosTerminalPaymentSchema` получил последними ключами `staff_id` и
  `released_at`; касса читает ответ по известным ключам (`apps/pos/src/types.ts`, `terminalPayment`), лишние
  терпит; `state` не получил новых значений. Снятая попытка в `/open` не попадает. Закрытие смены с
  неснятой оплатой даст кассе 409 с неизвестным ей кодом - она покажет общую ошибку (текст кода - этап 3).
- Новые ключи в схеме `.nullable().optional()`: ответ старой точки (без ключей) разбирается новой схемой.
- Новый сервер на базе без 030: единственная проверка - строка 030 в `schema_migrations` и таблица
  `kaspi_pos_attempt_releases`; без неё поведение как в PR #444, `release` отвечает 404, `terminal-releases`
  - пустой список, закрытие смены без нового отказа.
- Старый сервер на базе с 030: триггеры не меняют форму ответов; прежний рантайм таблиц снятий не называет.
- Права: триггер привязки заказа к попытке выполняется с правами владельца, поэтому без прав на таблицу
  снятий терминальная продажа проходит. Шлюз `kaspiReleaseInstalled` требует `SELECT` на таблицу снятий:
  без него снятие отвечает 404, список и закрытие смены работают как без 030, закрытый приём и
  выключенный способ - прежними чистыми отказами. Для самого снятия рантайму нужны `SELECT, INSERT`
  (без изменения, удаления и очистки таблицы); их выдаёт инструмент этапа 2.
- Маршруты `release`, `terminal-releases` и запрос `open?scope=other_desks` нужно добавить в профили LAN
  (`infra/windows/lan-route-profiles.mjs`) и протокол оболочки кассы (`apps/pos-desktop/protocol.mjs`) -
  этапы 2 и 3.

### 4.1 Перед выкладкой

1. Миграцию 030 и права на таблицу снятий ставит один инструмент (этап 2), одной операцией.
2. До окна на кассе проверить на точке: `SELECT count(*), sum(amount_minor) FROM kaspi_pos_attempts
WHERE state='success' AND order_id IS NULL`. Старые оплаты без заказа после 030 блокируют закрытие
   смены своей кассы, пока их не оформят или не снимут по PIN начальника смены.
3. Миграция применяется при остановленных службах: она берёт блокировки на `kaspi_pos_attempts`,
   `local_staff`, `local_cash_shifts`, `local_manager_approvals` и пересоздаёт функции, которые вызывает
   каждая продажа.

## 5. client (этап 3)

Кнопка «Снять оплату» у оплаченной без заказа попытки: PIN начальника смены (`staff/approvals`,
действие `terminal_release`, субъект `{ quote_id, amount_minor }` попытки), причина, подтверждение «возврат
сделан на терминале» → `POST .../release`; текст `TERMINAL_UNSOLD_PAYMENTS` из `posErrorTextRu`.
