# Сборка 33: повторная отправка в App Store на нашем домене (31.10.2026)

Ветка `codex/mobile-build33-1031` от `origin/codex/shared-development` `e4eb91b5` (= TestFlight 32:
казахская вычитка, вкладка «Игры», прямое «Удалить аккаунт» для Apple 5.1.1(v)). Код приложения
в этой полосе не менялся: перенесены проверки домена, инструменты выпуска и тексты, написаны
заметки для App Review и черновик ответа Apple. Всё проверено локально на веб-экспортах с
изолированными фикстурами: ни одного запроса к VPS, `api.pickchick.kz`, Kaspi или Apple. Push не
выполнялся, номер сборки не менялся (в `app.json` по-прежнему `32`, поднимает Codex).

## Почему

Apple 30.10 отклонила 1.0 / сборку 23 только по 5.1.1(v): не найдено удаление аккаунта. Сборка 32
это исправила. Владелец 30.10: «переводи на наш домен» - сборка для App Store, собранная со
staging-адресом nip.io, перестанет работать у всех, кто её установил, когда сервер переедет.
Сборки 30-32 собраны профилем `storefront` (nip.io). Работа по домену была в полосе
`codex/mobile-build29-1030` (`d365cfb6`, не влита); её вибрация и отступы игр устарели после
сборки 30 Codex (`3b98dd27`, `71c851a0`).

## Что перенесено из `codex/mobile-build29-1030`

Перенос `cherry-pick -n` с новым сообщением коммита (в теле указан исходный коммит). Конфликтов
не было: эти файлы в shared после `528ea695` не менялись. Упоминания «build 29» в коде, тестах и
CI заменены на «build 33».

