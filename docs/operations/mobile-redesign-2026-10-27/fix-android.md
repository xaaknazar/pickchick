# Полоса android: первый выпуск приложения в Google Play (05.11.2026)

Ветка `codex/mobile-android-1105` от `codex/mobile-build33-1031` `8f9db20e` (TestFlight 32 +
доменные и релизные инструменты сборки 33 + shared `9f0a064f`). Владелец 05.11: у него уже есть
личный аккаунт разработчика Google Play. Задача полосы - всё, что нужно для первой сборки
Android и карточки в Play, без загрузки в Google (её делает Codex в Play Console). Ни одного
запроса к серверу PickChick, Kaspi, Apple или Google Play; `versionCode` не менялся (7).

## Что изменено

### 1. Инструмент выпуска `scripts/mobile/android_release.py`

Фазы `doctor`, `build`, `inspect`; та же модель профилей, что у `ios_release.py` (модуль
загружается и переиспользуется: закреплённые флаги профиля, удаление `EXPO_PUBLIC_API_URL` и
`EXPO_PUBLIC_UPCOMING_PAYMENTS` из окружения, запрет ссылки поддержки на nip.io в production).

- Профиль по умолчанию и единственный для Play - `production` (`https://api.pickchick.kz`).
  Staging-профиль (`storefront` и др.) требует `--allow-staging` и отклоняется, если метка
  выпуска содержит `release` или `upload`.
- В каждой фазе печатается событие «Mobile JS bundle backend» (профиль, окружение, адрес API,
  `profile_from_default`, предупреждение для staging).
- `doctor`: JDK, `ANDROID_HOME`, платформа 36, build-tools (версия из каталога React Native и
  35.0.0 - версия AGP по умолчанию для модуля `expo`), NDK и CMake, которые просит React Native,
  ключ загрузки (печатается только SHA-256 сертификата).
- `build`: `expo prebuild --platform android --clean` с закреплёнными значениями профиля, затем
  `./gradlew --no-daemon bundleRelease` (`--apk` - ещё и `assembleRelease`, `--architectures` -
  список ABI, по умолчанию `arm64-v8a,armeabi-v7a,x86_64`). AAB и приватный `release.json`
  (0600) - вне репозитория (`~/Library/Caches/PickChick/android-releases/<метка>` на Mac).
- Подпись: путь и пароли ключа загрузки - только из `PICKCHICK_ANDROID_UPLOAD_KEYSTORE`,
  `..._KEYSTORE_PASSWORD`, `..._KEY_ALIAS`, `..._KEY_PASSWORD` или приватного файла 0600 с теми
  же строками (`--signing-file`). Файл ключа должен быть 0600 и не попадать в Git (внутри
  репозитория допустим только игнорируемый путь, например `.local/` для одноразового ключа).
  Gradle получает их как свойства `pickchickUpload*` через `ORG_GRADLE_PROJECT_*` в окружении
  (их читает release signing config из плагина, см. п. 2): ни в командной строке, ни в логе, ни
  в `release.json` паролей и пути ключа нет. Ключ с владельцем `CN=Android Debug` отклоняется до
  prebuild; `inspect` ещё раз сверяет подпись AAB с записанным сертификатом ключа загрузки.
- `inspect`: манифест из AAB (`aapt2 dump xmltree` по proto-манифесту базового модуля) -
  пакет, versionCode/versionName (versionCode сверяется с `app.json`), minSdk, targetSdk >= 36,
  отсутствие `debuggable`/`testOnly`, `usesCleartextTraffic` не true, `allowBackup=false`,
  `dataExtractionRules`, разрешения по списку (`PERMISSION_ALLOWLIST`) и список запрещённых,
  запрос `dgis` в `<queries>`, нет схемы `exp+` (dev client). Плюс встроенный Expo app config
  (окружение и API должны совпасть с профилем), Hermes-бандл внутри, подпись совпадает с
  записанным сертификатом ключа загрузки.
- Загрузки в Google нет.

### 2. Настройки Android (`apps/mobile/app.json`, `apps/mobile/plugins/android-release.js`)

- **API 36**: React Native 0.86 / Expo SDK 57 уже собирают с compileSdk 36 и targetSdk 36
  (каталог `react-native/gradle/libs.versions.toml`, лог Gradle), `expo-build-properties` не
  нужен.
