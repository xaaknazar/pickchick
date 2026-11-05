# Дизайн полосы BACK OFFICE: операции, персонал, склад (переход 19.11.2026)

База: `origin/codex/shared-development` 1a9472f1 (05.11.2026), только чтение, ничего не реализовано.
Коды: А7-А12, Ск1, Ск2, Ск5-Ск7, Д3, Д5, У3-У6 и отчёты менеджера вместо аналитики iiko.
Миграции обозначены `cloud-NEXT` (после cloud 072 и после cloud-NEXT полосы POS, номер назначает lead).
**Edge-миграция этой полосе не нужна.** UNCONFIRMED - не подтверждено кодом или документами.
В текстах UI только дефис `-` (правило владельца, `AGENTS.md`).

## 1. Текущее состояние

**Роли и доступ.**

- В бэк-офисе две роли: `bo_access_grants.role IN ('manager','analyst')` (`db/cloud/migrations/017_cloud_backoffice.sql:101-107`). Запись - только `manager`: `index.ts:112`, `finance.ts:208`, `workforce-store.ts:45` (все в `packages/backoffice-core/src/`). UI прячет кнопки по `d.role !== 'manager'` (`apps/backoffice/src/operations.ts:421,673,1197`).
- Роли «бухгалтер» нет (`docs/operations/finance-ledger.md:136-139`). Есть только назначение бухгалтера сверки поверх analyst (`reconciliation.ts:226-239`, таблица `bo_rec_accountants`). Аналитик читает всё, включая финансы и начисления.
- Личные логины уже поддерживаются: файл accounts v2, у каждого свой scrypt и actor (`apps/backoffice/staff-auth.mjs:55-89`). Выдача прав - `scripts/backoffice-setup.mjs`.
- На edge три роли: `cashier|shift_manager|kitchen` (`db/edge/migrations/004_edge_local_orders.sql:7`). Сотрудника заводит только оператор (`packages/local-orders/src/staff.ts:33-50`). Роль сменить нельзя: `staff.role !== setup.role` даёт CONFLICT (`staff.ts:49`). PIN вводится по одному скрытым вводом на сервере (`scripts/staff-pin-setup.mjs:33-50`).
- Кухня работает под общим логином `kitchen` (`docs/operations/device-access.md:23-28`). Права на станции выдаются только роли kitchen (`packages/edge-fulfillment/src/setup.ts:93-111`), экран ограничен режимом терминала (`services/edge/src/fulfillment-controller.ts:153,171-178`). Поэтому персональный доступ к экранам на практике не используется.

**Сотрудники, табель, BioCheck.**

- Карточка `Employee`: `role` (manager/cashier/cook/assembler/staff) и необязательная текстовая `position` (`model.ts:145-153`). 68 сотрудников импортированы из ведомости со статусом «Уточнить» (`docs/operations/payroll-september.md:5-7,42,139`).
- В графике `WorkPlan.position` - свободный текст (`workforce.ts:22-36`). Типы записей `plan|rate|time|bonus|payroll` (cloud `052:5`, `057:50`). Расстановки по станциям нет.
- Импорт отметок уже есть: команда `import` принимает нормализованные события с готовым `employee_id` и дедуплицирует их по `(branch, source, external_id)` (`workforce.ts:46-51,171-175`, `workforce-store.ts:405-436`). CSV-парсера и сопоставления сотрудников нет, формат ZKTeco неизвестен (`docs/operations/workforce.md:157-167`).

**Журнал смен менеджера.** Запись `bo_records` kind `shift`: ответственный, открыта/закрыта, наличные (`model.ts:154-162`). Одна открытая смена на точку, закрытая неизменна (`index.ts:885-909`). Чек-листов нет. В UI это «Управленческий журнал» (`operations.ts:2297-2310`). Все `bo_records` читаются одним `LIMIT 2000 ORDER BY kind` (`index.ts:227-229`). Поэтому растущий kind `shift` со временем вытеснит из выдачи `station` и `ticket`.

**Склад** - облачный управленческий журнал одной точки (`docs/architecture/inventory.md:30-33`).

- Команда `stock` поддерживает `receipt|waste|count`, у документа есть только `reference` и общий `reason`. Кода причины списания, поставщика и даты документа нет (`model.ts:213-218`). В документе не больше 100 строк, у каждой строки обязательный `expected_revision` (`model.ts:188-198`).
- Остаток не бывает отрицательным: `INSUFFICIENT_STOCK` (`model.ts:403`, CHECK `017:41,67`). Документы и движения неизменяемы (`017:97-98`). Kind `transfer` есть в CHECK, но не реализован (`017:52`). Сторно нет. Учёт по средневзвешенной стоимости (`model.ts:405-410`).
- В iiko 4 склада: хоз Абай Плаза, кухня, бар, мороженое (`docs/architecture/inventory.md:13`). У нас один.
- Импорт ТТК создал 229 позиций и 165 техкарт с `product_id=ttk:<номер>`. Это не id меню. Документов и остатков нет, полуфабрикаты производятся вручную, без рекурсии (`docs/operations/ttk-import-2026-10-20.md:24-28,66-69,120-126`).

**Списание по продажам (Ск2).**

