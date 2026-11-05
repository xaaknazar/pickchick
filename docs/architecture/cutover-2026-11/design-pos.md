# Дизайн: POS SALES (касса) к переходу 19.11.2026

База: `origin/codex/shared-development` 1a9472f1 (05.11.2026), только чтение. Ничего не реализовано.
Миграции обозначены `edge-NEXT` / `cloud-NEXT` (после edge 025 и cloud 072); номера назначает lead.
Все пути относительно корня репозитория. UNCONFIRMED - не подтверждено кодом/документами.

## 1. Текущее состояние

**Режим и заказ.** Касса работает в `unpaid_service` (ADR-0010). Режим точки хранится в `branch_config.pos_service_mode` с CHECK `payment_required|unpaid_service` (`db/edge/migrations/012_edge_pos_unpaid_fulfillment.sql:3-4`). `createLocalOrder` либо создаёт unpaid-заказ и в той же транзакции делает допуск на кухню, либо `payment_required`-заказ, который навсегда остаётся `awaiting_payment` (`packages/local-orders/src/orders.ts:295-341`; `next_action='payment_not_available'`, `:204`). Автомат заказа зашит в БД: `state IN ('awaiting_payment','cancelled')`, `payment_state='not_started'`, `fiscal_state='not_requested'`, переход только `awaiting_payment→cancelled` (`db/edge/migrations/004_edge_local_orders.sql:67-95`). Контракты те же: `QuoteSchema.channel` = literal `'pos'`, `discount_minor` = literal `'0'` (`packages/contracts/src/index.ts:421,425`), `LocalOrderSchema.payment_state` = literal (`:458`). Отмена кассиром возможна только пока все кухонные задания `queued` (`orders.ts:384`, `packages/edge-fulfillment/src/local-pos.ts:146-151`).

**Допуск на кухню.** `localUnpaidExecution.admit` требует режим `unpaid_service` (`local-pos.ts:21-23`), пишет `channel:'pos'` и `serviceMode` только `dine_in|takeaway` (`:38-39`; enum в `packages/edge-fulfillment/src/model.ts:118`, сама схема `.passthrough()` `:113-137`), номер 1-299 (`:77-79`). CHECK `fulfillment_admission_origin` пускает для `edge_pos` только `admission_kind='unpaid_service'` (`db/edge/migrations/017_edge_kiosk_prepaid.sql:3-10`). Эпоха нумерации - последняя открытая смена любого терминала (`db/edge/migrations/022_edge_display_numbers.sql:37-40`).

**Смена.** Есть кассовая смена на терминал: разменный фонд, внесение/изъятие (только менеджер, `db/edge/migrations/014_pos_workspace.sql:68`), закрытие с пересчётом и расхождением, замороженный `closed_report` (`packages/local-orders/src/shifts.ts:93-172`, `:224-284`). Отчёт жёстко говорит `cash_received_minor:'0'`, `payment_processing_available:false` (`shifts.ts:36-38`, `contracts/src/index.ts:555-557`). Открытие и закрытие - право `manage` = только `shift_manager` (`packages/local-orders/src/staff.ts:150-156`). Роли: `cashier|shift_manager|kitchen` (`004_edge_local_orders.sql:7`).

**UI кассы.** Работает v2 (`apps/pos/src/index.html` → `v2/app.js`). Экраны оплаты уже нарисованы (плитки «Наличные», «Kaspi терминал», «Смешанная», «Без выручки» с причинами и PIN, `apps/pos/src/v2/reference-view.js:434-470,541`). Но все бизнес-обработчики подменены на `unavailable` (`apps/pos/src/v2/app.js:81-82,400-419,551`), CTA «ПЕРЕДАТЬ БЕЗ ОПЛАТЫ» (`:552`). Менеджерское подтверждение сейчас - отдельный PIN-вход с заменой сессии кассира, только для закрытия смены (`app.js:191-206`). Клиент строго парсит заказ и смену и отвергнет любые оплаты (`apps/pos/src/types.ts:559-561,616-618`). Журнал неотправленной команды знает 7 видов, остальное считает `STORAGE_DAMAGED` (`apps/pos/src/model.ts:18-24,232-293`).

**Печать и ящик.** В POS и pos-desktop печати нет. Main даёт renderer только журнал и окно (`apps/pos-desktop/main.mjs:81-124`, `preload.cjs:26-47`). Единственный ESC/POS код - фотопринтер киоска: TCP 9100, одна запись, потерянный результат = `unknown` без авто-перепечати (`tools/photo-printer/transport.mjs:9-29`). Модели принтера и ящика неизвестны (КД6).

**Сеть.** POS-desktop ходит только на `http://127.0.0.1:<edgePort>` (`apps/pos-desktop/protocol.mjs:44,302-303`; README:68). LAN-шлюз кухни пускает только кухонные маршруты и явно не пропускает кассовые/платёжные (`infra/windows/kitchen-lan-gateway.mjs:14-53`, `infra/windows/kitchen-lan.md:3-8`). Кухня уже умеет закреплённый TLS к удалённому edge (`apps/kitchen/server.mjs:46`, `apps/kitchen-desktop/security.mjs:36-90`). Device access (020) знает только `prep|assembly|display` (`db/edge/migrations/020_terminal_access.sql:34`).

