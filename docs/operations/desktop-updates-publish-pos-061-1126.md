# Касса 0.6.1 - каталог обновлений 26.11.2026

## Статус

DEPLOYED: `kitchen-0.4.10-pos-0.6.1` (касса `idle`, кухня 0.4.10 перенесена побайтно).
Владелец 26.11 в 08:24 UTC: «Разрешаю опубликовать кассу 0.6.1». Выпуск выполнил Claude через
Remote Control на MacBook владельца (gh, SSH `pickchick-ops`). Пакет оператора тот же, что для
0.6.0: `/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package` (`source_sha` 4df05b79).
Сервер точки, база, облачный API и настройки не менялись.

## Что в кассе 0.6.1

Касса 0.6.0 плюс новый фискальный чек Webkassa на казахском и русском (`edd46511`, `f4125945`:
`apps/pos-desktop/printer.mjs`, `apps/pos/src/v2/ops-view.js`, тесты). Сборка с
`f41259458618eda2990740b54b492a5b75a1bd02` (ветка `codex/webkassa-1125`).

## Доказательство

- [Windows POS package 45774232371](https://github.com/xaaknazar/pickchick/actions/runs/45774232371):
  success на `f4125945`.
- Артефакт `pickchick-pos-update-feed-f4125945…`: `pos/latest.json` (SHA-256 `2abd1b31…5586`,
  `apply=idle`) и `PickChick-POS-Setup-0.6.1-x64.exe` 172299836 байт, SHA-256
  `1c0ea96cff0b32c633292cd791b5c9cefff67a13234abcf573a51cc6a2b4eb61` (совпадает с `latest.json` и
  с шагом «Lay out the update feed of this build» журнала сборки). Загружен в
  `/opt/pickchick-staging/incoming/desktop-pos-061-1126/feed/pos`.
- Inspect до: `kitchen-0.4.10-pos-0.6.0`, блокировки и остатков нет. Publish без `--apply`:
  `inspected`, `validated=true`, имя `kitchen-0.4.10-pos-0.6.1`.
- Apply 26.11 ~08:24 UTC: `deployed`, журнал
  `/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.10-pos-0.6.1-ca8989dd46e540e9837f0fa1a214207e.json`.
- Снаружи 08:24:33 UTC: `pos/latest.json` HTTP/2 200 `no-store`, версия 0.6.1, тот же SHA-256;
  установщик HEAD 200, 172299836 байт; `kitchen/latest.json` не изменился (тело SHA-256
  `adaa13a5…20c8`); корень `/desktop-updates/` 404.

## Отзыв

`withdraw --package <пакет> --expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.10-pos-0.6.0 --expected-current kitchen-0.4.10-pos-0.6.1`
(установленные версии не откатываются).

## Что дальше

Тестовая касса ставит 0.6.1 сама при запуске, в первые 10 минут или 03:00-05:59, если никто не
вошёл. Подтверждение - заголовок окна кассы и вид следующего фискального чека.
