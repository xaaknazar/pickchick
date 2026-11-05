# CR kds-4 → cloud и integration: два корневых unit-теста старого правила prep-станции

Полоса: kds (ветка `codex/cutover-kds`). Адресаты: cloud (`tests/unit/catalog-*`, контракт §4.1) и integration (`tests/unit/menu-routing.test.mjs` не закреплён ни за одной полосой).
Основание: KDS-2 «исправление `routing.ts` для нескольких prep-станций» (контракт §1.2), правило из `design-kds.md` §6: «prep-станция для новых позиций = та, на которую указывают действующие prep-маршруты; иначе требуется единственная prep-станция». Коммит полосы: `6c0cd964`.

## Что и почему

Два теста проверяют прежнее правило «новая prep-позиция - только при единственной prep-станции»:

- `tests/unit/menu-routing.test.mjs`, тест «new products follow the published kitchen field and the single prep station only» - ждёт `ROUTING_UNRESOLVED` при второй prep-станции;
- `tests/unit/catalog-edge-parity.test.mjs`, тест «routing coverage reports routes derived on apply and proves derivation with stations» - ждёт `ok:false` при второй prep-станции.

После `provisionKdsStations` на точке три prep-станции («Приготовление», «Панировка (6)», «Тосты и бургеры (5)»), и прежнее правило отклоняло бы каждую публикацию меню с новой позицией. По новому правилу позиция идёт на станцию действующих prep-маршрутов; неоднозначность (маршруты на двух prep-станциях) по-прежнему отклоняется. В ветке kds `pnpm test` поэтому 379/383: эти два теста и два известных теста нумерации без 026 (CR kds-1).

Новые проверки правила полосы kds: `tests/integration/menu-routing.test.mjs` (чистые векторы `deriveRouting` с тремя prep-станциями, публикация с настоящими станциями KDS, неоднозначная маршрутизация).

## Точный diff (проверен: обе копии с этими правками - 12/12)

```diff
--- a/tests/unit/menu-routing.test.mjs
+++ b/tests/unit/menu-routing.test.mjs
@@ -92,7 +92,7 @@
   assert.ok(first.routes.some((route) => route.productId === removed.source_id));
 });

-test('new products follow the published kitchen field and the single prep station only', () => {
+test('new products follow the published kitchen field and the prep station of the prep routes', () => {
   const snapshot = menu();
   const active = installed(snapshot);
   const extra = {
@@ -112,8 +112,19 @@
     kind: 'prep',
   });
   assert.equal(routes.get(extra.product_id).stationId, prep);
+  // Cutover KDS-2: with a second prep station (KDS 5 and 6 are prep) a new prep item follows
+  // the station of the existing prep routes; routes on two prep stations stay ambiguous.
   const second = [...stations, { id: randomUUID(), kind: 'prep' }];
-  assert.throws(() => deriveRouting(withExtra, active, second), unresolved);
+  assert.equal(
+    deriveRouting(withExtra, active, second).routes.find((route) => route.productId === 'new-item')
+      .stationId,
+    prep,
+  );
+  const split = {
+    ...active,
+    routes: [...active.routes, { productId: 'other-prep', stationId: second[2].id, kind: 'prep' }],
+  };
+  assert.throws(() => deriveRouting(withExtra, split, second), unresolved);
   // An assembly item never needs the prep station, even when there are two.
   const assemblyOnly = {
     items: [...snapshot.items, { ...extra, kitchen: { route: 'assembly_item' } }],
```

```diff
--- a/tests/unit/catalog-edge-parity.test.mjs
+++ b/tests/unit/catalog-edge-parity.test.mjs
@@ -211,10 +211,18 @@
   });
   assert.equal(report.ok, true);
   assert.equal(report.routing.derived_version, 3);
-  // With two prep stations a new prep route cannot be derived: the publication would be rejected.
+  // Prep routes on two prep stations: a new prep route cannot be derived (cutover KDS-2 rule),
+  // the publication would be rejected.
+  const secondPrep = '30000000-0000-4000-8000-000000000003';
   const ambiguous = {
-    routing: { ...routing, routes: routing.routes.slice(1) },
-    stations: [...stations, { id: '30000000-0000-4000-8000-000000000003', kind: 'prep' }],
+    routing: {
+      ...routing,
+      routes: [
+        ...routing.routes.slice(1),
+        { productId: 'other-prep', stationId: secondPrep, kind: 'prep' },
+      ],
+    },
+    stations: [...stations, { id: secondPrep, kind: 'prep' }],
   };
   report = catalogEdgeParity({ catalog: mockupCatalogDraft, snapshot, routing: ambiguous });
   assert.equal(report.ok, false);
```

Готовый патч - `docs/collaboration/cutover-cr/kds-4.patch` (в блоках выше markdown съедает пустые строки контекста, поэтому `git apply` берёт файл, а не текст CR): `git apply docs/collaboration/cutover-cr/kds-4.patch`. Проверено 05.11 на слиянии pos (`b25674d5`) в kds вместе с CR kds-6: корневой `pnpm test` - 383 теста, 382 прошли, 0 упали, 1 пропущен (подробности - CR kds-8).

Интерфейс `deriveRouting(snapshot, active, stations)` не меняется. Если полоса cloud сливается раньше kds, её правка этих тестов должна идти вместе со слиянием kds (иначе красные с другой стороны): удобнее, чтобы integration применила оба diff в коммите слияния kds.
