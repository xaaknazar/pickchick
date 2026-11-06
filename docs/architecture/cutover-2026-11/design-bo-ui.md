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
kind `assignment`) в 075 не входят.

Опорные данные: продажи кассы - таблицы 073 (`cloud_pos_*`, приёмник CC-4), отчёт продаж - CC-7
(`ops/sales`), роли - CC-5 (`roles.ts`), склад v2 - CC-6 (`stock-v2.ts`, `ops/stock`).

Разрыв с iiko (`iiko-gap.md`, план P0-0...P0-6) по шагам полосы (§7). Отдельный флаг «Кассы» ввело
решение владельца 05.11 (`BACKOFFICE_POS_DAY_ENABLED`) вместо `BACKOFFICE_SALES_REPORT_ENABLED` из плана.

| iiko-gap | Что                                                                             | Где                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-0     | старт и CR                                                                      | шаг 1, CR `bo-ui-1`                                                                                                                           |
| P0-1     | `GET ops/pos-day`                                                               | шаг 2                                                                                                                                         |
| P0-2     | раздел «Касса»: «Смены и Z», «Чеки», «Webkassa», три CSV                        | шаг 3                                                                                                                                         |
| P0-3     | «Главная» и честные тексты (названия состояний, каналов, способов; P0-8, P0-13) | шаг 3                                                                                                                                         |
| P0-4     | отчёт списаний по причинам                                                      | сделан облачной полосой (CC-6: `ops/stock?view=waste\|movement`, «Списания по причинам»); полоса добавляет `variance` и `consumption` (шаг 4) |
| P0-5     | `edgeStaffId` и `scripts/edge-staff-id.mjs`                                     | шаг 2                                                                                                                                         |
| P0-6     | проверка и выпуск                                                               | шаг 8                                                                                                                                         |

## 2. Флаги и совместимость

Все - env API, `true|false`, по умолчанию `false`, только облачный API с `BACKOFFICE_ENABLED=true`
(проверяет `loadConfig`, `packages/platform/src/config.ts`, список `BACKOFFICE_P1_FLAGS`). Поле
`ServiceConfig` появляется только при включённом флаге; кабинету флаги передаёт
`backofficeP1Options(config)` (`packages/backoffice-core/src/p1-flags.ts`).

| Флаг                                   | `capabilities` в `GET branches/:id` (только при `true`) | Значение ключа                                                                                                 | Зависит от                    | Откат                                            |
| -------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------ |
| `BACKOFFICE_POS_DAY_ENABLED`           | `pos_day`                                               | всегда `true`: без 073 вид отвечает `coverage.pos_tables=false`                                                | -                             | `false`                                          |
| `BACKOFFICE_STOCK_AUTOCONSUME_ENABLED` | `stock_autoconsume`                                     | склад v2 включён и таблицы 075 настроек и очереди доступны роли на запись                                      | `BACKOFFICE_STOCK_V2_ENABLED` | режим `off` или флаг `false`; документы остаются |
| `BACKOFFICE_MANAGER_SHIFTS_ENABLED`    | `manager_shifts`                                        | `bo_manager_shifts` доступна на запись                                                                         | -                             | `false`; смены остаются                          |
| `BACKOFFICE_STAFF_POSITIONS_ENABLED`   | `staff_positions`                                       | всегда `true` (только поля карточки)                                                                           | -                             | `false`; поля в карточке остаются                |
| `BACKOFFICE_DISCOUNTS_ENABLED`         | `discounts`                                             | `bo_discounts` на запись и история на чтение                                                                   | -                             | `false`                                          |
| `BACKOFFICE_STOCK_V2_ENABLED` (есть)   | `stock_p1` (новый, шаг склада)                          | ключ есть только при флаге **и** доступных таблицах 075 склада; иначе ключа нет, ответ - как у облачной полосы | 075                           | `false`                                          |

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

| Право                  | manager | shift_manager | accountant | analyst | Команды                                                  |
| ---------------------- | ------- | ------------- | ---------- | ------- | -------------------------------------------------------- |
| `stock.reverse`        | да      | -             | да         | -       | `stock_reverse`                                          |
| `menu_links.write`     | да      | -             | -          | -       | `menu_link_save`                                         |
| `menu_links.approve`   | да      | -             | -          | -       | `menu_links_approve` (шеф утверждает через управляющего) |
| `stock.settings`       | да      | -             | -          | -       | `stock_settings`                                         |
| `consumption.write`    | да      | да            | -          | -       | `consumption_retry`, `consumption_skip`                  |
| `manager_shifts.write` | да      | да            | -          | -       | `manager_shift_open`, `_save`, `_close`                  |
| `staff.positions`      | да      | -             | -          | -       | поля должности в карточке, `ops/staff-roster`            |
| `discounts.write`      | да      | -             | -          | -       | `discount_save`, `discount_state`                        |

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
`DISCOUNT_NAME_TAKEN`.

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

### 5.8 Скидки (`BACKOFFICE_DISCOUNTS_ENABLED`)

```text
GET ops/discounts → { discounts: [Discount], history?: (при ?id=) [{ revision, snapshot, changed_by_name, changed_at }] }
Discount = { id, name, kind: 'percent'|'amount', percent_bp|null, value_minor|null,
             scope: { categories: [slug], products: [slug], channels: ['hall'|'yandex_eda'|'glovo'] },
             schedule: { start_at|null, end_at|null, weekdays: [1..7], hours: [{ from: 'HH:MM', to: 'HH:MM' }] },
             requires_manager_pin, combinable, state, revision, updated_by_name, updated_at }
discount_save  { id, expected_revision, payload: Discount без id/state/revision }   // 0 - новая, в draft
discount_state { id, state: 'draft'|'active'|'archived', expected_revision }
```

Скидки нигде не применяются и не публикуются: ни outbox, ни меню, ни edge. Экран пишет: «Касса пока
не применяет скидки. Они начнут работать после обновления кассы». На запуске скидок нет.

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
4. Склад: сторно, `variance`/`consumption`, быстрые плитки и выход ТТК, связи меню (API и экран).
5. Автосписание: ядро, воркер, настройки, очередь, экран.
6. Смена менеджера и персонал (должности, выгрузка, `staff-roster-apply`, `staff-pin-batch`).
7. Скидки и исправления аудита без флага.
8. Runbook `docs/operations/backoffice-p1-cutover.md`, дополнения `backoffice-cutover.md`, CR маршрутов
   для `scripts/contracts.mjs`, полный прогон наборов и `pnpm check`.

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
