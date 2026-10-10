# Облачный кухонный канал: этап S3 (стопы и gate KITCHEN_OFFLINE)

Решение: [ADR-0014](adr/0014-cloud-kitchen-channel.md), архитектура:
[cloud-kitchen-channel.md](cloud-kitchen-channel.md), предыдущий этап: [S2](cloud-kitchen-s2.md).
Этап S3 соответствует строке S4 плана в cloud-kitchen-channel.md (стопы, gate) и части S5 (unstop
из BO без TTL 120 с). В production ничего не включено: все точки в режиме `edge`, флаг
`BACKOFFICE_CLOUD_STOPS_ENABLED` по умолчанию `false`, гранты не подключены в provisioning,
HTTP-маршруты не зарегистрированы.

## Что сделано

- Cloud 055 (`db/cloud/migrations/055_cloud_channel_stops.sql`), только добавления:
  - `cloud_channel_stops` - стоп облачных каналов по товару/опции (тот же hashed `variant_id`,
    что в меню кассы), `duration` `manual`|`hour` (без `shift`), `version` растёт строго на 1,
    `updated_at`/`expires_at` ставит сервер, удаление и смена идентичности запрещены.
  - `cloud_channel_stop_events` - неизменяемый журнал каждой версии (пишет trigger, обойти
    нельзя); причина обязательна (3-300 символов).
  - `cloud_stale_stop_overrides` - снятие последнего известного кассового стопа только для
    облачных каналов. Trigger допускает запись только против текущего наблюдения кассы, если
    оно старше 30 секунд, позиция в `stopped_ids` и версия в `stop_states` равна
    `edge_version`. Запись неизменяема. Override действует, пока нет нового наблюдения кассы
    (`edge_observed_at >= observed_at` того же устройства).
  - `cloud_stop_commands.delivery_policy` (`ttl` по умолчанию | `until_reconnect`); durable
    допускается только для UNSTOP `manual`. Новый trigger запрещает менять policy и переводить
    в `expired` durable-команду, которую касса ещё не получила. CHECK 048 про 120 секунд не
    изменён: `expires_at` остаётся, но для durable не применяется.
- `packages/fulfillment-transport/src/cloud.ts`: истечение и фильтр доставки пропускают durable
  команды (через `to_jsonb`, работает и на схеме до 055). Доставленная, но не отвеченная
  durable-команда повторно доставляется каждые 5 секунд и не истекает в облаке.
- Edge не менялся. Проверено: edge 019 (`packages/local-orders/src/remote-stops.ts`) считает
  60 секунд от `received_at` на самой кассе, а не от `issuedAt`, поэтому команда, выданная
  час назад и доставленная при переподключении, применяется с проверкой `expected_version`;
  расхождение даёт `conflict` с `result_version`. Протокол 4 не менялся.
- `packages/backoffice-core/src/cloud-stops.ts` (экспорт через `stops.ts`, так как `index.ts`
  и `package.json` заняты):
  - `setCloudStopInTransaction` - stop/unstop с `expected_version` (0 - ещё не было), конфликт
    версий `CONFLICT`/`VERSION_MISMATCH`, идемпотентность по `request_id` (`bo_commands`),
    аудит `bo_audit` `cloud_stop:stop|unstop` с before/after;
  - `overrideCashierStopInTransaction` - только при устаревшей кассе (`CASHIER_ONLINE`),
    стоп должен быть в последних данных (`CASHIER_STOP_NOT_FOUND`) той же версии
    (`CASHIER_VERSION_MISMATCH`), один активный override (`OVERRIDE_ACTIVE`); с
    `include_cashier: true` дополнительно создаётся durable UNSTOP для кассы (нужен и
    `BACKOFFICE_REMOTE_STOPS_ENABLED`), правило одной открытой команды на позицию сохраняется;
    аудит `cloud_stop:override_cashier` и `remote_stop:unstop`;
  - `readCloudStops` - режим точки, онлайн кухни, наблюдение кассы, по каждой позиции облачный
    стоп и следующая версия, кассовый стоп и версия, активный override, команда кассе
    (`pending.awaits_reconnect`, `last_result` включая `conflict`) и итог
    `cloud_sales_blocked`, вычисленный тем же кодом, что gate продаж;
  - `CloudChannelStops` - сервис с той же проверкой токена/роли, что `Backoffice`, для
    регистрации маршрутов без изменения общего класса; ошибки - `CloudStopError`
    (`BackofficeError` с полем `detail`, общий enum причин в `model.ts` занят).
  - Стоп-лист v2 (`readStopList`): durable команда не показывается истёкшей, у неё
    `expires_at: null` и `awaits_reconnect: true`; TTL-команды без изменений.
