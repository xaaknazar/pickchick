# Сборка App Store без «скоро» и без Apple Pay (29.10.2026)

Ветка `codex/mobile-appstore-clean-1029` от `codex/mobile-launch-1028` = `c36287e7` (TestFlight 26,
исправления QA сборки 25, «приложение всегда открывается на меню»). Проверено локально на
веб-экспортах с изолированными фикстурами: без банка, без реальных клиентов, без запросов к VPS,
Kaspi или Apple. Push не выполнялся.

Две части: первая версия полосы (коммиты до `27ac1f45`) и исправления по проверке техлида и
проходу «как ревьюер Apple» того же дня (раздел «Проверка 29.10» ниже, дополнения A-C задания).

## Что сказал владелец и почему

PickChick 1.0 (сборка 23) на ускоренной проверке App Review. App Review Guideline 2.1 (App
Completeness) отклоняет заглушки, «coming soon» и функции, которые не работают; одному
разработчику Apple велела убрать все упоминания Apple Pay, раз приложение им не пользуется. В
приложении было много таких текстов. Владелец 29.10: «устрани это все».

Сборка App Store - это Kaspi-сборка клиента (`EXPO_PUBLIC_KASPI_CHECKOUT=1`): профили
`storefront` и `production` в `scripts/mobile/ios_release.py` (`EXPO_PUBLIC_CUSTOMER_AUTH=server`,
опубликованный каталог, тестовые заказы и ферма выключены). Все правила ниже действуют в ней;
сборки симулятора, тестовых заказов, дизайн-каталог и дизайн-превью (`?preview=1`) показывают
всё, как раньше (кроме общих правок текста и переводов).

## Проверка 29.10: что было не так и что сделано

### A. Аккаунт App Review на шаге оплаты (блокирующее)

Сервер отвечает 403 FORBIDDEN на `POST /v1/customer-checkout/orders` для номера App Review
(`customer-checkout-controller.ts`, `execute` - до создания чего-либо; сервер не менялся).

Было: нажатие «Оплатить с Kaspi.kz» или полоса корзины сохраняли намерение оплаты, приходил
FORBIDDEN, и из-за сохранённого намерения экран оставался на «Связываемся с рестораном» с
кнопкой «Проверить оплату», которая снова слала `POST /orders` (снова FORBIDDEN); через 20 с -
«Ресторан не подтверждает заказ - Ресторан пока не ответил». Текст FORBIDDEN («Оплата Kaspi ещё
не открыта для вашего аккаунта», EN «...not enabled for your account yet») не показывался вовсе,
а сам был тем «ещё не», за которое Apple отклоняет. Скриншот команды
`.local/slide-to-pay/review-account-press-320.png` показывал этот же спиннер.

Стало:

- `recover()` (`KaspiCheckoutScreen.tsx`): авторитетный 403 FORBIDDEN на команду создания
  (`orderingForbidden` в `checkout-preflight.ts`: только настоящий ответ сервера 403 с кодом
  FORBIDDEN) удаляет намерение так же, как `QUOTE_EXPIRED`: заказа не существует, ждать нечего.
  Экран возвращается в корзину, корзина сохраняется, повторов в фоне нет.
- Корзина показывает «Для этого аккаунта оплата заказов выключена. Как проходит заказ - можно
  посмотреть без оплаты.» (EN «Ordering is turned off for this account. You can see how ordering
  works without payment.», KK «Бұл аккаунт үшін тапсырыстарды төлеу өшірілген. Тапсырыстың қалай
  өтетінін төлемсіз көруге болады.») и кнопку «Как проходит заказ» / «How ordering works» /
  «Тапсырыс қалай орындалады» (`checkout-forbidden-demo`), открывающую `/demo-order` с этой
  корзиной. Кнопки «Попробовать снова» для этого случая нет. Новое нажатие «Оплатить» - снова
  одна котировка и один отказ, счёт (`/payment`) не создаётся никогда.
- FORBIDDEN на чтении («Оформление пока недоступно для вашего аккаунта», EN «...yet») ->
  «Для этого аккаунта оформление заказов выключено. Корзина сохранена.»