**Облако.** POS-заказы уходят тремя потоками, все строгие:

- `order_commercial`: `order.created|cancelled`, `payment_state:'not_started'`, `execution_mode:'unpaid_service'?` (`packages/pos-order-sync/src/model.ts:21-34`, CHECK в `db/cloud/migrations/016_cloud_pos_order_sync.sql:56-65`, `018_pos_kitchen_sync.sql:6`);
- кухонные наблюдения: допускаются только при коммерческой проекции с `execution_mode='unpaid_service'` (`018_pos_kitchen_sync.sql:36,56`, `packages/pos-order-sync/src/kitchen-cloud.ts:77,179`, `kitchen-model.ts:36`, `packages/edge-fulfillment/src/records.ts:56`);
- cashier reports: смена с инвариантом `opening+in-out=expected` и заказ с `state awaiting_payment|cancelled` (`packages/fulfillment-transport/src/cashier-reports.ts:10-77,115-131`). Edge-триггер считает expected только по движениям (`db/edge/migrations/016_edge_cashier_reports.sql:14-27`).

Денег нет нигде. Сверка прямо помечает `cash` и `kaspi_pos` как «PickChick не записывает» (`packages/backoffice-core/src/reconciliation-model.ts:28-44`). Есть готовый образец согласования возможностей: облако отвечает `cashierReportsSupported` (`packages/fulfillment-transport/src/model.ts:114-115`, `cloud.ts:234-289`, `worker.ts:504-532`).

**Kaspi/фискал.** QR и счета Kaspi работают только для облачных заказов через неофициальный мост с одной сессией кассира (ADR-0012; `packages/commerce-core/src/kiosk-kaspi-qr.ts:249`). У Smart POS есть официальная LAN-документация: одна операция за раз, целые тенге, processId/опрос/восстановление (`docs/operations/iiko-web-audit-2026-09-23.md:61-76`). В iiko 9 типов оплат: наличные, kaspi ailillu, Kaspi вручную, ChocoFood, Glovo, Яндекс, питание сотрудников, KaspiSmartPos, маркетинг (`:22`). Ручные возвраты облачных заказов уже есть за флагом `BACKOFFICE_MANUAL_REFUNDS_ENABLED` (`packages/backoffice-core/src/stops.ts:41`, `packages/commerce-core/src/repository.ts:1519`).

## 2. Целевое поведение по кодам трекера

