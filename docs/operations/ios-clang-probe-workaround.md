# Локальный обход зависания Clang probe в SwiftBuild

Применять только при подтверждённом зависании `CreateBuildDescription →
ExecuteExternalTool clang -v -E -dM ... /dev/null`: Clang ждёт записи в pipe,
а SwiftBuild не читает stderr. [Upstream fix #1315](https://github.com/swiftlang/swift-build/pull/1315)
исправляет последовательное чтение stdout/stderr. Обычные ошибки компиляции
этот обход не исправляет. Предпочтительное постоянное решение — версия Xcode,
в которой включено это исправление; конкретную установленную версию проверять отдельно.

Подготовка не запускает сборку и не меняет Xcode, проект или глобальные настройки:

```sh
python3 scripts/mobile/clang_probe_workaround.py --destination .local/clang-probe-run-01
```

Скрипт использует Clang выбранного `xcrun` Xcode, создаёт новую локальную
директорию и выводит абсолютные `cc`/`cxx`. Добавить эти два значения как
аргументы **одного** нужного вызова `xcodebuild`: `CC=<cc>` и `CXX=<cxx>`.
Не добавлять overrides в общие build settings. Не менять `LD`, `LDPLUSPLUS`
или выбранный toolchain. Для проверки одного iOS Simulator можно отдельно
передать `ONLY_ACTIVE_ARCH=YES`; для archive это не требуется.

Только probe с `-v -E -dM -c /dev/null` выполняется с одновременным чтением
двух потоков. Затем launcher передаёт исходные байты stdout, закрывает его
дескриптор и передаёт исходные байты stderr, сохраняя код завершения. Все
остальные вызовы переходят через `execv` непосредственно в настоящий Clang.
Никакие версии, макросы, результаты проверки или diagnostic bytes не создаются
искусственно и не берутся из заранее подготовленного кеша.

`usr/share`, `usr/lib`, `usr/include` и прочие каталоги ссылаются на выбранный
настоящий toolchain. Это обязательно: SwiftBuild читает `share/clang/features.json`
относительно пути компилятора. Без этого ссылки на launcher могут незаметно
изменить набор доступных compiler features. Для каждого нового варианта нужен
новый путь: прежний SwiftBuild cache может содержать прежнюю metadata.

Рядом сохраняется `provenance.json`: пути, версия и SHA-256 реальных Clang/Clang++,
launcher и `features.json`. Если обход применяется к release, сохранить этот
файл и точные аргументы вызова рядом с артефактами выпуска. Обычный release
скрипт сам такие overrides не включает. После обновления Xcode создать
директорию заново и повторить проверку; локальные launcher/provenance не коммитить.

Проверки: `python3 -m unittest discover -s tests/mobile -p 'test_clang_probe_workaround.py'`.
Они проверяют большой stderr до stdout с последовательно читающим родителем,
побайтовое сохранение потоков/exit, `execv` для обычной компиляции и настоящие
metadata symlinks. Успех этих проверок не заменяет фактическую native UI проверку;
статус сборки смотреть в `docs/project-status.md`.
