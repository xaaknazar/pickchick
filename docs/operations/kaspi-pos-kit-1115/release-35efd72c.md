# Пакет Kaspi Smart POS, 16.11.2026

## Статус

Готовый `kaspi-pos-kit-1115` собран и сохранён для установки Claude.
Ветка `codex/kaspi-pos-1115` перемотана без force на точный исходник
`35efd72ce470789466dd265814d0bcdf49182431` из `claude/project-thread-ej7z1n`.
Относительно e92e6ba6 изменён только тест сотрудников бэк-офиса; код кандидата
при подготовке не менялся. [Аудит исходника](source-audit-35efd72c.json).

- [Foundation 43761973367](https://github.com/xaaknazar/pickchick/actions/runs/43761973367):
  completed/success, 11/11 заданий.
- [Windows POS 43761995773](https://github.com/xaaknazar/pickchick/actions/runs/43761995773):
  completed/success, 3/3 заданий, `apply=idle`.
- Семь тестов `test_windows_head_029_runtime_release.py` прошли на Windows
  PowerShell 5.1, включая
  `KaspiHeadRuntimeGuards.test_ledger_pins_match_the_kaspi_tool`.
- Исправленный тест `backoffice-p1-staff-roster.test.mjs` прошёл в составе
  полного интеграционного набора. Самообновление POS на стенде прошло.

[Снимок CI](ci-35efd72c.json). Полные ответы GitHub run/jobs обеих CI включены
в набор. Windows workflow запущен явно, поскольку изменение теста бэк-офиса
не входит в его автоматический фильтр путей.

## Доставка

Архив на Mac:

```text
/Users/xaknazar/Claude/PickChick-exchange/kaspi-pos-kit-1115/kaspi-pos-kit-1115-35efd72c.zip
```

- Размер: `180142411` байт.
- SHA-256: `4043e009d17a755ab00644c616145e6dddd7f12b78426313b75ee79b60fd3c40`.
- Рядом находится файл `.zip.sha256`; распакованная проверенная копия - `kit/`.
- В `kit/SHA256SUMS.txt` перечислены контрольные суммы файлов,
  в `kit/packages.json` - размеры, исходник и состав.

| Файл внутри набора                    |      Байт | SHA-256                                                          |
| ------------------------------------- | --------: | ---------------------------------------------------------------- |
| runtime-35efd72c.zip                  |   8959421 | 6c407a9deb6ff9480d2b7bd94480f5708d51cfb6907019767e628673533719a3 |
| pos/PickChick-POS-Setup-0.5.4-x64.exe | 172282370 | f954c11fe3456005940684c32e97a0d7f081cc75cec62b358ab36c083850feca |

Установщик получен из артефакта GitHub `14180252776` этого Windows-запуска.
SHA-256 артефакта ZIP сверён с digest GitHub:
`c59b59ceda142e407ee9b4e07b84275763d70d1d0c45e81a4f9e3d0ccf7e2ee2`.
verification.json подтверждает чистый исходник exact 35efd72c, размер и SHA
установщика. [Полная запись доставки](delivery-35efd72c.json).

## Проверки набора

- Рантайм содержит 8134 файла, 135 размещений пакетов и 245 проверенных связей
  зависимостей; symlinks и native addons отсутствуют.
- Все 29 миграций имеют LF и совпадают с закреплённым ledger по SHA-256.
  Административные инструменты 029, новый edge-backup и terminal setup взяты
  побайтно из exact source. Закрепления PowerShell-помощников проверены.
- Внешний ZIP перечитан; все 28 доставленных файлов совпали с исходными байтами.
  После копирования в папку обмена вновь проверены ZIP и SHA256SUMS.txt.
- Проверены пути архива, отсутствие файлов секретов, owner env и identity,
  сигнатур приватных ключей и токенов GitHub.
- Восемь блоков [COMMANDS.md](COMMANDS.35efd72c.md) прошли локальный parse-only
  PowerShell 7.7.0. Функция свежести backup проверена на положительных
  DateTime/ISO примерах и отказах при старой/будущей копии, неверной схеме,
  stale health и неуспешной задаче. Установочные команды не исполнялись.

## Дальше

Claude устанавливает по [COMMANDS.md](COMMANDS.35efd72c.md) и исходному
[runbook 029](../stage2-windows-1030/head-runtime-029.md).
`-PredecessorCommit` оставлен как `<sha рантайма 028>` по последнему решению
владельца. Его нужно получить из `sourceCommit` установленного
`EdgeTools\runtime-head-028-*\completed.json` и подставить только в исполняемую
копию блока вне набора. Доставленные файлы не редактировать: их байты защищены
SHA256SUMS. Незаполненный placeholder останавливает команды до изменений.

Порядок: свежая backup028, остановка writers и штатный maintenance lease,
DB029 inspect/apply, свежая backup029, runtime verify/apply, включение backup,
POS 0.5.4 и отдельная привязка терминала. Оператор повторно проверяет
установленный predecessor и сохраняет защиты соседних служб.

Фактическая установка, работа на физическом терминале и реальная оплата
не проверялись. Лента обновлений, облако и касса не менялись. Секретов в наборе
и Git нет. Общий статус, roadmap и онлайн-пульт в этой узкой задаче не менялись;
протокол сохранён в собственной ветке документов.

История неудачных кандидатов:
[e92e6ba6](attempt-e92e6ba6.md), [9b2e751f](attempt-9b2e751f.md),
[f57edaf4](attempt-f57edaf4.md), [2f15560e](attempt-2f15560e.md),
[982f6e2f](attempt-982f6e2f.md). Старый `COMMANDS.e92e6ba6.draft.md` является
только историческим черновиком, для установки не использовать.
