# Дополнение дизайна: полоса bo-ui (экраны P1 бэк-офиса за флагами)

Полоса: bo-ui (ветка `codex/cutover-bo-ui`, от итога облачной полосы 43806cf4). Дата: 06.11.2026.
Основание: решение владельца 05.11 - экраны бэк-офиса, которые контракт перенёс в P1 (R7, R8, P1 в
§1.2 и §4), делаются сейчас, до 19.11, за флагами, которые по умолчанию выключены. Плюс исправления
по полному аудиту бэк-офиса (F01-F20) и разрыв с iiko (шаги P0-0...P0-6).
Порядок важности: контракт §00 → `owner-decisions.md` → дополнение контракта для полосы bo-ui →
этот документ → `design-backoffice.md` §2-8. Где здесь не сказано иначе, действует `design-backoffice.md`.

## 1. Объём

Делается сейчас (все пункты - за флагами §2, при выключенных флагах кабинет и API прежние):

| Блок            | Что                                                                                                                                                                                                          | Флаг                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Касса           | раздел «Касса»: вкладки «Смены и Z», «Чеки», «Webkassa», CSV; `GET ops/pos-day`; новая «Главная» (выручка из `ops/sales`, открытые смены и неоформленные чеки из `ops/pos-day`); имена кассиров вместо кодов | `BACKOFFICE_POS_DAY_ENABLED`           |
| Склад           | сторно документа, вкладки «Расхождения подсчёта» и «Списание по продажам» в отчётах склада, быстрые плитки списания и списание по выходу ТТК, связи «позиция меню - склад»                                   | `BACKOFFICE_STOCK_V2_ENABLED` (есть)   |
| Автосписание    | воркер, настройки точки `off / dry_run / on` и `start_at`, очередь с причинами, повтор и пропуск                                                                                                             | `BACKOFFICE_STOCK_AUTOCONSUME_ENABLED` |
| Смена менеджера | открытие и закрытие смены по чек-листу, авто-проверки, передача смены                                                                                                                                        | `BACKOFFICE_MANAGER_SHIFTS_ENABLED`    |
| Персонал        | должности (11), доп. станции, доступ к кассе, выгрузка состава; `scripts/edge-staff-id.mjs`, `staff-roster-apply.mjs`, `staff-pin-batch.mjs`                                                                 | `BACKOFFICE_STAFF_POSITIONS_ENABLED`   |
| Скидки          | только редактор: создать, изменить, включить, архивировать. Касса скидки пока не применяет (P1 полосы pos), на edge ничего не публикуется                                                                    | `BACKOFFICE_DISCOUNTS_ENABLED`         |
| Аудит           | исправления F01-F20 (§6)                                                                                                                                                                                     | см. §6                                 |

Не делается в этой полосе: расстановка (А9), импорт ZKTeco (А7), заявки (Ск6), методы сверки
агрегаторов (У5), раскладка KDS из кабинета. Их таблицы (`bo_attendance_*`, `bo_supply_requests`,
kind `assignment`) в 075 не входят. Расстановку, заявки, поставщиков с ценами и отчёты склада делает
вторая волна (полоса bo-ui2, миграция 076) - §9.

Опорные данные: продажи кассы - таблицы 073 (`cloud_pos_*`, приёмник CC-4), отчёт продаж - CC-7
(`ops/sales`), роли - CC-5 (`roles.ts`), склад v2 - CC-6 (`stock-v2.ts`, `ops/stock`).

Разрыв с iiko (`iiko-gap.md`, план P0-0...P0-6) по шагам полосы (§7). Отдельный флаг «Кассы» ввело
решение владельца 05.11 (`BACKOFFICE_POS_DAY_ENABLED`) вместо `BACKOFFICE_SALES_REPORT_ENABLED` из плана.

| iiko-gap | Что                                                                             | Где                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| P0-0     | старт и CR                                                                      | шаг 1, CR `bo-ui-1`                                                                                                                   |
| P0-1     | `GET ops/pos-day`                                                               | шаг 2                                                                                                                                 |
| P0-2     | раздел «Касса»: «Смены и Z», «Чеки», «Webkassa», три CSV                        | шаг 3                                                                                                                                 |
| P0-3     | «Главная» и честные тексты (названия состояний, каналов, способов; P0-8, P0-13) | шаг 3                                                                                                                                 |
| P0-4     | отчёт списаний по причинам                                                      | API - облачная полоса (CC-6: `ops/stock?view=waste\|movement`); шаг 4: сторно в отчёте, вкладки «Списания» и «Движение», по дням, CSV |
| P0-5     | `edgeStaffId` и `scripts/edge-staff-id.mjs`                                     | шаг 2                                                                                                                                 |
| P0-6     | проверка и выпуск                                                               | шаг 8                                                                                                                                 |

## 2. Флаги и совместимость

Все - env API, `true|false`, по умолчанию `false`, только облачный API с `BACKOFFICE_ENABLED=true`
(проверяет `loadConfig`, `packages/platform/src/config.ts`, список `BACKOFFICE_P1_FLAGS`). Поле
`ServiceConfig` появляется только при включённом флаге; кабинету флаги передаёт
`backofficeP1Options(config)` (`packages/backoffice-core/src/p1-flags.ts`).

| Флаг                                   | `capabilities` в `GET branches/:id` (только при `true`) | Значение ключа                                                                                                                                              | Зависит от                    | Откат                                            |
| -------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------ |
| `BACKOFFICE_POS_DAY_ENABLED`           | `pos_day`                                               | всегда `true`: без 073 вид отвечает `coverage.pos_tables=false`                                                                                             | -                             | `false`                                          |
| `BACKOFFICE_STOCK_AUTOCONSUME_ENABLED` | `stock_autoconsume`                                     | склад v2 и `stock_p1` (шаг 5: связи), таблицы 075 настроек и очереди доступны роли на запись                                                                | `BACKOFFICE_STOCK_V2_ENABLED` | режим `off` или флаг `false`; документы остаются |
| `BACKOFFICE_MANAGER_SHIFTS_ENABLED`    | `manager_shifts`                                        | `bo_manager_shifts` на запись и `bo_branch_templates` на добавление (шаг 6)                                                                                 | -                             | `false`; смены остаются                          |
| `BACKOFFICE_STAFF_POSITIONS_ENABLED`   | `staff_positions`                                       | всегда `true` (поля карточки); список должностей правится при `bo_branch_templates` (`staff_positions.editable`)                                            | -                             | `false`; поля в карточке остаются                |
| `BACKOFFICE_DISCOUNTS_ENABLED`         | `discounts`                                             | `bo_discounts` на запись и история на чтение                                                                                                                | -                             | `false`                                          |
| `BACKOFFICE_STOCK_V2_ENABLED` (есть)   | `stock_p1` (шаг 4, последний ключ)                      | только `true` и только при флаге **и** `stockP1Ready` (колонки 075 склада и права helper-а P1 со `stockV2`); иначе ключа нет, ответ - как у облачной полосы | 075 и helper P1               | `false` или helper P1 со `stockV2=false`         |

Ключи P1 идут после ключей облачной полосы в порядке таблицы. Правила совместимости:

1. **Все флаги выключены** (включая склад v2) - ответы API, поведение БД и кабинет байт-в-байт как у
   итога облачной полосы. Доказательство - тесты `tests/integration/backoffice-p1-flags.test.mjs`
   (конфиг, `GET branches/:id` с флагами облака и без, строки во всех таблицах 075 не видны, HTTP),
   `packages/backoffice-core/tests/p1-schema.test.mjs` (`GET branches/:id`, `ops/stock` и строки
   одинаковы до и после 075). Каждый следующий шаг добавляет свой тест «флаг выключен - прежний ответ».
2. Новый вид `ops/<view>` при выключенном флаге - ровно 404 неизвестного вида (`NOT_FOUND` без
   причины). Новая команда при выключенном флаге - ровно `INVALID_REQUEST` неизвестного типа:
   команды P1 разбираются отдельной схемой только при включённом флаге, общая `Command` не меняется.
3. Новые поля существующих payload (`Employee.position_code`, `Ingredient.quick_waste`, строка
   списания `recipe_output_id`) принимаются только при флаге; без флага строгие схемы отклоняют их
   как сегодня. Кабинет шлёт их только при соответствующем ключе `capabilities`.
4. Новый кабинет со старым API: ключа нет или `ops/*` отвечает 404 - раздел скрыт, текст «Раздел
   появится после обновления сервера» не показывается без нужды (раздел просто не виден).
5. `permissions[]` (при `BACKOFFICE_ROLES_ENABLED`) получает права P1 (§4) только при включённом флаге
   функции; без флагов P1 список прежний.

## 3. Миграция 075 (`db/cloud/migrations/075_cloud_backoffice_ops.sql`)

Имя без цифр после префикса: `migrate()` применяет только `^\d{3}_[a-z_]+\.sql$` (R11), поэтому не
`_p1`. Только добавления, без FK на `cloud_pos_*`, права - только `infra/staging/backoffice-p1-grants.mjs`.
DDL заморожен 10.11: дальше файл только дополняется, если тест докажет пробел, смысл не меняется.

| Объект                                  | Содержание                                                                                                                                                                 | Инварианты (БД)                                                                                                                                                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bo_stock_documents`                    | `source_ref` (`pos:<uuid>` или `cloud:<uuid>`), `reverses_document_id`; kind += `reversal`                                                                                 | сторно - один раз на документ, той же точки, сторно сторно запрещено, у сторно нет `order_id` и `reason_code`; `source_ref` только у `consumption`: `pos:` без `order_id`, `cloud:` = `order_id`; один `consumption` на заказ (`source_ref`; прежний индекс по `order_id` тоже действует) |
| `bo_stock_balances.counted_at`          | время последнего подсчёта позиции                                                                                                                                          | только вперёд, не сбрасывается; прежние обновления остатка его не трогают                                                                                                                                                                                                                 |
| `bo_stock_settings`                     | `autoconsume_mode off/dry_run/on`, `start_at`                                                                                                                              | `dry_run`/`on` требуют `start_at`; нет строки = `off`                                                                                                                                                                                                                                     |
| `bo_menu_stock_links`                   | связь товара или опции каталога (slug) со складом: `effect consume/none`, `lines` 0..50, `status draft/approved`                                                           | ключ = `product[:group:option]`; `none` ⇔ пустые строки; изменение `effect`/`lines` возвращает в `draft`, утверждение их не меняет                                                                                                                                                        |
| `bo_consumption_items`                  | очередь автосписания: заказ кассы или облака, состояние, причина, документ                                                                                                 | `applied`, `skipped`, `not_required` - конечные; `applied` ⇔ документ, и это `consumption` именно этого заказа; `blocked/skipped/not_required` с причиной                                                                                                                                 |
| `bo_manager_shifts`                     | смена менеджера: `opening`, `closing` (jsonb), `template_version`                                                                                                          | одна открытая на точку; `business_date` = дата открытия по Алматы (смена после полуночи - день открытия); закрытая содержит `closing.handover` (3+ символа) и неизменна                                                                                                                   |
| `bo_branch_templates` (шаг 6, раздел 8) | версии списков, которые правит управляющий: чек-лист смены (`manager_shift`: `opening`, `closing`) и должности (`staff_positions`)                                         | версия 1 - встроенная в коде, строки с версии 2; только добавление (`commerce_immutable`); смена с `template_version > 1` ссылается на существующую версию (триггер)                                                                                                                      |
| `bo_discounts`, `bo_discount_revisions` | скидка: сумма в тиынах или процент в базисных пунктах (10000 = 100 %), `scope`, `schedule`, `requires_manager_pin=true`, `combinable=false`, `state draft/active/archived` | `archived` конечна; живые названия точки уникальны без учёта регистра; каждую ревизию пишет триггер владельца в историю, роль API историю не пишет                                                                                                                                        |

Общие правила таблиц 075: первая ревизия 1, каждое изменение +1, ключевые колонки неизменны, удалений
нет (триггер `guard_bo_revision`).

**Решение по сторно списания по продаже.** Документ `consumption` на заказ один навсегда (индекс по
`source_ref`), позиция очереди после `applied` не возвращается в `pending`. Ошибочное автосписание
исправляется командой `stock_reverse` (остатки возвращаются, позиция остаётся `applied`, в очереди видно
«Списано, затем сторно»), фактический расход - подсчётом (правило поглощения). Команды
`consumption_reverse` из `design-backoffice.md` §4 нет. Так двойное списание одного заказа невозможно
на уровне БД.

Права (`backoffice-p1-grants.mjs`, вызывается последним в `provision.mjs`, CR `bo-ui-1`): связи - при
складе v2; настройки и очередь - при автосписании и складе v2; смены - при флаге смен; скидки - при
флаге скидок (история только чтение). DELETE/TRUNCATE не выдаются. Дополнительно чтение `cloud_pos_*`
для «Кассы» и `cloud_pos_sales`, `catalog_menu_deliveries`, `catalog_publications` для воркера.

## 4. Права (матрица §5.10 + P1)

Чтение всех новых видов - `reports.read` (все четыре роли), кроме `ops/staff-roster` (только manager).

| Право                     | manager | shift_manager | accountant | analyst | Команды                                                  |
| ------------------------- | ------- | ------------- | ---------- | ------- | -------------------------------------------------------- |
| `stock.reverse`           | да      | -             | да         | -       | `stock_reverse`                                          |
| `menu_links.write`        | да      | -             | -          | -       | `menu_link_save`                                         |
| `menu_links.approve`      | да      | -             | -          | -       | `menu_links_approve` (шеф утверждает через управляющего) |
| `stock.settings`          | да      | -             | -          | -       | `stock_settings`                                         |
| `consumption.write`       | да      | да            | -          | -       | `consumption_retry`, `consumption_skip`                  |
| `manager_shifts.write`    | да      | да            | -          | -       | `manager_shift_open`, `_save`, `_close`                  |
| `manager_shifts.template` | да      | -             | -          | -       | `manager_shift_template` (шаг 6)                         |
| `staff.positions`         | да      | -             | -          | -       | поля должности в карточке, `ops/staff-roster`            |
| `discounts.write`         | да      | -             | -          | -       | `discount_save`, `discount_state`                        |

Сделано в шаге 4: `stock.reverse` - отдельный список P1 (`BACKOFFICE_P1_PERMISSIONS`,
`P1_ROLE_PERMISSIONS` в `roles.ts`), в `BACKOFFICE_PERMISSIONS` не входит: `permissions[]` получает его
только при `stock_p1`, без флагов список прежний. Без `BACKOFFICE_ROLES_ENABLED` решает грант
(manager - да, analyst - `FORBIDDEN`).

Сделано в шаге 5: `menu_links.write`, `menu_links.approve` (управляющий) приходят в `permissions[]` со
складом P1, `stock.settings` (управляющий) и `consumption.write` (управляющий, начальник смены) - при
доступном автосписании; порядок списка - `BACKOFFICE_P1_PERMISSIONS`.

Сделано в шаге 6: `manager_shifts.write` (управляющий, начальник смены) и `manager_shifts.template`
(управляющий, новое право для версии чек-листа) - при доступной смене менеджера; `staff.positions`
(управляющий: поля карточки, список должностей, `ops/staff-roster`) - при флаге должностей. Порядок -
`BACKOFFICE_P1_PERMISSIONS`. Отказ в выгрузке состава для начальника смены - `ROLE_FORBIDDEN`.

Сделано в шаге 7: `discounts.write` (только управляющий: решение владельца - скидки делаются только в
бэк-офисе) приходит в `permissions[]` последним, пока редактор доступен (`capabilities.discounts`:
флаг и права helper-а P1). Начальник смены и бухгалтер получают `ROLE_FORBIDDEN`, аналитик -
`FORBIDDEN`; без `BACKOFFICE_ROLES_ENABLED` решает грант.

Сторно: `design-backoffice.md` противоречит сам себе (§2 А12 - «сторно ... только manager и
shift_manager», там же и в таблице §4 - бухгалтер делает сторно, `stock_reverse` m/acc). Принято по
таблице §4: manager и accountant; вопрос владельцу - §8 в.2.

Быстрое списание и списание по выходу ТТК - существующее `stock.waste`. Без `BACKOFFICE_ROLES_ENABLED`
всё решает грант: manager - всё, analyst - только чтение (как сегодня). Отказ - `FORBIDDEN`
(`ROLE_FORBIDDEN` для назначенных ролей). Кабинет скрывает кнопку, если права нет, а если кнопка видна,
но недоступна - объясняет словами («Сторно делают управляющий и бухгалтер»).

## 5. API

Чтение - `GET /v1/admin/backoffice/branches/:id/ops/<view>` (один снимок REPEATABLE READ), запись -
существующий `POST .../commands` (`request_id`, digest, `bo_audit`, блокировка точки
`bo:branch:<id>`, `expected_revision`). Деньги - строки целых тиын. Даты - `YYYY-MM-DD` календаря
Алматы, время - ISO UTC. Новые виды добавляются в регулярку `infra/public-staging/gateway.Caddyfile` и
allowlist `apps/backoffice/server.mjs` (точные ключи query, предел ответа как у `ops/sales`).

Новые причины ошибок (`BackofficeErrorReasonSchema`, только при флагах): `COUNTED_AFTER_DOCUMENT`,
`REVERSAL_NOT_ALLOWED`, `ALREADY_REVERSED`, `RECIPE_POLICY_EXPLODE`, `AUTOCONSUME_ACTIVE`,
`LINK_NOT_APPROVED`, `CHECKLIST_INCOMPLETE`, `HANDOVER_REQUIRED`, `MANAGER_SHIFT_OPEN`,
`DISCOUNT_NAME_TAKEN`, `DISCOUNT_ARCHIVED`, `DISCOUNT_PERIOD_ENDED` (два последних - шаг 7).

### 5.1 `GET ops/pos-day?date=YYYY-MM-DD[&terminal_id=uuid]` (`BACKOFFICE_POS_DAY_ENABLED`)

День - календарный день Алматы. Смена кассы, закрытая после полуночи, относится к дню открытия, и её
продажи тоже (продажа без известной смены - по `business_date`). Это отличается от «Продаж» (CC-7, по
времени продажи) - экран пишет об этом в «Как считается».

Сделано в шаге 2 (`packages/backoffice-core/src/pos-day.ts`). Ответ:

```text
{ schema_version: 1, branch_id, view: 'pos-day', date, terminal_id|null, timezone: 'Asia/Almaty',
  day_start, day_end, as_of,
  coverage: { pos_tables: bool, cashier_reports: bool,
              last_received_at: ts|null,                     // последняя запись 073 точки: «Данные кассы получены в 23:41»
              cashier_reports_at: ts|null },
  terminals: [{ terminal_id, label, first_seen_at|null }],   // «Касса 1», «Касса 2» по первой смене (Z и отчёты кассы)
  shifts: [{ shift_id, terminal_id|null, device_id|null,
             source: 'z'|'cashier_report'|'sales', state: 'open'|'closed'|'unknown',
             opened_at|null, closed_at|null, opened_by_staff_id|null, cashier_staff_ids: [id],
             cash: { opening_cash_minor, cash_in_minor, cash_out_minor, cash_sales_minor|null,
                     cash_refunds_minor|null, expected_cash_minor, counted_cash_minor|null,
                     discrepancy_minor|null } | null,
             terminal: { expected_minor, reported_minor|null, discrepancy_minor|null },  // Kaspi терминал
             z: ShiftReport|null, z_received_at|null, cashier_report_at|null,
             received: { sales_count, voided_count, sales_minor, refunds_minor,
                         methods: [{ method, count, sales_minor, refunds_minor }] },     // 8 способов
             fiscal: { pending, recorded, not_required },
             flags: { cash_discrepancy: bool, terminal_discrepancy: bool, fiscal_pending: int } }],
  totals: { sales_count, voided_count, checks, sales_minor, voids_minor, refunds_minor, revenue_minor,
            average_check_minor, no_revenue: { checks, total_minor, kinds: [{ revenue_kind, checks, total_minor }] } } | null,
  channels: [{ channel, checks, sales_minor, voids_minor, refunds_minor, revenue_minor, average_check_minor }],
  methods: [{ method, revenue: bool, payments, sales_minor, voids_minor, refunds_minor, net_minor }],  // 8 способов
  sales: [{ order_id, display_number, terminal_id, shift_id, device_id, cashier_staff_id, sold_at,
            business_date, of_day: bool, sales_channel, service_mode, channel, revenue_kind,
            external_order_ref|null, subtotal_minor, discount_minor, total_minor,
            cash_tendered_minor|null, change_minor|null, state: 'paid'|'voided', voided_at|null,
            beneficiary|null, reason|null, approval_manager_staff_id|null, lines,
            tenders: [{ tender_id, method, amount_minor, confirmation, reference|null }],
            refunds: [{ refund_id, kind: 'void'|'refund', amount_minor, reason_code, reason, staff_id,
                        approved_by_staff_id, shift_id, terminal_id|null, created_at, in_day: bool,
                        tenders: [{ method, amount_minor }] }],
            refunded_minor,
            fiscal: [{ receipt_id, kind, refund_id|null, state, receipt_number|null, version,
                       amount_minor, recorded_by_staff_id|null, recorded_at|null, in_day: bool }] }],
  fiscal_summary: { pending: { count, amount_minor }, recorded: { count, sales_minor, refunds_minor, net_minor },
                    not_required: { count, amount_minor, methods: [{ method, count, amount_minor }] } } | null,
  staff: { '<edge staff id>': { name, employee_id, role } },  // по edgeStaffId; нет карточки - id нет в карте
  limits: { sales: 2000, earlier_sales: 200 }, truncated: { sales: bool, earlier_sales: bool } }
