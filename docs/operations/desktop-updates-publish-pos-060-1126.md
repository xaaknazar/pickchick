# Касса 0.6.0 - каталог обновлений 26.11.2026

## Статус

DEPLOYED: `kitchen-0.4.10-pos-0.6.0` (касса `idle`, кухня 0.4.10 перенесена побайтно).
Владелец 26.11 в 05:25 UTC: «Разрешаю опубликовать кассу 0.6.0, обновить сервер точки и включить
Webkassa на тестовой кассе и в облаке». Выпуск выполнил Claude через Remote Control на MacBook
владельца (gh, SSH `pickchick-ops`). Пакет оператора тот же, что для 0.5.6-0.5.9:
`/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package` (`source_sha` 4df05b79).

## Что в кассе 0.6.0

Касса 0.5.9 плюс автоматические чеки Webkassa (`1daefc68`, `0298b517`, `b2ab2541`): касса спрашивает
у сервера точки чек продажи и печатает его с QR; если на точке нет учётной записи Webkassa (404),
чек пробивается вручную, как раньше. Сборка с `da9f61251b7076a52e619ecf127a3309ff4f362a`
(PR 434, ветка `codex/webkassa-1125`).

## Доказательство

- [Windows POS package 45761889598](https://github.com/xaaknazar/pickchick/actions/runs/45761889598)
  и [Foundation CI 45761889572](https://github.com/xaaknazar/pickchick/actions/runs/45761889572)
  (11/11 jobs): success на `da9f6125`.
- Артефакт `pickchick-pos-update-feed-da9f6125…`: `pos/latest.json` (SHA-256 `4dde555e…6b87`,
  `apply=idle`) и `PickChick-POS-Setup-0.6.0-x64.exe` 172294148 байт, SHA-256
  `462902a9912bc0637c63b7b2d9cd6f754bc21e2c11adb95355a12fc3b69fb73c` (совпадает с `latest.json`).
  Загружен в `/opt/pickchick-staging/incoming/desktop-pos-060-1126/feed/pos`.
- Inspect до: `kitchen-0.4.10-pos-0.5.9`, блокировки и остатков нет. Publish без `--apply`:
  `inspected`, `validated=true`, имя `kitchen-0.4.10-pos-0.6.0`.
- Apply 26.11 06:14:37 UTC: `deployed`, журнал
  `/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.10-pos-0.6.0-fbbf7a3ce9b24c5f8423fe0d67de682e.json`.
- Снаружи: `pos/latest.json` HTTP/2 200 `no-store`, версия 0.6.0, тот же SHA-256; установщик HEAD 200,
  172294148 байт; `kitchen/latest.json` не изменился (тело SHA-256 `adaa13a5…20c8` до и после);
  корень `/desktop-updates/` 404. `tests/desktop-update-server/published-check.mjs` по этой записи - ok.

## Отзыв

`withdraw --package <пакет> --expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.10-pos-0.5.9 --expected-current kitchen-0.4.10-pos-0.6.0`
(установленные версии не откатываются).

## Что дальше

Касса ставит 0.6.0 сама при запуске, в первые 10 минут или 03:00-05:59, если никто не вошёл.
Подтверждение - заголовок окна кассы. Сервер точки обновлён до `da9f6125` в том же окне
(`edge-webkassa-da9f612-1126.md`); Webkassa на точке пока не включена, касса работает с ручным чеком.