- **Адаптивная иконка**: передний слой вырезан из арта иконки App Store
  (`apps/mobile/assets/app-icon.png`, синий фон убран) и уменьшен так, что вся наклейка лежит в
  безопасном круге 66 dp из 108; фон `#0042E0` (синий иконки iOS); монохромный слой для тем
  Android 13 (силуэт с вырезанными буквами); значок уведомлений 96 px. Генератор:
  `scripts/mobile/android_adaptive_icon.py` (`--preview` рисует маски круг / скруглённый квадрат /
  squircle / капля и мелкие размеры 48-192 px - проверено, ничего не обрезается).
- **Разрешения**: `blockedPermissions` удаляет то, что добавляют шаблон и библиотеки, но
  приложению не нужно: хранилище, `SYSTEM_ALERT_WINDOW`, микрофон, камера, геолокация, медиа,
  телефон, точные будильники, full-screen intent, foreground service, установка пакетов,
  биометрия, `AD_ID`.
- **allowBackup = false** и правила `pickchick_data_extraction_rules`, исключающие все разделы
  и из облачной копии, и из переноса на новое устройство (на Android 12+ одного `allowBackup`
  для переноса мало). Причина: токены сессии в `expo-secure-store` (ключи Keystore не
  переносятся), а в AsyncStorage лежит черновик оплаты - половинчатая копия хуже чистого входа.
  У `expo-secure-store` выключены собственные правила (`configureAndroidBackup: false`).
- **2ГИС**: на Android 11+ без `<queries>` `Linking.canOpenURL('dgis://...')` всегда false, и
  карточка ресторана открывала только веб-страницу. Плагин добавляет запрос `dgis`; запасной
  путь через веб остаётся.
- **Подпись release**: шаблон Expo подписывает release отладочным ключом. Плагин даёт release
  свой signing config из свойств `pickchickUpload*`; без них AAB остаётся неподписанным, но
  никогда не отладочным (так собранный в Android Studio без ключа release не уйдёт в Play).
- Счётчики на иконке: 16 разрешений лаунчеров (ShortcutBadger из expo-notifications) тоже
  заблокированы - приложение не ставит бейдж.
- **Назад**: `predictiveBackGestureEnabled: false` (Expo пишет
  `enableOnBackInvokedCallback=false`, BackHandler работает по-старому);
  `softwareKeyboardLayoutMode: resize` явно.
- Статус-бар: `expo-status-bar` светлый (как было); системная панель навигации прозрачная
  (edge-to-edge обязателен в SDK 57), отступы - `react-native-safe-area-context`, как на iOS.

### 3. Android UX (`apps/mobile/src`)

- **Аппаратная «Назад» в шторках** (`back-layers.ts`, `OrderSheet.tsx`): шторка сначала
  спрашивает верхний слой. Экран оплаты Kaspi в корзине: «Назад» = стеклянный X - с окном
  «Закрыть оплату?», пока банк может списать деньги; без X (момент «Оплачено») заблокированная
  шторка просто держит «Назад» - из оплаты нельзя выйти из приложения и ничего не отправляется
  повторно. Документы и поддержка поверх входа закрываются отдельно, шаг кода возвращает к
  номеру (как кнопка «Изменить номер»). Экран оплаты во вкладке «Заказы» слушает «Назад» только
  когда вкладка на экране.
- **Найденная ошибка**: шторка слушала «Назад» и тогда, когда над ней открыт другой экран. Игра,
  открытая из трекера заказа, при «Назад» вне игры отдавала событие шторке статуса под собой:
  та уезжала, а невидимый маршрут оставался поверх вкладок. Теперь шторка слушает только когда
  её экран в фокусе.
- Диалог удаления аккаунта не закрывается «Назад», пока идёт удаление (результат и ошибка
  показываются в нём же, как у неактивной кнопки).
- Кнопки системного календаря Android («Готово» / «Отмена») и системного окна «Очистить данные
  устройства?» были русскими в KK/EN - теперь через `t()`.
- **Вибрация ручки оплаты** (`haptic-map.ts`, `haptics.ts`): на Android - системные константы
  (`DRAG_START` / `SEGMENT_TICK` / `CONFIRM` с запасными `LONG_PRESS` / `CLOCK_TICK` для старых
  версий) вместо вибромотора 43-60 мс на каждую шестнадцатую трека; они короткие, настроены
  производителем и учитывают «Отклик на касание». iOS без изменений.