```

`sales` - чеки дня (новые сверху) и, после них, более ранние чеки, по которым сегодня был возврат
(`of_day=false`, их деньги не входят в продажи дня). Выручка = продажи - отмены - возвраты дня
(`revenue_kind='revenue'`); питание персонала и маркетинг - в `totals.no_revenue` и своими способами
(`revenue=false`). Сумма способов с `revenue=true` равна `totals.revenue_minor` (тест). Чек - чек выручки
дня, не отменённый в тот же день; средний чек - их сумма / их число, половина вверх.

Без 073 или без прав на любую из шести таблиц - `coverage.pos_tables=false`, `totals`, `fiscal_summary` -
`null`, `sales`, `channels`, `methods` пустые; смены из отчётов кассы (033) всё равно в `shifts`. Экран пишет
«Облако ещё не получает продажи кассы», а не нули. Ошибки: `INVALID_REQUEST` (дата, `terminal_id`, лишние
ключи), 403 чужой точке, 404 без флага (вид неизвестен, как до полосы).

При флаге то же чтение добавляет в снимок `GET branches/:id` поля `pos_terminals`, `pos_staff`,
`cashier_metrics.paid_total_minor` и в строки кассы `terminal_id`; `payment_state` проданного на кассе
заказа - `captured`, `fiscal_state` - из 073 (CR pos-4 §2). Карточка заказа кассы получает `pos_sale`
(та же карточка чека), `pos_staff`, `pos_terminal`. Без флага - ни одного нового ключа (тест
`backoffice-p1-flags`).

### 5.2 `GET ops/stock?view=…&start_date&end_date` (склад v2; есть у облачной полосы)

Виды облачной полосы `waste`, `movement` не меняются, пока нет 075. При `stock_p1`:

- в `documents[]` добавляются `source_ref`, `reverses_document_id`, `reversed_by` (id сторно или `null`);
- `view=variance` - расхождения подсчёта: `rows: [{ ingredient_id, name, unit, counts, expected, counted,
delta_quantity, delta_value_minor }]` по документам `count` периода (ожидаемо = остаток до подсчёта),
  `by_day`, итоги; признак `count_scope` из `meta` (`daily_key` или `full`);
- `view=consumption` - списания по продажам: `by_day`, `by_ingredient`, `by_source` (`pos`, `cloud`,
  ручное `consume`), документы со `source_ref`.

Тест облачной полосы с точным списком ключей документа при складе v2 (`stock-v2.test.mjs`) обновляется
в шаге склада: без 075 ключи прежние.

**Сделано в шаге 4** (`packages/backoffice-core/src/stock-p1.ts`, `readStockOpsP1`; при `stock_p1`
вместо `readStockOps`, без него ответ облачной полосы):

- `documents[]` - прежние ключи, затем `source_ref`, `reverses_document_id`, `reversed_by` (id сторно
  или `null`), `reversed_at`, `reverses` (`{kind, reference, reason_code, created_at}` документа, который
  сторнирован, или `null`); те же ключи и `reason_code`, `meta` получает список `documents` в `GET
branches/:id`, а строки `stock` - `counted_at`;
- `view=waste` берёт и сторно списаний периода: сторно - отрицательная запись дня, в который его
  провели, с причиной и автором исходного списания (закрытые дни не меняются, дни складываются в
  период); `documents` - число списаний, `reversals` - число сторно, `value_minor` - нетто; то же в
  каждой строке `by_reason`, `by_day`, `by_author`; `by_ingredient` - нетто количества и суммы;
  прежнее списание без кода - строка `reason_code: null`;
- `view=movement` - сторно отдельным видом `reversal` в `by_kind`;
- без сторно ответ равен ответу облачной полосы плюс `reversals: 0` и пустые ссылки (тест).

Не сделано в шаге 4: `view=variance` и `view=consumption` (их данные появятся с подсчётом ключевых
позиций и автосписанием, шаги 5-6), `meta.count_scope`.

**Сделано в шаге 8** (`readStockOpsP1`, запрос `StockOpsQueryP1`; запрос облачной полосы
`StockOpsQuery` прежний, без склада P1 новые виды - `INVALID_REQUEST`, без склада v2 - 404
`STOCK_V2_DISABLED`; allowlist прокси и кабинета принимают оба вида):

- `view=variance`: документы `count` окна; `totals { documents, items, lines_with_difference,
shortage_value_minor, surplus_value_minor, delta_value_minor }`; `summary.rows [{ ingredient_id,
name, unit, counts, expected, counted, last_counted_at, delta_quantity, delta_value_minor }]` -
  `expected`/`counted` последнего подсчёта позиции в окне (ожидалось = `balance_after -
quantity_delta`), суммы - по всем подсчётам окна, сортировка по сумме (недостача сверху);
  `summary.by_day [{ day, documents, items, lines_with_difference, shortage_value_minor,
surplus_value_minor, delta_value_minor }]`;
- `view=consumption`: документы `consumption` и сторно их, как `waste`: `totals { documents,
value_minor, reversals }`, `summary.by_source [{ source: pos|cloud|manual, documents, reversals,
value_minor }]` (по `source_ref` исходного документа), `by_day`, `by_ingredient` (нетто);
- отклонение: `meta.count_scope` не сделан. Общая команда `stock` не меняется (её `meta` строгая и
  только для поставки), а отдельная команда подсчёта дала бы второй путь записи того же документа.
  Ключевые позиции определяет карточка (`count_daily`, §5.4), отчёт показывает позиции каждого
  подсчёта; вкладка отчёта называется «Расход по продажам», потому что «Списание по продажам» -
  уже вкладка связей и очереди (шаг 5).

### 5.3 Связи меню: `GET ops/menu-links` и команды (склад v2 + 075)

```text
GET → { schema_version: 1, branch_id, catalog: { version, published_at },
        items: [{ catalog_key, catalog_ref: { product_id, group_id?, option_id? }, kind: 'product'|'option'|'combo'|'set',
                  name_ru, product_name_ru, group_name_ru|null, linked_product_id|null,
                  link: { effect, lines: [{ ingredient_id|recipe_output_id, quantity, name, unit }],
                          status, revision, updated_by_name, updated_at, approved_by_name|null, approved_at|null }|null,
                  from_combo: bool }],                       // комбо без своей связи - «Из состава комбо»
        coverage: { items, linked, approved, without_link } }
menu_link_save    { catalog_ref, effect: 'consume'|'none', lines: [{ ingredient_id | recipe_output_id, quantity }], expected_revision }
menu_links_approve { keys: [catalog_key] (1..200), expected_revisions: { [catalog_key]: revision } }
```

Каталог - последняя публикация точки (slug, как `stopVariantId`). Строки: `ingredient_id` - позиция
склада; `recipe_output_id` - выход техкарты (`stock_policy`, `design-backoffice.md` §4).

**Сделано в шаге 5** (`packages/backoffice-core/src/consumption.ts`, `consumption-store.ts`; за
`stock_p1`, без него вид - 404 неизвестного вида при выключенном складе v2 и `NOT_FOUND`/
`STOCK_V2_DISABLED` без 075 или прав; команды - `INVALID_REQUEST` или `NOT_READY`/`STOCK_V2_DISABLED`):

- `items[]` - товары и опции головной публикации в порядке каталога: `catalog_key`, `catalog_ref`,
  `kind` (`product`/`option`/`combo`/`set`), имена, `linked_product_id` (у опции - товар, который она
  означает: `linked_product_id` каталога или товар с тем же slug, правило стоп-листа menu-sync),
  `listed`, `from_combo` (комбо или набор без своей связи с составом), `covered_without_link`, `link`
  (строки с именем и единицей позиции, `updated_by_name`, `approved_by_name`); `orphans[]` - связи
  slug, которых нет в головном каталоге; `coverage { items, linked, approved, without_link }` по
  позициям в продаже. Без публикации или без права чтения `catalog_publications` - `catalog: null`.
- `menu_link_save`: позиция должна быть в головном каталоге (`NOT_FOUND`/`CATALOG_ITEM_NOT_FOUND`),
  строка - существующая позиция склада, `recipe_output_id` - выход ровно одной техкарты точки
  (`INVALID_REQUEST`), количество - целое 1..999999999 в единице позиции, без повторов, 0..50 строк,
  `none` ⇔ без строк. Новая или изменённая связь - черновик; сохранение без изменений (сравнение jsonb)
  сохраняет утверждение. `menu_links_approve` - каждая связь на показанной ревизии (`CONFLICT`),
  утверждённая остаётся как есть. Права - `menu_links.write`, `menu_links.approve` (управляющий).
- Отклонение от текста выше: `recipe_output_id` - id позиции склада, которая является выходом
  техкарты (а не id техкарты): шеф выбирает «Котлета (выход ТТК)», вложенные строки ТТК ссылаются
  на те же позиции. `ingredient_id` списывает позицию как есть, `recipe_output_id` - по `stock_policy`
  техкарты: `explode` - строки × q / выход, рекурсивно до 6 уровней, вложенные выходы по своей
  политике; `stock` - сам выход. `stock_policy` принимает `save` техкарты при складе P1 (`RecipeP1`,
  строгая `Recipe` без флага прежняя). **Ревью (BOUI-R1):** умолчания больше нет. Техкарта без
  `stock_policy` на любом уровне - проблема `RECIPE_POLICY_UNSET` (продажа заблокирована, ничего не
  списано), а не тихая раскладка: полуфабрикат, который делают партиями через «Производство», иначе
  списывался бы дважды (сырьё при производстве и при продаже). `produce` техкарты без политики, выход
  которой списывает утверждённая связь (прямо или через вложенные техкарты не «запасом»), - отказ
  `INVALID_REQUEST/RECIPE_POLICY_UNSET`; прочие техкарты без политики производятся, как у облачной
  полосы. `stock_policy` - только у техкарты с выходом (у техкарты блюда - `INVALID_REQUEST`).

### 5.4 Сторно и списание (склад v2 + 075)

- `stock_reverse { document_id }` - обратный документ `reversal` с движениями ровно противоположными
  исходным (количество и стоимость исходных движений; для прихода - нельзя, если остатка или стоимости
  уже меньше: `INSUFFICIENT_STOCK`). Нельзя: `count` и `reversal` (`REVERSAL_NOT_ALLOWED`), уже сторно
  (`ALREADY_REVERSED`), подсчёт позиции документа после него (`COUNTED_AFTER_DOCUMENT`). Текст в окне:
  «Сторно создаст обратный документ. Исходный останется в истории».
- `stock` (расширение, склад v2 + 075): строка waste может быть `{ recipe_output_id, quantity }` -
  сервер раскладывает выход ТТК на сырьё (точные дроби, одно округление half-up на ингредиент); подсчёт
  ставит `counted_at = now()` своим позициям; `meta.count_scope: 'daily_key'|'full'` у подсчёта.
- `Ingredient` (payload): `quick_waste?: { label: 1..40, quantity }` (плитка «Фингерсы из шкафа»),
  `count_daily?: bool`, `group?`.

**Сделано в шаге 4** (за `stock_p1`; без флага склада v2 команда неизвестна - `INVALID_REQUEST`, с флагом без `stock_p1` - `NOT_READY`/`STOCK_V2_DISABLED`):

- `stock_reverse { document_id, expected_balances }` - отдельной схемой `P1Request` (общая `Command` и
  `openapi.json` прежние). Отклонение от текста выше: `expected_balances` (ревизии остатков позиций
  документа, как у `produce`) - окно сторно показывает остаток «сейчас» и «после», и другой документ
  между показом и проведением даёт `CONFLICT`, а не тихо другой итог. Обратный документ: `kind
