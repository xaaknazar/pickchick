# CR client-1 → pos: уточнения §5.1, на которые опирается касса

Полоса: client (ветка `codex/cutover-client`). Адресат: pos (`codex/cutover-pos`), копия - integration.
Основание: контракт §5.1, §00 п.1, §10 риск 3. Состояние полосы: CL-1 часть A (продажа) - коммиты `bf7c33d5` (контроллер) и `33b091da` (экраны).

Касса закодирована строго по §5.1. Ниже - места, где §5.1 допускает два прочтения; касса выбрала одно. Просьба подтвердить или ответить встречным CR до заморозки edge-кода 12.11. Изменений в чужих файлах полоса client не делала.

## 1. `POST staff/approvals`: чей `staff_id`

Касса шлёт `staff_id` **кассира из сессии**, PIN - начальника смены; начальника касса узнаёт только из ответа `manager:{staff_id, name}` (иначе ответу незачем называть начальника, а у кассы нет списка начальников).

```json
{
  "staff_id": "<staff_id сессии кассира>",
  "pin": "<PIN начальника смены>",
  "action": "staff_meal",
  "subject": { "quote_id": "<uuid>", "amount_minor": "<quote.total_minor>" }
}
```

- `Idempotency-Key` - новый uuid на каждую попытку; команда не пишется в журнал кассы (в журнале не должно быть PIN). Потерянный ответ = неиспользованное подтверждение, которое истечёт.
- Неверный PIN или PIN не начальника смены: касса ждёт 401 или 403 (код любой), показывает «Неверный PIN или нет прав начальника смены» и **не** завершает сессию кассира. Если сессия кассира действительно истекла, касса узнает это следующим обычным запросом. 429 - как у `staff/pin`.
- `token` в ответе: строка `^[A-Za-z0-9._~-]{16,256}$`.
- Перед запросом подтверждения касса берёт свежую квоту, если до её истечения меньше 15 с; подтверждение привязано к `quote_id` и `amount_minor` этой квоты.

## 2. Заказ `pos_sale` в `LocalOrder` (`GET orders`, `GET orders/{id}`, ответ `POST pos/sales`)

Касса принимает: `execution_mode:'pos_sale'`, `state:'paid'|'cancelled'`, `payment_state:'captured'`, `fiscal_state:'not_requested'`, `fulfillment` присутствует, `next_action:'none'`. Другое значение `next_action` для `pos_sale` касса отвергнет (`INVALID_RESPONSE`). `snapshot` - квота; `sales_channel` в ней только у агрегатора (и тогда `service_mode:'takeaway'`), у зала ключа нет.

## 3. `PosSale`

- `display_number`: касса принимает целое число или строку цифр (в `LocalFulfillment` это строка), сравнивает с `order.fulfillment.display_number`.
- Наличная часть: `change_minor = cash_tendered_minor - сумма наличной оплаты`; без наличных оба поля `null`. Если `cash_tendered_minor` не передан при наличной оплате - `change_minor` `null` или `'0'`.
- `pickup`: `issue` для `hall`, `delivery_handover` для агрегатора; у агрегатора `external_order_ref` не `null`, у ChocoFood тоже.
- `revenue_kind` = `staff_meal`/`marketing` для этих методов, иначе `revenue`.
- `fiscal[].receipt_number` не `null` только при `state:'recorded'`.

## 4. `POST pos/fiscal-receipts/{receiptId}/record`

Ответ §5.1 - «запись чека», форма не задана. Касса проверяет только, что это объект и что `receipt_id` (если есть) равен пути, затем читает `GET pos/sales/{orderId}`. Тело кассы: `{expected_version, receipt_number}` (approval `fiscal_correct` - в части B полосы client).

## 5. Отказы `POST pos/sales`

Касса считает окончательными (команда не повторяется тем же ключом, квота остаётся для другой оплаты) ответы 4xx с кодами: `SERVICE_MODE_DISABLED`, `METHOD_DISABLED`, `TENDER_SUM_MISMATCH`, `CASH_TENDERED_TOO_LOW`, `TERMINAL_AMOUNT_NOT_WHOLE`, `CHANNEL_PRICE_UNAVAILABLE`, `EXTERNAL_REF_REQUIRED`, `EXTERNAL_REF_DUPLICATE`, `APPROVAL_REQUIRED`, `APPROVAL_INVALID`, `KITCHEN_UNAVAILABLE`, плюс прежние `CONFLICT` (409), `QUOTE_EXPIRED`, `MENU_CHANGED`, `ITEM_STOPPED`, `INVALID_REQUEST`, `NOT_FOUND`, `FORBIDDEN`, `CASH_SHIFT_REQUIRED`. 5xx и обрыв - неизвестный результат, повтор только тем же ключом и телом. Просьба не возвращать эти коды, если транзакция успела зафиксироваться.

## 6. `GET pos/config`, `GET ordering`, `CashShift`

- `pos/config`: неизвестные коды методов и каналов касса пропускает (не показывает), известные проверяет строго; `approval_ttl_seconds` 1..3600; `fiscal_mode` только `manual_webkassa`. 404 - старый edge, касса в прежнем режиме без оплаты.
- `ordering.pos_service_mode`: касса принимает и `pos_sale` (если полоса pos расширит `OrderingStateSchema`).
- `CashShift`: касса принимает деньги в `cash_received_minor`/`cash_refunded_minor` и любой boolean в `payment_processing_available` (для смен без `sales_mode` значения прежние, как в §5.1).

## 7. Маршруты для профиля `pos` шлюза (§5.5, к сведению client CL-2/CL-4)

Экраны части A вызывают: GET `pos/config`, `pos/sales/{uuid}`; POST `staff/approvals`, `pos/sales`, `pos/fiscal-receipts/{uuid}/record`. Пока они разрешены только в `apps/pos/server.mjs`; allowlist pos-desktop и профиль шлюза - следующий шаг полосы client.
