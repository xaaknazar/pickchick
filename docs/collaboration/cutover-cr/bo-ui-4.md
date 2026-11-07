# CR bo-ui-4: склад P1 под `BACKOFFICE_STOCK_V2_ENABLED` (шаг 4 полосы bo-ui)

Полоса: bo-ui (шаг 4). Кому: integration. Основание: дополнение контракта для полосы bo-ui (склад P1 -
сторно, отчёт списаний, быстрое списание - за существующим `BACKOFFICE_STOCK_V2_ENABLED`),
`design-bo-ui.md` §2, §5.2, §5.4, §8 в.5. Код - только пути полосы: `packages/backoffice-core/**`,
`apps/backoffice/**`, `tests/backoffice/**`, `tests/integration/backoffice-p1-flags.test.mjs`. DDL
075 не менялся. Runbook: `docs/operations/backoffice-p1-cutover.md`, раздел «Склад P1».

## 1. Что меняется и когда (подтвердить умолчание §8 в.5)

Склад P1 включается без нового флага, когда одновременно:

- `BACKOFFICE_STOCK_V2_ENABLED=true` в API;
- на базе 075;
- helper `backoffice-p1-grants.mjs` выдал роли API права склада (`stockV2: true`, вызов из CR
  `bo-ui-1` §1 с тем же env), то есть `stockP1Ready` в `packages/backoffice-core/src/stock-p1.ts`.

Тогда, и только тогда:

| Где                             | Что добавляется                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET branches/:id`              | `capabilities.stock_p1=true` (последний ключ); `counted_at` в строках `stock`; в строках `documents` ключи `reason_code`, `meta`, `source_ref`, `reverses_document_id`, `reversed_by`, `reversed_at`, `reverses` |
| `permissions[]` (роли включены) | `stock.reverse` у управляющего и бухгалтера (последним; в `BACKOFFICE_PERMISSIONS` не входит)                                                                                                                    |
| `GET ops/stock`                 | ссылки сторно в `documents[]`; `view=waste` - сторно списаний как отрицательные записи и счётчик `reversals`; `view=movement` - вид `reversal`                                                                   |
| `POST commands`                 | `stock_reverse {document_id, expected_balances}` (своя схема `P1Request`); `quick_waste` в карточке ингредиента; подсчёт двигает `bo_stock_balances.counted_at`                                                  |
| Кабинет                         | плашка о продажах, «Последний подсчёт», плитки списания, сторно, вкладки «Списания» и «Движение» с CSV                                                                                                           |

Без любого из трёх условий ответы, поведение БД и кабинет - как у облачной полосы (тесты
`stock-p1.test.mjs` «flag off», «stock v2 without 075», «least privilege»; браузер `stock-p1-browser`
режим off; `roles-stock-browser` на 074).

Просьба: подтвердить, что склад P1 выходит вместе со складом v2 (включение 16.11 по контракту), или
назвать отдельный флаг - тогда меняется одно условие `stockV2Enabled` в `stockP1Ready`/`p1Capabilities`
и `index.ts` (одна функция). Отдельно отключить склад P1 при включённом складе v2 можно уже сейчас:
helper P1 с `stockV2: false` (runbook, «Откат»).

## 2. Тесты облачной полосы, которые теперь ждут склад P1 на 075 (при слиянии)

На полной схеме тестовая роль - владелец, поэтому при складе v2 склад P1 включён. Поменяны ожидания:

- `packages/backoffice-core/tests/stock-v2.test.mjs`: `by_day` со счётчиком `reversals: 0`, ключи
  документа `GET branches/:id` с ключами P1 (без 075 ключи прежние - `stock-p1.test.mjs`);
- `packages/backoffice-core/tests/p1-schema.test.mjs`: после 075 ответы равны прежним за вычетом
  добавок склада P1 (все значения на старых строках - `null` или сохранённые);
- `tests/backoffice/ops-http.test.mjs`: `reversals: 0` в отчёте, плюс сторно через прокси;
- `tests/backoffice/roles-stock-browser.test.mjs` и `roles_stock_ui.py`: два прогона - база 074
  (вкладка облачной полосы «Списания и поставки») и 075 (вкладки «Списания» и «Движение»);
- `tests/integration/backoffice-p1-flags.test.mjs`: при флагах облака ключ `stock_p1` последним.

Если облачная полоса меняет эти тесты после 43806cf4, при слиянии сохранить обе части.

## 3. Контракты

`stock_reverse` разбирается схемой `P1Request` только при флаге (правило §2.2 дизайна), поэтому
`BackofficeRequest` в `openapi.json` прежний и `contracts:check` согласен. Описать P1-команды в
`scripts/contracts.mjs` - шаг 8 полосы (CR маршрутов) или интеграция.

## 4. Найдено, не исправлено (код облачной полосы, решение за интеграцией)

`packages/backoffice-core/src/model.ts`: `const positive = Amount.refine((v) => BigInt(v) > 0n)`.
Zod 4 выполняет `refine` и после неудачного `regex`, поэтому строка `'1.5'` или `'abc'` в
`amount_minor` команд `refund`/`manual_refund` или в `yield_quantity` техкарты бросает `SyntaxError`
(проверено: `Command.safeParse({type:'refund', ..., amount_minor:'1.5'})`), API отвечает 500 вместо 400. Деньги не меняются (транзакция не начинается), но ответ неверный. Исправление в одну строку
(`Amount.refine((v) => /^\d+$/.test(v) && BigInt(v) > 0n)` или регулярка без `refine`) меняет код
ответа при выключенных флагах, поэтому полоса его не делала. Схемы склада P1 этой ошибки не имеют
(`QuickWasteSchema` - только регулярка, тест).
