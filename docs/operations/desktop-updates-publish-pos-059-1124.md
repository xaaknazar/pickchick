# Касса 0.5.9 - каталог обновлений 24.11.2026

## Статус

DEPLOYED: `kitchen-0.4.10-pos-0.5.9` (касса `idle`, кухня 0.4.10 перенесена побайтно).
Владелец 24.11 в 05:17 UTC написал «Разрешаю опубликовать кассу 0.5.9». Выпуск выполнил Claude
через Remote Control на MacBook владельца (gh, SSH `pickchick-ops`). Пакет оператора тот же, что
для 0.5.6-0.5.8: `/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package`
(`source_sha` 4df05b79). Сервер точки и база не менялись.

## Что в кассе 0.5.9

Касса 0.5.8 (`08278ef6`) плюс `6d5a0e99` и `84f55e41`: в корзине нет строки подытога, суммы рядом с
«−/+/✕», промокод рядом с комментарием - список корзины длиннее. Сборка с
`84f55e41327128f6d7ee655d1939e468008f8910`.

## Доказательство

- [Windows POS 45190482834](https://github.com/xaaknazar/pickchick/actions/runs/45190482834) и
  [Foundation CI 45190482857](https://github.com/xaaknazar/pickchick/actions/runs/45190482857):
  success на `84f55e41`.
- Артефакт `pickchick-pos-update-feed-84f55e41…`: `pos/latest.json` (SHA-256 `3c3a9bb8…37ff`,
  `apply=idle`) и `PickChick-POS-Setup-0.5.9-x64.exe` 172291595 байт, SHA-256
  `76d4f419c7b95028f9e6b7e95b4f1ed5119330033889b2830715306a37aef9ed` (совпадает с `latest.json`).
  Загружен в `/opt/pickchick-staging/incoming/desktop-pos-059-1124/feed/pos`.
- Inspect до: `kitchen-0.4.10-pos-0.5.8` (кухню 0.4.10 ночью выложил другой тред; запрошенное
  сначала `kitchen-0.4.9-pos-0.5.8` не совпало, шаг остановился и продолжен с 0.4.10), блокировки и
  остатков нет, план `pos=new`, `kitchen=carried`. Publish без `--apply`: `inspected`, `validated=true`.
- Apply 24.11 05:23:22 UTC: `deployed`, журнал
  `/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.10-pos-0.5.9-2f5b6b125857465d90cdcf31d94d0c9a.json`.
- Снаружи: `pos/latest.json` HTTP/2 200 `no-store`, версия 0.5.9, тот же SHA-256; установщик HEAD 200,
  172291595 байт; `kitchen/latest.json` не изменился (0.4.10, тело SHA-256 `adaa13a5…20c8` до и после);
  корень `/desktop-updates/` 404.
- Ветка записи `ce664007` (запись кухни 0.4.10 `a6624f77` + `84f55e41`).

## Отзыв

`withdraw --package <пакет> --expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.10-pos-0.5.8 --expected-current kitchen-0.4.10-pos-0.5.9`
(установленные версии не откатываются).

## Что дальше

Касса ставит 0.5.9 сама при запуске, в первые 10 минут или 03:00-05:59, если никто не вошёл.
Подтверждение - заголовок окна кассы.