- Есть только ручная команда `consume` по одному облачному заказу (`index.ts:1037-1068`). Она требует `cloud_fulfillment_projection` и отклоняет комбо и модификаторы (`:1058-1064`).
- Закрепление техкарт - триггер только на `commerce_orders` (`017:115-123`), `bo_stock_documents.order_id` ссылается на `commerce_orders` (`017:55`). Значит, заказы кассы (edge-owned) списать нельзя совсем.
- Строки заказа кассы: `variant_id` и `modifiers` - хэши `localCatalogId` от slug опубликованного каталога (`packages/contracts/src/index.ts:376-413`, `packages/backoffice-core/src/stops.ts:84-95`, `packages/menu-sync/src/availability.ts:6-16`). Версия меню кассы сопоставляется с версией каталога через `catalog_menu_deliveries` (`packages/menu-sync/src/catalog-delivery.ts:27-38`).
- Строки облачного заказа: `productId` и `selectedDetails{modifiers, components}` в виде slug (`packages/commerce-core/src/availability.ts:166-196`). В каталоге есть `kind combo|set`, `combo_components` и `linked_product_id` у вариантов (`packages/catalog-admin/src/contracts.ts:55-108`).
- Строки в отчётах кассы - только `variant_id` без модификаторов (`packages/fulfillment-transport/src/cashier-reports.ts:63-71`).

**Отчёты.** Страница «Отчёты» показывает только оплаты приложения и киоска (`operations.ts:1873-1951`, примечание на `:1947`). Заказы кассы приходят как `payment_state:'not_started'` (`index.ts:216-226`). Каналов, часов, среднего чека по всем каналам и способов оплаты нет.

**Возвраты, сверка, финансы.**

- Ручной возврат Kaspi Pay уже реализован (`model.ts:249-267`, `index.ts:736-759`) за флагом `BACKOFFICE_MANUAL_REFUNDS_ENABLED` (`stops.ts:17-21,36-43`). Права выдаёт `manualRefundGrants` последним шагом `provision.mjs` (`infra/staging/manual-refund-grants.mjs:11-19`, `provision.mjs:142-149`).
- В сверке `cash` и `kaspi_pos` помечены `recorded:false` (`reconciliation-model.ts:28-44`). Методов агрегаторов нет в CHECK (`071:67`).
- В финансах счета и начальные остатки вводятся вручную (`finance-ledger.md:61-66`).

**Инфраструктура.**

- Байты `backoffice-grants.mjs` закреплены историческими выпусками, поэтому новые права - только отдельным helper (`manual-refund-grants.mjs:8-9`).
- Новые маршруты нужно добавить в allowlist прокси (`apps/backoffice/server.mjs:49-170`) и в регулярки gateway (`infra/public-staging/gateway.Caddyfile:67,82`).
- Образец фонового воркера с `--once`: `services/api/src/customer-notifications-worker.ts:1-60`.

## 2. Целевое поведение по кодам

| Код         | Поведение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| А8, Д3      | Справочник 11 должностей с номером станции, ролью кассы, нужен ли PIN и ролью БО (§4). В карточке появляются `position_code` и `pos_access`. Кнопка «Выгрузить состав для кассы» даёт JSON. На сервере точки оператор запускает `staff-roster-apply` (план, хэш, применение), затем `staff-pin-batch` (каждый сотрудник с PIN вводит его сам). id сотрудника кассы детерминирован: `edgeStaffId(employee_id, role)`. Экраны кухни - по привязке устройства к станции (К8, полоса KDS) под общим `kitchen`. Персональная атрибуция на кухне - через расстановку (А9). |
| А12, У4, Б4 | Личные логины получают назначение роли: `shift_manager` или `accountant` поверх гранта analyst. Отмены облачных заказов, ручные возвраты, списания, сторно и пропуск автосписания доступны только `manager` и `shift_manager`. На кассе подтверждение PIN делает полоса POS. Бухгалтер пишет в финансы и сверку, принимает приходы и делает сторно. Начальнику смены финансы, ставки и начисления не видны.                                                                                                                                                          |
| У3          | Включение существующего флага и прав (ops) после Т1. Кто вправе - по А12.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Ск1         | Приход с поставщиком (цех, пекарня, хозтовары, поставщик), номером и датой документа. Сторно документа целиком. Перемещений нет, склад один (вопрос 3). Приёмку проводим с бухгалтером на 3 реальных документах.                                                                                                                                                                                                                                                                                                                                                     |
| Ск5         | Быстрое списание с обязательной причиной: `hot_cabinet_expired` (>50 мин), `meat_expired` (>3 дней), `defect`, `prep_expired`, `damaged`, `returned_after_cooking`, `rework`, `other` (с комментарием). Строку можно ввести по выходу ТТК («Фингерс жареный 12 шт»): сервер раскладывает её на сырьё. Отчёт по причинам, дням, позициям и авторам.                                                                                                                                                                                                                   |
| Ск2         | Автосписание продаж кассы (`pos_sale`) и облачных заказов. Списываются связи «позиция меню - склад», состав комбо берётся из каталога, выходы ТТК раскладываются на сырьё. Запуск - когда кухня начала заказ, остальное добирает проход в конце дня. Ровно один документ на заказ. Нехватка остатка, нет связи, связь не утверждена - заказ блокируется, видно причину, повтор автоматически. Режимы точки `off`, `dry_run`, `on`, начало с момента `start_at`.                                                                                                      |
| Ск7, А11    | Закрытие смены менеджера. Пункты: кассовые смены закрыты и расхождения пояснены (данные кассы), наличные сданы, смена Webkassa закрыта, списания внесены, подсчёт ключевых позиций проведён (форма заполнена позициями `count_daily`), заявки, инциденты курьеров, заблокированные списания, передача смены (текст обязателен). Закрытая смена неизменна.                                                                                                                                                                                                            |
| А10         | Тот же механизм, шаблон открытия: явка по графику, мясо и заготовки по срокам (кнопка «Списать»), оборудование, экраны, разменный фонд, стоп-лист.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Д5          | `stock-opening-import`: CSV инвентаризации 18.11 превращается в документы `count` по 100 строк. План с хэшем, повтор после потери ответа не создаёт дублей. Отрицательные остатки iiko не переносятся.                                                                                                                                                                                                                                                                                                                                                               |
| Отчёты      | «Продажи»: выручка, возвраты, чеки, средний чек, каналы (зал, с собой, Яндекс Еда, Glovo, приложение, киоск), 8 способов оплаты, по часам и дням, топ позиций, отмены и возвраты с подтвердившим менеджером, открытые смены, «Без выручки» (питание, маркетинг). Скидки - колонка 0 до механизма скидок. CSV.                                                                                                                                                                                                                                                        |
| А9 (P1)     | Расстановка: «сотрудник X на станции S с HH:MM», перестановка закрывает прежний интервал. Видна в табеле и в чек-листе. Из неё КД9 считает ошибки по людям.                                                                                                                                                                                                                                                                                                                                                                                                          |
| А7 (P1)     | Импорт CSV ZKTeco/BioCheck по профилю колонок и таблице «ID в терминале - сотрудник». Без отпечатков. Пишет существующей командой `import`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Ск6 (P1)    | Заявка в цех, пекарню или на хозтовары: строки, остаток на момент заявки, подсказка «минимум - остаток», печать и копирование текста. Сама ничего не отправляет. Получение заявки сразу открывает приход.                                                                                                                                                                                                                                                                                                                                                            |
| У5, У6 (P1) | Методы сверки `yandex_eda`, `glovo`, `chocofood` с итогом вручную. Факты кассы в сверке делает полоса POS. У6 - ввод счетов и остатков бухгалтером в существующих «Финансах» с датой начала 19.11.                                                                                                                                                                                                                                                                                                                                                                   |