reversal`, тот же `reference`, `reason` запроса, движения ровно противоположные. Отказы:
  `NOT_FOUND` (не документ точки), `INVALID_REQUEST`/`REVERSAL_NOT_ALLOWED` (подсчёт, сторно,
  перемещение, документ без движений), `CONFLICT`/`ALREADY_REVERSED`, `CONFLICT`/`COUNTED_AFTER_DOCUMENT`
  (документ подсчёта позиции позже документа или `counted_at` позже), `CONFLICT` (ревизия),
  `INSUFFICIENT_STOCK` (остаток или стоимость меньше обратного движения, в том числе ноль штук при
  ненулевой стоимости - `CHECK` 017), `NOT_READY`/`STOCK_V2_DISABLED` (флаг есть, `stock_p1` нет).
  Аудит `stock_reverse`, идемпотентность и блокировка точки - общий конверт команд.
- `quick_waste` в карточке ингредиента принимает `IngredientP1`; без `stock_p1` строгая `Ingredient`
  отклоняет поле, как раньше. В окне «Списание» плитки ингредиентов в работе; нажатие добавляет
  количество в строку позиции.
- Подсчёт двигает `counted_at` своих позиций на время документа (`greatest`, назад нельзя - триггер 075).
- Кабинет: плашка «Продажи пока не списываются...» (исправления склада: `stock_v2` или `pos_day`),
  «Последний подсчёт» в «Остатках», вкладки «Списания» и «Движение» с CSV, сторно в «Документах».

Не сделано в шаге 4: строка списания `recipe_output_id` (раскладка выхода ТТК), `count_daily`, `group`,
`meta.count_scope`, связи меню (§5.3) - они нужны автосписанию и подсчёту ключевых позиций.

**Сделано в шаге 8**: `IngredientP1` принимает `count_daily: boolean` и `group:
raw|semi|packaging|drink|household|other` (без склада P1 строгая `Ingredient` их отклоняет);
кабинет - поля в карточке, кнопка «Подсчёт на закрытии (N)» (окно `count` со строками этих позиций;
`stock.count`). `produce` при складе P1 отказывает техкарте с явным `stock_policy='explode'`
(`INVALID_REQUEST/RECIPE_POLICY_EXPLODE`); без политики - как раньше (иначе склад P1 сломал бы
производство всех прежних техкарт). Поле «Выход техкарты при продаже» (`stock_policy`) - в
редакторе техкарты кабинета. Строка списания `recipe_output_id` по-прежнему не сделана (общая
строка `stock` требует `ingredient_id`; вариант - отдельная команда P1, решение после 19.11).

### 5.5 Автосписание (`BACKOFFICE_STOCK_AUTOCONSUME_ENABLED`)

```text
GET ops/consumption?state=pending|previewed|blocked|applied|skipped|not_required&date=YYYY-MM-DD
  → { settings: { autoconsume_mode, start_at|null, revision },
      items: [{ source, order_id, display_number|null, sold_at, state, reason|null, detail,
                document_id|null, reversed: bool, attempts, next_attempt_at|null, revision }],
      counts: { [state]: int }, coverage: { sold_lines, linked_lines, share_bp } }
stock_settings     { autoconsume_mode: 'off'|'dry_run'|'on', start_at: ISO|null, expected_revision }
consumption_retry  { source, order_id, expected_revision }
consumption_skip   { source, order_id, expected_revision }    // причина - reason запроса (3..500)
```

Алгоритм - `design-backoffice.md` §4 (отбор, разбор, раскладка, поглощение подсчётом, применение) с
решением §3 этого документа (документ один на заказ). Воркер `services/api/src/stock-consumption-worker.ts`
(`--once`, тик 30 с) работает только при флаге, под ролью API; без строки настроек или в `off` ничего не
отбирает. Ручной `consume` при режиме `dry_run`/`on` - `AUTOCONSUME_ACTIVE`. Включать `on` - только при
покрытии строк продаж связями не ниже 95 % в `dry_run` (runbook).

**Сделано в шаге 5** (`consumption-store.ts`; ключ `stock_autoconsume` = флаг, склад v2, `stock_p1` и
права 075 на настройки и очередь; без флага вид - 404 неизвестного вида, команды - `INVALID_REQUEST`, с
флагом без прав - `NOT_READY`):

- Отбор (`enqueueConsumption`, `INSERT ... ON CONFLICT DO NOTHING`, по 200 за тик в порядке продажи):
  `cloud_pos_sales` (при праве чтения) и `commerce_orders` с оплатой (`sold_at` - первая
  `commerce_captures`), `sold_at >= start_at`, кухня начала (`pos_kitchen_sync_projection`/
  `cloud_fulfillment_projection` в `in_production|ready|handed_over`, `trigger_kind=kitchen_started`)
  или прошёл проход 03:00 Алматы следующего дня (`day_close`). Окно чтения - продажи старше самой
  старой позиции (перенос `start_at` назад) или новее самой новой минус 7 дней.
- Обработка (`processConsumptionItem`, своя транзакция на позицию под `bo:branch:<id>`, настройки
  перечитываются внутри): `pending`; `blocked` после `next_attempt_at` (1, 2, 5, 15, 30, 60 мин) или
  после поставки, подсчёта, производства, сторно, изменения связи, техкарты или позиции склада;
  `previewed` при `on`; только `sold_at >= start_at`.
- Решение: отмена или полный возврат до кухни - `not_required/CANCELLED_BEFORE_KITCHEN`; ручной
  `consume` облачного заказа - `not_required/MANUAL_CONSUMPTION`; нет версии каталога (касса: release →
  `catalog_menu_deliveries`; облако: `catalogReference.version`) - `blocked/MENU_VERSION_UNKNOWN`;
  проблемы разбора (`NO_LINK`, `LINK_NOT_APPROVED`, `ITEM_UNKNOWN`, `COMBO_TOO_DEEP`,
  `INGREDIENT_UNKNOWN`, `RECIPE_*`) - `blocked`, причина - первая (`NO_LINK` важнее), все - в
  `detail.problems`; поглощение `counted_at >= sold_at`; `dry_run` - `previewed` с `detail.needs`;
  `on`: нехватка - `blocked/INSUFFICIENT_STOCK` с `detail.shortages`, нечего списывать -
  `not_required/NOTHING_TO_CONSUME|ABSORBED_BY_COUNT`, иначе документ `consumption`
  (`source_ref`, `order_id` только облака, `recipe_snapshot` - версия каталога, ревизии связей и
  техкарт, потребность с точными дробями), движения `stockEffect('waste')`, позиция `applied`. Автор
  документа - `bo_stock_settings.updated_by` (у «Повторить» - нажавший).
- `GET ops/consumption` дополнительно: `display_number`, `refunded` (отмена или возврат кассы,
  возврат облака - видно возврат после кухни), `trigger_kind`, `updated_at`; `counts` по всем
  состояниям в рамках дня; `coverage { days: 7, start_date, end_date, sold_lines, linked_lines,
share_bp, missing: [{catalog_key, name, lines}] (до 20), truncated }` - строки продаж 7 дней Алматы
  (до 5000 чеков кассы и 5000 заказов), строка покрыта, если весь её разбор без проблем; список - до
  200 позиций (`truncated.items`).
- `GET branches/:id` при доступном автосписании - `stock_settings { autoconsume_mode, start_at,
revision }` (плашка склада) и права `stock.settings`, `consumption.write` в `permissions[]`.
- `consumption_retry` выполняет попытку сразу в команде (`NOT_READY`, если режим `off` или продажа до
  `start_at`); `consumption_skip` - `skipped` с причиной запроса; обе - на показанной ревизии
  (`CONFLICT`), конечная позиция - `CONFLICT`. Аудит - общий конверт команд; документы воркера в
  `bo_audit` не пишутся (их след - `source_ref` и очередь).
- Helper P1 при автосписании читает и `cloud_pos_refunds` (полный возврат до кухни, CR `bo-ui-5`).
- **Ревью (BOUI-R2): работает ли воркер.** Очередь пополняет только воркер, поэтому `GET
ops/consumption` и `stock_settings` в `GET branches/:id` несут `backlog { not_queued, waiting,
since, stalled, stall_minutes: 5 }`: продажи с `start_at`, которые воркер уже взял бы (отбор
  `enqueueConsumption` без предела 200), но в очереди их нет, и позиции `pending` (`previewed` при
  `on`), необработанные 5 минут. Продажа становится «должной» с начала кухни (время проекции) или
  прохода закрытия дня и не раньше последнего сохранения режима (догон после включения - не сбой).
  Кабинет: «Списание по продажам не работает: N продаж не обработаны с ЧЧ:ММ» вместо «списываются
  автоматически» на плашке, в начале вкладки и в проверке смены менеджера `blocked_consumption`
  (`problem`, факты `not_processed`, `not_processed_since`).

### 5.6 Смена менеджера (`BACKOFFICE_MANAGER_SHIFTS_ENABLED`)

```text
GET ops/manager-shifts?date=YYYY-MM-DD
  → { open: Shift|null, shifts: [Shift], template: { version: 1, opening: [Item], closing: [Item] },
      checks: { [code]: { status: 'ok'|'problem'|'no_data', text } } }   // авто-пункты, на лету
Shift = { id, business_date, state, manager_employee_id|null, manager_name|null, opened_at, opened_by_name,
          closed_at|null, closed_by_name|null, opening: { items: [Answer] }, closing: { items: [Answer], handover }|null, revision }
