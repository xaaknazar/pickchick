# «Подключить киоск»: привязка iPad к точке из бэк-офиса

Запрос владельца 16.11.2026: привязывать iPad-киоск к точке самому, без офлайн-скриптов на
облачном сервере. Новая сборка iPad не нужна: iPad вводит выданные данные в прежнюю форму
«Настройка киоска» (`/v1/kiosk-checkout/enrollment/exchange` не менялся).

## Как заказ киоска попадает на кухню точки

1. **iPad → точка (облако).** Строка `kiosk_devices` (организация, точка) и ключ устройства в
   SecureStore iPad. API киоска обслуживает одну точку: `KIOSK_CHECKOUT_BRANCH_ID`.
2. **Точка → сервер точки → кухня.** Оплаченный заказ идёт по `fulfillment_transport_bindings`
   на сервер точки (FulfillmentWorker), тот ставит его на станции кухни. Проверено 16.11.2026:
   облако шлёт заказы точки на устройство `2fd08ecf-5e62-4e58-8439-e2353b79ef9b`, это
   `EDGE_DEVICE_ID` службы Fulfillment на кассовом моноблоке 192.168.2.66.

Кухня получает заказ киоска только после подтверждённой оплаты Kaspi QR.

## Как работает кнопка

- Бэк-офис, «Устройства», кнопка «Подключить киоск» (только управляющий, только когда
  `kiosk_pairing_enabled` в ответе списка). Управляющий вводит название и причину.
- Сервер создаёт `kiosk_devices` (новый случайный ключ) и alias `kiosk_enrollment_aliases` так
  же, как `scripts/provision-kiosk.mjs` + `provision-kiosk-enrollment.mjs`: scrypt-проверка
  пароля и AES-GCM шифр ключа на `KIOSK_ENROLLMENT_KEY`. Ответ один раз содержит
  «ID устройства» (`ipad-xxxxxx`) и «Ключ устройства» (16 строчных букв и цифр без похожих
  символов). Срок 30 минут. Пароль и ключ не хранятся и в журналы не пишутся.
- Журнал выдачи - `kiosk_pairing_issues` (только добавление; кто, когда, название, причина).
- Список показывает такой киоск «Ждём ввода на iPad»; после ввода на iPad - как обычный киоск
  с его названием. Невведённые и истёкшие данные из списка пропадают.
- Ограничения: 5 выдач на управляющего за 10 минут, не больше 5 невведённых данных на точку,
  повтор того же `request_id` не показывает пароль снова.
- Другую точку организации кнопка не обслуживает (`KIOSK_BRANCH_NOT_SERVED`), пока на ней не
  включены «Киоски на этой точке» (ADR-0019, [kiosk-multipoint.md](kiosk-multipoint.md), флаг
  `KIOSK_MULTI_BRANCH_ENABLED`).
- Уже привязанный iPad хранит прежнюю привязку; чтобы привязать его заново, приложение
  переустанавливают со сбросом данных.

## Компоненты

| Где                                                  | Что                                                    |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `db/cloud/migrations/079_cloud_kiosk_pairing.sql`    | `kiosk_pairing_issues` (append-only)                   |
| `infra/staging/kiosk-pairing-grants.mjs`             | INSERT новых строк киоска/alias, SELECT/INSERT журнала |
| `packages/backoffice-core/src/kiosk-pairing.ts`      | выдача, ограничения, состояние для списка              |
| `services/api/src/device-registry-controller.ts`     | `POST .../devices/kiosk-pairing`, флаг                 |
| `apps/backoffice/server.mjs`, `src/api.ts`           | портал и клиент пропускают маршрут                     |
| `apps/backoffice/src/components/DeviceAccessView.ts` | кнопка, окно, панель с ID и ключом                     |
| `tests/integration/kiosk-pairing.test.mjs`           | PostgreSQL, права, HTTP через портал, обмен на iPad    |

## Установка (исполнитель: Codex)

1. Резервная копия облачной базы. Миграция cloud `079_cloud_kiosk_pairing.sql` (одна новая
   таблица).
2. Права: `kioskPairingGrants(<api role>, {backoffice: true, pairing: true})`. Если позже
   повторно применяются права `commercial-channel-grants.mjs` (они делают `REVOKE ALL` на
   `kiosk_devices`), этот шаг повторить.
3. Выпуск API и веба бэк-офиса с этим коммитом. В env api: `BACKOFFICE_KIOSK_PAIRING_ENABLED=true`
   (нужны также `BACKOFFICE_ENABLED`, `KIOSK_CHECKOUT_ENABLED` с верной точкой и
   `KIOSK_ENROLLMENT_KEY`, иначе кнопка не показывается).
4. Шлюз менять не нужно: портал бэк-офиса ходит в API напрямую.
5. Проверка: в «Устройства» видна кнопка «Подключить киоск»; запрос без входа - 401.

Откат: `BACKOFFICE_KIOSK_PAIRING_ENABLED=false` и `kioskPairingGrants(..., {pairing: false})`.
Выданные и привязанные iPad продолжают работать: их строки и ключи не меняются.
