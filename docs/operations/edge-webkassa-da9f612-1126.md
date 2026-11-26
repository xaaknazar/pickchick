# Сервер точки da9f612 и ключ Webkassa на тестовой кассе 26.11.2026

## Статус

- Сервер точки: DEPLOYED, но оператор не записал `READY`. Edge и четыре воркера тестовой кассы
  (192.168.2.66) работают из рантайма `da9f61251b7076a52e619ecf127a3309ff4f362a` (Webkassa, касса 0.6.0;
  внутри установленный ранее `e34051ec`). Схема 029 не менялась.
- Webkassa на точке: НЕ ВКЛЮЧЕНА. `enable-webkassa-edge.ps1 -Apply` отказал до остановки служб,
  `edge.env` не изменён.

Владелец 26.11 в 05:25 UTC: «Разрешаю опубликовать кассу 0.6.0, обновить сервер точки и включить
Webkassa на тестовой кассе и в облаке». Выполнил Claude через Remote Control на MacBook владельца
(gh, SSH `Админ@192.168.2.66` через временный `ssh_config`, проверка host key включена; оператор
запускался через `Start-Process` с пустым `-RedirectStandardInput`). Облако не трогалось.

## Сервер точки

Runbook `docs/operations/stage2-windows-1030/app-runtime-029.md`, оператор
`infra/windows/update-runtime-app-029.ps1` из `da9f6125` (SHA-256 `1ff50db6…d7e0`, тот же, что 23.11).

- Архив собран на Mac из чистого checkout `da9f6125` (`pnpm install --frozen-lockfile`,
  `scripts/build-windows-edge-runtime.py`): 9202269 байт, SHA-256
  `3d7cc5962dc06d02640eddec33e2575be1bb0962cea935e80a4ec2fd2451f6bd`, 8177 файлов, в манифесте
  `sourceCommit` `da9f6125`.
- CI-доказательство - run/jobs Foundation CI 45761889572 (11/11 success), SHA-256 файла
  `11de39db6955a60aa1499e0e96ddad789d059f7a835fd076a103c64d4ef54503`.
- Входы в `C:\ProgramData\PickChick\EdgeTools\incoming-app-029-da9f612` (архив, `ci-proof.json`,
  `windows\` = `infra/windows` из `da9f6125`; Администраторы и SYSTEM, наследование выключено).
  SHA-256 на кассе совпали.
- Копия `schema029` (ручной запуск задачи) 11:03:30 (+05), `state ok`; задача копий отключена.
  В 11:04:20 остановлены семь служб; Postgres и оба туннеля работали.
- `-PredecessorCommit e34051ec30c6e641abcc1cd82a8ae040e775e77d`, `-BranchId
  7a6f6d98-395d-4462-b5e4-b0364a4a8ec1`, `-AllowSameDiskBackup`.
- Без `-Apply` (11:04:23-11:05:00): `VERIFIED: candidate runtime, CI, predecessor schema029 runtime,
  stopped writers and schema029 backup; no persistent change.`
- С `-Apply` (11:05:10-11:12:04): привязки переключены и службы кандидата запущены в 11:11:43-11:11:46,
  затем оператор завершился `Unrelated service changed.` (строка 134, `Assert-RuntimeNeighbor`):
  в 11:11:50 `PickChickSyncTunnel` неожиданно завершился и был перезапущен своей службой (11:11:55).
  Оператор прощает перезапуск только `PickChickFulfillmentTunnel`. `completed.json` в
  `EdgeTools\runtime-app-029-da9f612` не записан (есть `inputs.json`, `original-0..4.xml`).
- По runbook («после первого запуска кандидата - разбираться вперёд») запущен KitchenLAN, задача копий
  включена (11:12:43). Окно 11:04:20-11:12:43 (+05), 06:04-06:12 UTC.
- Проверка: `/health/ready` 200 `{"ready":true,"degraded":false,…database up, schema up}`;
  `GET /edge/v1/pos/branch-orders` без сессии 401; все десять служб Running; Edge и четыре воркера из
  `C:\Program Files\PickChick\Edge\edge-da9f612\app`.

Следствие: у каталога `runtime-app-029-da9f612` нет `completed.json`, поэтому следующий запуск
`update-runtime-app-029.ps1` с `-PredecessorCommit da9f6125…` его, вероятно, не примет. Перед
следующим окном нужно решить, как записать предшественника (или научить оператор прощать перезапуск
`PickChickSyncTunnel` так же, как `PickChickFulfillmentTunnel`).

Отзыв (если понадобится): тот же оператор из `infra\windows` `e34051ec`
(`EdgeTools\incoming-app-029-e34051e`) - но он тоже требует `completed.json` предшественника; см. выше.

## Webkassa на точке

- `node scripts/webkassa-account-from-env.mjs` на Mac: `host devkkm.webkassa.kz`, `cashbox SWK00036966`.
  Файл передан в новую папку `EdgeTools\incoming-webkassa-1126` (Администраторы и SYSTEM) вместе с
  `infra\windows` из `da9f6125` (`enable-webkassa-edge.ps1` SHA-256 `72a53ab1…f68f`).
- `edge.env` до: SHA-256 `ee59ae58b3c85d0109cab9c342efcca8d31298abac453f4f4672fbd3f3611c32`.
- План (11:13:30): `mode Enable`, `account {host devkkm.webkassa.kz, cashbox SWK00036966}`,
  `env_after_sha256 9b5f20ac…078c`, перезапуск KitchenLink и Edge.
- `-Apply` (11:13:40-11:13:41): `Webkassa activation did not complete; inspect the retained attempt`.
  Причина: `Invoke-WebkassaEdgeRestart` допускает у `PickChickEdge` только зависимую службу
  `PickChickKitchenLink`, а на этой кассе от Edge зависят ещё `PickChickPosSync` и `PickChickKitchenLAN`
  (обе Running) - `Unreviewed Edge dependent; no service stopped.` Ни одна служба не остановлена.
- Итог: `edge.env` прежний (`ee59ae58…1c32`), Edge ready 200, маршрут
  `pos/fiscal-receipts/…/webkassa` 404 (Webkassa выключена, касса - ручной чек). Попытка
  `EdgeTools\webkassa-d9280b4a896d4e92823031b69a8759e2` (`before.env`, `intent.json`, `failed.json`
  с `rollback_verified=false`: откат тоже упёрся в ту же проверку, но менять было нечего).
- Оператор уже положил файл учётной записи в `C:\ProgramData\PickChick\Edge\config\webkassa.json`
  (защищённый ACL, чтение службой). Повторный запуск откажет («An account file is already in place»):
  файл удаляют вручную после исправления оператора. Промежуточные копии (`incoming-webkassa-1126\webkassa.json`
  и копия на Mac) удалены.

Что нужно: исправить `enable-webkassa-edge.ps1` - останавливать и запускать вместе с Edge также
`PickChickPosSync` и `PickChickKitchenLAN` (или принимать их как известных зависимых), тест PS 5.1,
CI; затем удалить `Edge\config\webkassa.json` и повторить план и `-Apply`.
