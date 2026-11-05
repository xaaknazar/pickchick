# CR cloud-2: подключение потока `posSales` (CC-4) вне файлов полосы cloud

Полоса: cloud (шаг 3, CC-4). Кому: integration (п. 1-5), pos (п. 6). Интерфейсы §5 не меняются:
отправитель и приёмник реализуют §5.6 как есть.

Что сделано в `codex/cutover-cloud`: приёмник `receivePosSales` (`packages/pos-order-sync/src/sales-cloud.ts`),
маршрут `POST /internal/v1/edge/pos-orders/sales` (`services/api/src/pos-order-sync-controller.ts`),
флаг `CLOUD_POS_SALES_SYNC_ENABLED` (`packages/platform/src/config.ts`, `posSalesSyncEnabled`,
требует `CLOUD_POS_ORDER_SYNC_ENABLED=true`), отправитель `syncPosSalesOnce`/`createPosSalesSchedule`/
`retryPosSalesDelivery` (`packages/pos-order-sync/src/sales-worker.ts`) и его цикл
`runPosSalesLoop` в `infra/windows/native-pos-sync-worker.mjs`. Runbook:
`docs/operations/backoffice-cutover.md`.

## 1. Флаг в окружении API (integration)

Без этого флаг нельзя включить на стенде: compose не передаёт переменную в контейнер.

`infra/staging/compose.yaml`, в обоих местах рядом с `CLOUD_POS_ORDER_SYNC_ENABLED`:

```diff
       CLOUD_POS_ORDER_SYNC_ENABLED: ${CLOUD_POS_ORDER_SYNC_ENABLED:-false}
+      CLOUD_POS_SALES_SYNC_ENABLED: ${CLOUD_POS_SALES_SYNC_ENABLED:-false}
```

`.env.example` (владелец не назначен):

```diff
 CLOUD_POS_ORDER_SYNC_ENABLED=false
+# Cutover CC-4: posSales of paid POS sales (needs CLOUD_POS_ORDER_SYNC_ENABLED and cloud073 grants).
+CLOUD_POS_SALES_SYNC_ENABLED=false
```

Если какой-то тест релиза сверяет полный список переменных compose (`tests/operations/test_*release*.py`),
добавить туда же новую строку.

## 2. Права (integration, §5.9)

- Облако: `infra/staging/provision.mjs` - `cloudPosSalesGrants(apiRole, {receiver: true, backoffice: true})`
  из `infra/staging/pos-sales-grants.mjs` после прочих helper-ов. Без этих прав приёмник отвечает
  404, как облако без 073 (проверено тестом с реальной LOGIN-ролью).
- Касса: роль `pickchick_pos_sync` должна получить `WORKER_PRIVILEGES` из
  `infra/windows/pos-sales-grants.mjs` (`posSalesWorkerGrants`) там же, где сейчас
  `posSyncWorkerGrants` (`infra/windows/pos-sync-worker-grants.mjs` / `native-pos-sync-db.mjs`),
  и в проверку точных прав. Без них отправитель стоит в `not_installed` (повтор раз в 10 минут,
  ничего не отправляет); с ними доставка проверена тестом
  `least privilege: the POS sync worker and the receiver need exactly the 026/073 grants`.
  Отправителю нужны ровно `SELECT, UPDATE(acknowledged_at, attempts, last_error)` на
  `pos_sale_outbox` и `SELECT, INSERT, UPDATE` на `pos_sale_sync_state`, плюс прежнее `SELECT` на
  `pos_order_sync_state`.

## 3. OpenAPI (integration, `scripts/contracts.mjs`)

У полосы cloud нет точки вставки в `scripts/contracts.mjs` (§4.2), поэтому маршрут пока не описан
в `openapi.json`. Предлагаемый блок сразу после `openapi.paths['/internal/v1/edge/pos-orders/events'] = {...};`
(импорт `PosSaleBatchSchema`, `PosSaleBatchResultSchema` из `@pickchick/pos-order-sync` рядом с
`PosOrderReceiptSchema`), затем `pnpm contracts:generate`:

