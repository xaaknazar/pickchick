# Сервер точки da9f612 и ключ Webkassa на тестовой кассе 26.11.2026

## Статус

- Сервер точки: DEPLOYED, но оператор не записал `READY`. Edge и четыре воркера тестовой кассы
  (192.168.2.66) работают из рантайма `da9f61251b7076a52e619ecf127a3309ff4f362a` (Webkassa, касса 0.6.0;
  внутри установленный ранее `e34051ec`). Схема 029 не менялась.
- Webkassa на точке: ВКЛЮЧЕНА 26.11 в 11:34:48 (+05) оператором из `e6dbe59b` (третья попытка, см.
  конец записи); первые две (`da9f6125`, `81ece158`) отказали, `edge.env` оба раза остался прежним.

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

## Повтор с исправленным оператором 81ece158 (26.11, 11:27 +05)

Оператор `81ece158477d7bda963fd8382c20c42fd0d87b40` (`codex/webkassa-1125`): останавливает вместе с
Edge также PosSync и KitchenLAN и переиспользует уже положенный `Edge\config\webkassa.json`.
[Windows POS package 45767569481](https://github.com/xaaknazar/pickchick/actions/runs/45767569481)
(включая guards PS 5.1) - success. `infra\windows` из `81ece158` в новой папке
`EdgeTools\incoming-webkassa-1126b` (Администраторы и SYSTEM), `enable-webkassa-edge.ps1` SHA-256
`f657ad26dc7e7cd1656bc933046ee7ec55d50e3be2a8648a78484ca2686c2858` совпал с коммитом.

- План (11:27:20, без `-AccountFile`): `account {host devkkm.webkassa.kz, cashbox SWK00036966,
reused_file true}`, `env_before ee59ae58…1c32`, `env_after 9b5f20ac…078c`, перезапуск PosSync,
  KitchenLAN, KitchenLink, Edge.
- `-Apply` (11:27:31-11:27:39): `Webkassa activation did not complete`. Службы остановлены и снова
  запущены (Edge 11:27:37, KitchenLink и KitchenLAN 11:27:38, PosSync 11:27:39), `edge.env` записан
  в 11:27:37 и вернулся к `ee59ae58…1c32`. Попытка `EdgeTools\webkassa-abfcb6a96e384abab97e67214309a34d`
  (`failed.json`: `rollback_verified=false`).
- Итог: Edge ready 200, все десять служб Running, маршрут webkassa 404 (ключа нет), касса - ручной чек.

Причина (по коду): `Write-WebkassaEnvCas` после `[IO.File]::Replace` проверяет `Assert-Acl $Path
-ServiceRead` без `-Foundation -InheritedAllowed`. `ReplaceFile` оставляет у `edge.env` прежний ACL -
унаследованный, с записью `Админ` FullControl, - и проверка падает («Protected ACL required»), хотя
байты уже заменены. Откат пишет прежние байты тем же путём и падает на той же проверке, поэтому
`rollback_verified=false`, но содержимое восстановлено. Исправление: в строке 82 проверять как в
строке 76 (`Assert-Acl $Path -Foundation -ServiceRead -InheritedAllowed`), тест PS 5.1 с
унаследованным ACL у `edge.env`, затем повторить план и `-Apply` (файл учётной записи на месте).

## Включено оператором e6dbe59b (26.11, 11:34 +05)

`e6dbe59b4f25f33f07aae08672e4e0feb4b6a182` (`codex/webkassa-1125`) меняет только проверку после
`Replace` на `Assert-Acl $Path -Foundation -ServiceRead -InheritedAllowed` (+ статический тест).
[Windows POS package 45768501497](https://github.com/xaaknazar/pickchick/actions/runs/45768501497) -
success. `infra\windows` из `e6dbe59b` в `EdgeTools\incoming-webkassa-1126c` (Администраторы и SYSTEM),
`enable-webkassa-edge.ps1` SHA-256 `fb3827551b5dd1f24bce8c8ed57fe2ed7464238fa108e5039aac7470a858d7ff`
совпал с коммитом.

- План (11:34:18): `reused_file true`, `devkkm.webkassa.kz`, `SWK00036966`, `env_before ee59ae58…1c32`,
  `env_after 9b5f20ac…078c`.
- `-Apply` (11:34:30-11:34:48): `pickchick-webkassa-edge-ready-v1`, `env_after_sha256
9b5f20ac7a24dff60003fcf0b6e5ccf668d4ded2b9b17f858a8716d50f97078c`, `completed_epoch 1795674888`.
  Попытка `EdgeTools\webkassa-b878de3b868d4af2b77738a84e176b17` (`before.env`, `intent.json`,
  `verified.json`).
- Проверка: `/health/ready` 200; все десять служб Running; задача копий Ready;
  `GET /edge/v1/pos/fiscal-receipts/00000000-0000-4000-8000-000000000000/webkassa` без сессии 401
  (маршрут включён).

Отключение: тот же оператор `-Mode Disable -ExpectedEdgeEnvSha256 9b5f20ac…078c` (сначала без
`-Apply`). Дальше: продажа на кассе 0.6.0 - чек Webkassa печатается автоматически с QR.
