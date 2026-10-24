# PickChick Kiosk: постоянная выдача вместо 90-дневного TestFlight

Подготовлено 24.10.2026 (этап 2, полоса kln). Все факты Apple сверены с официальной
документацией в этот день; ссылки - у каждого пункта. Решение о канале принимает владелец;
этим этапом ничего в App Store Connect, Apple Business или на iPad не менялось.

## Сейчас

Киоск `kz.pickchick.kiosk` (запись App Store Connect «PickChick Kiosk», ASC ID `6809407135`)
выдаётся через **внутренний TestFlight**: группа «PickChick Kiosk Internal», без внешних групп и
публичной ссылки ([протокол](kiosk-testflight.md)). Release-хелпер экспортирует киоск только с
`testFlightInternalTestingOnly=true` (`scripts/mobile/ios_release.py`).

Ограничения TestFlight по Apple:

- сборку можно тестировать до 90 дней, после этого она недоступна тестировщикам
  ([TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview));
- внутренние тестировщики - до 100 пользователей App Store Connect (там же);
- внутренняя группа ограничивает аккаунты, а не конкретные iPad.

Для ресторана это значит: каждые ~80 дней новая сборка, установка на каждый iPad со снятием
AppLock, иначе киоск перестанет запускаться. Пока постоянный канал не выбран, это делается по
календарю (см. «Что делать сейчас»).

## Варианты постоянной выдачи

| Вариант                               | Срок жизни установки                          | App Review | Доступность для организации из Казахстана                                                  | Что нужно в коде выпуска                                    |
| ------------------------------------- | --------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| A. Unlisted App Store                 | как у App Store (без 90 дней)                 | да         | Apple: «все регионы, поддерживаемые App Store»; Казахстан есть в списке регионов App Store | экспорт без `testFlightInternalTestingOnly`, отдельный флаг |
| B. Custom App (частная выдача)        | как у App Store                               | да         | через Apple Business; в матрице Казахстана нет «Get Apps» - **не подтверждено**            | то же, что A                                                |
| C. Ad hoc                             | пока действует профиль/сертификат (проверить) | нет        | не зависит от страны; до 100 iPad в год на аккаунт разработчика                            | экспорт с ad hoc профилем (новый режим хелпера)             |
| D. Apple Developer Enterprise Program | -                                             | нет        | не подходит по условиям Apple                                                              | -                                                           |

### A. Unlisted App Store (рекомендуемый кандидат)

