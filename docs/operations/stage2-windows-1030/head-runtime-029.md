# Kaspi Smart POS: рантайм 029 после рантайма 028 (ADR-0017)

`infra/windows/update-runtime-head-029.ps1` переключает четыре native-службы
(`PickChickEdge`, `PickChickFulfillmentWorker`, `PickChickMenuSyncWorker`,
`PickChickDeviceAccessWorker`) с рантайма, который поставил оператор
`update-runtime-head-028.ps1`, на рантайм с адаптером Kaspi Smart POS. Оператор 028
принимает архив ровно с 28 миграциями и не годится для 029. По умолчанию выполняется
проверка; изменения требуют `-Apply`. Оператор устроен как оператор 028 (те же
закреплённые помощники, проверки соседних служб, туннеля и отката); отличаются только
предшественник, число миграций и схема копии. На рабочей кассе он ещё не запускался.

## Порядок окна

Все команды на кассе, в PowerShell администратора, из распакованного набора Codex
(архив рантайма, его SHA-256, CI-подтверждение, `COMMANDS.md`). Пароли, identity и токены
терминала в чат не попадают.

1. Новый инструмент копий этого релиза (`install-edge-backup.ps1 -Mode Install`, с
   `-AllowSameDisk`, решение владельца 14.11): он знает журнал 001-029. Свежая
   проверенная копия `schema028` в `E:\PickChickBackups`.
2. Приостановить копии по расписанию и остановить все службы кассы: `PickChickEdge`,
   `PickChickFulfillmentWorker`, `PickChickMenuSyncWorker`, `PickChickDeviceAccessWorker`,
   `PickChickKitchenLink`, `PickChickKitchenLAN` (если установлена). `PickChickPostgres` и
   `PickChickFulfillmentTunnel` продолжают работать.
3. 029: `node --env-file=<owner.env> infra/windows/kaspi-pos-upgrade-db.mjs inspect <toolsRoot> <appRoot> <branchId>`,
   затем то же с `apply`. `<appRoot>` - распакованный рантайм кандидата (в нём
   `db/edge/migrations` и `infra/windows/native-edge-backup-ledger.json`), `<toolsRoot>` -
   как у прежних инструментов 026-028. Повторный `apply` отказывается.
4. Повторный `Install` инструмента копий: `health.schema = schema029`; задача снова
   приостановлена до конца окна.
5. Этот оператор: сначала без `-Apply` (`VERIFIED: …`), затем с `-Apply` (`READY: …`):

   ```powershell
   .\update-runtime-head-029.ps1 -SourceCommit <sha кандидата> -RuntimeArchive <архив> `
     -RuntimeSha256 <sha256 архива> -CiProof <CI кандидата> -BranchId 7a6f6d98-395d-4462-b5e4-b0364a4a8ec1 `
     -PredecessorCommit <sha рантайма 028> -AllowSameDiskBackup
   ```

   Он сам запускает `PickChickEdge`, `PickChickKitchenLink` и три воркера.

6. Запустить `PickChickKitchenLAN` (если есть) и включить задачу копий.
7. Только после этого привязка терминала: `scripts/kaspi-terminal-setup.mjs probe`, затем
   `register` (ADR-0017, «Порядок включения на точке»), первая оплата 100 ₸.

## Входы

- `-SourceCommit`, `-RuntimeArchive`, `-RuntimeSha256`: архив
  (`scripts/build-windows-edge-runtime.py`) и его точный исходник.
- `-CiProof`: полная успешная Foundation CI точного `-SourceCommit` в формате `run`/`jobs`.
- `-BranchId`: фактическая точка.
- `-PredecessorCommit`: исходник рантайма, который поставил оператор 028. Его каталог
  состояния `EdgeTools\runtime-head-028-<7 знаков>` должен содержать `completed.json`
  (schema 28) и `original-0..3.xml`.

SQL не выполняется, конфигурации, identity, флаги, меню, привязки терминалов и
POS-приложение не меняются.

## Что проверяется до изменений

- архив: полный manifest, SHA каждого файла, ровно 29 миграций подряд; 001-028 по байтам
  равны установленному рантайму 028, а весь журнал равен первым 29 строкам закреплённого
  `native-edge-backup-ledger.json` (строка 028 - `684ffa9c…`, строка 029 - `edf0f0cb…`);
- база: журнал миграций ровно 001-029 (то есть шаг 3 выполнен), кластер и точка прежние;
- XML служб ровно такие, какими их записал оператор 028 из своих `original-<i>.xml`;
- службы кассы остановлены, POS-sync не установлен, PostgreSQL и туннель работают;
- свежая (не старше двух часов) зашифрованная копия `schema029`, место копий не на C
  (с `-AllowSameDiskBackup` - другой раздел того же диска);
- закрепления помощников и инструмента копий по SHA-256.

## Отказы и откат

- Существующий каталог `Edge\edge-<7 знаков>` или `EdgeTools\runtime-head-029-<7 знаков>`
  запрещает повтор: сохранить каталог и разобрать состояние.
- При отказе замены XML возвращаются привязки 028, службы остаются остановленными.
  Тогда база уже schema029, а работа рантайма 028 на ней не проверялась: восстановить копию
  `schema028` из шага 1 по runbook копий и запустить службы 028, либо исправить причину и
  повторить оператор с новым кандидатом.
- После запуска служб старые бинарники автоматически не возвращаются.

Проверки: `tests/operations/test_windows_head_029_runtime_release.py` (функции отказов на
Windows PowerShell 5.1 в `windows-pos.yml`, SCM и SQL подменены).