| Код                | Поведение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| КС1                | Новый режим точки `pos_sale`: заказ сразу оплачен и в одной транзакции PG передан на кухню. Способы: `cash` (со сдачей), `kaspi_terminal` (карта/QR/NFC на терминале Kaspi, кассир отмечает), смешанная (наличные + терминал), `aggregator_yandex`/`aggregator_glovo`, `staff_meal`, `marketing`. Типы iiko: kaspi ailillu - не переносим (И7); ChocoFood - не переносим, если нет решения владельца; «Kaspi вручную» - резерв `kaspi_manual`, выключен до объяснения владельца. Kaspi QR через облачный мост на кассе - P2: нужен WAN, новый облачный API для заказа с владельцем edge, и он делит единственную сессию кассира с приложением и киоском. QR к 19.11 делается на самом терминале Kaspi. |
| КС2                | Ожидаемые наличные = фонд + внесения - изъятия + наличные продажи (за вычетом сдачи) - наличные возвраты. X-отчёт - снимок без изменения состояния. Z-отчёт PickChick (не фискальный) замораживается при закрытии. При закрытии вводятся пересчёт и итог терминала Kaspi за смену. Расхождение требует причины и PIN менеджера.                                                                                                                                                                                                                                                                                                                                                                        |
| КС3, А12           | «Отмена» (void, пока кухня не начала) и «Возврат» (частичный/полный, привязан к исходным оплатам) - только с одноразовым подтверждением PIN начальника смены. Каждый void/refund создаёт фискальную запись `refund`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| КС4                | Нефискальный «Чек заказа», X/Z, слип возврата и внесения/изъятия печатает main-процесс pos-desktop на принтер своей кассы. Ящик открывается при наличной оплате.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| КС5                | Канал продажи `hall                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | yandex_eda | glovo`. Для агрегатора обязателен номер заказа (уникален для канала), цены канала, способ только «оплачено агрегатором». На кухню уходит как доставка. |
| КС6                | Сейчас - ручная отметка (`confirmation='cashier_attested'`). Шов `PaymentTerminalPort` + `attempt_id` для будущего адаптера.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| КС7                | Скидки-пресеты за отдельным флагом, пустой список по умолчанию (P1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| КС8                | Без выбора «в зале/с собой» дальше не пустит. Обязательный экран «Повторите заказ гостю». На чеке крупно номер и место получения.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Ч3 / Ч2            | Каждая продажа/возврат получает `pos_fiscal_receipts` в режиме `manual_webkassa`; номер чека Webkassa вводится вручную; неоформленные чеки блокируют закрытие смены без PIN менеджера. `FiscalPort` - интерфейс для будущего адаптера, без вызовов Webkassa.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| У3 / У5            | Продажи, оплаты, возвраты, фискальные номера и Z-отчёты уходят в облако новым durable-потоком `posSales` (edge владелец, облако только проекция). В сверке `cash` и `kaspi_pos` становятся «записываемыми». Ручные возвраты облачных заказов (У3) - существующий флаг, его включение не входит в эту lane.                                                                                                                                                                                                                                                                                                                                                                                             |
| КД7/КД12 (смежное) | Несколько касс на своих моноблоках ходят к edge на 192.168.2.69 через LAN-шлюз с POS-профилем и закреплённым TLS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 3. Данные и миграции

### 3.1 edge-NEXT `pos_sales` (одна миграция, только добавления)

Изменение старых CHECK - через DO-блок с поиском по `pg_get_constraintdef`, как в `014_pos_workspace.sql:79-83` и `022:16-21`.

- `branch_config.pos_service_mode`: добавить `'pos_sale'`.
- `local_orders`: `execution_mode` + `'pos_sale'`; `state` + `'paid'`; `payment_state IN ('not_started','captured')`; CHECK `(execution_mode='pos_sale') = (payment_state='captured')`; `state='paid' ⇒ execution_mode='pos_sale'`; CHECK причины: `paid ⇒ cancellation_reason IS NULL`. Заменить `guard_local_order_update` (`004_edge_local_orders.sql:78-93`): INSERT `paid` только для `pos_sale`, UPDATE `awaiting_payment|paid → cancelled`, version+1, `payment_state` неизменен. Для старых строк поведение байт-в-байт прежнее. Частичные возвраты строку заказа **не меняют**: версии остаются 1/2, совместимо с облачным инвариантом `db/cloud/migrations/016_cloud_pos_order_sync.sql:65`. `fiscal_state` в строке остаётся `not_requested`, фискал живёт в отдельной таблице.
- `guard_local_execution_mode` (`012_edge_pos_unpaid_fulfillment.sql:29-40`): `pos_sale` только при `pos_service_mode='pos_sale' AND ordering_enabled`. `guard_local_execution_admission` (`012:46-57`, deferred): для `pos_sale` нужны резервирование `admission_kind='pos_sale'` **и** строка `pos_sales` с Σ оплат = `total_minor`.
- `fulfillment_admission_origin` (`017_edge_kiosk_prepaid.sql:4-10`): добавить ветку `edge_pos`/`pos_sale` с теми же условиями, что и у unpaid.
- `local_cash_shifts.sales_mode boolean NOT NULL DEFAULT false`, ставится при открытии в режиме `pos_sale` и потом неизменен (добавить в ROW-сравнение `guard_local_cash_shift`, `010_edge_cash_shifts.sql:36-38`).
- Новые таблицы (append-only, триггер неизменяемости, FK на `(id,branch_id)`):
  - `pos_payment_methods(branch_id, code, enabled=false, fiscal_policy, requires_approval, allow_in_mix, reference_required)`. Запись делает только оператор, runtime имеет лишь SELECT, как у `local_pos_service_setup` (012:59-73). Seed: все выключены.
  - `pos_sales(order_id PK, branch_id, quote_id, execution_mode CHECK='pos_sale', shift_id, terminal_id, cashier_staff_id, sales_channel, external_order_ref, revenue_kind, total_minor, cash_tendered_minor, change_minor, beneficiary, reason_code, comment, approval_id, review_confirmed_at, created_at)`. FK `(order_id,branch_id,quote_id,execution_mode)` → `local_order_execution_identity` (012:7-8). `UNIQUE(branch_id,sales_channel,external_order_ref) WHERE external_order_ref IS NOT NULL` - защита от двойного ввода заказа агрегатора.
  - `pos_sale_tenders(id, order_id, branch_id, method, amount_minor>0, confirmation, reference, attempt_id NULL, created_at)`.
  - `pos_refunds(id, order_id, branch_id, kind void|refund, shift_id, terminal_id, staff_id, approved_by_staff_id NOT NULL, approval_id NOT NULL, amount_minor>0, reason_code, reason, lines jsonb, created_at)` и `pos_refund_tenders(refund_id, tender_id, method, amount_minor>0, reference)`. Триггер проверяет: Σ по исходной оплате ≤ её сумме, Σ по заказу ≤ total, наличный возврат - только из открытой `sales_mode`-смены и не больше ожидаемых наличных.
  - `pos_fiscal_receipts(id, branch_id, order_id, refund_id NULL, kind sale|refund, mode 'manual_webkassa', state, receipt_number NULL, version, recorded_by_staff_id, recorded_at, amount_minor)`. Меняются только `state`/`receipt_number`/`version`/`recorded_*`. Уникальность номера в БД не ставим: формат и нумерация Webkassa UNCONFIRMED, дубль даёт предупреждение в приложении.
  - `local_manager_approvals(id, branch_id, terminal_id, manager_staff_id, action, subject_hash, token_hash, expires_at, consumed_at, consumed_command_key)`. Одноразовое, TTL 120 с.
  - `pos_sale_outbox(event_id, sequence bigserial, branch_id, kind sale|refund|fiscal|shift_report, entity_id, payload, acknowledged_at, attempts, last_error)`. Неизменяемая идентичность, как в `016_edge_cashier_reports.sql:55-62`.
- Функция `pos_shift_cash(shift_id) → (cash_sales_minor, cash_refunds_minor)`. Ею пользуются `drawer()` и новая версия `append_cashier_shift_report`. Для `sales_mode` в payload добавляются два ключа и expected с продажами. Для остальных смен payload байт-в-байт прежний.
- Обязательные сопутствующие правки: гранты runtime и fulfillment-worker (`infra/windows/edge-runtime-grants.mjs`, `fulfillment-worker-grants.mjs`), SHA-256 в allowlist копий (`infra/windows/native-edge-backup-ledger.json`), upgrade-скрипт по образцу `*-upgrade-db.mjs`.

### 3.2 cloud-NEXT `pos_sales_sync`

- Расширить enum'ы старых проекций: `pos_order_sync_projection.execution_mode IN ('unpaid_service','pos_sale')` (cloud `018_pos_kitchen_sync.sql:6`), `payment_state IN ('not_started','captured')`, `state/version`: `(1, awaiting_payment|paid)` / `(2, cancelled)` (cloud `016_cloud_pos_order_sync.sql:56-65`); `pos_kitchen_sync_projection.execution_mode` (`018:36`) и guard (`018:56`).
- Новые: `cloud_pos_sale_inbox(event_id PK, branch_id, device_id, sequence, payload_hash, UNIQUE(device_id,sequence))`; проекции `cloud_pos_sales`, `cloud_pos_tenders`, `cloud_pos_refunds`, `cloud_pos_refund_tenders`, `cloud_pos_fiscal_receipts`, `cloud_pos_shift_reports`. Облако их не меняет, кроме применения более нового sequence от того же устройства. Гранты: receiver - INSERT/UPDATE, backoffice/бухгалтер - SELECT.
- P1: добавить методы сверки `yandex_eda|glovo` в CHECK `bo_rec_lines`/`bo_rec_totals` (`071_cloud_daily_reconciliation.sql:67,90`).

## 4. API и контракты

Все edge-маршруты: `/edge/v1/*`, сессия сотрудника, POST с `Idempotency-Key` через `command()`. Результат хранится в `local_command_results` (`packages/local-orders/src/commands.ts:24-57`), повтор с тем же ключом не тратит подтверждение повторно.

| Метод/путь                                                                | Тело → ответ                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET pos/config`                                                          | `{mode, methods[], channels[{code,enabled,prices_available}], fiscal_mode:'manual_webkassa', discounts[]}`. 404 на старом edge → клиент остаётся в unpaid-UI.                                                                                                            |
| `POST checkout/quotes`                                                    | `CartSchema` + опц. `sales_channel` (нет поля = `hall`, старые quote байт-в-байт прежние). Quote + опц. `sales_channel`.                                                                                                                                                 |
| `POST pos/sales`                                                          | `{quote_id, service_mode_confirmed:true, order_repeated:true, external_order_ref?, tenders:[{method,amount_minor,reference?}], cash_tendered_minor?, beneficiary?, reason_code?, comment?, approval?:{approval_id,token}, fiscal_receipt_number?}` → `201 {order, sale}` |
| `GET pos/sales/{orderId}`                                                 | `PosSale` (оплаты, возвраты, фискальные записи, `display_number`, `pickup`)                                                                                                                                                                                              |
| `POST pos/sales/{orderId}/void`                                           | `{expected_version, reason_code, reason, approval}` - через `execution.cancel`, только пока кухня не начала (`ORDER_IN_PRODUCTION`, иначе - возврат)                                                                                                                     |
| `POST pos/sales/{orderId}/refunds`                                        | `{refund_id, amount_minor, lines?, tenders:[{tender_id,amount_minor,reference?}], reason_code, reason, approval}`                                                                                                                                                        |
| `POST staff/approvals`                                                    | `{pin, terminal_id, action, subject}` → `{approval_id, token, expires_at, manager}`. Backoff тот же, что у `staff/pin` (`services/edge/src/staff-auth-controller.ts:56-96`).                                                                                             |
| `GET pos/fiscal-receipts/pending`, `POST pos/fiscal-receipts/{id}/record` | `{expected_version, receipt_number, approval?}` (исправление уже записанного номера - только с approval `fiscal_correct`)                                                                                                                                                |
| `GET cash-shifts/{id}/x-report`, `GET cash-shifts/{id}/z-report`          | `ShiftReport`                                                                                                                                                                                                                                                            |
| `POST cash-shifts/{id}/close`                                             | Плюс опц. `terminal_reported_minor`, `approval`. В `sales_mode` закрытие с неоформленными чеками требует approval.                                                                                                                                                       |
| `POST orders` в режиме `pos_sale`                                         | `409 SERVICE_MODE_DISABLED`                                                                                                                                                                                                                                              |

**Enum'ы** (новый `packages/contracts/src/pos-sales.ts`): `PosPaymentMethod = cash|kaspi_terminal|aggregator_yandex|aggregator_glovo|staff_meal|marketing|kaspi_manual|card_terminal(резерв)|kaspi_qr_cloud(резерв P2)`; `PaymentConfirmation = drawer|cashier_attested|aggregator_attested|manager_approved|terminal_adapter|cloud_adapter`; `SalesChannel = hall|yandex_eda|glovo`; `RevenueKind = revenue|staff_meal|marketing`; `RefundReason = guest_changed_mind|wrong_order|quality|aggregator_cancelled|cashier_error|other`; `FiscalReceiptState = pending|recorded|not_required|decision_pending` (резерв `issuing|issued|failed|unknown`); `ApprovalAction = void|refund|staff_meal|marketing|discount|fiscal_correct|shift_close_pending_fiscal`. `LocalOrder`: `state` + `paid`, `payment_state` + `captured|partially_refunded|refunded` (вычисляется), `fiscal_state` + `manual_pending|manual_recorded|not_required` (вычисляется), `execution_mode` + `pos_sale`, `next_action` + `record_fiscal_receipt`, опц. `sale`. `CashShift`: литералы `'0'`/`false` (`index.ts:555-557`) превращаются в money/boolean, но для не-`sales_mode` смен значения прежние.

**Правила оплат (edge, одна транзакция).** Σ tenders = `quote.total_minor`. Не больше одной наличной части; `cash_tendered_minor ≥` наличной части, сдача = разница и только из наличных. Агрегаторный канал ⇔ ровно один tender `aggregator_*` своего канала и обязательный `external_order_ref`. `staff_meal`/`marketing` - единственная часть, approval нужного действия. `kaspi_terminal` - сумма кратна 100 тиын (терминал принимает целые тенге, iiko-audit:68-70), иначе `TERMINAL_AMOUNT_NOT_WHOLE`. Метод должен быть `enabled`. Approval: роль `shift_manager`, тот же терминал, не истёк, не использован, `subject_hash = hashJson({action, quote_id|order_id, amount_minor})` совпадает. Ошибки: `TENDER_SUM_MISMATCH`, `CASH_TENDERED_TOO_LOW`, `METHOD_DISABLED`, `APPROVAL_REQUIRED`, `APPROVAL_INVALID`, `EXTERNAL_REF_DUPLICATE`, `REFUND_LIMIT`, `DRAWER_INSUFFICIENT`, `FISCAL_PENDING`, `TERMINAL_AMOUNT_NOT_WHOLE`, `CHANNEL_PRICES_UNAVAILABLE`.

**Кухня.** `local-pos.ts` превращается в `localPosExecution(kind)`. Для `pos_sale` в snapshot добавляются `salesChannel` и `externalOrderRef` (passthrough-безопасно, model.ts:113-137); `serviceMode` для агрегатора = `takeaway`, enum не меняется. Маршрут на монитор 2 и экран выдачи доставки делает KDS lane. `records.ts:56` берёт `executionMode` из `admission_kind`.

**Потоки edge→cloud.**

1. `order_commercial`: для `pos_sale` - `order.created` (`state:'paid'`, `payment_state:'captured'`, `execution_mode:'pos_sale'`) и `order.cancelled` при void. Это нужно, чтобы кухонные наблюдения нашли коммерческую проекцию (cloud `018_pos_kitchen_sync.sql:56`).
2. cashier reports: заказ `paid`/`cancelled`, смена с опц. `cash_sales_minor`, `cash_refunds_minor` и инвариантом `opening+in-out+sales-refunds=expected`.
3. Новый `posSales[]` в pull-запросе fulfillment-transport с ответом `posSaleReceipt`. Edge шлёт только после ответа облака `posSalesSupported:true`, по образцу `cashierReportsSupported`. Облако сверяет арифметику, дедуплицирует по `event_id` и `(device,sequence)`, ACK только после COMMIT.

**Швы.** `PaymentTerminalPort {start(attempt), status(processId), cancel}` с очередью по терминалу и состоянием `unknown` без повторного списания. В P0 это только интерфейс и `attempt_id` NULL. `FiscalPort {issueSale, issueRefund, openShift, closeShift}`: в P0 реализация `manual` ничего не вызывает, адаптер Webkassa появится после Ч1.

## 5. UI (`apps/pos/src/v2`, тексты RU, только дефис)

1. **Заказ.** Переключатель «Зал / Яндекс Еда / Glovo» (только при включённых методах). Для агрегатора поле «Номер заказа Яндекс Еды/Glovo*», тип показывается как «Доставка». Кнопки «В зале» / «С собой» без значения по умолчанию; CTA неактивна: «Выберите: в зале или с собой».
2. **«Повторите заказ гостю».** Крупный список позиций с модификаторами, тип, итог. Кнопки «Изменить» и «Гость подтвердил - к оплате».
3. **Оплата.** Плитки «Наличные», «Kaspi терминал», «Смешанная»; для агрегатора одна плитка «Оплачено агрегатором». В «Без выручки»: «Питание сотрудника», «Маркетинг» (PIN начальника смены). Плитку «Карта терминал» скрыть, причину «Брак» убрать (это списание, Ск5).
   - Наличные: «Внесено гостем», быстрые 5 000/10 000/20 000, крупно «Сдача: 1 500 ₸», CTA «Принять 3 500 ₸ · сдача 1 500 ₸».
   - Терминал: «1. Введите на терминале Kaspi 3 500 ₸. 2. Дождитесь «Оплата прошла». 3. Номер чека терминала (необязательно)». CTA «Оплата на терминале прошла», вторичная «Терминал отклонил».
   - Смешанная: части, «Остаток»; кнопка недоступна, пока остаток не 0.
   - Агрегатор: «Заказ оплачен в Glovo №GL-1234 - деньги придут от агрегатора».
4. **Готово.** «Заказ №27 · Забрать на выдаче» / «Выдача доставки · Яндекс №…», «Сдача 1 500 ₸». Поле «Номер чека Webkassa» с кнопками «Сохранить» / «Позже». «Печать чека заказа», «Новый заказ».
5. **Заказ в истории.** «Отменить заказ» (пока кухня не начала) или «Возврат» → причина, сумма/позиции, по какой оплате вернуть, PIN начальника смены. Для терминала: «Проведите возврат на терминале Kaspi, затем подтвердите».
6. **Чеки Webkassa (вкладка).** «Не оформлено: 3»; строки «№27 · 12:41 · 3 400 ₸ · Наличные» с полем номера. В строке статуса: «Чеки: вручную в Webkassa · не оформлено: 3».
7. **Смена.** «X-отчёт» (экран и печать). Мастер закрытия: пересчёт наличных → «Итог терминала Kaspi за смену» → неоформленные чеки (если есть - PIN) → расхождение с причиной → «Z-отчёт PickChick (не фискальный)» → «Не забудьте закрыть смену в Webkassa».
8. **Связь.** Красный статус: «Нет связи с сервером кассы. Новые заказы не принимаются - сообщите менеджеру». Неотправленная команда остаётся в журнале и повторяется тем же ключом.

## 6. Изменения по файлам

- `db/edge/migrations/<edge-NEXT>_pos_sales.sql`, `db/cloud/migrations/<cloud-NEXT>_pos_sales_sync.sql` - §3.
- `packages/contracts/src/index.ts` (Cart/Quote `sales_channel`, LocalOrder, CashShift, OrderingState mode), новый `pos-sales.ts`; `scripts/contracts.mjs` - новые маршруты в OpenAPI.
- `packages/local-orders/src/`: новые `sales.ts` (createSale), `refunds.ts` (void/refund), `approvals.ts`, `fiscal-receipts.ts` (manual + `FiscalPort`), `payment-methods.ts`, `reports.ts` (X/Z); `orders.ts` (loadOrder/orderEvent для `pos_sale`, блок `POST orders`), `shifts.ts` (drawer, close, sales_mode), `pricing.ts` (канал, хук скидок), `errors.ts`, `index.ts`.
- `packages/edge-fulfillment/src/local-pos.ts` (kind + snapshot), `records.ts:56`.
- `services/edge/src/pos-sales-controller.ts` (новый), `index.ts` (регистрация), `staff-auth-controller.ts` (`approvals`).
- `packages/fulfillment-transport/src/cashier-reports.ts`, `model.ts`, `cloud.ts`, `worker.ts`, новый `pos-sales.ts` (pending/ack/receive).
- `packages/pos-order-sync/src/model.ts`, `kitchen-model.ts`, `kitchen-cloud.ts:77,179`.
- `packages/backoffice-core/src/`: новый `pos-sales.ts` (дни, методы, каналы, Z, CSV), `reconciliation.ts` (POS-факты при читаемой таблице и флаге), `reconciliation-model.ts` (`recorded` из конфигурации); `services/api/src/backoffice-controller.ts`; `apps/backoffice` - раздел «Продажи кассы».
- `apps/pos/src/model.ts` (Pending: `sale|void|refund|fiscal_record`, close с 3-5 ключами), `types.ts`, `api.ts`; `v2/app.js`, `v2/template.html`, `v2/reference-view.js` (§5).
- `apps/pos-desktop/protocol.mjs` (allowlist новых путей; `edgeHost`+`edgeCertificatePem` по образцу `apps/kitchen/server.mjs:46`, https с закреплённым сертификатом, без отката на HTTP), новый `printer.mjs` (`windows-driver`: скрытое окно и `webContents.print({silent,deviceName})`; `escpos-tcp`: ESC/POS и импульс ящика `ESC p`), `main.mjs`/`preload.cjs` (`pickchickPosPrinter.print(ticket)`: только типизированный JSON, HTML собирает main), `resources/config.example.json`, `README.md`.
- `infra/windows`: гранты, backup ledger, `pos-sales-upgrade-db.mjs`; `scripts/pos-sales-setup.mjs` (оператор: включить режим и методы; предусловия: нет открытых смен, облако объявило `posSalesSupported`). Профиль POS в LAN-шлюзе делает LAN lane.
- Документы: новый ADR-0015 «POS-продажи и ручной фискальный порядок», `docs/operations/pos-sales.md` (runbook), `docs/project-status.md`, `docs/roadmap/project.json`.

## 7. Флаги и безопасный выпуск

Все по умолчанию выключены; merge и deploy ничего не меняют:

- edge: `pos_service_mode='pos_sale'` (только скрипт оператора) и `pos_payment_methods.enabled` (все false). Скидки (P1) - пустой `pos_discount_presets`.
- pos-desktop: нет `edgeHost` → loopback как сейчас; нет `printer` → «Печать не настроена».
- cloud: `POS_SALES_SYNC_ENABLED` (принимать `posSales` и объявлять поддержку), `BACKOFFICE_POS_SALES_ENABLED`, `REC_POS_FACTS_ENABLED`.

Совместимость. Новый POS на edge 020-025 получает 404 на `pos/config` и работает как сейчас. Старый POS на новом edge работает, пока режим не `pos_sale`. Поэтому все кассы обновляются **до** включения режима.

Порядок:

1. CI зелёный, флаги выключены.
2. cloud-NEXT в серверном окне после 069-072. Smoke старых потоков, затем `POS_SALES_SYNC_ENABLED=true`.
3. edge-NEXT вместе с 025 в окне С4 (ночь на 15.11) или отдельной ночью. Smoke: unpaid-заказ → кухня → облако без изменений.
4. LAN-профиль POS и установка на кассовые моноблоки (КД12).
5. Т7 16-17.11: оператор включает `pos_sale` и методы, проводится пробная смена, Т8 - сверка.
6. 19.11 - боевое включение.

Откат. Вернуть `unpaid_service` (только без открытых `sales_mode`-смен); данные остаются, миграции аддитивны. Откат бинарника POS - только после пустого журнала: старый клиент не знает новых видов Pending.

## 8. Тесты

Новые:

- `tests/integration/pos-sales.test.mjs`: наличные со сдачей, смешанная, агрегатор и дубль номера, питание/маркетинг без approval и с ним, void до/после старта кухни, частичный возврат и лимит, наличный возврат больше ящика, повтор с тем же ключом, тот же ключ с другим телом → CONFLICT, approval просрочен/чужой терминал/не то действие/повторно, X/Z и expected, закрытие с неоформленными чеками, режим выключен → `SERVICE_MODE_DISABLED`, две кассы параллельно (номера, блокировка точки).
- `tests/integration/pos-sales-upgrade.test.mjs`: 025 + старые строки → NEXT, старые cashier reports байт-в-байт, unpaid без изменений.
- fulfillment-transport: `posSales` только при поддержке облака, ACK/hash, отказ при неверной арифметике.
- pos-order-sync: `kitchen-upgrade` с `pos_sale`.
- `tests/pos-desktop/protocol.test.mjs`: новые пути, закреплённый TLS, нет HTTP fallback; `printer.test.mjs`: байты ESC/POS, `unknown` без авто-перепечати.
- `tests/pos/cashier-ui.test.mjs`, `browser.test.mjs`: КС8, оплаты, approvals, журнал.
- `packages/backoffice-core/tests/reconciliation-unit.test.mjs`: POS-факты.
- offline-stand: продажа без WAN и догоняющая синхронизация.

Прогнать существующие: `pnpm check`, `pnpm test:integration` (особенно `pos-unpaid-kitchen`, `cash-shifts`, `cash-shift-upgrade`, `edge-runtime-grants`, `edge-migration-order`, `windows-edge-backup`, `stage2-cross-lane`), `pnpm test:pos`, `test:fulfillment`, `test:fulfillment-transport`, `test:pos-order-sync`, `test:backoffice`, `test:kitchen`, `node --test tests/pos-desktop/*.test.mjs`, `tests/operations/windows-cashier-reports-upgrade.test.mjs`.

## 9. Зависимости и общие файлы

- **KDS/LAN lane:** POS-профиль шлюза (порт, IP касс, allowlist = `protocol.mjs`, привязка IP → `terminal_id` для `staff/pin|approvals`); маршрутизация по `salesChannel`; эпоха номеров при нескольких кассах; печать бегунка на выдаче (КД8); поведение кухни при void.
- **Каталог (Аг4):** цены каналов в edge-меню. Формат не определён (UNCONFIRMED); без них агрегатор → `CHANNEL_PRICES_UNAVAILABLE`.
- **Склад (Ск2/Ск5):** списание по `cloud_pos_sales.lines`; возврат после производства - списание с причиной.
- **Финансы/бэк-офис (У4/У5):** представления и сверка.
- **Фискал (Ч1/Ч2):** адаптер за `FiscalPort`.
- **Infra/deploy:** окна, гранты, копии.

Общие файлы: `packages/contracts/src/index.ts`, обе миграции, `packages/edge-fulfillment/src/local-pos.ts`, `records.ts`, `packages/fulfillment-transport/src/*`, `packages/pos-order-sync/src/*`, `infra/windows/*grants*.mjs`, `native-edge-backup-ledger.json`, `scripts/contracts.mjs`, `docs/project-status.md`, `docs/roadmap/project.json`. Перед изменениями - claim через `scripts/project-sync.mjs`.

## 10. Приоритеты

**P0 (к 19.11):**

- P0-1 ядро продаж edge (КС1, КС5, КС6-ручной);
- P0-2 деньги смены, X/Z, итог терминала (КС2);
- P0-3 подтверждение менеджера, void/refund (А12, КС3);
- P0-4 ручные номера Webkassa и шов `FiscalPort` (Ч3, Ч2-seam);
- P0-5 UI кассы (КС1-КС3, КС5, КС8, Ч3);
- P0-6 POS-desktop по LAN (КД7/КД12);
- P0-7 печать чека заказа и ящик (КС4, КС8);
- P0-8 синхронизация в облако (У3/У5 данные);
- P0-9 минимальный раздел бэк-офиса «Продажи кассы», Z, CSV (У4/У5);
- P0-10 infra/runbook/upgrade-тесты.

**P1:** скидки (КС7, после И8); POS-факты в сверке; методы `yandex_eda`/`glovo` в сверке; режим `pos` в device access; пречек; внесение/изъятие кассиром с approval.

**P2:** адаптер Kaspi Smart POS (КС6, после теста устройства); Webkassa (Ч2); Kaspi QR через облако на кассе; API агрегаторов (Аг7/8); автопроводки ДДС/ОПиУ; допродажи (КС9).

## 11. Оценка P0 (инженеро-дни)

| P0        | дни                  |
| --------- | -------------------- |
| P0-1      | 2.5                  |
| P0-2      | 1.0                  |
| P0-3      | 1.5                  |
| P0-4      | 0.75                 |
| P0-5      | 2.5                  |
| P0-6      | 1.0                  |
| P0-7      | 1.0 (+ оборудование) |
| P0-8      | 1.5                  |
| P0-9      | 1.0                  |
| P0-10     | 1.0                  |
| **Итого** | **≈13.75**           |

Это примерно 5 рабочих дней на троих. Code freeze - 12.11, иначе Т7 не успевает.

## 12. Риски и вопросы владельцу

**Риски.**

1. cloud-NEXT обязан быть установлен раньше включения режима, иначе кухонные наблюдения и отчёты в облако встанут. Локальная кухня при этом работает, очередь копится.
2. Ручная отметка терминала и агрегатора - подтверждение со слов кассира. Это осознанное решение владельца (КС6), которое противоречит общему правилу AGENTS.md о доверенном адаптере; нужно ADR-0015. Контроль - итог терминала в Z и ежедневная сверка.
3. Ручной Webkassa в пик отстаёт от продаж: юридический риск (Р2). Закрытие смены блокируется.
4. Сервер 192.168.2.69 - единая точка отказа для всех касс (UPS К2, памятка).
5. Эпоха номеров сбрасывается при открытии смены на второй кассе (`022_edge_display_numbers.sql:37-40`).
6. Окно С4 перегружено (072+025+NEXT).
7. Цены каналов (Аг4) не готовы.

**Вопросы.**

1. Сколько касс и какие моноблоки; модель и подключение принтера (USB/LAN), ящик через принтер? Есть ли дисплей покупателя, Halyk-терминал (КД6, И6)?
2. Что такое «Kaspi вручную»; оставляем ли ChocoFood?
3. Питание сотрудников: кто, по какой цене, лимит, нужен ли PIN?
4. Причины «Маркетинга».
5. Webkassa вручную: кто пробивает, сразу или пачкой, на каком устройстве, какой номер записывать; чеки для агрегаторов и 0 ₸ (Ч3, Ч4, Р2).
6. Возвраты: наличными из ящика? В какие сроки?
7. Если цен каналов нет - разрешить цены зала?
8. Чек заказа в одном или двух экземплярах (гостю и на поднос)?
9. Кто открывает смену; стандартный фонд; Z по каждой кассе.
10. Пробная смена Т7: реальные деньги идут в PickChick или в iiko, как не задвоить?
11. Подтвердить сервер на 192.168.2.69 (Р19).
12. Устраивает ли QR на терминале Kaspi вместо QR на экране кассы до P2?