- Охрана оплаты не ослаблена: FORBIDDEN на команду счёта (`POST /payment`) по-прежнему оставляет
  заказ с тихой кнопкой «Отправить счёт на ...» (так проверяет `browser_kaspi_checkout.py`);
  неразборчивый ответ (не конверт ошибки сервера) не считается отказом и ведёт себя как раньше.

Проверка: новый `tests/mobile/browser_review_account.py` (синтетический 403 FORBIDDEN на POST:
RU 393, EN и KK 320, нажатие и полоса; текст, кнопка, нет экрана «Связываемся», ровно одна
котировка и один отказ на каждое явное действие, ни одного `/payment`, ничего нового через 22 с,
корзина на месте, намерения в хранилище нет, демонстрация открывается с этой корзиной,
перезапуск ничего не шлёт и не показывает баннер возобновления), сценарий F
`browser_slide_to_pay.py` и шаг оплаты в обходе `browser_store_walk.py`.
`browser_kaspi_checkout.py` и `browser_checkout_legal.py` ждут новый текст и кнопку;
`browser_published_catalog.py` (интеграционный, нужен PostgreSQL) переписан под новое поведение,
здесь не запускался.

### B. Охрана текста шире (блокирующее)

Общий список `tests/mobile/store-copy-patterns.json` для теста исходников и для обхода в
браузере. Добавлены: RU «ещё не / еще не / пока не / пока нет / пока недоступно», «а пока»,
«пока их / пока можно», «станет доступ», «будет доступ», «после запуска», «уточняется»; KK «әлі»,
«әзірге» (отдельным словом: «Мәзірге» и «мәліметтері» не ловятся), «қосылуда», «нақтыланып
жатыр»; EN «yet», «will be available», «available later», «for now», «in the meantime», «once ...
connected / enabled / launched / approved / published / available», «after launch», «not
enabled», «being confirmed»; программа Чиков (RU «Чики / Чиков / ...», KK «Чиктер», EN «Chiki»;
персонаж игры «Чик» в единственном числе разрешён); заглушки «Без фото» / «Фотосыз» / «No photo»;
«банковская карта» / «bank card». Мутации проверяющего («Оплата картой ещё не доступна», «Card
payments will be available later», «Карта қосылуда») и `true || upcomingFeaturesShown(...)`
теперь роняют тест (проверено).

Ворота проверяются по синтаксическому дереву: каждое использование выражения-ворот (или
переменной, где оно хранится) должно быть условием `?:`, `if` или цепочки `&&`, но не частью `||`
или `!`. Тест сам портит каждые ворота (`true || x`, `x || true`, `!x`) и ждёт падения. Целые
файлы вне сборки App Store (`screens/OrderScreens.tsx`, `loyalty/PeakScreens.tsx`,
`loyalty/peaks.ts`) перечислены с проверкой, кто их импортирует.

Переписано (все сборки):