## 3. Данные и миграции

**Владение.** Склад, связи меню, очередь списаний, смены менеджера, роли, расстановка и заявки принадлежат облаку. Продажи, оплаты, возвраты, кассовые смены и сотрудники кассы принадлежат edge и приходят в облако потоками полосы POS. Склад остаётся облачным и на 19.11. Переход на edge-владение по `docs/architecture/inventory.md:68-69` - P2.

**cloud-NEXT `bo_ops_cutover`** - одна аддитивная миграция, вместе со схемой для P1, чтобы не просить второе окно:

```sql
bo_role_designations(id uuid PK, actor_id ->catalog_managers, branch_id ->branches,
  role text NULL CHECK(role IN('shift_manager','accountant')), reason 3..500,
  source text DEFAULT 'trusted_local_setup' CHECK(source='trusted_local_setup'), created_at)
  -- только добавление (commerce_immutable); действует последняя запись по (actor,branch); NULL = нет роли
ALTER TABLE bo_stock_documents ADD reason_code text NULL CHECK(reason_code IN('hot_cabinet_expired',
  'meat_expired','defect','prep_expired','damaged','returned_after_cooking','rework','other')),
  ADD source_ref text NULL CHECK(source_ref ~ '^(pos|cloud):[0-9a-f-]{36}$'),
  ADD reverses_document_id uuid NULL REFERENCES bo_stock_documents(id),
  ADD meta jsonb NULL CHECK(meta IS NULL OR jsonb_typeof(meta)='object');
  -- kind CHECK пересоздать с 'reversal'; CHECK(kind<>'waste' OR reason_code IS NOT NULL OR created_at<'<дата миграции>')
CREATE UNIQUE INDEX ... ON bo_stock_documents(source_ref) WHERE kind='consumption';
CREATE UNIQUE INDEX ... ON bo_stock_documents(reverses_document_id) WHERE kind='reversal';
ALTER TABLE bo_stock_balances ADD counted_at timestamptz NULL;   -- время последнего подсчёта позиции
bo_stock_settings(branch_id PK, autoconsume_mode text CHECK IN('off','dry_run','on') DEFAULT 'off',
  start_at timestamptz NULL, revision int>0, updated_by ->catalog_managers, updated_at)
bo_menu_stock_links(branch_id, catalog_key text, product_slug, group_slug NULL, option_slug NULL,
  effect text CHECK IN('consume','none'), lines jsonb array (<=50; пусто <=> none),
  status text CHECK IN('draft','approved'), revision int>0, updated_by, updated_at,
  approved_by NULL, approved_at NULL, PRIMARY KEY(branch_id,catalog_key))
bo_consumption_items(branch_id, source text CHECK IN('pos','cloud'), order_id uuid, sold_at,
  state text CHECK IN('pending','previewed','applied','blocked','skipped','not_required'),
  reason text NULL, detail jsonb, document_id NULL ->bo_stock_documents, trigger text
  CHECK IN('kitchen_started','day_close'), attempts int, next_attempt_at, revision int, updated_at,
  PRIMARY KEY(branch_id,source,order_id))
  -- триггер переходов: applied/skipped/not_required конечны; document_id меняется только NULL -> id
bo_manager_shifts(id PK, branch_id, business_date date, manager_employee_id, state CHECK IN('open','closed'),
  opened_at, closed_at NULL, opening jsonb, closing jsonb NULL, template_version int, revision int>0,
  opened_by, closed_by NULL, UNIQUE(branch_id) WHERE state='open')  -- триггер: closed неизменна
-- P1, в той же миграции:
ALTER bo_workforce_records kind CHECK + 'assignment';
bo_attendance_identities(branch_id, source, external_user_id, employee_id, revision, updated_at, PK(branch_id,source,external_user_id))
bo_attendance_profiles(id, branch_id, name, mapping jsonb, revision)  -- по образцу bo_rec_profiles
bo_supply_requests(id PK, branch_id, kind CHECK IN('central_kitchen','bakery','household','supplier'),
  state CHECK IN('draft','submitted','received','cancelled'), needed_by date, lines jsonb,
  receipt_document_id NULL, revision, created_by, submitted_at, updated_at)
```

