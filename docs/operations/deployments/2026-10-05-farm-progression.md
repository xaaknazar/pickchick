# PICK FARM protocol 2 - подготовка API для TestFlight 12

5 октября 2026 проверен установленный baseline:

- API `14bbd28d25975bfa0d888a1bf5f3d733ff679434`.
- Public pointer `331d663a1002fb180334f6e8206afa7e8b553067`.
- Gateway SHA-256 `1df3d12b60e829081bc90b77256cfc5a84b30064cabe8039cae519a41465ed51`.
- API compose SHA-256 `c62c24cb90418e791b9740352ffcafe4c664a1669887914d79dfea96dbbc5db2`.
- Public manifest base source `e236824b80ee315eae48c371d722f4f6459aac8c`.

`release-farm-update.py` закреплён на этих версиях. До установки требуется
полностью зелёная CI всех 11 jobs для точного опубликованного SHA.
Инструмент сохраняет immutable API image, owned maintenance/deployment lock,
CAS указателя, проверку всех 38 миграций, ACL, данных, runtime flags,
публичных файлов, кухни и банковского worker. Во время apply проверяет
зашифрованную копию через восстановление в отдельную временную БД.
Миграции, grants и provision не запускаются; live dump автоматически не восстанавливается.

Protocol 2 согласован с новым клиентом: старый клиент фермы получает требование
обновиться до изменения persistence. Коммерческие платежи не вызываются.
Одиночный игровой цикл и совместимость хранения проверены в исходном этапе;
установка API и публикация TestFlight здесь пока не объявляются выполненными.

Адресные проверки подготовки: `python3 -m unittest discover -s tests/operations
-p 'test_farm_update.py'` и `test_farm_release.py`.
Следующий шаг - получить согласованный release SHA, exact green CI, выполнить
prepare/apply, сохранить итоговые доказательства и отдельно принять нативный клиент.
