# CR pos-5 → lead/integration, cloud, client (копия kds): номер заказа после отмены, чек возврата без чека продажи

Полоса: pos (ветка `codex/cutover-pos`, исправления по ревью лида POS-R1, POS-R2, POS-R6..R8).
Адресаты: lead и integration (`codex/cutover-1119`), cloud (`codex/cutover-cloud`), client
(`codex/cutover-client`), копия kds.
Основание: контракт §00 п.1, §2.2, §3.2 п.6, §3.3, §4.1, §4.4, §5.1; CR pos-1 §1, CR pos-3 §1, CR pos-4 §2.
Всё по-прежнему выключено: новые правила действуют только на строки `pos_sales` и
`pos_fiscal_receipts`, которые появляются после `enable`.

## 1. lead: номер агрегатора и ChocoFood уникален среди неотменённых продаж (POS-R2, до заморозки DDL 10.11 18:00)

**Проблема.** По §3.3 номер `external_order_ref` был уникален среди всех строк `pos_sales`,
включая отменённые (частичный уникальный индекс), а `pos_sales` неизменяема. Обычная поправка
на кассе - кассир ошибся в заказе Яндекс Еды, Glovo или ChocoFood, отменил его до старта кухни
и вводит заново - получала `EXTERNAL_REF_DUPLICATE` «Этот номер заказа уже пробит». Кассиру
пришлось бы придумывать другой номер, и номер на выдаче доставки
(`snapshot.delivery.externalNumber`) и в сверке перестал бы совпадать с планшетом.

**Решение (сделано в 026).** Номер принадлежит не больше чем одной **неотменённой** продаже
канала. Отмена (`void`: заказ `cancelled` - единственный путь отмены оплаченной продажи)
освобождает номер; история хранит обе продажи с одним номером.

- `db/edge/migrations/026_edge_pos_sales.sql`: индекс `pos_sales_external_order_ref_idx`
  теперь неуникальный (поиск по номеру). Уникальность - в `guard_pos_sale` (BEFORE INSERT):
  `pg_advisory_xact_lock` по `(branch_id, sales_channel, external_order_ref)`, затем проверка
  «есть ли продажа с этим номером, чей `local_orders.state <> 'cancelled'`» - отказ с
  `ERRCODE 23505`. Проверка после блокировки видит все зафиксированные продажи (новый снимок
  read committed); отмена, ещё не зафиксированная, номер держит. Под repeatable read и
  serializable снимок старше блокировки, поэтому продажа с номером там отклоняется
  (`0A000`); рантайм работает в read committed.
- `packages/local-orders/src/sales.ts`: предварительная проверка не учитывает отменённые
  продажи; `23505` по-прежнему превращается в `EXTERNAL_REF_DUPLICATE`.
- Почему не отдельная таблица номеров с частичным уникальным индексом (вариант A ревью): она
  добавляет изменяемое отношение, права рантайма и строку в списки копий integration, а
  гарантия та же при единственном уровне изоляции рантайма. Новых отношений и прав нет.

**Diff контракта** (lead правит текст; поведение уже в ветке pos):

```diff
 §00 п.1, chocofood:
-Номер заказа ChocoFood обязателен (`external_order_ref`, то же правило `ExternalOrderRefSchema`, уникален в ветке среди заказов ChocoFood; ...
+Номер заказа ChocoFood обязателен (`external_order_ref`, то же правило `ExternalOrderRefSchema`, уникален в ветке среди неотменённых заказов ChocoFood: номер отменённой продажи можно ввести снова; ...
 §2.2, правила продажи:
-агрегатор ⇔ обязательный уникальный в канале `external_order_ref`.
+агрегатор ⇔ обязательный `external_order_ref`, уникальный в канале среди неотменённых продаж (void освобождает номер для повторного ввода).
 §3.3, 026:
-`pos_sales` (`UNIQUE(branch_id, sales_channel, external_order_ref) WHERE external_order_ref IS NOT NULL`)
+`pos_sales` (номер: не больше одной неотменённой продажи на `(branch_id, sales_channel, external_order_ref)` - `guard_pos_sale` под advisory-блокировкой номера; индекс `pos_sales_external_order_ref_idx` неуникальный)
```

Тесты: `tests/integration/pos-sales.test.mjs` - «a voided aggregator or ChocoFood order frees
its number for the corrected re-entry» (Яндекс Еда и ChocoFood: отмена, повторный ввод тем же
номером, дубль живой продажи, одновременный повторный ввод на двух кассах - продаёт ровно одна),
повторный ввод под ограниченным LOGIN рантайма; `tests/integration/pos-sales-schema.test.mjs` -
«an order number belongs to one sale that is not voided ...» (SQL: отмена освобождает номер,
незафиксированная отмена держит его для другой кассы, вторая вставка ждёт блокировку номера и
получает `23505`, repeatable read и serializable отклоняются).

## 2. integration: новый SHA-256 миграции 026 (заменяет CR pos-1 §1)

