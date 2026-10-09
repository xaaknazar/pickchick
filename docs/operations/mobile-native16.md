# Мобильная сборка 0.2.0 (16)

Подготовка 9 октября 2026 в отдельной ветке `codex/mobile-native16` от
`865e132e9769aebe59d2c4fc2f96e0ac8f2704d6` (`codex/mobile-live-menu`).
Это мобильный клиент единого опубликованного меню. API schema050 выпускается
отдельно; сервер, Windows, iPad 11 и Kaspi QR этой процедурой не изменяются.

## Исходники и восстановление сети

Помимо номера сборки переносится адресное исправление `connectivity.ts`:
при возвращении приложения в foreground вызывается `NetInfo.refresh()`.
iOS может пропустить событие сети в фоне; сохранённый offline-статус иначе
удерживал чтение каталога выключенным. Новое событие сети, следующий lifecycle
переход и cleanup имеют приоритет над запоздалым результатом refresh.
Ошибка обновления не подменяется подтверждением доступной сети.
Только публичные чтения каталога и доступности получают этот сигнал;
заказы, счета и другие банковские команды автоматически не повторяются.

Шесть регрессий выполняют настоящий адаптер с подставленными native событиями:
возврат после offline без нового события, повтор active, late result в фоне,
разный порядок двух foreground-ответов, приоритет network event, cleanup и отказ.
Вместе с catalog/availability recovery прошли 19/19; mobile TypeScript, адресные
ESLint/Prettier и diff-check прошли. Полная CI точного release SHA требуется
отдельно, до native сборки и публикации.

Передача узких scopes согласована с владельцем общей задачи. Старые native
проекты и архивы build 15 сохраняются. Общие status/handoff/roadmap обновляет
координатор после подтверждённых результатов этапа.

## Профиль и подпись

Сохраняются Bundle ID `kz.pickchick.app`, Team `DAJTP6MC3Q`, версия `0.2.0`
и профиль `published-catalog` (`catalog-pilot` является alias). Набор флагов
идентичен принятой сборке 15:

```text
EXPO_PUBLIC_CUSTOMER_AUTH=server
EXPO_PUBLIC_KASPI_CHECKOUT=1
EXPO_PUBLIC_ORDER_SIMULATOR=0
EXPO_PUBLIC_UNPAID_TEST_ORDERS=0
EXPO_PUBLIC_PICK_FARM=1
EXPO_PUBLIC_PUBLISHED_CATALOG=1
```

API URL остаётся тем же HTTPS endpoint из `apps/mobile/app.json`.
`PICKCHICK_APP_VARIANT=release`, `EXPO_NO_DOTENV=1` исключают случайный Dev-вариант
и dotenv при prebuild/Release. `ios_release.py` закрепляет те же шесть флагов
при создании JS-бандла. Секреты не попадают в EXPO_PUBLIC или репозиторий.

Read-only doctor 9 октября подтвердил Xcode 26.6 (17F113), Team/Bundle ID,
существующую manual Distribution identity и App Store profile до 30 июля 2027.
`settings_changed=false`; авторизация сервера Apple этим не подтверждается.
Подпись использует прежний приватный отдельный keychain и тот же profile.
Новые сертификаты не создаются. См. [общую процедуру](mobile-testflight.md).

NetInfo 12.0.1 - новая нативная зависимость относительно build 15. Нужен fresh
Expo prebuild и CocoaPods; прежнего JS-бандла или неизменённого native проекта
недостаточно. Архивы/DerivedData размещаются вне Documents/iCloud, под уникальным
label в `~/Library/Caches/PickChick/releases/`.

## Порядок завершения

1. Опубликовать исходники, проверить remote SHA и полную зелёную CI точного SHA.
2. В этой отдельной рабочей копии выполнить frozen install, Expo prebuild iOS с
   Release-профилем и `pod install`. Проверить присутствие NetInfo в Podfile.lock.
3. Выполнить `scripts/mobile/ios_release.py doctor`, затем `archive` и `export`
   с `--app mobile --feature-profile published-catalog` и прежними manual
   signing-аргументами; label содержит build 16 и source SHA.
4. Проверить фактические Info.plist архива и IPA: версия 0.2.0, build 16,
   Bundle ID/Team, embedded main.jsbundle. Сохранить CI URL, SHA-256 IPA,
   release metadata и результат codesign.
5. После отдельного review координатора загрузить в существующий App Store
   Connect `6809208492`. Обработку Apple и доступность группе PickChick Internal
   подтвердить отдельно. Наличие IPA не означает установленную сборку.
6. Физически проверить открытие меню, обновление опубликованной цены в карточке
   и корзине, background/foreground с восстановлением сети. Без нового реального
   заказа, счёта или оплаты. Обновлять поверх существующего приложения.

На момент подготовки все ранее paired iPhone имеют `tunnelState=unavailable`;
непосредственная установка и физическая приёмка не подтверждены. Build 16 пока
не собран и не загружен; факты архива/экспорта будут добавлены после выполнения.