| Было                                                                               | Стало                                                                                    |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| «Оплата Kaspi ещё не открыта для вашего аккаунта.»                                 | «Для этого аккаунта оплата заказов выключена. Как проходит заказ - ...» + кнопка         |
| «Оформление пока недоступно для вашего аккаунта. Корзина сохранена.»               | «Для этого аккаунта оформление заказов выключено. Корзина сохранена.»                    |
| «Ресторан пока не готов принимать заказы. Корзина сохранена.»                      | «Ресторан сейчас не принимает заказы. Корзина сохранена.»                                |
| «Позиция ресторана. Оформление пока недоступно.» (серверное меню)                  | «Позиция меню ресторана.»                                                                |
| «Оценка этого заказа пока недоступна.» (сервер выключил отзывы)                    | блока оценки нет; если оценка уже была - «Оценки сейчас не принимаются.»                 |
| «Чек выпущен. Ссылка пока недоступна.» / «...Ссылка на него уточняется.»           | «Чек выпущен.» / «Чек выпущен»                                                           |
| «Документы ещё не опубликованы. Вход по SMS станет доступен после их утверждения.» | «Документы сейчас недоступны, поэтому вход по номеру телефона закрыт. Попробуйте позже.» |
| «Доступность пока не подтверждена» / «Приём заказов пока недоступен»               | «Не удалось проверить доступность» / «Приём заказов сейчас недоступен»                   |
| «Сведения об аллергенах ресторан ещё не подтвердил.»                               | «Ресторан не указал аллергены этой позиции. Уточните у сотрудника.»                      |
| «Данные уточняются.» (пищевая ценность)                                            | «Пищевая ценность не указана.»                                                           |
| «Позиция / Игра / Заказы / Подтверждение номера пока недоступн...»                 | «... сейчас недоступн...»                                                                |
| «Здесь пока тихо» (EN «Nothing here yet»)                                          | «Корзина пуста»                                                                          |
| «Часы уточняются»                                                                  | «Часы работы не указаны»                                                                 |
| «Мы готовим каталог этого ресторана.» (пустое меню)                                | «Позиции этого ресторана сейчас не загрузились. Обновите меню.»                          |
| «Прогресс / Игра / Партия / Рекорд пока не сохран...»                              | «... не сохран...»                                                                       |
| «Бумажные отметки и право на подарок пока учитываются на кассе.» (карточка 6 + 1)  | без «пока»                                                                               |
| KK «Ал жаңа шың әлі алда» (Pick Blocks)                                            | «Ал жаңа шың - алда»                                                                     |

Оставлено как реальное состояние (список `states`, причина у каждого): «Проверяем, что кухня
может принять заказ. Счёт ещё не выставлен.», «Счёт ещё не пришёл в Kaspi...» (Kaspi не ответил
за 20 с), «Ресторан пока не ответил...» (ресторан не ответил за 20 с), «счёт ещё не отправлен»
(неоплаченный заказ в «Заказах»), «Пока не работаем» (закрыто; EN «Closed for now»), прощание
«Будем ждать снова!» (EN «...soon!»).

### Остальное блокирующее

- **Чики.** Экран входа: «Чтобы оформлять заказы, копить Чики и играть в игры» -> «Чтобы
  оформлять заказы и следить за ними». Старт игр: «Личный рекорд на устройстве · очки без
  начисления Чиков» -> «Личный рекорд хранится на этом устройстве»; из подсказок Pick Blocks, Pick
  Man и Pick Run убраны «...не переводятся в Чики / Чики за игру не начисляются».
- **Фото соусов.** У Heinz сырного и барбекю (доп «Добавить к комбо» и соус в комбо) было «Без
  фото». Добавлены `assets/catalog-hd/sauce-cheese.png` и `sauce-bbq.png`: прозрачная баночка из
  `signature-small.png` с перекрашенным соусом, без упаковки Heinz (README папки). Где фото нет
  совсем (будущие позиции каталога), вместо серого значка и «Без фото» - знак PickChick.
- **Игры без входа (5.1.1).** В сборке App Store гость открывает «События», Pick Blocks, Pick Man
  и Magic Sort без аккаунта (`guestCanOpen` в `account-access.ts`; вкладка, `AccountGate`,
  `requiresAccount`). Рекорд гостя Magic Sort хранится на устройстве под своим ключом `guest`.
  Заказы, профиль и Pick Farm по-прежнему требуют входа; другие сборки - как раньше.
- **«Настройки».** Экран шестерёнки называется «Настройки» (было «Язык приложения» / «Язык и
  уведомления»), «Язык приложения» - заголовок раздела; подпись шестерёнки «Настройки» (было
  «Настройки профиля»); строка «Конфиденциальность» - «Документы и ваши данные» (было «Как будут
  обрабатываться согласия»).

### Мелкое (исправлено)

- Ворота в тесте проверяются структурно (см. B).
- Обход идёт и на профиле `storefront` (опубликованный каталог, без тестовых заказов; CI собирает
  его отдельно, `PICKCHICK_PREVIEW_OUTPUT=storefront`), доходит до шага оплаты (FORBIDDEN,
  ресторан не отвечает, Kaspi медленно), удаляет аккаунт и открывает игры гостем.