Answer = { code, status: 'done'|'problem'|'not_applicable', comment|null }   // comment обязателен для problem и not_applicable
manager_shift_open  { id, manager_employee_id?, items: [Answer], expected_revision: 0 }
manager_shift_save  { id, phase: 'opening'|'closing', items: [Answer], handover?, expected_revision }
manager_shift_close { id, items: [Answer], handover: 3..2000, expected_revision }
```

Шаблон v1 (код `packages/backoffice-core/src/manager-shifts.ts`): открытие (А10) - явка по графику
(авто), мясо и заготовки по срокам (кнопка «Списать»), оборудование, экраны, разменный фонд, стоп-лист
(авто); закрытие (А11, Ск7) - кассовые смены закрыты и расхождения пояснены (авто из `ops/pos-day`),
наличные сданы, смена Webkassa закрыта, списания внесены, подсчёт ключевых позиций (авто по `count_daily`),
инциденты курьеров, заблокированные списания (авто при автосписании), передача смены (обязательна).
Ошибки: `MANAGER_SHIFT_OPEN`, `CHECKLIST_INCOMPLETE`, `HANDOVER_REQUIRED`, закрытая - `CONFLICT`.
«Управленческий журнал» (kind `shift` в `bo_records`) при флаге только читается.

**Сделано в шаге 6** (`manager-shifts.ts` - схемы, шаблон v1, правило чек-листа; `manager-shifts-store.ts` -
БД; за флагом и правами 075 на `bo_manager_shifts` и `bo_branch_templates`, иначе вид - 404
неизвестного вида без флага и `NOT_READY` без прав, команды - `INVALID_REQUEST`/`NOT_READY`):

- `GET ops/manager-shifts?date` (по умолчанию сегодня по Алматы) → `{ schema_version, branch_id, date,
timezone, as_of, template: {version, opening, closing, updated_at, updated_by_name, editable},
open: Shift|null, open_template: {version, opening, closing}|null, shifts: [Shift] (до 50,
truncated), checks_date, checks: {attendance, stoplist, cash_float, cash_shifts,
webkassa_receipts, waste, key_count, blocked_consumption} }`. Проверка - `{status: ok|problem|
no_data|off, facts}`: тексты пишет кабинет (`manager-shift-model.ts`), факты - сервер. Проверки
  открытой смены - за её день (`checks_date`), без открытой - за `date`.
- Пункт: `{code, label, auto: <проверка>|null, required}`; ответ `{code, status, comment}`. Неполно
  (`INVALID_REQUEST/CHECKLIST_INCOMPLETE`): нет ответа на обязательный пункт (кроме проверки `off`),
  «Есть проблема» или «Не применимо» без комментария, пункт с проверкой `problem` без комментария
  (это пояснение расхождения). Ответ хранит текст пункта и проверку на момент ответа.
- Отклонения от текста выше: `manager_shift_open` без `business_date` (день - по часам БД при
  открытии); `manager_shift_save` фазы `closing` - черновик (`closing.draft=true`, неполные ответы и
  передача), фазы `opening` - исправление открытия (полное); новая команда
  `manager_shift_template {opening, closing, expected_version}` - версия чек-листа точки
  (`bo_branch_templates`), действует для смен, открытых после неё; открытая смена закрывается по своей
  версии (`open_template`).
- Авто-проверки: «Кассовые смены» и «Разменный фонд» - смены дня из `readPosDay` (Z и отчёты кассы:
  закрыто из всего, сумма расхождений наличных и терминала; касса открыта, а данных нет 10 минут -
  `no_data/stale`), «Webkassa» - чеки дня без номера, «Списания» и «Подсчёт» - документы склада дня,
  «Заблокированные списания» - позиции очереди дня в `blocked` (`off` без автосписания), «Явка» -
  опубликованные смены графика, «Стоп-лист» - последнее сообщение кассы. Подсчёт по `count_daily`
  в шаге 6 не сделан (поля нет): проверялось наличие подсчётов дня. Шаг 8: при отмеченных
  позициях `key_count` - `problem`, пока хоть одна используемая позиция `count_daily` не посчитана
  документом `count` дня (факты `key_items`, `key_counted`, `key_missing` до 10 имён,
  `key_missing_count`); без отмеченных - прежнее правило.
- Журнал: при доступной смене менеджера `save` kind `shift` - `NOT_READY/LEGACY_JOURNAL_READ_ONLY`;
  `GET branches/:id` читает журнал отдельно (последние 200, `limits.shift_records`,
  `truncated.shift_records`), остальные записи - прежние 2000 (пробел §1 `design-backoffice.md`).

### 5.7 Персонал (`BACKOFFICE_STAFF_POSITIONS_ENABLED`)

`Employee` (payload, без DDL): `position_code`, `extra_position_codes[] (≤3)`,
`pos_access: 'none'|'cashier'|'shift_manager'`. Справочник 11 должностей (`positions.ts`):

| Код                 | Должность           | Станция | Функция KDS                          | Доступ к кассе по умолчанию |
| ------------------- | ------------------- | ------- | ------------------------------------ | --------------------------- |
| `cashier`           | Кассир              | 1       | -                                    | `cashier` (PIN)             |
| `issue`             | Выдача              | 2       | `issue`                              | `none`                      |
| `delivery_handover` | Выдача доставки     | 3       | `delivery_handover`                  | `none`                      |
| `assembler`         | Сборщик             | 4       | `assembly_hall`, `assembly_delivery` | `none`                      |
| `toasts_fries`      | Тосты, бургеры, фри | 5       | `toasts`                             | `none`                      |
| `breading`          | Панировщик          | 6       | `breading`                           | `none`                      |
| `fryer`             | Жарщик              | 7       | -                                    | `none`                      |
| `prep`              | Заготовщик          | 8       | -                                    | `none`                      |
| `runner`            | Раннер              | 9       | -                                    | `none`                      |
| `shift_manager`     | Менеджер смены      | -       | -                                    | `shift_manager` (PIN)       |
| `manager`           | Управляющий         | -       | -                                    | `shift_manager` (PIN)       |

Номера станций - по сводной таблице «Описание станций и системы PickChick» (1 касса, 2 выдача,
3 выдача доставки, 4 сборка, 5 тосты, бургеры, фри, 6 панировка, 7 жарка, 8 заготовка, 9 раннеры).
Десять должностей - трекер А8; одиннадцатая (`manager`) - предположение: Д3 называет 11 должностей,
но не перечисляет их (`design-backoffice.md` §12 в.2, здесь §8 в.3).

Экраны кухни - общим входом `kitchen` (К8), PIN только для кассы. `edgeStaffId(employee_id, role) =`
uuid из `sha256('pickchick-edge-staff-v1:' + employee_id + ':' + role)` с битами версии как у
`localCatalogId` (`packages/menu-sync/src/availability.ts:6-16`); один вектор в `backoffice-core` и
`scripts/edge-staff-id.mjs`. `GET ops/staff-roster` (manager) → `{ schema_version: 1, branch_id,
generated_at, staff: [{ employee_id, name, role, edge_staff_id }], sha256 }` - вход
`staff-roster-apply.mjs --file F [--apply --expected-plan H]` и `staff-pin-batch.mjs` на сервере точки
(операторские функции `packages/local-orders`; нет функции - CR `bo-ui-<n>`).

**Сделано в шаге 6** (`positions.ts`; за флагом, без DDL для карточки):

- `GET branches/:id` - `staff_positions: {version, editable, positions, updated_at, updated_by_name}`;
  должность `{code, label, station 1..9|null, kds (функции KDS станции), pos_access, active}`. Список
  редактируемый (решение задачи шага): `staff_positions_save {positions, expected_version}` пишет
  версию в `bo_branch_templates` (право `staff.positions`); код не удаляется (`POSITION_IN_USE`), только
  `active=false`.
- Карточка `EmployeeP1`: `position_code`, `extra_position_codes` (до 3, без повтора должности),
  `pos_access`; должность и станции - из списка и действующие (кроме уже стоящих у карточки,
  `POSITION_UNKNOWN`). Сохранение без этих полей их оставляет; при выключенном флаге неизменённые поля
  в запросе не дают отказа (`stripKeptPositions`) - откат не стирает должности.
- `GET ops/staff-roster` (управляющий) → `{schema_version: 1, branch_id, generated_at,
positions_version, staff: [{employee_id, name, position_code, pos_access, role, edge_staff_id,
active}], sha256}`: все карточки, включая неработающие и удалённые (их записи отзываются); `role` -
  роль кассы только у работающей карточки с доступом. `sha256` - от `{schema_version, branch_id, staff}`
  с фиксированным порядком ключей (тот же код в `scripts/staff-roster-apply.mjs`, тест сравнивает).
- `scripts/staff-roster-apply.mjs`: план (`provision`, `revoke`, `keep`, `blocked`, `unmanaged`) и его
  sha256; `--apply --expected-plan H` - ровно этот план через `revokeStaff`, затем `provisionStaff` на
  активном `--terminal` и файл входа `staff-credential.mjs`. Роль не меняется на месте (отзыв и новая
  запись); отозванная ранее запись - `blocked` (CR `bo-ui-6` §3). `scripts/staff-pin-batch.mjs`: PIN по
  одному скрытым вводом через `setStaffPin`, три попытки, занятый PIN - повтор, PIN нигде не выводится.

### 5.8 Скидки (`BACKOFFICE_DISCOUNTS_ENABLED`)

**Сделано в шаге 7** (`packages/backoffice-core/src/discounts.ts`; кабинет `apps/backoffice/src/discounts.ts`,
`discounts-model.ts`). Скидки создаются и меняются только здесь, только управляющим
(`discounts.write`); читают все четыре роли. Нигде не применяются и не публикуются: ни
`bo_publications`, ни `bo_delivery_outbox`, ни меню, ни edge (тест «never published»). На запуске
скидок нет.

```text
GET ops/discounts[?id=uuid] → { schema_version: 1, branch_id, view: 'discounts', timezone, as_of,
  applied_at_pos: false, published_to_edge: false,      // станут true, когда касса начнёт применять (P1 pos)
  channels: ['hall','yandex_eda','glovo','chocofood','mobile','kiosk'],
  catalog: { version, categories: [{ id, name }], products: [{ id, name, category_id }] } | null,
  discounts: [Discount & { period: 'always'|'not_started'|'running'|'ended',
                           unknown_items: { categories: [slug], products: [slug] }, valid: bool }],
  truncated, limits: { discounts: 200, history: 100 },
  // только с ?id=: ревизии этой скидки, новые первыми (bo_discount_revisions, пишет триггер владельца)
  id, history: [{ revision, name, kind, percent_bp, value_minor, scope, schedule,
                  requires_manager_pin, combinable, state, changed_by_name, changed_at }], history_truncated }
Discount = { id, name, kind: 'percent'|'amount', percent_bp|null, value_minor|null,
             scope: { categories: [slug], products: [slug], channels: [канал] },
             schedule: { start_at|null, end_at|null, weekdays: [1..7], hours: [{ from: 'HH:MM', to: 'HH:MM' }] },
             requires_manager_pin, combinable, state, revision,
             created_by_name, created_at, updated_by_name, updated_at }
discount_save  { id, expected_revision, payload: Discount без id/state/revision и имён }  // 0 - новая, в draft
discount_state { id, state: 'draft'|'active'|'archived', expected_revision }
```

Правила (одни и те же в ядре и в форме кабинета, тесты `discounts-unit`, `discounts-ui`):

- **Размер**: процент в базисных пунктах 100..10000 (1-100 %, до двух знаков после запятой) или
  сумма в целых тиынах больше 0 и не больше 1 000 000 ₸; ровно одно из двух.
- **Название**: 1-80 символов в одну строку; два живых (не в архиве) названия точки не совпадают
  без учёта регистра (`CONFLICT/DISCOUNT_NAME_TAKEN`; уникальный индекс 075 - страховка).
- **На что**: категории и позиции по slug опубликованного каталога (оба списка пусты - всё меню).
  Неизвестные - `NOT_FOUND/CATALOG_ITEM_NOT_FOUND`; без опубликованного меню - только «Всё меню»
  (`NOT_READY/CATALOG_NOT_PUBLISHED`). Позиция, ушедшая из меню позже, видна в списке как «(нет в
  меню)», и такая скидка не включается.
- **Где**: хотя бы один канал из шести: зал, Яндекс Еда, Glovo, ChocoFood (чек зала с оплатой
  ChocoFood), приложение (`mobile`), киоск. Задача шага назвала шесть каналов, первоначальный дизайн -
  три; `scope` - jsonb, DDL не менялся.
- **Когда**: период `[start_at, end_at)` (каждая граница необязательна); в кабинете - дни Алматы
  включительно (`end_at` = полночь следующего дня); дни недели ISO 1..7, хотя бы один; до четырёх
  промежутков `ЧЧ:ММ` по Алматы без пересечений, конец до `24:00`, пусто - весь день.
- **Условия**: `requires_manager_pin` по умолчанию `true`, `combinable` по умолчанию `false`.
- **Состояния**: новая и изменённая скидка - `draft`. Изменение включённой возвращает её в `draft`:
  живая скидка никогда не меняется молча (сохранение без изменений состояние не трогает). Включение
  (`active`) проверяет сохранённую скидку заново и не включает закончившийся период
  (`INVALID_REQUEST/DISCOUNT_PERIOD_ENDED`). `archived` конечна (`CONFLICT/DISCOUNT_ARCHIVED`),
  название освобождается. То же состояние ещё раз - `INVALID_REQUEST`.
- **Конверт команды**: `request_id`, digest, `bo_audit` с `before_value` и `after_value`, блокировка
  точки, `expected_revision`; каждую ревизию копирует в `bo_discount_revisions` триггер 075.

Кабинет: раздел «Скидки» после «Промо и баннеры» только при `capabilities.discounts`; сверху -
«Скидки пока не применяются на кассе. Включим после проверки на кассе.» (текст владельца; заменил
текст первоначального дизайна). Список (фильтр по состоянию), редактор с черновиком во вкладке,
«Включить», «Выключить», «В архив», «История». Без флага раздела нет, запросов к `ops/discounts`
нет, `#discounts` открывает «Главную».

**P1 полосы pos: что понадобится кассе (заметка, не сделано; CR `bo-ui-7`).** Касса применит
скидки после проверки на кассе (решение владельца). Предложение интерфейса:

1. **Что получит edge.** Целый набор включённых скидок точки, заменяющий прежний (пустой набор -
   скидок нет), только после явного включения публикации (новый флаг, по умолчанию выключен):

   ```text
   DiscountSet = { schema_version: 1, branch_id, version: int (растёт), generated_at,
     discounts: [{ discount_id, revision, name, kind: 'percent'|'amount',
                   percent_bp|null, value_minor|null,
                   channels: ['hall'|'yandex_eda'|'glovo'|'chocofood'],  // каналы кассы; mobile/kiosk - облако, позже
                   categories: [slug], products: [slug],                  // сопоставление с меню кассы по slug
                   valid_from|null, valid_until|null, weekdays: [1..7], hours: [{ from, to }],  // Алматы
                   requires_manager_pin, combinable }] }
   ```

   Доставка - новый вид в существующем канале доставки бэк-офиса на edge (`bo_delivery_outbox`) или
   отдельный поток, решает integration. На edge - `pos_discount_presets` и `GET pos/config` →
   `discounts[]` (`design-pos.md`, раздел про конфиг кассы).

2. **Применение.** Кассир выбирает скидку в чеке; касса проверяет канал, период, день недели и час
   по Алматы и состав. `requires_manager_pin=true` - approval `discount` (уже в
   `ApprovalActionSchema`, `packages/contracts/src/cutover-enums.ts:45`) с PIN роли `shift_manager`.
   `combinable=false` - в чеке только эта скидка; `combinable=true` - только вместе с такими же,
   по очереди от остатка. Чеки без выручки (`staff_meal`, `marketing`) - без скидки.
3. **Расчёт (предложение).** База - сумма подходящих позиций по цене канала с модификаторами.
   Процент: `round_half_up(база × percent_bp / 10000)`; сумма: `min(value_minor, база)`. Скидка
   раскладывается по подходящим позициям пропорционально (метод наибольшего остатка) целыми тиынами,
   строка не уходит ниже 0.
4. **Данные продажи.** `QuoteSchema.discount_minor` (сейчас `z.literal('0')`,
   `packages/contracts/src/index.ts:446`; `packages/local-orders/src/pricing.ts:79`) становится суммой;
   `pos_sale`: `subtotal_minor - discount_minor = total_minor` (приёмник облака это уже проверяет,
   `packages/pos-order-sync/src/sales-model.ts:178`), плюс поле `discount` (`discount_id`,
   `revision`, `name`, `kind`, `percent_bp` или `value_minor`, `approved_by_staff_id`; без скидки -
   `null`) и `discount_minor` у строки. Проверка
   «без скидки» в `packages/pos-order-sync/src/model.ts:66` (`total_minor = subtotal_minor`)
   снимается для продаж со скидкой. В облаке `cloud_pos_sales.discount_minor` уже есть (073), для
   отчёта по скидкам - `discount jsonb NULL` новой миграцией (номер у integration).
5. **Возврат** позиции возвращает оплаченную сумму строки (после её доли скидки).
6. **Бэк-офис после этого**: `applied_at_pos=true` убирает плашку; «Касса» уже показывает
   `discount_minor` чеков (`ops/pos-day`), отчёт продаж добавит строку «Скидки».

### 5.9 Реестр заказов на сервере: `GET ops/orders` (`BACKOFFICE_POS_DAY_ENABLED`, аудит F10)

```text
GET ops/orders?start_date&end_date[&q&channel=mobile|kiosk|pos&terminal_id&sort=new|old|number|amount&page]
  → { start_date, end_date, filters, page, page_size: 100, pages,
      rows: [{ id, created_at, channel, display_number, total_minor, state, payment_state,
               kitchen_state, terminal_id|null, source: cloud|cashier_report|pos_sync }],
      totals: { orders, live_orders, live_total_minor, by_terminal: [{ terminal_id, live_orders,
                live_total_minor }] },
      terminals: [{ terminal_id, label }], coverage: { pos_tables, cashier_reports } }
```

Окно - дни Алматы, до года (как `GET branches/:id`). Три источника реестра: заказы приложения и
киоска (`commerce_orders`), заказы отчёта кассы (`cloud_cashier_orders`, оплаченная продажа кассы -
`captured`, CR pos-4 §2), прочие заказы кассы (`pos_order_sync_projection`); касса заказа - из продажи
073 или смены кассира. `q`: «117» или «№117» - номер заказа (точно, все кассы), иное - начало id.
Итоги - по всей выборке (не по странице), без отменённых, по кассам. Без флага - 404 неизвестного вида.
Кабинет спрашивает сервер на каждый фильтр (поиск - через 300 мс), листает по 100, CSV собирает все
страницы (до 5000 заказов); если вид не ответил - прежний список последних 200 на источник с пометкой.

### 5.10 «Оплаты и чеки»: одна дата на странице (аудит F13, исправления аудита)

С исправлениями аудита у страницы нет переключателя периода в шапке. Блоки под сверкой показывают
день сверки (без сверки - свой выбор дня, по умолчанию сегодня) и читаются отдельным `GET
branches/:id?period=custom` этого дня, не трогая период других страниц; «Обновить» читает их заново.

### 5.11 Откат склада P1 (ревью BOUI-R3)

- На месте (флаг выключен, helper с `stockV2: false`, нет прав 075): поля P1 карточки ингредиента
  (`quick_waste`, `count_daily`, `group`) и техкарты (`stock_policy`), присланные без изменений,
  отбрасываются до строгой проверки облачной полосы и возвращаются из записи; сохранение без них их не
  стирает; изменённое или новое поле P1 - по-прежнему `INVALID_REQUEST` (образец полей должностей).
  Сохранение без полей P1 идёт в прежнем порядке облачной полосы.