**Изменения payload без DDL** (необязательные поля, старые записи остаются валидными):

- `Ingredient`: `group` (`raw|semi|packaging|drink|household|other`), `count_daily`, `quick_waste`, `supply_kind`.
- `Recipe`: `stock_policy` (`explode` по умолчанию | `stock`).
- `Employee`: `position_code`, `extra_position_codes[]`, `pos_access` (`none|cashier|shift_manager`).

**Edge.** Таблиц нет. Состав кассы ведётся существующими `local_staff`, `local_staff_pins` и операторскими функциями.

## 4. API и контракты

**Чтение** - один префикс, одна регулярка в gateway и прокси: `GET /v1/admin/backoffice/branches/:id/ops/<view>`.

- `sales?start_date&end_date` (до 92 дней) - отчёт продаж (§2).
- `stock?view=waste|consumption|variance|movement&start_date&end_date` - отчёты склада.
- `consumption?state=blocked|pending|previewed&date` - очередь с причинами и покрытием каталога: N позиций и вариантов без связи, доля строк продаж со связью.
- `menu-links` - каталог плюс связи.
- `manager-shifts?date` - открытая смена, история и авто-проверки, посчитанные на лету.

`GET branches/:id` дополнительно отдаёт `effective_role`, `permissions[]` и `capabilities.{roles,stock_v2,autoconsume,manager_shifts,sales_report}`. Поле `role` остаётся прежним (`manager|analyst`) для установленного UI.

**Запись** - через существующий `POST .../commands`. Он уже даёт `request_id`, digest, аудит и блокировку точки (`index.ts:576-616,796-815`). Новые типы:

| type                                                | Тело                                                                                                                         | Право                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `stock` (расширение)                                | `+reason_code` (обязателен для waste при stock_v2), `+meta{supplier_kind,supplier_name,document_date,count_scope:'daily_key' | 'full'}`. Строка: `ingredient_id`**или**`recipe_output_id`(только waste).`expected_revision` становится необязательным для receipt и waste. | receipt: m/sm/acc; waste, count: m/sm |
| `stock_reverse`                                     | `{document_id}`. Не для consumption, если уже был подсчёт: `COUNTED_AFTER_DOCUMENT`. Нехватка остатка: `INSUFFICIENT_STOCK`. | m/acc                                                                                                                                       |
| `menu_link_save`                                    | `{catalog_ref, effect, lines[], expected_revision}`                                                                          | m                                                                                                                                           |
| `menu_links_approve`                                | `{keys[], expected_revisions}`                                                                                               | m (шеф через управляющего)                                                                                                                  |
| `stock_settings`                                    | `{autoconsume_mode, start_at, expected_revision}`                                                                            | m                                                                                                                                           |
| `consumption_retry` / `consumption_skip`            | `{source, order_id, expected_revision}`; для skip причина обязательна                                                        | m/sm                                                                                                                                        |
| `consumption_reverse`                               | `{document_id}`: сторно и возврат заказа в pending (после исправления связи)                                                 | m                                                                                                                                           |
| `manager_shift_open` / `_save` / `_close`           | `{id, business_date?, manager_employee_id?, phase, items[], handover?, expected_revision}`                                   | m/sm                                                                                                                                        |
| `supply_request_save` / `_submit` / `_receive` (P1) | черновик, подача, приход по строкам                                                                                          | m/sm                                                                                                                                        |

`m` - manager, `sm` - shift_manager, `acc` - accountant.

**Роли** (`packages/backoffice-core/src/roles.ts`): `effectiveRole = grant.manager ? 'manager' : designation ?? 'analyst'`. Назначение действует только при `BACKOFFICE_ROLES_ENABLED`. `can(role, permission)` - статическая матрица. Без флага поведение байт в байт прежнее. Новые ошибки в `BackofficeErrorReasonSchema`: `ROLE_FORBIDDEN`, `STOCK_V2_DISABLED`, `REASON_REQUIRED`, `COUNTED_AFTER_DOCUMENT`, `RECIPE_POLICY_EXPLODE`, `AUTOCONSUME_ACTIVE`, `CHECKLIST_INCOMPLETE`, `MANAGER_SHIFT_OPEN`.

**Алгоритм автосписания** (`packages/backoffice-core/src/consumption.ts` - чистые функции, `consumption-store.ts` - БД):

