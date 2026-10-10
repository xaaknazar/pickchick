# Облачный кухонный канал kiosk/mobile

Решение: [ADR-0014](adr/0014-cloud-kitchen-channel.md). Статус: этап S0 (документы);
код, миграции и развёртывание не начаты.

## 1. Текущее состояние (проверено по `origin/codex/shared-development`, 3c399b48)

- Киоск и mobile после оплаты создают `edge.kitchen_admission_requested`
  (`packages/commerce-core/src/repository.ts`); выполнение и номер ведёт edge
  (`packages/edge-fulfillment`, таблица `fulfillment_reservations`, сквозная
  последовательность `fulfillment_display_sequence`).
- Gate оформления: `assertBranchItemsAvailable` в
  `packages/commerce-core/src/availability.ts` - стопы кассы + ожидающие стоп-команды
  BO, затем `AVAILABILITY_STALE`, если `cloud_branch_availability.observed_at` старше
  30 секунд.
- Стопы пишет только edge; BO отправляет команды через protocol 4
  (`db/cloud/migrations/048_cloud_stop_commands.sql`,
  `packages/fulfillment-transport/src/model.ts`).
- Кухня: `apps/kitchen` (prep/assembly/display), LAN gateway
  `infra/windows/kitchen-lan-gateway.mjs`, облачный портал `infra/kitchen-portal`
  проксирует к кассе ([ADR-0011](adr/0011-kitchen-live-link.md)), доступ устройств -
  [ADR-0013](adr/0013-device-access.md).

## 2. Режим точки и владелец заказа

`branch_channel_modes(branch_id, cloud_channels_owner, epoch, changed_by, reason)`.
Переключение - команда BO с аудитом и увеличением `epoch`. При подтверждении оплаты
заказ получает `fulfillment_owner` (`edge`|`cloud`) и `owner_epoch`; оба поля
неизменяемы (trigger). Агрегатор и POS всегда `edge`.

## 3. Номера каналов

- Таблица `channel_number_ranges(branch_id, channel, low, high)` (касса 1-299,
  kiosk 300-599, mobile 600-899) и `channel_number_counters(branch_id, channel,
shift_key, last_number)`.
- `shift_key` облака меняется при получении события открытия смены кассы (через
  transport). Пока касса offline, `shift_key` прежний.
- Выделение: в транзакции оплаты `SELECT ... FOR UPDATE` счётчика, следующий номер по
  кругу в диапазоне, пропуск номеров активных заказов (частичный unique index по
  `(branch_id, channel, shift_key, display_number) WHERE active`). Нет свободного -
  `NOT_READY` + алерт, оплата не открывается.
- Edge 021: номер POS из 1-299 со сбросом по `local_cash_shifts`; ограничение
  `UNIQUE(display_number)` из edge 005 заменяется уникальностью в пределах смены.

## 4. Облачное выполнение

- Cloud 054: `cloud_kitchen_orders` (state, version, owner_epoch, display_number,
  snapshot, routing_version) и `cloud_kitchen_tasks` (station, kind, state, version);
  `cloud_kitchen_commands` (commandId, idempotency key, hash тела, результат);
  события в существующий durable outbox.
- Общий пакет машины состояний (рабочее имя `packages/fulfillment-state`):
  переходы `queued -> in_progress -> done`, `accepted -> in_production -> ready ->
handed_off`, отмена/`confirm_stop`, вычисление `taskPlan`. Edge переводится на него
  без изменения поведения (S1 доказывает равенство тестовыми векторами).
- API `/v1/kitchen/feed?station=...&after=...`, `/v1/kitchen/commands`
  (`expectedVersion`, `Idempotency-Key`), `/v1/kitchen/display`. Повтор с тем же
  ключом и телом возвращает прежний результат; другое тело - `CONFLICT`.
- Опрос ленты обновляет `kitchen_station_presence(device_id, station_id, seen_at)`.

## 5. Gate `KITCHEN_OFFLINE`

Для заказа с владельцем `cloud` перед оплатой: приём включён, часы работы, меню
опубликовано, стопы (раздел 6), и хотя бы одна assembly и одна prep станция имели
`seen_at > now() - 30 s`. Иначе `KITCHEN_OFFLINE`. Проверка свежести кассы
(`AVAILABILITY_STALE`) для этого режима не применяется. Клиенты kiosk
(`apps/kiosk/src/commercial-controller.ts`) и mobile
(`apps/mobile/src/checkout-preflight.ts`) получают новый код и текст.

## 6. Стопы облачных каналов

- Cloud 055: `cloud_channel_stops(branch_id, variant_id, stopped, reason, actor,
version)` и `cloud_stale_stop_overrides(branch_id, variant_id, edge_observed_at,
reason, actor, expires_at)`.
- Продажа в облачном канале разрешена, если позиции нет в облачных стопах и нет в
  последних известных кассовых стопах, кроме записей с действующим override. Override
  действует только для облачных каналов, требует причину, пишет аудит и снимается при
  новом наблюдении кассы.
- Снятие кассового стопа и для кассы (уточнение владельца 2026-10-10): BO создаёт
  override для облачных каналов и одновременно команду UNSTOP в
  `cloud_stop_commands` с `expected_version` последнего известного состояния кассы.
  Вместо истечения через 120 секунд команда остаётся `pending` до переподключения
  кассы; edge (`remote_stop_commands`, edge 019) применяет её только при совпадении
  версии, иначе `conflict`. Конфликт показывается управляющему, override облачных
  каналов при этом сохраняется до нового наблюдения кассы. Причина и аудит
  обязательны для обеих частей.

