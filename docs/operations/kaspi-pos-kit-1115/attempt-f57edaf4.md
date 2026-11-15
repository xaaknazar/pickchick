# Пакет Kaspi Smart POS, 15.11.2026

## Статус

STOP по условию владельца: при ошибке CI сообщить запуск и имя теста.
Готовый комплект не собран, размер и SHA-256 установочного ZIP отсутствуют.

`codex/kaspi-pos-1115` обновлена без force до
`f57edaf4ae4c771db06ad63a6bfc6b736c2526e0`; удалённый SHA совпадает.
Код этого коммита не менялся. Лента обновлений, облако и касса не менялись.

- [Foundation CI 43733154037](https://github.com/xaaknazar/pickchick/actions/runs/43733154037)
  запущена на точном SHA; в момент снимка ещё выполняется.
- [Windows POS CI 43733153883](https://github.com/xaaknazar/pickchick/actions/runs/43733153883)
  запущена на том же SHA; обязательное задание Windows guards упало.
  Остальные задания в момент снимка ещё выполняются.

[Доказательство](ci-f57edaf4.json).
История: [982f6e2f](attempt-982f6e2f.md), [2f15560e](attempt-2f15560e.md).

## Упавший тест и причина

[Задание 132869857621](https://github.com/xaaknazar/pickchick/actions/runs/43733153883/job/132869857621):
`Native release guards on Windows PowerShell 5.1`.

Тест: `KaspiHeadRuntimeGuards.test_ledger_pins_match_the_kaspi_tool`,
`tests/operations/test_windows_head_029_runtime_release.py:181`.

- stage2: 3 PASS;
- queue-recovery025: 4 PASS;
- head-runtime028: 6 PASS;
- head-runtime029: 6 PASS, 1 FAIL;
- следующий набор edge-backup после отказа не запускался.

Тест считает SHA-256 фактических байтов
`db/edge/migrations/029_edge_kaspi_pos.sql` после Windows checkout.

- Закреплённый SHA-256 и хеш исходного Git blob с LF:
  `edf0f0cbce196dc6601c5bcb2d9457ac2d43e12a51916d52d5cd6824f5339784`.
- Фактический Windows SHA-256:
  `e74825a1084c34b081783fbe3c7cdbebb4752f3a5b9936edc3c1e92c444d7ccc`.

Локальный пересчёт исходного blob после единственного преобразования LF в CRLF
дал точно тот же `e74825…`. Для файла git attributes `text` и `eol` не заданы.
Причина несовпадения байтов подтверждена; это не изменение SQL-содержания в PR.

Следующее исправление должно закрепить канонические LF-байты миграций при Windows
checkout и упаковке, например правилом для `db/edge/migrations/*.sql` в
`.gitattributes`. Хеш проверенной миграции в ledger и операторе не заменять на CRLF-хеш,
проверку не отключать. После исправления нужны обе CI на новом точном SHA.

## Что теперь подготовлено в исходнике

Появился `update-runtime-head-029.ps1` и runbook
`docs/operations/stage2-windows-1030/head-runtime-029.md`.
Упаковщик включает четыре инструмента Kaspi и ledger; POS имеет версию0.5.4.
Семь локальных тестов упаковщика прошли. Установочный архив при красном CI не создавался.

## PredecessorCommit и будущий COMMANDS.md

План комплекта14.11 содержит runtime028
`dec8b48cd899fe015baee17a3853affbe7eee774`.
Это пока не доказательство фактической установки. Владелец запрошен о значении
`sourceCommit` из реального
`C:\ProgramData\PickChick\EdgeTools\runtime-head-028-*\completed.json`.
Без подтверждения конкретный SHA не объявляется установленным. На кассу для чтения
не подключались.

В COMMANDS.md нужен именно `sourceCommit` документа completed, а не его
`predecessorCommit`, который обозначает более старый runtime.
Сохраняются `original-0..3.xml`; оператор029 сверяет их с действующими привязками.

После зелёных CI инструкция будет следовать новому runbook:

1. Новый backup-tool и проверенная свежая schema028-копия в `E:\PickChickBackups`.
2. Приостановленная задача копий, завершённая текущая копия, остановленные edge-службы.
3. Распаковка кандидата в отдельный защищённый staging и inspect/apply029.
   Не создавать конечный `Edge\edge-f57edaf\app` заранее.
4. Повторный backup Install и подтверждённая свежая schema029-копия.
   Проверять не только выход команды, но и JSON health/lastTaskResult.
5. Оператор029 сначала без `-Apply`, затем с ним, с точным подтверждённым predecessor.
6. Возврат KitchenLAN и задачи копий, отдельно установка POS0.5.4 и привязка терминала.
7. После каждого Node-вызова проверять LASTEXITCODE; при неизвестном исходе остановиться.
   Восстановление старой базы не превращать в автоматический обработчик отказа.

Все будущие действия на устройстве выполняет Claude. Секреты в комплект не включаются.