1. **Отбор** (идемпотентно, `INSERT ... ON CONFLICT DO NOTHING`):
   - Касса: `pos_order_sync_projection.execution_mode='pos_sale' AND state='paid'` плюс `pos_kitchen_sync_projection.state IN('in_production','ready','handed_over')`.
   - Облако: `commerce_orders` с `commerce_captures` плюс `cloud_fulfillment_projection.state IN(...)`, как в `index.ts:1044`.
   - Проход в конце дня (03:00 Алматы) берёт оплаченные, не отменённые и не начатые заказы.
   - Учитываются только `sold_at >= start_at`. При `off` ничего не отбирается.
2. **Разбор.**
   - Каталог кассы: `quote.release_id` -> `catalog_menu_deliveries.catalog_version` -> `catalog_publications`. Облако: последняя публикация с `published_at <= sold_at`.
   - Хэши id кассы переводятся обратно в slug через `stopVariantId`.
   - Строка: связь товара. Если её нет и `kind IN(combo,set)`, берутся `combo_components × quantity` рекурсивно, до 5 уровней.
   - Плюс варианты: при `linked_product_id` - связь этого товара, иначе связь варианта. Всё умножается на количество варианта и строки.
   - `components` облачного заказа используются только для выбора, которого нет в modifiers (UNCONFIRMED, проверить на Т1/Т2).
3. **Раскладка.** Строка связи с выходом техкарты `stock_policy='explode'` раскладывается на `lines × q / yield` рекурсивно, до 6 уровней, цикл даёт `RECIPE_CYCLE`. Счёт идёт точными дробями BigInt. Округление одно: half-up до целой учётной единицы на ингредиент на заказ. Нули фиксируются в снимке.
4. **Поглощение подсчётом.** Ингредиент с `counted_at >= sold_at` не списывается, в снимке он отмечен `absorbed_by_count`. Подсчёт уже отразил физический расход. Это закрывает опоздавшие после WAN-обрыва продажи и списания, внесённые после подсчёта. Подсчёт ставит `counted_at = now()`. Задним числом - P1.
5. **Применение.** Блокировка точки `bo:branch:` (та же, что у команд, без дедлоков). Документ `consumption` с `source_ref`, `order_id` (только для облака), `recipe_snapshot` (связи и ревизии техкарт) и движениями `stockEffect('waste')`.
   - Нехватка: `blocked/INSUFFICIENT_STOCK` с дефицитом по ингредиентам и повтором после прихода или подсчёта.
   - `dry_run` пишет `previewed` и потребность без движений. Проверка связей на Т7.
   - Ручной `consume` при включённом режиме отвечает `AUTOCONSUME_ACTIVE`.
   - Воркер `services/api/src/stock-consumption-worker.ts` (`--once`, тик 30 с, флаг) работает под ролью API.

**Контракт с полосой POS** (cloud-NEXT `pos_sales_sync`, нужно для отчётов, не для Ск2):

- `cloud_pos_sales(order_id, branch_id, device_id, shift_id, sold_at, sales_channel, service_mode, revenue_kind, total_minor, discount_minor, external_order_ref, state)`.
- `cloud_pos_tenders(order_id, method, amount_minor)`.
- `cloud_pos_refunds(order_id, kind, amount_minor, reason_code, approved_by_staff_id, created_at)`.
- `cloud_pos_shift_reports`.
- Методы - ровно 8 по решению владельца 2: `cash, kaspi_terminal, kaspi_manual, aggregator_yandex, aggregator_glovo, chocofood, staff_meal, marketing`. В design-pos ChocoFood пока «не переносим» - это нужно согласовать.
- `approved_by_staff_id` равен `edgeStaffId(employee_id, role)`.
- Без этих таблиц (`to_regclass`) отчёт строится по `pos_order_sync_projection`, без разбивки по оплатам, и показывает `coverage.pos_tenders=false`.

**Состав кассы.**

- `edgeStaffId(e, r) = uuid(sha256('pickchick-edge-staff-v1:'+e+':'+r))` - по образцу `localCatalogId`.
- `scripts/staff-roster-apply.mjs --file roster.json [--apply --expected-plan H]`: заводит отсутствующих (`provisionStaff`). При смене роли отзывает старый id (`revokeStaff`) и заводит новый. Уволенных и снятых с доступа отзывает. Bootstrap-файлы 0600, как в `staff-setup.mjs`.
- `scripts/staff-pin-batch.mjs` - цикл по `staff-pin-setup` с именем сотрудника на экране.

**Начальные остатки.** `scripts/stock-opening-import.mjs --csv F --branch B [--apply --expected-plan H]`.

- Колонки: `ingredient_id|name; quantity; unit(кг|л|шт|г|мл); total_value_tenge`. Имена сопоставляются только однозначно.
- Порции по 100 строк, `request_id = uuid(planHash+chunk)`. Перед повтором результат перечитывается, как в `ttk-import.mjs`.

## 5. UI (`apps/backoffice`, RU)

- **Остатки.**
  - Кнопки «Поставка», «Списание», «Инвентаризация» (`inventory.ts:254-256`), плюс «Подсчёт на закрытии» и «Сторно».
  - Списание: плитки `quick_waste` («Фингерсы из шкафа», «Мясо», «Фри», «Булки»), количество, обязательная «Причина: Тепловой шкаф: старше 50 минут | Мясо: старше 3 дней | Брак | Заготовка: истёк срок | Упало / повреждено | Возврат после приготовления | Переделка | Другое». Пустая причина: «Укажите причину списания».
  - Поставка: «Откуда: Цех | Пекарня | Хозтовары | Поставщик», «Номер и дата накладной».
  - Сторно: «Сторно создаст обратный документ. Исходный останется в истории».
