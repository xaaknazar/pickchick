# Недетерминированное ожидание farm PostgreSQL теста - 6 октября 2026

Основа: `e192f051f9ead17b45340158a51dfbf83007e403`.
CI показала правильную посадку tomato с 10800 секундами, тогда как тест гонки
carrot/tomato безусловно ожидал 45 секунд и одну tutorial посадку carrot.
Порядок захвата PostgreSQL row lock не гарантирует победу первого promise.

Изменён только `packages/farm-persistence/tests/postgres.test.mjs`:
единственный победитель и `STALE_STATE` проигравшего по-прежнему обязательны.
Проверки cropId, серверного plantedAt, growSeconds и tutorialPlantings теперь
соответствуют fulfilled команде. Два независимых клиента детерминированно
проверяют обе допустимые культуры и долговечное сохранение результата:
carrot - 45 секунд / tutorial 1; tomato - 10800 секунд / tutorial 0.

Root явно делегировал пересечение теста в своей прежней доступной задаче
`farm-progression-api`. Gameplay `packages/farm-game`, runtime, CI и политики
не изменялись. Файлы общей памяти, занятые вторым Mac, не перезаписывались.

Проверено: frozen install; сборка farm-persistence и её зависимостей; реальный
PostgreSQL 18 на изолированном localhost:55439, тест с отдельным schema прошёл
(гонка, обе культуры, replay, rollback, clock, isolation); ESLint и Prettier
теста, staged diff check. Временный PostgreSQL остановлен после проверки.
Полную CI запускает root на новом итоговом SHA; старую CI не перезапускали.
