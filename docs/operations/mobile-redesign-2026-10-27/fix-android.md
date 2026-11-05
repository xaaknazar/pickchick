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
- Имя AAB называет профиль: `PickChick-0.2.0-7-production.aab`; тестовая staging-сборка -
  `PickChick-0.2.0-7-storefront-staging-not-for-play.aab` (с любой меткой выпуска).
- В каждой фазе первым печатается событие «Mobile JS bundle backend» (профиль, окружение, адрес
  API, `profile_from_default`, предупреждение для staging) - и тогда, когда фаза дальше
  останавливается (нет ключа загрузки, staging без `--allow-staging`).
- `doctor`: JDK, `ANDROID_HOME`, платформа 36, build-tools (версия из каталога React Native и
  35.0.0 - версия AGP по умолчанию для модуля `expo`), NDK и CMake, которые просит React Native,
  ключ загрузки (печатается только SHA-256 сертификата).
- `build`: `expo prebuild --platform android --clean` с закреплёнными значениями профиля, затем
  `./gradlew --no-daemon bundleRelease` (`--apk` - ещё и `assembleRelease`, `--architectures` -
  список ABI, по умолчанию `arm64-v8a,armeabi-v7a,x86_64`). AAB и приватный `release.json`
  (0600) - вне репозитория (`~/Library/Caches/PickChick/android-releases/<метка>` на Mac).
  Отказ до сборки (нет ключа, ключ - отладочный, нет пакета в `app.json`, занятая метка) не
  оставляет каталога выпуска; упавший prebuild/Gradle оставляет `build.log` и `release.json` с
  `buildStatus: failed`.
- Подпись: путь и пароли ключа загрузки - только из `PICKCHICK_ANDROID_UPLOAD_KEYSTORE`,
  `..._KEYSTORE_PASSWORD`, `..._KEY_ALIAS`, `..._KEY_PASSWORD` или приватного файла 0600 с теми
  же строками (`--signing-file`). Файл ключа должен быть 0600 и не попадать в Git (внутри
  репозитория допустим только игнорируемый путь, например `.local/` для одноразового ключа).
  Только шаг Gradle получает их как свойства `pickchickUpload*` через `ORG_GRADLE_PROJECT_*` в
  окружении (их читает release signing config из плагина, см. п. 2). `expo prebuild` и все его
  config plugins не получают ни одного значения ключа: ни `ORG_GRADLE_PROJECT_pickchickUpload*`,
  ни `PICKCHICK_ANDROID_UPLOAD_*` из окружения оболочки. Остаток: процессы, которые запускает
  сам Gradle (сборка JS-бандла Metro, autolinking через node), наследуют окружение Gradle - это
  свойство способа через окружение. Ни в командной строке, ни в логе, ни в `release.json`
  паролей и пути ключа нет. Хранилище ключа загрузки с владельцем `CN=Android Debug`
  отклоняется до prebuild («The upload keystore holds the Android debug key»); `inspect` ещё
  раз сверяет подпись AAB с записанным сертификатом ключа загрузки.
- `inspect`: манифест из AAB (`aapt2 dump xmltree` по proto-манифесту базового модуля) -
  пакет, versionCode/versionName (versionCode сверяется с `app.json`), minSdk, targetSdk >= 36,
  отсутствие `debuggable`/`testOnly`, `usesCleartextTraffic` не true, `allowBackup=false`,
  `dataExtractionRules`, разрешения по списку (`PERMISSION_ALLOWLIST`) и список запрещённых,
  запрос `dgis` в `<queries>`, нет схемы `exp+` (dev client). Плюс встроенный Expo app config
  (окружение и API должны совпасть с профилем), Hermes-бандл внутри, подпись совпадает с
  записанным сертификатом ключа загрузки.
- `inspect` - последний шаг перед ручной загрузкой в Play Console, поэтому **staging-бандл
  его не проходит** («the storefront profile talks to the staging host»). Тестовую staging-сборку
  можно проверить только с `--allow-staging`, и тогда событие - не «Inspect PASS», а
  «Inspect PASS for a local test only - NOT for Google Play» (`google_play_profile: false`).