- Откат образа API на сборку облачной полосы: `P1_PAYLOAD_STASH_SQL` (владелец схемы, одна
  транзакция, перед откатом) переносит все поля P1 карточек ингредиента, техкарты и сотрудника в
  `bo_p1_payload_stash` (только владелец) и поднимает ревизию; `P1_PAYLOAD_RESTORE_SQL` возвращает их.
  Оба блока дословно в runbook «Откат образа API», тест сверяет их.

### 5.12 Тождество с облачной полосой (ревью BOUI-R4)

`tests/integration/fixtures/backoffice-cloud-lane-golden.json` - выходы сборки облачной полосы
43806cf4 на одном синтетическом наборе (2031 год): `read()` управляющего и аналитика за день и неделю,
карточки заказа кассы и приложения, все виды `ops`, неизвестные команды P1, строгое сохранение и
запись; при всех флагах выключенных и при ролях с отчётом продаж. `backoffice-p1-golden.test.mjs`
сравнивает с ним эту полосу (с порядком ключей). Записать заново:
`node tests/integration/fixtures/backoffice-cloud-lane-golden.mjs <dist/index.js сборки 43806cf4>`.

## 6. Кабинет (`apps/backoffice`, русский) и аудит

Общие правила: только дефис `-`, даты `ДД.ММ.ГГГГ`, деньги одним форматом «11 670 ₸» (`money` из
`sales-report-model.ts`), CSV в тенге с заголовком «Сумма, ₸» (`csvTenge`, защита от формул),
статусы текстом, телефон 390 px без скрытых сумм и кнопок, проверка 1440x900 и 390x844.

| Находка                               | Решение                                                                                                                                                           | Где                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| F04                                   | «Касса», «Главная», карточка заказа кассы: оплата из 073, без данных «Оплата на кассе: данные не поступают», а не «Не начата»                                     | `POS_DAY`                                      |
| F12, F10                              | имя кассира по `edgeStaffId`, колонка «Касса» с именем устройства, дата в одну строку                                                                             | `POS_DAY`                                      |
| F09, F03                              | кнопки по `permissions[]`, а не по `role`; «Вы: начальник смены»; объяснение недоступной кнопки                                                                   | `permissions[]` при `BACKOFFICE_ROLES_ENABLED` |
| F01, F02, F17 (склад)                 | подтверждение при потере ввода, перечитывание остатков на `CONFLICT` склада с понятным текстом, названия «Ингредиенты», «Поставка»                                | `STOCK_V2` или `POS_DAY`                       |
| F01 (прочие окна)                     | вопрос перед закрытием окна записи, черновик карточки записи в `sessionStorage`                                                                                   | `POS_DAY` (шаг 3, §8 в.1)                      |
| F05, F06, F08, F11, F13-F16, F19, F20 | «Нет связи» вместо «нужен доступ», CSS вкладок, имена в аудите (F08 меняет ответ API: `actor_name` только при `POS_DAY`), CSV в тенге, телефонные таблицы, тексты | `POS_DAY` (шаг 3, §8 в.1)                      |
| F07                                   | период только там, где он работает                                                                                                                                | `POS_DAY` (шаг 3, §8 в.1)                      |
| F18                                   | текст экрана входа при неверном файле                                                                                                                             | не сделано: до входа флаги неизвестны, §8 в.1  |
| F10 (остаток), F13 (остаток)          | реестр на сервере с поиском, страницами и итогами периода (§5.9); одна дата на «Оплатах и чеках» (§5.10)                                                          | `POS_DAY` (ревью)                              |

Исправление, которому нужен новый запрос или ответ API, всегда идёт за флагом своей функции.

**Открытый вопрос (интеграция и владелец, §8 в.1).** Дополнение контракта требует: при всех
выключенных флагах кабинет, ответы API и поведение БД байт-в-байт как у облачной полосы. Исправления
аудита «только кабинет» меняют поведение кабинета без флага, поэтому без явного согласия так их не
выпускаем.

**Сделано в шаге 3 (до ответа).** Общие исправления пришлось к чему-то привязать, чтобы их можно
было проверить и выпустить 19.11: они идут за `BACKOFFICE_POS_DAY_ENABLED`, флагом кабинета
перехода (новая «Главная», «Касса»), который включается в день перехода. Решает одна функция
`auditFixes` в `apps/backoffice/src/operations-model.ts` (ключ `capabilities.pos_day`); модули,
которые рисуют таблицы, деньги и даты без снимка, читают её через `ui.fixes` (`ui-fixes.ts`), CSS - через
класс `bo-fixes` у `<html>`. Исправления склада идут за `stock_v2` или `pos_day`, тексты ролей - за
`permissions[]` или `pos_day`. Если интеграция решит иначе, меняется только `auditFixes` (CR `bo-ui-3`).
Прежнее умолчание шагов 1-2 (для справки):

- исправление раздела, у которого есть флаг, идёт за этим флагом: склад (F01, F02, F17 для склада) -
  `BACKOFFICE_STOCK_V2_ENABLED` (ключ `stock_v2`), касса и заказы кассы (F04, F10, F12) -
  `BACKOFFICE_POS_DAY_ENABLED`;
- F03 и F09 - по `permissions[]` облачной полосы, то есть только при `BACKOFFICE_ROLES_ENABLED`;
- общие исправления (F05-F08, F11, F13-F16, F18-F20) пишутся и тестируются, но включаются только после
  ответа на §8 в.1: либо без флага (тогда тест HTTP-прокси и модели доказывает, что запросы и ответы API
  прежние), либо за флагом, который назовёт интеграция.

## 7. Порядок работ полосы (шаги 2-8, предложение)

1. Шаг 1 (сделан): 075, `backoffice-p1-grants.mjs`, флаги, этот документ, CR `bo-ui-1`. Три теста
   облачной полосы (`roles`, `sales-report`, `stock-v2` в `packages/backoffice-core/tests`) ждали, что
   `migrate()` применит ровно 073/074; теперь они ждут все файлы от нужного и заодно проверяют прежний
   рантайм на 075.
2. Шаг 2 (сделан): `ops/pos-day`, `edge-staff-id` (ядро и скрипт), allowlist и gateway, тесты
   PostgreSQL и HTTP по ролям, раздел «Касса», блок «Сегодня» на «Главной», реестр заказов с кассой,
   F04/F10/F11 (CSV реестра)/F12, исправления CR pos-4 §2 - всё за `BACKOFFICE_POS_DAY_ENABLED`;
   браузерная проверка с флагом и без, runbook «Касса в бэк-офисе» (`backoffice-p1-cutover.md`).
3. Шаг 3 (сделан): исправления аудита F01-F17, F19, F20 за флагами (§6), CR `bo-ui-3`; F18 - нет
   (до входа флаги неизвестны).
4. Шаг 4 (сделан): сторно (`stock_reverse`), плитки быстрого списания, `counted_at`, плашка про
   продажи, отчёт списаний с учётом сторно, вкладки «Списания» и «Движение» с CSV, ключ `stock_p1`,
   право `stock.reverse`; CR `bo-ui-4`. Перенесено: `variance`/`consumption`, выход ТТК, связи меню.
5. Шаг 5 (сделан): связи меню (`ops/menu-links`, `menu_link_save`, `menu_links_approve`), ядро
   автосписания, очередь, режим (`ops/consumption`, `stock_settings`, `consumption_retry`,
   `consumption_skip`), воркер `stock-consumption-worker.ts`, вкладка «Списание по продажам», CR
   `bo-ui-5`. Перенесено: отчёты склада `view=consumption|variance` (шаг 6, с подсчётом ключевых
   позиций), поле `stock_policy` в редакторе техкарты кабинета.
6. Шаг 6 (сделан): смена менеджера (`ops/manager-shifts`, команды открытия, черновика, закрытия и версии
   чек-листа, авто-проверки, журнал только для чтения и исправление `LIMIT 2000`), должности
   (список с версиями, поля карточки, «Доступы», `ops/staff-roster`), `staff-roster-apply.mjs`,
   `staff-pin-batch.mjs`; 075 раздел 8 `bo_branch_templates`; CR `bo-ui-6`. Перенесено: подсчёт по
   `count_daily`, отчёты склада `variance`/`consumption`, восстановление отозванной записи кассы (CR).
7. Шаг 7 (сделан): редактор скидок (`ops/discounts`, `discount_save`, `discount_state`, раздел
   «Скидки» с плашкой, история), право `discounts.write`, интерфейс для кассы (§5.8, P1), CR
   `bo-ui-7`. Исправления аудита без флага не делались: §8 в.1 без ответа, умолчание шага 3 в силе.
8. Шаг 8 (сделан): отчёты склада `view=variance|consumption` (вкладки «Расхождения подсчёта», «Расход
   по продажам»), `count_daily`/`group` и «Подсчёт на закрытии», проверка ключевых позиций смены,
   `stock_policy` в редакторе техкарты и `RECIPE_POLICY_EXPLODE`; браузерный проход по всем экранам
   P1 четырьмя ролями на 1440 и 390 px (`p1-pass-browser.test.mjs`) и исправления из него; runbook
   (сводка: флаги, порядок 13.11-19.11, роли, откат), дополнения `backoffice-cutover.md`, CR
   `bo-ui-8` (075 в окне Cloud-1, маршруты `ops/<view>` в `scripts/contracts.mjs`); полный прогон.

Каждый шаг: тест «флаг выключен - прежний ответ», права по §4 с отказом для каждой роли, идемпотентность
команд (`request_id`, тот же ключ с другим телом - `CONFLICT`), деньги целыми тиынами.

## 8. Вопросы интеграции и владельцу (с умолчанием)

1. **Исправления аудита без флага.** Можно ли выпустить общие исправления кабинета (F05-F08, F11,
   F13-F16, F18-F20, §6) без флага, если запросы и ответы API не меняются? Умолчание с шага 3: они
   идут за `BACKOFFICE_POS_DAY_ENABLED` (функция `auditFixes`), то есть приходят с кабинетом перехода
   19.11 и уходят при его откате; F18 ждёт ответа. Другой ответ - правка одной функции (CR `bo-ui-3`).
2. **Кто делает сторно склада.** Умолчание: управляющий и бухгалтер (`design-backoffice.md` §4).
   Начальнику смены - только если владелец скажет.
3. **Одиннадцатая должность.** Умолчание: `manager` («Управляющий», доступ к кассе как у начальника
   смены). Остальные десять - трекер А8.
4. **Чеков кассы в день в пик** (предел `ops/pos-day`, `iiko-gap.md` в.13). Ответ: 2000 чеков за день
   (и до 200 более ранних чеков с возвратом в этот день) с признаком `truncated`; итоги дня считаются по
   всем чекам, предел только у списка (шаг 2).
5. **Склад P1 под `BACKOFFICE_STOCK_V2_ENABLED`.** По дополнению контракта сторно, связи меню, быстрые
   плитки и отчёты склада P1 включаются тем же флагом, что причины списаний (вкл. 16.11). Значит, после
   Cloud-2 (075 и права) они появятся у управляющего без отдельного шага. Умолчание: так и оставить
   (черновые связи ничего не списывают, пока автосписание выключено); если нужен отдельный шаг - новый
   флаг через CR.
6. **Отозванная учётная запись кассы** (шаг 6). Номер кассы детерминирован, а операторские функции
   не восстанавливают `active=false`: вернувшийся сотрудник в прежней роли получает `blocked`.
   Умолчание: вручную через оператора кассы; функция - полосе pos (CR `bo-ui-6` §3).
7. **Право на чек-лист.** Умолчание: версию чек-листа сохраняет только управляющий
   (`manager_shifts.template`), открывают и закрывают смену управляющий и начальник смены.
8. **Изменение включённой скидки** (шаг 7). Умолчание: возвращает её в черновик, управляющий
   включает её снова (живая скидка не меняется молча). Если владельцу нужно менять, например,
   только даты без выключения - отдельное решение.
9. **Каналы и сумма скидки** (шаг 7). Умолчание: шесть каналов (зал, Яндекс Еда, Glovo, ChocoFood,
   приложение, киоск), ChocoFood - чек зала с оплатой ChocoFood; сумма - до 1 000 000 ₸ на чек
   (защита от опечатки). Правила расчёта на кассе (§5.8 P1) - предложение для полосы pos.
10. **075 в окне Cloud-1** (шаг 8). Связи шефа и проверка без списания на Т7/Т8 возможны, только если
    075 и права P1 стоят до 16.11. Умолчание runbook: 075 в Cloud-1 (14.11) вместе с 074 (CR
    `bo-ui-8` §1); если интеграция оставит её в Cloud-2, проверка на Т7/Т8 выпадает и режим остаётся
    «Проверка без списания» дольше.

## 9. Вторая волна (полоса bo-ui2)

Полоса: bo-ui2 (ветка `codex/cutover-bo-ui2`, от итога bo-ui `aff89ce6`). Основание: решение
владельца 06.11 - вторая волна бэк-офиса (поставщики и их цены, заявки, отчёты склада, расстановка)
делается сейчас, за флагами, которые по умолчанию выключены. Порядок важности - как в начале документа
плюс дополнение для bo-ui2; где этот раздел молчит, действуют §2-§8. Миграция 075 и helper bo-ui для
этой полосы заморожены; её миграция - 076, права - `infra/staging/backoffice-supply-grants.mjs`
(CR `bo-ui2-1`). Синтетические имена поставщиков («Поставщик 1»); настоящий список - из выгрузки iiko
владельца через скрипт импорта, не в коде, тестах и документах.

### 9.1 Флаги и совместимость

Env API, `true|false`, по умолчанию `false`, только облачный API с `BACKOFFICE_ENABLED=true`
(`loadConfig`, список `BACKOFFICE_P2_FLAGS`; кабинету - `backofficeP2Options(config)`, `p2-flags.ts`).

| Флаг                                  | `capabilities`     | Значение ключа                                                      | Нужен также                           | Откат                                      |
| ------------------------------------- | ------------------ | ------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------ |
| `BACKOFFICE_SUPPLY_ENABLED`           | `supply`           | `true` при складе v2 и правах 076 (helper bo-ui2), иначе `false`    | `BACKOFFICE_STOCK_V2_ENABLED`         | `false`; поставщики, цены, заявки остаются |
| `BACKOFFICE_STOCK_REPORTS_ENABLED`    | `stock_reports`    | `true` при складе v2 и читаемых столбцах 074 (шаг 4), иначе `false` | `BACKOFFICE_STOCK_V2_ENABLED` (шаг 4) | `false`; поля карточки остаются            |
| `BACKOFFICE_STAFF_ASSIGNMENT_ENABLED` | `staff_assignment` | `true` при должностях и правах 076, иначе `false`                   | `BACKOFFICE_STAFF_POSITIONS_ENABLED`  | `false`; интервалы остаются                |

Поставка по заявке - приход склада v2 (откуда, поставщик, дата накладной), поэтому без склада v2
`loadConfig` отказывает; станции расстановки - должности списка точки (§5.7), поэтому без должностей
тоже. Ключи идут после всех ключей bo-ui, `stock_p1` включительно. Правила совместимости §2 действуют
и здесь:

1. **Все три флага выключены** - ответы API, поведение БД и кабинет байт-в-байт как у итога bo-ui.
   Доказательство: `tests/integration/backoffice-p2-golden.test.mjs` против записанных выходов сборки
   `aff89ce6` (`fixtures/backoffice-bo-ui-golden.json`: чтение четырёх ролей, карточки заказов, все виды
   облачной полосы и bo-ui, виды и команды второй волны, строгое сохранение, запись; флаги bo-ui
   выключены, флаги облачной полосы, все флаги bo-ui включены) на схеме с 076 и на схеме до 075;
   `backoffice-p2-flags.test.mjs` (конфиг, ключи, строка в каждой таблице 076 не меняет чтение, HTTP);
   `p2-schema.test.mjs` (076 не меняет ни одного прежнего объекта, строки и ответы bo-ui прежние).
   Отдельно: сборка `aff89ce6` на схеме с 076 дала ровно эталон.
