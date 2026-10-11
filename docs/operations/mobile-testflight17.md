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
- Foundation CI [38054824704](https://github.com/xaaknazar/pickchick/actions/runs/38054824704)
  для `12408670`: 9 из 10 задач зелёные; static checks отменена по лимиту 25 мин
  (25,3 мин, на шаге Virtual farm), поэтому агрегат красный. Так же завершались
  обе попытки для `d85f0244`. Причина - замедление раннера, а не новые тесты:
  на том же коде `3c399b48` в 03:52 UTC интеграционный шаг шёл 8,9 мин
  (289 тестов, в среднем 1,79 с), днём 12,6-13,7 мин (292 теста, 2,6-2,7 с).
  Ветка remove-pick-farm, где менялся только mobile, тоже шла 24,5 мин.
  Новые тесты mobile-live-fixes добавляют около 11 с. Лимит CI не менялся.
- Шаги, до которых CI не дошла, локально: farm-game 28/28, `audit:release` -
  успешно (high/critical нет).

## Архив и экспорт (без загрузки)

Release `mobile-storefront-20261010-17-12408670-b` в
`~/Library/Caches/PickChick/releases/`: archive и export успешны, `dirty=false`,
версия 0.2.0, build 17, Bundle ID `kz.pickchick.app`, strict codesign архива и IPA,
`get-task-allow=false`. Embedded flags - storefront (`PICK_FARM=0`,
`PUBLISHED_CATALOG=1`); Metro-export с теми же env даёт `FARM_ENABLED=false`,
`publishedCatalogEnabled()=true`. SHA-256 `main.jsbundle`
`27d2daae37d8e72b7a724848a5dc1791a16f4322f3c69f57f7ea84fab0093bd6` (одинаков в архиве
и IPA), IPA 133480283 байт, SHA-256
`d5468dcb026e0b3a0ab6166c3090edb3f2cea4a73e69f2e0168d733b913f63e6`.
Первая попытка (label без `-b`) упала: в новой рабочей копии не были собраны
workspace-пакеты; после `pnpm build` архив собран заново.

После повторного запуска static checks (attempt 2) Foundation CI
[38054824704](https://github.com/xaaknazar/pickchick/actions/runs/38054824704)
для `12408670` зелёная 11/11. Затем этот IPA загружен в TestFlight: загрузка
успешна 10 октября 2026 в 18:53 (Алматы). Коммит `48909dcd` поверх - только
документация `[skip ci]`.

## Приёмка владельцем

10 октября 2026, около 20:40 (Алматы): владелец проверил TestFlight 0.2.0 (17)
на устройстве и сообщил: «все в норме». Сборка из `12408670`, профиль
storefront, CI 38054824704 (attempt 2) зелёная. Отдельные пункты чек-листа
(живое меню за 3 с, остановленное блюдо в корзине, пересчёт цены, нет Pick Farm,
Magic Sort - ходы и рекорд) владелец по отдельности не перечислял; зафиксировано
общее подтверждение.

Исходный код сборки включён в общий срез `codex/shared-development` слиянием
`63818701`.
