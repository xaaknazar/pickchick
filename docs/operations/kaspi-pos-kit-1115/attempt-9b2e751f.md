# Пакет Kaspi Smart POS, 15.11.2026

## Статус

STOP по условию владельца: при ошибке CI сообщить запуск и имя проверки.
Готовый kaspi-pos-kit-1115 не собран, размер и SHA-256 установочного ZIP отсутствуют.

`codex/kaspi-pos-1115` обновлена без force до
`9b2e751fca7d8efcd0ed4b15180aea410056d71a`; удалённый SHA совпадает.
Исходный коммит не менялся. Лента обновлений, облако и касса не менялись.

- [Foundation CI 43733904023](https://github.com/xaaknazar/pickchick/actions/runs/43733904023):
  обязательное задание `Foundation static checks and transaction invariants` упало.
  Остальные задания на момент снимка частично ещё выполнялись; полного PASS нет.
- [Windows POS CI 43733907474](https://github.com/xaaknazar/pickchick/actions/runs/43733907474):
  completed/success, все 3 задания PASS на точном SHA.
  Workflow запущен явно с `apply=idle`: изменение только `.gitattributes`
  не входит в фильтр путей автоматического запуска Windows POS.

[Снимок CI](ci-9b2e751f.json). Это журнал остановки, не разрешение установки.
История: [982f6e2f](attempt-982f6e2f.md), [2f15560e](attempt-2f15560e.md),
[f57edaf4](attempt-f57edaf4.md).

## Причина остановки

[Задание 132872295252](https://github.com/xaaknazar/pickchick/actions/runs/43733904023/job/132872295252),
шаг `Build and static checks`, команда `prettier --check .`.

Ошибка не относится к тесту Kaspi. Prettier требует пустую строку в
`docs/operations/stage2-windows-1030/head-runtime-029.md`: после абзаца
`Он сам запускает ... и три воркера.` и перед пунктом 6.
Проверка этого одного файла локально воспроизвела отказ с exit 1.
Сравнение результата форматирования с исходником показало только эту пустую строку.
Файл исходной ветки не редактировался.

Следующий шаг для автора PR: исправить форматирование, опубликовать новый SHA
и повторить Foundation и Windows POS на нём. Проверку не отключать;
успех Windows на старом SHA не заменяет проверку нового кандидата.

## Что прошло на Windows

- `Package installed Windows x64 POS`: PASS, установщик POS 0.5.4 собран CI.
- `Installed POS updates itself from a feed`: PASS на стенде CI.
- `Native release guards on Windows PowerShell 5.1`: PASS.
- `test_windows_head_029_runtime_release.py`: 7 тестов, OK, включая
  `KaspiHeadRuntimeGuards.test_ledger_pins_match_the_kaspi_tool`.

Правило LF для миграций устранило прежний отказ сверки хеша 029.
Это подтверждение стенда CI, не установки или оплаты на рабочей кассе.
Установочный набор при красной Foundation CI не создавался.

## PredecessorCommit и будущий COMMANDS.md

Владелец явно разрешил оставить `<sha рантайма 028>` в `-PredecessorCommit`.
Claude подставит полный `sourceCommit` из фактического
`C:\ProgramData\PickChick\EdgeTools\runtime-head-028-*\completed.json` на кассе.
Не подставлять плановый SHA без чтения этого документа; его поле
`predecessorCommit` относится к более старому рантайму.
Неверный предшественник отклоняется оператором. Дополнительный ответ владельца
об установленном SHA для подготовки инструкции не требуется.

После зелёных CI точного кандидата комплект будет содержать runtime ZIP,
его SHA-256, полное CI-подтверждение, POS 0.5.4, закреплённые инструменты
и COMMANDS.md по `head-runtime-029.md`.

Инструкция сохраняет этот порядок и условия:

1. Проверка SHA и CI до обслуживания; кандидат только в защищённом staging,
   конечный каталог `Edge\edge-<7 знаков>` заранее не создавать.
2. Новый backup-tool с сохранением destination, retention, maxAgeMinutes и
   reportInHeartbeat; свежая проверенная schema028-копия в `E:\PickChickBackups`.
3. Приостановленная задача копий, завершённая текущая копия, остановленные
   edge-службы; PostgreSQL и туннель продолжают работать.
4. Миграция 029: inspect, затем apply из кандидата; после Node проверяется
   LASTEXITCODE. Проверки CI и копии выполняются до DB-фазы.
5. Повторный backup Install, свежая schema029-копия; проверяются не только
   завершение команды, но и lastTaskResult, health.state, stale, schema,
   lastSuccessAt. Расписание снова приостановлено до конца окна.
6. Оператор029 без `-Apply`, затем с ним; сохранены проверки соседей, архива,
   предшественника, XML и свежей копии. Никакого обхода защит.
7. Возврат KitchenLAN и задачи копий, отдельно установка POS и привязка
   терминала. Не добавлять автоматический запуск служб или восстановление БД
   в обработчик неизвестного исхода.

Все будущие действия на устройстве выполняет Claude. Секреты, owner env и
identity в комплект не включаются. Готовность оплаты на физическом терминале
проверяется отдельно владельцем и Claude.
