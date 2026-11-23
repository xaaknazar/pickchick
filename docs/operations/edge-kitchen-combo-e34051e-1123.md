# Сервер точки e34051e на тестовой кассе 23.11.2026

## Статус

DEPLOYED: Edge и четыре воркера тестовой кассы (192.168.2.66) работают из рантайма
`e34051ec30c6e641abcc1cd82a8ae040e775e77d` (ветка `codex/kitchen-edge-check-1123`): состав комбо
из бэк-офиса и граммы передаются на кухню вместе с заказом (пара к кухне 0.4.9, см.
`desktop-updates-publish-kitchen-049-1123.md`). Владелец 23.11 в 09:16 UTC: «…нужно обновить
сервер на кассовом моноблоке (сделаю бэкап) и программу кухни»; в 12:54 UTC: «Разрешаю Claude на
Mac подключиться по SSH к тестовой кассе 192.168.2.66 и обновить сервер точки». Выполнил Claude
через Remote Control на MacBook владельца (gh, SSH `Админ@192.168.2.66` через временный
`ssh_config`, проверка host key включена). Схема базы 029 не менялась.

Runbook `docs/operations/stage2-windows-1030/app-runtime-029.md`, оператор
`infra/windows/update-runtime-app-029.ps1` из `e34051ec` (SHA-256 `1ff50db6…d7e0`).

## Доказательство

- Архив собран на Mac из чистого checkout `e34051ec` (`pnpm install --frozen-lockfile`,
  `scripts/build-windows-edge-runtime.py`): 8964278 байт, SHA-256
  `e869d2644bf977c04ba583bf3e900162b246543f47da00facbc184bc60d4f291`; в манифесте
  `sourceCommit` `e34051ec`, 8134 файла.
- CI-доказательство - run/jobs
  [Foundation CI 45168985435](https://github.com/xaaknazar/pickchick/actions/runs/45168985435)
  (`completed`/`success`, 11/11 jobs на `e34051ec`), SHA-256 файла
  `e0769748e43eeebc12928fe9fc944e906cbc4a4d701309527d7ae6ff450da7c4`.
- Входы в `C:\ProgramData\PickChick\EdgeTools\incoming-app-029-e34051e` (архив, `ci-proof.json`,
  `windows\` = `infra/windows` из `e34051ec`, 114 файлов; владелец Администраторы, доступ
  Администраторы и SYSTEM, наследование выключено). SHA-256 на кассе совпали.
- Копия `schema029` (`\PickChick\PickChickEdgeBackup`, ручной запуск) 17:56 (+05) результат 0;
  задача копий отключена на окно. В 17:56:49 остановлены PosSync, FulfillmentWorker,
  MenuSyncWorker, DeviceAccessWorker, KitchenLink, KitchenLAN, Edge; Postgres и оба туннеля
  работали.
- Предшественник `7fe50fb89370591deaf00804a46cf090bc2dbc2f`, `-BranchId
  7a6f6d98-395d-4462-b5e4-b0364a4a8ec1`, `-AllowSameDiskBackup`.
- Первый запуск без `-Apply` (17:57) завис: дочерний `powershell.exe -File`, запущенный в
  SSH-сессии, ждал стандартного ввода (0,4 с CPU за 11 минут). Это был запуск только проверки, он
  остановлен в 18:08; изменений не было. Дальше оператор запускался через `Start-Process` с
  пустым `-RedirectStandardInput` и `-ExecutionPolicy Bypass` для процесса.
- Без `-Apply` (18:08:45-18:09:22): `VERIFIED: candidate runtime, CI, predecessor schema029 runtime,
stopped writers and schema029 backup; no persistent change.`
- С `-Apply` (18:09:34-18:16:30): `READY: schema029 unchanged and four native runtimes on the
candidate verified; credentials, terminal links and optional flags unchanged.`
- Затем запущен KitchenLAN, задача копий включена (18:16:48). Окно 17:56:49-18:16:48 (+05),
  12:56-13:16 UTC; заказы в это время не проходили (владелец заметил в 13:11 UTC).
- Проверка: `http://127.0.0.1:3101/health/ready` 200
  `{"ready":true,"degraded":false,"dependencies":{"database":"up","schema":"up",…}}`;
  `GET /edge/v1/pos/branch-orders?from=2026-11-23&to=2026-11-23` без сессии 401 (маршрут есть);
  все десять служб PickChick Running; Edge и четыре воркера работают из
  `C:\Program Files\PickChick\Edge\edge-e34051e\app`. Каталог состояния
  `EdgeTools\runtime-app-029-e34051e` (`completed.json`, `inputs.json`, `original-0..4.xml`).

## Отзыв

Тот же оператор в обратную сторону: из `infra\windows` коммита `7fe50fb8`
(`EdgeTools\incoming-app-029-7fe50fb\windows`) с `-SourceCommit 7fe50fb8…`, его архивом
(`edge-runtime-7fe50fb.zip`, SHA-256 `8b92439f…e519`) и CI, `-PredecessorCommit
e34051ec30c6e641abcc1cd82a8ae040e775e77d`, в том же окне (копия, остановка семи служб, без
`-Apply`, затем с `-Apply`, KitchenLAN, копии). После первого запуска кандидата прежние файлы
автоматически не возвращаются: разбираться вперёд.

## Что дальше

Проверить на кассе заказ с комбо: кухня 0.4.9 показывает состав из бэк-офиса и граммы.
Для будущих окон: запускать оператор с закрытым стандартным вводом (см. выше), чтобы окно не
затягивалось.
