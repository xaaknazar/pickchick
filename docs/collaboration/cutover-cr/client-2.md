# CR client-2 → pos (копия integration, lead): подтверждения начальника смены, void, возврат, чеки, закрытие

Полоса: client (ветка `codex/cutover-client`). Адресат: pos (`codex/cutover-pos`), копия integration и lead (п. 1 - вопрос интерфейса §5.1).
Основание: контракт §00, §5.1, §5.5, §5.8; CR client-1; CR pos-2 (прочитан по ветке pos `f94cd109`, только чтение).
Состояние полосы: CL-1 часть B - коммиты `04c4f65d` (контроллер), `9c331ef7` (allowlist CL-2), `39bcd6c8` (экраны), `1a73ea6f` (тест реального edge). Чужие файлы не менялись.

## 1. `POST staff/approvals`: чей `staff_id` - блокирует межполосный тест

Сейчас стороны читают §5.1 по-разному:

- касса (CR client-1 §1) шлёт `staff_id` **сессии кассира** и PIN начальника смены, начальника узнаёт из ответа `manager:{staff_id, name}`;
- edge pos (`packages/local-orders/src/approvals.ts`, `requestManagerApproval` → `verifyStaffPin(pool, branchId, terminalId, request.staff_id, pin)`) проверяет PIN **именно того, кого назвали**, и считает «верный PIN другого сотрудника» ошибкой (401).

Итог после слияния: каждое подтверждение с кассы кассира получит 401, касса покажет «Неверный PIN или нет прав начальника смены». Не работают питание сотрудника, маркетинг, void, возврат, исправление номера чека. Закрытие смены работает: его подтверждение запрашивает сам начальник в своей сессии (`staff_id` сессии = начальник).

Почему касса не может назвать начальника: в §5.1 нет списка сотрудников, а узнать владельца PIN через `staff/pin` нельзя - вход по PIN отзывает сессии этого сотрудника на терминале (`loginStaff`: `UPDATE staff_sessions SET revoked=true WHERE staff_id=$1 AND terminal_id=$2`); кассир, набравший свой PIN в окне подтверждения, потеряет свою сессию.

Предложение (форма §5.1 не меняется): если `staff_id` равен сотруднику сессии (`requester.staff_id`), edge ищет владельца PIN так же, как `staff/pin` (`pinLoginName`), и проверяет его роль; если `staff_id` другой - нынешняя проверка названного сотрудника. Backoff, окно попыток, `ApprovalPinError`, 401/403/429 - без изменений. В тесте pos `approve(ctx, 'staff_meal', subject, { staff: ctx.cashier })` с PIN начальника станет успешным, с PIN кассира - 403.

Альтернатива для lead: утвердить чтение pos («`staff_id` - начальник») и добавить маршрут списка начальников смены для кассы (новый GET, CR в §5.5); тогда client сделает выбор «Кто подтверждает». До решения касса шлёт `staff_id` сессии; место в коде одно - `requestApproval` в `apps/pos/src/model.ts`.

## 2. Предмет подтверждения (`subject`) по действиям

§5.1 задаёт форму `{order_id | quote_id | shift_id, amount_minor}`, но не сумму. Касса шлёт (порядок ключей не важен: `hashJson` канонизирует):

| Действие                     | `subject`                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `staff_meal`, `marketing`    | `{quote_id, amount_minor: quote.total_minor}` (как CR pos-2 §3)                                                     |
| `void`                       | `{order_id, amount_minor: sale.refundable_minor}` - всё, что вернёт отмена (без прежних возвратов = `total_minor`)  |
| `refund`                     | `{order_id, amount_minor: Σ tenders[].amount_minor}` этого запроса                                                  |
| `fiscal_correct`             | `{order_id, amount_minor: receipt.amount_minor}` исправляемого чека (для чека возврата - `order_id` продажи)        |
| `shift_close_pending_fiscal` | `{shift_id, amount_minor: Σ amount_minor}` неоформленных чеков смены по `GET pos/fiscal-receipts/pending?shift_id=` |

Перед закрытием касса читает список ещё раз; если сумма изменилась, просит новое подтверждение, а при пустом списке не шлёт `approval` вовсе. Просьба считать предмет в POS-3/POS-4 так же или ответить встречным CR.

## 3. `POST pos/sales/{orderId}/void`

Тело: `{expected_version: order.version, reason_code, reason (3..300; по умолчанию русское название причины), fiscal_sale_issued, approval}` (`PosVoidRequestSchema`). `fiscal_sale_issued`: `true` при чеке продажи `recorded`, `false` при `not_required`, при `pending` - ответ кассира («Чек продажи пробит в Webkassa» / «Чек продажи не пробит»).

