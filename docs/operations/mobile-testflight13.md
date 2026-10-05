# TestFlight 0.2.0 (13) - подготовка TEST оплаты

5 октября 2026 владелец выбрал сначала подключить тестовую оплату TipTop Pay.
Build 13 подготовлен в `apps/mobile/app.json`. Архивирование, загрузка Apple и
доступность этой сборки в TestFlight пока не подтверждены.

## Состав и ограничения

Сборка должна включать согласованный итоговый коммит с backend, контрактами,
мобильным TEST checkout и build 13. `farm-pilot` сохраняет серверный вход,
Kaspi, PICK FARM и выключенные simulator/unpaid TEST orders. Отдельный новый
native flag для TipTop Pay не требуется: методы и среда выбираются сервером.

Для TipTop Pay TEST клиент показывает «Тестовая оплата - деньги не спишутся»,
открывает защищённую страницу в системном браузере, восстанавливает тестовую
сессию через сервер и сохраняет корзину. TEST результат не создаёт коммерческий
заказ, резерв, платёжный ledger или задание кухни. Kaspi сохраняет свой LIVE путь.
Включение Apple Pay требует отдельной проверки домена и серверного разрешения;
наличие iPhone само по себе не включает метод.

## Входные проверки

1. Получить свежие refs и окончательный исходный коммит. Архивировать только
   чистый checkout точного SHA с зелёной полной CI. Не использовать промежуточный
   checkpoint или готовый архив build 12.
2. Проверить серверный TEST config, доступность меню и отдельный endpoint TEST
   оплаты. TEST terminal и webhook должны оставаться в TEST режиме. Проверка
   успешной страницы браузера сама по себе не подтверждает серверный результат.
3. Зарезервировать `@apple/testflight`; сохранить штатную native release lock.
4. Подготовить generated iOS workspace из того же исходника, установить
   закреплённые зависимости и Pods. Проверить, что Release bundle читает этот
   checkout и native `CURRENT_PROJECT_VERSION=13` соответствует app.json.
5. Повторно использовать существующие ручные signing inputs build 12.
   Выполнить `scripts/mobile/ios_release.py doctor` с этими приватными аргументами.
   Не помещать их значения, provisioning profile или пароль keychain в Git.

Для повторного использования готовых Pods можно после зелёной CI выбрать в
чистой native рабочей копии новую ветку, указывающую прямо на итоговый SHA,
и обновить generated project через Expo prebuild без переустановки зависимостей.
Проверить фактический build 13 до archive. Не создавать дополнительный merge
commit после проверки CI: release metadata должны указывать на проверенный
исходный SHA. Штатный скрипт запрещает workspace другой рабочей копии; doctor
и все фазы запускаются из той же копии, где находится выбранный workspace.

## Выпуск

Штатный runbook: [mobile-testflight.md](mobile-testflight.md). Каждая фаза
использует один новый label, например `tiptoppay-test-20261005-13-FINALSHA`:

```sh
python3 scripts/mobile/ios_release.py doctor --feature-profile farm-pilot
python3 scripts/mobile/ios_release.py archive --feature-profile farm-pilot --release LABEL
python3 scripts/mobile/ios_release.py export --feature-profile farm-pilot --release LABEL
python3 scripts/mobile/ios_release.py upload --feature-profile farm-pilot --release LABEL --asc-app-id 6809208492
```

К каждой команде добавляются те же существующие ручные signing arguments из
приватной конфигурации. Команды выше показывают порядок фаз, а не предлагают
переключаться на automatic signing. Артефакты находятся вне репозитория/iCloud
в `~/Library/Caches/PickChick/releases/LABEL/`.

После archive проверить source SHA, dirty=false, 0.2.0 (13), Bundle ID
`kz.pickchick.app`, Team `DAJTP6MC3Q`, embedded `main.jsbundle`, `farm-pilot`
flags и codesign. После export сверить IPA и SHA-256. После upload отдельно
дождаться Apple processing и статуса «Тестируется» в существующей группе
PickChick Internal; новые тестировщики этим этапом не добавляются.

Физическая проверка: TEST предупреждение до ввода реквизитов, системный браузер,
закрытие без ложного успеха, возврат/перезапуск и серверный TEST результат;
корзина сохранена, коммерческий заказ и кухня не появились. Отдельно сохранить
доказательство, что экран Kaspi продолжает прежний сценарий.

## Проверенные возможности и время

Локально доступны Xcode 26.6 (17F113), готовый generated workspace/Pods прежнего
выпуска в рабочей копии `magic-sort` и около 89 GiB свободного диска. `xcodebuild -checkFirstLaunchStatus`
завершился успешно. Distribution identity build 12 отсутствует в текущем
обычном keychain search list; штатный ручной выпуск временно подключает
существующий отдельный keychain. Штатный doctor из рабочей копии выпуска 12
подтвердил Bundle ID/Team, существующие manual identity/profile и срок профиля;
настройки подписи не изменялись. Это ещё не проверка разблокировки keychain
во время archive или актуальной авторизации Apple.

Build 12 `farm-polish-20261005-12-978c6e5` имел чистый source
`978c6e53a4a542780127e7a0334a3d883a72b621`, profile `farm-pilot`,
archive/export complete и delivery submitted. По времени приватных журналов
архив занял около 3 часов 24 минут, export - 23 секунды, upload - 99 секунд.
Это наблюдение предыдущего выпуска, не прогноз: build 13 и Apple processing
могут занять другое время. Между timestamped записями Xcode есть промежуток
около 192,7 минуты; по журналу нельзя отделить активную сборку от возможной
паузы. Готовность до конца 5 октября не подтверждена.