- **Связи меню (Остатки → «Списание по продажам»).**
  - Таблица товаров и вариантов каталога: «Связь со складом», «Статус: Черновик | Утверждено», фильтр «Без связи: N».
  - Комбо без своей связи показаны как «Из состава комбо».
  - Переключатель «Списание по продажам: Выключено | Проверка без списания | Включено с ДД.ММ ЧЧ:ММ» с подтверждением.
  - Очередь: «Не списано: 3 · нет связи: Бургер Острый · не хватает: Булка (нужно 2 шт, есть 0)», кнопки «Повторить», «Пропустить с причиной».
- **Отчёты.** Вкладки «Продажи | Списания | Расхождения подсчёта». Плашка покрытия: «Касса: оплаты по способам ещё не поступают» или «Данные кассы получены в 23:41». Под таблицей - «Как считается»: «Средний чек - сумма оплаченных чеков / число чеков, до возвратов; питание сотрудников и маркетинг не входят в выручку».
- **Смены.**
  - Вкладка «Смена менеджера»: «Открыть смену» → чек-лист открытия. Днём - карточка «Смена открыта · менеджер ...» с авто-показателями.
  - «Закрыть смену» → мастер по пунктам: статус «Готово | Есть проблема | Не применимо», комментарий обязателен для двух последних.
  - Пример авто-пункта: «Кассовые смены: 2 из 2 закрыты, расхождение -500 ₸ пояснено».
  - Нет WAN на точке: «Данные кассы не поступают с 21:10. Подтвердите вручную».
  - Без передачи смены: «Заполните передачу смены».
  - «Управленческий журнал» скрывается при флаге, старые записи остаются только для чтения.
- **Сотрудники.**
  - Поле «Должность» - список из 11, «Доп. станции», «Доступ к кассе: Нет | Кассир | Начальник смены».
  - Колонка «Доступы»: «Касса (PIN), экраны 2-6 общим входом».
  - Кнопка «Выгрузить состав для кассы».
- **Роли.** Шапка «Вы: начальник смены». Разделы «Финансы» и «Начисления» скрыты, сервер отвечает 403 `ROLE_FORBIDDEN`.
- **P1.** Вкладка «Расстановка»: сетка станций 1-9.3 и сотрудники, «Переставить с 13:30». В табеле - полоса станций. Вкладка «Заявки».

## 6. Изменения по файлам

- `db/cloud/migrations/<cloud-NEXT>_bo_ops_cutover.sql` - §3.
- `packages/backoffice-core/src/`:
  - новые `roles.ts`, `positions.ts` (11 кодов, номер станции, роль edge, PIN, роль БО; функции KDS lane: breading, toasts, assembly_hall, assembly_delivery, issue, delivery_handover), `consumption.ts`, `consumption-store.ts`, `stock-v2.ts` (причины, meta, сторно, раскладка waste, counted_at), `manager-shifts.ts` (шаблоны v1 и авто-проверки), `sales-report.ts`, `stock-report.ts`, `edge-staff-id.ts`;
  - `model.ts` - Command, Ingredient, Recipe, Employee, ошибки;
  - `index.ts` - маршрутизация команд по правам, `read()` с permissions, ветки `stock` и `produce` (`RECIPE_POLICY_EXPLODE`);
  - `stops.ts` - `BackofficeOptions` и 5 флагов;
  - `finance.ts:203-208` и `workforce-store.ts:32-45` - effective role; shift_manager без финансов, начислений и ставок;
  - P1: `workforce.ts` (`WorkAssignment`), `workforce-store.ts` (`assignment`, `attendance_identity_save`, импорт по профилю).
- `services/api/src/`: `backoffice-controller.ts` (`GET ops/:view`), новый `stock-consumption-worker.ts`, `index.ts` (wiring).
- `apps/backoffice/`:
  - `src/inventory.ts` и `inventory-model.ts` - причины, поставщик, сторно, быстрые плитки, лимиты;
  - новые `src/menu-links.ts`, `src/manager-shift.ts`, `src/sales-report.ts` и их `*-model.ts`;
  - `src/operations.ts` - разделы и gating по `permissions`;
  - `src/workforce.ts` - должности и выгрузка состава;
  - `src/api.ts`;
  - `server.mjs` - allowlist `ops/*`.
- `scripts/`: новые `staff-roster-apply.mjs`, `staff-pin-batch.mjs`, `stock-opening-import.mjs`; `backoffice-setup.mjs` (`--designation shift_manager|accountant|none`, для бухгалтера также `reconciliation-accountant`).
- `infra/staging/`: новый `backoffice-ops-grants.mjs` (свои таблицы, `SELECT` на `cloud_pos_*` при наличии, `catalog_menu_deliveries`, `catalog_publications`); `provision.mjs` - вызов после `manualRefundGrants`; owner-шаг миграции по образцу `stage2-cloud-owner.mjs`; unit/systemd или compose для воркера.
- `infra/public-staging/gateway.Caddyfile:67` - регулярка `ops/(sales|stock|consumption|menu-links|manager-shifts)`.
- `docs/operations/backoffice-cutover.md` (runbook 18-19.11), `docs/project-status.md`, `docs/roadmap/project.json`, ADR-0008 (дополнение: роли и автосписание).

## 7. Флаги и безопасный выпуск