2. Вид второй волны без флага - ровно 404 неизвестного вида, команда - ровно `INVALID_REQUEST`
   неизвестного типа: команды разбираются своей схемой только при флаге, общие `Command` и `P1Request`
   не меняются.
3. Новые поля payload принимаются только при флаге (без флага строгая схема их отклоняет, эталон
   «save with a P2 field»); откат флага поля не стирает (образец §5.7 и §5.11).
4. Новый кабинет со старым API: ключа нет или вид отвечает 404 - раздел не показывается.
5. `permissions[]` получает права §9.3 только при доступной функции.

Сделано в шаге 1: флаги, ключи `capabilities`, 076, helper прав, эталон, CR `bo-ui2-1`, этот раздел.
Шаг 2 (поставки): виды `suppliers` и `supply-requests`, шесть команд поставщиков и заявок (§9.4),
права §9.3 и раздел кабинета «Закупки». Ключ `supply` теперь ещё требует, чтобы роль API писала
столбцы прихода 074 (`supplyAvailable`, `p2-flags.ts`): приём заявки - это приход склада v2. Импорт
цен (`supplier_prices_import`), отчёты склада и расстановка - следующие шаги; до них эти виды и
команды при включённом флаге отвечают так же, как без него. Шаг 3 - импорт цен, шаг 4 - отчёты
склада, шаг 5 - расстановка: вид `staff-assignments`, команды `staff_assign` и `staff_unassign`,
ключ `staff_assignment` - при должностях и правах 076 (`staffAssignmentAvailable`, `p2-flags.ts`);
без должностей вид отвечает `NOT_READY`, команды - неизвестные (`INVALID_REQUEST`).

### 9.2 Миграция 076 (`db/cloud/migrations/076_cloud_backoffice_supply.sql`)

Только новые таблицы со своими функциями, триггерами и индексами; ничего существующего не меняет
(тест сверяет столбцы, умолчания, ограничения, индексы, триггеры, права и тела функций всех прежних
объектов до и после 076). Без FK на `cloud_pos_*`, прав в файле нет. Ревизии - `guard_bo_revision()`
из 075: удалений нет, первая ревизия 1, каждое изменение +1, ключевые колонки неизменны. Деньги -
`bigint` целых тиын (в jsonb строк заявки - строка целых тиын), количества - целые учётные единицы
позиции (`g`, `ml`, `pcs`), как в `bo_stock_balances`. DDL заморожен 10.11 18:00.

| Объект                      | Содержание                                                                                                             | Инварианты (БД)                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bo_suppliers`              | поставщик точки: название 1..120, вид `supplier`/`central_kitchen`/`bakery`, `active`                                  | название без пробелов по краям и управляющих символов, одно на точку без учёта регистра (импорт сопоставляет по названию); вид неизменен                                                                                                                                                                                                                                           |
| `bo_supplier_price_imports` | применённый импорт цен: источник `iiko_export`/`csv`, SHA-256 файла и плана, число строк 1..5000, итоги, автор, время  | план применяется на точке один раз (`UNIQUE(branch_id, plan_sha256)`); запись неизменна                                                                                                                                                                                                                                                                                            |
| `bo_supplier_prices`        | цена одной закупочной единицы (`g`, `kg`, `ml`, `l`, `pcs`) позиции у поставщика с дня `valid_from`; `manual`/`import` | `price_minor > 0`; ключ `(supplier_id, ingredient_id, unit, valid_from)`; единица измеряет позицию (`kg`/`g` - граммы, `l`/`ml` - миллилитры, `pcs` - штуки; триггер); `import` ⇔ ссылка на импорт той же точки; поставщик и позиция той же точки                                                                                                                                  |
| `bo_supply_requests`        | заявка в цех, пекарню, на хозтовары или поставщику: номер на точке, `needed_by`, примечание, строки, приход            | создаётся черновиком; после подачи строки, поставщик, дата и примечание неизменны, назад в черновик нельзя; `received` и `cancelled` конечны; `received` ⇔ один документ `receipt` той же точки, ставится один раз; подача - строки (1..100), дата и, у заявки поставщику, поставщик; цех и пекарня поставляют свои заявки, поставщик (`supplier`) - хозтовары и заявки поставщику |
| `bo_staff_assignments`      | «сотрудник на станции с ЧЧ:ММ»: бизнес-день, сотрудник, код станции, начало, конец, кто поставил и закрыл              | один открытый интервал на сотрудника (частичный уникальный индекс), интервалы сотрудника не пересекаются (триггер, `[начало, конец)`); бизнес-день - день Алматы начала или предыдущий (после полуночи в смене, открытой вечером); закрытый интервал неизменен, изменение - только закрытие                                                                                        |

Строка заявки (проверяется и в БД, jsonpath): `{ ingredient_id (uuid строчными), unit (единица
позиции: g|ml|pcs), qty (целое > 0), balance_at_request (целое ≥ 0), hint? (целое ≥ 0 или null),
price_minor? (целые тиын > 0, только при поставщике) }`; элементы - только объекты.

**Расстановка - отдельная таблица, а не kind `assignment` в `bo_workforce_records`** (так предлагал
`design-backoffice.md` §3). Проверено по коду табеля:

1. Табель читает все записи точки разом и не считает начисления, если их больше 10000
   (`packages/backoffice-core/src/workforce-store.ts:62-71`). Расстановка - несколько интервалов на
   человека в день: около 15 человек × 2-3 перестановки × 365 дней = 11-16 тысяч записей в год, то есть
   за год начисления перестали бы считаться.
2. Табель - право `workforce.read`/`workforce.write`; начальнику смены весь табель отвечает
   `ROLE_FORBIDDEN` (`workforce-store.ts:32-37`, матрица `roles.ts`), а расстановку ставит именно он во
   время смены.
3. «Один открытый интервал на сотрудника» и «без пересечений» должны держаться в БД (частичный
   уникальный индекс, триггер). В jsonb `payload` записи табеля они были бы только в коде, как сейчас
   проверки табеля (загрузка всех записей и сравнение).
4. Совместимость: прежний рантайм отдаёт все записи `bo_workforce_records` в табель и в снимок закрытого
   месяца (`workforce-store.ts:113-125`, `491-502`); новый kind попал бы в старый табель и снимки после
   отката. Отдельная таблица прежнему рантайму не видна.
5. Команды табеля идут своим конвертом (`bo_workforce_commands`, блокировка `workforce:<точка>`);
   расстановка - общим конвертом бэк-офиса (`bo_commands`, `bo_audit`, `bo:branch:<id>`), как остальные
   команды P1 и второй волны.

В табеле расстановка показывается чтением интервалов по сотруднику и дню (шаг расстановки).

**Payload без DDL.**

- Минимальный уровень - существующее обязательное `Ingredient.minimum` (целое в учётных единицах,
  «Минимальный запас в учётных единицах», `model.ts:83-88`, `apps/backoffice/src/operations.ts:995`).
  Отдельное `min_level` не вводится: два минимума одной позиции расходились бы. Подсказка к заказу =
  max(0, минимум - остаток).
- `Ingredient.supply_kind?: 'central_kitchen'|'bakery'|'household'|'supplier'` (`design-backoffice.md`
  §3) - откуда обычно приходит позиция (группировка подсказки и заявок). Принимается схемой карточки
  второй волны только при `BACKOFFICE_SUPPLY_ENABLED`; без флага - как сегодня (отказ строгой схемы).
- Шаг 4: `Ingredient.meat?: boolean` - цель «К заказу» - 3 дня расхода (§9.4 «Сделано в шаге 4»).
  Принимается только при `BACKOFFICE_STOCK_REPORTS_ENABLED` (и складе v2), `supply_kind` - только при
  `BACKOFFICE_SUPPLY_ENABLED` (и складе v2). Без флага сохранённое значение остаётся, а то же значение,
  присланное обратно, не отклоняется (правило отката BOUI-R3, `ingredientP2Keys`, `index.ts`);
  новое или изменённое - отказ строгой схемы, как раньше.

### 9.3 Права (матрица §5.10, §4 + вторая волна)

Чтение всех новых видов - `reports.read` (все четыре роли; цены поставщиков видны всем, как стоимость
в отчётах склада, §9.6 в.1). Новые права - отдельный список (как `BACKOFFICE_P1_PERMISSIONS`), в
`permissions[]` только при доступной функции; без `BACKOFFICE_ROLES_ENABLED` решает грант (manager -
всё, analyst - `FORBIDDEN`).

| Право                      | manager | shift_manager | accountant | analyst | Команды                                                             |
| -------------------------- | ------- | ------------- | ---------- | ------- | ------------------------------------------------------------------- |
| `suppliers.write`          | да      | -             | да         | -       | `supplier_save`, `supplier_price_save`, `supplier_prices_import`    |
| `supply.write`             | да      | да            | -          | -       | `supply_request_save`, `supply_request_submit`                      |
| `supply.close` (шаг 2)     | да      | -             | -          | -       | `supply_request_cancel`, `supply_request_receive`                   |
| `stock.receipt` (есть, P0) | да      | да            | да         | -       | `supply_request_receive` (вторым условием, вместе с `supply.close`) |
| `staff.assign`             | да      | да            | -          | -       | `staff_assign`, `staff_unassign`                                    |
| `staff.assign_override`    | да      | -             | -          | -       | `staff_assign` на станцию не по должности (вторым условием, шаг 5)  |

Отклонение шага 2 от предложения шага 1: по заданию шага («manager and shift manager create and
submit; manager receives and cancels; accountant reads») принимает поставку по заявке и отменяет
заявку только управляющий. Поэтому отдельное право `supply.close` (`BACKOFFICE_P2_PERMISSIONS`,
`P2_ROLE_PERMISSIONS`, `roles.ts`), а `stock.receipt` остаётся вторым условием приёма
(`P2_COMMAND_PERMISSIONS`, `p2-commands.ts`). Обычный приход склада (P0) по-прежнему проводят
управляющий, начальник смены и бухгалтер. Если владелец решит, что начальник смены тоже принимает
поставки по заявкам, - одна строка `supply.close` в `P2_ROLE_PERMISSIONS.shift_manager` и тест
матрицы (§9.6 в.5). Права второй волны идут в `permissions[]` после всех прав P1 и только при
`capabilities.supply === true`; без `BACKOFFICE_ROLES_ENABLED` решает грант (manager - всё, analyst -
`FORBIDDEN` без причины).

### 9.4 API (схемы - предложение шага 1; шаги видов уточняют их с отметкой отклонений)

Как §5: чтение - `GET .../ops/<view>` (один снимок REPEATABLE READ, точные ключи запроса в allowlist
прокси и регулярке шлюза), запись - `POST .../commands` (`request_id`, digest, `bo_audit` с
`before_value`/`after_value`, блокировка `bo:branch:<id>`, `expected_revision`). Деньги - строки целых
тиын, количества - строки целых учётных единиц, даты - `YYYY-MM-DD` Алматы, время - ISO UTC, CSV - в
тенге с заголовком «Сумма, ₸». Эталон (§9.1, п. 1) проверяет, что эти виды и команды без флагов -
неизвестный вид (404) и неизвестная команда (`INVALID_REQUEST`), как у bo-ui.

**Поставщики и цены** (`BACKOFFICE_SUPPLY_ENABLED`):

```text
GET ops/suppliers[?id=uuid]
  → { schema_version: 1, branch_id, view: 'suppliers', timezone: 'Asia/Almaty', as_of,
      suppliers: [{ id, name, kind: 'supplier'|'central_kitchen'|'bakery', active, revision,
                    prices: int, last_valid_from|null, created_by_name, created_at,
                    updated_by_name, updated_at }],
      limits: { suppliers: 500 }, truncated: { suppliers: bool },
      // только с ?id=: цены поставщика (действующая на сегодня - in_force) и его импорты
      id, prices: [{ ingredient_id, ingredient_name, ingredient_unit, unit, price_minor, valid_from,
                     in_force: bool, source: 'manual'|'import', import_batch_id|null, revision,
                     updated_by_name, updated_at }],
      imports: [{ id, source, file_sha256, plan_sha256, row_count, summary, actor_name, applied_at }] }
supplier_save          { id, expected_revision, payload: { name, kind, active } }    // 0 - новый; вид не меняется
supplier_price_save    { supplier_id, ingredient_id, unit, valid_from, price_minor, expected_revision }
supplier_prices_import { source: 'iiko_export'|'csv', file_sha256, plan_sha256,
                         rows: [{ supplier_name, supplier_kind, ingredient_id, unit, price_minor,
                                  valid_from }] (1..2000) }
  → { batch_id, suppliers_created, prices_created, prices_changed, unchanged }
```

Цена - за одну закупочную единицу; `kg`/`l` = 1000 `g`/`ml`. Цена в силе на день D - строка с
наибольшим `valid_from ≤ D` того же поставщика, позиции и единицы. Ожидаемая сумма строки заявки =
половина вверх (количество в учётных единицах × цена / множитель единицы), одно округление на строку.
`scripts/supplier-prices-import.mjs --file F --branch B --token-file C [--apply --expected-plan H]` -
план с SHA-256, как `stock-opening-import.mjs`: поставщики по названию (регистр, пробелы и «ё» не
различаются, новые создаются), позиции - однозначно по id или названию, план на точке применяется один
раз (`CONFLICT/IMPORT_ALREADY_APPLIED`).

**Заявки** (`BACKOFFICE_SUPPLY_ENABLED`):

```text
GET ops/supply-requests?start_date&end_date[&state=draft|submitted|received|cancelled][&kind=…][&id=uuid]
  → { schema_version: 1, branch_id, view: 'supply-requests', timezone, as_of, start_date, end_date,
      requests: [{ id, number, kind, state, supplier: { id, name, kind }|null, needed_by|null, note|null,
                   lines: [{ ingredient_id, name, unit, qty, balance_at_request, hint|null,
                             price_minor|null }],
                   total_minor|null, receipt_document_id|null, revision, created_by_name, created_at,
                   submitted_by_name|null, submitted_at|null, closed_by_name|null, closed_at|null }],
      counts: { draft, submitted, received, cancelled }, limits: { requests: 200 },
      truncated: { requests: bool },
      // только с ?id=: текст для печати и копирования и приход по заявке
      text|null, receipt: { id, reference, created_at, lines }|null }
supply_request_save    { id, expected_revision, payload: { kind, supplier_id|null, needed_by|null,
                         note|null, lines: [{ ingredient_id, qty }] (0..100) } }
                         // сервер добавляет unit, balance_at_request, hint, price_minor
supply_request_submit  { id, expected_revision }      // остаток и подсказка - на момент подачи
supply_request_cancel  { id, expected_revision }      // причина - reason запроса
supply_request_receive { id, expected_revision, reference, document_date,
                         lines: [{ ingredient_id, quantity, value_minor, expected_revision }] (1..100) }
  → { id, state: 'received', receipt_document_id }
```

Заявка сама ничего не отправляет: кабинет печатает и копирует текст. Получение сразу проводит приход
(Ск6): в одной транзакции документ `receipt` с движениями, как команда `stock` (`meta`: откуда = вид
заявки, поставщик, дата накладной), и заявка `received`; количества и суммы прихода - фактические
(могут отличаться от заявки).

**Отчёты склада** (`BACKOFFICE_STOCK_REPORTS_ENABLED`):

```text
GET ops/stock-balances[?date=YYYY-MM-DD]          // без даты - сейчас, с датой - на конец дня Алматы
  → { schema_version: 1, branch_id, view: 'stock-balances', timezone, as_of, date|null,
      rows: [{ ingredient_id, name, unit, group|null, supply_kind|null, quantity, value_minor,
               average_cost_minor|null, minimum, below_minimum: bool, counted_at|null,
               last_movement_at|null }],
      totals: { items, value_minor, below_minimum }, consumption: Consumption,
      limits: { rows: 1000 }, truncated: { rows: bool } }