- `EXPO_PUBLIC_UPCOMING_PAYMENTS=1` открыт в браузере: новый `browser_upcoming_payments.py`.
- Английский без русского (обход проверяет: в EN на экране и в accessible names нет кириллицы,
  кроме названий языков в выборе языка): «Готов к выдаче at 11:40» -> «Ready for collection at
  11:40»; модификаторы в корзине, статусе и демо; описания игр в карусели «Играй, пока готовим»
  (переводились уже склеенные в одну строку); «ТЦ Abay Plaza · Kaspi», адрес и «Алматы · 1
  ресторан» («1 restaurant», KK «1 мейрамхана»); a11y: «Close: Корзина», «Date of birth: Выбрать»,
  «Order number 15, Готов», «Подробнее о заказе», «Pick Combo, 4 190 ₸, выбрать», «Play PICK
  BLOCKS. Заполняй ряды...», «Increase / Decrease / Swap» на странице блюда, «City: Алматы»,
  «Open ТЦ Abay Plaza in 2GIS».
- «Помощь»: карточка больше не похожа на кнопку (информационная «Поддержка в ресторане» с текстом
  про кассу; кнопка контакта появляется внутри, только если в релиз передан
  `EXPO_PUBLIC_SUPPORT_URL`), вступление без «данных карты» и чата: «Подойдите к кассе ресторана и
  назовите номер заказа. Никому не сообщайте код входа.» Телефона или почты в репозитории нет -
  их может задать владелец через `EXPO_PUBLIC_SUPPORT_URL` (tel:/mailto:/https).
- Уведомления: пустой список - «Новых сообщений нет / Сюда приходят сообщения о ваших заказах.
  Статус каждого заказа есть в разделе «Заказы».» Вкладки «Для вас» в сборке App Store нет: в неё
  не приходит ничего ни при каком состоянии сервера.
- Удаление аккаунта: после подтверждения - «Аккаунт удалён. Профиль и доступ на всех ваших
  устройствах удалены.»
- Документы: убрано «Согласие на сообщения об акциях запрашивается отдельно» (такого запроса нет).
- Демонстрация: «Покупка и чек не создавались» (без «бонусов»).
- «События»: подзаголовок «Мини-игры Pick Chick: рекорды сохраняются на этом устройстве.»
- Риск 4.1 / 5.2.1: соперники Pick Man - огоньки вместо «привидений»; обложка Pick Man без
  привидений и табло «1UP / HIGH SCORE» (`assets/games/pick-man-cover-store.png`, оригинал
  владельца сохранён, `assets/games/pick-man-art.md`).
- «Мои данные» с незаполненным профилем (из «Изменить профиль», «Мои данные», «Дата рождения»):
  есть «Отмена» назад в профиль без сохранения. В первом входе (лист входа) - как раньше.
- «Меню обновляется»: «Позиции этого ресторана сейчас не загрузились. Обновите меню.»
- Сервер превью: старый процесс на порту 5296 к моменту работы уже не существовал; свои серверы
  этой работы остановлены.

### Не сделано, с причиной

- **Pick Blocks похож на Tetris** (поле 10 x 20, семь фигур, задержка фиксации): это механика
  игры, её переделка - отдельная задача владельца. Если риск неприемлем до ответа Apple, игру
  можно выключить в бэк-офисе (`gameEnabled('pick-blocks')`), без новой сборки.
- Тексты, которые приходят с сервера (акции бэк-офиса, названия позиций каталога без перевода,
  тексты push), охраной не проверяются.

## C. Сверка с черновиком заметок для Apple (`review-notes-1029.en.txt`, файл не менялся)

Проверено в браузере на этой сборке (обход и `browser_review_account.py`):

