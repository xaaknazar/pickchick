# Графика карточки Google Play

Play Console > Store presence > Main store listing требует, кроме текстов из `listing.json`,
значок приложения, графический баннер (feature graphic) и скриншоты телефона: они обязательны
до отправки выпуска в закрытое тестирование и production. Источник требований - справка Play
Console «Add preview assets»; перед загрузкой сверить, они меняются.

## 1. Значок 512 x 512 - готов

`graphics/play-icon-512.png`: 512 x 512, 32-битный PNG с прозрачностью, 247 КБ (лимит 1 МБ).
Это арт значка App Store (`apps/mobile/assets/app-icon.png`), уменьшенный без изменений: полный
квадрат без скруглений и тени - маску и тень Google Play рисует сам. Значок на телефоне
(адаптивный) - отдельные слои `apps/mobile/assets/android/`, они в AAB.

## 2. Графический баннер 1024 x 500 - черновик, владелец утверждает

`graphics/feature-graphic-1024x500.png`: 1024 x 500, 24-битный PNG без прозрачности (Play
принимает JPEG или 24-битный PNG до 15 МБ). Наклейка PickChick (передний слой адаптивного
значка) и вырезанные бургер, стрипсы и фирменный соус на синем фирменном фоне, без текста:
надписи пришлось бы делать на трёх языках, а Play может накрыть баннер своими кнопками. Всё
важное - в середине, края свободны. Только наши блюда, без напитков с чужими марками.

Генератор: `python3 scripts/mobile/play_store_graphics.py` (пишет оба файла в
`docs/operations/mobile-play-2026-11/graphics/`; `--output DIR` - в другой каталог). Если владелец
хочет другую композицию или фото, файл заменяется тем же именем и размером; тест
`tests/mobile/play-listing.test.mjs` проверит размер и формат.

## 3. Скриншоты телефона - снимает Codex

Требования Play: от 2 до 8 скриншотов на телефон, JPEG или 24-битный PNG без прозрачности,
каждая сторона от 320 до 3840 px, длинная сторона не больше двух коротких. Для показа в
подборках Play нужно не меньше 4 скриншотов от 1080 px. Поэтому снимаем **1080 x 1920**
(портрет 9:16). Обычный снимок современного телефона 1080 x 2400 (20:9) длиннее 2:1 - Play его
не примет.

Как снять (Mac, после внутреннего тестирования, с настоящими ценами):

1. Android Studio > Device Manager: эмулятор с экраном 1080 x 1920, 420 dpi (профиль Pixel 2
   или свой профиль с этим разрешением), Android 15 или 16.
2. Сборка с `--apk` (`android_release.py build --apk --release play-screens-N`, профиль
   `production`), `adb install <каталог выпуска>/PickChick-<версия>-<код>-production.apk`.
3. Чистая строка состояния (демо-режим Android):
   `adb shell settings put global sysui_demo_allowed 1`, затем
   `adb shell am broadcast -a com.android.systemui.demo -e command enter`,
   `... -e command clock -e hhmm 0941`, `... -e command notifications -e visible false`,
   `... -e command battery -e level 100 -e plugged false`.
4. Каждый экран: `adb exec-out screencap -p > ru/01-menu.png`; прозрачность убрать
   (`sips -s format jpeg ru/01-menu.png --out ru/01-menu.jpg` или любой конвертер в JPEG).
5. Экраны и запреты - те же, что для App Store: `docs/operations/mobile-appstore-2026-10-22/screenshots-plan.md`
   (Меню, Блюдо, Корзина с Kaspi до нажатия оплаты, Статус заказа, Игры, Профиль; без Чиков,
   «скоро», Apple Pay / Google Pay, тестовых цен, настоящих телефонов и имён). На Android в
   кадре нет «App Store» и iPhone-рамок.
6. Язык: русский набор обязателен (язык карточки по умолчанию). Казахский и английский наборы -
   по желанию владельца (иначе Play покажет русские).

Файлы скриншотов в Git не кладём: они хранятся там же, где скриншоты App Store, вне репозитория.