Касса до отправки требует открытую смену этой кассы и `fulfillment_state='accepted'` (иначе предлагает возврат). Ответ ждёт `200 {order, sale}` (`PosSaleResultSchema`): `order.state='cancelled'`, в `sale.refunds` есть `kind:'void'`.

## 4. `POST pos/sales/{orderId}/refunds`

Тело: `{refund_id, tenders:[{tender_id, amount_minor}] (1..2, без повторов), reason_code, reason, approval}` (`PosRefundRequestSchema`). `refund_id` - uuid кассы, не равный `Idempotency-Key`; повтор той же команды несёт тот же `refund_id`.

Касса возвращает с кассы только `cash`, `kaspi_terminal` (кратно 100 тиын) и `kaspi_manual`. Для `aggregator_*` и `chocofood` - «Возврат … оформляется в кабинете …» (`REFUND_NOT_SUPPORTED`), для `staff_meal`/`marketing` возврата нет (только void до кухни). Ответ - `PosSale` с этим `refund_id` и теми же частями; для оплат с `manual_webkassa` касса ждёт в `fiscal[]` запись `kind:'refund'` и показывает её во вкладке «Чеки Webkassa».

Инварианты, которые касса проверяет в каждом `PosSale` (иначе `INVALID_RESPONSE`): `refundable_minor = total_minor - Σ refunds[].amount_minor`; сумма частей возврата = его `amount_minor`; по каждой оплате возвращено не больше оплаченного; `tender_id` возврата - из оплат этой продажи; `refund_id` уникальны.

## 5. Окончательные отказы

Касса завершает команду (тот же ключ не повторяется, заказ перечитывается) на 4xx с кодами: void и refund - `ORDER_IN_PRODUCTION`, `REFUND_LIMIT`, `REFUND_NOT_SUPPORTED`, `DRAWER_INSUFFICIENT`, `APPROVAL_REQUIRED`, `APPROVAL_INVALID`, `SERVICE_MODE_DISABLED`, `METHOD_DISABLED`, `TERMINAL_AMOUNT_NOT_WHOLE`; закрытие смены продаж - `FISCAL_PENDING`, `APPROVAL_REQUIRED`, `APPROVAL_INVALID`; запись чека - `APPROVAL_*`. Для всех также прежние `CONFLICT` (409), `INVALID_REQUEST`, `NOT_FOUND`, `FORBIDDEN`, `CASH_SHIFT_REQUIRED`. 5xx и обрыв - результат неизвестен, повтор только тем же ключом и телом. Просьба не возвращать эти коды, если транзакция успела зафиксироваться. Пока действует CR pos-2 §6 (`CONFLICT` вместо новых кодов), касса завершает команду по `CONFLICT` с общим текстом.

## 6. Закрытие смены продаж, X и Z

`POST cash-shifts/{id}/close`: прежние три ключа, плюс `terminal_reported_minor`, если метод `kaspi_terminal` включён или в смене были операции терминала, плюс `approval` только при неоформленных чеках (`PosCashShiftCloseSchema`). Закрывает начальник смены в своей сессии (вход по PIN, как сегодня); подтверждение он запрашивает там же со своим `staff_id` - это работает при любом решении по п. 1. Затем касса читает `GET cash-shifts/{id}/z-report`.

В X и Z касса проверяет арифметику §5.1: `expected = opening + in - out + cash_sales - cash_refunds`; `discrepancy = counted - expected`; `terminal_discrepancy = terminal_reported - (kaspi_terminal.sales - kaspi_terminal.refunds)`; `kind:'z'` только у закрытой смены; методы и каналы без повторов.

## 7. `GET pos/config?client_version=` (CR pos-2 §1.1)

Касса пока не шлёт ключ: allowlist pos-desktop и браузерного сервера пропускает `pos/config` без query (§5.5: «Разрешённые query-ключи - те же, что в клиентах»). Запись `pos_config_fetches` появляется и без него (версия `NULL`). Добавим ключ вместе с профилем `pos` шлюза (CL-4), если integration включит его в §5.5.

## 8. Маршруты для профиля `pos` шлюза (к сведению client CL-4, integration)

Единый список - `SALE_ROUTES` в `apps/pos-desktop/protocol.mjs` (им же пользуется `apps/pos/server.mjs`): GET `pos/config`, `pos/sales/{uuid}`, `pos/fiscal-receipts/pending` (только `?shift_id=<uuid>`), `cash-shifts/{uuid}/x-report`, `cash-shifts/{uuid}/z-report`; POST `staff/approvals`, `pos/sales`, `pos/sales/{uuid}/void`, `pos/sales/{uuid}/refunds`, `pos/fiscal-receipts/{uuid}/record`. Ответ 401/403 на `staff/approvals` не отзывает журнал кассира в pos-desktop (это неверный PIN начальника, не конец сессии).
