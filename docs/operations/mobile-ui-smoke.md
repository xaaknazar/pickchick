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
Исходная схема PickChick и подпись приложения сохраняются. После нового clean
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
  -derivedDataPath .local/mobile-ui-smoke/DerivedData \
  -resultBundlePath .local/mobile-ui-smoke/Run-<UNIQUE_ID>.xcresult \
  CODE_SIGNING_ALLOWED=NO
```

Путь `.xcresult` должен быть новым для каждого запуска. Для быстрой проверки
корзины добавьте `-only-testing:PickChickUITests/SmokeTests/testPreviewCartQuantityAndDisabledPayment`.
Запускать UI-тесты и archive параллельно для одного native project нельзя.
Скрипт сам не запускает сборку, Simulator, archive или отправку в Apple.

Установка harness проверяется отдельно на временном Xcode-проекте через
`--project /path/to/PickChick.xcodeproj`: dry run не изменяет файлы, повторный
`--install` не дублирует target/source/dependency и оставляет project/scheme
побайтово прежними. Это не заменяет фактический `xcodebuild test`; результат
нативного прогона следует записывать только после чтения `.xcresult`.
