# PickChick: отдельное приложение и локальный TestFlight

Заказчик выбрал отдельное приложение PickChick в существующей Apple Team
**Aknazar Kuanysh / DAJTP6MC3Q**. Идентификатор для регистрации:
**kz.pickchick.app**. Приложения Divergents и iDrink не являются исходной записью
PickChick: их Bundle ID, профили, версии и метаданные не изменяются.

## Проверенная локальная среда

Проверка 2026-09-06: Xcode 26.6 (17F113), iOS 26.5 simulators, CocoaPods 1.17.0,
Node 24.16.0, pnpm 11.19.0. В Xcode есть конфигурация входа и кеш выбранной paid
Team; это не проверка актуальности сессии или прав на сервере Apple. Первоначально
была доступна только Apple Development identity. Затем по разрешению заказчика
из EAS получен один существующий сертификат распространения выбранной Team;
его закрытый ключ проверен и импортирован в отдельный приватный keychain.
Новые сертификаты не выпускались, прежние не отзывались. App Store profiles
прежних приложений для PickChick неприменимы.

Fastlane 2.238.0 установлен, кеша Apple-сессии Fastlane нет. Локальная сессия Expo
присутствует; её наличие не доказывает Apple-доступ. Auth-секреты из других
проектов не копировались. Ранее на этом Mac применялся Xcode automatic signing
и экспорт с `destination=upload`. Выпуск PickChick использует локальный Xcode;
ручная подпись отдельным App Store profile устраняет зависимость архивирования
от development profile и зарегистрированных устройств.

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
интеграций, без подмены реального банковского ответа или отправленной SMS.
По последующему поручению связать экраны разрешён отдельный TEST-контур:
синтетические заказы, явно обозначенный симулятор оплаты и тестовые станции.
Он описан в [ADR 0006](../architecture/adr/0006-test-order-flow.md) и включается
только отдельным серверным capability; `customerOperationsEnabled=false`
продолжает запрещать реальные коммерческие операции.

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

Для ручной подписи передать **одинаковые аргументы во все фазы**:

- `--provisioning-profile`: приватный файл App Store profile именно PickChick;
- `--signing-identity`: SHA-1 существующего Apple Distribution certificate;
- `--keychain`: отдельный keychain с этой identity, не login/system;
- `--keychain-password-file`: при необходимости приватный файл с созданным
  во время подготовки случайным 256-битным hex-паролем отдельного keychain.

Файлы принадлежат текущему пользователю и имеют режим 0600. `doctor` с этими
аргументами дополнительно проверяет Team, Bundle ID, срок, тип профиля, совпадение
сертификата и существование valid identity. Он не изменяет signing settings.
Полные resolved manual settings проверяются непосредственно перед архивированием.

`archive --release LABEL`, `export --release LABEL` и
`upload --release LABEL --asc-app-id 6809208492` разделены: первые две команды
не загружают приложение. В ручном режиме нет `-allowProvisioningUpdates`:
новые сертификаты, профили и Apple devices не создаются. Сохранён прежний
automatic mode без manual-аргументов; он использует `-allowProvisioningUpdates`
и существующую учётную запись Xcode. Пароль Apple или код 2FA в скрипт не передают.

Ручные настройки временно применяются только к generated PickChick app target,
Release/iphoneos. Pods, Debug и настройки simulator не меняются. Отдельный
keychain временно добавляется в конец текущего user search list для codesign;
default/login keychain остаётся прежним. Профиль устанавливается на время фазы.
После успеха или ошибки исходные настройки восстанавливаются. При обнаружении
одновременного изменения скрипт останавливается, сохраняя чужое изменение и
приватный снимок; перед повтором требуется сверить его. После аварийного завершения
процесса также проверяются release.lock и приватная копия native project.

Архивы, DerivedData, журналы и release metadata теперь сохраняются по умолчанию
в `~/Library/Caches/PickChick/releases/<release>/`, вне iCloud. Можно передать
`--artifacts-root` с другим локальным каталогом вне репозитория, Documents,
Desktop и стандартных папок облачной синхронизации. Это необходимо из-за
воспроизведённого восстановления FinderInfo у generated frameworks в Documents,
которое прерывало codesign. Старый неуспешный запуск остаётся историческим
журналом в `.local/mobile-ios/releases/connected-20260906-1/`; его не перезаписывают.

