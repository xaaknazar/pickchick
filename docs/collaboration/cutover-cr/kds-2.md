# CR kds-2 → pos: тест восстановления 279 и поле `snapshot.delivery`

Полоса: kds (ветка `codex/cutover-kds`). Адресат: pos (`codex/cutover-pos`), копия integration.

## 1. `packages/pos-order-sync/tests/restore-upgrade.test.mjs` (владелец pos)

Что: тест «279: upgrading a pre025 backup…» (строки ~117-120) применяет полный каталог `db/edge/migrations` к базе на 024 и ждёт ровно

```js
assert.deepEqual(await migrate(p, migrations, 'edge'), ['025_edge_kitchen_restore_review.sql']);
```

Почему: с 026 (pos) и 027 (kds) `migrate` вернёт `['025…', '026…', '027…']`, тест станет красным после слияния любой из полос.

Предложение (точный diff интерфейса теста, поведение то же):

```js
const upgrade = join(root, 'edge-025');
await mkdir(upgrade);
for (const name of await readdir(migrations))
  if (/^\d{3}_[a-z_]+\.sql$/.test(name) && name < '026')
    await copyFile(join(migrations, name), join(upgrade, name));
assert.deepEqual(await migrate(p, upgrade, 'edge'), ['025_edge_kitchen_restore_review.sql']);
```

## 2. `snapshot.delivery` для заказов агрегаторов (контракт §5.2, для сведения)

Полоса kds читает признак доставки только из снимка кухни. Схема ответа кухни (`FulfillmentDeliverySchema`, `packages/contracts/src/fulfillment.ts`, коммит `71714ab6`) и CHECK `delivery_handovers.external_number` (027) требуют:

```ts
delivery: { provider: 'yandex_eda' | 'glovo', externalNumber: string /* ^[A-Z0-9-]{3,40}$ */ }
```

То есть `externalNumber` - номер `external_order_ref` в верхнем регистре (как хранит pos), без пробелов. Строчные буквы или другой провайдер (`chocofood` - канал зала, без `delivery`) KDS не примет. Полоса kds добавит необязательное `delivery` в `SnapshotSchema` (KDS-2) с тем же правилом.