| Что сказано в заметках                                                               | В сборке                                                                                                      | Итог                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Profile > Language                                                                   | строка профиля «Язык» / «Language» открывает «Настройки» с выбором языка                                      | есть                     |
| Profile > Settings (gear icon) > «How ordering works»                                | шестерёнка «Настройки» / «Settings» -> экран «Настройки» -> «Как проходит заказ» -> демонстрация без запросов | есть (после этой правки) |
| on the payment step it says so and offers «How ordering works»                       | FORBIDDEN-текст + кнопка «How ordering works» (раздел A)                                                      | есть (после этой правки) |
| Profile > Manage data > Delete account                                               | «Управление данными» / «Manage data» -> «Удалить аккаунт» -> подтверждение -> DELETE -> «Аккаунт удалён»      | есть                     |
| play the mini-games                                                                  | гость тоже                                                                                                    | есть                     |
| Step 1: «choose Sign in»                                                             | кнопка на экране входа - «По номеру телефона» / «With your phone number»                                      | расхождение              |
| «Outside these hours the app shows "The restaurant is closed" with the opening time» | шапка и красная плашка корзины «Opening at 10:00» (`откроемся в 10:00`), серая кнопка «Closed for now»        | расхождение              |
| `[HOURS - confirm with GET availability]`, `[IF ATTACHED]`                           | незаполненные места                                                                                           | заполнить владельцу      |

Предлагаемые формулировки для заметок (решает владелец): шаг 1 - «tap the profile icon (top
right) and choose "With your phone number"»; часы - «Outside these hours the app shows "Opening at
10:00" and the pay button reads "Closed for now"».

## Что изменилось для клиента (сборка App Store), первая версия полосы

1. **Оплата - только Kaspi.kz.** «Способ оплаты» в корзине показывает одну строку Kaspi.kz. Нет
   строк «Apple Pay» / «Google Pay» / «Банковская карта» с «СКОРО», их названий, a11y-текстов
   («Apple Pay, скоро») и значков Apple / Google. Ручка полосы корзины и кнопка оплаты - Kaspi.
   Логика «последний способ оплаты» (6б) сохранена: сохранённый Apple Pay или карта из будущей
   сборки по-прежнему падают на Kaspi и не стираются.
2. **Программа Чиков не живая - у неё нет входа.** Убраны карточка меню «Чики за любимый вкус ·
   6 вершин Алматы · скоро», в профиле «Мои Чики и уровни» и группа «Программа Чиков» («Награды
   и миссии», «Промокоды · Скоро»). Старая или прямая ссылка на `/screen/M23`, `M24`, `M25`
   (Чики, история, миссии), `M22` (заглушка возврата) и `M35` (заглушка оценки; в Kaspi-сборке
   заказ оценивается на самом заказе) открывает «Меню».
3. **«События»** - только игры. Разделы «Миссии» и «Скоро» убраны.
4. **Карточка «Купи 6 комбо, 7-е в подарок»** - только пока сервер ведёт программу (решение
   ниже). Пустой заголовок «Акции» без карточки и без опубликованных акций не показывается.
5. **Настройки уведомлений** («О моих заказах», «События и предложения») - только когда сервер
   подключил push для этой платформы (`/v1/notifications/config`). Пока нет - ни выключенных
   переключателей, ни «Сервис уведомлений ещё не подключён». Строка «Уведомления» в профиле
   (требование владельца 27.10) осталась.
6. **Фискальный чек.** У каждого заказа из приложения сейчас `receipt: deferred` (сервер:
   `fiscalPolicy: deferred_pilot`). Для такого заказа плитки «Чек» на статусе и блока «Фискальный
   чек» на завершённом заказе нет. Если сервер вернёт `pending` или `issued`, показывается.
7. **Помощь.** Формы «написать сообщение» нет; строка ресторана с адресом открывает «Наши
   рестораны». В окне «...» статуса заказа - «Обратитесь к сотруднику ресторана и назовите номер
   заказа.»
8. **Мелкие тексты во всех сборках:** «Фото скоро» -> знак PickChick; пустое меню «Меню скоро
   появится» -> «Меню обновляется»; выключенная игра «Загляни позже...» -> «Выбери другую игру в
   «Событиях»»; в составе блюда серверного меню нет «перенесены из макета»; неиспользуемый
   компонент `PaymentChoice` («Онлайн-оплата скоро появится») удалён.

