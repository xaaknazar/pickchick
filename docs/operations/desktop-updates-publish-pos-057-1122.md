# Касса 0.5.7 - каталог обновлений 22.11.2026

## Статус

DEPLOYED: `kitchen-0.4.7-pos-0.5.7` (касса `idle`, кухня 0.4.7 перенесена побайтно).
Владелец 22.11 в 13:13 UTC написал «выпускай новые сборки». Выпуск выполнил Claude через
Remote Control на MacBook Air владельца (gh, SSH `pickchick-ops`). Пакет оператора тот же, что для 0.5.6:
`/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package` (`source_sha` 4df05b79).

## Что в кассе 0.5.7

Линия Kaspi 0.5.6 (`092480a0`) плюс правки кассы из `69b0ef49` (только `apps/pos/src/v2/app.js`
и `apps/pos/src/v2/template.html`): соусы и платные напитки в сетах фингерсов.
Коммит `666fc2c54cfc7be1ff642280eb070c41ac2bdb5c` (ветка `claude/pos-057-1122`),
`node --test tests/pos/cashier-ui.test.mjs` 91/91.

## Доказательство

- [Windows POS 45026739017](https://github.com/xaaknazar/pickchick/actions/runs/45026739017):
  3/3 PASS, включая самообновление установленной кассы из каталога.
- Артефакт каталога `14755528924`: `pos/latest.json` (SHA-256 `5d5fbf0b…8e29`, `apply=idle`) и
  `PickChick-POS-Setup-0.5.7-x64.exe` 172283001 байт, SHA-256
  `d59b1ce8a9975eefe08e0156a21967f8bb82e8a4a27b7c7822a48d65e5f93e89` (тот же хеш в журнале сборки).
  Загружен в `/opt/pickchick-staging/incoming/desktop-pos-057-1122/feed/pos`.
- Inspect до: `kitchen-0.4.7-pos-0.5.6`, блокировки и остатков нет, план `pos=new`, `kitchen=carried`.
  Publish без `--apply`: `inspected`, `validated=true`.
- Apply 22.11 13:37:54 UTC (журнал): `deployed`, журнал
  `/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.7-pos-0.5.7-456199e156cc44a28fe4904aeae3a74d.json`.
- Снаружи: `pos/latest.json` HTTP/2 200 `no-store`, версия 0.5.7, тот же SHA-256; установщик HEAD 200,
  172283001 байт; `kitchen/latest.json` не изменился (0.4.7, `39b2785e…19ec`); корень `/desktop-updates/` 404.
- Ветка записи от `fa13f3bc` (запись 0.5.6) с влитым `claude/pos-057-1122`.

## Отзыв

`withdraw --package <пакет> --expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.7-pos-0.5.6 --expected-current kitchen-0.4.7-pos-0.5.7`
(установленные версии не откатываются).

## Что дальше

Касса ставит 0.5.7 сама при запуске, в первые 10 минут или 03:00-05:59, если никто не вошёл.
Подтверждение - заголовок окна кассы.
