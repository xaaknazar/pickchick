# CR cloud-1: межполосный тест этапа 2 и новая фича меню `aggregator_prices`

Полоса: cloud (шаг 2, CC-3). Кому: integration (файл не входит ни в одну полосу, §4.1).
Срочность: до слияния cloud часть B (13.11), иначе `tests/integration/stage2-cross-lane.test.mjs` красный.

## Что

`tests/integration/stage2-cross-lane.test.mjs:256` проверяет полный список фич меню:

```js
assert.deepEqual(EdgeMenuFeatureSchema.options, ['combo_stops']);
```

## Зачем

D0 (5b212949, §4.3 п.2 контракта) добавил в `EdgeMenuFeatureSchema` значение `aggregator_prices`.
С D0 этот тест красный при любом коде полос: значение задаёт сам `packages/contracts/src/index.ts`
(регион D0/cloud), полоса cloud перечисление не меняла. Проверено в ветке `codex/cutover-cloud`
(шаг 2): единственная ошибка теста - это сравнение, остальные проверки теста зелёные.

## Точный diff

```diff
-  assert.deepEqual(EdgeMenuFeatureSchema.options, ['combo_stops']);
+  assert.deepEqual(EdgeMenuFeatureSchema.options, ['combo_stops', 'aggregator_prices']);
```

Интерфейсы §5 не меняются. Касса новой сборки теперь заявляет обе фичи
(`menu_features=combo_stops,aggregator_prices`, `packages/menu-sync/src/worker.ts`); облако без CC-3
игнорирует незнакомое значение (`edgeMenuFeatures`), установленное облако - весь ключ.

## Второе (по желанию интеграции)

`.env.example` (владелец не назначен) - добавить выключенный флаг рядом с прочими флагами каталога,
чтобы оператор видел его в шаблоне:

```diff
 CATALOG_ADMIN_ENABLED=false
+# Cutover CC-3: Yandex Eda / Glovo prices reach the cashier edge (needs CATALOG_EDGE_PUBLICATION_ENABLED).
+CATALOG_AGGREGATOR_PRICES_ENABLED=false
```

Без этой строки поведение то же: флаг по умолчанию `false`.