## Решение по карточке 6 + 1 (с доказательством)

Программа на сервере выключена: `docs/project-status.md` («На сервере акция выключена»), `README.md`
этой папки («`CUSTOMER_COMBO_REWARDS_ENABLED` выключен, отметок клиентов нет»). Сервер отвечает
`/v1/customer-checkout/combo-rewards` -> `{enabled: false}`. Решение: в сборке App Store карточка
видна только когда сервер отвечает `enabled: true` с отметками клиента (`comboCardShown` в
`apps/mobile/src/store-build.ts`). Когда владелец включит программу на сервере, карточка
появится сама, без новой сборки. Минус: гость не видит акцию, пока не войдёт.

## Флаг `EXPO_PUBLIC_UPCOMING_PAYMENTS` и что владелец теряет визуально

- По умолчанию выключен. «Способ оплаты» перечисляет только способы, которые платят сейчас.
- `EXPO_PUBLIC_UPCOMING_PAYMENTS=1` возвращает прежний вид: Kaspi.kz выбран, «Apple Pay» (на
  Android «Google Pay») - СКОРО, «Банковская карта» - СКОРО, серые и не выбираются (скриншот
  `.local/upcoming-payments/selector-flag-393.png`).
- Как вернуть: добавить `"EXPO_PUBLIC_UPCOMING_PAYMENTS": "1"` в нужный профиль
  `scripts/mobile/ios_release.py` (для локального Metro/экспорта - переменная окружения).
  Значение, случайно оставшееся в оболочке, в архив не попадает (`archive_environment`).

## Охраны оплаты

`submit` / `pay` / намерения оплаты (аудит 19.10: 0.2, 2.0, 2.1, 2.4, 2.5) не ослаблены.
Единственное изменение - отказ FORBIDDEN на команду создания удаляет намерение, которому не
соответствует ни один заказ (как истёкшая котировка); всё остальное (неизвестный исход, сбой
связи, FORBIDDEN на счёт, закрытие оплаты) работает как раньше, это проверяют прежние сценарии.

## Проверки

Проверка 29.10, на финальном коде (экспорты пересобраны после последней правки приложения):

- `pnpm test:mobile` - 550/550 node-тестов (было 542: +6 `store-review.test.mjs`, +2 в
  `store-copy.test.mjs`) и 59 Python-тестов (1 пропущен, как раньше); `pnpm typecheck` (все
  пакеты), `pnpm lint`, `pnpm format:check`, `node scripts/mobile/translations.mjs --check`,
  `pnpm design:check` - без ошибок.
- Мутации охраны (вручную, затем откат): `true || upcomingFeaturesShown(...)` в профиле, строки
  «Оплата картой ещё не доступна», «Card payments will be available later», «Карта қосылуда» -
  `store-copy.test.mjs` падает в каждом случае.

Браузер, профиль App Store `storefront` (опубликованный каталог, без тестовых заказов; порт 5197,
`PICKCHICK_PREVIEW_OUTPUT=storefront`):

- `browser_store_walk.py` (`STORE_WALK_PROFILE=storefront`) - PASS, 80 экранов, ни одного запроса
  `/v1/test/*`, ни одной лишней записи; шаг оплаты (FORBIDDEN + демонстрация, ресторан не отвечает,
  Kaspi медленно), удаление аккаунта, игры гостем, EN без кириллицы.

Браузер, Kaspi-экспорт QA (порт 5196):

- `browser_store_walk.py` - PASS, 80 экранов (тот же обход).
- `browser_review_account.py` (новый) - PASS.
- `browser_kaspi_checkout.py` (320, 393, 768, 852), `browser_checkout_legal.py`,
  `browser_checkout_traps.py`, `browser_launch_resume.py` A-H, `browser_cart_page.py`,
  `browser_slide_to_pay.py` A-P - PASS на финальном экспорте.