- **Клавиатура** (`keyboard-avoidance.ts`): SDK 57 - edge-to-edge, `adjustResize` больше не
  уменьшает окно, поэтому `KeyboardAvoidingView` входа и профиля теперь даёт отступ и на
  Android (на телефоне, который всё же уменьшит окно, перекрытие = 0, двойного отступа нет).
- Свечение кнопки входа (`AuthWelcome`) на Android нарисовано `boxShadow` (iOS-тени Android
  игнорирует). Остальные ключевые карточки уже имели `elevation`.
- Проверено и не менялось: все игры (`fullScreenModal`) обрабатывают `hardwareBackPress`, у
  всех `Modal` есть `onRequestClose`, календарь на Android идёт через `DateTimePickerAndroid`,
  казахский текст на Android - системный `sans-serif` (Roboto содержит все казахские буквы).
  Обрезку строк (`includeFontPadding`) и отклик нажатий без телефона подтвердить нельзя.
- Веб: Escape по-прежнему закрывает только незаблокированную шторку (так проверяет
  `browser_kaspi_checkout.py`); слои - только для «Назад» Android.

### 4. Пакет для Google Play `docs/operations/mobile-play-2026-11/`

`listing.json` (RU/KK/EN; русский и английский - тексты App Store сборки 33, казахский -
перевод, **нужна вычитка носителем**), `data-safety.md` (ответы из кода со ссылками на
файлы; рекомендация - «не передаются», Kaspi.kz и Telegram под исключениями Google, есть
консервативный вариант), `content-rating.md` (IARC: всё «нет», ожидается 3+; аудитория 18+,
чтобы не попасть под Families), `app-access.en.txt` (тот же аккаунт проверки, что у Apple:
номер и код только в полях Play), `account-deletion-web.md`, `testers-guide.ru.md`.

Страница удаления: исходник страницы поддержки в репозитории
(`infra/public-staging/support/`), добавлены ссылка «Удалить аккаунт PickChick» и раздел
`#delete-account` на трёх языках: путь в приложении с подписями приложения и запрос по
телефону ресторана. Публикация - отдельный шаг Codex (`support-page-release.py`; так как
изменились `content.json`, `render.py`, `style.css`, нужен новый манифест источника).

## Проверки

### Настоящая сборка Android в контейнере

Linux-контейнер, 2 vCPU, 8 ГБ, без KVM. Android SDK поставлен вручную в `/root/android-sdk`
(платформа 36, build-tools 36.0.0 и 35.0.0, NDK 27.1.12297006, CMake 3.22.1; скачано с
dl.google.com), JDK 21. Ключ - **одноразовый** (`.local/mobile-android/throwaway-key/`, PKCS12,
владелец `CN=PickChick throwaway test upload key`), не ключ загрузки и не в Git.

Команда: `python3 scripts/mobile/android_release.py build --signing-file <.local/...> --release
container-throwaway-N --architectures arm64-v8a` (профиль по умолчанию `production`).

- Попытки 1-3 остановились до компиляции: Maven Central отвечал Gradle `429 Too Many Requests`
  (общий исходящий IP; curl в то же время получал 200), затем Gradle не смог сам поставить
  build-tools 35.0.0 (нет файлов лицензий SDK). Для Central в контейнере подключено официальное
  зеркало Google (`maven-central.storage-download.googleapis.com`) init-скриптом в
  `~/.gradle/init.d` (вне репозитория, удалён в конце); build-tools 35.0.0 поставлены с
  dl.google.com; `doctor` теперь требует их.
- Попытка 4: `BUILD SUCCESSFUL in 19m 2s`, AAB 141 МБ, но **`inspect` отказал**: AAB был
  подписан отладочным ключом (`CN=Android Debug`) - AGP проигнорировал
  `android.injected.signing.*` из окружения; плюс 16 разрешений счётчиков на иконке
  (ShortcutBadger из expo-notifications). Исправлено: собственный release signing config в
  плагине (свойства `pickchickUpload*`), счётчики заблокированы.
- Попытка 5 (рабочее дерево = содержимое коммита `fe46c288`; `release.json`: `gitSha` `22b48fa9`,
  `dirty`): `BUILD SUCCESSFUL in 12m 45s`. Сторож диска полосы
  остановил скрипт сразу после Gradle (свободно 3,16 ГБ при пороге 3,1 ГБ), до копирования -
  AAB перенесён в каталог выпуска, временные файлы `app/build` удалены, затем отдельно
  `android_release.py inspect --release container-throwaway-5`: **Inspect PASS**.