GET ops/stock-turnover?start_date&end_date[&ingredient_id=uuid]   // до 92 дней
  → { schema_version: 1, branch_id, view: 'stock-turnover', timezone, as_of, start_date, end_date,
      rows: [{ ingredient_id, name, unit, opening, receipts, waste, consumption, production_in,
               production_out, counts, reversals, closing }],      // каждое - { quantity, value_minor } со знаком
      totals: { … те же поля … }, consumption: Consumption }
GET ops/order-hint?kind=central_kitchen|bakery|household|supplier[&supplier_id=uuid][&days=7]
  → { schema_version: 1, branch_id, view: 'order-hint', timezone, as_of, kind, days,
      rows: [{ ingredient_id, name, unit, balance, minimum, hint, used_per_day|null, days_left|null,
               price: { supplier_id, unit, price_minor, valid_from }|null }],
      consumption: Consumption }
Consumption = { mode: 'off'|'dry_run'|'on'|'unavailable', start_at|null, backlog|null }
```

Честность: остатки и расход без автосписания не учитывают продажи. `consumption` - режим и `backlog`
автосписания bo-ui (`consumptionBacklog`, §5.5 BOUI-R2; `unavailable` - флага или прав 075 нет). Пока
режим не `on` или `backlog.stalled`, кабинет пишет «Продажи не списываются со склада автоматически:
остатки и расход - без продаж» или «Списание по продажам не работает: N продаж не обработаны с ЧЧ:ММ».
Начало периода - остаток после последнего движения до окна (движения неизменны, 017), конец = начало +
сумма движений окна (тест); подсказка без цены - если у поставщика нет цены в силе.

**Расстановка** (`BACKOFFICE_STAFF_ASSIGNMENT_ENABLED`):

```text
GET ops/staff-assignments?date=YYYY-MM-DD
  → { schema_version: 1, branch_id, view: 'staff-assignments', timezone, as_of, date,
      stations: [{ code, label, station|null }],        // должности списка точки в силе (§5.7)
      employees: [{ employee_id, name, position_code|null, extra_position_codes }],   // работающие
      open: [Assignment], intervals: [Assignment] }      // открытые сейчас и все интервалы бизнес-дня
Assignment = { id, employee_id, employee_name, station_code, station_label, business_date,
               started_at, ended_at|null, set_by_name, ended_by_name|null, revision }