- Справочно (не ошибка): `bundle_mentions_staging_host`. Константа `STAGING_API_URL` из
  `apps/mobile/src/build-config.ts` есть в каждом бандле, и в iOS тоже (было до полосы); во
  время работы production-экспорт обращается только к `api.pickchick.kz` (обход витрины: 2299
  запросов). Когда build-config перестанет класть её в production, проверку можно сделать
  ошибкой.
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
  биометрия, `AD_ID`. После проверки техлида ещё три (по коду, необязательные):
  `ACCESS_WIFI_STATE` (NetInfo читает данные Wi-Fi только при выданном разрешении -
  `NetInfoUtils.isAccessWifiStatePermissionGranted`; приложению нужен только `isConnected`),
  `RECEIVE_BOOT_COMPLETED` (expo-notifications переставляет локальные уведомления после
  перезагрузки; приложение их не планирует, push идёт через Firebase) и
  `BIND_GET_INSTALL_REFERRER_SERVICE` (expo-application; referrer не запрашивается). Их больше
  нет и в `PERMISSION_ALLOWLIST`: если вернутся, `inspect` упадёт. **AAB после этого не
  пересобирался** (см. «Проверки»): ожидаемый список на следующей сборке - 7 разрешений.
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
- **Вибрация ручки оплаты** (`haptic-map.ts`, `haptics.ts`): после проверки техлида на Android
  захват ручки (`grab`) и точка, где отпускание оплачивает (`armed`), остались сильным
  `impactAsync(heavy)` - вибромотор 60 мс, как до полосы: владелец просил вибрацию сильнее, а
  системные `DRAG_START` / `CONFIRM` / `LONG_PRESS` на многих телефонах слабее. Только щелчки
  каждую шестнадцатую трека (`tick`) - системная константа слайдера `SEGMENT_TICK` (Android 14+,
  запасная `CLOCK_TICK`): короткая, настроена производителем и учитывает «Отклик на касание»,
  тогда как 43 мс вибромотора на каждый щелчок сливаются в гул. iOS без изменений. Силу
  проверить на 2-3 настоящих телефонах до production.
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

Графика карточки (`store-graphics.md`, `graphics/`): значок 512 x 512 (32-битный PNG, арт
значка App Store) готов; графический баннер 1024 x 500 (24-битный PNG, наклейка PickChick и
наши бургер, стрипсы и соус на фирменном синем, без текста) - **черновик, утверждает
владелец**; генератор `scripts/mobile/play_store_graphics.py`. Скриншоты телефона снимает
Codex: 4-8 штук 1080 x 1920 (9:16; снимок 1080 x 2400 длиннее 2:1 и Play его не примет) в
эмуляторе Android Studio с релизного APK, порядок и запреты - как в плане скриншотов App
Store.

