# Оплата терминалом при закрытом приёме и снятие оплаты без заказа: схема 030 и рантайм 030 (аудит 28.11 P0-1)

Этап 2 из трёх (этап 1 - миграция и серверный код, этап 3 - касса). Состав окна: миграция
`db/edge/migrations/030_edge_kaspi_pos_release.sql`, права рантайма на таблицу снятий и
переключение пяти служб на рантайм с серверной логикой этапа 1. Решения владельца 28.11.2026 и
что делает 030 - в `docs/collaboration/cutover-cr/pos-8.md`.

Два инструмента, оба по образцу прошлых окон:

- `infra/windows/kaspi-pos-release-upgrade-db.mjs` - база 029 -> 030, права рантайма на новую
  таблицу выдаются в той же транзакции (образец: `kaspi-pos-upgrade-db.mjs`);
- `infra/windows/update-runtime-head-030.ps1` - переключение служб `PickChickEdge`,
  `PickChickFulfillmentWorker`, `PickChickMenuSyncWorker`, `PickChickDeviceAccessWorker` и
  `PickChickPosSync` с рантайма схемы 029 на рантайм схемы 030. По умолчанию выполняется
  проверка; изменения требуют `-Apply`. Образец - `update-runtime-app-029.ps1`: именно он
  работает с пятью службами, включая `PickChickPosSync`, и применялся на кассе 23.11 и 26.11
  (`docs/operations/edge-webkassa-da9f612-1126.md`: 26.11 его запуск переключил и запустил службы,
  но остановился на перезапуске `PickChickSyncTunnel` и не записал `completed.json`).
  `update-runtime-head-029.ps1` для этого окна не годится: он отказывает при установленной
  `PickChickPosSync`. Отличаются только предшественник, число миграций (30),
  схема копии (`schema030`), каталог состояния и закреплённые хэши. На рабочей кассе ни один из
  двух инструментов ещё не запускался; тесты оператора на Windows PowerShell 5.1 идут только в CI
  (`windows-pos.yml`).

SQL оператор служб не выполняет: 030 ставит инструмент базы с остановленными службами.

## Что нужно знать до окна

- Схема назад не откатывается. Бинарный откат возможен только до первого запуска служб на новом
  рантайме: при отказе замены XML оператор возвращает привязки 029, службы остаются остановленными.
  База тогда уже `schema030`; старый рантайм таблицу снятий не называет, но его работа на базе 030 на
  кассе не проверялась. Дальнейший путь: исправить причину и повторить оператор с новым кандидатом
  либо восстановить копию `schema029` из шага 1 по `edge-restore.md`. После запуска служб старые
  бинарники автоматически не возвращаются.
- Оплаченные на терминале попытки без заказа блокируют закрытие смены своей кассы после 030
  (`TERMINAL_UNSOLD_PAYMENTS`, pos-8.md, §4.1): их надо оформить продажей или снять по PIN
  начальника смены. Кнопка снятия появится на кассе только с этапом 3; до него касса 0.6.3 покажет
  при закрытии смены общую ошибку. Число и сумму таких попыток `inspect` показывает до окна (поле
  `unsoldPayments`, строка `WARNING:` в потоке ошибок). Это предупреждение, не отказ.
- Миграция берёт блокировки на все таблицы и пересоздаёт функции, которые вызывает каждая продажа,
  поэтому службы остановлены на весь шаг 3.

## Порядок окна

Все команды на кассе, в PowerShell администратора, из распакованного набора Codex (архив
рантайма, его SHA-256, CI-подтверждение, `COMMANDS.md`); оператор служб запускается из папки
`infra\windows` точного коммита кандидата (он читает рядом с собой закреплённые по SHA-256
помощники). Пароли, identity и токены в чат не попадают.

0. Только чтение, до окна: запрос из pos-8.md §4.1 к базе точки
   (`SELECT count(*), sum(amount_minor) FROM kaspi_pos_attempts WHERE state='success' AND order_id IS NULL`).
   Инструмент шага 3 даёт то же число сам, но только в окне: при работающих службах он
   отказывается. Если оплаты без заказа есть, решить с владельцем, что с ними делать (оформить
   продажей или снять по PIN начальника смены, когда появится кнопка этапа 3).
1. Новый инструмент копий этого релиза (`install-edge-backup.ps1 -Mode Install`, с `-AllowSameDisk`,
   решение владельца 14.11): он знает журнал 001-030. Свежая проверенная копия `schema029` в
   `E:\PickChickBackups`.
2. Приостановить копии по расписанию и остановить: `PickChickPosSync`, `PickChickFulfillmentWorker`,
   `PickChickMenuSyncWorker`, `PickChickDeviceAccessWorker`, `PickChickKitchenLink`,
   `PickChickKitchenLAN` (если установлена), `PickChickEdge`, затем `PickChickSyncTunnel`.
   `PickChickPostgres` и `PickChickFulfillmentTunnel` продолжают работать. Туннель синхронизации
   нужен только `PickChickPosSync`; оператор запускает `PickChickPosSync` последним, и Windows
   поднимает туннель вместе с ним.
