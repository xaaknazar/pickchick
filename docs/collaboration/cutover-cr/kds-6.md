# CR kds-6 → cloud: код ошибки `HANDOVER_MARKS_REQUIRED` в `ErrorSchema`

Полоса: kds (ветка `codex/cutover-kds`). Адресат: cloud (`codex/cutover-cloud`) - владелец региона `packages/contracts/src/index.ts` от `MenuModifierOptionSchema` до `EDGE_MENU_FEATURES_QUERY_KEY` (§4.1), где лежит `ErrorSchema`. Копия - integration.
Основание: контракт §5.4: «`handoff` заказа доставки требует `handover:{numberMatched:true, courierAccepted:true, photoTaken:true}`, иначе 400 `HANDOVER_MARKS_REQUIRED`».
Состояние полосы: KDS-4 `fea2b0ba`.

## 1. Проблема

Edge бросает `HttpException({code:'HANDOVER_MARKS_REQUIRED'}, 400)` (`services/edge/src/fulfillment-controller.ts`, `runFulfillment`). Фильтр ошибок `packages/platform/src/http.ts:68-84` пропускает только коды из `ErrorSchema.shape.code`; неизвестный код заменяется умолчанием статуса. Сейчас клиент кухни получает `400 INVALID_REQUEST` вместо `HANDOVER_MARKS_REQUIRED` и не может показать «Отметьте все три условия протокола передачи.»

## 2. Точный diff интерфейса

`packages/contracts/src/index.ts`, `ErrorSchema.code` - добавить одно значение (место - рядом с кодами кассового edge, после `'SHIFT_CLOSED',`):

```diff
     'ORDER_IN_PRODUCTION',
     'SHIFT_CLOSED',
+    // Kitchen edge only (cutover KDS-4): handoff of a delivery order without the three courier
+    // marks. Only kitchen clients with the KDS layout send marks; cloud routes never answer it.
+    'HANDOVER_MARKS_REQUIRED',
     'CONFLICT',
```

После этого - `pnpm contracts:generate` (enum в `openapi.json`).

## 3. Совместимость

- Облачные маршруты (приложение, киоск, бэк-офис) этот код никогда не отправляют: строгие бандлы со своим enum ошибок его не увидят.
- Установленный клиент кухни не отправляет `handover` и с выключенной раскладкой получает прежний `400 INVALID_REQUEST` (проверено `tests/integration/kds-http-compat.test.mjs`).
- Без этого CR поведение безопасно: передача без отметок всё равно отклоняется (400), меняется только код в теле.

## 4. Как проверено у kds

`tests/integration/kds-http.test.mjs` ждёт `HANDOVER_MARKS_REQUIRED`, если код уже есть в `ErrorSchema`, иначе `INVALID_REQUEST` - после слияния CR тест автоматически становится строгим. На уровне репозитория код точный: `FulfillmentError('INVALID', 'HANDOVER_MARKS_REQUIRED')` (`packages/edge-fulfillment/tests/kds-postgres.test.mjs`).