| Исходный коммит | Новый коммит | Что                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b2a69cbf`      | `4758a736`   | `browser_network.py`: запись источника каждого запроса за пределы loopback и `assert_api_origin()` (при `PICKCHICK_EXPECT_API` падает на любой запрос к nip.io или IP сервера и при нуле запросов к ожидаемому API); обход и аккаунт App Review её вызывают; шаг storefront в CI экспортирует профиль `production`; `ios_release.py` не пускает `EXPO_PUBLIC_SUPPORT_URL` на nip.io в `production` |
| `1646b3f2`      | `6a61363a`   | `ios_release.py`: событие «Mobile JS bundle backend» в `doctor`, `archive`, `export`, `upload` (профиль, окружение, адрес API, `profile_from_default`; для любого профиля, кроме `production`, - предупреждение «need --feature-profile production»)                                                                                                                                               |
| `8fea28bf`      | `44ca491f`   | `scripts/mobile/check_domain_links.py` + 7 тестов: шлюз только чтением перед отправкой (API на домене, `terms_url` / `privacy_url` сервера и поля App Store Connect на `pickchick.kz`, страницы открываются)                                                                                                                                                                                       |
| `cc00a854`      | `1ff7b966`   | `metadata.json` без Pick Run, с абзацем «ЗАКАЗ И ОПЛАТА» / «ORDER AND PAY»; `screenshots-plan.md` (обновлён: сборка 33, вкладка «Игры», нынешний список профиля с «Удалить аккаунт»); заметки 28: код только в Telegram; `store-metadata.test.mjs`                                                                                                                                                 |

Новое в этой полосе:

- `03720f2f` - `docs/operations/mobile-review-notes-33.en.txt` и черновик ответа
  `docs/operations/mobile-review-reply-33.en.txt` (ниже), их проверка в `store-metadata.test.mjs`.
- `fcacd0b0` - `browser_store_walk.py` проходит путь заметок 33 по-английски (ниже).

## Что не перенесено и почему

- `9322f9a9` (вибрация сильнее и чаще, `haptic-cues.ts`): заменена сборкой 30 Codex (`3b98dd27`,
  `71c851a0` - своя усиленная вибрация, она уже в TestFlight 30-32). Переносить
  вторую схему поверх - конфликт в `KaspiSlideToPay.tsx` и `haptics.ts` без запроса владельца.
- `18823985`, `6af78633` (общий помощник отступов игр `ArcadeSafeArea`): проверено, реального
  пробела нет (раздел ниже), поэтому не перенесены.
- `12442beb`, `d365cfb6` (заметка полосы 29) и `fix-haptics.md`: заметка 29 описывает
  непринятую вибрацию; нужное из неё повторено здесь.

### Отступы игр в `fullScreenModal`: проверка

Все игры открываются маршрутами `games/*` с `ARCADE_SCREEN_OPTIONS` (`fullScreenModal`). Ошибка
сборки 28 - нативный `SafeAreaView` внутри модального экрана меряет себя в начале анимации и может
оставить 0 сверху. На этом дереве:

| Игра / обёртка     | Отступы                                                         | Итог                                                                                        |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Pick Man           | `View` + `useSafeAreaInsets()` (корневой провайдер), `3b98dd27` | исправлено в shared                                                                         |
| Pick Blocks        | `useSafeAreaInsets()`                                           | тот же механизм, что у исправленного Pick Man; жалоб не было                                |
| Magic Sort         | `useSafeAreaInsets()`                                           | то же                                                                                       |
| Pick Farm          | `useSafeAreaInsets()`                                           | в App Store выключена (`EXPO_PUBLIC_PICK_FARM=0`), маршрут уводит в «Игры»                  |
| Pick Run           | нативный `SafeAreaView`                                         | маршрута нет: M27/M28 уводят в «Игры» (`ScreenHost`), не `fullScreenModal` - не открывается |
| `AccountGate`      | нативный `SafeAreaView`                                         | в App Store три игры открыты гостю (`guestCanOpen`): обёртка сразу отдаёт игру              |
| `GameAvailability` | нативный `SafeAreaView`                                         | только если бэк-офис выключит игру; карточка по центру экрана, шапки сверху нет             |

Ни одна доступная в сборке 33 игра не стоит на нативном `SafeAreaView`. Остаток - только
`GameAvailability` в редком состоянии с карточкой по центру; не исправлялся (правило: только
реальный пробел).

## Заметки для App Review (сборка 33)

`docs/operations/mobile-review-notes-33.en.txt` - текст сборки 28 и:

- новый раздел «ACCOUNT DELETION (Guideline 5.1.1(v))» в порядке экранов: значок профиля сверху
  справа на «Menu», «Games» или «Orders» > в профиле «Delete account» (сразу под «Language») >
  на экране «Delete account» кнопка «Delete account» > в окне «Delete your Pick Chick account?»
  ещё раз «Delete account» («Keep account» - отмена) > «Account deleted» только после ответа
  сервера. Также Profile > Settings (шестерёнка) > «Delete account». «Clear local data» - другое
  действие (выход на этом устройстве, аккаунт остаётся). Номер проверки после удаления снова
  входит и получает новый пустой профиль;
- «Games tab» вместо «Events tab»; устаревший путь «Profile > Manage data > Delete account» убран
  (строки «Управление данными» в профиле больше нет);
- код клиентам - только в Telegram (как в сборке 29);
- местозаполнители для Codex: `{OPEN}`, `{CLOSE}` (часы Алматы), `{UTC}`, `{PACIFIC}`, `{VIDEO}`.
  3372 знака с местозаполнителями; с заполненными часами и строкой о видео - около 3600 (лимит
  Apple 4000, тест считает с запасом).

Каждая метка в кавычках есть в английском каталоге приложения (`store-metadata.test.mjs`
проверяет все), а путь удаления по этим меткам проходит браузерный обход (ниже). Номер и код
проверки в тексте не пишутся - только в полях Username / Password.

Черновик ответа в Resolution Center: `docs/operations/mobile-review-reply-33.en.txt` - коротко,
по-английски, тот же путь (Profile > Delete account, Profile > Settings > Delete account,
«Account deleted»), сборка 0.2.0 (33). О видео в тексте ничего нет, кроме строки `{VIDEO}`: Codex
заменяет её одной фразой, только когда запись владельца реально приложена, иначе удаляет строку.
Тест не даёт словам video / recording / attach появиться вне местозаполнителя.

## Домен: профиль `production` на этом дереве

Профиль `production` в `ios_release.py` = флаги `storefront` + `EXPO_PUBLIC_PICKCHICK_ENV=production`
-> `https://api.pickchick.kz` (`apps/mobile/src/build-config.ts`). Код приложения менять не
понадобилось: API, проверка связи (`/health/live`), фото блюд (`/v1/media/catalog/*`),
картинки бэк-офиса, вход, профиль, удаление аккаунта, push-регистрация берут адрес из `API_URL`.
Вне API: 2ГИС, OpenStreetMap (атрибуция карты), `https://kaspi.kz`. Чек - `receiptUrl` сервера
(сейчас `deferred`). Universal links нет.

- Бандл экспорта `production`: `https://api.pickchick.kz` и одна строка nip.io - константа
  staging-профиля в `BUILD_PROFILES` (в `production` не выбирается; обход ниже это подтверждает).
- Вне приложения остаются: «Документы» в профиле, ссылки согласия при входе и блок документов при
  оплате открывают `terms_url` / `privacy_url` сервера (`CUSTOMER_AUTH_TERMS_URL` /
  `CUSTOMER_AUTH_PRIVACY_URL`; аудит 14.10 записал их на nip.io) и поля App Store Connect
  «Support URL» / «Privacy Policy URL». Их проверяет `check_domain_links.py` (шаг 3 ниже).
- Профиль по умолчанию в `ios_release.py` оставлен `storefront`: сменить его можно отдельным
  изменением после «Domain gate PASS». До тех пор флаг `--feature-profile production` обязателен,
  а событие «Mobile JS bundle backend» с предупреждением показывает забытый флаг.

## Что сделать Codex для сборки 33

1. После проверки PM влить ветку; поднять `ios.buildNumber` в `apps/mobile/app.json` до `33`.
   Нативных изменений нет, prebuild/pods как обычно.
2. **Archive, export и upload - только `--feature-profile production`.**
   `python3 scripts/mobile/ios_release.py archive --feature-profile production ...` и тот же флаг
   в `export` / `upload`. В выводе каждой фазы должно быть «Mobile JS bundle backend» с
   `"environment": "production"`, `"api_url": "https://api.pickchick.kz"` и без `warning`; иначе
   не отправлять. `EXPO_PUBLIC_API_URL` не задавать; `EXPO_PUBLIC_SUPPORT_URL` - только на
   `pickchick.kz` или телефон/почта.
3. **Шлюз домена (только чтение)**: `python3 scripts/mobile/check_domain_links.py` - сначала без
   полей карточки. Пока сервер отдаёт документы с nip.io, ожидается FAIL на `server terms_url` /
   `server privacy_url`. После «да» владельца перевести `CUSTOMER_AUTH_TERMS_URL` /
   `CUSTOMER_AUTH_PRIVACY_URL` сервера и поля «Support URL» / «Privacy Policy URL» (RU и en-GB)
   на `pickchick.kz`, затем повторить с полями обеих локализаций:
   `python3 scripts/mobile/check_domain_links.py --support-url <RU как в Apple> --support-url <en-GB как в Apple> --privacy-policy-url <как в Apple>`.
   Отправлять на проверку только при «Domain gate PASS».
4. Сборку 33 в TestFlight; на iPhone проверить, что приложение работает с `api.pickchick.kz`
   (сертификат, меню, вход, профиль) и что «Документы» открывают `pickchick.kz`.
5. Видео владельца на физическом iPhone по сценарию `mobile-app-review-1030.md` (выделенный
   аккаунт проверки, вход, Profile > Delete account > Delete account > подтверждение >
   «Account deleted»), затем снова войти тем же номером, чтобы аккаунт был доступен Apple.
6. Заметки: в `mobile-review-notes-33.en.txt` заполнить `{OPEN}` / `{CLOSE}` по
   `GET /v1/customer-checkout/availability` (в заметках 28 было 10:00 / 00:00), `{UTC}` (05:00-19:00) и
   `{PACIFIC}` на дату подачи: с 1 ноября 2026 в США PST (UTC-8) - «21:00 on the previous day to
   11:00 (PST, UTC-8)». `{VIDEO}` - одна фраза о приложенной записи, только если она приложена;
   иначе строку удалить. Перед вставкой проверить, что `/v1/auth/config` не включил WhatsApp:
   иначе исправить фразу «Regular customers receive their code in Telegram». То же для
   `{VIDEO}` в ответе `mobile-review-reply-33.en.txt`.
7. **Повторная отправка и ответ Apple - только после «да» владельца**: выбрать для 1.0 сборку 33,
   вставить заметки, приложить видео, ответить в Resolution Center, отправить. Тексты карточки и
   скриншоты (`metadata.json`, `screenshots-plan.md`) - тоже только после «да» и после
   публикации настоящих цен.
8. Потом отдельным изменением: `DEFAULT_MOBILE_PROFILE = "production"` в `ios_release.py`, когда
   шлюз даёт PASS.

## Проверки

- `pnpm test:mobile`: 566/566 node-тестов (было 562: +4 `store-metadata.test.mjs`) и 70
  Python-тестов (было 59: +2 `test_browser_network.py`, +2 `test_ios_release.py`, +7
  `test_check_domain_links.py`), 1 пропуск как раньше.
- `pnpm typecheck` (все пакеты), `pnpm lint`, `pnpm format:check`,
  `node scripts/mobile/translations.mjs --check` (1462 строки, новых строк интерфейса нет),
  `pnpm design:check` (130 экранов) - без ошибок.
- Экспорт production storefront (`EXPO_PUBLIC_PICKCHICK_ENV=production`, порт 5197):
  - `browser_store_walk.py` (`STORE_WALK_PROFILE=storefront`,
    `PICKCHICK_EXPECT_API=https://api.pickchick.kz`) - PASS, 101 экран (97 + 4 новых английских
    экрана удаления), 2315 внешних запросов, все на `api.pickchick.kz`, 0 на nip.io (первый прогон
    до нового шага: 97 экранов, 2235 запросов, тоже только домен). Новый шаг: из значка профиля по
    английским меткам заметок - «Delete account» сразу под «Language», экран, окно «Delete your
    Pick Chick account?» с «Keep account», «Account deleted», ровно один
    `DELETE /v1/customers/me` и ни одного до подтверждения; Settings > «Delete account»
    открывает тот же экран без запросов;
  - `browser_review_account.py` (`REVIEW_ACCOUNT_PROFILE=storefront`, то же ожидание) - PASS,
    529 внешних запросов, все на `api.pickchick.kz`;
  - обратная проверка: `browser_review_account.py` с тем же ожиданием на staging-экспорте (5196)
    падает «requests to the staging host» (559 запросов на nip.io) - проверка действительно ловит.
- Экспорт Kaspi/customer-auth (5196): `browser_slide_to_pay.py` A-Q - PASS.
- Экспорт симулятора (5182): `browser_account_required.py` и `browser_profile.py` (вход в профиль
  из шапки, двойные тапы, выход) - PASS.
- Число запросов меняется от прогона к прогону (опрос статуса и проверка связи по таймеру); тест
  проверяет не число, а что ни один запрос не ушёл на nip.io и API получил запросы.

Скриншоты: `.local/mobile-1031/b33/` - `store-production/` (обход production, в том числе
`delete-profile-en-393.png`, `delete-screen-en-393.png`, `delete-confirm-en-393.png`,
`delete-done-en-393.png`), `review-account-production/`, `slide-to-pay/`.

## Что подтверждает только iPhone и чего эта полоса не проверяла

- Что сборка 33 работает с `api.pickchick.kz` на устройстве (сертификат, вход, удаление,
  оплата Kaspi) - браузер отвечал фикстурами, настоящий домен не запрашивался.
- Куда ведут «Документы» и ссылки согласия (сервер) и поля App Store Connect - только
  `check_domain_links.py` против настоящего домена (эта полоса его не запускала: без сети к
  production).
- Видео удаления на физическом iPhone (владелец) и шапки игр при первом входе после холодного
  запуска (нативное поведение, браузер не воспроизводит).
- VoiceOver на пути удаления (не менялся).

## Границы и риски

- Код приложения не менялся; менялись тесты, инструменты выпуска, CI и документы.
- CI больше не обходит storefront со staging-адресом - только профиль `production` (флаги те же).
- «Code in Telegram only» верно, пока на сервере не включён резерв WhatsApp (шаг 6).
- Если бэк-офис выключит игру, карточка `GameAvailability` во `fullScreenModal` стоит на нативном
  `SafeAreaView` (по центру экрана; при первом входе возможен 0 сверху - не под строкой
  состояния, т.к. содержимое по центру).
- Возможные конфликты: `.github/workflows/ci.yml` (шаг storefront), `tests/mobile/browser_network.py`,
  `browser_store_walk.py` (`walk_delete`), `browser_review_account.py`,
  `scripts/mobile/ios_release.py`, `docs/operations/mobile-appstore-2026-10-22/metadata.json`,
  `tests/mobile/store-metadata.test.mjs`. Ветку `codex/mobile-build29-1030` после влития этой не
  вливать (её нужное здесь, остальное заменено).
- `docs/project-status.md`, `docs/roadmap/project.json`, `handoff.md` не менялись.