3. 030: `node --env-file=<owner.env> infra/windows/kaspi-pos-release-upgrade-db.mjs inspect <toolsRoot> <appRoot> <branchId>`,
   затем то же с `apply`. `<appRoot>` - распакованный рантайм кандидата (в нём `db/edge/migrations`
   и `infra/windows/native-edge-backup-ledger.json`), `<toolsRoot>` - как у прежних инструментов
   026-029. `apply` ставит 030, выдаёт рантайму `SELECT, INSERT` на `kaspi_pos_attempt_releases` и
   доказывает права 030 и заново права 029. Повторный `apply` отказывается («already applied»);
   `inspect` на обновлённой базе отвечает `alreadyInstalled: true`.
4. Повторный `Install` инструмента копий: `health.schema = schema030`; задача снова приостановлена до
   конца окна.
5. Оператор служб: сначала без `-Apply` (`VERIFIED: …`), затем с `-Apply` (`READY: …`):

   ```powershell
   .\update-runtime-head-030.ps1 -SourceCommit <sha кандидата> -RuntimeArchive <архив> `
     -RuntimeSha256 <sha256 архива> -CiProof <CI кандидата> -BranchId 7a6f6d98-395d-4462-b5e4-b0364a4a8ec1 `
     -PredecessorCommit <sha установленного рантайма 029> -AllowSameDiskBackup
   ```

   Он сам запускает `PickChickEdge`, `PickChickKitchenLink`, три воркера и последним
   `PickChickPosSync`.

6. Запустить `PickChickKitchenLAN` (если есть) и включить задачу копий.
7. Проверки после, только чтение: `/health/ready` на порту edge готов;
   `kaspi-pos-release-upgrade-db.mjs inspect` отвечает `alreadyInstalled: true` и
   `runtimeGrantsVerified: true`; `cashier-report-function-grants.mjs inspect` показывает
   `"schema":"schema030"` и `"ready":true` (EXECUTE на функции 030 не добавляет, см.
   `cashier-report-function-grants.md`); `install-edge-backup.ps1 -Mode Inspect` показывает
   `schema030`; после первой копии по расписанию - проверенная копия `schema030`.
8. Публикация кассы с кнопкой «Снять оплату» - этап 3, отдельным документом. Маршруты
   `release`, `terminal-releases` и `open?scope=other_desks` в профиль LAN-шлюза
   (`lan-route-profiles.mjs`) и в протокол оболочки кассы входят вместе, этапом 3.

## Входы оператора служб

- `-SourceCommit`, `-RuntimeArchive`, `-RuntimeSha256`: архив
  (`scripts/build-windows-edge-runtime.py`) и его точный исходник.
- `-CiProof`: полная успешная Foundation CI точного `-SourceCommit` в формате `run`/`jobs`.
- `-BranchId`: фактическая точка.
- `-PredecessorCommit`: исходник установленного рантайма схемы 029. Его каталог состояния
  (`EdgeTools\runtime-head-029-<7 знаков>` или `EdgeTools\runtime-app-029-<7 знаков>`, ровно один)
  содержит `completed.json` (schema 29, с `predecessorCommit`) и `original-0..3.xml`.
- `-AcceptInterruptedPredecessor`: как у `update-runtime-app-029.ps1`, только для предшественника,
  чей запуск `update-runtime-app-029.ps1` переключил и запустил службы, но не записал
  `completed.json` (читается его `inputs.json`; остальные проверки те же). По записи 26.11 это
  вероятный случай для рантайма `da9f612`: перед окном проверить, есть ли в
  `EdgeTools\runtime-app-029-<7 знаков>` предшественника `completed.json`.
- `-AllowSameDiskBackup`: решение владельца 14.11, как в прошлых окнах.

## Что проверяется до изменений

- архив: полный manifest, SHA каждого файла, ровно 30 миграций подряд; 001-029 по байтам равны
  установленным, а весь журнал равен первым 30 строкам закреплённого
  `native-edge-backup-ledger.json` (строка 029 - `edf0f0cb…`, строка 030 - `5dfc739e…`);
- база: журнал миграций ровно 001-030 (то есть шаг 3 выполнен), кластер и точка прежние;
- XML служб ровно такие, какими их записал предшественник (сохранённый оригинал с заменой только
  пути приложения), XML `PickChickPosSync` указывает на рантайм предшественника под LocalService;
  меняются только путь приложения и рабочая папка;
- все пишущие службы остановлены, PostgreSQL и туннель облака работают, конфигурации и identity
  неизменны до и после переключения;
- свежая (не старше двух часов) зашифрованная копия `schema030`, место копий не на C (с
  `-AllowSameDiskBackup` - другой раздел того же диска);
- закрепления помощников, журнала и инструмента копий по SHA-256.

Каталог состояния оператора: `EdgeTools\runtime-head-030-<7 знаков>` (`inputs.json`,
`original-0..4.xml`, `completed.json` со `schema` 30). Существующий каталог
`Edge\edge-<7 знаков>` или каталог состояния запрещает повтор: сохранить и разобрать состояние.

## Что дальше

Это окно ставит рантайм 030 один раз. Для следующих обновлений рантайма кассы без смены схемы
оператора `update-runtime-app-030.ps1` нет: `update-runtime-app-029.ps1` принимает ровно 29
миграций и предшественника схемы 029 и на базе 030 откажет. Следующему обновлению понадобится новый
оператор по образцу этого.

Проверки: `tests/operations/test_windows_head_030_runtime_release.py` (функции отказов на Windows
PowerShell 5.1 в `windows-pos.yml`, SCM и SQL подменены), `tests/integration/kaspi-pos-release-upgrade.test.mjs`,
`tests/integration/windows-cutover-upgrade.test.mjs`.
