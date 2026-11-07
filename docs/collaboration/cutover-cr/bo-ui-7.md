# CR bo-ui-7: скидки - редактор в бэк-офисе и что нужно кассе (шаг 7 полосы bo-ui)

Полоса: bo-ui (шаг 7). Кому: полоса pos (§2, главное), integration (§1). Флаг:
`BACKOFFICE_DISCOUNTS_ENABLED` (CR `bo-ui-1` §2, по умолчанию `false`). Дизайн: `design-bo-ui.md` §5.8
(сделано и заметка P1 для кассы), runbook: `docs/operations/backoffice-p1-cutover.md`, раздел «Скидки».
Основание: контракт §00 п.2 и вопрос 23 (скидки создаются и меняются только в бэк-офисе, касса
применяет их с PIN начальника смены, на запуске скидок нет, механизм кассы - P1), решение владельца
05.11 (экраны P1 бэк-офиса делаются сейчас за флагами).

Почему отдельный номер: задача шага называла `bo-ui-2.md`, но это CR шага 2 («Касса»). Чтобы не
смешивать темы и не переписывать принятый CR, скидки - здесь; в `bo-ui-2.md` добавлен §4 со ссылкой.

Что сделано в `codex/cutover-bo-ui` (коммиты шага 7):

- ядро `packages/backoffice-core/src/discounts.ts`: `GET .../ops/discounts[?id=]`, команды
  `discount_save` и `discount_state` (общий конверт: `request_id`, digest, `bo_audit`, блокировка
  точки, `expected_revision`), право `discounts.write` (только управляющий);
- кабинет: раздел «Скидки» с плашкой «Скидки пока не применяются на кассе. Включим после проверки на
  кассе.», список, редактор, включение, выключение, архив, история;
- ничего не публикуется: ни `bo_publications`, ни `bo_delivery_outbox`, ни меню, ни edge.

## 1. Integration

1. **Контракт и OpenAPI не меняются.** Вид идёт через общий `GET .../ops/:view`, команды - через
   общий `POST .../commands`; тела видов в `openapi.json` не описаны (как `ops/stock`).
   `contracts:check` после шага проходит без изменений.
2. **Права.** Ничего нового: вызов helper P1 из CR `bo-ui-1` §1 уже передаёт `discounts`
   (`SELECT, INSERT, UPDATE` на `bo_discounts`, `SELECT` на `bo_discount_revisions`; историю пишет
   триггер владельца 075). Проверка состава скидки читает опубликованный каталог
   (`catalog_publications`, `catalog_branch_heads`): общая роль API получает это чтение от
   `infra/staging/catalog-admin-grants.mjs` (всегда) и `backoffice-grants.mjs`. Без него сохраняется
   только скидка «на всё меню» (`NOT_READY/CATALOG_NOT_PUBLISHED`). Тест
   `discounts.test.mjs` «API role» проверяет редактор ровно с этими правами.
3. **Шлюз и прокси кабинета** - в файлах полосы: `infra/public-staging/gateway.Caddyfile`
   (`/ops/(...|staff-roster|discounts)`), `apps/backoffice/server.mjs` (только ключ `id`, uuid;
   предел ответа 4 МиБ). При конфликте с другими полосами в той же строке - объединить вручную,
   оставив все виды.
4. **Тесты облачной полосы.** `tests/integration/backoffice-p1-flags.test.mjs`: `without()` снимает
   `discounts.write` с конца `permissions[]`, HTTP-часть проверяет 404 без флага и 200 с флагом.
   `tests/backoffice/pos-day-ui.test.mjs` теперь ждёт, что `ops/discounts` разрешён. При слиянии
   брать версии bo-ui.
5. **Порядок включения.** Безопасно в любой момент после Cloud-2: скидки только хранятся.
   Рекомендация: не включать до 19.11 без просьбы владельца; включить, когда владелец захочет
   готовить скидки заранее.

## 2. Полоса pos: применение скидок на кассе (P1, не к 19.11)

Предложение интерфейса (подробно - `design-bo-ui.md` §5.8, заметка P1). Всё ниже - работа полосы pos
и integration; бэк-офис уже хранит всё нужное и ничего не отдаёт, пока нет решения.

