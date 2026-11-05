# CR pos-2 → client, cloud (копия kds, integration): маршруты продажи POS-2 и одобрения менеджера

Полоса: pos (ветка `codex/cutover-pos`). Адресаты: client (`codex/cutover-client`), cloud (`codex/cutover-cloud`), копия kds и integration.
Основание: контракт §00, §2.2, §4.2, §5.1-5.3, §5.5, §5.6. Состояние полосы: `0af9c314` (ядро продажи), `a6293218` (маршруты edge и блок `cutover:pos` в `scripts/contracts.mjs`), `4d426cfd` (тесты).
Всё выключено: маршруты работают только после `pos-sales-setup.mjs enable` (режим `pos_sale` и включённые методы).

## 1. client: что нужно кассе и pos-desktop

Просьбы (CL-1, CL-2, CL-4):

1. `GET pos/config` принимает необязательный query-ключ `client_version` (`^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$`, например `pos-2.1.0`). Edge записывает его в `pos_config_fetches` вместе с кассой и сотрудником; по этой записи `pos-sales-setup.mjs` (POS-6) проверяет, что каждая касса обновлена. Просьба: касса отправляет свою сборку; ключ разрешён в allowlist pos-desktop (`protocol.mjs`) и в профиле `pos` шлюза (§5.5). Без ключа всё работает, версия просто `NULL`. Неверный формат или повтор ключа - 400.
2. `POST staff/approvals` отвечает **201** и `Cache-Control: no-store`. Это не `command()`: `Idempotency-Key` не нужен и не учитывается, токен не попадает в `local_command_results` (хранится только SHA-256). Повтор запроса выдаёт новое одобрение, неиспользованное истекает через 120 с. Ответы: 401 - неверная сессия или неверный PIN; 403 - PIN верный, но это не начальник смены (или сессия кухни); 429 `AUTH_RATE_LIMITED` с `Retry-After` - backoff этой кассы, **общий со `staff/pin`** (после 5 неверных PIN на кассе - блокировка 30 с, дальше с удвоением до 15 мин); 404 - edge без 026. Терминал одобрения - терминал сессии кассира.
3. Предмет одобрения (`subject`) для `staff_meal` и `marketing` - `{quote_id, amount_minor: quote.total_minor}` той квоты, которую продаём; `action` равен методу. Одобрение тратится ровно один раз внутри `POST pos/sales`; повтор того же запроса с тем же `Idempotency-Key` и телом возвращает сохранённый ответ и одобрение повторно не тратит. Чужая касса, другое действие, другая сумма, истёкший или уже использованный токен - 409 `APPROVAL_INVALID`.
4. Тело `POST pos/sales` (сверх схемы `PosSaleRequestSchema`): `cash_tendered_minor` обязателен тогда и только тогда, когда есть наличная часть; `beneficiary` - только у `staff_meal`, `reason` - только у `marketing`, `approval` - только у них двоих; `external_order_ref` - только у агрегатора и ChocoFood (хранится и возвращается в верхнем регистре); `reference` допустим у любой части. Нарушение формы - 400 `INVALID_REQUEST`; правила денег - 409 с кодами §5.1. Порядок проверок: квота и меню → форма оплат → `METHOD_DISABLED` → смена кассы (`CASH_SHIFT_REQUIRED`) → дубль номера → одобрение. Поэтому выключенный метод никогда не просит PIN.
5. Квота агрегатора: `POST checkout/quotes` с `sales_channel: 'yandex_eda'|'glovo'` - только при режиме `pos_sale` (иначе 409 `SERVICE_MODE_DISABLED`) и только `takeaway` (иначе 400). `'hall'` и отсутствие поля дают прежнюю квоту зала байт-в-байт.
6. Коды ошибок в теле HTTP: пока CR pos-1 §2 не принят облаком, фильтр ошибок отвечает `CONFLICT` вместо 13 новых кодов (статус всегда 409). `SERVICE_MODE_DISABLED`, `CASH_SHIFT_REQUIRED`, `KITCHEN_UNAVAILABLE` уже в `ErrorSchema` и приходят как есть.

## 2. cloud

1. Напоминание: CR pos-1 §2 (13 кодов POS в `ErrorSchema`) теперь нужен - маршруты есть, касса показывает тексты только по точному коду.
2. Небольшое: `channelItemPriceMinor` (`packages/menu-sync/src/channel-prices.ts`) не принимает `MenuItem` при `exactOptionalPropertyTypes` (zod даёт `aggregator_prices_minor?: {…} | undefined`). Предлагаемый diff типа параметра, поведение не меняется:

   ```ts
   item: {
     price_minor: string;
     aggregator_prices_minor?:
       | { yandex_eda?: string | undefined; glovo?: string | undefined }
       | undefined;
   },
   ```

   До этого `pricing.ts` полосы pos передаёт товар через приведение типа (в рантайме разобранный zod-объект не содержит ключей со значением `undefined`).

## 3. kds (для сведения)

- Касса допускает продажу через `buildKitchenPlan(client, {branchId, snapshot, routing})` для обоих видов допуска (`unpaid_service` и `pos_sale`), `task_plan` = `plan`, `assembly_station_id` = `assemblyStationId`; ошибка `FulfillmentError` → `KITCHEN_UNAVAILABLE`. Тест полосы pos: без раскладки допуск продажи совпадает с unpaid-заказом (снимок, план, задачи).
- Снимок агрегатора: `delivery: {provider: 'yandex_eda'|'glovo', externalNumber: <верхний регистр>}`, `serviceMode: 'takeaway'`, `channel: 'pos'`. ChocoFood - зал, без `delivery`.
- `records.ts` `view()`: `executionMode` = `admission_kind` (`unpaid_service` | `pos_sale`). Для unpaid события байт-в-байт прежние; расширение `PosKitchenEventSchema` (`kitchen-model.ts`) под `pos_sale` - POS-6 полосы pos.

## 4. integration (для сведения)

Новых отношений и прав нет: рантайму хватает списка CR pos-1 §1 (`posSalesRuntimeGrants`), это проверено реальным ограниченным LOGIN (`applyEdgeRuntimeGrants` + `posSalesRuntimeGrants`) в `tests/integration/pos-sales.test.mjs`.