```js
// cutover:cloud begin
Object.assign(openapi.components.schemas, {
  PosSaleBatch: jsonSchema(PosSaleBatchSchema),
  PosSaleBatchResult: jsonSchema(PosSaleBatchResultSchema),
});
openapi.paths['/internal/v1/edge/pos-orders/sales'] = {
  post: {
    operationId: 'receiveEdgePosSales',
    description:
      'Private, disabled-by-default (CLOUD_POS_SALES_SYNC_ENABLED) posSales stream of paid POS sales, voids, refunds, Webkassa receipt records and Z reports of the cashier edge (contracts 5.6). Up to 50 events in edge sequence order; {events: []} is the support probe. Each event commits on its own and is acknowledged only after COMMIT; the answer is the accepted prefix, the first refused event ends it as rejected CONFLICT or INVALID_EVENT. 404 without the flag or schema073. Not routed by the public gateway.',
    security: [{ deviceBearer: [], deviceId: [] }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/PosSaleBatch' } } },
    },
    responses: {
      200: response('PosSaleBatchResult'),
      400: response(
        'Error',
        'Malformed batch, query string, over 50 events or 96 KiB, unordered sequences',
      ),
      401: response('Error', 'Invalid, expired or revoked device'),
      403: response('Error', 'Inactive POS sync binding or another branch'),
      404: response('Error', 'Feature disabled or schema073 missing'),
      413: response('Error', 'Global HTTP body limit exceeded'),
      500: response('Error', 'Internal error'),
    },
  },
};
// cutover:cloud end
```

## 4. Тестовые скрипты пакета (integration; `packages/pos-order-sync/package.json`, владелец не назначен)

```diff
-    "test": "node --test tests/unit.test.mjs",
-    "test:integration": "node --env-file=../../.env.example --test --test-concurrency=1 tests/integration.test.mjs tests/kitchen-integration.test.mjs tests/kitchen-upgrade.test.mjs tests/restore.test.mjs"
+    "test": "node --test tests/unit.test.mjs tests/sales-worker.test.mjs tests/sales-cloud.test.mjs",
+    "test:integration": "node --env-file=../../.env.example --test --test-concurrency=1 tests/integration.test.mjs tests/kitchen-integration.test.mjs tests/kitchen-upgrade.test.mjs tests/restore.test.mjs tests/sales-cloud-integration.test.mjs tests/sales-worker-integration.test.mjs"
```

## 5. Межполосные и стендовые тесты (integration)

- `tests/integration/cutover-cross-lane.test.mjs`: события `posSales` настоящей кассы принимает
  `receivePosSales(pool, {deviceId, token}, {events})` (экспорт `@pickchick/pos-order-sync`);
  отправку кассы - `syncPosSalesOnce(pool, {enabled, branchId, origin, identity}, createPosSalesSchedule(), io)`.
- `tests/offline-stand/worker.mjs` повторяет цикл службы: для догона «всех потоков» после 30
  минут без WAN добавить `runPosSalesLoop` из `infra/windows/native-pos-sync-worker.mjs`
  (параметры `pool, sync, identity, branchId, origin, once, signal, log, fail`).
- Известно красный в ветке cloud: `packages/pos-order-sync/tests/restore-upgrade.test.mjs`
  (ожидает, что после 025 нет миграций; с 026 из коммита схемы pos это не так). Исправлено в
  полосе pos коммитом d494402b, после слияния pos тест зелёный; полоса cloud этот файл не правит.

## 6. Команды оператора (pos, `scripts/pos-sales-setup.mjs`)

- `status`: показывать `pos_sale_sync_state.last_supported_at` и `last_error` (форматы
  `CLOUD_UNSUPPORTED`, `HTTP_<код>`, `NETWORK_UNKNOWN`, `INVALID_RESPONSE`, `NO_PROGRESS`,
  `PARKED <CONFLICT|INVALID_EVENT|LOCAL_INVALID|TOO_LARGE> <event_id>`) и число неподтверждённых
  строк `pos_sale_outbox`.
- `sync-release --event <uuid> --reason "..."` (owner env, аудит как у прочих команд): вызывает
  `retryPosSalesDelivery(pool, branchId, eventId)`. Функция проверяет, что вызывающий - владелец
  `pos_sale_outbox`, и снимает отметку `rejected:` только с этого непринятого события; иначе
  `FORBIDDEN`/`CONFLICT`.
