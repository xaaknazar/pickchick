# Киоск с оплатой на своём терминале Kaspi Smart POS (облако)

Решение: [ADR-0018](../architecture/adr/0018-kiosk-kaspi-terminal.md). Этот документ - облачная
часть: миграция cloud080, права, флаг, маршруты API. Приложение киоска и кухня делаются
отдельно.

## Что делает

- iPad сам ведёт свой терминал Kaspi Smart POS по локальной сети. Облако к терминалу не ходит и
  токенов терминала не получает.
- Облако хранит, какой терминал привязан к какому киоску: один активный терминал на киоск и один
  активный киоск на терминал (`kiosk_terminal_links`, строки не удаляются, снятие ставит
  `unlinked_at`).
- Оплата: iPad просит попытку (`POST orders/:id/payment`, `method: 'kaspi_terminal'`), облако
  создаёт попытку провайдера `kaspi-pos` на точную сумму заказа в целых тенге. iPad проводит
  оплату на терминале и сообщает `started` и `result` (`POST orders/:id/terminal-events`), запросы
  заверены ключом киоска.
- Деньги засчитываются только при `status=success` с `transaction_id`, суммой, равной сумме
  попытки, и тем же `terminal_id`, что был привязан при создании попытки (и тем же `process_id`,
  если iPad сообщил `started`). Тогда заказ идёт на кухню тем же путём, что и оплаченный Kaspi
  QR: та же запись оплаты (`observePayment`) и та же команда кухне.
- `fail` закрывает попытку, можно начать новую с новым `request_id`.
- `unknown`, успех с неверной суммой или терминалом, а также попытка без результата дольше
  15 минут переводятся в «требует сверки»: попытка `unknown`, запись в
  `commerce_reconciliation_issues` (`KIOSK_TERMINAL_RESULT_UNKNOWN`,
  `KIOSK_TERMINAL_RESULT_MISMATCH`, `KIOSK_TERMINAL_RESULT_OVERDUE`), заказ помечается для
  проверки управляющим и на кухню не идёт. Поздний точный результат после 15 минут деньги
  записывает, но заказ остаётся у управляющего.
- Попытки старше 15 минут проверяются при каждом обращении киоска этой точки (конфигурация,
  оплата, чтение заказа). Отдельный процесс не нужен.
- Журнал событий терминала `commerce_kiosk_terminal_events` - только добавление; повтор того же
  события (`attempt_id`, `kind`, `process_id`) с теми же данными даёт тот же ответ, с другими - 409. На попытку принимается один `started` и один `result`.

## Маршруты (заголовки киоска `x-kiosk-device`, `x-kiosk-key`; все ответы `no-store`)

| Маршрут                               | Вход                                                                                                                            | Ответ                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /v1/kiosk-checkout/config`       | гость                                                                                                                           | прежний ответ + `kaspi_terminal: { enabled, terminal }` |
| `PUT /v1/kiosk-checkout/terminal`     | только ключ устройства; `{ terminal_id, serial, host }`, host - частный IPv4                                                    | `{ terminal_id, serial, host, linked_at }`              |
| `DELETE /v1/kiosk-checkout/terminal`  | только ключ устройства                                                                                                          | `{ unlinked: true }`                                    |
| `POST .../orders/:id/payment`         | гость; `{ method: 'kaspi_terminal', request_id }`                                                                               | `{ attempt_id, amount_tenge, terminal_id, expires_at }` |
| `POST .../orders/:id/terminal-events` | гость; `{ attempt_id, kind, process_id, terminal_id, status?, sub_status?, transaction_id?, method?, amount_tenge?, message? }` | заказ как в `GET orders/:id`                            |

- Ошибки 409: `KIOSK_TERMINAL_TAKEN`, `KIOSK_TERMINAL_NOT_LINKED`, `KIOSK_TERMINAL_DISABLED`,
  `KIOSK_TERMINAL_WHOLE_TENGE`, `CONFLICT`. Неверное тело - 400.
- `GET orders/:id` у заказа с терминалом: `paymentMethod: 'kaspi_terminal'`,
  `payment: { kind: 'kaspi_terminal', state: 'pending' | 'checking' | 'paid' | 'failed',
attempt_id, amount_tenge, terminal_id, expires_at }`. `phase`: открытая попытка -
  `awaiting_payment`, `fail` - `failed`, сверка - `checking`, после оплаты - обычные фазы кухни.
- Пока у заказа открыта или оплачена попытка, любой `POST payment` возвращает её, вторую не
  создаёт. Заголовок `Idempotency-Key` не нужен.
- `kaspi_terminal` не добавляется в `paymentMethods`: установленные сборки киоска проверяют этот
  список строго.

## Настройки API

| Переменная                        | Значение                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `KIOSK_KASPI_TERMINAL_ENABLED`    | `true` включает; пусто или `false` - выключено; любое другое значение останавливает запуск API |
| `KIOSK_KASPI_TERMINAL_ACCOUNT_ID` | id учётной записи `commerce_provider_accounts` точки: `kind='payment'`, `provider='kaspi-pos'` |

Учётная запись `kaspi-pos` отдельная: она не может совпадать с `KIOSK_KASPI_QR_ACCOUNT_ID` или
`KASPI_REMOTE_ACCOUNT_ID`. Нужны также прежние настройки киоска (`KIOSK_CHECKOUT_ENABLED`, точка,
ключи). Секретов эта функция не добавляет.

## Установка (исполнитель: Codex)

1. Резервная копия облачной базы.
2. Миграция cloud `080_cloud_kiosk_kaspi_terminal.sql`: три новые таблицы и обновлённая проверка
   попытки оплаты (разрешает `kaspi-pos` для киоска так же, как `kaspi-qr`). Данные не меняются.
3. Учётная запись провайдера точки (владельцем базы), например:
   `INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id)