Страница удаления: исходник страницы поддержки в репозитории
(`infra/public-staging/support/`), добавлены ссылка «Удалить аккаунт PickChick» и раздел
`#delete-account` на трёх языках: путь в приложении с подписями приложения и запрос по
телефону ресторана. После проверки техлида раздел говорит, что удаляется (профиль, вход по
номеру, согласия, доступ со всех устройств - как `deleteMe` в
`packages/customer-identity/src/index.ts`) и что остаётся (записи о заказах и платежах для
учёта), и ведёт ссылкой прямо к разделу «Сроки хранения аккаунта» опубликованной политики
(`/legal/privacy#:~:text=Сроки%20хранения%20аккаунта`; заголовок закрепляет `legal-update.py`).
Точного срока в репозитории нет - он только в опубликованной политике. Публикация - отдельный шаг Codex (`support-page-release.py`; так как
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
  `~/.gradle/init.d` (вне репозитория, удалён в конце; точный скрипт - в разделе «Если Maven
  Central отвечает 429» ниже); build-tools 35.0.0 поставлены с dl.google.com; `doctor` теперь
  требует их.
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
осталось (`--no-daemon`). Поправка после проверки техлида: в первой уборке остались около 11 МБ
вывода сборки самих Gradle-плагинов (`.gradle`, `.kotlin`, `build` в `@react-native/gradle-plugin`,
`expo-modules-autolinking/android/expo-gradle-plugin`, `expo-dev-launcher-gradle-plugin`,
`expo-module-gradle-plugin`; все файлы созданы Gradle 04.11 20:47-22:35, ни одного из пакета) -
удалены при исправлениях.

### Если Maven Central отвечает 429

В контейнере 05.11 повторилось: Central отвечает Gradle `429 Too Many Requests` (у техлида и
при исправлениях). Gradle считает 429 ошибкой, а не «нет файла», поэтому простое зеркало после
Central не помогает: плагин, которого нет на зеркале (ktfmt из плагин-портала в сборке
`@react-native/gradle-plugin`), останавливает сборку на Central, а плагин-портал сам
перенаправляет часть файлов на Central (`kotlin-gradle-plugins-bom`). Работает только так:
зеркало Google **первым** во всех списках репозиториев (в том числе `pluginManagement` каждого
settings), а к самому Central Gradle не обращается. Проверено 05.11 на копии
`@react-native/gradle-plugin` (Gradle 9.3.1, как в шаблоне Expo SDK 57): с зеркалом первым,
но с Central дальше в списке - `429` от Central и `Plugin [id: 'com.ncorti.ktfmt.gradle'] was
not found`; со скриптом ниже - `BUILD SUCCESSFUL`, 81 файл с зеркала и плагин-портала, AGP
8.12.0 с dl.google.com, ни одного запроса к `repo.maven.apache.org`. Полная сборка приложения
с этим скриптом не повторялась (место на диске); в сборках 4 и 5 выше работал прежний
init-скрипт с зеркалом, его текст не сохранился.

Только если на Mac или в CI будет 429: сохранить как
`~/.gradle/init.d/pickchick-central-mirror.gradle` (не в репозиторий), собрать, удалить файл.

```groovy
// ~/.gradle/init.d/pickchick-central-mirror.gradle - outside the repository, only while Maven
// Central answers Gradle with HTTP 429 Too Many Requests (shared egress IP). Delete it after.
//
// Gradle treats 429 as a failure, not as "missing": a plugin or library that is not in the
// repository before Central (ktfmt from the plugin portal, the RN gradle-plugin build) stops the
// build at Central. So Google's official Maven Central mirror goes FIRST in every repository list
// (plugin repositories of every settings file, settings-level and project-level dependency
// repositories, buildscript repositories), and Central itself is never asked (an exclude-all
// content filter). The plugin portal redirects some artifacts to Central
// (kotlin-gradle-plugins-bom); with the mirror first they are found there before the portal.
def mirrorUrl = 'https://maven-central.storage-download.googleapis.com/maven2/'
def mirrorName = 'PickChickCentralMirror'
def centralHosts = ['repo.maven.apache.org', 'repo1.maven.org']

def mirrorFirst = { RepositoryHandler repositories ->
    if (repositories.findByName(mirrorName) != null) return
    def mirror = repositories.maven {
        name = mirrorName
        url = mirrorUrl
    }
    repositories.remove(mirror)
    repositories.addFirst(mirror)
    repositories.withType(MavenArtifactRepository).configureEach { repository ->
        if (repository.name != mirrorName && centralHosts.contains(repository.url?.host)) {
            repository.content { excludeGroupByRegex('.*') }
        }
    }
}

beforeSettings { settings ->
    mirrorFirst(settings.pluginManagement.repositories)
    mirrorFirst(settings.buildscript.repositories)
    mirrorFirst(settings.dependencyResolutionManagement.repositories)
}

settingsEvaluated { settings ->
    // A settings file without plugin repositories means "the plugin portal". Keep that default,
    // last: the portal redirects what it does not host to Central (429), so it must never be
    // asked before google() for the Android Gradle plugin.
    def plugins = settings.pluginManagement.repositories
    if (plugins.size() == 1 && plugins.findByName(mirrorName) != null) plugins.gradlePluginPortal()
}

allprojects {
    mirrorFirst(buildscript.repositories)
    mirrorFirst(repositories)
}
```

Размер: AAB 141 МБ только с arm64-v8a; из них 94 МБ - картинки JS (`res/drawable-mdpi`), 10 МБ -
видео витрины, 19 МБ dex. Загрузка на телефон около 130 МБ - меньше лимита Play 200 МБ на базовый
модуль, но много; кандидаты на сокращение - ассеты выключенных игр (Pick Run и др.). Не менялось.

### Тесты

- `pnpm test:mobile`: **582/582** node-тестов (было 566: +4 `android-config.test.mjs`,
  +8 `android-ux.test.mjs`, +4 `play-listing.test.mjs`) и **91** Python-тест (было 73: +18
  `test_android_release.py`), 1 пропуск как раньше. После исправлений по проверке техлида -
  см. «Исправления после проверки техлида». Пока сгенерированная папка
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

### Тесты (после проверки техлида)

- `pnpm test:mobile`: **584/584** node-тестов (+1 настоящий шаблон Expo в
  `android-config.test.mjs`, +1 графика Play в `play-listing.test.mjs`) и **96** Python-тестов
  (+5 в `test_android_release.py`: имя AAB с профилем, окружение оболочки без значений ключа,
  отказ без каталога выпуска, упавший Gradle с `buildStatus: failed`, staging-сборка и
  staging-inspect), 1 пропуск как раньше.
- `tests/operations/test_support_page_release.py`: 5/5 (раздел удаления: ссылка на «Сроки
  хранения аккаунта» на трёх языках).
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck` (весь репозиторий), `tsc --noEmit`
  мобильного приложения, `pnpm design:check`, `translations.mjs --check` (1462 сообщения) - без
  ошибок.
- Браузер: новый Kaspi-экспорт (`customer-auth`, порт 5196) - `browser_slide_to_pay.py` PASS
  (затронут модуль вибрации; веб-ветка `haptic()` та же, тест читает подсказки вибрации).
  Остальные наборы не перезапускались: веб-код, который они проверяют, не менялся.
- Раздел удаления на 360 px (RU/KK/EN) снят Playwright: без горизонтальной прокрутки, ссылка
  на политику переносится в две строки (`.local/mobile-1027/android/review/support/`).
- Init-скрипт зеркала Central проверен Gradle 9.3.1 на копии `@react-native/gradle-plugin`
  (см. раздел про 429); Gradle, его кэш и копия удалены, демонов нет.

## Что проверить только на телефоне

- Аппаратная «Назад» и жест «Назад» на всех слоях: корзина, оплата (с окном «Закрыть оплату?»),
  вход (все шаги, документы), профиль и подэкраны, удаление аккаунта, игры, статус заказа и
  игра из трекера.
- Клавиатура на входе и в профиле (edge-to-edge), календарь даты рождения (системный диалог,
  язык кнопок).
- Вибрация ручки оплаты на 2-3 телефонах разных производителей до production: захват и точка
  оплаты - вибромотор 60 мс (heavy), щелчки по треку - системная константа слайдера (её сила
  зависит от производителя; при выключенном «Отклике на касание» щелчков нет, как на iOS при
  выключенной System Haptics). Если щелчки слишком слабые - заменить их на `impactAsync`
  в `haptic-map.ts`, если захват слишком резкий - на `medium`.
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
   «Mobile JS bundle backend» с `"environment": "production"` и без `warning`, затем ровно
   «Inspect PASS» (не «... for a local test only - NOT for Google Play») и файл
   `PickChick-<версия>-<код>-production.aab`. Это первая сборка с тремя убранными разрешениями:
   в событии «Android bundle manifest» ожидается 7 разрешений (INTERNET, ACCESS_NETWORK_STATE,
   VIBRATE, POST_NOTIFICATIONS, WAKE_LOCK, `c2dm.permission.RECEIVE`,
   `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`). `versionCode` перед каждой загрузкой поднимает
   Codex в `app.json`. Если Gradle получает 429 от Maven Central - init-скрипт из раздела
   «Если Maven Central отвечает 429».
4. **Play Console**: создать приложение «PickChick» (по умолчанию русский, приложение,
   бесплатное), включить **Play App Signing** (Google хранит ключ подписи, мы - только ключ
   загрузки), заполнить App content по пакету: Privacy policy, App access, Ads (нет), Content
   rating, Target audience, Data safety, Delete account URL
   `https://pickchick.kz/support/#delete-account` (сначала опубликовать страницу и проверить,
   что раздел «Сроки хранения аккаунта» политики называет срок для заказов и платежей),
   категорию Food & Drink, контакты (`{SUPPORT_EMAIL}`), карточку из `listing.json`, графику из
   `docs/operations/mobile-play-2026-11/graphics/` (значок 512 x 512 и баннер 1024 x 500 после
   «да» владельца) и 4-8 скриншотов телефона 1080 x 1920 по `store-graphics.md`.
