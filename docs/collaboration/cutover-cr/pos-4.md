# CR pos-4 → cloud, integration (копия client, kds): старые потоки с `pos_sale`, оператор, бэк-офис

Полоса: pos (ветка `codex/cutover-pos`, шаг 4 - POS-6 и операционная часть). Адресаты: cloud
(`codex/cutover-cloud`), integration (`codex/cutover-1119`), копия client и kds.
Основание: контракт §00, §5.6 (конец), §6.1, §6.2, §7.3, риск 10.2; CR pos-1, pos-2, pos-3.
Всё выключено: пока оператор не выполнил `pos-sales-setup.mjs enable`, ни одного события
`pos_sale` нет, и полезная нагрузка всех старых потоков прежняя байт-в-байт (тест ниже).

## 1. Что сделано в полосе pos (для сведения всех)

Строгие разборщики старых потоков принимают `pos_sale`; всё прочее - как на D0:

| Поток            | Файл                                                       | Что принимается дополнительно                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| order_commercial | `packages/pos-order-sync/src/model.ts` (`parseEvent`)      | `order.created` `paid`/`captured`/`pos_sale` (версия 1), `order.cancelled` `cancelled`/`captured`/`pos_sale` (версия 2); квота агрегатора только у `pos_sale` и только `takeaway` |
| order_commercial | `packages/pos-order-sync/src/cloud.ts` (`receivePosOrder`) | проекция `paid`/`captured`; отмена сверяет `payment_state`; облако без 073 отвечает 409 (CHECK → `CONFLICT`), ничего не пишет                                                     |
| кухня            | `kitchen-model.ts`, `kitchen-cloud.ts:77,179`              | `executionMode: pos_sale`, если коммерческая проекция того же режима                                                                                                              |
| cashier reports  | `packages/fulfillment-transport/src/cashier-reports.ts`    | заказ `paid` (версия 1) / `cancelled` (2) с `execution_mode: pos_sale`; смена с парой `cash_sales_minor` + `cash_refunds_minor` и `opening+in-out+sales-refunds=expected`         |

Edge и облако используют одни и те же функции: edge-воркеры разбирают свой outbox ими же, поэтому
новый API (Cloud-1) и новый рантайм edge должны содержать этот код до `enable`.
Тесты: `packages/pos-order-sync/tests/pos-sale-streams.test.mjs` (замороженная копия схемы D0,
векторы всех восьми способов), `tests/integration/pos-sales-streams.test.mjs` (день продаж
через настоящий API и воркеры: наличные со сдачей и отмена, смешанная с приготовлением и
возвратом, Яндекс Еда, питание; всё доходит до `pos_order_sync_projection`,
`pos_kitchen_sync_projection`, `cloud_cashier_*`; `posSales` - один строго упорядоченный
пакет; день без `pos_sale` - формы D0; облако на 072 - edge хранит события).

Оператор: `scripts/pos-sales-setup.mjs` (`status`, `enable`, `disable`, `fiscal-policy`),
runbook `docs/operations/pos-sales.md`, ADR-0015.

## 2. cloud: бэк-офис для оплаченных продаж кассы (просьба пользователя: «исправлять фронт-энд бэк-офиса»)

Бэк-офис не падает на данных `pos_sale` (проверено: `Backoffice.read` и `Backoffice.order` в
`tests/integration/pos-sales-streams.test.mjs`), но показывает их как неоплаченные. Нужно
(файлы полосы cloud, полоса pos их не трогает):

1. `packages/backoffice-core/src/index.ts:215-226` (`cashier_orders`) и `:482-499` (заказ из
   cashier report): `payment_state: 'not_started'` и `fiscal_state: 'not_requested'` заданы
   константой. Для `payload.execution_mode === 'pos_sale'` - `payment_state: 'captured'`
   (и для отменённой продажи: деньги возвращены отменой, см. `cloud_pos_refunds`); фискальное
   состояние - из `cloud_pos_fiscal_receipts` (CC-4), пока их нет - прежнее значение.
   Предлагаемый diff:

   ```ts
   payment_state: row.payload.execution_mode === 'pos_sale' ? 'captured' : 'not_started',
   ```

