# Пакет Kaspi Smart POS, 16.11.2026

## Статус

STOP по условию владельца при любом отказе CI. Готовый kaspi-pos-kit-1115 не собран.
Runtime ZIP и окончательный архив комплекта отсутствуют; их SHA-256 не заявляется.

Ветка `codex/kaspi-pos-1115` перемотана без force на
`e92e6ba6500a40e144ebbd9c8558266ee15678f1`. Исходник и тесты не менялись.
Лента обновлений, облако и касса не менялись.

- [Foundation43754144310](https://github.com/xaaknazar/pickchick/actions/runs/43754144310):
  completed/failure, 9 из 11 заданий прошли. Основное задание static/invariants
  упало на интеграционном тесте, итоговое задание CI повторило отказ.
- [Windows43754165344](https://github.com/xaaknazar/pickchick/actions/runs/43754165344):
  completed/success, все 3 задания PASS. Проверка 029 содержит 7 успешных тестов,
  включая `KaspiHeadRuntimeGuards.test_ledger_pins_match_the_kaspi_tool`.
  Самообновление POS на стенде тоже прошло. Workflow запущен явно с `apply=idle`:
  изменение руководства не входит в автоматический фильтр путей Windows.

[Снимок CI](ci-e92e6ba6.json), [аудит исходника](source-audit-e92e6ba6.json).

## Упавшая проверка

[Задание132934432961](https://github.com/xaaknazar/pickchick/actions/runs/43754144310/job/132934432961),
шаг `Test PostgreSQL constraints and HTTP failure scenarios`.

Тест:
`roster -> staff-roster-apply -> staff-pin-batch: plan, hash, roles never changed in place, PINs never printed`.

Файл `tests/integration/backoffice-p1-staff-roster.test.mjs`: объявление строка74,
отказ строки263, `AssertionError: a PIN is never shown or logged`.

В журнале отказа показано событие `staff_session_saved` с полями event, staff_id,
role, expires_at, file. Регулярное выражение проверяет всю строку и совпало с
подстрокой случайного UUID в staff_id и именем файла, содержащим этот UUID.
Отдельного поля PIN в этом событии нет. Это ложное срабатывание проверки подстроки
на синтетических идентификаторах; значения идентификаторов и PIN сюда не копируются.

Исправление должен подготовить автор: исключить случайные совпадения в структурных
идентификаторах, сохранив проверку отсутствия PIN в выводе. Повтор ради зелёного
результата не запускался. Нужны новый SHA и обе полные зелёные CI на нём.

## Подготовленные материалы

- Исправления LF и форматирования руководства проверены. Первые 28 миграций
  побайтно равны исходнику `dec8b48cd899fe015baee17a3853affbe7eee774`, все 29
  контрольных сумм совпадают с ledger, закрепления помощников и backup-tool верны.
- Владелец прямо указал `-PredecessorCommit dec8b48cd899fe015baee17a3853affbe7eee774`.
  Подтверждение на кассе остаётся проверкой оператора по completed.json и файлам.
- Получен артефакт Windows14177089255; SHA-256 всего ZIP сверён с GitHub.
  Внутри POS0.5.4: `PickChick-POS-Setup-0.5.4-x64.exe`, 172282435байт,
  SHA-256 `f8db17227245fa2457d08fb970130570fc7f6b39873030c0ad67478b1ecf5f58`.
  verification.json подтверждает exact e92e6ba6 и чистый исходник. Этот установщик
  не означает готовый комплект и не был установлен или опубликован в ленте.
- [Черновик COMMANDS](COMMANDS.e92e6ba6.draft.md) сохранён для продолжения. Все8 блоков
  прошли локальный parse-only PowerShell7.7.0. Проверены варианты DateTime/ISO и
  отказы на старой/будущей копии, неверной схеме и неуспешной задаче. Это не
  Windows5.1/SCM-приёмка самих блоков и не проверка физического устройства.
- Инструкция сохраняет настройки копий, выполняет сверку XML/байтов установленного
  028 до DB-фазы, использует штатный maintenance lease, требует свежие schema028
  и schema029 и оставляет регистрацию терминала отдельным действием. Runtime hash
  остаётся незаполненным, поэтому черновик останавливается до изменений.

После исправления CI: новый exact-source runtime, proof обеих CI, установщик
того же SHA, проверенные инструменты, COMMANDS и SHA256SUMS. До этого не применять.
Секреты, owner env и identity в Git и будущий комплект не включаются.

История: [9b2e751f](attempt-9b2e751f.md), [f57edaf4](attempt-f57edaf4.md),
[2f15560e](attempt-2f15560e.md), [982f6e2f](attempt-982f6e2f.md).
