# Мобильная сборка 0.2.0 (17), профиль storefront

Подготовка 10 октября 2026 на ветке `codex/mobile-integration-1010` поверх
`d85f0244` (общий срез `3c399b48` + `codex/mobile-live-fixes` `b56860b8`,
`codex/remove-pick-farm` `056ddb64`, `codex/magic-sort-record` `8f042522`).
Изменение этого шага - только номер сборки `16 -> 17` в `apps/mobile/app.json`.
Native-зависимости не менялись относительно 16.

## Профиль

`ios_release.py --app mobile --feature-profile storefront`
(`STOREFRONT_FLAGS`): pilot-флаги, `EXPO_PUBLIC_PUBLISHED_CATALOG=1`,
`EXPO_PUBLIC_PICK_FARM=0`. Bundle ID `kz.pickchick.app`, Team `DAJTP6MC3Q`,
подпись - прежний manual profile и отдельный keychain, как у сборки 16
([процедура](mobile-native16.md), [общий порядок](mobile-testflight.md)).

## Совместимость с установленным API

Установленный API `f277d1a4` (schema050). Клиент обращается только к
`auth/*`, `customers/me`, `branches`, `content/branches`, `capabilities` и
`v1/customer-checkout/*` (catalog, catalog/media, availability, orders,
feedback). Эти контроллеры на HEAD совпадают с `f277d1a4`; серверный код ветки
сверх `f277d1a4` (device registry, terminal access, сброс пароля кухни) клиентом
не вызывается. `v1/customer-farm` при `PICK_FARM=0` не используется.

## Проверки

- Локально на HEAD с номером 17: `pnpm check` - успешно; `pnpm test:mobile` -
  322/322 JS и 50/50 Python.
- Foundation CI: см. отчёт задачи; статус для точного SHA фиксируется отдельно.

## Что осталось

Архив, экспорт и загрузка в TestFlight; затем физическая приёмка на двух iPhone:
живое меню за 3 с после публикации, остановленное блюдо остаётся в корзине как
недоступное, изменение цены - пересчёт и подтверждение, нет Pick Farm,
Magic Sort - ходы и рекорд без подсказок.
