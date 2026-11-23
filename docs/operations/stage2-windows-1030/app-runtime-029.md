# Обновление программы сервера точки на схеме 029 (без изменений базы)

`infra/windows/update-runtime-app-029.ps1` переключает службы сервера точки
(`PickChickEdge`, `PickChickFulfillmentWorker`, `PickChickMenuSyncWorker`,
`PickChickDeviceAccessWorker`, `PickChickPosSync`) с установленного рантайма схемы 029 на
проверенный новый рантайм с теми же 29 миграциями. Первый случай: 23.11.2026, маршрут
`GET pos/branch-orders` для экрана кассы «Заказы» (все заказы точки за день, период или месяц).

Предшественник: рантайм, который поставил оператор `update-runtime-head-029.ps1`
(`EdgeTools\runtime-head-029-<7 знаков>`), или прошлый запуск этого оператора
(`EdgeTools\runtime-app-029-<7 знаков>`). По умолчанию только проверка; изменения требуют
`-Apply`. SQL не выполняется: база остаётся схемой 029 байт в байт. Конфигурации, identity,
флаги, меню, привязки терминалов и приложение кассы не меняются.

## Порядок окна

Все команды на кассе, в PowerShell администратора (x64 Windows PowerShell 5.1), из папки
`infra\windows` точного коммита кандидата: оператор читает рядом с собой закреплённые по
SHA-256 помощники. Пароли, identity и токены в чат не попадают.

1. Свежая проверенная копия `schema029` не старше двух часов (задача
   `\PickChick\PickChickEdgeBackup` делает её каждый час; при сомнении запустить её
   вручную и дождаться результата 0).
2. Отключить задачу копий на время окна и остановить: `PickChickPosSync`,
   `PickChickFulfillmentWorker`, `PickChickMenuSyncWorker`, `PickChickDeviceAccessWorker`,
   `PickChickKitchenLink`, `PickChickKitchenLAN`, `PickChickEdge`. `PickChickPostgres`,
   `PickChickFulfillmentTunnel` и `PickChickSyncTunnel` продолжают работать.
3. Оператор: сначала без `-Apply` (`VERIFIED: …`), затем с `-Apply` (`READY: …`):

   ```powershell
   .\update-runtime-app-029.ps1 -SourceCommit <sha кандидата> -RuntimeArchive <архив> `
     -RuntimeSha256 <sha256 архива> -CiProof <CI кандидата> -BranchId 7a6f6d98-395d-4462-b5e4-b0364a4a8ec1 `
     -PredecessorCommit <sha установленного рантайма> -AllowSameDiskBackup
   ```

   Он сам запускает `PickChickEdge`, `PickChickKitchenLink`, три воркера и последним
   `PickChickPosSync`.

4. Запустить `PickChickKitchenLAN`, включить задачу копий.
5. Проверка: `http://127.0.0.1:<порт edge>/health/ready` готов; `GET /edge/v1/pos/branch-orders`
   без сессии отвечает 401 (маршрут есть); на кассе «Заказы» показывает заказы всех каналов;
   кухня принимает заказ.

Если проверка без `-Apply` отказала, ничего не изменено: снова запустить службы из шага 2 и
включить задачу копий.

## Входы

- `-SourceCommit`, `-RuntimeArchive`, `-RuntimeSha256`: архив
  (`scripts/build-windows-edge-runtime.py`) и его точный исходник.
- `-CiProof`: полная успешная Foundation CI точного `-SourceCommit` в формате `run`/`jobs`.
- `-BranchId`: фактическая точка.
- `-PredecessorCommit`: исходник установленного рантайма (на тестовой кассе 23.11:
  `8290c87f7e1cf3262d59c7014aec25ed0eb97a3c`). Его каталог состояния содержит
  `completed.json` (schema 29, с `predecessorCommit`) и `original-0..3.xml`.

## Что проверяется до изменений

- архив: полный manifest, SHA каждого файла, ровно 29 миграций подряд, каждая по байтам
  равна установленной; журнал базы равен закреплённому журналу 001-029;
- CI точного коммита, предшественник, кластер базы и точка;
- четыре XML служб равны тому, что записал предшественник (сохранённый оригинал с
  заменой только пути приложения), XML `PickChickPosSync` указывает на рантайм
  предшественника под LocalService; меняются только путь приложения и рабочая папка;
- все пишущие службы остановлены, `PickChickPostgres` и туннель работают, файлы конфигурации
  и identity неизменны до и после переключения;
- свежая копия `schema029`, диск копий (`-AllowSameDiskBackup`, решение владельца 14.11).

Неудачное переключение XML возвращает прежние привязки и оставляет службы остановленными
(после этого запустить их, как в шаге 2). После первого запуска кандидата прежние файлы не
возвращаются автоматически: разбираться вперёд.