Все флаги по умолчанию `false`. Миграция только добавляет. Касса и кухня не меняются.

| Флаг (API env)                         | Что включает                                                      |
| -------------------------------------- | ----------------------------------------------------------------- |
| `BACKOFFICE_ROLES_ENABLED`             | назначения ролей; без флага назначение игнорируется               |
| `BACKOFFICE_STOCK_V2_ENABLED`          | причины, meta, сторно, раскладка waste, связи меню, отчёты склада |
| `BACKOFFICE_STOCK_AUTOCONSUME_ENABLED` | воркер; дальше нужен `bo_stock_settings.autoconsume_mode` точки   |
| `BACKOFFICE_MANAGER_SHIFTS_ENABLED`    | чек-листы смены менеджера                                         |
| `BACKOFFICE_SALES_REPORT_ENABLED`      | отчёт продаж                                                      |
| `BACKOFFICE_MANUAL_REFUNDS_ENABLED`    | существует (У3)                                                   |

**Совместимость.**

- Новый кабинет со старым API получает 404 на `ops/*` и прячет разделы. Новые поля payload он шлёт только при `capabilities.stock_v2`: строгие схемы старого API их отклонят.
- Старый кабинет с новым API работает: `role`, формы и команды прежние.

**Порядок.**

1. Code freeze 12.11.
2. Серверное окно: cloud 069-072, cloud-NEXT POS, затем наш cloud-NEXT и гранты с флагами `false`. Smoke прежних разделов.
3. 13.11: `ROLES`, `STOCK_V2`, `MANAGER_SHIFTS`, `SALES_REPORT`. Назначения управляющему, начальникам смен и бухгалтеру. `MANUAL_REFUNDS` после Т1.
4. 13-17.11: шеф заполняет связи, `AUTOCONSUME=true`, режим `dry_run`. На Т7/Т8 сверяем `previewed` с ожиданием шефа.
5. 18.11 вечером: инвентаризация, `stock-opening-import`, проверка итога с бухгалтером.
6. 19.11 00:00: режим `on`, `start_at` = время окончания ввода остатков.

Если включаем позже, воркер догоняет продажи с `start_at` по порядку. Подсчёты между ними учитываются правилом поглощения.

**Откат.** Режим `off` или флаг `false`. Документы остаются, ошибочные исправляются сторно. Edge не затронут.

## 8. Тесты

**Новые**

- `packages/backoffice-core/tests/`:
  - `roles.test.mjs`: матрица прав; analyst без флага неизменен; shift_manager получает 403 на финансы и ставки.
  - `stock-v2.test.mjs`: причина обязательна; сторно один раз; `COUNTED_AFTER_DOCUMENT`; раскладка waste; необязательные ревизии; прежние команды дают прежний результат.
  - `consumption-unit.test.mjs`: векторы дробей и округления, комбо до 5 уровней, `linked_product_id`, цикл, хэши кассы в slug.
  - `consumption.test.mjs` (PostgreSQL):
    - `pos_sale` в работе кухни списывается ровно один раз, повтор тика не дублирует;
    - void до кухни не списывается;
    - нехватка блокирует, после прихода заказ применяется;
    - опоздавшая продажа после подсчёта поглощается;
    - граница `start_at`; `dry_run` без движений;
    - skip пишет аудит;
    - гонка с ручной командой;
    - ограниченная роль БД.
  - `manager-shifts.test.mjs`: одна открытая смена; закрытие без обязательных пунктов отклоняется; закрытая неизменна; точный повтор запроса.
  - `sales-report.test.mjs`: фикстуры POS и облака; без таблиц POS; часы и дни по Алматы.
- `tests/backoffice/ops-http.test.mjs` (маршруты, прокси, флаги выкл.), `ops-browser.test.mjs` (1440 и 393 px: списание, чек-лист, связи), `tests/unit/backoffice-ops-grants.test.mjs`.
- `tests/integration/staff-roster.test.mjs` (edge: план и хэш, детерминированные id, смена роли, повтор), `tests/integration/stock-opening-import.test.mjs`.

**Существующие:** `pnpm check`, `pnpm --filter @pickchick/backoffice-core test test:integration`, `pnpm test:backoffice`, `test:commerce`, `test:pos-order-sync`, `test:fulfillment-transport`, `tests/backoffice/finance*.test.mjs`, `reconciliation-*.test.mjs`, `workforce*`, `tests/integration/stage2-cross-lane.test.mjs`, `stage2-cloud-owner.test.mjs`, `python3 -m unittest discover -s tests/operations` (fixtures со списками миграций).

## 9. Зависимости и общие файлы

**Полоса POS.**

- Расширение `pos_order_sync_projection` (`pos_sale`, `paid`) нужно Ск2.
- `cloud_pos_*` по контракту §4 нужны отчётам и чек-листу.
- 8 методов оплаты и `edgeStaffId` для подтверждающего.
- Получатель питания сотрудника - `employee_id` из выгрузки состава (P1).

**Полоса KDS.**

- Коды функций станций для `positions.ts`.
- `kds_edge_events` (их P1) нужны для пункта «Инциденты курьеров» и для КД9 по людям через А9.

**Каталог (М1, М2, Аг4).** Стабильные slug и `combo_components` до того, как шеф начнёт связи. Смена slug ломает связь: позиция показывается как «без связи».

**Ops.** Б3/Б4 - личные аккаунты в accounts-файле, окно сервера, воркер в compose или systemd.