staff_assign   { employee_id, station_code, started_at, expected_revision }  // ревизия открытого интервала или 0
staff_unassign { employee_id, ended_at, expected_revision }
```

Перестановка («Переставить с 13:30») в одной транзакции закрывает открытый интервал в момент начала
нового и открывает новый; начало не раньше начала открытого интервала. Бизнес-день - день открытой
смены менеджера, если она открыта, иначе день Алматы начала (правило 076). Станция - действующая
должность списка. Расстановка видна в табеле и в чек-листе смены менеджера.

Новые причины ошибок (`BackofficeErrorReasonSchema`, только при флагах, список уточняется в шагах):
`SUPPLIER_NAME_TAKEN`, `SUPPLIER_INACTIVE`, `PRICE_UNIT_MISMATCH`, `IMPORT_ALREADY_APPLIED`,
`IMPORT_STALE` (шаг 3), `REQUEST_LOCKED` (заявка не черновик), `ASSIGNMENT_OVERLAP`.

**Сделано в шаге 2 и отклонения от схем выше** (`packages/backoffice-core/src/supply.ts`,
`p2-commands.ts`; тесты `supply.test.mjs`, `supply-unit.test.mjs`):

- Команды разбираются схемой `P2Request` только при флаге (`Backoffice.p2Request`, по образцу
  `p1Request` и `P1_COMMAND_FLAGS`: `P2_COMMAND_FLAGS` - `supplyEnabled` и `stockV2Enabled`); со всеми
  флагами второй волны выключенными ничего не разбирается, команда - `INVALID_REQUEST`, вид - 404.
  Каждая команда - в общем конверте (`request_id`, digest, `bo_audit` с `before_value`/`after_value`,
  блокировка `bo:branch:<id>`), `expected_revision` обязательна; изменение без разницы не поднимает
  ревизию (как скидки).
- `GET ops/suppliers`: в ответе ещё `today`, `limits.prices` (1000) и с `?id` - `prices_truncated`.
  Цены поставщика упорядочены по позиции, единице и дню (новые выше) - это история цены по позиции;
  исправление строки поднимает её ревизию, прежняя цена - в `before_value` аудита.
- `GET ops/supply-requests`: `start_date` и `end_date` обязательны и с `?id`. Строки списка - без
  `lines` (`line_count` и `line_names` первых трёх; кабинет принимает ответ до 1 МБ, а 200 заявок по
  100 строк его превысили бы); у заявки ещё `unpriced_lines` и `cancel_reason` (из аудита команды
  отмены). С `?id` - `request` (заявка в любой день), `text`, `receipt` (`document_date`,
  `supplier_kind`, `supplier_name`, `total_minor`, фактические строки), `difference` (по каждой
  позиции заявки и прихода: заказали, получили, разница со знаком). Общий `open` - черновики и
  поданные заявки всех дней (кабинет говорит, что есть открытые заявки вне периода), и `today`.
- `supply_request_save`: `supplier_id`, `needed_by`, `note` можно не передавать (null); вид не
  меняется (`INVALID_REQUEST`); поставщик - этой точки, нужного вида (§9.2) и не в архиве
  (`SUPPLIER_INACTIVE`); позиция - активная. Ожидаемая сумма строки - по цене в силе на сегодня
  (день сохранения, при подаче - день подачи); если после округления 0, строка без цены.
- `supply_request_submit`: строки, `needed_by` не раньше сегодняшнего дня Алматы и поставщик у
  заявки поставщику, иначе `INVALID_REQUEST`/`REQUEST_INCOMPLETE` (новая причина).
- `supply_request_cancel` - черновик или поданная заявка; `supply_request_receive` - только поданная;
  иное состояние - `CONFLICT`/`REQUEST_LOCKED`. Ответ приёма - вся заявка и `difference`. Приход
  проводится кодом команды `stock` (`Backoffice.stock`: те же движения и средняя себестоимость), с
  `meta` (откуда = вид заявки, имя поставщика, дата накладной) и причиной запроса; неверная ревизия
  остатка - `CONFLICT`, ничего не записано. Связь «один раз» держит 076 (`receipt_document_id`
  UNIQUE, ставится один раз, `received` конечна); тест одновременного приёма двумя запросами даёт
  ровно один документ.
- `supplier_prices_import` и `scripts/supplier-prices-import.mjs` - не в шаге 2 (следующий шаг).

**Сделано в шаге 3 (импорт цен, Д6) и отклонения от схем выше**
(`packages/backoffice-core/src/supplier-import.ts`, `scripts/supplier-prices-import.mjs`; тесты
`supplier-import.test.mjs`, `tests/backoffice/supplier-prices-import.test.mjs`,
`tests/integration/backoffice-p2-supplier-prices-import.test.mjs`, `supplier-imports-ui.test.mjs`,
`supplier-imports-browser.test.mjs`; runbook `docs/operations/backoffice-supply.md` §5):

- Команда - частями. API принимает не больше 100 КБ JSON на команду
  (`packages/platform/src/http.ts`, общий `json` 100 KiB), а план до 5000 строк (076
  `row_count`) в одну команду не помещается. Поэтому вместо `rows: [...] (1..2000)` одна команда -
  одна часть плана:

  ```text
  supplier_prices_import { batch_id, source: 'iiko_export'|'csv', file_sha256, plan_sha256,
                           row_count (строк файла, 1..5000), part, parts (1..50),
                           summary (только в части 1), suppliers: [{ id, name, kind }] (0..200, новые),
                           prices: [{ supplier_id, ingredient_id, unit, price_minor, valid_from }] (1..500) }
    → { batch_id, part, parts, supplier_ids, suppliers_created, prices_created, unchanged }
  ```

  Часть 1 создаёт запись импорта (`UNIQUE(branch_id, plan_sha256)`) с отчётом, каждая часть -
  своих новых поставщиков и цены `source='import'`; каждая в общем конверте (`request_id`, digest,
  `bo_audit` с результатом части, блокировка точки), право `suppliers.write`, флаги
  `supplyEnabled` и `stockV2Enabled` (`P2_COMMAND_FLAGS`). `batch_id`, id новых поставщиков и
  `request_id` частей скрипт выводит из SHA-256 плана, поэтому повтор после потерянного ответа
  отправляет те же байты. Части проверяются по порядку: часть 2 без части 1 или от другого плана -
  `CONFLICT/IMPORT_STALE`; часть, уже записанная под другим `request_id`, -
  `CONFLICT/IMPORT_ALREADY_APPLIED` (новые причины `IMPORT_ALREADY_APPLIED`, `IMPORT_STALE`).

- Импорт только добавляет. Цена того же поставщика, позиции, единицы и дня с той же суммой -
  `unchanged`, без записи; с другой суммой, занятое название нового поставщика, поставщик в архиве,
  выключенная или чужая позиция - `CONFLICT/IMPORT_STALE`, часть не записана. Поэтому
  `prices_changed` из предложения шага 1 нет: импорт не меняет и не удаляет ни цен, ни поставщиков
  (исправление - вручную, `supplier_price_save`). Единица, которая не измеряет позицию, -
  `INVALID_REQUEST/PRICE_UNIT_MISMATCH`.
- `summary` (отчёт в `bo_supplier_price_imports.summary`) - строгая схема `ImportSummarySchema`:
  `{ schema: 'pickchick.supplier-prices-report/v1', file_name, profile: 'iiko'|'csv'|'custom',
parts, counts: { rows, matched, new_prices, unchanged, new_suppliers, not_found, ambiguous,
unit_mismatch, duplicates, conflicts, inactive, invalid, notes }, issues: [{ line, code, supplier,
name, text }] (до 300), issues_total }`, не больше 24 КБ; полный список строк - в файле плана.
  Коды строк - `IMPORT_ISSUE_CATEGORIES` (категория у каждого кода; скрипт и кабинет сверяются с
  ними тестами).
- Новый вид `GET ops/supplier-imports[?id=uuid]` (только при флаге, все роли, `reports.read`):
  последние 20 импортов с частями (`parts_applied` из аудита команд, `complete`), итогами и
  счётчиками отчёта; один (с `id` или последний) целиком - отчёт, поставщики импорта (создан ли
  импортом, сколько цен из него осталось), `prices_corrected` - сколько его цен исправлено вручную.
  Без флага - 404 неизвестного вида. Allowlist кабинета, прокси и регулярка шлюза дополнены.
- Отклонение в `GET ops/suppliers?id`: `imports[]` теперь без полного `summary`, только
  `file_name` и `counts`: 50 отчётов по 24 КБ превысили бы 1 МБ ответа кабинета; полный отчёт -
  `ops/supplier-imports?id`.
- Сопоставление позиций: «код» - это id позиции PickChick (uuid). Артикулы iiko в PickChick не
  хранятся (ингредиенты заведены из ТТК без артикулов), поэтому колонка артикула iiko не
  используется; без кода - точное название (регистр, пробелы, «ё» не важны), иначе отчёт.
- Кабинет: в «Поставщики и цены» блок «Импорт цен из iiko» (последний импорт или выбранный из 20:
  состояние словами, загружено, счётчики отчёта, строки с причиной и фильтром, поставщики импорта).
  Сервер без вида (404) - блока нет.
- `Ingredient.supply_kind` (§9.2) в шаге 3 не сделан: он нужен группировке подсказки к заказу и
  переходит в шаг отчётов склада.

**Сделано в шаге 4 (отчёты склада, Ск4) и отклонения от схем выше**
(`packages/backoffice-core/src/stock-reports.ts`; кабинет `apps/backoffice/src/stock-reports-model.ts`,
`inventory.ts`; тесты `stock-reports.test.mjs`, `stock-reports-unit.test.mjs`,
`tests/backoffice/stock-reports-p2-ui.test.mjs`, `stock-reports-p2-browser.test.mjs`):

- Отклонение: по заданию шага отчёты - виды существующего `GET ops/stock`, а не отдельные
  `ops/stock-balances`, `ops/stock-turnover`, `ops/order-hint` из предложения шага 1:
  `ops/stock?view=balances`, `ops/stock?view=reorder` (без других ключей запроса) и прежний
  `ops/stock?view=movement&start_date&end_date` (до 92 дней), который при флаге получает
  `turnover` и `consumption` после всех своих ключей bo-ui. Поэтому отчётам нужен склад v2:
  `loadConfig` не запускает API с `BACKOFFICE_STOCK_REPORTS_ENABLED` без
  `BACKOFFICE_STOCK_V2_ENABLED`, а `capabilities.stock_reports` - `true` только при складе v2 и
  читаемых столбцах 074 (`stockReportsAvailable`; без них `ops/stock` - 404 `STOCK_V2_DISABLED`).
  Без флага `view=balances|reorder` - `INVALID_REQUEST` строгой схемы bo-ui, `view=movement` -
  ответ bo-ui байт-в-байт (эталон: «comparison can fail» допускает при флаге только чтения и
  `ops stock movement` там, где склад v2 есть, и сверяет его без двух новых ключей). Имена
  `stock-balances`, `stock-turnover`, `order-hint` остаются неизвестными видами (404).
- `view=balances`: строки всех позиций (до 2000) - `ingredient_id, name, unit, active, group,
supply_kind, meat, quantity, value_minor, minimum, below_minimum, counted_at, last_movement_at,
last_purchase{quantity, value_minor, at, document_id}|null, value_last_price_minor|null, revision`;
  `totals { items, active, below_minimum, value_minor, value_last_price_minor, unpriced }`,
  `counted_at_known`, `consumption`. «Ниже минимума» - активная позиция с минимумом и остатком
  меньше него. Последняя цена закупки - последняя строка документа `receipt` с суммой больше нуля,
  не сторнированного; стоимость по ней - половина вверх (остаток × сумма / количество).
  Без `?date` (на конец дня) - не нужно заданию шага.
- `view=movement` + `turnover { rows, totals, mismatches, limits, truncated }`: по позиции
  `opening`, `receipts`, `production_in`, `consumption`, `waste`, `production_out`, `counts`,
  `reversals`, `transfers`, `in`, `out`, `closing` - каждое `{ quantity, value_minor }` со знаком;
  `totals` - только суммы (единицы позиций разные). Начало - остаток после последнего движения до
  окна (порядок `created_at`, `id`), конец = начало + движения окна, `in`/`out` - положительные и
  отрицательные движения, так что начало + пришло - ушло = конец по количеству и сумме. Конец
  сверяется с остатком после последнего движения окна: расхождение - id позиции в `mismatches`
  (кабинет пишет «не сходится»; в тестах всегда пусто).
- `view=reorder` (вместо `order-hint?kind&supplier_id&days`; фильтров нет, «Откуда» - поле
  строки): активные позиции с целью больше нуля, у которых остаток ниже цели (`state: 'below'`) или
  не больше цели плюс 20 % (`near`). Цель - минимум; у позиции «Мясо» - 3 дня расхода по большему
  из средних за 7 и 14 полных дней (вверх), но не меньше минимума (`target_rule: 'meat_days'`).
  `hint` = max(0, цель - остаток), `days_left` = остаток × дни / расход (вниз), `hint_value_minor` -
  по последней цене закупки. Отклонение от «только документы списания по продажам»: расход = списание
  по продажам (`consumption`, автоматические и ручные) + расход в производство (отрицательные
  движения `production`), каждый за вычетом своего сторно в день сторно; списания и инвентаризации
  не расход. Иначе сырое мясо, которое уходит в заготовку через «Производство», не имело бы расхода
  и правило «3 дня» к нему не применялось бы. Периоды - полные дни Алматы до сегодняшнего; при
  режиме `on` - не раньше первого полного дня после `start_at` (`periods.d7/d14` с днями), чтобы
  свежий запуск не занижал средний расход. Сортировка: ниже цели, затем меньше дней, затем имя.
- `consumption` (во всех трёх) = `{ mode: 'off'|'dry_run'|'on'|'unavailable', start_at, backlog,
sales_included }`; `sales_included` = режим `on` и `backlog.stalled=false`. Пока его нет, кабинет
  на каждой вкладке пишет, что цифры без продаж (или текст `stallText` о необработанных продажах).
- Право чтения - `reports.read`, все четыре роли; новых прав нет, `permissions[]` прежний.
  «Создать заявку» - право `supply.write` при `capabilities.supply` (кабинет), иначе кнопки нет или
  она неактивна с причиной словами.
- Объём: каждый отчёт читает движения всей истории точки (последнее движение до окна, последняя
  поставка) без индекса по `(branch_id, ingredient_id)` - DDL заморожен. На объёме одной точки
  (около миллиона движений за год) это доли секунды; если станет медленно - индекс отдельным CR.

**Сделано в шаге 5 (расстановка, А9) и отклонения от схем выше**
(`packages/backoffice-core/src/staff-assignments.ts`; кабинет `apps/backoffice/src/assignment.ts`,
`assignment-model.ts`, `workforce.ts`, `manager-shift-model.ts`; тесты `staff-assignments.test.mjs`,
`staff-assignments-unit.test.mjs`, `tests/backoffice/assignment-ui.test.mjs`,
`assignment-browser.test.mjs`, `tests/integration/backoffice-p2-golden.test.mjs`):

- **Станции - коды кухни.** Должность с функциями KDS даёт по станции на функцию с кодом функции и
  названием экрана кухни (`KdsFunctionSchema`, `packages/contracts`): `issue` «Выдача (2)»,
  `delivery_handover` «Выдача доставки (3)», `assembly_hall` «Сборка - зал (стол 1)»,
  `assembly_delivery` «Сборка - доставка (стол 2)», `toasts` «Тосты и бургеры (5)», `breading`
  «Панировка (6)». Должность с номером станции без экрана - станция с кодом должности: `cashier`
  «Кассир (1)», `fryer` «Жарщик (7)», `prep` «Заготовщик (8)», `runner` «Раннер (9)». У менеджеров
  станции нет. Отклонение от схемы шага 1 выше («станция - должность списка»): «Сборщик» даёт две
  станции, стол 1 и стол 2, иначе ошибки КД9 по столу нельзя отнести к людям. Код подходит под
  проверку 076 (`^[a-z][a-z0-9_]{1,39}$`), DDL не менялся. Список - из должностей в силе
  (`readStaffPositions`); станция выключенной должности новых не принимает
  (`INVALID_REQUEST/STATION_UNKNOWN`), но в истории остаётся со своим названием.
- **Команды - день смены и время ЧЧ:ММ** вместо момента `started_at`/`ended_at` предложения шага 1:

  ```text
  staff_assign   { employee_id, station_code, business_date, time: 'ЧЧ:ММ', expected_revision,
                   override_reason? (3..300) }   // ревизия открытого интервала сотрудника или 0
  staff_unassign { employee_id, time: 'ЧЧ:ММ', expected_revision }   // ревизия открытого интервала
    → { assignment: Assignment, closed: Assignment|null, changed: bool }
  ```

  Момент считает PostgreSQL (Asia/Almaty): время 00:00-05:59 - ночь после дня смены (следующий
  календарный день), с 06:00 - сам день. Поэтому бизнес-день интервала - день Алматы его начала
  минус 6 часов, и проверка 076 (день начала или предыдущий) держится по построению. Конец
  `staff_unassign` - время того же дня смены, что у интервала: ночной интервал (начат до 06:00)
  кончается до 06:00 того же утра. При часах точки 10:00-00:00 ночь кончается задолго до 06:00
  (вопрос владельцу §9.6 в.7).

- **Бизнес-день по умолчанию** (`today` вида, его берёт кабинет) - день Алматы «сейчас минус 6
  часов». Отклонение от «день открытой смены менеджера, если она открыта»: при обычной работе (смена
  открывается после 06:00, закрывается до 06:00) это один и тот же день, а забытая открытой смена
  прошлых суток не уводит утреннюю расстановку в прошлый день. Открытая смена показана в виде
  (`manager_shift`), её проверка «Расстановка заполнена» считает интервалы её дня.
- **Правила.** Один открытый интервал сотрудника (076). Перестановка в одной транзакции закрывает
  открытый интервал в момент нового начала и открывает новый. Начало не раньше начала открытого
  интервала и не внутри прежнего (`CONFLICT/ASSIGNMENT_OVERLAP`; проверка до записи, триггер 076 -
  страховка). Перестановка - в том же дне смены, что открытый интервал, иначе
  `CONFLICT/ASSIGNMENT_PREVIOUS_DAY` (сначала «Закончить» интервал прошлого дня). Время не позже
  часов БД плюс 5 минут, конец не раньше начала (`INVALID_REQUEST/ASSIGNMENT_TIME`). Та же станция -
  ничего не меняется (`changed: false`, ревизия прежняя). Карточка - работающая
  (`INVALID_REQUEST/EMPLOYEE_NOT_WORKING`), чужая - `NOT_FOUND`. Чужая ревизия - `CONFLICT`. Каждая
  команда - в общем конверте (`request_id`, digest, `bo_audit` действия `staff_assign` или
  `staff_unassign` с `before_value` = открытый интервал, блокировка точки).
- **Только по должности.** Станция должна входить в `position_code` или `extra_position_codes`
  карточки; иначе `INVALID_REQUEST/STATION_NOT_ALLOWED`. С причиной `override_reason` (3-300
  символов) и правом `staff.assign_override` (только управляющий; начальнику смены -
  `FORBIDDEN/ROLE_FORBIDDEN`) интервал открывается; причина хранится в
  `bo_audit.after_value.assignment.override_reason` команды, которая открыла интервал (без DDL), вид
  читает её оттуда и показывает в истории.
- **Вид** `GET ops/staff-assignments` (читают все роли кабинета; без флага - 404 неизвестного вида):

  ```text
  ?date=ГГГГ-ММ-ДД | без ключей (день по умолчанию)
    → { schema_version: 1, branch_id, view: 'staff-assignments', timezone, as_of, today,
        night_end: '06:00', manager_shift: { id, business_date, opened_at }|null, mode: 'day', date,
        stations: [{ code, label, number, kds|null, positions, active }],
        employees: [{ employee_id, name, position_code, extra_position_codes, stations }],
        intervals: [Assignment] (до 500, по началу),
        earlier_open: [Assignment] (открытые с прошлых дней),
        counts: { intervals, open, employees }, limits, truncated }
  ?start_date&end_date[&employee_id][&station_code]   // окно до 92 дней по дню смены
    → { ...та же шапка, mode: 'range', start_date, end_date, employee_id|null, station_code|null,
        stations, employees: [{ employee_id, name }],
        intervals: [{ id, employee_id, station_code, business_date, started_at, ended_at }],
        // до 3000
        limits, truncated }
  Assignment = { id, employee_id, employee_name, station_code, station_label, business_date,
                 started_at, ended_at|null, set_by_name, set_at, ended_by_name|null, revision,
                 override_reason|null }
  ```

- **Табель.** При `capabilities.staff_assignment` вкладка «Табель» (раздел «Смены») берёт окно
  месяца и показывает в списках «День» и «Неделя» колонку «Станции» («Сборка - зал (стол 1)
  10:00 - 13:30; Выдача (2) с 13:30»), в сетке месяца - станции в подписи ячейки и точку после
  часов, и строку «По «Расстановке» работали, но в табеле нет записи». Часы табеля расстановка не
  меняет.
- **Чек-лист смены менеджера.** Пункт «Расстановка заполнена» в закрытии (обязательный, проверка
  `staff_assignment`) есть только при доступной расстановке и не входит в шаблон: вид
  `ops/manager-shifts` отдаёт `extra_items: { opening: [], closing: [пункт] }` последним ключом и
  `checks.staff_assignment` последней проверкой, команды закрытия проверяют его после пунктов
  шаблона. Схема шаблона точки прежняя (пункт с этой проверкой в шаблон не сохранить). Проверка -
  `problem`, пока за день смены нет ни одного интервала, пока кто-то из опубликованного графика дня
  без интервала или пока открыт интервал прошлого дня; факты: `intervals`, `employees`, `open`,
  `stations`, `missing` (до 10 имён), `missing_count`, `earlier_open`. Без флага вид и команды
  смены - как у bo-ui (эталон); кабинет не отправляет из черновика ответ на пункт, которого нет.
- **Эталон.** Тест «comparison can fail» для расстановки: при флаге меняются ровно чтения (ключ
  `staff_assignment`, при ролях - два права в конце `permissions[]`), `ops/staff-assignments`
  (без должностей - `NOT_READY`) и, где есть смена менеджера и должности, `ops/manager-shifts`. Тела
  команд эталона (предложение шага 1 с `started_at`) остаются неизвестными командами.

**Чтение для КД9 (ошибки сборки по людям; КД9 не строится в этой полосе).** Учёт возвратов
«Вернуть на сборку» ведётся по столу (`assembly_hall` - стол 1, `assembly_delivery` - стол 2) и по
дню (`design-kds.md` КД9). Кто стоял за столом, отвечает расстановка:

- HTTP: `GET .../ops/staff-assignments?start_date&end_date&station_code=assembly_hall` (окно до 92
  дней по дню смены, до 3000 интервалов, `truncated`). Событие в момент `t` на станции `S` относится
  к интервалам этой станции с `started_at <= t < ended_at` (открытый - до «сейчас»). На одной
  станции могут стоять несколько человек: ошибка относится ко всем, кто стоял, или делится - решает
  КД9. Интервал нулевой длины (исправлен в ту же минуту) никому не относится.
- На сервере: `assignedAt(db, branch, station, at)` из `@pickchick/backoffice-core` - те же
  интервалы одним запросом (индекс 076 `(branch_id, business_date, started_at)` для окна; для точки
  во времени - отбор по станции и началу).
- Станции кухни - коды функций KDS, те же, что `details.kds.function` задач и
  `fulfillment_returns`; станции без экрана (касса, жарка, заготовка, раннер) в КД9 не участвуют.
- День смены интервала - `business_date`; момент события сравнивается с моментами, не с днём.

### 9.5 Порядок работ полосы bo-ui2 (шаги 2-6 - предложение)

1. Шаг 1 (сделан): 076, `backoffice-supply-grants.mjs`, флаги и ключи, эталон `aff89ce6`, CR `bo-ui2-1`,
   этот раздел. `p1-schema.test.mjs` bo-ui ждёт теперь 075 и все следующие файлы (CR `bo-ui2-1` §3).
2. Поставщики, цены и импорт (`scripts/supplier-prices-import.mjs`), `supply_kind`.
3. Заявки и приход по заявке.
4. Отчёты склада и расстановка.
5. Кабинет: разделы, печать и копирование, CSV, телефон 390 px.
6. Проход браузером по всем экранам и ролям, runbook `docs/operations/backoffice-supply.md`, полный прогон.

Каждый шаг: тест «флаг выключен - прежний ответ» (эталон §9.1), права по §9.3 с отказом для каждой
роли, идемпотентность команд, деньги целыми тиынами.

Как вышло: шаг 2 - поставщики, цены и заявки с приходом по заявке; шаг 3 - импорт цен; шаг 4 -
отчёты склада и `supply_kind`/`meat`; шаг 5 - расстановка; шаг 6 (сделан) - проход браузером
(`tests/backoffice/p2-pass-browser.test.mjs`: четыре роли, 1440 и 390 px, все флаги, 102 экрана) с
исправлениями кабинета, открытые пункты прошлых шагов и runbook `docs/operations/backoffice-supply.md`
(«Коротко»: флаги, порядок 13.11-19.11, роли, откат; §10 проход и тесты; §11 чего пока нет).
Пункты прошлых шагов, закрытые в шаге 6:

- `supplyAvailable` требует и чтения столбцов прихода 074 (`stockV2Readable`): карточка заявки
  читает приход обратно; роль без чтения получает `supply=false` и `NOT_READY`, а не ошибку.
- Откат расстановки проверен: после закрытия смены с пунктом «Расстановка заполнена» бэк-офис без
  флага читает закрытую смену ровно так, как она сохранена (PostgreSQL), и кабинет показывает ответ,
  комментарий и авто-проверку (Chromium).
- Старый API без `ops/supplier-imports` (404) скрывает только блок импорта; ошибка 503 - словами в
  блоке, остальная страница работает (Chromium).
- Остаток на конец прошлого дня отдельным видом не делается: это «На конец» в «Движении» за период,
  который кончается этим днём. Цена поставщика в «К заказу» не дублируется: её показывает редактор
  заявки с выбранным поставщиком.

### 9.6 Вопросы владельцу (с умолчанием)

1. **Цены поставщиков видят все роли** (начальник смены, аналитик) - как стоимость в отчётах склада.
   Если цены закупки нужно скрыть от начальника смены - отдельное право чтения.
2. **Поставщиков и цены ведут** управляющий и бухгалтер; заявки - управляющий и начальник смены;
   принимают поставку все, кому разрешён приход (управляющий, начальник смены, бухгалтер).
3. **Хозтовары** - заявка без поставщика (свой хоз склад) или поставщику вида «поставщик».
4. **Расстановка после полуночи** относится к бизнес-дню открытой смены менеджера.
5. **Приём поставки по заявке и отмена заявки** - только управляющий (шаг 2). Если вечернюю поставку
   принимает начальник смены без управляющего, он проводит обычную «Поставку» на странице «Остатки»
   (P0), а заявку закрывает управляющий; либо владелец выдаёт начальнику смены `supply.close`.
6. **«К заказу»** (шаг 4): цель мяса - 3 дня расхода, «рядом» - до цели плюс 20 %, расход -
   продажи и расход в производство за 7 и 14 полных дней. Если владелец хочет другое число дней или
   отдельную цель для каждой позиции - поле карточки вместо флажка «Мясо» (без DDL).
7. **Ночь расстановки** (шаг 5): время 00:00-05:59 относится к дню смены накануне. При часах
   10:00-00:00 и уборке до 01:00-02:00 это безопасно; если смена начинается раньше 06:00 или
   кончается позже, граница - одна константа `NIGHT_END` (`staff-assignments.ts`) и тест.
8. **Не по должности ставит только управляющий** (шаг 5, по заданию: «unless the manager confirms an
   override with a reason»). Если начальник смены в вечерний час пик тоже должен ставить не по
   должности - одна строка `staff.assign_override` в `P2_ROLE_PERMISSIONS.shift_manager` и тест
   матрицы; без этого он ставит сотрудника по его должности или просит управляющего добавить ему
   доп. станцию в карточке.
9. **«Расстановка заполнена» - пункт закрытия смены**, не открытия: к открытию люди ещё приходят, к
   закрытию день виден целиком (для КД9 важна полнота дня). Если пункт нужен и при открытии - тот же
   механизм (`extra_items.opening`).