Метаданные содержат commit SHA, признак незакоммиченных изменений, версию, build,
API URL и идентификаторы ручной подписи, без путей к секретам. Повторный archive
с тем же label запрещён. Export/upload проверяют Bundle ID, Team, встроенный
`main.jsbundle` и совпадение исходного профиля/сертификата. Успешные ручные фазы
также фиксируют факт восстановления временных signing settings.

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

## Проверка выпуска 6 сентября 2026

Зарегистрированы Bundle ID `kz.pickchick.app` и отдельная карточка
[PickChick — 6809208492](https://appstoreconnect.apple.com/apps/6809208492/distribution)
в Team DAJTP6MC3Q. SKU `pickchick-ios`, основной язык русский; новые пользователи
не добавлялись. Нативный Release XCUITest прошёл заказ T-000013: создание,
симуляцию, приготовление, восстановление после перезапуска, историю и отмену.

Попытка `archive --release connected-20260906-1` завершилась Xcode65:
не найден iOS App Development profile для нового bundle и нет зарегистрированных
устройств для его автоматического выпуска. Это отдельная задача подписи;
успешная сборка симулятора не создаёт App Store distribution profile.

После этой попытки подготовлен `PickChick App Store 2026-09-06` для
`DAJTP6MC3Q.kz.pickchick.app`, с `get-task-allow=false` и без списка устройств.
Профиль и существующий сертификат действуют до 30 июля 2027. Подпись временного
исполняемого файла этим сертификатом прошла `codesign --verify --strict`.
17 проверок release helper прошли, включая native xcodeproj fixture и
восстановление при ошибке. На временной копии настоящего native project Xcode
подтвердил manual Team/Bundle/profile/identity; исходный проект не изменялся.
Затем выполнены настоящие archive и export с label
`connected-20260906-distribution-1` из чистого commit
`21614c2bc6048bf96bc8f0a5ef954f20759dac7b`. Xcode подтвердил
`ARCHIVE SUCCEEDED`, export завершился успешно. Получен PickChick **0.1.0 (1)**,
Bundle ID `kz.pickchick.app`, Team DAJTP6MC3Q, подключённый к TEST VPS.

IPA размером 35 129 623 байта имеет SHA-256
`f1e33535428a4117bc3905ad239a1d1ce90e671172bb4c4539a85fefe2d59805`.
После распаковки отдельно проверены `codesign --verify --deep --strict`,
встроенные JS bundle и App Store profile, Bundle ID/Team/version/build,
`get-task-allow=false`. Исходный pbxproj и точные user search/default Keychain
совпали с состоянием до сборки. Временные файлы проверки удалены.

Архив, IPA, журналы и безопасный `ipa-verification.json` находятся приватно в
`~/Library/Caches/PickChick/releases/connected-20260906-distribution-1/`;
IPA — `export/PickChick.ipa`. Подписанные бинарные файлы и signing credentials
не добавлялись в Git. Это подтверждённый archive/export; результат последующей доставки — ниже.

Первоначально App Store Connect блокировал отправку из-за обновлённого
Apple Developer Program License Agreement. После обращения к владельцу портал
показал соглашение от 18 августа 2026 как **Accepted September 6, 2026**;
предупреждение исчезло. Агент соглашение не принимал.

В 18:01:56 UTC Apple подтвердил `Upload succeeded`; затем App Store Connect
завершил обработку версии **0.1.0 (1)**. ID сборки
`787218fc-3201-42ec-8420-e6408d546cf8`:
[сборка в TestFlight](https://appstoreconnect.apple.com/teams/d4bb6fec-2b82-44c6-b91d-b679b1114a6e/apps/6809208492/testflight/ios/787218fc-3201-42ec-8420-e6408d546cf8).

Создана внутренняя группа `PickChick Internal` с ручным распределением сборок.
В группу добавлен только владелец существующей команды; App Store Connect
подтвердил одного тестировщика со статусом «Приглашен(а)» и одну назначенную
сборку со статусом **«Тестируется»**. Сохранены русские заметки «Что тестировать» с явными TEST-ограничениями.
Публичная ссылка и внешнее beta review не создавались, другим пользователям
приглашения не отправлялись. Сборка не публиковалась в общем App Store.

Владелец должен принять приглашение и установить PickChick через TestFlight
на iPhone. Физическая установка и запуск этим этапом ещё не подтверждены.
[Сценарий проверки](mobile-beta-0.1.0.md); локальное свидетельство Apple-доставки —
`delivery-verification.json` рядом с архивом. Контакты тестировщика и auth-секреты
в этот файл и Git не включены.