2. `packages/backoffice-core/src/index.ts:193-201` (`cashier_metrics`): добавить
   `paid_total_minor` = сумма `total_minor` заказов `state='paid'`; «Сумма неоплаченных
   заказов» для продаж всегда 0, это верно.
3. `apps/backoffice/src/operations.ts:42` (`labels`): нет подписей `paid` («Оплачен»),
   `captured` («Оплачено»), `pos_sale` («Продажа кассы»); сейчас бейджи показывают код.
4. `apps/backoffice/src/operations.ts:1403-1440` (панель смены): для смены продаж (в payload
   есть `cash_sales_minor`) добавить строки «Наличные продажи» (`cash_sales_minor`) и
   «Наличные возвраты» (`cash_refunds_minor`); «Ожидаемый остаток» уже включает их.
5. `apps/backoffice/src/operations.ts:1797-1801`: текст «Подтверждённые оплаты, возвраты и
   фискальные итоги этой смены пока не передаются. Наличие заказа не означает оплату.»
   неверен для смены продаж. Для неё: «Смена продаж: оплаты и возвраты приняты кассой;
   способы оплаты, чеки Webkassa и Z - в отчёте продаж».
6. Тесты бэк-офиса на синтетических строках `cloud_cashier_orders` (`paid`, `pos_sale`) и
   `cloud_cashier_shifts` (с `cash_sales_minor`), формы - как в `tests/integration/pos-sales-streams.test.mjs`.

Отчёт продаж (CC-7) по-прежнему читает `cloud_pos_*` (§5.7); пункты выше - только чтобы
старые экраны «Заказы» и «Кассовые смены» не вводили в заблуждение.

## 3. cloud: напоминания

1. CR pos-1 §2: 13 кодов POS в `ErrorSchema` (касса показывает тексты только по точному коду).
2. `sales-worker.ts`: на каждый ответ 200 (в том числе пустую пробу) записывать
   `pos_sale_sync_state.last_supported_at` (§5.6). `pos-sales-setup.mjs enable` требует
   `last_supported_at` не старше 24 ч, без строки - отказ `CLOUD_NOT_SUPPORTED`.

## 4. integration

1. `scripts/build-windows-edge-runtime.py` (`FILES`): добавить `scripts/pos-sales-setup.mjs`
   (и `infra/windows/pos-sales-grants.mjs` вместе с `pos-sales-upgrade-db.mjs`, CR pos-1 §1).
   Скрипт импортирует только `./edge-migrate.mjs`, `@pickchick/contracts`,
   `@pickchick/database`, сети не использует, работает под owner-подключением edge
   (`edgeInstallConfig`).
2. Порядок §6.2 шаг 6: `--reason` должен быть 3-300 символов (CHECK аудита 026, как у
   `kds_setting_changes`); пример контракта `--reason "Т7"` скрипт отклонит до обращения к
   базе (`INVALID_ARGUMENTS`). В мастер-runbook писать, например, «Т7 пробная смена».
3. `cutover-cross-lane`: фикстура `streamDesk` из `tests/integration/pos-sales-streams.test.mjs`
   (касса, кухня, POS sync с обеих сторон, API с `posOrderSyncEnabled`) годится как основа.
4. Окружение тестов - как в CR pos-1 §5 (базы `pickchick_edge`/`pickchick_cloud` на паре
   PostgreSQL только этой полосы).

## 5. client, kds (для сведения)

Интерфейсы §5 не менялись. Касса узнаёт режим по `GET pos/config`; `enable` требует, чтобы
каждая касса (терминал со сменой или входом кассира/начальника смены за 30 дней, кроме
кухонных экранов и табло из доступа устройств) хотя бы раз получила `GET pos/config`.