- `browser_review_demo.py`, `browser_localization.py`, `browser_combo_rewards.py`,
  `browser_tracker_redesign.py` kaspi, `browser_orders_redesign.py kaspi` (393 и 320),
  `browser_cart_unavailable.py` A-O, `browser_cart_layer.py` kaspi - PASS на экспорте до
  последней правки (она вернула прежнее поведение FORBIDDEN на `/payment` и этих сценариев не
  касается).

Браузер, экспорт с `EXPO_PUBLIC_UPCOMING_PAYMENTS=1` (порт 5198): `browser_upcoming_payments.py`
(новый) - PASS.

Браузер, экспорт симулятора (порт 5182; там всё показывается, как раньше): `browser_profile.py`,
`browser_account_required.py` (стена входа для игр в этой сборке осталась), `browser_peak_loyalty.py`,
`browser_pick_man.py`, `browser_pick_blocks.py`, `browser_cart_sheet.py`,
`browser_catalog_recovery.py`, `browser_demo_account.py`, `browser_complete_catalog.py`,
`browser_menu_recovery.py`, `browser_tab_bar.py`, `browser_tracker_redesign.py` sim,
`browser_orders_redesign.py sim`, `browser_cart_layer.py` sim, `browser_restaurants_redesign.py` -
PASS. `browser_ux_guidance.py` - FAIL на строке 77 (`modifier-drink-cola-bottle`): этот testID есть
только в старом `ProductConfiguration`, а меню открывает `PhotoProduct` уже на основе `c36287e7`;
до изменённых строк тест не доходит, к этой работе не относится.

Скриншоты (профиль `storefront`, 393 x 852, плюс EN, KK, 320 x 568, гость, шаг оплаты, флаг):
`.local/mobile-1029/store/*.png`, обзорный лист `.local/mobile-1029/store/overview-store.png`;
те же экраны на QA-экспорте - `.local/mobile-1029/store-qa/`.

## Не проверено

- Реальный iPhone (iOS 26) и сборка TestFlight с этими изменениями: нужна новая сборка (номер не
  менялся). VoiceOver: чтение текста FORBIDDEN, «Как проходит заказ», карточки «Помощи».
- Настоящий ответ прода для номера App Review (FORBIDDEN с конвертом ошибки) проверен по коду
  `customer-checkout-controller.ts` и фикстурой с тем же конвертом; запрос к серверу не делался.
- `browser_published_catalog.py` (нужен PostgreSQL) переписан, но не запускался.
- Ответы прода, на которых держатся решения: `/combo-rewards` -> `{enabled: false}`,
  `/v1/notifications/config` (push для `apns` не включён), `receipt: deferred`. Перед отправкой
  стоит одним GET убедиться в первых двух.
- Ссылки дизайн-превью (`?preview=1`) показывают образцы дизайна; из интерфейса туда не попасть.
- Android (Google Pay в списке не появится так же, как Apple Pay на iOS) - только unit-тест.

## Границы и риски

- Конфликты с другими полосами вероятны в `apps/mobile/src/i18n/messages.json`,
  `docs/translations/*` (перегенерировать `node scripts/mobile/translations.mjs`),
  `screens/KaspiCheckoutScreen.tsx`, `screens/ProfileScreens.tsx`, `screens/CatalogScreens.tsx`,
  `.github/workflows/ci.yml`. Новая строка «скоро / ещё не / yet» из другой полосы уронит
  `store-copy.test.mjs` - это задумано.
- Изменение поведения: гость сборки App Store играет без входа (другие сборки - как раньше);
  обложка и соперники Pick Man другие.
- `docs/project-status.md`, `docs/roadmap/project.json`, `handoff.md` не менялись.

## Файлы

Проверка 29.10 (поверх первой версии):

- Шаг оплаты: `apps/mobile/src/screens/KaspiCheckoutScreen.tsx`, `checkout-preflight.ts`
  (`orderingForbidden`), `commerce-presentation.ts` (`ORDERING_FORBIDDEN`),
  `commerce-read-recovery.ts`.
