# Параллельная Foundation CI

Последовательный foundation job разделён на пять независимых runner:
статические проверки и транзакции; POS/backoffice; мобильные bundles и checkout;
симуляторные browser regression; server account/Kaspi fixtures. Каждый runner
имеет собственный checkout, build, файловые exports и Docker databases. Тесты
внутри одного DB suite сохраняют последовательность. Все прежние suites
сохранены; остальные пять заданий workflow продолжают выполняться отдельно.

`Build, contracts and PostgreSQL integration` сохраняет имя обязательной
проверки и становится gate с `needs` на все пять suites. Gate запускается через
`always()` и принимает только пять `success`: failure, cancellation и skipped
закрывают выпуск. Новые проверки coverage запускаются существующим staging
unittest discovery. Полная зелёная CI остаётся условием выпуска.

Результирующий workflow имеет 11 jobs. Release validators со стандартной
проверкой допускают дополнительные successful jobs и проверяют весь список.
Исторические профили `exact_jobs=True` намеренно продолжат отклонять изменённый
набор: новый deployment через такой профиль требует отдельно проверенного
обновления профиля. Старые доказательства CI не переписываются.

Локально: `python3 -m unittest discover -s tests/operations -p test_ci_parallel.py`.
Длительность и успешность полного parallel run подтверждаются только GitHub CI;
локальная проверка конфигурации не означает измеренное ускорение.

Для короткого цикла разработки доступен read-only выбор проверок:
`node scripts/development-checks.mjs --base origin/codex/shared-development`
или список изменённых путей вместо `--base`. Команда только печатает план.
Для mobile-only изменений выбираются mobile build/typecheck/tests/export и
browser suites. Для документов - форматирование. Общие зависимости, смешанные
и неизвестные пути возвращают полный набор. Этот план не меняет обязательную CI
и не является автоматическим разрешением выпуска.

Push и pull_request triggers сохранены: push защищает рабочие ветки, PR -
изменения из fork и merge context перед main. Исключение одного trigger без
надёжного определения открытого PR оставило бы часть веток без проверки.
