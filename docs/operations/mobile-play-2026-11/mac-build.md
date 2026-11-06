# Android 1.0.1 (7): подготовка на Mac, 05.11.2026

## Область и разрешения

Владелец разрешил шаги 1-3 из fix-android.md: интеграция/PR/CI/merge,
локальный Android SDK, постоянный upload key и подписанный production AAB.
Версия 1.0.1 согласована отдельно; Android versionCode 7, iOS buildNumber 33.
Google Play, сайт поддержки, VPS, касса, iPad и App Store не изменяются.

Исходный бандл: 51e54708cb378d2de5960b91867f361e85cdca2e.
SHA-256 бандла: 2119eb3b877798cd602acf80335b80f54829c2ca848e43f56c431a9155d381e2.
Shared включён обычными merge без конфликтов, включая итоговый протокол PR306.
PR302/303 не включены. Чужие локальные изменения сохранены.

## Совместная работа

Claim mobile-android-1105: 38 путей ветки, этот протокол и @release/android.
Владелец согласовал временную передачу 12 пересекающихся файлов от
mobile-kazakh-review-1030, mobile-launch-1028, mobile-tab-motion-1102,
mobile-cart-mode-1029 и mobile-appstore-1022. Остальные области сохранены.
Для auth.tsx явно записано согласованное пересечение с родительским резервом
apps/mobile/src/app: родитель сохранён, чтобы не освободить чужие Expo-маршруты.
ProjectSync не поддерживает скобки в именах индивидуальных scopes.
После зелёной CI и merge PR306 собственная завершённая задача mobile-build33-1031
закрыта штатным finish; освобождённые статус и roadmap заняты Android-задачей.

## Подтверждённые проверки

- pnpm через Corepack 11.19.0; frozen install, сборка workspace PASS.
- test:mobile: 584 Node + 96 Python PASS.
- TypeScript, ESLint, Prettier, translations --check, design:check PASS.
- Два Python-теста сборщика получили фиксированный app.json fixture: смена
  пользовательской версии больше не ломает проверку имени артефакта.
- Production web-export: 101 экран storefront PASS; 2298 проверяемых запросов
  на api.pickchick.kz, 0 на nip.io. Проверочный аккаунт RU/KK/EN PASS (522
  обращения к этому домену), ответы сервера искусственные, банковских счетов нет.
