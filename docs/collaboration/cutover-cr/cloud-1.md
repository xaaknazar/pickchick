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

## Третье: правка вне шаблона владения (ревью CR-CLOUD-R11)

`tests/integration/menu-sync.test.mjs` не подходит под шаблон полосы
`tests/integration/{catalog,menu-sync,channel,unified-menu}-*` (§4.1: после `menu-sync` в имени
точка, а не дефис), но полоса cloud правила его в коммите 8856dc1a: касса новой сборки заявляет
обе фичи меню, и тест ждал прежний запрос. Правка - только ожидаемый запрос, проверка та же:

```diff
-      // No active menu yet: only the menu features this runtime applies (stage 2, pcs).
-      assert.equal(fake.requests[0].query, '?menu_features=combo_stops');
+      // No active menu yet: only the menu features this runtime applies (stage 2 combo_stops,
+      // cutover aggregator_prices).
+      assert.equal(fake.requests[0].query, '?menu_features=combo_stops%2Caggregator_prices');
 ...
-      assert.equal(features, 'combo_stops');
+      assert.equal(features, 'combo_stops,aggregator_prices');
```

Просьба к интеграции: принять эту правку при слиянии cloud часть B (или считать файл файлом полосы
cloud в §4.1).

## Статус

П. 1 применён интеграцией в `codex/cutover-1119` (2ee4bdab, «stage 2 cross-lane check expects the
aggregator_prices menu feature»). П. 2 и п. 3 - на интеграции.

## Для интеграции: сообщение коммита f8355655

`f8355655` - целый `git cherry-pick -x` коммита полосы pos 513985f6 (патч идентичен, проверено
ревью). Строка `(cherry picked from commit 513985f6...)`, которую добавляет `-x`, стоит после двух
обязательных строк подписи. Переписывать коммит нельзя (правило полос); следующие переносы
полоса cloud делает так, чтобы ссылка на исходный коммит была в теле сообщения до подписи.
