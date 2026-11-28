# Сервер точки 5b09632 на тестовой кассе 28.11.2026

## Статус

READY. Edge и четыре воркера тестовой кассы (192.168.2.66, `WIN-C583E2V3LH9`) работают из рантайма
`5b09632b87a6b66a877383323d30492ad30f8d3a` (голова `codex/cutover-1119`: PR #437 и запись кухни
0.4.11). Предшественник — `6a58d6b8` (см. `edge-webkassa-6a58d6b-1126.md`), его запуск завершён
нормально, поэтому без `-AcceptInterruptedPredecessor`. Схема 029 не менялась. `edge.env` и файл
аккаунта Webkassa не менялись: касса остаётся тестовой devkkm, касса киоска (`--kiosk-cashbox`)
подключится позже, когда облако начнёт пробивать чеки.

Владелец 28.11 в 13:58 UTC: «Разрешаю обновить сервер точки на тестовой кассе до 5b09632b». В
14:10 UTC он добавил в `CLAUDE.local.md` на MacBook разрешение на SSH `Админ@192.168.2.66` ключом
`pickchick_cashier_admin_ed25519`. Работу выполнил Claude через Remote Control на MacBook
владельца, порядок как 26.11:

- SSH через временный `ssh_config`, проверка host key включена;
- оператор через `Start-Process` с пустым `-RedirectStandardInput`.

Облако и лента обновлений в этом окне не трогались.

## Входы

- Runbook `docs/operations/stage2-windows-1030/app-runtime-029.md`, оператор
  `infra/windows/update-runtime-app-029.ps1` из `5b09632b` (SHA-256 `5d055345…d736`, тот же файл,
  что 26.11).
- Архив собран на Mac из чистого checkout `5b09632b` (`pnpm install --frozen-lockfile`,
  `scripts/build-windows-edge-runtime.py`):
  - 9 268 141 байт, 8192 файла;
  - SHA-256 `9e846c365dbe33f98ee7db6f12f000b12b669eae87f7270b7e6a258c053cb3ec`;
  - в манифесте `sourceCommit` `5b09632b`.
- CI:
  - [Foundation CI 46054152672](https://github.com/xaaknazar/pickchick/actions/runs/46054152672)
    на `codex/cutover-1119`, 11/11 success. Run и jobs записаны в `ci-proof.json`, SHA-256
    `299e6b50a0f39ad4f8f13ef4e2491eb6958b20431d611dcccda7c321be43fe30`.
  - Windows POS package на `5b09632b` не запускался: от `0889ca56` изменились только кухня
    (`apps/kitchen`, `apps/kitchen-desktop`) и записи ленты. На `0889ca56` Windows POS package —
    success.
- Входы в `C:\ProgramData\PickChick\EdgeTools\incoming-app-029-5b09632`:
  - архив `edge-runtime-5b09632.zip`, `ci-proof.json`, `windows\` = `infra/windows` из `5b09632b`;
  - доступ только Администраторы и SYSTEM, наследование выключено, посторонних ACL нет, 119 файлов;
  - SHA-256 архива, `ci-proof.json` и всех 117 файлов `windows\` на кассе совпали с Mac.

## Окно (время +05)

- 19:12:33–19:12:36: ручной запуск `PickChickEdgeBackup`, результат 0. `status.json`: `state ok`,
  `schema029`, `lastSuccessAt 2026-11-28T14:12:35.762Z`. Задача копий отключена.
- 19:12:57: остановлены `PickChickPosSync`, `PickChickFulfillmentWorker`, `PickChickMenuSyncWorker`,
  `PickChickDeviceAccessWorker`, `PickChickKitchenLink`, `PickChickKitchenLAN`, `PickChickEdge`,
  `PickChickSyncTunnel`. `PickChickPostgres` и `PickChickFulfillmentTunnel` работали.
- `edge.env` до: SHA-256 `9b5f20ac7a24dff60003fcf0b6e5ccf668d4ded2b9b17f858a8716d50f97078c`.
- Параметры: `-SourceCommit 5b09632b… -PredecessorCommit 6a58d6b8cad3d1ebc05caebf16527f2b901146a3
-BranchId 7a6f6d98-395d-4462-b5e4-b0364a4a8ec1 -AllowSameDiskBackup` (без
  `-AcceptInterruptedPredecessor`).
- Без `-Apply` (19:13:01–19:13:42): `VERIFIED: candidate runtime, CI, predecessor schema029 runtime,
stopped writers and schema029 backup; no persistent change.`
- С `-Apply` (19:14:14–19:21:07): `READY: schema029 unchanged and four native runtimes on the
candidate verified; credentials, terminal links and optional flags unchanged.`
- `EdgeTools\runtime-app-029-5b09632\completed.json`:
  - `schema 29`;
  - `sourceCommit 5b09632b…`, `predecessorCommit 6a58d6b8…`;
  - `predecessorInterrupted false`, `databasePreserved true`, `environmentChanged false`;
  - `completedAt 2026-11-28T14:21:06.61Z`.
- 19:21:27: запущен `PickChickKitchenLAN`, задача копий включена (Ready). Окно 19:12:57–19:21:27
  (14:12–14:21 UTC).

## Проверка (19:21–19:27)

- `/health/ready` 200 `{"ready":true,"degraded":false,…database up, schema up}`.
- `GET /edge/v1/pos/fiscal-receipts/00000000-0000-4000-8000-000000000000/webkassa` без сессии — 401
  (маршрут Webkassa включён).
- `GET /edge/v1/pos/terminal-payments/open` без сессии — 401, не 404: маршрут восстановления оплаты на
  терминале Kaspi есть.
- `edge.env` после: SHA-256 `9b5f20ac…078c`, не изменился.
- Все десять служб PickChick Running. Edge, `PickChickFulfillmentWorker`, `PickChickMenuSyncWorker`,
  `PickChickDeviceAccessWorker` и `PickChickPosSync` запущены из
  `C:\Program Files\PickChick\Edge\edge-5b09632\app`.
- Журнал Edge с 19:20:44 до 19:26:51:
  - `PickChickEdge.err.log` не пополнялся, то есть нет ни одной ошибки и ни одного
    `kaspi_terminal_poll_failed`;
  - `kaspi_terminal_poll_ready` пишется только после сбоя (`kaspi-terminal-loop.ts` записывает
    только смену состояния), поэтому его отсутствие и есть успешный опрос.

Отзыв: отдельно не проверялся. По runbook после первого запуска кандидата разбираться вперёд.
