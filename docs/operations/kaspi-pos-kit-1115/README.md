# Пакет Kaspi Smart POS, HTTP-привязка, 16.11.2026

## Статус

`codex/kaspi-pos-1115` перемотана без force на
`8290c87f7e1cf3262d59c7014aec25ed0eb97a3c` из `claude/project-thread-ej7z1n`.
Готов новый набор с HTTP-привязкой терминала по ADR-0017 п. 11.
Код кандидата при подготовке не менялся; PR378 не сливался.

- [Foundation43815847968](https://github.com/xaaknazar/pickchick/actions/runs/43815847968):
  success, 11/11.
- [Windows POS43815851233](https://github.com/xaaknazar/pickchick/actions/runs/43815851233):
  success, 3/3, `apply=idle`.
- Семь тестов `test_windows_head_029_runtime_release.py` прошли на Windows
  PowerShell5.1, включая `KaspiHeadRuntimeGuards.test_ledger_pins_match_the_kaspi_tool`.
- В Foundation прошли новые тесты HTTP probe, отказа HTTPS-связи от автоматического
  перехода на HTTP, TLS probe и взаимоисключающих аргументов регистрации.

[Снимок CI](ci-8290c87f.json), [аудит исходника](source-audit-8290c87f.json).
Миграции001-029 и закрепления операторов не менялись. Первые28 миграций побайтно
равны подтверждённому владельцем установленному `dec8b48c`.

## Скачать

[Предварительный выпуск GitHub](https://github.com/xaaknazar/pickchick/releases/tag/kaspi-pos-kit-1115-8290c87f)
с тегом, указывающим точно на `8290c87f7e1cf3262d59c7014aec25ed0eb97a3c`.
Это отдельный pre-release, не Latest; существующие выпуски не менялись.

[Архив kaspi-pos-kit-1115-8290c87f.zip](https://github.com/xaaknazar/pickchick/releases/download/kaspi-pos-kit-1115-8290c87f/kaspi-pos-kit-1115-8290c87f.zip),
[файл SHA-256](https://github.com/xaaknazar/pickchick/releases/download/kaspi-pos-kit-1115-8290c87f/kaspi-pos-kit-1115-8290c87f.zip.sha256).

- Размер архива: `180145417` байт.
- SHA-256: `3e61398d39563598b184e265f4a094a5d09bacbeef50ddb671550a434e4e2a4f`.
- GitHub release ID: `446698042`.
- Внутри: рантайм, POS0.5.4, оператор029 с помощниками, edge-backup, полные CI
  run/jobs, COMMANDS.md, packages.json и SHA256SUMS.txt.

| Файл внутри набора                    |      Байт | SHA-256                                                          |
| ------------------------------------- | --------: | ---------------------------------------------------------------- |
| runtime-8290c87f.zip                  |   8961648 | 45f06480ad9fdc04175630dae4801062209172b7decec7ad82507ee7e21e6f10 |
| pos/PickChick-POS-Setup-0.5.4-x64.exe | 172282433 | adc64c48b08d1d947da9c2ccb95af8974b14ef1635fa33864b3dba9899613e82 |

Установщик получен из exact-source Windows-артефакта `14202865012`, ZIP digest
`162706daca384f07d5b10cfb447f4ccc32f082b687ac1250ff8c2eac66b91383`.
Размер и сумма установщика совпадают с verification.json и CI-SHA256SUMS.txt.

Локальная копия:

```text
/Users/xaknazar/Claude/PickChick-exchange/kaspi-pos-kit-1115/8290c87f/kaspi-pos-kit-1115-8290c87f.zip
```

Рядом - `.zip.sha256` и распакованный `kit/`.
[Запись доставки](delivery-8290c87f.json) содержит контрольные суммы всех файлов.

## Проверки и установка

В рантайме8134 файла, 135 размещений пакетов, 245 связей зависимостей.
Пути, полный manifest, LF и SHA всех29 миграций, точные помощники проверены;
symlinks и native addons отсутствуют. Внешний архив перечитан; все28 файлов
сверены после копирования. Значения GitHub asset digest совпали с локальными.
Полное скачивание опубликованного ZIP без авторизации: HTTP200, 180145417байт,
SHA-256 совпал. Публичный файл .sha256 также совпал с локальным.
Проверено отсутствие секретных файлов, owner env, identity, приватных ключей
и токенов GitHub в текстовых файлах и рантайме. Секреты в публикацию не включены.

Восемь PowerShell-блоков [COMMANDS.md](COMMANDS.md) прошли локальную проверку
синтаксиса без выполнения установочных команд. Положительные и отрицательные
примеры свежести backup прошли. Это не проверка самих команд на настоящей кассе.

`-PredecessorCommit dec8b48cd899fe015baee17a3853affbe7eee774` уже задан по
подтверждению владельца. Инструкция и оператор сверяют completed.json, файлы
установленного028 и XML перед изменениями; при несовпадении останавливаются.

Порядок прежний: backup028, остановленные writers и maintenance lease,
DB029 inspect/apply, backup029, runtime verify/apply, включение backup, POS.
Привязка - отдельным действием после успешного рантайма:

```text
probe --host 192.168.2.236
register --terminal <terminalId кассы> --host 192.168.2.236 --transport http
```

Между ними проверяются `transport: http`, данные физического терминала и
отсутствие прежней привязки. terminalId берётся из config.json кассы, не из
серийного номера или terminal id Kaspi. HTTP выбран владельцем по ADR-0017 п. 11;
существующие HTTPS-связи автоматически не переключаются.

Устанавливает Claude. Облако, касса, рабочая лента обновлений, реальные оплаты
и привязки при подготовке не менялись. Физическая приёмка остаётся на точке.
Общий статус, roadmap и онлайн-пульт этой узкой задачей не обновлялись.

Предыдущий готовый набор сохранён: [35efd72c](release-35efd72c.md).
История отказов CI: [e92e6ba6](attempt-e92e6ba6.md),
[9b2e751f](attempt-9b2e751f.md), [f57edaf4](attempt-f57edaf4.md),
[2f15560e](attempt-2f15560e.md), [982f6e2f](attempt-982f6e2f.md).
