# Редизайн 27.10.2026: шапка с профилем, три вкладки, уведомления в профиле

Линия `hdr`, ветка `codex/mobile-header-1027` от `82ddc326` (сборка 23). Корзина и
оплата свайпом - отдельная линия `cart`; её файлы здесь не менялись.

## Что изменилось для клиента

- **Шапка как в Drinkit, на всех трёх вкладках.** Слева логотип, название точки и
  часы работы (нажатие открывает выбор ресторана M05, как раньше). Справа, у правого
  поля страницы (18 pt), одна круглая кнопка профиля 48 pt: белый силуэт в тёмно-синем
  стеклянном кольце, наши цвета (`header-profile`). Колокольчик из шапки убран.
  Индикатора непрочитанных уведомлений на кнопке нет (ответ владельца).
- **Меню.** Шапка заменила прежнюю строку в `storefront-header`: та же схлопывающаяся
  подложка при прокрутке, те же замеры высоты и закреплённые категории.
- **События и Заказы.** Та же шапка закреплена сверху, под ней прежние заголовки и
  содержимое. Безопасная зона учтена один раз (События - сама шапка, Заказы - `Page`).
  Шапка не сдвигается при переключении вкладок. Pull-to-refresh на этих экранах не
  было и нет; прокрутка и резерв высоты нижней панели не менялись.
- **Нижняя панель: ровно три вкладки** - Меню, События, Заказы. Вкладки профиля нет.
  Гейты входа (События, Заказы) и оранжевый счётчик активных заказов сохранены.
  Три равные ячейки (около 92 pt на 320 и 117 pt на 393), подпись 12 pt вместо 11.
  Самая длинная подпись (каз. «Тапсырыстар», 6,56 em) помещается на 320 pt при обычном
  шрифте; на iOS при максимальном шрифте подпись ужимается до 0,8 (`adjustsFontSizeToFit`),
  а не обрезается.
- **Профиль - отдельный экран поверх вкладок** по тому же адресу `/profile`. Сверху
  закреплённая строка: назад (`profile-back`), «Профиль», настройки. На iOS работает
  системный свайп назад. Все прежние функции профиля на месте. Гость, нажавший кнопку
  профиля, проходит тот же вход, что и раньше через вкладку (`returnTo=M30`), и после
  входа попадает в профиль. Старые ссылки `/profile` открывают профиль.
- **Уведомления внутри профиля.** Строка «Уведомления» (`profile-notifications`) сразу
  под карточкой с именем. Число непрочитанных показывается только внутри этой строки
  (оранжевый счётчик `profile-notifications-count`, доступное имя «Уведомления,
  непрочитанных: N»). Кнопка назад на экране уведомлений возвращает в профиль.

## Навигация (что исправлено вместе с переездом профиля)

- `ScreenHost`: профиль исключён из вкладок; кнопка шапки делает `push('/profile')`,
  сохранение формы M04 возвращает в существующий профиль (`dismissTo`), `returnTo=M30`
  после входа ведёт в `/profile`, редирект M29 ведёт в `/profile`. Переходы из профиля
  на вкладки (Мои заказы, Меню) возвращаются к существующему набору вкладок, а не кладут
  второй поверх профиля.
- `auth.tsx`, `ReviewDemoScreen` (демо DEMO-1), iOS `SmokeTests.swift` переведены на
  новый маршрут и `header-profile`. Push-переход из уведомления по-прежнему ведёт в
  «Заказы».
- Экран уведомлений: назад - в профиль (если истории нет - `replace('/profile')`);
  кнопка пустого состояния возвращает к вкладкам через `dismissTo`.
- Профиль и корзина: на экране профиля нет ни нижней панели, ни корзины (корзина
  показывается только на активной вкладке, как и раньше).

## Файлы

Новые: `apps/mobile/src/components/AppHeader.tsx`, `apps/mobile/src/app/profile.tsx`
(перенесён из `app/(tabs)/profile.tsx`), `tests/mobile/app-header.test.mjs`.
Изменены: `CatalogScreens.tsx` (только шапка меню), `GameScreens.tsx`, `OrdersTab.tsx`
(`OrdersHeader` - его используют все варианты «Заказов», поэтому `KaspiCheckoutScreen`
не тронут), `MobileScreen.tsx` (контекст текущего экрана для шапки), `ProfileScreen.tsx`,
`app/notifications.tsx`, `app/_layout.tsx`, `app/(tabs)/_layout.tsx`, `app/auth.tsx`,
`ScreenHost.tsx` (только маршруты профиля), `ReviewDemoScreen.tsx` (две строки),
`FloatingTabBar.tsx`, `tab-bar-metrics.ts`, `i18n/messages.json` (+2 строки RU/KK/EN:
«Уведомления, непрочитанных: {p0}», «Назад в профиль»). Тесты: `tab-bar.test.mjs`,
`browser_tab_bar.py`, `browser_profile.py`, `browser_customer_account.py`,
`browser_localization.py`, `browser_mockup_fidelity.py`, `browser_review_demo.py`,
`browser_account_required.py`, `tests/operations/layout_regression.py`, `SmokeTests.swift`.

