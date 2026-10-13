# Киоск: редизайн 13.10, build 15

## Подготовка

Ветка `codex/kiosk-redesign-1013`, [PR #238](https://github.com/xaaknazar/pickchick/pull/238),
base `codex/shared-development`. Интегрирован shared `1d141433` и по прямому
разрешению владельца демо/смена KZ → RU → EN из `114d5555`.
Отдельный коммит `5367bbd783385d9ec93068170e076a96dfb08a2e` задаёт buildNumber 15.
Версия 0.1.0, Bundle ID `kz.pickchick.kiosk`, только iPad.

Скрытый демо-режим сохранён вместе с кнопкой «Салют»: удержание логотипа 5 с,
подтверждение, изолированный каталог/корзина/демонстрационный QR/номер Д-123.
Выход по плашке ДЕМО; после перезапуска демо выключен. Смена надписи начинается
с KZ, затем RU и EN каждые 2,4 с; явный выбор языка фиксирует подпись.

## Проверки до выпуска

- `pnpm install --frozen-lockfile`, build/typecheck, ESLint и Prettier успешны.
- `pnpm test:kiosk`: 181/181 после объединения.
- Web export и Storybook build успешны. Браузерные сценарии выполняются
  только на локальных фикстурах; финансовых обращений к VPS/банку нет.
- Браузер: demo 2/2, welcome CTA 3/3, redesign start 1/1 (3 размера и языка),
  menu 5/5, upsell 6/6 (включая коммерческий QR на фикстуре Storybook),
  прежний UI 6/6, payment success 1/1. Roadmap tests 7/7.
- iOS prebuild и CocoaPods выполнены. Прежняя публичная переменная киоска
  `EXPO_PUBLIC_KIOSK_COMMERCIAL=1` сохранена для prebuild и Release bundle;
  остальные EXPO_PUBLIC_* не добавляются, загрузка dotenv отключена.
- Release helper проверил профиль именно киоска и действующую подпись.
  Профили, ключи и пароли остаются в приватных исключённых из Git файлах.

## Доставка

Точный исходник архива: `3b9733affd4db3f1ea7082b12534f63a04637af4`, чистое
дерево, локальная и удалённая вершины совпали. До архива проверена полная
[Foundation CI 38359170302](https://github.com/xaaknazar/pickchick/actions/runs/38359170302)
(11/11), [Kiosk UI library](https://github.com/xaaknazar/pickchick/actions/runs/38359175164)
и [Project roadmap](https://github.com/xaaknazar/pickchick/actions/runs/38359175149).
Все проверки PR на этом исходнике успешны.

Release archive завершился `ARCHIVE SUCCEEDED`; export успешен.
`codesign --verify --deep --strict` прошёл для архива и приложения из IPA;
метаданные подтверждают 0.1.0 (15), `kz.pickchick.kiosk`, iPad family `[2]`.
Release label: `kiosk-redesign-20261013-15`. Приватные артефакты сохранены в
`~/Library/Caches/PickChick/releases/kiosk-redesign-20261013-15`.
`application-identifier`, `keychain-access-groups` и Team совпали с сохранённым
подписанным артефактом build 14 (`114d5555`); это проверка совместимости
идентичности, а не доказательство установки 14 или 15 на iPad.

На повторной проверке 13 октября iPad Air 13 M3 недоступен через `devicectl`.
Выбран предусмотренный владельцем путь archive/export/upload с обязательным
`testFlightInternalTestingOnly=true` и только существующая группа
PickChick Kiosk Internal. Release helper завершил upload успешно;
`release.json` содержит `deliveryStatus=submitted`, ASC app ID `6809407135`.
App Store Connect показал 0.1.0 (15), «Обработка», загрузка 13 октября в 12:30
Алматы. ASC build ID `5ae11bed-a1a2-4782-986d-f0b87cc804c7`.
Обработка завершена: Apple показывает «Тестируется», «Внутреннее» и
**PickChick Kiosk Internal**. Сборка добавлена только в эту существующую
внутреннюю группу с одним прежним тестировщиком. Внешних групп и публичных
ссылок нет. Русский чек-лист сохранён в «Что тестировать».
[Открыть сборку](https://appstoreconnect.apple.com/teams/d4bb6fec-2b82-44c6-b91d-b679b1114a6e/apps/6809407135/testflight/ios/5ae11bed-a1a2-4782-986d-f0b87cc804c7).
[Подтверждение группы и статуса](images/kiosk-redesign-2026-10-13/testflight15-ready.jpg).
Приложение и его данные с iPad не удалялись. Физическая установка и приёмка
пока не подтверждены.

Для установки: на iPad открыть TestFlight → PickChick Kiosk → обновить до
0.1.0 (15), сохранив существующее приложение. Демо включается удержанием
логотипа на заставке 5 секунд и подтверждением.

## Контрольные суммы SHA-256

| Артефакт                            | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| IPA                                 | `ae11ffad0c1caebb8eb293c5c60768149f162f4b67df353fe1248eabba44c707` |
| main.jsbundle (архив и IPA совпали) | `aaa1a6fd7267715aaac145799f10da7d337f70d5954df4fd54bc9a9cbc7c361e` |
| Executable в архиве                 | `f3376d46af4504ce64dfbd5ab5571e9b01d555175ecd3ea6c542b9119ce2dc6a` |
| Executable после экспорта           | `b2bc3c8b73a05040afee9524c2489f02af05f7491d3206cd624e7d77afb5f20a` |

Хеши executable зафиксированы отдельно для архива и экспортированного IPA;
обе подписи прошли проверку, встроенный JS совпал.
Приватные доказательства: `release.json`, `artifact-proof.json`, `archive.log`,
`export.log`, `upload.log` и ExportOptions. Оба ExportOptions содержат
`testFlightInternalTestingOnly=true`. Содержимое профиля и ключей в Git не переносится.

Apple приняла загрузку с восемью предупреждениями об отсутствующих dSYM
сторонних frameworks. Собственный dSYM приложения присутствует; диагностика
нативных сбоев этих зависимостей остаётся ограничением, а не проверенной функцией.

## Чек-лист владельца на iPad

- Старт: «Салют», подпись KZ → RU → EN, фиксация выбранного языка,
  статичный вид при «Уменьшить движение».
- Демо: удержать логотип 5 с, подтвердить; проверить плашку ДЕМО на каждом
  экране, путь меню → допы → способ оплаты → неоплачиваемый QR → Д-123.
- Меню: все разделы, фотографии, прокрутка, корзина и закреплённые действия.
- Нативный вид: стекло без backdrop blur, радиальный фон и смешивание фото.
- Реальные платежи, счета и банковские QR этим протоколом не проверяются.