Факты из манифеста AAB (`aapt2 dump xmltree`, полный вывод - `.local/mobile-android/`):

| Поле                                       | Значение                                                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| package / versionCode / versionName        | `kz.pickchick.app` / 7 / 0.2.0                                                                                                                                                                                                                 |
| minSdk / targetSdk / compileSdk            | 24 / 36 / 36                                                                                                                                                                                                                                   |
| debuggable, testOnly, usesCleartextTraffic | нет, нет, нет                                                                                                                                                                                                                                  |
| allowBackup / dataExtractionRules          | `false` / `@xml/pickchick_data_extraction_rules`                                                                                                                                                                                               |
| enableOnBackInvokedCallback                | `false`                                                                                                                                                                                                                                        |
| Разрешения (10)                            | INTERNET, ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE, VIBRATE, POST_NOTIFICATIONS, RECEIVE_BOOT_COMPLETED, WAKE_LOCK, `c2dm.permission.RECEIVE`, `BIND_GET_INSTALL_REFERRER_SERVICE`, `kz.pickchick.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` |
| `<queries>`                                | `https`, `dgis`                                                                                                                                                                                                                                |
| Схемы ссылок                               | только `pickchick` (нет `exp+`)                                                                                                                                                                                                                |
| Встроенный app config / JS                 | `production`, `https://api.pickchick.kz`; Hermes-байткод, строка production API в бандле                                                                                                                                                       |
| Подпись                                    | SHA-256 `D5:F9:2C:...:1B:59` = одноразовый ключ, не отладочный                                                                                                                                                                                 |
| «Mobile JS bundle backend»                 | `{"feature_profile": "production", "environment": "production", "api_url": "https://api.pickchick.kz", "profile_from_default": true}` без `warning`                                                                                            |

После проверки всё временное удалено: init-скрипт зеркала и весь `~/.gradle`, Android SDK
(`/root/android-sdk`), нативные `android/build` и `.cxx` в `node_modules`, сгенерированная
`apps/mobile/android/`, AAB и одноразовый ключ; остались только `build.log` и `release.json`
(без секретов) в `~/.cache/PickChick/android-releases/container-throwaway-*`. Демонов Gradle не
осталось (`--no-daemon`).

Размер: AAB 141 МБ только с arm64-v8a; из них 94 МБ - картинки JS (`res/drawable-mdpi`), 10 МБ -
видео витрины, 19 МБ dex. Загрузка на телефон около 130 МБ - меньше лимита Play 200 МБ на базовый
модуль, но много; кандидаты на сокращение - ассеты выключенных игр (Pick Run и др.). Не менялось.

### Тесты

- `pnpm test:mobile`: **582/582** node-тестов (было 566: +4 `android-config.test.mjs`,
  +8 `android-ux.test.mjs`, +4 `play-listing.test.mjs`) и **91** Python-тест (было 73: +18
  `test_android_release.py`), 1 пропуск как раньше. Пока сгенерированная папка
  `apps/mobile/android/` лежала на диске, `app-config.test.mjs` (introspection схем dev-сборки)
  падал: Expo читает существующий манифест; после её удаления - зелёный. Так было бы и до
  полосы - запускать тесты без сгенерированного `android/`.
- `tests/operations/test_support_page_release.py`: 5/5 (+1: раздел удаления на трёх языках).
- `pnpm lint`, `pnpm format:check`, `pnpm design:check`, `node scripts/mobile/translations.mjs
--check` (1462 сообщения), `tsc --noEmit` мобильного приложения и `pnpm typecheck` всего репозитория - без ошибок.
- Браузер (порты полосы, изолированные фикстуры, ни одного запроса к серверу):
  - Kaspi-экспорт (`customer-auth`, 5196): `browser_kaspi_checkout.py` PASS,
    `browser_store_walk.py` PASS, `browser_review_account.py` PASS, `browser_slide_to_pay.py` -
    первый прогон упал в `scenario_stuck_sending` (жест ручки не дошёл до конца, пока Gradle
    компилировал C++ и load average был ~7 на 2 ядрах), повторный прогон без нагрузки PASS;
  - production-экспорт (`storefront`, 5197, `EXPO_PUBLIC_PICKCHICK_ENV=production`):
    `browser_store_walk.py` PASS (все 2299 внешних запросов - к `https://api.pickchick.kz`),
    `browser_review_account.py` PASS (оба с `PICKCHICK_EXPECT_API=https://api.pickchick.kz`);
  - экспорт входа (`customer-auth` без Kaspi, 5196): `browser_customer_account.py` PASS;
  - симулятор (5182): `browser_profile.py` PASS, `browser_cart_sheet.py` PASS.
