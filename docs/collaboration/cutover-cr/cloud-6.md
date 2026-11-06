# CR cloud-6: коды ошибок edge в `ErrorSchema` и команда владельца для Z смены через восстановление кассы

Полоса: cloud (доработка по решениям lead/integration 06.11). Кому: integration; копия pos, kds,
client. Интерфейсы §5 не меняются. Миграций и новых прав нет. Всё выключено: облачные маршруты
отвечают как раньше, команда владельца ничего не делает, пока её не вызвали.

Коммиты `codex/cutover-cloud`: `14b3dcc1` (`ErrorSchema`), `7d22332d` (`chore: regenerate
openapi`), `5109bcb3` (команда владельца, runbook, тесты), этот CR.

## 1. `ErrorSchema.code`: 13 кодов POS и `HANDOVER_MARKS_REQUIRED` (CR pos-1 §2, CR client-4 §1, CR kds-6)

Что: регион cloud `packages/contracts/src/index.ts`, перечень `ErrorSchema.code` (строки 229-249):
после `'ORDER_IN_PRODUCTION',` - `METHOD_DISABLED`, `TENDER_SUM_MISMATCH`,
`CASH_TENDERED_TOO_LOW`, `TERMINAL_AMOUNT_NOT_WHOLE`, `CHANNEL_PRICE_UNAVAILABLE`,
`EXTERNAL_REF_REQUIRED`, `EXTERNAL_REF_DUPLICATE`, `APPROVAL_REQUIRED`, `APPROVAL_INVALID`,
`REFUND_LIMIT`, `REFUND_NOT_SUPPORTED`, `DRAWER_INSUFFICIENT`, `FISCAL_PENDING`; после
`'SHIFT_CLOSED',` - `HANDOVER_MARKS_REQUIRED`. `openapi.json` перегенерирован отдельным коммитом.

- Источник перечня - `PosErrorCodeSchema` (`packages/contracts/src/pos-sales.ts` этой ветки):
  файл побайтно равен файлу `codex/cutover-pos` `b25674d5`, 15 кодов, у ветки pos кодов не
  больше; `SERVICE_MODE_DISABLED` и `ORDER_IN_PRODUCTION` были в D0.