1. **Что получит edge** - целый набор включённых скидок точки (`state=active`), заменяющий прежний;
   пустой набор - скидок нет. Публикация - только после отдельного флага (по умолчанию выключен):

   ```text
   DiscountSet = { schema_version: 1, branch_id, version: int (растёт), generated_at,
     discounts: [{ discount_id, revision, name, kind: 'percent'|'amount',
                   percent_bp|null,            // 100..10000 (1-100 %)
                   value_minor|null,           // целые тиыны, до 100000000
                   channels: ['hall'|'yandex_eda'|'glovo'|'chocofood'],
                   categories: [slug], products: [slug],   // пусто и пусто = всё меню
                   valid_from|null, valid_until|null,       // [от, до), ISO UTC
                   weekdays: [1..7], hours: [{ from: 'HH:MM', to: 'HH:MM' }],  // Алматы, пусто = весь день
                   requires_manager_pin, combinable }] }
   ```

   Каналы `mobile` и `kiosk` хранятся в бэк-офисе, но кассе не нужны (облачные каналы, позже).
   Доставка: новый вид в канале доставки бэк-офиса на edge (`bo_delivery_outbox`) или отдельный
   поток - решает integration. На edge - `pos_discount_presets` (edge 028+, резерв P1 контракта) и
   `GET pos/config` → `discounts[]` (`design-pos.md`, таблица маршрутов кассы).

2. **Применение и PIN.** Кассир выбирает скидку в чеке; касса проверяет канал, период, день недели
   и час по Алматы и состав чека. `requires_manager_pin=true` - approval `discount` (уже в
   `ApprovalActionSchema`, `packages/contracts/src/cutover-enums.ts:45`, «P1, accepted by the
   database from day one») с PIN учётной записи роли `shift_manager`. `combinable=false` - в чеке
   только она; `combinable=true` - только с такими же. Скидка не применяется к чекам без выручки
   (`staff_meal`, `marketing`).
3. **Расчёт (предложение, решает полоса pos).** База - сумма подходящих позиций по цене канала с
   модификаторами. Процент: `round_half_up(база × percent_bp / 10000)`; сумма:
   `min(value_minor, база)`. Скидка раскладывается по подходящим позициям пропорционально (метод
   наибольшего остатка) целыми тиынами; строка не ниже 0. Несколько суммируемых - по очереди от
   остатка.
4. **Контракт и данные продажи.**
   - `QuoteSchema.discount_minor`: сейчас `z.literal('0')` (`packages/contracts/src/index.ts:446`),
     касса считает `'0'` (`packages/local-orders/src/pricing.ts:79`) - становится суммой;
   - событие `pos_sale`: `subtotal_minor - discount_minor = total_minor` (приёмник облака уже это
     проверяет, `packages/pos-order-sync/src/sales-model.ts:178`), новое необязательное поле
     `discount` (`discount_id`, `revision`, `name`, `kind`, `percent_bp` или `value_minor`,
     `approved_by_staff_id`) и `discount_minor` у строки;
   - проверка «без скидки» в `packages/pos-order-sync/src/model.ts:66`
     (`q.total_minor !== q.subtotal_minor`) снимается для продаж со скидкой;
   - облако: `cloud_pos_sales.discount_minor` уже есть (073); для отчёта по скидкам -
     `discount jsonb NULL` новой облачной миграцией (номер у integration), приёмник хранит его как есть;
   - X/Z-отчёт: строка «Скидки» (сумма и число чеков) - по желанию полосы pos.
5. **Возврат** позиции возвращает оплаченную сумму строки, то есть после её доли скидки.
6. **Webkassa** (ручная): кассир вводит скидку так же, как в чеке кассы.
7. **Что сделает бэк-офис потом** (полоса bo-ui или её преемник): `applied_at_pos=true` в
   `ops/discounts` убирает плашку; «Касса» уже показывает `discount_minor` каждого чека
   (`ops/pos-day`); отчёт продаж получит строку «Скидки» и разбивку по `discount_id`.

Вопросы к полосе pos (умолчание в скобках):

- округление - на всю базу, затем раскладка (да) или по каждой строке отдельно;
- заказы агрегаторов, введённые с планшета: сумма приходит от агрегатора, своя скидка разойдётся с
  выплатой агрегатора (канал можно отметить, но касса применяет скидку только к залу и ChocoFood,
  пока владелец не решит иначе);
- кто подтверждает: только `shift_manager` (да) или и учётная запись управляющего.

## 3. Полоса cloud: для сведения

- Скидки не попадают в меню и в публикации каталога: `catalog_*`, `menu_*`, `bo_publications`,
  `bo_delivery_outbox` не меняются (тест `discounts.test.mjs` «never published»).
- Новые причины ошибок только при флаге: `DISCOUNT_NAME_TAKEN`, `DISCOUNT_ARCHIVED`,
  `DISCOUNT_PERIOD_ENDED` (`packages/backoffice-core/src/model.ts`).