## 7. Кухонные устройства в облаке

Cloud 056 (после 051): учётные данные устройства для облачной ленты - код подключения
из BO (как в ADR-0013: короткий TTL, хранится hash, поколение, отзыв). Устройство
получает ключ станции; пароль повара не требуется. Каждая команда аудируется с
`device_id` и `station_id`. Отзыв в BO действует немедленно.

## 8. Кухня и табло

- Gateway (`infra/windows/kitchen-lan-gateway.mjs`, Electron `apps/kitchen-desktop`)
  получает второй upstream - облачный `/v1/kitchen/*`, с собственным ключом
  устройства.
- Renderer (`apps/kitchen/src`) объединяет ленты по `orderId`, хранит
  `fulfillmentOwner`, отправляет команду только владельцу, показывает индикатор связи
  каждого потока и ведёт журнал незавершённых команд отдельно по владельцу.
- Табло объединяет номера edge и облака, дубли по `orderId` отбрасываются.

## 9. Зеркало для отчётов

Protocol 5 transport: событие `cloud.channel_order_mirrored` (сумма, способ оплаты,
номер, статус выдачи, ссылка на фискальный документ, если появится). Edge 022:
read-only `cloud_channel_orders` для отчётов/X-Z; кухня и табло её не читают. Edge
протокола 4 продолжает работать; облако шлёт событие только после ACK протокола 5.

## 10. Этапы

| Этап | Содержание                                                                                                                                             | Проверки                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0   | ADR, архитектура, резерв миграций                                                                                                                      | `pnpm check`                                                                                                                                                                                                            |
| S1   | общий пакет машины состояний, перевод edge                                                                                                             | векторы переходов edge = старое поведение, unit + PostgreSQL edge                                                                                                                                                       |
| S2   | cloud 053 номера, edge 021 POS 1-299                                                                                                                   | конкуренция выделения, круг, пропуск активных, 300 активных -> `NOT_READY`, сброс по смене, офлайн кассы                                                                                                                |
| S3   | cloud 054 выполнение + `/v1/kitchen/*`                                                                                                                 | идемпотентность, `expectedVersion`, разрыв до/после commit, outbox                                                                                                                                                      |
| S4   | cloud 055 стопы, gate `KITCHEN_OFFLINE`                                                                                                                | матрица стопов/override/аудит, свежесть станций 30 с                                                                                                                                                                    |
| S5   | режим `cloud_channels_owner`, оплата kiosk/mobile без admission; unstop из BO без TTL 120 с (pending до переподключения, `expected_version`, conflict) | владелец фиксируется при оплате, смена epoch не трогает старые заказы, агрегатор остаётся edge; касса offline > 120 с -> unstop применяется после переподключения; касса изменила стоп -> conflict в BO, без перезаписи |
| S6   | cloud 056 устройства, gateway второй upstream, renderer, табло                                                                                         | отзыв, чужая станция, команда не тому владельцу, офлайн журнал, браузерные проверки                                                                                                                                     |
| S7   | protocol 5, edge 022 зеркало, X-Z; guarded release                                                                                                     | отсутствие двойного показа, отчёты, backup/restore, полная CI                                                                                                                                                           |

Каждый этап - отдельная ветка `codex/cloud-kitchen-<этап>`, claim путей и PR.
Релизы на VPS/кассу - только по runbook, с резервом `@vps`/`@windows/cashier`.

## 11. Риски

- Два владельца в одной кухне: ошибка маршрутизации команды. Защита: владелец в
  каждой карточке, сервер отклоняет чужой `orderId`.
- Пересечение номеров каналов при неверных диапазонах: CHECK диапазона в БД.
- Ложная свежесть кухни (экран открыт, повара нет): 30 секунд - только техническая
  проверка; приём выключает управляющий.
- Фискальная схема не определена (ADR-0014, открытый вопрос 1).
- Изменение ограничений `display_number` на edge - миграция живой кассы, нужна
  проверка восстановления и обратной совместимости binary.
- Нагрузка опроса ленты: ограничить частоту и использовать курсор `after`.

## 12. Пересечения с задачами

| Задача                 | Пересечение                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devices-access`       | `apps/kitchen/*`, `apps/kitchen-desktop`, `infra/kitchen-portal`, `infra/windows/kitchen-lan-gateway.mjs`, cloud 051, edge 020, `@vps/*`, `@windows/cashier` - S6/S7 после её завершения |
| `kiosk-v3-launch`      | `docs/03`, `kiosk-checkout.ts`, migrations 045/046, admission киоска - S5 согласовать                                                                                                    |
| `kaspi-qr-pending`     | `kiosk-kaspi-qr.ts` - точка подтверждения оплаты, где фиксируется владелец                                                                                                               |
| `mobile-live-fixes`    | `services/api/src/customer-checkout-controller.ts` - gate mobile                                                                                                                         |
| `workforce`            | cloud 052 и `services/api/src/index.ts` (регистрация контроллеров)                                                                                                                       |
| `unified-menu-release` | удалённые стопы Windows (`infra/windows/remote-stops-*`, `enable-native-remote-stops.ps1` у `devices-access`) - изменение TTL в S5                                                       |
| `restaurant-report`    | `docs/project-status.md`, `docs/roadmap/project.json`, handoff                                                                                                                           |
| `tiptoppay-backend`    | `customer-checkout-response.ts`, `order-view.ts` - новые коды ответа                                                                                                                     |
