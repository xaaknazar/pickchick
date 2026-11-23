# Касса 0.5.8 - каталог обновлений и сервер точки 23.11.2026

## Статус

DEPLOYED: `kitchen-0.4.8-pos-0.5.8` (касса `idle`, кухня 0.4.8 перенесена побайтно).
Владелец 23.11 в 11:32 UTC написал «Разрешаю опубликовать кассу 0.5.8 и обновить сервер точки на
тестовой кассе». Выпуск выполнил Claude через Remote Control на MacBook владельца (gh, SSH
`pickchick-ops`). Пакет оператора тот же, что для 0.5.6 и 0.5.7:
`/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package` (`source_sha` 4df05b79).

## Что в кассе 0.5.8

Линия Kaspi 0.5.7 (`666fc2c5`) плюс:

- «−», «+» и «✕» работают на только что добавленной строке (`2da91daa`);
- «Терминал отклонил» не показывается, пока гость платит на терминале Kaspi (`9e7618db`);
- нет вспышки «Результат запроса неизвестен» при нажатиях в стоп-листе, в «Заказах» нет будущих
  дней (`94c7e198`);
- «Заказы» показывают все заказы точки за день, период или месяц (`6eb5094d`, маршрут edge
  `GET pos/branch-orders`, поэтому вместе с кассой обновлён сервер точки, см. ниже);
- панель восстановления при запуске, переменная привязки оператора, хеш LAN-манифеста (`08278ef6`).

Сборка с `08278ef6bb30cfc406e6d825e39cbae5b01654f9`; финальный коммит линии
`7fe50fb89370591deaf00804a46cf090bc2dbc2f` отличается только тестом `tests/pos/browser_ui.py`.

## Доказательство

- [Windows POS 45148341294](https://github.com/xaaknazar/pickchick/actions/runs/45148341294): success
  на `08278ef6`. [Foundation CI 45155600613](https://github.com/xaaknazar/pickchick/actions/runs/45155600613):
  11/11 success на `7fe50fb8`.
- Артефакт `pickchick-pos-update-feed-08278ef6…`: `pos/latest.json` (SHA-256 `1f304ed7…021a`,
  `apply=idle`) и `PickChick-POS-Setup-0.5.8-x64.exe` 172291377 байт, SHA-256
  `b49e664541578c18bf14d52837396a72b37a38e9e50b99cb870a21cae99a4a58` (совпадает с `latest.json`).
  Загружен в `/opt/pickchick-staging/incoming/desktop-pos-058-1123/feed/pos`.
- Inspect до: `kitchen-0.4.8-pos-0.5.7`, блокировки и остатков нет, план `pos=new`, `kitchen=carried`.
  Publish без `--apply`: `inspected`, `validated=true`.
- Apply 23.11 11:32:39 UTC: `deployed`, журнал
  `/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.8-pos-0.5.8-90bbea34a34647da9b3de30a43ee9735.json`.
- Снаружи: `pos/latest.json` HTTP/2 200 `no-store`, версия 0.5.8, тот же SHA-256; установщик HEAD 200,
  172291377 байт; `kitchen/latest.json` не изменился (0.4.8, `c263a981…1810`); корень `/desktop-updates/` 404.

## Сервер точки на тестовой кассе (192.168.2.66)

Runbook `docs/operations/stage2-windows-1030/app-runtime-029.md`, оператор
`infra/windows/update-runtime-app-029.ps1` из `7fe50fb8`.

- Архив собран на Mac из чистого checkout `7fe50fb8` (`pnpm install --frozen-lockfile`,
  `scripts/build-windows-edge-runtime.py`): 8963633 байт, SHA-256
  `8b92439f2f79381a50e7290e4a33a0cfb8f9a94a13ce6b57706a7e4a26d1e519`. CI-доказательство -
  run/jobs Foundation CI 45155600613 (SHA-256 файла `5ca45f44…1798`).
- Входы в `C:\ProgramData\PickChick\EdgeTools\incoming-app-029-7fe50fb` (владелец Администраторы,
  доступ Администраторы и SYSTEM, наследование выключено).
- Копия `schema029` 15:37 (+05) результат 0; задача копий отключена на окно; остановлены
  PosSync, FulfillmentWorker, MenuSyncWorker, DeviceAccessWorker, KitchenLink, KitchenLAN, Edge;
  Postgres и оба туннеля работали.
- Предшественник `8290c87f7e1cf3262d59c7014aec25ed0eb97a3c`, `-AllowSameDiskBackup`.
  Без `-Apply`: `VERIFIED: candidate runtime, CI, predecessor schema029 runtime, stopped writers and
schema029 backup; no persistent change.` С `-Apply`: `READY: schema029 unchanged and four native
runtimes on the candidate verified; credentials, terminal links and optional flags unchanged.`
- Затем запущен KitchenLAN, задача копий включена. Окно 16:33-16:42 (+05).
- Проверка: `/health/ready` 200 `ready:true`; `GET /edge/v1/pos/branch-orders?from=2026-11-23&to=2026-11-23`
  без сессии 401 `UNAUTHORIZED` (маршрут есть); все десять служб PickChick Running; Edge и четыре
  воркера работают из `C:\Program Files\PickChick\Edge\edge-7fe50fb\app`.

## Отзыв

Каталог: `withdraw --package <пакет> --expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.8-pos-0.5.7 --expected-current kitchen-0.4.8-pos-0.5.8`
(установленные версии не откатываются). Сервер точки после первого запуска кандидата
автоматически не возвращается: разбираться вперёд (runbook).

## Что дальше

Касса ставит 0.5.8 сама при запуске, в первые 10 минут или 03:00-05:59, если никто не вошёл.
Подтверждение - заголовок окна кассы. Проверить на кассе «Заказы» (все каналы, период, месяц).
