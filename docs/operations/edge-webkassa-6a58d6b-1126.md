# Сервер точки 6a58d6b на тестовой кассе 26.11.2026 (Webkassa: Z-отчёт при Code 11)

## Статус

READY. Edge и четыре воркера тестовой кассы (192.168.2.66) работают из рантайма
`6a58d6b8cad3d1ebc05caebf16527f2b901146a3` (предшественник `da9f6125`, его запуск был прерван
перезапуском `PickChickSyncTunnel`, см. `edge-webkassa-da9f612-1126.md`). Схема 029 не менялась,
Webkassa осталась включённой (`edge.env` прежний).

Новое в кандидате: edge-воркер Webkassa при Code 11 (смена старше 24 ч) закрывает смену Z-отчётом
и один раз повторяет чек; оператор принимает прерванного предшественника
(`-AcceptInterruptedPredecessor`); runbook останавливает в окне и `PickChickSyncTunnel`.

Владелец 26.11 в 10:36 UTC: «делай» (обновить сервер точки с автоматическим закрытием смены).
Выполнил Claude через Remote Control на MacBook владельца (gh, SSH `Админ@192.168.2.66` через
временный `ssh_config`, проверка host key включена; оператор через `Start-Process` с пустым
`-RedirectStandardInput`). Облако и лента обновлений касс в этом окне не трогались.

## Входы

- Runbook `docs/operations/stage2-windows-1030/app-runtime-029.md` кандидата, оператор
  `infra/windows/update-runtime-app-029.ps1` из `6a58d6b8` (SHA-256 `5d055345…d736`).
- Архив собран на Mac из чистого checkout `6a58d6b8` (`pnpm install --frozen-lockfile`,
  `scripts/build-windows-edge-runtime.py`): 9202498 байт, SHA-256
  `635cfe1bbe5dae5741f915305ad399dc9e8afab8e0335e245ea27641a8cc8cce`, 8177 файлов, в манифесте
  `sourceCommit` `6a58d6b8`.
- CI: [Foundation CI 45803247328](https://github.com/xaaknazar/pickchick/actions/runs/45803247328)
  (11/11 success) - run/jobs в `ci-proof.json`, SHA-256
  `0380decf6b2718659f95295b6b0ce7d8d6982ae71040b9d2feb4b73095dbe788`;
  [Windows POS package 45803247324](https://github.com/xaaknazar/pickchick/actions/runs/45803247324) -
  success.
- Входы в `C:\ProgramData\PickChick\EdgeTools\incoming-app-029-6a58d6b` (архив, `ci-proof.json`,
  `windows\` = `infra/windows` из `6a58d6b8`; Администраторы и SYSTEM, наследование выключено,
  117 файлов, посторонних ACL нет). SHA-256 на кассе совпали.

## Окно (время +05)

- 16:32:29-16:32:35: ручной запуск `PickChickEdgeBackup`, результат 0; `status.json` `state ok`,
  `schema029`, `lastSuccessAt 2026-11-26T11:32:31.712Z`. Задача копий отключена.
- 16:32:53: остановлены `PickChickPosSync`, `PickChickFulfillmentWorker`, `PickChickMenuSyncWorker`,
  `PickChickDeviceAccessWorker`, `PickChickKitchenLink`, `PickChickKitchenLAN`, `PickChickEdge`,
  `PickChickSyncTunnel`. Postgres и `PickChickFulfillmentTunnel` работали.
- `edge.env` до: SHA-256 `9b5f20ac7a24dff60003fcf0b6e5ccf668d4ded2b9b17f858a8716d50f97078c`.
- Параметры: `-SourceCommit 6a58d6b8… -PredecessorCommit da9f61251b7076a52e619ecf127a3309ff4f362a
  -AcceptInterruptedPredecessor -BranchId 7a6f6d98-395d-4462-b5e4-b0364a4a8ec1 -AllowSameDiskBackup`.
- Без `-Apply` (16:32:56-16:33:33): `VERIFIED: candidate runtime, CI, predecessor schema029 runtime,
  stopped writers and schema029 backup; no persistent change.`
- С `-Apply` (16:33:45-16:40:40): `READY: schema029 unchanged and four native runtimes on the
  candidate verified; credentials, terminal links and optional flags unchanged.`
- `EdgeTools\runtime-app-029-6a58d6b\completed.json`: `schema 29`, `sourceCommit 6a58d6b8…`,
  `predecessorCommit da9f6125…`, `predecessorInterrupted true`, `databasePreserved true`,
  `environmentChanged false`, `completedAt 2026-11-26T11:40:40.62Z`.
- 16:40:51: запущен `PickChickKitchenLAN`, задача копий включена (Ready). Окно 16:32:53-16:40:51
  (11:32-11:40 UTC).

## Проверка (16:41)

- `/health/ready` 200 `{"ready":true,"degraded":false,…database up, schema up}`.
- `GET /edge/v1/pos/fiscal-receipts/00000000-0000-4000-8000-000000000000/webkassa` без сессии - 401
  (маршрут Webkassa включён).
- `edge.env` после: SHA-256 `9b5f20ac…078c` - не изменился.
- Все десять служб PickChick Running (включая `PickChickSyncTunnel` и `PickChickPosSync`); Edge и
  четыре воркера из `C:\Program Files\PickChick\Edge\edge-6a58d6b\app`.

Отзыв (если понадобится): тот же оператор с `-SourceCommit da9f6125…` и `-PredecessorCommit
6a58d6b8…` из `infra\windows` подходящего коммита, сначала без `-Apply`.
