# Касса 0.6.3 - каталог обновлений 26.11.2026

## Статус

DEPLOYED: `kitchen-0.4.10-pos-0.6.3` (касса `idle`, кухня 0.4.10 перенесена побайтно).
Владелец 26.11 в 11:33 UTC: «Разрешаю опубликовать кассу 0.6.3». Выпуск выполнил Claude через
Remote Control на MacBook владельца (gh, SSH `pickchick-ops`). Пакет оператора тот же, что для
0.6.0-0.6.2: `/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package`
(`source_sha` 4df05b79). Сервер точки, база, облачный API, настройки и Webkassa не менялись и
не вызывались (сервер точки тестовой кассы обновлён отдельно, `edge-webkassa-6a58d6b-1126.md`).

## Что в кассе 0.6.3

Касса 0.6.2 плюс `35577151` (`apps/pos-desktop/printer.mjs`, тест): под логотипом фирменного
чека печатается название точки (`branchLabel` кассы, кроме общих «Локальная точка»/«Тестовая
точка»/«Касса N») и адрес регистрации кассы Webkassa; в реквизитах адрес больше не повторяется.
На тестовой кассе `branchLabel` = «ТЦ Abay Plaza - тест».

Сборка с `6a58d6b8cad3d1ebc05caebf16527f2b901146a3` (ветка `codex/webkassa-1125`).

## Доказательство

- [Windows POS package 45803247324](https://github.com/xaaknazar/pickchick/actions/runs/45803247324):
  success на `6a58d6b8` (установка, самообновление с каталога, проверки PowerShell 5.1);
  [Foundation CI 45803247328](https://github.com/xaaknazar/pickchick/actions/runs/45803247328) 11/11.
- `apps/pos-desktop/package.json` на `6a58d6b8`: `0.6.3`.
- `tests/pos-desktop/fiscal-branded.test.mjs` с `6a58d6b8`: 9/9.
- Артефакт `pickchick-pos-update-feed-6a58d6b8…`: `pos/latest.json` (SHA-256 `ff513063…fa89`,
  версия 0.6.3, `apply=idle`) и `PickChick-POS-Setup-0.6.3-x64.exe` 172300584 байт, SHA-256
  `69ed45930eca585282faf3e80a41a16dcec13ff900a4f20b97a0e036403bf53f` (совпадает с `latest.json` и
  с журналом сборки). Загружен в `/opt/pickchick-staging/incoming/desktop-pos-063-1126/feed/pos`,
  на сервере тот же SHA-256.
- Inspect до: `kitchen-0.4.10-pos-0.6.2`, блокировки и остатков нет, план `pos new`,
  `kitchen carried`, `next_release kitchen-0.4.10-pos-0.6.3`. Publish без `--apply`: `inspected`,
  `validated=true`.
- Apply 26.11 11:48:44-11:48:54 UTC (tmux): `deployed`, `phase=verify`, журнал
  `/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.10-pos-0.6.3-148c137fd9c5459ba80db12bc04514ee.json`.
- Снаружи 11:49:00 UTC: `pos/latest.json` HTTP/2 200 `no-store`, версия 0.6.3, тот же SHA-256;
  установщик HEAD 200, 172300584 байт; `kitchen/latest.json` не изменился (тело SHA-256
  `adaa13a5…20c8`); корень `/desktop-updates/` 404.

## Отзыв

`withdraw --package <пакет> --expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.10-pos-0.6.2 --expected-current kitchen-0.4.10-pos-0.6.3`
(установленные версии не откатываются).

## Что дальше

Тестовая касса ставит 0.6.3 сама при запуске, в первые 10 минут или 03:00-05:59, если никто не
вошёл. Подтверждение - заголовок окна кассы и название точки с адресом под логотипом следующего
фискального чека.
