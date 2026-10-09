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
ESLint/Prettier и diff-check прошли. Полная CI точного release SHA прошла до native сборки: 11/11 задач
[Foundation CI 37929668466](https://github.com/xaaknazar/pickchick/actions/runs/37929668466).

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

NetInfo 12.0.1 - новая нативная зависимость относительно build 15. Выполнены fresh
Expo prebuild и CocoaPods; NetInfo autolink подтверждён в Podfile.lock и native
компиляции. `pod install`: 114 dependencies, 113 pods. Архив/DerivedData размещены
вне Documents/iCloud, под уникальным label в `~/Library/Caches/PickChick/releases/`.

## Подтверждённый архив и экспорт

9 октября 2026 Release archive и export завершились успешно. Проверка артефактов
выполнена в 14:19 UTC. Исходники бинарника:
[`b25f6df68cabe1100bf8265a57fb141bd6ef867d`](https://github.com/xaaknazar/pickchick/commit/b25f6df68cabe1100bf8265a57fb141bd6ef867d),
[PR 220](https://github.com/xaaknazar/pickchick/pull/220).
Это foreground fix/build 16 плюс проверенный checkpoint браузерных fixtures
`3bc98faf`; рабочее дерево было чистым. Последующая правка этого отчёта не
меняет source SHA бинарника.

`ios_release.py doctor`, `archive` и `export` использовали `--app mobile
--feature-profile published-catalog` и прежние manual signing inputs.
`release.json`: `archiveStatus=complete`, `exportStatus=complete`, `dirty=false`,
`temporarySigningSettingsRestored=true`. Все шесть embedded public flags
побайтно совпадают с metadata принятой сборки 15.

В фактическом Info.plist и архива, и экспортированной IPA подтверждены версия
`0.2.0`, build `16`, Bundle ID `kz.pickchick.app`. Обе подписи прошли
`codesign --verify --deep --strict`. Entitlements архива:
`application-identifier=DAJTP6MC3Q.kz.pickchick.app`, Team `DAJTP6MC3Q`,
`get-task-allow=false`. Embedded `main.jsbundle` присутствует в обеих копиях;
SHA-256 совпадает:
`a61761aba28bfb7fec2203a6ea11161f88e8f4e14d805fb636b67fa01f9983f5`.

Локальный каталог артефактов:
`~/Library/Caches/PickChick/releases/mobile-live-menu-20261009-16-b25f6df6/`.
Архив: `PickChick.xcarchive`; IPA: `export/PickChick.ipa`.

- Размер IPA: **133473223 байта**.
- SHA-256 IPA: `a8655b4b41e8653d34c639ee208ed1a0404505550b9ce21ae45fd30a60c68d62`.
- Доказательства на Mac: `release.json`, `archive.log`, `export.log` в каталоге
  артефактов; `.local/mobile-native16/ci-proof-b25f6df6.json` и
  `artifact-verification.json` в отдельной рабочей копии. Секреты не опубликованы.

## Следующий этап и границы проверки

9 октября в 14:22 UTC выполнена одна штатная попытка `ios_release.py upload`
для App Store Connect `6809208492`. Этот helper делает отдельный export с
`destination=upload` из того же проверенного неизменного `PickChick.xcarchive`;
SHA-256 выше относится к локальному `export/PickChick.ipa`, а не к транспортному
контейнеру Xcode. Source, версия, Bundle ID, флаги и подпись архива сохранены.

Xcode завершил попытку с exit 70: `exportArchive Failed to Use Accounts`.
В Apple Accounts нет вошедшей учётной записи; открыта штатная страница входа.
Временные настройки подписи восстановлены. Safari App Store Connect авторизован,
но последняя видимая сборка - 15; сборки 16 в списке нет. `deliveryStatus` не
установлен. Повторная отправка не выполнялась.

**Принятие upload Apple, processing, доступность группе и установка 16 ещё не
подтверждены.** Следующий шаг - вход владельца в Xcode → Settings → Apple Accounts,
затем проверка отсутствия уже принятой 16 и продолжение с тем же архивом. Пароль
и 2FA вводятся владельцем. После принятия отдельно подтвердить processing и
назначение существующей PickChick Internal. Тестеров, внешние группы, договоры
и публичный App Store release эта операция не меняет.

По подтверждению координатора, API `3bc98faf` и `CUSTOMER_CHECKOUT_HEAD_GUARD=true`
уже установлены независимо от этого native upload. Настройка API не доказывает
установку клиента 16.

На последней read-only проверке paired iPhone имели `tunnelState=unavailable`.
Физически остаётся проверить открытие меню, обновление опубликованной цены в
карточке и корзине, background/foreground с восстановлением сети. Проверки
адаптера и успешная компиляция не заменяют физическую проверку сети iOS.
Обновлять поверх существующего приложения; новый реальный заказ, счёт или
оплата для этой проверки не создаются. iPad 11 этой операцией не затронут.