`db/edge/migrations/026_edge_pos_sales.sql` изменён до заморозки DDL (§3.2 п.6: на точке 026
ещё не применялась). Новый SHA-256:
`4ff8da34df867929269b7554a61182741840a2300f7a406d4e33748e99a0d873`
(прежний `9e3ab95a…` из CR pos-1 §1 недействителен). Список отношений, права рантайма и воркера
(`infra/windows/pos-sales-grants.mjs`) не меняются: проверка номера читает `pos_sales` и
`local_orders` правом `SELECT`, которое у рантайма уже есть, а advisory-блокировке прав не нужно.
Остальное из CR pos-1 §1 и CR pos-4 §4 в силе (ledger копий и `EDGE_BACKUP_SCHEMAS`, гранты в
`edge-runtime-grants.mjs` и `pos-sync-worker-grants.mjs`, `pos-sales-upgrade-db.mjs`, файл
`scripts/pos-sales-setup.mjs` в пакете Windows).

## 3. client: void с «чек пробит» для продажи без чека (POS-R1; дополняет CR pos-3 §1 п.3)

`POST pos/sales/{orderId}/void` с `fiscal_sale_issued: true`, когда чек продажи `not_required`
(агрегаторы, ChocoFood, питание, маркетинг или способ с политикой `not_required`), отвечает
409 `CONFLICT` и ничего не пишет; подтверждение не тратится. Раньше edge создавал чек возврата
`pending` для продажи, которую никогда не пробивали в Webkassa: кассира просили пробить возврат
без продажи, а смена не закрывалась без PIN. Порядок проверок CR pos-3 §1 п.3 не меняется
(«согласие с чеком» - тот же шаг `CONFLICT`). Касса client уже отправляет `false` для чека
`not_required` (`apps/pos/src/model.ts`, `voidSale`), поэтому в UI ничего менять не нужно.
В 026 то же правило проверяет база: чек возврата не может быть `pending`/`recorded`, если чек
продажи `not_required` (`guard_pos_fiscal_receipt`, INSERT).

Повторный ввод заказа агрегатора или ChocoFood тем же номером после отмены теперь проходит
(п. 1); текст `EXTERNAL_REF_DUPLICATE` прежний. В `scripts/contracts.mjs` (блок pos) дополнены
только описания 409 у `pos/sales` и `pos/sales/{orderId}/void`; схемы запросов и ответов те же.

## 4. integration (копия kds): тип `Reservation.admission_kind` в `records.ts` (POS-R8)

По §4.1 полоса pos владеет в `packages/edge-fulfillment/src/records.ts` только `view()`, а kds -
всем `packages/edge-fulfillment/src/**`, кроме `records.ts`; интерфейс `Reservation` (строка 17)
остаётся у integration. Он всё ещё объявляет `admission_kind: 'cloud_authorized' |
'unpaid_service'`, хотя 026 разрешает `pos_sale`; `view()` прячет это приведением типа.

```diff
 export interface Reservation {
   ...
-  admission_kind: 'cloud_authorized' | 'unpaid_service';
+  admission_kind: 'cloud_authorized' | 'unpaid_service' | 'pos_sale';
```

Приведение в `view()` (регион pos) остаётся: оно сужает тип по `commercial_owner='edge_pos'`
(CHECK `fulfillment_admission_origin` в 026), чего TypeScript сам не выводит; после правки
типа оно сужает верный тип, а не прячет неверный. Поведение не меняется (только тип).

## 5. cloud (для сведения)

1. В `cloud_pos_sales` теперь бывает несколько продаж с одним
   `(branch_id, sales_channel, external_order_ref)`: не больше одной `paid`, остальные
   `voided`. Отчёт продаж (CC-7) и сверка (P1) не должны считать номер уникальным: сопоставлять
   по номеру среди `state='paid'`. В 073 уникальности номера нет, менять DDL не нужно.
2. Бэк-офис для оплаченных продаж (CR pos-4 §2, пункты 1-6) по-прежнему открыт, и пользователь
   повторил просьбу («фронт-энд бэк-офиса тоже надо исправлять»). Это файлы полосы cloud
   (`packages/backoffice-core/src/index.ts`, `apps/backoffice/src/operations.ts`), полоса pos их
   не трогает. Нужно до Cloud-1 (14.11), иначе владелец и бухгалтер увидят оплаченные продажи
   как неоплаченные.

## 6. Для сведения всех: отмена и возврат продажи другой кассы, после `disable` (POS-R6, POS-R7)

- Кассир видит только продажи своей кассы (`GET pos/sales/{id}`, void и возврат отвечают
  `NOT_FOUND` для продажи другой кассы). Отмену или возврат продажи другой кассы оформляет
  начальник смены, войдя на кассе, где отдают деньги: проводка - в смене этой кассы, наличные -
  из её ящика (тест «a refund of another desk's sale is made in a shift manager session on the
  refunding desk»). Это записано в `docs/operations/pos-sales.md` §5. Код не менялся: возврат
  без сессии начальника на кассе B потребовал бы, чтобы касса client открывала чужую продажу,
  а `GET pos/sales` намеренно ограничен своей кассой.
- После `pos-sales-setup.mjs disable` отмена и возврат продаж `pos_sale` в PickChick
  невозможны (`SERVICE_MODE_DISABLED`, и смены уже не смены продаж). Возвраты продаж Т7
  (16-17.11) оформляются до `disable`, иначе вручную с записью в журнал смены; runbook §2, §3, §9
  и ADR-0015 «Последствия» это описывают.
