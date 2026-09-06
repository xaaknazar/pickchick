# PickChick: отдельное приложение и локальный TestFlight

Заказчик выбрал отдельное приложение PickChick в существующей Apple Team
**Aknazar Kuanysh / DAJTP6MC3Q**. Идентификатор для регистрации:
**kz.pickchick.app**. Приложения Divergents и iDrink не являются исходной записью
PickChick: их Bundle ID, профили, версии и метаданные не изменяются.

## Проверенная локальная среда

Проверка 2026-09-06: Xcode 26.6 (17F113), iOS 26.5 simulators, CocoaPods 1.17.0,
Node 24.16.0, pnpm 11.19.0. В Xcode есть конфигурация входа и кеш выбранной paid
Team; это не проверка актуальности сессии или прав на сервере Apple. В доступном
поиске Keychain найдена одна Apple Development identity. Локальная Apple
Distribution identity не найдена. App Store profiles прежних приложений
существуют, но для PickChick неприменимы.

Fastlane 2.238.0 установлен, кеша Apple-сессии Fastlane нет. Локальная сессия Expo
присутствует; её наличие не доказывает Apple-доступ. Auth-секреты из других
проектов не копировались. Ранее на этом Mac применялся Xcode automatic signing
и экспорт с `destination=upload`, поэтому первая схема PickChick использует
локальный Xcode и существующую учётную запись.

## Запись приложения в Apple

Перед первой загрузкой:

1. В выбранной Team проверить наличие `kz.pickchick.app`. Если его ещё нет,
   зарегистрировать explicit App ID с описанием `PickChick`. При конфликте
   остановиться и согласовать новый ID, не менять идентификатор молча.
2. Создать отдельную запись App Store Connect: платформа iOS, имя PickChick,
   основной язык Russian, Bundle ID `kz.pickchick.app`, SKU `PICKCHICK-IOS`.
   Проверить доступ текущего владельца; не расширять доступ другим пользователям.
3. Записать числовой Apple ID новой записи. Этот идентификатор нужен для
   проверки доставки; он не является секретом.
4. Если Apple требует обновлённое соглашение, его читает и принимает владелец.
   Готовность аккаунта не подразумевает согласие с новым соглашением.

Доступность имени/Bundle ID и создание записи подтверждаются результатом Apple,
а не этим документом. Account Holder, Admin или App Manager может создать запись;
до её создания Apple требует принятого актуального соглашения. См.
[создание App Store Connect record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app)
и [регистрация App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id).

## Подготовка native проекта

В `apps/mobile` должны быть проверены app config, Bundle ID, выбранная Apple Team,
версия и увеличиваемый номер сборки. После Expo prebuild/CocoaPods появляется
`apps/mobile/ios/PickChick.xcworkspace`. Если имя workspace/scheme отличается,
передать его явно скрипту. Приложение должно использовать публичный HTTPS
staging API, доступный с iPhone без SSH-туннеля; ключи cloud/edge, staff PIN и
секреты провайдеров не входят в bundle.

Операции SMS, Kaspi, фискализации и начисления не становятся рабочими из-за
TestFlight-сборки. В релизе должны оставаться честные состояния недоступных
интеграций, без симуляции подтверждённой оплаты или отправленной SMS.

## Воспроизводимые команды

Из корня репозитория:

```sh
python3 scripts/mobile/ios_release.py doctor
```

`doctor` проверяет локальный Xcode, а при наличии native workspace — разрешённый
scheme, Bundle ID и Team. Он не регистрирует App ID, не создаёт сертификаты и не
обращается к App Store Connect для подтверждения прав.

В первой версии endpoint фиксируется в `apps/mobile/app.json` → `expo.extra.apiUrl`:
`https://pickchick.185.129.51.103.nip.io`. Рядом зафиксированы `environment=staging`
и `customerOperationsEnabled=false`. Скрипт читает эту версионируемую конфигурацию,
не подменяет endpoint переменной окружения и останавливается при другой Team,
Bundle ID или включённых клиентских операциях. Каталог, ошибки API, перезапуск
и выключение сети проверяются в установленном приложении.

```sh
python3 scripts/mobile/ios_release.py archive --release ios-0.1.0-1
python3 scripts/mobile/ios_release.py export --release ios-0.1.0-1
python3 scripts/mobile/ios_release.py upload --release ios-0.1.0-1 --asc-app-id PICKCHICK_APPLE_ID
```

В последней команде заменить `PICKCHICK_APPLE_ID` проверенным числовым ID новой
записи. `archive`, `export` и `upload` разделены: первые две команды не загружают
приложение. `-allowProvisioningUpdates` разрешает Xcode использовать существующий
вход и создать/обновить необходимые подписи. Если потребуется вход/2FA или права,
пользователь завершает его в Xcode; пароль или код не сохраняют в GitHub/документах.
Сертификаты других приложений не отзывают при достижении лимита.

Архивы, журналы Xcode и release metadata сохраняются только в игнорируемой
`.local/mobile-ios/releases/<release>/`. Метаданные содержат commit SHA, признак
незакоммиченных изменений, версию, номер сборки и API URL. Повторный archive с тем
же label не перезаписывает файл. Export/upload проверяют Bundle ID, Team и
встроенный `main.jsbundle`, чтобы случайно не отправить другое приложение или
сборку, зависящую от Metro.

Скрипт не печатает auth-секреты или полный вывод Xcode. При ошибке сообщает путь
к приватному локальному журналу. `upload` не нажимает публичный App Store release
и не рассылает приглашения новым тестировщикам.

## Проверка результата Apple

Успешная команда загрузки означает завершённую доставку, но ещё не доступность
в TestFlight. В новой записи PickChick проверить:

1. Сборка появилась с ожидаемыми версией и номером; обработка завершилась.
2. Нет предупреждений о подписи, неподдерживаемом SDK или недостающей информации.
3. Экспортные сведения заполнены по фактически используемому шифрованию.
4. Сборка доступна выбранному внутреннему тестировщику и запускается на iPhone
   без Metro/USB/SSH. Для внешнего тестирования отдельно требуется Apple beta
   review; приглашения отправляются только по поручению заказчика.

Зафиксировать screenshot/ссылку на запись, версию, build number, результат
реального запуска и ограничения функций в `docs/project-status.md`. См.
[Expo: iOS submission](https://docs.expo.dev/submit/ios/) и
[Apple: загрузка сборок](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds).