- 5 тестов страницы поддержки PASS; сайт не публиковался.
- PR307 включён обычным merge 8409830627745c885ba6aada6c51b5a55dda7da2.
  Проверенная вершина 1fb5ba04deb67029eb49e9b05352600ba9754f48;
  [Foundation CI](https://github.com/xaaknazar/pickchick/actions/runs/41986578348)
  PASS 11/11, дополнительные roadmap/photo-printer проверки также зелёные.
- Android Studio 2026.2.1.8 (rabbit1), встроенная Java 25.0.3 установлены.
  SHA-256 установщика проверен перед установкой. Gradle шаблона Expo: 9.3.1.
- Постоянный upload key RSA-4096 / PKCS12 создан. Пароль случайный, хранится
  в локальной login Keychain macOS; файл ключа 0600, каталог 0700, вне проекта
  и iCloud. Пароль передаётся keytool/Gradle через память и окружение, не argv.
  Повторное чтение сертификата через Keychain успешно.

SHA-256 сертификата upload key (не содержимое ключа):

`3B:50:AC:C2:B0:F3:CF:D7:07:B6:1B:9C:F0:EE:DC:F2:E8:36:2C:4B:5C:92:53:39:56:B2:6F:CA:9B:0E:8E:56`

## Подписанная сборка на Mac

05.11 владелец отдельно согласился принять лицензию Android SDK. Установлены
Platform 36, Build-Tools 35.0.0 и 36.0.0, NDK 27.1.12297006, CMake 3.22.1.
Doctor с Java 21.0.12.1 завершился с кодом 0, все компоненты найдены.
Первая попытка play-internal-1 на Java 25 завершилась ошибкой configureCMake
в react-native-screens/worklets. На установленной Java 21 повторная попытка
play-internal-1-r2 завершилась BUILD SUCCESSFUL за 4 минуты 17 секунд.
Код приложения и ключ не менялись. Maven 429 не было, зеркало не подключалось.
Глобальные настройки Java не менялись; выбран только JAVA_HOME этого выпуска.

Исходный опубликованный SHA: `1a9472f1dc2a34b8ab4db7beb6f9c5616ed23f73`, dirty=false.
Это обычный merge [PR308](https://github.com/xaaknazar/pickchick/pull/308).
Дерево совпадает с f87d8eda0363b08c1b6b03a105533bf700a3813d:
`f7d19aec1b4f26d0a22112f7db7ee80e05169b49`.
[Foundation CI этого дерева](https://github.com/xaaknazar/pickchick/actions/runs/41990360542)
PASS 11/11, дополнительные 4 проверки также зелёные.

В doctor, build и inspect: feature_profile=production, environment=production,
api_url=https://api.pickchick.kz, profile_from_default=false, событие backend
без warning. Inspect PASS, google_play_profile=true, upload_performed=false.
У Gradle остаются предупреждения устаревших API; их не отключали.

Артефакт вне Git:
`~/Library/Caches/PickChick/android-releases/play-internal-1-r2/PickChick-1.0.1-7-production.aab`.
Размер: 166767770 байт.
SHA-256 AAB: `863c7ba7455e65402925521990b183ca2526d6b20e233c1aa366be14dd8da90d`.
SHA-256 встроенного Hermes JS:
`e9f70a81e51b3a3667ac76f987842ab9c859abcf787dc41340644f7ec5052599`.

- package kz.pickchick.app, versionName 1.0.1, versionCode 7;
- minSdk 24, targetSdk/compileSdk 36;
- ABI arm64-v8a, armeabi-v7a, x86_64;
- debuggable/testOnly/usesCleartextTraffic не включены, allowBackup=false,
  dataExtractionRules заданы, dgis есть, exp+ scheme отсутствует;
- авторизация server, Kaspi/published catalog включены; simulator,
  unpaid test orders и Pick Farm выключены; UPCOMING_PAYMENTS не задан;
- production app.config и Hermes bytecode встроены. Строка старого staging
  адреса остаётся как константа build-config, а не выбранный backend;
  production web-обход выше подтверждает 0 обращений к nip.io.

Ровно 7 разрешений:

1. android.permission.INTERNET
2. android.permission.ACCESS_NETWORK_STATE
3. android.permission.VIBRATE
4. android.permission.POST_NOTIFICATIONS
5. android.permission.WAKE_LOCK
6. com.google.android.c2dm.permission.RECEIVE
7. kz.pickchick.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION

`jarsigner -verify` вернул код 0 и «jar verified». Отдельное чтение всех
1824 payload-записей через JarFile с проверкой подписи подтвердило 0
неподписанных записей и единственный SHA-256 сертификата, указанный выше.
Jarsigner предупреждает о self-signed upload certificate, отсутствии timestamp,
неподписанных POSIX attributes и порядке ZIP (MANIFEST расположен после payload,
поэтому JarInputStream его не видит). Дублирующихся ZIP-записей нет; содержимое
не перепаковывалось. Эти предупреждения сохранены, не скрыты; Google ещё не
подтвердил приём AAB, поскольку загрузка не разрешена и не выполнялась.

## Пока не подтверждено

- Физический Android, включая аппаратную Назад и ощутимую вибрацию.
- FCM/Google Services не настроены; доставка push не заявляется рабочей.
- Офлайн-копия upload key и пароля: владелец подготовит носитель позже.
- Приём файла Google Play и установка из внутреннего тестирования.

Ключ и пароль хранятся вне проекта, пароль в локальной Keychain. Их содержимое
не включено в Git, чат или логи. Для повторной сборки использовать Java 21 и
тот же постоянный ключ; секреты передавать только штатным защищённым способом.

## Последующие шаги только по отдельному разрешению

Обновление сайта поддержки, заполнение Play Console и загрузка AAB не начаты.
Онлайн-пульт не публиковался. Вычитка KK, Data safety для Kaspi/Telegram,
контакт удаления аккаунта/поддержки и баннер магазина остаются решениями владельца.