VALUES(<новый uuid>,<организация>,<точка>,'payment','kaspi-pos','kiosk-terminal-<точка>',true,<юрлицо точки>)`.
4. Права роли API: `kioskTerminalGrants(<api role>, true)` из
   `infra/staging/kiosk-terminal-grants.mjs`, после прав оформления заказа и киоска
   (`customerCheckoutGrants`, `kioskCheckoutGrants`). Если позже повторно применяются те, этот
   шаг повторить. На базе без 080 скрипт ничего не делает.
5. В env API: `KIOSK_KASPI_TERMINAL_ENABLED=true`, `KIOSK_KASPI_TERMINAL_ACCOUNT_ID=<id из п. 3>`.
6. Выпуск API с этим коммитом.
7. Шлюз: установленный шлюз перечисляет пути киоска поимённо, новые маршруты без него
   недоступны. Вставить блок `infra/domains/kiosk-terminal.Caddyfile` перед `@backoffice_get`
   тем же порядком, что `infra/public-staging/kiosk-staff-gateway.py` (сверка, резервная копия,
   пересоздание только шлюза). Отдельного скрипта установки для этого блока пока нет.
8. Проверка: `GET config` киоска показывает `kaspi_terminal.enabled: true`; после настройки
   терминала в служебном меню киоска - `terminal` с его `terminal_id`. Контрольная оплата на
   терминале: заказ появляется на кухне, в `commerce_captures` строка с `transaction_id` Kaspi.

## Откат

1. `KIOSK_KASPI_TERMINAL_ENABLED=false` (или убрать) и перезапуск API: маршруты терминала
   отвечают `KIOSK_TERMINAL_DISABLED`, киоск показывает прежнюю оплату Kaspi QR.
2. `kioskTerminalGrants(<api role>, false)`: снимает все права на таблицы 080. Права записи
   результата оплаты на общих таблицах (`commerce_captures`, `commerce_provider_inbox` и др.)
   этот шаг не снимает: та же роль может держать их для QR.
3. Миграцию не откатывать: таблицы 080 остаются как журнал. Открытые попытки после отката
   разбираются как обычные инциденты сверки.

## Компоненты

| Где                                                      | Что                                                  |
| -------------------------------------------------------- | ---------------------------------------------------- |
| `db/cloud/migrations/080_cloud_kiosk_kaspi_terminal.sql` | привязки, попытки, журнал событий, проверка попытки  |
| `packages/commerce-core/src/kiosk-terminal.ts`           | привязка, попытка, приём итога, просрочка            |
| `packages/commerce-core/src/kiosk-checkout.ts`           | `config`, `payment`, `terminal-events`, `orders/:id` |
| `services/api/src/kiosk-checkout-controller.ts`          | маршруты                                             |
| `infra/staging/kiosk-terminal-grants.mjs`                | права роли API                                       |
| `infra/domains/kiosk-terminal.Caddyfile`                 | блок шлюза для трёх новых маршрутов                  |
| `tests/integration/kiosk-terminal.test.mjs`              | PostgreSQL, ограниченная роль, HTTP                  |

## Что не сделано

- Принятие инцидента управляющим в кабинете («Инциденты оплаты киоска», миграция 050) пока
  только для Kaspi QR: инцидент терминала виден как проверка заказа
  (`commerce_reconciliation_issues`), а не в списке передачи киоска.
- Сторожевой процесс (watchdog) не считает просроченные попытки терминала.
- Возвраты через терминал не делаются: возврат вручную на терминале.
- Скрипт установки блока шлюза (п. 7) не написан: блок вставляется вручную по образцу.
