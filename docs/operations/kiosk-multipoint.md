# Киоски на нескольких точках (облако и бэк-офис)

Решение: [ADR-0019](../architecture/adr/0019-kiosk-per-point.md). Инструкция для владельца и
управляющего: [kiosk-new-point.md](kiosk-new-point.md). Этот документ - установка для оператора:
миграция cloud081, права, флаг.

## Что делает

- Управляющий в «Устройства» включает «Киоски на этой точке» для любой точки организации.
  После этого «Подключить киоск» работает на этой точке, а API киоска обслуживает её киоски.
- Точка из env (`KIOSK_CHECKOUT_BRANCH_ID`) работает как раньше, вместе с Kaspi QR и счётом на
  телефон. Её в «Устройства» не выключают.
- Другие точки платят только на своём терминале Kaspi Smart POS у киоска (ADR-0018). При первом
  включении точка получает свою учётную запись `kaspi-pos` (`external_reference`
  `kiosk-terminal:<id точки>`, юрлицо точки). Оплата засчитывается на неё, заказ идёт на кухню
  своей точки тем же путём, что и на точке из env.
- Выключение: новые заказы с киосков точки не принимаются (`NOT_READY`), выдать новые ID/ключ
  нельзя. Оплаченные заказы остаются на кухне, привязанные iPad не сбрасываются: после повторного
  включения работают с той же учётной записью.
- Каждое включение и выключение - запись в `bo_audit` (`kiosk_branch_settings`, причина, до и
  после) и `bo_commands` (повтор того же запроса даёт тот же ответ). Устаревший экран (чужое
  изменение между чтением и записью) получает `KIOSK_BRANCH_VERSION`.

## Маршруты

| Маршрут                                                           | Вход                                                             | Ответ                                             |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| `GET /v1/admin/backoffice/branches/:branch/devices`               | как раньше                                                       | с флагом добавлено `kiosk_branch`                 |
| `POST /v1/admin/backoffice/branches/:branch/devices/kiosk-branch` | управляющий; `{ request_id, enabled, expected_version, reason }` | `{ primary, enabled, version, payment_account }`  |
| `GET /v1/kiosk-checkout/config` (киоск другой точки)              | гость                                                            | `paymentMethods: []`, `kaspi_terminal.only: true` |

Ошибки записи: 409 `KIOSK_BRANCH_PRIMARY` (точка из env), `KIOSK_BRANCH_VERSION`,
`KIOSK_BRANCH_NOT_SERVED` (другая организация); 503 `KIOSK_MULTI_BRANCH_DISABLED`
(флаг выключен или нет прав 081); 403 не управляющий.

## Настройки API

| Переменная                        | Значение                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `KIOSK_MULTI_BRANCH_ENABLED`      | `true` включает; пусто или `false` - как раньше (одна точка); другое значение останавливает API |
| `KIOSK_KASPI_TERMINAL_ENABLED`    | должен быть `true`: другие точки платят только на терминале                                     |
| `KIOSK_KASPI_TERMINAL_ACCOUNT_ID` | без изменений; учётная запись терминала точки из env                                            |

Нужны также прежние настройки киоска и «Подключить киоск» (`KIOSK_CHECKOUT_ENABLED`,
`KIOSK_ENROLLMENT_KEY`, `BACKOFFICE_KIOSK_PAIRING_ENABLED`, `BACKOFFICE_ENABLED`). Фискальная
политика должна быть `deferred_pilot`: при `required` другие точки остаются выключенными.
Секретов функция не добавляет.

## Установка (исполнитель: Codex)

1. Резервная копия облачной базы.
2. Миграция cloud `081_cloud_kiosk_branch_settings.sql`: таблица `kiosk_branch_settings` и
   функция `kiosk_branch_terminal_account` (SECURITY DEFINER, владелец - владелец миграций).
   Данные не меняются.
3. Права роли API: `kioskBranchSettingsGrants(<api role>, { multiBranch: true, backoffice: true })`
   из `infra/staging/kiosk-branch-settings-grants.mjs`, после `kioskTerminalGrants`. Даёт SELECT,
   INSERT/UPDATE колонок настроек и EXECUTE функции; INSERT на `commerce_provider_accounts` не
   даёт. Журнал (`bo_audit`, `bo_commands`) пишется прежними правами бэк-офиса. На базе без 081
   скрипт ничего не делает.
4. В env API: `KIOSK_MULTI_BRANCH_ENABLED=true`.
5. Выпуск API и веба бэк-офиса с этим коммитом. Шлюз менять не нужно: новых маршрутов киоска нет,
   портал бэк-офиса ходит в API напрямую.
6. Приложение киоска: нужна сборка с этим изменением (сообщение «оплата только на терминале»).
   Установленные сборки на другой точке оплату не начинают.
7. Проверка: в «Устройства» другой точки виден блок «Киоски на этой точке»; включение показывает
   учётную запись `kiosk-terminal:<id точки>`; затем «Подключить киоск», настройка терминала на
   iPad, контрольный заказ появляется на кухне этой точки.

## Откат

1. `KIOSK_MULTI_BRANCH_ENABLED=false` и перезапуск API: работает только точка из env, ответы как
   до изменения. Киоски других точек получают `FORBIDDEN` и не принимают заказы.
2. `kioskBranchSettingsGrants(<api role>, { multiBranch: false, backoffice: true })` снимает права
   на таблицу и функцию.
3. Миграцию не откатывать: строки настроек и созданные учётные записи `kaspi-pos` остаются как
   история; оплаченные заказы на них ссылаются.

## Компоненты

| Где                                                       | Что                                                    |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `db/cloud/migrations/081_cloud_kiosk_branch_settings.sql` | настройки точки, проверка, функция учётной записи      |
| `packages/commerce-core/src/kiosk-branches.ts`            | флаг, чтение настройки точки                           |
| `packages/commerce-core/src/kiosk-checkout.ts`            | допуск гостя, `config` и оплата другой точки           |
| `packages/commerce-core/src/kiosk-enrollment.ts`          | обмен ID/ключа iPad на включённой точке                |
| `packages/backoffice-core/src/kiosk-branch-settings.ts`   | состояние, переключатель, аудит                        |
| `packages/backoffice-core/src/kiosk-pairing.ts`           | «Подключить киоск» на включённых точках                |
| `services/api/src/device-registry-controller.ts`          | `POST .../devices/kiosk-branch`, флаг                  |
| `apps/backoffice/src/components/DeviceAccessView.ts`      | блок «Киоски на этой точке»                            |
| `apps/kiosk/src/commercial-controller.ts`                 | `kaspi_terminal.only`, сообщение «позовите сотрудника» |
| `infra/staging/kiosk-branch-settings-grants.mjs`          | права роли API                                         |
| `tests/integration/kiosk-multipoint.test.mjs`             | PostgreSQL, ограниченная роль, путь до кухни точки     |

## Что не сделано

- Kaspi QR и счёт на телефон на других точках (мост и воркер обслуживают одну учётную запись).
- Выбор или смена учётной записи оплаты точки в бэк-офисе (только оператором в базе).
- Фискальная политика `required` для других точек.
