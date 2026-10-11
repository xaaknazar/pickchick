# Мобильная сборка 0.2.0 (18), профиль storefront

11 октября 2026, по поручению владельца «опубликуй новую сборку для телефона».
Владелец выбрал «только одобренное»: общий срез `8891b329` (плавающее нижнее меню,
одобрено владельцем) + номер сборки `17 -> 18` в `apps/mobile/app.json`, коммит
`fb4dc2cd` на ветке `codex/mobile-testflight18`. Паттерны Luma (шторки, тосты,
свайп отмены) и запрет отмены оплаченного заказа в сборку не входят - они на ветке
`codex/mobile-luma-patterns`. Native-зависимости не менялись относительно 17.

## Проверки

- Foundation CI [38127621186](https://github.com/xaaknazar/pickchick/actions/runs/38127621186)
  для `fb4dc2cd`: success. CI исходного `8891b329`: 38085375816 success.
- `ios_release.py --app mobile --feature-profile storefront`: doctor, archive, export
  успешны; прежние manual profile/identity и отдельный keychain.
- Архив проверен helper'ом: 0.2.0 (18). IPA 133480801 байт, SHA-256 `9cb6bf4fa6363c23c8a557a4cc92f48c579e6cd1c3f381c37fcaccb9ae7e975a`.

## Загрузка

Upload в App Store Connect 6809208492: `Upload succeeded`, `EXPORT SUCCEEDED`,
11 октября 2026 в 14:45 (Алматы). Обработка Apple и появление в PickChick Internal
не подтверждены на момент записи. Физическая приёмка на iPhone не выполнена.