Факты Apple ([Unlisted app distribution](https://developer.apple.com/support/unlisted-app-distribution/)):

- приложение не видно в поиске, категориях и подборках, открывается только по прямой ссылке;
  доступно также через Apple Business;
- подходит для управляемых и неуправляемых устройств, «во всех регионах, поддерживаемых App
  Store». Казахстан (KAZ) есть в списке регионов App Store
  ([регионы App Store](https://developer.apple.com/help/app-store-connect/reference/app-store-pricing-and-availability-start-times-by-region/));
- приложение должно пройти App Review; бета или «предварительная» версия получит отказ; в
  заметках для ревью пишут, что нужен unlisted, и подают отдельный запрос;
- приложение доступно любому, у кого есть ссылка: Apple советует собственную защиту от
  постороннего использования. У киоска она есть: без настройки устройства (операторский
  alias и пароль, проверка сервером) приложение показывает только «Настройка киоска» и не
  может создать заказ.

Что сделать владельцу:

1. Решить, что запись «PickChick Kiosk» идёт публичным методом (unlisted). Выбор между A и B
   делается **до первого одобрения**: после одобрения метод не меняется, переход
   private <-> public требует новой записи приложения и новой отправки
   ([Set distribution methods](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/set-distribution-methods/)).
2. Подготовить доступ для App Review: Apple должна войти и пользоваться приложением
   ([Custom Apps](https://support.apple.com/en-gb/guide/business/axm58ba3112a/web): нужны
   тестовые учётные данные или очищенные данные). Для киоска это отдельное устройство-ревью
   (alias и пароль) и код сотрудника для демо-режима, где деньги не списываются. Как не дать
   ревьюеру создать настоящий счёт Kaspi - решение владельца и PM (например, отдельная точка
   без включённой оплаты); этим этапом не реализовано.
3. Отправить сборку на ревью и запрос unlisted.
4. Устанавливать на iPad по ссылке App Store под Apple Account ресторана (или через Apple
   Business, если он будет). Автообновления приложений на киоске выключить и обновлять по
   runbook со снятием AppLock: как iPadOS ведёт себя при обновлении приложения под AppLock -
   проверить на iPad.

Изменение кода, нужное до выпуска (не сделано, требует решения владельца): у
`ios_release.py --app kiosk` появляется явный режим выпуска для ревью, который не ставит
`testFlightInternalTestingOnly`; остальные проверки (профиль, API, release id в бандле) те же.
Сейчас хелпер намеренно не умеет этого, чтобы киоск не попал в App Store случайно - менять эту
защиту без решения нельзя.

### B. Custom App через Apple Business

Факты Apple:

- разработчик выбирает частную выдачу и указывает Organization ID организации; приложение
  появляется в Apps and Books её Apple Business и раздаётся через MDM или коды погашения
  ([Volume Purchase and Custom Apps](https://developer.apple.com/support/volume-purchase-and-custom-apps/),
  [Set distribution methods](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/set-distribution-methods/));
- каждая версия проходит App Review, обычно 1-2 дня
  ([Distribute Custom Apps](https://support.apple.com/guide/deployment/distribute-custom-apps-dep0113f6e18/web));
- лицензии приложений в Apple Business привязаны к стране App Store организации, которая
  берётся из адреса при регистрации
  ([Intro to app and book licenses](https://support.apple.com/en-ae/guide/business/axme19b23f7f/web));
- автоматическая установка приложений настраивается после назначения лицензий
  ([Configure app installation](https://support.apple.com/guide/business/configure-app-installation-axmf6ab5d3eb/web)).

Казахстан в [Feature availability](https://support.apple.com/en-ae/guide/business/axmef1c47twq/web)
(публикация 14.04.2026, проверено 24.10.2026): «Built-in device management», «Managed Apple
Accounts», «Zero-touch deployment», «Brand and Location Management», «Branded Mail».
**«Get Apps» и «Get Books» для Казахстана не указаны.** Значит, получение лицензий (в том числе
Custom App) для казахстанской организации документацией не подтверждено. Это наш вывод из
двух страниц, а не подтверждённый запрет: владелец уточняет у Apple Business до выбора B.

Что сделать владельцу для B (и для MDM вообще):

1. Зарегистрировать организацию в Apple Business: название, адрес, сайт (ускоряет проверку),
   законный представитель, телефон и почта для кодов; D-U-N-S - один из способов проверки, не
   обязателен для регистрации. На проверку 60 дней, иначе данные организации удаляются
   ([Sign up for Apple Business](https://support.apple.com/en-ae/guide/business/axm402206497/web)).
2. Спросить Apple, доступны ли Apps and Books / Custom Apps казахстанской организации.
3. Если да - сообщить разработчику Organization ID («Preferences» -> «Enrollment Information»).

Встроенное управление устройствами доступно в Казахстане и принимает собственный
`.mobileconfig` ([Custom configuration](https://support.apple.com/en-gb/guide/business/axmcf4de99c4/web)),
то есть наш профиль AppLock можно раздавать и без Custom App. iPad добавляются в Apple Business
вручную через Apple Configurator (iPadOS 16+, устройство стирается, после добавления есть
30 дней, когда пользователь может вывести его из Apple Business)
([Add devices using Apple Configurator](https://support.apple.com/en-gb/guide/business/axm200a54d59/web)).

### C. Ad hoc

Факты Apple:

- в аккаунт разработчика можно зарегистрировать до 100 iPad в год членства; отключение
  устройства место не освобождает, сброс списка - в начале нового года членства
  ([Devices overview](https://developer.apple.com/help/account/devices/devices-overview/));
- ad hoc профиль создаёт Account Holder или Admin: App ID, один distribution certificate,
  выбранные зарегистрированные устройства
  ([Create an ad hoc provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-an-ad-hoc-provisioning-profile/));
  приложение запускается только на устройствах из профиля
  ([Distributing your app to registered devices](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices));
- для команд, созданных после 6 июня 2021, ad hoc приложение при первом запуске проверяется
  сервисом Apple: iPad нужен интернет, через firewall должен быть доступен
  `https://ppq.apple.com`, иначе приложение может не запуститься
  ([Provisioning profile updates](https://developer.apple.com/help/account/provisioning-profiles/provisioning-profile-updates/));
- установка `.ipa` через Apple Configurator может потребовать режим разработчика на iPad
  ([Enabling Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device):
  речь о development-подписи; для ad hoc - проверить на iPad).

Не найдено в документации Apple, проверить в портале: срок действия ad hoc профиля и что
происходит с установленным приложением после его истечения. Наш App Store профиль киоска в
портале действует до 30.07.2027 - то есть ad hoc тоже, скорее всего, придётся
переподписывать и переустанавливать раз в год.

Что сделать владельцу: собрать UDID каждого ресторанного iPad (Finder или Apple Configurator),
зарегистрировать их, создать ad hoc профиль `kz.pickchick.kiosk`. В коде нужен новый режим
экспорта хелпера с ad hoc профилем (метод экспорта сверить с `xcodebuild -help` установленного
Xcode); этим этапом не сделан.

### D. Apple Developer Enterprise Program - не подходит

Apple требует 100+ сотрудников, юридическое лицо, D-U-N-S, раздачу только своим сотрудникам и
прямо пишет, что программа - для случаев, которые не решаются App Store, Custom Apps через
Apple Business, ad hoc или TestFlight; 299 USD в год
([Apple Developer Enterprise Program](https://developer.apple.com/programs/enterprise/)).

## Что делать сейчас

1. Пока канал не выбран - внутренний TestFlight. В календарь: дата загрузки каждой сборки +
   80 дней = крайний срок новой сборки; установка по
   [runbook](ipad-kiosk-onsite-runbook.md) (снять AppLock, обновить, вернуть, проверить
   «Состояние киоска»). Обновлять только при пустом киоске, без неизвестной оплаты.
2. Владелец выбирает A или B (после ответа Apple Business), либо C для небольшого числа iPad.
3. После выбора - отдельная задача на режим выпуска в `ios_release.py` с тестами
   `tests/mobile/test_ios_kiosk_release.py` и на процедуру App Review.