- `packages/commerce-core/src/availability.ts`: `branchAvailability`/`assertBranchItemsAvailable`
  читают режим `branch_channel_modes`. Режим `edge` (нет строки, нет таблицы или нет права) -
  прежний код и прежний результат. Режим `cloud`: продажа запрещена, если позиция в облачных
  стопах, в последних известных кассовых стопах без действующего override или в ожидающей
  STOP-команде BO; gate `KITCHEN_OFFLINE`, если за 30 секунд не опрашивали ленту хотя бы одна
  станция `assembly` и одна `prep` (`cloud_kitchen_station_presence`, 054). Свежесть кассы в
  этом режиме не проверяется. Нет права читать входы облачного gate - gate закрыт.
  Часы работы, включённый приём и опубликованное меню проверяют вызывающие (без изменений).
- `infra/staging/cloud-channel-stop-grants.mjs`: роль BO (SELECT/INSERT, UPDATE только колонок
  намерения, без DELETE) и роль продаж (только SELECT). В provisioning не подключено.
- Mobile: `apps/mobile/src/checkout-preflight.ts` повторяет `KITCHEN_OFFLINE` как
  `AVAILABILITY_STALE`; текст ошибки не нужен (неизвестный код уже тихий).

## Тесты

- `tests/integration/cloud-channel-stops.test.mjs` (PostgreSQL, изолированные схемы): версии,
  аудит, идемпотентность, конкурентные stop/unstop (ровно один выигрывает), неизменяемость;
  режим `edge` без изменений; gate `KITCHEN_OFFLINE` (prep без assembly, опрос старше 30 с),
  устаревшая касса при работающей кухне - продажа разрешена, оба источника стопов блокируют;
  override (касса online, чужая версия, аудит, только для облачных каналов, снимается новым
  наблюдением, DB guard); durable unstop (час offline - pending, доставка при переподключении,
  повторная доставка, conflict виден в read model); production-shaped роли BO и продаж;
  e2e с ролью Windows worker и edge 019: применение через час и conflict.
- `tests/unit/cloud-channel-stop-grants.test.mjs`, `tests/mobile/checkout-preflight.test.mjs`.

## Не сделано и заблокировано

- Код ошибки `KITCHEN_OFFLINE` в `packages/contracts/src/index.ts` (занят `devices-access`).
- `services/api/src/customer-checkout-controller.ts` (занят `mobile-live-fixes`): для клиентов
  без `profile=pickchick.checkout-errors-v1` отображать `KITCHEN_OFFLINE` как
  `SERVICE_UNAVAILABLE`, как сейчас `AVAILABILITY_STALE`.
- Киоск `apps/kiosk` (занят `kiosk-build12`): код `KITCHEN_OFFLINE` и текст.
- Маршруты BO в `services/api/src/index.ts` (занят `workforce`) и UI `apps/backoffice`
  (`operations.ts` занят `devices-access`).
- Подключение `cloud-channel-stop-grants.mjs` в `infra/staging/provision.mjs` (занят
  `workforce`), релиз на VPS не выполнялся.
- Смешанный деплой: если 055 применена, а API ещё старый, старый код истечения не встретит
  durable-команд (их создаёт только новый код). Старый код при наличии durable-команды получил
  бы ошибку trigger в pull; выпускать миграцию и API вместе.
- Ручная отмена durable-команды управляющим (если касса не вернётся) - кандидат S5.
