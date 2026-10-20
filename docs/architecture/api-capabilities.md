# `GET /v1/capabilities`: что означает ответ

Аудит 19.10.2026 (находка 7.5): ответ `/v1/capabilities` выглядит так, будто оплат нет
(`checkout:false`, `payments:false`, `fiscal:false`, `ordering_enabled:false`), хотя с 30
сентября 2026 mobile принимает реальные оплаты Kaspi.

## Почему булевы поля v1 не меняются

Поля `ordering_enabled`, `features.checkout`, `features.payments`, `features.fiscal`,
`features.loyalty` схемы v1 - **замороженный шлюз совместимости**, а не описание production:

- mobile TestFlight 0.2.0 build 20 (`apps/mobile/src/api.ts`, `parseCapabilities`) бросает
  `Unsupported feature`, если любое из них не `false`, и `Unsupported environment`, если
  `ordering_enabled` не `false`; меню не загружается;
- киоск (`apps/kiosk/src/controller.ts`, `loadCatalog`) так же требует `false`;
- контракт `CapabilitiesSchema` (`packages/contracts`) фиксирует их как `z.literal(false)`.

Переключение в `true` сломало бы установленные клиенты. Реальные оплаты идут через
отдельные маршруты (`/v1/customer-checkout/*`, `/v1/kiosk-checkout/*`), которые установленные
клиенты используют независимо от этих флагов. Если понадобится машинно-читаемая правда,
её нужно добавлять новым полем или схемой v2 вместе с новыми сборками клиентов.

## Что исправлено 20.10.2026

`notice` (текст, который установленные клиенты не показывают) больше не утверждает «Заказы
доступны без оплаты», когда включён mobile Kaspi: при `CUSTOMER_KASPI_PILOT_ENABLED=true` и
`CUSTOMER_KASPI_SALES_ENABLED` не `false` он сообщает, что заказы оплачиваются через Kaspi, а
чеки в процессе подключения. Код: `services/api/src/capabilities.ts`, тест:
`tests/unit/capabilities.test.mjs` (в том числе проверка установленным парсером mobile).
Release-скрипты, сравнивающие ответ до/после выпуска, увидят изменение `notice` - это
ожидаемо.

## Фактическое состояние (на 20.10.2026, по документам репозитория)

| Что                 | Факт                                                          | Источник                                                           |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| Mobile оплата Kaspi | работает с 30.09 (владелец), затем все подтверждённые клиенты | [kaspi-live-activation.md](../operations/kaspi-live-activation.md) |
| Фискальные чеки     | не выдаются (Webkassa отложена владельцем)                    | там же, ADR-0012                                                   |
| Возвраты Kaspi      | только вручную в Kaspi Pay                                    | ADR-0012, [kaspi-remote.md](../operations/kaspi-remote.md)         |
| Домен               | `https://pickchick.kz/` -> кабинет, установлен                | [cabinet-entry.md](../operations/cabinet-entry.md)                 |
| Pick Farm           | убрана из новых mobile-сборок 10.10 (коммит `056ddb64`)       | git                                                                |
| Фотокабина киоска   | установлена на iPad (build 22) 15.10                          | [kiosk-photo-ipad.md](../operations/kiosk-photo-ipad.md)           |
