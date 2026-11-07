# CR bo-ui-8: завершение полосы bo-ui - 075 до Т7, маршруты `ops/<view>`, заметки к слиянию

Полоса: bo-ui (шаг 8, завершение). Кому: integration (§1-§3), владелец и полосы pos/cloud (§4 - сводка
открытых вопросов полосы). Runbook: `docs/operations/backoffice-p1-cutover.md` (раздел «Коротко»:
флаги, порядок 13.11-19.11, роли, откат). Дизайн: `design-bo-ui.md` §5.2, §5.4, §5.6, §7 шаг 8, §8 в.10.

Что сделано в шаге 8 (коммиты `codex/cutover-bo-ui` после `175d192b`):

- ядро: `GET .../ops/stock?view=variance|consumption` при складе P1 (отчёты «Расхождения подсчёта»
  и «Расход по продажам»), `count_daily` и `group` в карточке ингредиента при складе P1, проверка
  ключевых позиций смены менеджера по `count_daily`, `RECIPE_POLICY_EXPLODE` на `produce` техкарты с
  явным `stock_policy='explode'`;
- кабинет: две вкладки отчётов с CSV в тенге, «Подсчёт на закрытии (N)», поля карточки и техкарты;
- браузерный проход по всем экранам P1 четырьмя ролями на 1440x900 и 390x844
  (`tests/backoffice/p1-pass-browser.test.mjs`, 154 экрана) и три исправления из него;
- runbook со сводкой и дополнения `backoffice-cutover.md`.

Новых флагов, таблиц, прав, команд и изменений 075 нет. При всех выключенных флагах ответы API,
поведение БД и кабинет прежние (тесты `stock-p1-reports.test.mjs` «flag off», `ops-http.test.mjs`,
`backoffice-p1-flags.test.mjs`).

## 1. 075 в окне Cloud-1 (14.11), а не Cloud-2 (меняет CR `bo-ui-1` §4)

CR `bo-ui-1` §4 предлагал ставить 075 в окне Cloud-2 (ночь 17→18.11). Порядок, который просит
владелец (связи шефа, проверка без списания на продажах Т7/Т8, инвентаризация 18.11, включение с
19.11 00:00 или позже с догоном), требует 075 и прав helper-а P1 до 16.11. Предложение:

- §6.2 шаг 2 (14.11 вечер, Cloud-1): 072 → 073 → 074 → **075** одним шагом `provision.mjs`, helper P1
  вызывается последним со всеми ключами `false`; API со всеми флагами P1 `false`; smoke прежних
  разделов кабинета (`GET branches/:id` без новых ключей `capabilities`).
- 075 только добавляет и совместима в обе стороны: прежний рантайм облачной полосы проверен на 075
  (`upgrade from 074 with data`, все наборы полосы cloud на полной схеме, шаг 1), новый - на 074 без
  075 (`p1-grants.test.mjs`).
- Включение флагов P1 - шаги 3-5 и 7-8 раздела «Порядок 13.11-19.11» runbook, не в окне.

Если 075 останется в Cloud-2: runbook сдвигает связи и проверку без списания на 18.11, проверка
очереди на Т7/Т8 выпадает, режим после 19.11 остаётся «Проверка без списания» не меньше двух дней.

## 2. Маршруты `GET .../ops/<view>` в `scripts/contracts.mjs` (вне путей полосы)

`packages/contracts/openapi.json` не описывает ни виды облачной полосы (`ops/stock`, `ops/sales`), ни
виды bo-ui (`ops/pos-day`, `ops/menu-links`, `ops/consumption`, `ops/manager-shifts`,
`ops/staff-roster`, `ops/discounts`): `scripts/contracts.mjs:1253-1259` перечисляет только
`branches/{branchId}`, `orders/{orderId}` и `commands`. Предложение integration (одно место, потом
`pnpm contracts:generate` и отдельный коммит «chore: regenerate openapi»):