- Игры гостем: `account-access.ts` (`guestCanOpen`), `components/AccountGate.tsx`,
  `app/(tabs)/_layout.tsx`, `games/magic-sort/useMagicSort.ts`.
- Тексты и экраны: `screens/ProfileScreens.tsx` (помощь, удаление, документы, «Настройки»),
  `screens/ProfileScreen.tsx`, `screens/RegistrationScreen.tsx` («Отмена»), `app/notifications.tsx`,
  `screens/CompletedOrderScreen.tsx` (оценка), `screens/PhotoProduct.tsx` (знак вместо «Без
  фото», a11y), `screens/ProductConfiguration.tsx`, `screens/CatalogScreens.tsx`,
  `screens/ReviewDemoScreen.tsx`, `screens/GameScreens.tsx`, `screens/AuthScreens.tsx`,
  `components/AuthWelcome.tsx`, `components/ComboRewardCard.tsx`, `components/Restaurants.tsx`,
  `app/product-photo.tsx`, `backoffice/GameAvailability.tsx`, `catalog.ts`, `restaurant-hours.ts`,
  `useTestOrders.ts`, игры (`ArcadeExperience.tsx`, Pick Blocks, Pick Man, Pick Run, Magic Sort).
- Английский: `order-status.ts`, `domain.ts` (`selectionDescription`), `components/GameCarousel.tsx`,
  `games/useOrderGames.ts`, `games/GamePosterCard.tsx`, `components/OrdersTab.tsx`,
  `components/OrderHistoryCard.tsx`, `components/OrderSheet.tsx`, `screens/OrderStatusScreen.tsx`,
  `screens/ConnectedOrderScreens.tsx`.
- Картинки: `assets/catalog-hd/sauce-cheese.png`, `sauce-bbq.png` (+ README),
  `assets/games/pick-man-cover-store.png` (+ `pick-man-art.md`), `src/assets.ts`,
  `src/product-photo-assets.ts`, `games/pick-man/visuals.tsx` (огоньки).
- `apps/mobile/src/i18n/messages.json` (38 строк переписаны в RU/KK/EN, у 1 изменён только KK/EN, 6 новых, 5 неиспользуемых удалены) и
  `docs/translations/mobile-ru-kk-en.{md,html}`.
- `scripts/mobile/preview-server.mjs` (выход `storefront`), `.github/workflows/ci.yml` (обход на
  профиле `storefront`, `browser_review_account.py`).
- Тесты: `store-copy-patterns.json`, `store-copy.test.mjs`, `store-review.test.mjs` (новые или
  переписанные), `browser_store_walk.py`, `browser_review_account.py`,
  `browser_upcoming_payments.py` (новые или переписанные), `browser_slide_to_pay.py` (F),
  `browser_kaspi_checkout.py`, `browser_checkout_legal.py`, `browser_published_catalog.py`,
  `browser_localization.py`, `browser_ux_guidance.py`, `browser_cart_sheet.py`,
  `browser_catalog_recovery.py`, `browser_live_menu_update.py`, `payment-availability.test.mjs`.

Первая версия: `apps/mobile/src/store-build.ts` (новый), `payment-method.ts`, `PaymentChoice.tsx`,
`CartSheet.tsx`, `ScreenHost.tsx`, `CatalogScreens.tsx`, `ProfileScreen.tsx`, `ProfileScreens.tsx`,
`GameScreens.tsx`, `CartExtras.tsx`, `notifications/provider.tsx`, `KaspiCheckoutScreen.tsx`,
`CompletedOrderScreen.tsx`, `OrderActions.tsx`, `PhotoProduct.tsx`, `ProductConfiguration.tsx`,
`GameAvailability.tsx`, `app/notifications.tsx`, `scripts/mobile/ios_release.py`, тесты
`store-build.test.mjs`, `payment-method.test.mjs`, `cart-page.test.mjs`, `test_ios_release.py`,
`browser_cart_page.py`, `browser_combo_rewards.py`, `browser_tracker_redesign.py`.
