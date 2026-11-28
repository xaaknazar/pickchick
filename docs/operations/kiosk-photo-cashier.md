# Фото с iPad-киоска на кассовом Xprinter (26.11.2026)

Владелец 26.11: фото, сделанное гостем на iPad-киоске, печатается отдельным
фирменным чеком на принтере кассового моноблока (тот же Xprinter, что печатает
чеки). Позже у киоска будет свой принтер: он задаётся одной строкой конфигурации.

## Макет slip v2 (утверждён владельцем 26.11, 16:23 Алматы)

`tools/photo-printer/slip.mjs` + `preparePhotoSlip` в `raster.mjs`: логотип
(оранжевая наклейка печатается чёрным, буквы белые), «ФОТО НА ПАМЯТЬ», фото 4:3
в рамке с уголками видоискателя, подпись на языке гостя (RU/KK/EN), пожелание,
`PickChick · <точка>`, дата и время по Алматы, `pickchick.kz`. 576×973 точки,
укладывается в лимит превью киоска (высота ≤ 1000), поэтому код киоска не меняется.
Буквы - контуры Montserrat 800 / Golos Text 600 (SIL OFL) в `glyphs.json`,
пересборка: `python3 design/photo-slip/build-glyphs.py <Montserrat_800.ttf> <Golos_600.ttf>`.
Фото дизерингуется отдельно, логотип и текст - порогом, чтобы края были чёткими.
Прежний макет остаётся как `"layout": "v1"`.

## Схема

iPad → HTTPS (локальный CA «PickChick Photo Local CA 2026», профиль доверия на iPad)
→ служба `tools/photo-printer` на кассе → RAW-задание в очередь Windows
(`transport: windows-queue`, `windows-raw.ps1`, winspool) → Xprinter. Байты идут
через stdin, фото не пишется на диск. Спулер сам разводит задания POS и фото.
POS, edge, база и Webkassa не затрагиваются; облако фото не получает.

Пример конфигурации: `tools/photo-printer/config.windows-xprinter.example.json`.
Проверочная печать без людей: `node tools/photo-printer/test-print.mjs <config> ru`
(`--preview out.png` - только файл).

## Установка на тестовой кассе 26.11

- Касса WIN-C583E2V3LH9, 192.168.2.66 (Wi-Fi, адрес по DHCP: закрепить на роутере).
- `C:\PickChickPhoto\app` (пакет), `C:\PickChickPhoto\node\node.exe` (Node 24.21,
  копия из edge, чтобы обновление edge её не убрало).
- `C:\ProgramData\PickChickPhoto\` config.json, jobs.sqlite, tls\ (SYSTEM+Administrators).
- Брандмауэр «PickChick Photo 13440»: TCP 13440, LocalSubnet, Private/Domain.
- Задача планировщика «PickChick Photo»: при старте системы, SYSTEM, перезапуск при сбое.
- Очередь «PickChick XP-A160M» (USB001), `cut: true`, `point: "Abay Plaza"`.
- Ключ CA хранится только на Mac владельца (`~/Claude/photo-slip-1126/ca/`, 0600).
  Серверный сертификат: SAN IP + hostname, до 26.11.2027. Смена IP кассы = новый
  сертификат и новая сборка киоска.
- Тестовый чек вышел на бумаге (владелец 16:42). Киоск build 51
  (`EXPO_PUBLIC_KIOSK_PHOTO_URL=https://192.168.2.66:13440`, исходник
  `claude/project-thread-gj7cwf-kiosk` = cutover-1119 6d9d8ec5 + fb682580),
  сопряжение 16:51, первое фото с iPad - `sent`.

## Сопряжение iPad

Меню → карточка Алекса «Сделать фото» → в фотокабине удерживать логотип рядом
с «Назад» 5 секунд (не логотип заставки: там меню сотрудника). Код: остановить
задачу, запустить `server.mjs <config> --pair`, код живёт 5 минут; затем вернуть
задачу планировщика.