- Скриншоты (не в Git): `.local/mobile-1027/android/` - маски адаптивной иконки (крупно и
  96 px) и страница поддержки с разделом удаления, RU/KK/EN, 1280 и 360 px.

## Что проверить только на телефоне

- Аппаратная «Назад» и жест «Назад» на всех слоях: корзина, оплата (с окном «Закрыть оплату?»),
  вход (все шаги, документы), профиль и подэкраны, удаление аккаунта, игры, статус заказа и
  игра из трекера.
- Клавиатура на входе и в профиле (edge-to-edge), календарь даты рождения (системный диалог,
  язык кнопок).
- Вибрация ручки оплаты на нескольких телефонах (сила системных констант зависит от
  производителя; при выключенном «Отклике на касание» вибрации нет, как на iOS при выключенной
  System Haptics).
- Иконка на реальных лаунчерах, тема Android 13, значок уведомления; статус-бар и панель
  навигации (3 кнопки и жесты) на тёмном фоне; обрезка казахского текста.
- 2ГИС: открывается приложение, если установлено; push (нужен `google-services.json` через
  `PICKCHICK_GOOGLE_SERVICES_FILE` и FCM на сервере - в этой полосе не настраивалось).
- Эмулятора здесь нет (нет KVM): поведение на устройстве в контейнере не проверялось вообще.

## Шаги Codex и владельца

1. **Mac**: Android Studio (JDK 17+ входит), SDK Platform 36, Build-Tools 36.0.0 и 35.0.0,
   NDK 27.1.12297006, CMake 3.22.1; `export ANDROID_HOME=~/Library/Android/sdk`;
   `python3 scripts/mobile/android_release.py doctor` - без FAIL.
2. **Ключ загрузки** (upload key), один раз:
   `keytool -genkeypair -keystore ~/PickChick-keys/pickchick-upload.jks -storetype PKCS12 -alias pickchick-upload -keyalg RSA -keysize 4096 -validity 10000`
   (пароль - случайный, в Связку ключей macOS). Резервные копии: Связка ключей + офлайн-копия
   файла и пароля (зашифрованный носитель в сейфе). Потеря ключа = запрос сброса ключа загрузки
   в Google (несколько дней без обновлений). Никогда не класть в репозиторий, iCloud Drive и
   переписку.
3. Сборка: переменные `PICKCHICK_ANDROID_UPLOAD_*` (или `--signing-file` 0600), затем
   `python3 scripts/mobile/android_release.py build --release play-internal-1`. В выводе:
   «Mobile JS bundle backend» с `"environment": "production"` и без `warning`, затем
   «Inspect PASS». `versionCode` перед каждой загрузкой поднимает Codex в `app.json`.
4. **Play Console**: создать приложение «PickChick» (по умолчанию русский, приложение,
   бесплатное), включить **Play App Signing** (Google хранит ключ подписи, мы - только ключ
   загрузки), заполнить App content по пакету: Privacy policy, App access, Ads (нет), Content
   rating, Target audience, Data safety, Delete account URL
   `https://pickchick.kz/support/#delete-account` (сначала опубликовать страницу), категорию
   Food & Drink, контакты (`{SUPPORT_EMAIL}`), карточку из `listing.json`, скриншоты Android.
5. **Внутреннее тестирование** (internal testing): загрузить AAB, установить у себя и владельца,
   пройти «Что проверить только на телефоне».
6. **Закрытое тестирование** (closed testing): список Google-аккаунтов 12+ человек, ссылка-
   приглашение (`{OPT_IN_LINK}` в `testers-guide.ru.md`), 14 дней подряд. Нужно, если личный
   аккаунт разработчика создан после 13.11.2023 (владелец уточняет в Play Console).
7. После 14 дней - заявка на доступ к production (Play Console > Dashboard), затем выпуск в
   production только с `--feature-profile production` (по умолчанию).
