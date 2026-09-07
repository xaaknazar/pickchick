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

## Вложенная сборка ExpoModulesJSI после `env -i`

В установленном ExpoModulesJSI 57.0.8 скрипт
`apple/scripts/build-xcframework.sh` запускает отдельный
`xcodebuild build -scheme ExpoModulesJSI`. Перед ним `env -i` намеренно удаляет
настройки родительского Xcode, включая `XCODE_XCCONFIG_FILE`, чтобы не смешать
SDK разных сборок. Скрипт сохраняет `PATH`, `HOME`, `PODS_ROOT`, `RN_ROOT` и
при наличии `DEVELOPER_DIR`. Поэтому обход, применённый только к родительскому
archive/build, не обязательно попадает во вложенную проверку Clang.

Если именно эта вложенная сборка воспроизвела зависание, создать новый локальный
каталог с дополнительным launcher:

```sh
python3 scripts/mobile/clang_probe_workaround.py \
  --destination .local/clang-probe-expo-jsi-run-01 \
  --expo-jsi-xcodebuild
```

Флаг выключен по умолчанию. В результате появляются абсолютные `path_prefix`
и `xcodebuild_launcher`; обычная подготовка Clang этих файлов не создаёт.
Xcode добавляет собственный `Developer/usr/bin` впереди родительского `PATH`
(подтверждено в локальном kiosk Build01). Одной переменной shell у основного
`xcodebuild` недостаточно. Поэтому сначала отдельно запустить **оригинальный**
Expo build script с теми же абсолютными `PODS_ROOT`, `RN_ROOT` и выбранным Xcode:

```sh
env PATH="<path_prefix>:$PATH" \
  DEVELOPER_DIR="<selected Xcode>/Contents/Developer" \
  PODS_ROOT="<repository>/apps/kiosk/ios/Pods" \
  RN_ROOT="<same React Native root as the CocoaPods phase>" \
  PLATFORM_NAME=iphonesimulator \
  /bin/bash "<installed expo-modules-jsi>/apple/scripts/build-xcframework.sh"
```

Здесь нет родительского Xcode phase, поэтому launcher остаётся первым после
вложенного `env -i`. Передать реальные абсолютные пути вместо placeholders;
не менять `HOME`. Сохранить полный лог, provenance и код завершения. Только
после успешного build slice запустить основную native сборку. Оригинальный
Expo script сам проверяет хеши исходников, Pods/RN путей и версии Swift и
повторно использует соответствующий slice; кеш-файлы вручную не создавать,
не подменять и не отмечать успешными. Проверить фактический cache-hit в логе
основной сборки. При отличающихся путях или toolchain совпадение не гарантировано.
Для archive аналогично подготовить `PLATFORM_NAME=iphoneos`: готовый simulator
slice не заменяет device slice. Настройки CC/CXX самого основного build
передаются отдельно, как выше. Одновременно основной и предварительный build
одного Expo package не запускать: они используют общие generated Products.

Launcher консервативно перехватывает только вызов, у которого первый аргумент
`build`, ровно один `-scheme ExpoModulesJSI` и нет другой build action или
metadata query. В этом вызове он заменяет только CLI-настройки `CC=`/`CXX=`
на созданные Clang wrappers и выполняет настоящий выбранный `xcodebuild`
через `execv`. Остальные аргументы, окружение, cwd, потоки и завершение
сохраняются. Archive, другая схема, `-showBuildSettings`, `-create-xcframework`,
неоднозначные и option-first формы проходят без изменений. Launcher не
возвращает удалённые `SDKROOT`/`PLATFORM_NAME` и не меняет исходники `node_modules`,
глобальный Xcode или проект. Generated Products и slice cache создаёт сам
оригинальный Expo script в обычном порядке. После запуска убрать этот `PATH` override.

Дополнительная provenance содержит путь и SHA-256 настоящего `xcodebuild`,
путь и SHA-256 launcher, точную область действия и оба compiler override.
Проверки используют искусственный executable и `env -i`: подтверждают
узкий выбор схемы, сохранение аргументов с пробелами, окружения, cwd,
stdout/stderr и exit/signal, а также отсутствие launcher без opt-in.
Это проверка запуска инструмента; успешная сборка ExpoModulesJSI, основной
сборки и работа приложения подтверждаются отдельными native build/UI результатами.

Проверки: `python3 -m unittest discover -s tests/mobile -p 'test_clang_probe_workaround.py'`.
Они проверяют большой stderr до stdout с последовательно читающим родителем,
побайтовое сохранение потоков/exit, `execv` для обычной компиляции и настоящие
metadata symlinks. Успех этих проверок не заменяет фактическую native UI проверку;
статус сборки смотреть в `docs/project-status.md`.
