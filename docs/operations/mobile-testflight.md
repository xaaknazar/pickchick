# PickChick: отдельное приложение и локальный TestFlight

Заказчик выбрал отдельное приложение PickChick в существующей Apple Team
**Aknazar Kuanysh / DAJTP6MC3Q**. Идентификатор для регистрации:
**kz.pickchick.app**. Приложения Divergents и iDrink не являются исходной записью
PickChick: их Bundle ID, профили, версии и метаданные не изменяются.

## Выпуск 1 октября 2026: 0.2.0 (6)

Подготовлен из общего среза `c483680` в отдельной рабочей копии. App Store Connect
подтвердил: прежняя 0.1.0 (5) обработана и включена в `PickChick Internal`,
две установки. Новая версия использует тот же `kz.pickchick.app` и Apple Team;
PickChick Dev остаётся отдельным приложением.

Для текущего клиентского пилота все фазы release helper используют
`--feature-profile customer-pilot`. Профиль фиксирует серверный вход и Kaspi,
выключает симулятор и неоплаченный TEST-путь, отключает чтение локального dotenv
при сборке. Значения сохраняются в метаданных и сверяются при export/upload.
`expo.extra.customerOperationsEnabled=false` остаётся ограничителем прежнего
общего контура; текущий Kaspi работает через отдельный customer-checkout API.

В выпуск входят текущий дизайн, постоянная серверная сессия, четырёхзначный
Telegram-код, Kaspi со сроком счёта 180 секунд, стоп-лист, комментарий клиента
и напитки в рекомендациях. Возможность новой оплаты зависит от доступности
кассового узла и серверных проверок. WhatsApp и фискализация Webkassa ещё не
включены; сборка не заменяет настройку провайдеров. Пополнение Telegram Gateway
владелец планировал, успешная доставка на другой номер ещё не подтверждена.

