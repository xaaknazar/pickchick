# Облачный кухонный канал: iPad-киоск и экран заказа (build 13)

Решение: [ADR-0014](adr/0014-cloud-kitchen-channel.md), предыдущий этап: [S4](cloud-kitchen-s4.md).
В production ничего не включено: все точки в режиме `edge`, build 13 на iPad не устанавливался,
релиз на VPS не выполнялся. Поведение режима `edge` не меняется.

## Сервер (`packages/commerce-core`)

- `order-view.ts` (`readCheckoutOrder`, общий для киоска и мобильного приложения): если у заказа
  нет строки `cloud_fulfillment_projection` и он записан в `cloud_channel_orders`, номер, статус
  кухни, этап (`cooking`/`assembly`) и время изменения берутся из `cloudKitchenProjection`
  (`cloud_kitchen_orders`, номер 300-599 kiosk / 600-899 mobile). Состояния совпадают с edge:
  `accepted`/`in_production` - «Готовим», `ready`, `handed_over`, `cancel_requested`/`cancelled` -
  `attention`. Для облачного заказа `receipt: 'deferred'` (чек пока не выбивается,
  `deferred_no_receipt`). Без таблиц или грантов 054/056 заказ читается как раньше.
- `kiosk-checkout.ts` `config()`: в режиме `cloud` условие «кухня» - gate `KITCHEN_OFFLINE`
  (`cloudChannelAvailability`: за 30 с опрашивали ленту хотя бы одна станция prep и одна
  assembly), а не активная привязка кассы и устройство. Ответ в режиме `cloud` дополнительно
  содержит `kitchen: 'online' | 'offline'`; ответ режима `edge` прежний (те же поля и значения).
  Если киоск не готов из-за кухни, `quote`/`create`/`pay` отказывают `KITCHEN_OFFLINE`
  (`AvailabilityError`, HTTP 503), иначе как раньше `NOT_READY`. Пока `KITCHEN_OFFLINE` не
  входит в `ErrorSchema`, клиенты получают `SERVICE_UNAVAILABLE`.

## Киоск (`apps/kiosk`, build 13)

- Ошибка `KITCHEN_OFFLINE` с текстом KZ/RU/EN. RU: «Кухня сейчас не на связи - заказ оформить
  нельзя. Пригласите сотрудника.» Показывается, когда `/config` ответил `kitchen: 'offline'`,
  когда в режиме `cloud` лента наличия стала не свежей, и на отказ `KITCHEN_OFFLINE` или
  отказы старого вида (`NOT_READY`, `AVAILABILITY_STALE`, `SERVICE_UNAVAILABLE`) при известной
  офлайн-кухне. Оформление закрыто, меню остаётся видимым. Когда лента снова свежая, киоск
  перечитывает `/config` и открывает оформление; корзина сохраняется.
- Режим `edge`: прежние тексты (`NOT_ACCEPTING` при не свежей ленте).
- Оплаченный облачный заказ показывает номер с сервера (300-599) и статус кухни; при
  `receipt: 'deferred'` - прежний текст «Фискальный чек пока не сформирован».
- Повторно применён пропущенный фикс build 11 (`f2e34110`): заголовок шапки корзины/upsell
  держит минимальную ширину, языковой переключатель сжимается первым.
- `buildNumber` iOS - `13`.

## Проверки

- PostgreSQL: `tests/integration/cloud-kitchen-payment.test.mjs` (номер и статусы облачного заказа
  в `read()` киоска до выдачи, `receipt: 'deferred'`; готовность в `cloud` без привязки кассы,
  `kitchen: 'offline'` -> `KITCHEN_OFFLINE` для `pay`; режим `edge` без поля `kitchen` и с
  `receipt: 'pending'`), `packages/commerce-core/tests/kiosk-checkout.postgres.test.mjs` (точная
  форма ответа `config()` в режиме `edge`).
- Киоск: `tests/kiosk/cloud-kitchen.test.mjs` (контроллер: офлайн при старте, уход и возврат
  кухни в сессии, отказ `KITCHEN_OFFLINE`, номер 342 после оплаты, `edge` прежний),
  `tests/kiosk/browser_cloud_kitchen.py` (Storybook `Kiosk/CloudKitchen`, 768/820/1024: текст
  KZ/RU/EN, кнопка оплаты закрыта, номер 342, ширина заголовка шапки). Браузерный тест
  запускается вместе с `browser_payment_options.py` в workflow `kiosk-ui-library` (файл workflow
  занят задачей `kiosk-kaspi-qr`).

## Не сделано

- `KITCHEN_OFFLINE` в `ErrorSchema`/`openapi.json` (занят `inventory`).
- Установка build 13 на iPad, включение режима `cloud` и грантов на VPS - отдельные релизные шаги
  по runbook и только с подтверждением владельца.