## Проверки (27.10.2026, локально, только фикстуры)

- `pnpm test:mobile`: 403/403 JS и 59 Python (1 пропуск), 0 ошибок.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` - без ошибок.
- Симулятор (`EXPO_PUBLIC_ORDER_SIMULATOR=1`, порт 5182), весь список CI
  `foundation_simulator` кроме `browser_published_photos.py`: прошли `browser_tab_bar`,
  `browser_profile`, `browser_account_required`, `layout_regression` (2 теста),
  `browser_catalog_recovery`, `browser_menu_recovery`, `browser_demo_account`,
  `browser_complete_catalog`, `browser_restaurants_redesign`, `browser_orders_redesign sim`,
  `browser_tracker_redesign`, `browser_pick_blocks`, `browser_pick_man`, `browser_arcade`,
  `browser_arcade_motion`, `browser_peak_loyalty`; `browser_magic_sort` - со второго
  запуска (первый упал на временной проверке под нагрузкой двух линий).
  `browser_mockup_fidelity` падает на строке 74 (`video` count): локальный Chromium 141
  не умеет H.264 (`canPlayType` пустой), видео витрины уходит в постер. Это окружение,
  не шапка: копия теста без двух проверок видео прошла все проверки шапки, профиля,
  уведомлений и длинного названия ресторана на 320/402 и упала дальше на той же причине
  (строка 219, пауза/воспроизведение видео).
- Kaspi/customer-auth (`EXPO_PUBLIC_CUSTOMER_AUTH=server EXPO_PUBLIC_KASPI_CHECKOUT=1
EXPO_PUBLIC_UNPAID_TEST_ORDERS=1`, порт 5196): прошли `browser_review_demo` (320/393,
  kk/ru/en, гость - шапка и вход по кнопке профиля), `browser_localization` (с одним
  непрочитанным), `browser_orders_redesign kaspi` (393 и 320x568), `browser_checkout_legal`,
  `browser_checkout_traps`, `browser_combo_rewards`, `browser_tracker_redesign`
  (`TRACKER_MODE=kaspi`), `browser_kaspi_checkout`.
- Customer-auth без Kaspi (как первый экспорт CI): `browser_customer_account` прошёл
  (320/390/430).
- Снимки для владельца (393x852 и 320x568): `.local/mobile-1027/hdr/` - меню, меню при
  прокрутке, События, Заказы, профиль с непрочитанным, уведомления, гость после нажатия
  кнопки профиля.

## Не проверено

- Реальный iPhone: свайп назад с профиля, нажатия, Dynamic Type на устройстве
  (проверены лимиты `maxFontSizeMultiplier` и измеренные ширины подписей), VoiceOver.
- iOS XCUITest `SmokeTests.swift` обновлён, но не запускался (нет macOS). При запросе по
  `header-profile` XCUITest берёт первое совпадение; все вызовы сделаны с меню сразу
  после запуска, когда другие вкладки ещё не смонтированы.
- Реальные push и APNs; переход из уведомления в «Заказы» не менялся.
- `browser_published_photos.py` и задания `foundation_mobile` (`browser_checkout.py`,
  `browser_cart_sheet.py`) не запускались: их экспорт и область - не эта линия.

## Для интеграции

- `tests/mobile/browser_cart_shortcut.py` (файл линии `cart`, не в CI) ещё ссылается на
  `tab-profile` и `('profile', 'M30')`; при слиянии убрать профиль из списка вкладок.
- Корзина над нижней панелью: логика `ScreenHost` (`activeTab`, `bottomOffset`) не
  менялась; на `/profile` корзины нет.
- Перевод `docs/translations/mobile-ru-kk-en.*` не перегенерирован
  (`node scripts/mobile/translations.mjs`), проверки в CI нет.
- Осторожно с параллельными экспортами: `/tmp/metro-cache` общий для рабочих копий.
  Первый Kaspi-экспорт этой линии получил `kaspiCheckoutEnabled=false`, хотя переменная
  была задана, - вероятно, кэш преобразований из параллельного экспорта другой линии.
  После экспорта проверять флаг в бандле или экспортировать по очереди.
