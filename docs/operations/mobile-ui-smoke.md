# Нативная проверка iOS

`tests/mobile/ios/SmokeTests.swift` проверяет приложение `kz.pickchick.app` через
XCUITest. Запуск Release не требует Metro: JavaScript и брендовые файлы входят
в приложение. Это проверка нативного интерфейса, а не подтверждение банковской
интеграции или работы всего приложения без сети.

Три автономных сценария: запуск M06 и переходы ко всем 35 страницам каталога дизайна;
добавление Pick Combo в отдельную демонстрационную корзину, количество 1 → 2 → 1
и заблокированная оплата; недоступный запрос SMS и экран ввода OTP. Тесты
используют accessibility testID и нативный scroll, без координат. Снимки страниц
сохраняются как attachments в `.xcresult`.

Четвёртый сценарий `testConnectedOrderSurvivesRelaunch` использует действующий
синтетический VPS: создание заказа из каталога, явная симуляция оплаты,
состояние «Готовится», перезапуск приложения, чтение того же номера в истории
и отмена созданного тестового заказа. Staff-ключей в приложении/тестах нет.
Если публичный TEST gate выключен, сценарий отмечается skipped; это не считается
подтверждением сквозной связи. Для него нужны интернет и опубликованный TEST API.

После Expo prebuild и установки CocoaPods, когда другие сборки iOS завершены:

```sh
ruby scripts/mobile/ios_ui_smoke.rb
ruby scripts/mobile/ios_ui_smoke.rb --install
xcrun simctl list devices available
```

Первая команда — dry run. Вторая идемпотентно добавляет `PickChickUITests`
и отдельную общую схему Release в сгенерированный, исключённый из Git проект.
Исходная схема PickChick и подпись для устройств/архива сохраняются. Только
Release для iphonesimulator получает локальную ad-hoc подпись и собственную
Keychain-группу; глобальный `CODE_SIGNING_ALLOWED=NO` использовать нельзя, иначе
SecureStore не сможет восстановить сеанс. После нового clean
prebuild команду установки нужно повторить. Скрипт переиспользует `xcodeproj`
из CocoaPods; при нестандартной установке передайте `PICKCHICK_POD_GEM_HOME`
с путём к CocoaPods `libexec`. Глобальные gems не устанавливаются.

Выберите UUID доступного iPhone Simulator из списка:

```sh
xcodebuild test \
  -workspace apps/mobile/ios/PickChick.xcworkspace \
  -scheme PickChickUITests \
  -configuration Release \
  -destination 'platform=iOS Simulator,id=<SIMULATOR_UUID>' \
  -parallel-testing-enabled NO \
  -derivedDataPath "$HOME/Library/Caches/PickChick/simulator-derived" \
  -resultBundlePath .local/mobile-ui-smoke/Run-<UNIQUE_ID>.xcresult \
  ONLY_ACTIVE_ARCH=YES
```

DerivedData должен находиться вне iCloud/Documents: FileProvider добавляет
FinderInfo к framework-каталогам, и codesign отвергает такую сборку. Удаление
атрибутов внутри синхронизируемой папки не помогает, поскольку они возвращаются.
Пользовательские исходные файлы и метаданные ради сборки не очищаются.

Путь `.xcresult` должен быть новым для каждого запуска. Для быстрой проверки
корзины добавьте `-only-testing:PickChickUITests/SmokeTests/testPreviewCartQuantityAndDisabledPayment`.
Запускать UI-тесты и archive параллельно для одного native project нельзя.
Скрипт сам не запускает сборку, Simulator, archive или отправку в Apple.

Установка harness проверяется отдельно на временном Xcode-проекте через
`--project /path/to/PickChick.xcodeproj`: dry run не изменяет файлы, повторный
`--install` не дублирует target/source/dependency и оставляет project/scheme
побайтово прежними. Это не заменяет фактический `xcodebuild test`; результат
нативного прогона следует записывать только после чтения `.xcresult`.

## Подтверждённые результаты

6 сентября 2026, Xcode 26.6 / iOS Simulator 26.5 / iPhone 17 Pro:
три автономных сценария успешно завершены в Run-3. Первый connected-тест
выявил отсутствие Keychain entitlements в неподписанном симуляторе. Run-4
остановился на iCloud FinderInfo в сгенерированном framework. После отдельной
подписи симулятора и переноса DerivedData в Library/Caches connected-тест
прошёл в Run-5 и на финальном интерфейсе в Run-6 (38,127 с, T-000013).
Последний подтверждает создание на VPS, симуляцию оплаты, восстановление
после перезапуска из истории и отмену. Снимок
[восстановленного заказа](../design/verification/2026-09-06/native-restored.png)
сохранён в Git; полные xcresult остаются приватными локальными артефактами.
Это нативный тест соединения, но не загрузка в TestFlight и не физический iPad.