Из чистого `00254575098e242423ed301ff8d7c405d23ce79c` выполнены archive,
export и upload (label `customer-pilot-20261001-6-final`). Полная
[CI 36868949571](https://github.com/xaaknazar/pickchick/actions/runs/36868949571)
прошла 6/6 перед загрузкой. Локально `pnpm check`, mobile typecheck, mobile
Node/Python и 25 iOS release/kiosk checks прошли. Подпись, App Store profile,
Bundle ID, embedded main.jsbundle и восстановление keychain/settings проверены.
IPA: 115426841 байт; SHA-256
`701dfc59c384c1f3bc38dedc72d0faa13a513903c8cd336fec47ed55693a925d`.
Первый подготовительный архив сохранён отдельно: во время него добавлялся
только Swift smoke-test; для доставки использован повторный чистый архив.

Apple приняла 0.2.0 (6) 1 октября в 19:13 по Алматы; в App Store Connect
обработка завершена, сборка добавлена в существующую `PickChick Internal`
(2 действующих тестировщика). Описание тестирования сохранено, новые
тестировщики не добавлялись. [Карточка сборки в Apple](https://appstoreconnect.apple.com/apps/6809208492/testflight/ios/4b2d7121-59f8-42b9-9eb5-d32c6a44fa50).
Локальное подтверждение: `.local/testflight-0.2.0-6-available.png`.
Нативный Release запустился на отдельном iPhone 17 Pro simulator iOS26.5,
показал меню, страницу товара и корзину. Первый smoke остановился на правильно
отключённом оформлении: публичный availability API подтвердил `fresh=false`.
Свежесть меню/связь с кассовым узлом - отдельная эксплуатационная зависимость;
защитная блокировка не снималась, счёт и OTP не создавались. Повторная проверка
явно учитывает блокировку ресторана и проверяет вход через профиль; native
XCUITest прошёл (27,6 с): меню, товар, корзина, объяснение блокировки, вход,
системная клавиатура и неактивная отправка при пустом номере. Локального demo
кода на экране нет. Результат: `testflight-6-smoke-2.xcresult` в приватном кеше
релизов Mac. Физическая установка на iPhone пока не подтверждена.

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

## Выпуск 0.1.0 (2) — фиксированные действия

7 сентября 2026 по времени Алматы (6 сентября UTC) завершён выпуск из чистого
`d644822c3085348b66ea63d75bb753869d2d3829`. Xcode archive и export прошли;
проверены `kz.pickchick.app`, Team `DAJTP6MC3Q`, version `0.1.0`, build `2`,
встроенный main.jsbundle, App Store profile/get-task-allow=false и strict codesign.
Прежний distribution certificate/profile использован повторно; настройки
native project и Keychain восстановлены.

Локальный IPA: `~/Library/Caches/PickChick/releases/fixed-controls-20260906-2/export/PickChick.ipa`.
SHA-256 локального export:
`944fa1bc29e3c02fda7888f67c7a429002279d3f823a24ffc7b16815a3b32c82`.
Upload выполняет отдельный App Store export; этот hash относится к локальному IPA.

Apple processing завершён. ID сборки
`a769ee18-a2d1-4a59-9b14-a55bd56b6e57`,
[страница сборки](https://appstoreconnect.apple.com/teams/d4bb6fec-2b82-44c6-b91d-b679b1114a6e/apps/6809208492/testflight/ios/a769ee18-a2d1-4a59-9b14-a55bd56b6e57).
Сборка назначена существующей `PickChick Internal` (один владелец аккаунта);
в списке группы подтверждён статус **«Тестируется»**. «Что тестировать» заполнено
на русском и сохранено. Новые тестировщики и внешняя группа не добавлялись.

Run-9 прошёл 35 страниц, корзину и недоступную SMS; после найденного дефекта
M04 Run-10 подтвердил fixed controls и сохранение при клавиатуре (2/2).
[UI-протокол](../../tests/operations/verification-fixed-controls-2026-09-06.md).
App Store Connect уже показывает установку предыдущей сборки 1; установка
новой сборки 2 на физический iPhone пока не проверена. Это внутренний TEST beta,
не публикация в общедоступном App Store и не рабочий приём денег рестораном.

## Выпуск 0.1.0 (3) — исходная композиция и витрина без паузы

7 сентября 2026 по времени Алматы. Чистый нативный исходник:
`c43553d8bdb8c8b167f361379dc9eced85563c88`. Выпуск
`mockup-fidelity-20260907-3` прошёл archive/export, проверку Bundle ID/Team,
version/build, встроенных JS/profile и `codesign --verify --deep --strict`.
Временные настройки подписи восстановлены. IPA находится приватно в
`~/Library/Caches/PickChick/releases/mockup-fidelity-20260907-3/export/PickChick.ipa`.
SHA-256 локального export:
`152d640ade25f4caf2de6f2591b631ac82c2382b84e4b9dd16b8a55c7aaf908f`.
Upload выполняет отдельный App Store export; hash относится к локальному IPA.

Apple подтвердила `Upload succeeded` 6 сентября в 19:53:28 UTC; processing
завершён, ID сборки `57218519-c0bf-41e3-a431-6e14d48ba4e5`.
[Сборка в TestFlight](https://appstoreconnect.apple.com/teams/d4bb6fec-2b82-44c6-b91d-b679b1114a6e/apps/6809208492/testflight/ios/57218519-c0bf-41e3-a431-6e14d48ba4e5).
Русские заметки «Что тестировать» сохранены. В существующей группе
`PickChick Internal` подтверждена строка **0.1.0 (3) — «Тестируется»**.
В группе один прежний тестировщик; новые тестировщики не добавлялись.

Нативные Run-13/14/15 подтверждают обход экранов, финальную композицию,
закреплённые действия и восстановление TEST-заказа; точная последовательность
и ограничения указаны в [UI-протоколе](../../tests/operations/verification-mockup-fidelity-2026-09-07.md).
После архива отдельно исправлена браузерная гонка `HTMLVideoElement.play()`:
web-адаптер не меняет тело нативного плеера. Поэтому SHA iOS-архива и последней
web-версии различаются и записаны раздельно.

При проверке группы App Store Connect показал установленную предыдущую сборку
**0.1.0 (2)** на iPhone 15 Pro / iOS 26.6. Физическая установка и запуск сборки 3
пока не подтверждены. Сборка остаётся внутренней synthetic TEST beta.

## Выпуск 0.1.0 (4) — полный каталог, модификаторы и тестовый профиль

7 сентября 2026 по времени Алматы. Чистый исходник приложения:
`41d206e15c961a389e1aef50e57fb7b5d15b219f`. Выпуск
`complete-mockup-20260907-4` прошёл archive/export, проверку Bundle ID/Team,
фактических version/build, встроенных JS/profile и `codesign --verify --deep --strict`.
Временная конфигурация подписи восстановлена. Приватный локальный IPA:
`~/Library/Caches/PickChick/releases/complete-mockup-20260907-4/export/PickChick.ipa`.
SHA-256 локального export:
`7a2e2dd5ab39b5832e2e6079b6582b5a4a6ee778e389ae448f8548daa5602ba4`.
Upload выполняет отдельный export; этот hash относится к локальному IPA.

Apple подтвердила `Upload succeeded` 6 сентября в 22:04:27 UTC / 7 сентября
03:04:27 Алматы. Обработка завершена, ID сборки
`2ba51423-0511-41df-921c-642f2a486a3b`.
[Сборка в TestFlight](https://appstoreconnect.apple.com/teams/d4bb6fec-2b82-44c6-b91d-b679b1114a6e/apps/6809208492/testflight/ios/2ba51423-0511-41df-921c-642f2a486a3b).
Русские заметки «Что тестировать» сохранены; в 03:09 Алматы существующая группа
`PickChick Internal` показывает **0.1.0 (4) — «Тестируется»**. В группе один
прежний тестировщик; новые доступы и внешняя beta не создавались. Установка
на физический iPhone владельца ещё не подтверждена.

[CI исходника выпуска](https://github.com/xaaknazar/pickchick/actions/runs/34062525828)
прошёл во всех трёх jobs. [Нативный протокол](../../tests/operations/verification-mobile-complete-2026-09-07.md)
сохраняет результаты Run-20, исправление категории в Run-21 и итоговую проверку
отмены/входа Run-22. [Пользовательский сценарий](mobile-beta-0.1.0.md).

Загрузка принята с предупреждениями об отсутствующих dSYM восьми framework:
ExpoImage, React, ReactNativeDependencies, SDWebImage, его AVIF/SVG/WebP coders
и hermesvm. dSYM приложения присутствует. Предупреждения ограничивают расшифровку
стеков этих зависимостей; настройка/получение их символов остаётся работой по
диагностике и не выдаётся за завершённую. Apple не отклонила загрузку из-за них.

## Выпуск 0.1.0 (5) — вход по макету и дата рождения

7 сентября 2026 по времени Алматы. Чистый исходник приложения:
`074c608da1ad213596323bdc0b5cdb0a754b6a2e`. Выпуск
`auth-birthday-20260907-5` прошёл archive/export. Проверены Bundle ID
`kz.pickchick.app`, Team `DAJTP6MC3Q`, фактическая версия `0.1.0`, build `5`,
встроенный `main.jsbundle`, App Store profile/get-task-allow=false и
`codesign --verify --deep --strict`. Временные настройки подписи восстановлены.
Приватный локальный IPA:
`~/Library/Caches/PickChick/releases/auth-birthday-20260907-5/export/PickChick.ipa`.
Размер 37 122 260 байт; SHA-256 локального export:
`1e377286e69fd531460d5ecc466ccb97fddbd0f3fbfa08f539af2e10ff1ab155`.
Upload выполняет отдельный export; hash относится к локальному IPA.

Apple подтвердила **`Upload succeeded` 7 сентября в 08:14:44 UTC / 13:14:44 Алматы**.
`release.json` содержит `archiveStatus=complete`, `exportStatus=complete`,
`deliveryStatus=submitted`, `dirty=false` и правильный исходный SHA.
Завершение Apple processing и назначение в `PickChick Internal` пока
**не подтверждены**: существующая вкладка App Store Connect после обновления
перенаправлена на форму входа. Требуется повторный вход владельца, затем проверка
и при необходимости назначение сборки существующей группе. Последняя
подтверждённая доступная сборка — 4. Установка версии 5 на физический iPhone
не проверена; новые тестировщики и внешняя beta не создавались.

[CI исходника выпуска](https://github.com/xaaknazar/pickchick/actions/runs/34098655733)
успешен во всех трёх jobs. [UI-протокол](../../tests/operations/verification-auth-birthday-2026-09-07.md)
включает браузерные размеры, клавиатуру и нативный выбор/сохранение даты.
[Инструкция проверки](mobile-beta-0.1.0.md).

На Xcode 26.6 применён [локальный обход Clang probe deadlock](ios-clang-probe-workaround.md).
Только archive получил `XCODE_XCCONFIG_FILE` с двумя настройками CC/CXX;
compiler flags, архитектура, оптимизация и подпись не изменялись. Реальные
Clang/Clang++, compiler metadata и исходные результаты probe сохранены;
`compiler-provenance.json` рядом с архивом содержит пути и хэши. Export/upload
выполнены без этого override. Глобальные настройки Xcode не менялись.

Загрузка принята с предупреждениями об отсутствующих dSYM тех же восьми
framework, что в сборке 4: ExpoImage, React, ReactNativeDependencies, SDWebImage,
его AVIF/SVG/WebP coders и hermesvm. Ограничение расшифровки их стеков остаётся.
Профиль клиента и дата рождения локальные; реальная SMS-авторизация и серверное
хранение DOB этим выпуском не включаются. VPS не обновлялся.