- KDS: CR kds-6 просит один код. Остальные коды контроллеров kds на `d7affabc`
  (`services/edge/src/fulfillment-controller.ts`, `kds-controller.ts`) - `INVALID_REQUEST`,
  `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `SERVICE_UNAVAILABLE` - в перечне уже есть.

Как фильтр выбирает код (`packages/platform/src/http.ts`): `defaultCode` по статусу (строка 50:
400 - `INVALID_REQUEST`, 409 - `CONFLICT`, ...), `ErrorSchema.shape.code.safeParse(details.code)`
(строка 71), `proposed = declared.success ? declared.data : defaultCode` (строка 83); исключения
только для `KITCHEN_OFFLINE` (профиль v2) и `RESTAURANT_CLOSED`/`AVAILABILITY_STALE` (профиль v1).
Контроллеры pos (`pos-sales-controller.ts` `run()`, `orders-controller.ts`) бросают
`HttpException({code: error.code}, orderErrorStatus[error.code])`, где все 13 кодов - 409
(`packages/local-orders/src/errors.ts:35-62` на `b25674d5`); kds -
`fail(400, 'HANDOVER_MARKS_REQUIRED')` (`fulfillment-controller.ts:219-220` на `d7affabc`). После
слияния фильтр пропускает эти коды как есть; статусы те же.

Облачные маршруты: из новых кодов облако само порождает только `CommerceError('REFUND_LIMIT')`
(`packages/commerce-core/src/repository.ts:1469,1587`, `combo-reward-ledger.ts:426`). Бэк-офис уже
переводит его в `CONFLICT` (`packages/backoffice-core/src/index.ts:913-928`); контроллеры
checkout приложения и киоска теперь переводят его в `CONFLICT` сами
(`services/api/src/customer-checkout-controller.ts:188-192`, `kiosk-checkout-controller.ts:92-97`),
поэтому установленные бандлы приложения и киоска (строгий свой перечень) нового кода не увидят.
`LoyaltyError('REFUND_LIMIT')` до HTTP не доходит (потребителей нет).

Тест: `packages/pos-order-sync/tests/sales-cloud-error-codes.test.mjs` - `ErrorSchema` содержит
каждый код `PosErrorCodeSchema` и `HANDOVER_MARKS_REQUIRED`, коды D0 на месте, других новых нет;
настоящий фильтр (`createHttpApplication`, служба `edge`) отдаёт каждый код POS с 409 и
`HANDOVER_MARKS_REQUIRED` с 400, неизвестный код - по-прежнему `CONFLICT`/`INVALID_REQUEST`;
checkout приложения и киоска отвечает `CONFLICT` на `REFUND_LIMIT` при любом профиле.

Тесты других полос, которые после слияния становятся строгими (правок не нужно):

| Полоса | Тест                                                                                                                                                                                                                                         | Что меняется                                                                                |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| pos    | `tests/integration/pos-sales.test.mjs` «HTTP: pos/config, approvals with the staff/pin backoff, sales, replay and error codes» (`wire()`, строка 1605) и «HTTP: void, refunds, Webkassa receipts, X and Z and the sales close» (строка 3168) | `wire(expected)` возвращает точный код вместо `CONFLICT`                                    |
| kds    | `tests/integration/kds-http.test.mjs` `MARKS_CODE` (строка 72) в «KDS HTTP: layout on - ...» (строка 331) и «KDS-4 managed screens: ...» (строка 483)                                                                                        | ждёт `HANDOVER_MARKS_REQUIRED` вместо `INVALID_REQUEST`                                     |
| kds    | `tests/integration/kds-http-compat.test.mjs:120`                                                                                                                                                                                             | без изменений: отметки при выключенной раскладке - простой `INVALID`, 400 `INVALID_REQUEST` |
| client | `tests/pos/cashier-ui.test.mjs` «an edge that answers only a bare CONFLICT for the POS codes ...»                                                                                                                                            | без изменений: тест моделирует старый edge, путь остаётся верным                            |

Для integration: CR client-4 §5 п. 2 (409 `EXTERNAL_REF_DUPLICATE` и `REFUND_LIMIT` через
настоящий edge в `cutover-cross-lane`) теперь можно делать строгим. Конфликт `openapi.json` при
слиянии - взять любую сторону и `pnpm contracts:generate` (§4.2).

## 2. Z смены, открытой во время восстановления кассы (CR cloud-5 п. 2, вариант A)

Функция: `acceptRestoredShiftReport(pool, input)` и класс отказа `RestoredShiftReportError`
(`code` из `PosSyncError`, `reason` - фиксированный токен) в
`packages/pos-order-sync/src/sales-cloud.ts`, экспорт из пакета. `input`: `branchId`, `deviceId`
(edge точки), `actorId` (личный логин с грантом `manager` на точку), `requestId` (uuid), `reason`
(3..300 символов), `payloadHash` (из строки `pos_sale_outbox`), `event` (припаркованное событие
ровно в том виде, в каком его отправляет касса).

Точка входа: `scripts/backoffice-setup.mjs --accept-restored-z --branch --device --actor
--request --event <файл> --reason` с URL **владельца** базы облака (как `--designation`).
HTTP-маршрута нет, кабинет команду не вызывает. Ответ - одна строка JSON
`pos_sales_restored_z`; отказ - `pos_sales_restored_z_refused` (`code`, `reason`), код выхода 1.
Процедура с выгрузкой события на кассе (SQL для `psql`) - `docs/operations/backoffice-cutover.md`,
«Принять Z смены, открытой во время восстановления».

Что проверяет (по порядку): разбор запроса (`request`); событие разбирается как у приёмника и
совпадает с `payload_hash`, точка события - `branchId` (`model`); вид `shift_report`
(`not_shift_report`: отмены и возвраты так не принимаются); 073 установлена (`schema`);
вызывающий - владелец `cloud_pos_shift_reports` (`not_owner`); `actorId` - не отозванный логин
с грантом `manager` на точку (`actor`); ключ `requestId` + digest (`request_reused`); активная
привязка POS-синхронизации устройства этой точки, под той же блокировкой строки, что у
приёмника (`binding`); id события и пара (устройство, номер) свободны или это уже принятый тот
же Z (`identity`, иначе `duplicate`); у смены нет Z (`shift_identity`); облако не приняло событий
устройства после этого Z (`not_head`); приёмник отказал бы этому Z сейчас по `shift_cash` или
`shift_methods` (`not_parked`); по наличным и каждому способу в Z не больше, чем в облаке, и у
смены есть продажа не меньше чем на половину сдвига fence (5·10^8) ниже номера Z (`not_restore`).

Что пишет одной транзакцией: строку `cloud_pos_shift_reports` ровно из Z кассы, строку
`cloud_pos_sale_inbox` этого события (следующая попытка кассы - повтор), `bo_audit`
(`pos_sales:accept_restored_z`, причина, `before_value` - устройство, событие, номер;
`after_value` - ответ с разницей по способам) и `bo_commands` (актор, `requestId`, digest,
ответ). Тот же запрос - тот же ответ без записи; Z, уже принятый, - `state: duplicate` без
записи; отказ ничего не пишет. Без вызова поведение облака и кассы прежнее; приёмник по-прежнему
отказывает такому Z.

Права: новых нет. Роль API с правами приёмника и бэк-офиса (может писать все эти таблицы)
получает `not_owner` - проверено настоящим LOGIN.

Тесты:

- `packages/pos-order-sync/tests/sales-cloud-restored-z.test.mjs` - приёмник паркует Z
  (`shift_cash`); отказы `request`, `model`, `not_shift_report`, `not_owner` (роль API с правами
  приёмника и бэк-офиса), `actor` (аналитик, неизвестный, отозванный управляющий), `binding`
  (привязка выключена, чужое устройство), `not_parked` (Z сходится с облаком), `not_restore` (в Z
  больше, чем в облаке; смена без сдвига fence), после принятия `identity`, `shift_identity`,
  `not_head`, `request_reused`; ни один отказ ничего не пишет; принятие сохраняет Z как есть,
  inbox, аудит и команду; повтор и `duplicate` ничего не пишут; затем Z от кассы - повтор, и
  следующая продажа принимается.
- `packages/pos-order-sync/tests/sales-worker-integration.test.mjs` «restored edge database with
  the posSales fence (CR cloud-5): new events pass the lost timeline; a Z of a shift open across
  the restore is parked until the cloud owner accepts it as written» - касса с fence, потерянный
  отрезок, Z паркуется, простое освобождение снова паркует; выгрузка SQL из runbook (дословно),
  `scripts/backoffice-setup.mjs --accept-restored-z` с URL владельца, повтор команды, пустой файл
  - отказ `model`; после освобождения на кассе Z уходит повтором и следующая продажа доставлена.

Для integration:

1. `docs/operations/edge-restore.md` (мастер-runbook восстановления): после шага с `restore`
   добавить ссылку - если после восстановления поток `posSales` стоит на
   `PARKED INVALID_EVENT` для Z (`shift_report`), выполнить
   `docs/operations/backoffice-cutover.md`, «Принять Z смены, открытой во время
   восстановления»; отмены и возвраты потерянного отрезка - не этой командой.
2. Шаг 4 процедуры (освободить событие на кассе) - `retryPosSalesDelivery` с правами владельца
   базы кассы; команда оператора `pos-sales-setup.mjs sync-release` (CR cloud-2 §6) на
   `b25674d5` ещё не сделана - это за полосой pos.