**Общие файлы.** `packages/backoffice-core/src/{model,index,stops,finance,workforce-store,workforce}.ts`, `apps/backoffice/src/{operations,inventory,inventory-model,workforce,api}.ts`, `apps/backoffice/server.mjs`, `services/api/src/{backoffice-controller,index}.ts`, `infra/staging/provision.mjs`, `infra/public-staging/gateway.Caddyfile`, документы статуса. Перед изменениями - claim через `scripts/project-sync.mjs`.

## 10. Приоритеты

**P0 (к 19.11)**

- P0-1: роли БО (А12, У4, роли для Б4).
- P0-2: должности и состав кассы с PIN (А8, Д3).
- P0-3: склад v2 (Ск1, Ск5).
- P0-4: начальные остатки (Д5).
- P0-5: автосписание (Ск2).
- P0-6: закрытие смены и подсчёт ключевых позиций (А11, Ск7-минимум).
- P0-7: отчёты продаж, списаний и расхождений.
- P0-8: миграция, гранты, флаги, включение У3, runbook.

**P1 (желательно до 19.11):** открытие смены (А10, шаблон на том же механизме), расстановка (А9), заявки (Ск6), методы агрегаторов в сверке (У5), подсчёт задним числом, упаковка по типу заказа, отчёт «подтверждения менеджеров», CSV-импорт должностей, инциденты из KDS.

**P2:** ZKTeco (А7) после образца выгрузки (по трекеру к 30.11 - фактически P1 после ответа владельца), edge-владение складом, несколько складов и перемещения, партии и FEFO, таймер шкафа (Ск9), прогноз (Ск8), рекомендации заказа (Ск4), автопроводки в ДДС и ОПиУ, заявка на списание с экрана кухни, live-адаптер BioCheck.

## 11. Оценка P0 (инженеро-дни)

| P0                                                                      | Дни       |
| ----------------------------------------------------------------------- | --------- |
| P0-1 Роли и права                                                       | 1,0       |
| P0-2 Должности, выгрузка, roster и PIN                                  | 1,25      |
| P0-3 Склад v2                                                           | 1,5       |
| P0-4 Начальные остатки                                                  | 0,5       |
| P0-5 Автосписание (связи и UI, движок, очередь, воркер, отчёт покрытия) | 2,75      |
| P0-6 Смена менеджера и подсчёт                                          | 1,25      |
| P0-7 Отчёты                                                             | 1,5       |
| P0-8 Выпуск и ops                                                       | 0,75      |
| **Итого**                                                               | **≈10,5** |

Это два инженера на 5-6 дней. Без инженеров: шеф заполняет связи (примерно 54 позиции и варианты, 3-4 часа), инвентаризация 18.11.

## 12. Риски и вопросы владельцу

**Риски**

1. Если связи не утверждены к 18.11, Ск2 будет блокировать продажи и остатки будут неверны. Решение: включать `on` только при покрытии ≥95 % строк продаж в `dry_run`, иначе позже, с догоном от `start_at`.
2. TTK и меню расходятся (фингерс 1 шт против 5 шт, коулслоу). Связь задаёт шеф, по названию ничего не угадываем.
3. Полуфабрикаты с `stock` без документов производства постоянно уходят в `blocked`. По умолчанию `explode`. Список `stock` утверждает шеф.
4. Без WAN на точке данные кассы опаздывают. Кабинет при этом доступен с телефона по мобильному интернету. Опоздавшие продажи поглощаются подсчётом. Подсчёт до последней продажи даёт шум в расхождении (P1 - подсчёт задним числом).
5. Округление раскладки - не больше 0,5 единицы на ингредиент на заказ. Видно в расхождениях.
6. Нулевая стоимость в начальных остатках искажает себестоимость. Импорт требует стоимость по каждой строке.
7. Отчёты зависят от cloud-NEXT полосы POS. Без него нет разбивки по оплатам.
8. Окно сервера перегружено: 069-072, POS и наша миграция.

**Вопросы**

1. Кто начальники смен (имена) и будут ли они работать в кабинете с телефона? Должны ли они видеть финансы (мы предлагаем - нет)?
2. Подтвердите 11 должностей (в списке трекера 10 станционных; 11-я - управляющий?). Может ли человек работать на нескольких станциях?
3. Четыре склада iiko (хоз, кухня, бар, мороженое) - один склад PickChick с группами позиций? Переносим ли хоз склад?
4. Что поставляет цех (Р18): сырьё или готовые полуфабрикаты? Какие заготовки ведутся как запас (соусы, панированное филе)?
5. Списание из теплового шкафа - в штуках фингерсов? Нужна техкарта «1 жареный фингерс» от шефа.
6. Инвентаризация 18.11: кто считает, откуда стоимость (средняя себестоимость iiko?), во сколько заканчиваем ввод?
7. Ключевые позиции ежедневного подсчёта: мясо, филе, фри, булки, соусы, напитки?
8. Кто делает ручные возвраты в Kaspi Pay (Р7)? Разрешать ли это бухгалтеру?
9. Бухгалтер: логин, приёмка приходов, план счетов (У6)?
10. Бизнес-день - календарные сутки Алматы, как в сверке? Смена менеджера через полночь относится к дню открытия?
11. Образец выгрузки ZKTeco/BioCheck и модель устройства (А7).
12. Питание сотрудников: нужен ли отчёт по сотрудникам и лимит?