```js
'/v1/admin/backoffice/branches/{branchId}/ops/{view}': {
  get: {
    operationId: 'readBackofficeOperationsView',
    parameters: [
      { name: 'branchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'view', in: 'path', required: true, schema: { type: 'string', enum: [
        'stock', 'sales', 'pos-day', 'menu-links', 'consumption', 'manager-shifts', 'staff-roster', 'discounts',
      ] } },
    ],
    // Каждый вид - за своим флагом: без флага 404 неизвестного вида (NOT_FOUND без причины).
    responses: { 200: { description: 'View snapshot (schema_version 1)', content: { 'application/json': {
      schema: { type: 'object', required: ['schema_version', 'branch_id'], additionalProperties: true } } } } },
  },
},
```

Точные ключи запроса каждого вида - allowlist `apps/backoffice/server.mjs` (и регулярка
`infra/public-staging/gateway.Caddyfile:67`); схемы ответов - `design-bo-ui.md` §5. Полоса bo-ui этот
файл не меняла: он вне её путей, а `contracts:check` с текущим `openapi.json` согласен.

## 3. Заметки к слиянию (шаг 8)

- `tests/backoffice/ops-http.test.mjs` (облачная полоса): прокси теперь пропускает
  `ops/stock?view=variance|consumption`; пример отказа прокси - `view=sales`; добавлена проверка, что
  `view=variance` без склада v2 доходит до API и получает 404 `STOCK_V2_DISABLED`. При конфликте
  брать версию bo-ui.
- `packages/backoffice-core/tests/stock-p1.test.mjs`: `count_daily` теперь принимается `IngredientP1`.
- `packages/backoffice-core/package.json` `test:integration`: добавлен `tests/stock-p1-reports.test.mjs`.
- `apps/backoffice/src/ui-fixes.ts` `labelledCards`: подписи только своих строк таблицы, ячейка с
  вложенной таблицей - на всю ширину карточки (телефон). Действует при `ui.fixes` и для таблиц P1.
- Новая причина `RECIPE_POLICY_EXPLODE` в `BackofficeErrorReasonSchema` (`model.ts`; в `openapi.json`
  её нет, как и прочих причин полосы).
- `tests/backoffice/p1-pass-browser.test.mjs` - около 40 с, нужен `BACKOFFICE_TEST_PYTHON` (Python с
  Playwright), снимки в `.local/backoffice-p1-pass/`.

## 4. Открытые вопросы полосы (сводка, с умолчаниями)

| Где                                 | Вопрос                                                                                | Умолчание сейчас                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `design-bo-ui.md` §8 в.1, `bo-ui-3` | общие исправления аудита без флага                                                    | за `BACKOFFICE_POS_DAY_ENABLED`; F18 (экран входа) не сделан           |
| §8 в.2                              | сторно начальником смены                                                              | нет: управляющий и бухгалтер                                           |
| §8 в.5, `bo-ui-4` §1                | склад P1 под `BACKOFFICE_STOCK_V2_ENABLED`                                            | да                                                                     |
| §8 в.6, `bo-ui-6` §3                | восстановление отозванной учётной записи кассы (функция полосы pos)                   | вручную оператором кассы                                               |
| §8 в.7-9, `bo-ui-6` §4, `bo-ui-7`   | право на чек-лист, изменение включённой скидки, каналы и потолок скидки               | управляющий; в черновик; шесть каналов, 1 000 000 ₸                    |
| §8 в.10, этот CR §1                 | 075 в Cloud-1                                                                         | да                                                                     |
| `bo-ui-2` §2 (pos)                  | пояснение расхождения смены кассы в облако                                            | сумма и «Расхождение», пояснение - комментарием в смене менеджера      |
| `bo-ui-4` §4 (cloud)                | дробная сумма в команде возврата и техкарты даёт 500 вместо 400 (код облачной полосы) | не исправлено полосой bo-ui: меняет поведение при выключенных флагах   |
| `bo-ui-5` §1 (integration)          | служба воркера автосписания в compose или systemd                                     | не установлена; без неё режим «Включено» ничего не списывает           |
| `bo-ui-7` §2 (pos)                  | применение скидок на кассе                                                            | касса скидки не получает и не применяет                                |
| `design-bo-ui.md` §5.4              | строка списания по выходу ТТК (`recipe_output_id`) в окне «Списание»                  | не сделана: списание по сырью построчно или сторно автосписания заказа |