5. **Внутреннее тестирование** (internal testing): загрузить AAB, установить у себя и владельца,
   пройти «Что проверить только на телефоне».
6. **Закрытое тестирование** (closed testing): список Google-аккаунтов 12+ человек, ссылка-
   приглашение (`{OPT_IN_LINK}` в `testers-guide.ru.md`), 14 дней подряд. Нужно, если личный
   аккаунт разработчика создан после 13.11.2023 (владелец уточняет в Play Console).
7. После 14 дней - заявка на доступ к production (Play Console > Dashboard), затем выпуск в
   production только с `--feature-profile production` (по умолчанию).

## Открытые решения владельца

Аккаунт разработчика Google Play у владельца есть (подтвердил 05.11). Остаётся:

- дата создания этого аккаунта (видна в Play Console): если после 13.11.2023 - нужно закрытое
  тестирование 12+ тестировщиков 14 дней подряд до production;
- вычитка казахского текста карточки (`listing.json`, `kk`) носителем языка;
- Data safety: «не передаются» (Kaspi.kz и Telegram как обработчики по исключениям Google,
  рекомендация) или консервативный ответ «передаются» (`data-safety.md`);
- графический баннер 1024 x 500 (черновик в `graphics/`) - утвердить или заменить;
- почта или Telegram для запросов на удаление без приложения (сейчас только звонок в ресторан в
  часы работы) и кто выполняет такие запросы;
