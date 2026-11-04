# PickChick 0.2.0 (33): production / api.pickchick.kz

## Область и разрешение

Владелец разрешил подготовку, PR/CI/обычный merge и внутренний TestFlight33.
App Store 1.0 (32) сохраняется без замены и без повторной отправки.
Публичное обновление - только после одобрения32 и отдельного решения владельца.
PR302 и PR303 не включены: разрешения на их merge для этого выпуска нет.
Ветка mobile-build29-1030 не включается; открытого PR этой ветки не найдено.

Бандл mobile-build33-1031 проверен: SHA-256
`ffe3eedaa98d6c351ea7366703f042f6b8ccada6d5070b9351a9a1614f683010`.
Импортирована вершина `8f9db20efc871ccf5d78e1fcebc7051ba2840ab7`,
она уже содержит shared `9f0a064f24814db26af3ed2ea5c38148e6ba0399`.
Изменение приложения в этой задаче - только ios.buildNumber32 ->33;
версия0.2.0 и Bundle ID kz.pickchick.app сохранены.

В ProjectSync занят mobile-build33-1031. По явному разрешению владельца
переданы семь файлов и @release/ios, @apple/appstore из mobile-appstore-1022,
mobile-kazakh-review-1030 и stage2-windows-1030. Прежние задачи и остальные
области сохранены; широкий резерв документов сужен до остальных файлов.

## Проверки перед выпуском

- Frozen lockfile install и сборка workspace-зависимостей PASS.
- test:mobile: 566 Node +73 Python PASS.
- TypeScript mobile, lint и format:check PASS.
- translations --check: 1462 UI messages,4 push events,три языка PASS.
- Production web-export PASS: server auth, Kaspi и published catalogue включены;
  simulator, unpaid test orders и Pick Farm выключены.
- App Review account на production-экспорте PASS:530 перехваченных запросов
  к api.pickchick.kz,0 к nip.io; только искусственные ответы, без реальных счетов.
- browser_store_walk PASS:101 экран, RU/KK/EN,393x852 и320x568;2297
  перехваченных запросов на api.pickchick.kz,0 на nip.io.
- Xcode26.6 (17F113), doctor production PASS: environment=production,
  api_url=https://api.pickchick.kz, profile_from_default=false,без warning.
- Doctor с существующим выделенным keychain и App Store profile PASS;
  новая подпись и новые профили не создавались.
- Полная Foundation CI PASS, 11/11, attempt2:
  https://github.com/xaaknazar/pickchick/actions/runs/41905159145.
  Первый запуск остановился на таймауте browser_demo_account после reload;
  код приложения и тест совпадают с базой. Локальная проверка трёх размеров PASS,
  повтор только упавших CI jobs PASS. Photo printer CI также PASS после повтора
  проверки геометрии (первое падение на один пиксель).
- PR305 слит обычным merge: https://github.com/xaaknazar/pickchick/pull/305.
  Исходный чистый опубликованный SHA архива:
  `4c7ed8ece4265a64f76b1ea417ca67c459ee87a4`.
  Merge SHA: `642010ae555a9f8b8292a00dfb270ad2c581480b`; дерево совпадает с исходным.
- Native prebuild, pods, подписанный Release archive и export PASS.
  Загрузка остановлена Xcode: `Failed to Use Accounts`. Открыта форма входа
  Apple Account; подтверждённой загрузки и доступности в TestFlight пока нет.

## Нативный артефакт и доставка

Релиз `mobile-production-20261105-33`, версия0.2.0(33), Bundle ID `kz.pickchick.app`.
Для archive, export и попытки upload явно передан `--feature-profile production`.
Каждая из трёх фаз вывела `Mobile JS bundle backend` с полями:

```json
{
  "feature_profile": "production",
  "environment": "production",
  "api_url": "https://api.pickchick.kz",
  "profile_from_default": false
}
```

Поле warning отсутствует. Событие upload подтверждает выбранный профиль,
но не успешную передачу: первая попытка завершилась ошибкой авторизации Xcode.
Повторить upload того же архива после входа владельца, затем дождаться обработки
и проверить существующую группу PickChick Internal. Новые группы и тестировщики
не создаются; App Store32 не изменяется.

Проверки архива и экспортированного IPA:

- `codesign --verify --deep --strict`: PASS.
- Версия, build и Bundle ID в архиве и IPA совпадают.
- В нативном исполняемом файле присутствует runtime-класс ExpoHaptics.HapticsModule;
  это проверка включения модуля, не проверка ощущения вибрации на iPhone.
- Расширений `.appex`:0.
- `EXPO_PUBLIC_UPCOMING_PAYMENTS` не задан в окружении сборки.
- JS в IPA совпадает с архивом, 6 213 642 байта, SHA-256:
  `4a95b580c2506f464a7cd5be8963f9af97449d490f2122bec42667c72b5e35a6`.
- Экспортированный IPA:131 638 763 байта, SHA-256:
  `6d4991649fed74e77b346d987e105940bbe6bc153246209553313a0c9fee0179`.

Приёмка на физическом iPhone пока не выполнена. Нативная сборка и успешные
браузерные проверки не считаются подтверждением доступности в TestFlight.

## Apple и серверный шлюз

Проверка App Store Connect 04.11.2026 около20:12 UTC: последняя сборка0.2.0(32),
номер33 свободен. У отправки1.0(32) статус «Отклонено», причина2.1 Information Needed:
вопрос Apple02.11 «Do you use widgets?». Ответ владельца об отсутствии виджетов
сохранён; нового ответа Apple после него нет. Это не подтверждение одобрения.
Сборка32 и отправка не изменялись.

Read-only check_domain_links.py:9 строк,2 FAIL - сервер пока возвращает terms_url
и privacy_url на nip.io. API health/availability/auth config, Telegram-only,
https://pickchick.kz/legal/terms, /legal/privacy и /support/ PASS.
Поля App Store Connect этим запуском не проверялись (store_urls_checked=0).
После нового решения Apple требуется разрешённое переключение только двух
серверных ссылок штатным охраняемым способом с копией/откатом и повторный шлюз.
DEFAULT_MOBILE_PROFILE пока storefront: менять можно отдельно после Domain gate PASS.
Каждая нативная фаза33 должна явно получать --feature-profile production.

## Приёмка владельцем на iPhone

Не выполнена. После подтверждённой доступности33: меню; корзина без «Нет связи»;
вход; профиль; Документы; удаление аккаунта на выделенном тестовом номере.
Реальную оплату Kaspi владелец проверяет самостоятельно своим заказом.
Сервер, касса, iPad, каталог, цены и публичный App Store в этом этапе не обновляются.
Онлайн-пульт не опубликован.