- срок хранения записей о заказах и платежах после удаления: если в опубликованной политике его
  нет, назвать (можно вписать в `delete_kept` страницы поддержки);
- адрес поддержки `{SUPPORT_EMAIL}` для карточки.

## Исправления после проверки техлида (05.11.2026)

Блокирующих замечаний не было; все мелкие исправлены, кроме пересборки AAB (см. ниже).

- `android_release.py inspect` не пропускает staging-бандл: «Inspect FAIL ... talks to the
  staging host»; с `--allow-staging` - «Inspect PASS for a local test only - NOT for Google
  Play». Имя AAB/APK содержит профиль, у staging ещё `-staging-not-for-play`.
- `build`: значения ключа загрузки получает только шаг Gradle (`expo prebuild` - ни
  `ORG_GRADLE_PROJECT_pickchickUpload*`, ни `PICKCHICK_ANDROID_UPLOAD_*` оболочки). Отказ до
  сборки не оставляет пустого каталога выпуска; «Mobile JS bundle backend» печатается первым и
  при отказе (нет ключа, staging без флага). Текст отказа doctor/build: «The upload keystore
  holds the Android debug key» (про файл ключа, а не про бандл).
- Тест плагина подписи читает настоящий `app/build.gradle` из `expo/template.tgz` (SDK 57):
  смена шаблона Expo теперь ломает `pnpm test:mobile`, а не prebuild.
- Init-скрипт зеркала Maven Central - в разделе «Если Maven Central отвечает 429», проверен.
- Убраны оставшиеся 11 МБ вывода сборки Gradle-плагинов в `node_modules`.
- Страница удаления: что удаляется, что остаётся и ссылка на «Сроки хранения аккаунта».
- Графика Play: значок 512, черновик баннера 1024 x 500, план скриншотов телефона.
- Вибрация: захват и точка оплаты на Android снова heavy-импульс 60 мс.
- Разрешения `ACCESS_WIFI_STATE`, `RECEIVE_BOOT_COMPLETED`, `BIND_GET_INSTALL_REFERRER_SERVICE`
  заблокированы и убраны из списка `inspect`.
- `inspect` сообщает `bundle_mentions_staging_host` (справочно, не ошибка).
- **AAB не пересобран.** Из нативного изменились только три строки `blockedPermissions`
  (тот же механизм `tools:node="remove"`, что уже сработал в сборке 5 для 16 разрешений
  счётчиков; проверено introspection-тестом `android-config.test.mjs`). Полная сборка в
  контейнере съела около 11 ГБ (SDK, NDK, кэш Gradle), сейчас свободно 13 ГБ - с запасом 3 ГБ
  не помещается. Проверит первая сборка на Mac: лишнее разрешение = «Inspect FAIL».

Проверки после исправлений: см. «Тесты (после проверки техлида)».
