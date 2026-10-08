# Киоск v3: включение Kaspi QR и установка на iPad - передача оператору Mac

Документ для Codex на Mac владельца (SSH-ключ VPS, Xcode, подключённый iPad).
Составлен 8 октября 2026. Дизайн v3 в коде готов (раздел «Состояние ветки»);
**серверные шаги A, контрольный платёж B и установка C ещё не выполнены**. Цель владельца: (1) одно меню в киоске, мобильном приложении и
бэк-офисе; (2) включённая на сервере оплата Kaspi QR в киоске; (3) новая сборка
на iPad. Общие правила: [AGENTS.md](../../AGENTS.md),
[совместная работа](../collaboration/README.md). Предыстория:
[kiosk-kaspi-qr.md](kiosk-kaspi-qr.md), [kiosk-payment-options.md](kiosk-payment-options.md).

Порядок строгий: A (сервер, без денег) -> B (один контрольный платёж) -> C (iPad).
C можно выполнить раньше B, но платёжная приёмка на iPad - только после B.
Любой непройденный guard = стоп, lock сохраняется, отчёт владельцу; guard не ослаблять.

## Подготовка на Mac 8 октября: общий срез и цены

Владелец выбрал запуск для гостей и указал использовать цены бэк-офиса.
Read-only проверка Abay Plaza: draft revision 8 и published version 3 имеют один
payload SHA-256 `43d4580c488326238bca892c8f0ee98f3b1d981224261b187237aa31107ba6b7`.
Pick Combo в обеих версиях стоит **100 ₸**. Это существующая цена бэк-офиса,
не подстановка клиента; без нового решения владельца её не изменяем.
Повторная публикация идентичного черновика для запуска не требуется.

API/public остаются `778a718ffe916520fc177aaa663546e863a8574a`;
gateway SHA-256 `0bb039bde008cd3a25aeec3d4e06d15f3ad5e8dc3f6eda2e8373fd004264d3ff`.
Пока включён `deferred_pilot`, лимит 100 ₸, QR worker выключен; QR и fiscal
provider accounts отсутствуют. Владелец явно разрешил текущий запуск **без чека**
и **без бизнес-лимита суммы заказа**; это заменяет прежнее требование `required`
для этого этапа. Предстоит реализовать явный unlimited-режим и сохранить решение
в approval reference. Фискализация отложена и не считается готовой. Ещё нужны
согласованное окно перезапуска общего Kaspi-моста и контрольный платёж. Никаких изменений
на VPS или банковских запросов эта проверка не выполняла.

В v3 включён общий срез `2983daa` без переписывания истории. При разрешении
конфликтов сохранены девять фотографий напитков владельца, отдельные Яблоко /
Апельсин Piko и прежняя фотография **банки** Coca-Cola. `PhotoImage` владеет
масштабированием фото и имеет только `imageId` / семантический `variant`;
косметические override-пропсы отсутствуют. Его варианты добавлены в Storybook.
Выбор вкуса Piko в Storybook проверяется на подготовленном неопубликованном
каталоге; на сервере вкусы ещё не опубликованы.

Проверки объединённого дерева на Mac: TypeScript, ESLint, 85/85 kiosk tests
(включая 4 архитектурных), web export и Storybook build; 6/6 browser UI,
3/3 design/Storybook проверки, Axe без нарушений, QR/счёт на телефон и
выбор вкуса/фото/цена/идентичность строки Piko на 768, 820, 1024 px.
Impeccable detect: замечаний нет. Скриншоты проверены визуально:
[меню](images/kiosk-v3-launch/web-menu-1024.png),
[Piko](images/kiosk-v3-launch/web-piko-820.png),
[экран тестового QR](images/kiosk-v3-launch/web-qr-fixture-820.png).
Это **локальные синтетические сценарии**, их цены/QR не являются серверным
меню или подтверждением банковской оплаты. Native/CI/установка ещё впереди.

Общие status/handoff/roadmap зарезервированы `farm-gameplay-v2`, онлайн-пульт -
`tiptoppay-test-rollout`; текущие факты сохраняются здесь и в coordination registry.

### Продолжение на Mac: guarded checkout и решение владельца

Опубликованы `b79fd4f` и [PR 209](https://github.com/xaaknazar/pickchick/pull/209).
CI `37765963726` выявила устаревшую проверку белой подложки номера заказа.
В v3 белый номер находится на синем экране; проверка теперь определяет первую
непрозрачную родительскую поверхность и сохраняет проверки размера, видимости,
одного создания заказа и одного платежа. Локальный повтор прошёл.
Storybook CI `37765963746` / `37766014208` прошла.

Добавлен `infra/staging/release-kiosk-checkout.py`: точные baseline API/public,
compose, gateway, env и image; чистый опубликованный SHA, все 11 jobs CI,
maintenance, backup/isolated restore, old-image compatibility, CAS и rollback.
Профиль меняет только kiosk MAX_MINOR/fiscal approval reference и выдаёт
точные additive-права API/worker. Существующие права мобильного обработчика
сохраняются. QR account на этом этапе должен оставаться выключенным; создание
его записи и активация выполняются после успешного API release отдельной
операторской процедурой A3/A7. Профиль сам не создаёт банковские QR/счета.
Публичные файлы бэк-офиса, мобильные настройки, мост и работающие worker сохраняются.

`KIOSK_CHECKOUT_MAX_MINOR=unlimited` снимает только бизнес-лимит киоска.
Отсутствующий ключ по-прежнему означает безопасный прежний лимит 100 ₸;
`0`, пустая строка и `Infinity` не означают отсутствие лимита. Цена вычисляется
по публикации бэк-офиса, денежные ограничения доменной модели и целые тенге
для существующего QR-моста сохраняются. Все проверенные цены бэк-офиса целые.
Режим текущего выпуска: `deferred_pilot`, approval reference
`owner-2026-10-08-no-receipt-unlimited-backoffice` (прямое решение владельца).
Более ранние требования `required` / согласовать лимит ниже описывают прежний
план и для этого этапа заменены этим решением. Реальных чеков пока нет.

Добавлены `qr-worker.compose.yaml`, ограниченные QR-grants и
[инструкция сотруднику](kiosk-staff-payments.md). На локальном PostgreSQL 18.6
22/22 checkout/QR проверки прошли, включая restricted worker, один capture,
запрет изменения суммы/аккаунта и unlimited-заказ с сохранённой ценой публикации.
Полный commerce integration: 108/108 на PostgreSQL 18.6; API dependency build
прошёл. 37 release guard tests и 7 grant unit tests прошли. Новый полный CI требуется
перед prepare/apply и отдельно перед native build 7. VPS/приложение пока не менялись.

## Состояние ветки `codex/kiosk-v3-design` (8 октября)

Сделано и проверено в облаке (Claude), только `apps/kiosk` и этот документ:

- `dbf7a51` - дизайн v3 с анимацией: витрина (видео, «СДЕЛАТЬ ЗАКАЗ», «Оплата по QR»
  без логотипа Kaspi), выбор «здесь / с собой», меню (billboard, категории, карточки
  на фоне цвета фото), товар (напитки/соусы с фото, «показать все» в нижнем листе),
  корзина, апсейл, review, экран QR с обратным отсчётом 180 с, номер заказа.
  Анимации - `src/components/motion.ts` (native driver, при «Уменьшить движение»
  всё статично). Масштаб: макет 820 pt, на 13" +25% (`theme.v`). Фото - `assets/v3/`
  (4.3 МБ, webp), сопоставление по `image_id`/`optionId` в `src/assets.ts`.
- `99ad40e` - WCAG AA: решение владельца - #FF6900 только без текста; крупный
  белый текст на `orangeCta #E85A00`, мелкий и оранжевый текст - `orangeInk #B84500`.
  Доступные имена кнопок содержат видимый текст (у ProductCard префикс «+ <имя>» сохранён).
- Проверки (облако, Linux, web-экспорт): `tsc`, `eslint --max-warnings=0`, `ui:check`
  4/4, `node --test tests/kiosk/*.test.mjs` 85/85, `browser_ui.py` 6/6,
  `browser_payment_options.py`, `browser_mobbin.py` 3/3 (155 stories, 0 нарушений axe).
- **Не проверено:** полная CI на GitHub, нативная сборка iOS, реальный iPad
  (производительность анимаций и видео, шрифт Montserrat 900, 11" и 13"), `InstalledUITests`.
- Логика контроллера, корзины, оплаты и QR не менялась. Серверный код не менялся.

Kaspi QR уже реализован на `tapter-dev/kaspi-pos-automation` (тот же кассир, что
у счетов мобильного приложения): `/api/qr/create` -> `/api/qr/status`, успех только
`Processed` с совпавшими `QrOperationId` и `Amount`. Наш оверлей `qr-routes.mjs`
отдаёт токен банка без изменений (`https://qr.kaspi.kz/...`), т.е. «Единый QR»
(README upstream: QR строить из `QrOriginalToken`, а не из переписанного `pay.kaspi.kz`).
Upstream HEAD `175577e` новее нашего pin `28c9167`: `APP_VERSION` по умолчанию 26.0921
(у нас уже задан в `bridge.env`) и вывод причины отказа входа - обновлять pin не
обязательно, но причина отказа полезна при следующей поломке сессии.

## Неудобства и подводные камни (прочитать до запуска)

Продукт / касса:

1. **Лимит 100 ₸.** `KIOSK_CHECKOUT_MAX_MINOR` по умолчанию `10000` - любой
   реальный заказ дороже 100 ₸ не оплатится. Для гостей нужен новый лимит (решение
   владельца) отдельным выпуском env. Аналогично Pick Combo = 100 ₸ в каталоге
   после build 5 - вернуть цены до гостей.
2. **Сумма только в целых тенге:** worker создаёт QR только при
   `intended_minor % 100 = 0`. Цены с тиынами молча не выставят QR.
3. **Возврата нет.** Мост без refunds: ошибочную оплату возвращают вручную в Kaspi Pay.
   Нужна короткая инструкция для кассира: «оплатил, но экран не показал» / «оплатил дважды».
4. **Брошенный QR / неизвестный результат.** QR скрывается через 180 с, отменить его
   в Kaspi нельзя; поздняя оплата всё равно дойдёт (worker проверяет дальше).
   Неизвестный результат блокирует очистку гостя - нужен сотрудник. Процедуры для
   персонала в репозитории нет - описать: где смотреть статус и как отдать заказ.
5. **Один кассир на два канала.** Если сессия Kaspi умрёт (обновление Kaspi ->
   `OldVersionToUpdate`, выход из аккаунта), перестанут работать и счета мобильного
   приложения, и QR киоска одновременно. Нужен мониторинг `session-check.mjs` с
   уведомлением, иначе узнаем от гостей.
6. **Пересоздание моста роняет мобильные счета** на время рестарта (общий netns с
   `pickchick-kaspi-worker`). Делать вне часов работы, без pending-счетов.
7. **ACK меню с кассы для оплаты в киоске больше не нужен** (решение владельца
   8 октября, коммит в этой ветке): меню делается только в бэк-офисе, одна публикация
   сразу действует для приложения, киоска и кассы. Киоск теперь открывает оплату по тем
   же условиям, что мобильное приложение: точка принимает заказы, меню опубликовано,
   платёжный аккаунт включён, кухня на связи (активная `fulfillment_transport_bindings`
   и активное устройство). Отдельно остаётся задача синхронизации меню бэк-офиса с
   самой кассой Windows (сейчас касса меню не получает) - на оплату в киоске не влияет.
8. **Фискальный чек.** `deferred_pilot` = чека Webkassa нет. Для гостей нужен
   `required` и fiscal account - иначе продажи без чека.
9. **Координаты QR** `43.226626, 76.861489` - сверить, что это Abay Plaza.
10. **Другие банки** не проверены - не обещать гостям, пока не проверено.

Приложение киоска:

11. **Фото зашиты в сборку.** Новый товар из бэк-офиса появится в киоске сразу, но без
    фото (запасная заглушка `ProductArtwork`), пока его `image_id` не добавят в
    `src/assets.ts` и не выпустят новую сборку. То же для напитков/соусов (`optionId`).
    Мобильное приложение берёт фото иначе - меню «одинаковое» по данным, не по картинкам.
12. **Захардкожено в `MenuScreen.tsx`:** название точки `'ТЦ Abay Plaza'` (каталог отдаёт
    только id) и товар billboard по имени `'Master Combo'` (при переименовании -
    первое комбо). Метки «ХИТ/НОВИНКА» - по товару в коде. Правильно: поля в бэк-офисе.
13. **Цены напитков/соусов** (Coca-Cola/Zero/Fanta/Sprite 990 ₸, Fuse Tea 790 ₸, Heinz
    сырный и барбекю 390 ₸, барбекю - в наличии) утверждены владельцем **временно** только
    для прототипа; в каталог бэк-офиса их надо внести/проверить вручную.
14. **`EXPO_PUBLIC_KIOSK_COMMERCIAL=1` обязателен** и для prebuild, и для Release JS-бандла.
    Без него на iPad будет тестовый режим: кнопки «Оплатить для теста», «Проверить отказ».
15. **Адрес API зашит** (`src/api.ts` -> `pickchick.185.129.51.103.nip.io`). Переезд на
    боевой домен = новая сборка iPad.
16. **Не удалять приложение при установке** - потеряется регистрация киоска (enrollment).
17. Казахские тексты новых ключей (`orderNow`, `payQR`, `qrStep1-3`, `hit` ...) написаны
    без носителя языка - дать проверить владельцу.
18. Отличия от макета v3: на экране «здесь / с собой» остался «Назад» + «PICK CHICK»
    вместо круглого X; в меню нет кнопки «Назад» (возврат - через чип режима); не
    перенесены слайд 7+1 в billboard и бейдж «в корзине» на карточке; свечение
    приближено кругами; тень логотипа только на iOS; выбранная категория стала
    тёмно-оранжевой (#B84500) из-за контраста - можно вернуть #FF6900 с тёмной подложкой
    только под надписью.

Mac-рабочая копия:

19. В `.git/worktrees/{commerce-catalog-bridge,profile-card-backgrounds,kiosk-review-source}/index.lock`
    - старые lock-файлы (не от Claude); проверить, что git в этих worktree не запущен, и удалить.
      `.git/stale-maintenance-lock-claude` и `.local/kiosk-v3-design*.bundle` можно удалить после push.

## Что нужно от владельца

1. **Разрешение на контрольный платёж 100 KZT** (одна попытка, платит сам владелец
   в Kaspi.kz). Повторный create после неизвестного ответа запрещён; второй QR -
   только по новому разрешению. Возврата через мост нет (refunds вырезаны патчем):
   100 KZT остаются выручкой, заказ уйдёт на кухню как настоящий.
2. **Фискальный режим.** Сейчас на сервере `KIOSK_CHECKOUT_FISCAL_POLICY=deferred_pilot`
   (без чека Webkassa). Для запуска точки типовой режим `required` и нужен реальный
   `KIOSK_CHECKOUT_FISCAL_ACCOUNT_ID` (provider kind=`fiscal`), которого в репозитории нет.
   Решение: контрольный платёж в `deferred_pilot`, гостям - только после `required`?
3. **Другие банки.** Неизвестно, принимают ли приложения других банков этот QR
   (оригинальный QrToken Kaspi, без deeplink). Проверка допустима только на
   контрольном платеже и только сканированием без подтверждения: отмена в чужом
   приложении может перевести QR в `CancelledByUser`, и тогда нужен второй
   платёж (пункт 1). Владелец решает: проверять ли и каким приложением.
4. **Лимит и цены.** `KIOSK_CHECKOUT_MAX_MINOR=10000` (100 KZT на заказ) и, по
   протоколу build 5, Pick Combo в опубликованном каталоге стоит 100 ₸. Для
   контрольного платежа это удобно; для гостей нужны утверждённые цены и новый
   лимит (отдельное решение и отдельный выпуск env).
5. **Публикация меню из бэк-офиса** (см. A4): разрешение опубликовать текущий
   черновик как новую версию для точки Abay Plaza.
6. Подтверждение, что касса Windows (192.168.2.184) включена и доступна, а кухня
   готова принять контрольный заказ в часы работы (`CUSTOMER_KASPI_OPENING_TIME`/`CLOSING_TIME`).

## Блокеры, найденные в репозитории

- **Нет release-профиля включения оплаты.** `infra/staging/release-kiosk-qr.py`
  (baseline `d6cd144`) - только enrollment, требует `KIOSK_KASPI_QR_ENABLED=false`
  и сам проверяет, что QR account выключен. `release-kiosk-menu.py` (baseline `39336a7`)
  - только меню/сессии. `release-finance-dashboard.py` - baseline `41d2a61`.
    На VPS API/public = `778a718ffe916520fc177aaa663546e863a8574a`
    ([ceo-login.md](ceo-login.md), 8 октября); по `kiosk-payment-options.md` старые
    профили поверх 778 запускать нельзя. Нужен новый профиль (A1).
- **Нет runtime grants для QR.** `infra/staging/commercial-channel-grants.mjs`
  (`kioskCheckoutGrants`, `kioskWorkerGrants`) не подключён ни к одному release-скрипту
  и не содержит прав на `commerce_kiosk_kaspi_qr` для worker-роли. Тесты
  `kiosk-kaspi-qr.postgres.test.mjs` работают владельцем БД. Права нужно спроектировать
  и проверить на реальной роли (`pickchick_kaspi_worker` или отдельной).
- **Нет compose/unit для `kiosk-kaspi-qr-worker`.** Есть только
  `infra/payments/kaspi-bridge/worker.compose.yaml` для `kaspi-remote-worker.js`.
- **Нет release-процедуры моста с `--qr`.** `prepare-container.mjs ... --qr`
  собирает контекст, но установка/замена `pickchick-kaspi-bridge` не автоматизирована.
  Пересоздание моста затрагивает действующий `pickchick-kaspi-worker`
  (`network_mode: container:pickchick-kaspi-bridge`) мобильных счетов.
- ~~ACK меню~~ - снят: `KioskCheckout.config` больше не требует
  `catalog_menu_deliveries.status='applied'`, проверяет кухню как мобильный checkout
  (`packages/commerce-core/src/kiosk-checkout.ts`, тест
  `kiosk-checkout.postgres.test.mjs`). Синхронизация меню на саму кассу Windows
  (`native-pos-sync.md`: «does not update ... menu data») - отдельная задача.
- **Нет инструмента чтения реального QR status.** Worker пишет только счётчики.
  Скрипта, выводящего имена полей ответа `/api/qr/status`, нет (A6/B3).
- **Ветка `codex/kiosk-v3-design` есть только локально на Mac** (коммиты `dbf7a51`,
  `99ad40e` поверх `82400c8`, доставлены git-bundle в `.local/`). Её нужно
  опубликовать (`git push -u origin codex/kiosk-v3-design`) и прогнать полную CI.
  `buildNumber` в `app.json` всё ещё 6 - поднять до 7 отдельным коммитом перед C.
- `InstalledUITests` (нативная проверка build 5/6) в репозитории нет - только на Mac.
- CI: бюджет Actions восстановлен 8 октября (ceo-login.md), но зелёная CI
  каждого нового SHA обязательна; исключение владельца для build 6 на сервер не распространяется.

## 0. Подготовка на Mac

```sh
pnpm project:check && pnpm project:tasks         # свежие refs и журнал
node scripts/project-sync.mjs claim kiosk-v3-launch @vps @release/ios apps/kiosk infra/staging infra/payments/kaspi-bridge
```

Если `@vps`, `@vps/api` (финансы, [finance-ownership.md](../collaboration/finance-ownership.md))
или `@windows/cashier` заняты - согласовать, не перехватывать. Прочитать
[handoff.md](../collaboration/handoff.md). SSH: `pickchick-ops@185.129.51.103`,
ключ `~/.ssh/pickchick_staging_ed25519`, `StrictHostKeyChecking=yes`;
backup identity `.local/vps/backup-identity.agekey` (0600). Lock -
`/opt/pickchick-staging/.market-release.lock`.

## A. Сервер: включение гостевого checkout с Kaspi QR

### A0. Read-only инвентаризация (без изменений)

```sh
S='ssh -i ~/.ssh/pickchick_staging_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o BatchMode=yes pickchick-ops@185.129.51.103'
$S 'readlink -f /opt/pickchick-staging/current /opt/pickchick-staging/public-https/current; test ! -e /opt/pickchick-staging/.market-release.lock && echo lock-free'
$S 'docker exec pickchick-public-gateway sha256sum /etc/caddy/Caddyfile'
$S 'docker inspect --format "{{.Name}} {{.Config.Image}} {{.Image}}" pickchick-staging-api-1 pickchick-kaspi-bridge pickchick-kaspi-worker'
$S 'docker exec pickchick-staging-api-1 printenv KIOSK_CHECKOUT_ENABLED KIOSK_CHECKOUT_PAYMENT_METHOD KIOSK_CHECKOUT_FISCAL_POLICY KIOSK_CHECKOUT_MAX_MINOR KIOSK_KASPI_QR_ACCOUNT_ID KIOSK_KASPI_QR_ENABLED KIOSK_CHECKOUT_BRANCH_ID CATALOG_EDGE_PUBLICATION_ENABLED'
```

SQL (через `docker exec -i pickchick-staging-cloud-db-1 psql -X -qAt -U postgres -d pickchick_cloud`):

```sql
SELECT count(*),max(version) FROM schema_migrations;
SELECT id,provider,kind,enabled,branch_id,legal_entity_id FROM commerce_provider_accounts;
SELECT id,branch_id,active FROM kiosk_devices;
SELECT h.published_version,h.draft_revision FROM catalog_branch_heads h;
SELECT * FROM catalog_menu_deliveries;
SELECT b.id,b.ordering_enabled,b.legal_entity_id FROM branches b;
SELECT count(*) FROM commerce_kiosk_kaspi_qr;
SELECT count(*) FROM commerce_orders WHERE snapshot->>'channel'='kiosk';
```

Ожидание по документам: API 778a718, 1 активный `kiosk_devices` Abay Plaza,
только `kaspi-remote` enabled, `KIOSK_KASPI_QR_ACCOUNT_ID` уже задан UUID без
строки в `commerce_provider_accounts`, `KIOSK_KASPI_QR_ENABLED=false`, delivery нет,
kiosk-заказов 0. Любое расхождение - записать и остановиться. Секретные env
(`*_PII_KEY`, `KIOSK_ENROLLMENT_KEY`, `KASPI_SESSION_*`) не печатать.

### A1. Новый guarded-профиль (создать; в репозитории его нет)

Предлагаемое имя `infra/staging/release-kiosk-checkout.py` - по образцу
`release-kiosk-menu.py` (наследует `release-kiosk-qr.py` -> `release-farm-pilot.py`
-> `release-market.py`). Действия `preflight|prepare|apply|rollback`, обязательные
`--sha --branch --expected-api-sha --expected-public-sha --expected-gateway-sha256
--ssh-key --environment(0600) --ci-run|--ci-proof --backup-identity`, `rollback` - `--owner-id`.
Профиль должен:

- закрепить BASELINE = фактический API/public SHA из A0, хеши gateway и compose
  из A0, полный ledger миграций; новых миграций не добавлять (если нужны - отдельно);
- требовать `market.verify_ci` с полным набором `CI_JOBS` (11/11) точного SHA,
  чистое дерево, `HEAD==--sha`, свободный lock и `deployment_lock()`;
- в `apply`: maintenance (503 на `/v1/test/orders`), остановка API, `quiescent()`,
  `before`-снимок, `backup_restore()` (зашифрованная копия + восстановление в
  изолированную БД), проверка старого образа на схеме, CAS-переключение
  `current`/`public-https/current`, проверка mounts и SHA-256 Caddyfile, `cleanup('release')`;
- добавить в gateway **только** POST `/v1/kiosk-checkout/quotes`,
  `/v1/kiosk-checkout/orders`, `/v1/kiosk-checkout/orders/*/payment` и GET
  `/v1/kiosk-checkout/orders/*` в формате блоков `@kiosk_menu_*` (`header_up -Cookie`,
  `-X-Device-Id`, таймауты 2s/5s, `max_size 16KB`). Rate limit в gateway в репо
  нет - ограничения только в API. Мост (порт 3931) не публиковать;
- выдать `pickchick_app` точные права guest checkout (взять из
  `kioskCheckoutGrants(...,true)`, проверить ACL как в `verify_data`), а worker-роли -
  минимальные права на `commerce_kiosk_kaspi_qr`, outbox/attempts/orders/inbox (спроектировать,
  покрыть тестом на реальной роли PostgreSQL 18);
- создать строку `commerce_provider_accounts`: `id = KIOSK_KASPI_QR_ACCOUNT_ID` из A0,
  `kind='payment'`, `provider='kaspi-qr'`, те же organization/branch/legal_entity, что у
  точки (`branches.legal_entity_id`), `external_reference` - согласовать (в репо не
  задан), `enabled=false` на этапе apply; `enabled=true` - отдельным шагом A7;
- `CATALOG_EDGE_PUBLICATION_ENABLED` для оплаты в киоске не нужен (ACK снят); не
  включать в этом выпуске - это часть будущей синхронизации меню с кассой;
- сохранить `verify_public()`-проверки (auth, finance 401, мобильный каталог,
  TipTopPay 404, kitchen sourceSha), env API менять только перечисленным дельта-набором;
- `rollback`: сохранить БД/новые данные, вернуть ACL/pointers/образ; при новых
  деньгах - fail closed, lock остаётся.

Тесты: расширить `tests/operations/test_kiosk_qr_release.py` или новый
`tests/operations/test_kiosk_checkout_release.py`; локально `python3 -m unittest`, затем CI.

### A2. Мост с QR (`BRIDGE_QR=on`)

1. Upstream `tapter-dev/kaspi-pos-automation` на `28c9167f9c72cd6758a25e254bc92bc610daa485`.
2. `node infra/payments/kaspi-bridge/prepare-container.mjs UPSTREAM NEW_DIR --qr` ->
   `manifest.json` с `"qr": true` и хешами; `tests/operations/kaspi-qr-bridge.test.mjs` зелёный.
3. Сборка образа `pickchick-kaspi-bridge:<SHA>` на VPS из этого контекста; в
   приватном `bridge.env` (0600, 1000:1000) добавить `BRIDGE_QR=on`, `BRIDGE_POLLING=off`
   сохранить. Комплект `session.env/keypair.json/device.json` не менять и не перевыпускать.
4. Пересоздание моста требует пересоздать `pickchick-kaspi-worker` (общий netns).
   Перед этим: нет pending submissions/неустановленных счетов (как в
   `release-kaspi-session-worker.py`). Автоматизации нет - либо отдельный guarded
   профиль, либо ручная процедура под lock с сохранением старого image для возврата.
5. Проверки: label SHA, нет published ports, `/health`;
   `docker exec pickchick-kaspi-bridge node --env-file=/run/kaspi/session.env session-check.mjs`
   -> `active=true, invoiceAttempted=false`; мобильный worker `--once` без ошибок.

### A3. Worker `kiosk-kaspi-qr`

Compose по образцу `worker.compose.yaml` (создать; имя, например,
`pickchick-kiosk-qr-worker`): тот же immutable `pickchick-api:<SHA>`,
`network_mode: container:pickchick-kaspi-bridge`, read_only, cap_drop ALL, команда
`node --env-file=/run/pickchick/kiosk-qr.env --env-file=/run/pickchick/session.env services/api/dist/kiosk-kaspi-qr-worker.js`.
Приватный `kiosk-qr.env` (0600):

```text
KIOSK_KASPI_QR_ENABLED=true
KIOSK_KASPI_QR_ACCOUNT_ID=<UUID из A0, provider kaspi-qr>
KIOSK_KASPI_QR_LATITUDE=43.226626
KIOSK_KASPI_QR_LONGITUDE=76.861489
KASPI_BRIDGE_URL=http://127.0.0.1:3931
CLOUD_DATABASE_URL=<роль worker, host cloud-db, /pickchick_cloud>
APP_ENV=staging   (+ прочие обязательные platform env, как у pickchick-kaspi-worker)
```

`KASPI_SESSION_TOKEN_SN/VTOKEN_SECRET/PROFILE_ID` - из того же `session.env`.
`KASPI_REMOTE_ACCOUNT_ID` в этом env не задавать или он должен отличаться
(иначе `KIOSK_QR_REQUIRES_SEPARATE_ACCOUNT`). Проверка: запуск с `--once` ->
`{"event":"kiosk_kaspi_qr","submitted":0,"checked":0,"errors":0,"sessionProblem":false,"unknownOverdue":0}`,
затем постоянный режим; в логах только счётчики. Отключённый worker пишет `state:"disabled"`.

### A4. Меню: одна публикация для бэк-офиса, приложения и киоска

Мобильное приложение и киоск читают **одну и ту же** опубликованную версию
точки (`catalog_branch_heads.published_version` -> `catalog_publications`), поэтому
синхронизация = одна публикация в бэк-офисе, если `KIOSK_CHECKOUT_BRANCH_ID` совпадает
с веткой мобильной витрины (`CUSTOMER_KASPI_BRANCH_ID`) - сверить в A0.

1. В бэк-офисе «Каталог» опубликовать текущий проверенный черновик (draft revision 8,
   hash `43d4580c488326238bca892c8f0ee98f3b1d981224261b187237aa31107ba6b7`) как новую
   версию. Цены не менять без решения владельца (лимит, 100 ₸ у Pick Combo, напитки/соусы).
2. ACK с кассы для киоска не требуется (см. «Неудобства», п. 7). Проверить, что кухня
   на связи: активная `fulfillment_transport_bindings` и `devices.status='active'`,
   kitchen-live `edgeConnected:true`.
3. Проверка: `GET /v1/customer-checkout/catalog` и `GET /v1/kiosk-checkout/catalog`
   (с device-ключом) возвращают одинаковые `version`; новая публикация сразу видна в обоих.
4. Синхронизация меню на кассу Windows - отдельная задача `@windows/cashier`, не блокирует киоск.

### A5-A6. Запуск и проверки без денег

После apply (QR account ещё `enabled=false`):

- `/health/ready` true, образ API = prepared `image_id`, gateway SHA-256 = prepared;
- анонимно: `POST /v1/kiosk-checkout/quotes|orders` -> отказ API 4xx (не 404 gateway,
  не 200; точный код зафиксировать в профиле по контроллеру `kiosk-checkout-controller.ts`);
  `/v1/customer-checkout/test-payments` и TipTopPay -> 404; finance без входа -> 401;
- с device-ключом iPad: `GET /config` -> `paymentMethods: []`, `enabled:false`;
- мобильный каталог и `/v1/auth/config` байт-в-байт как в `prepared.json`;
- worker `--once` без ошибок; мобильный Kaspi worker и мост healthy, сессия active.

### A7. Включение QR account

Только после A2-A6 и публикации меню (A4): `UPDATE commerce_provider_accounts SET enabled=true
WHERE id='<QR account>' AND provider='kaspi-qr' AND kind='payment'` - через профиль
(шаг с собственным proof), не вручную. Проверка: `GET /config` ->
`enabled:true`, `paymentMethod:"kaspi_qr"`, `paymentMethods` содержит `kaspi_qr`.

## B. Контрольный платёж 100 KZT (только после явного «да» владельца)

1. Окно работы ресторана, кухня предупреждена, мост `active=true`.
2. На iPad: один Pick Combo (100 ₸), «с собой»/«в зале», оплата QR. Квота и сумма
   сервера = 10000 minor. Отсканировать QR камерой телефона владельца, оплатить в
   Kaspi.kz. При необходимости (решение п.3) - сначала только скан в другом банке.
3. Проверка строгого адаптера (`kiosk-kaspi-qr.ts`): успех = `Status='Processed'`,
   точные `QrOperationId` и `Amount`. SQL:
   `SELECT state,operation_id IS NOT NULL,amount_minor,delivered_at FROM commerce_kiosk_kaspi_qr;`
   Ожидание: `paid`, `10000`, `delivered_at` не NULL; попытка оплаты `captured`.
   Если деньги списаны, а состояние `issued`/`unknown` - форма ответа иная
   (например `Paid`). Не создавать второй QR, не править БД: снять обезличенный
   ответ status (только имена полей/типы, Status, совпадение Amount) отдельным
   read-only инструментом (в репо отсутствует), доработать адаптер и regression fixture,
   новый выпуск. QR-токен, ID операции и данные покупателя в Git не сохранять.
4. Кухня: заказ с номером с экрана iPad появился на кухне/кассе (kitchen-live,
   `edgeConnected:true`), прошёл приготовление/выдачу по обычной процедуре.
5. Очистка гостя: экран успеха 15 с -> витрина; старый `kiosk_sessions.ended_at`
   заполнен, создана новая сессия; заказ остался на сервере и кухне.
6. Истечение: QR скрывается через 180 с от первого create; worker продолжает
   проверку (поздняя оплата). Отмены QR нет.

## C. Сборка v3 и установка на iPad

Предусловие: `codex/kiosk-v3-design` закоммичена и опубликована, в коммите
`apps/kiosk/app.json` `"buildNumber": "7"` (следующий после 6), полная зелёная CI
точного SHA. Без этого установка - только по новому явному исключению владельца.

```sh
git switch codex/kiosk-v3-design && git pull --ff-only && git status --short   # пусто
pnpm install --frozen-lockfile
pnpm --filter @pickchick/kiosk typecheck && pnpm test:kiosk && pnpm --filter @pickchick/kiosk ui:check
cd apps/kiosk && EXPO_PUBLIC_KIOSK_COMMERCIAL=1 pnpm prebuild:ios && (cd ios && pod install)
xcodebuild -workspace ios/PickChickKiosk.xcworkspace -scheme PickChickKiosk \
  -configuration Release -destination 'id=<UDID iPad>' -allowProvisioningUpdates build
```

`EXPO_PUBLIC_KIOSK_COMMERCIAL=1` нужно и при сборке JS-бандла Release. Подпись -
Apple Development, Team `DAJTP6MC3Q`, тот же Bundle ID `kz.pickchick.kiosk` и
keychain access group, что у build 6 (иначе SecureStore с регистрацией не прочитается).
`KIOSK_API_URL` в `src/api.ts` = `https://pickchick.185.129.51.103.nip.io` - сверить.

Установка поверх, **без удаления приложения** (сохраняет enrollment):

```sh
xcrun devicectl list devices
xcrun devicectl device install app --device <UDID> <DerivedData>/Build/Products/Release-iphoneos/PickChickKiosk.app
xcrun devicectl device info apps --device <UDID> --bundle-id kz.pickchick.kiosk   # build 7
xcrun devicectl device process launch --device <UDID> kz.pickchick.kiosk
```

Подписанный build 6 сохранить локально для возврата. Нативная приёмка:
`InstalledUITests` (только на Mac) - меню через сохранённую регистрацию, без экрана
«Настройка киоска»; скриншоты 2048x2732; затем ручной путь: витрина v3 -> меню ->
товар -> корзина -> review -> QR (после A7) -> номер заказа -> очистка; клавиатура
телефона (счёт выключен, если `KIOSK_KASPI_INVOICE_ACCOUNT_ID` не задан), перезапуск
во время ожидания оплаты. Затем [ipad-kiosk-lockdown.md](ipad-kiosk-lockdown.md).
TestFlight (`scripts/mobile/ios_release.py --app kiosk`) - отдельный выпуск.

## Откат

- **Остановить новые оплаты, сохранив сверку:** `enabled=false` для QR account
  (новые create не выдаются, worker продолжает status-проверки уже выданных QR).
  Worker не останавливать, пока есть `commerce_kiosk_kaspi_qr` в
  `issuing/issued/unknown` или `delivered_at IS NULL`.
- **API/gateway:** `release-kiosk-checkout.py rollback --owner-id <UUID>` (после
  создания профиля) - прежние image/pointers/ACL, БД и новые финансовые записи
  сохраняются; восстановление старого дампа поверх рабочей БД запрещено.
- **Мост:** вернуть прежний образ без `BRIDGE_QR` только после завершения всех
  QR-попыток; затем пересоздать мобильный worker и проверить `session-check.mjs`.
- **Меню:** опубликованную версию не удалять; при ошибке - новая публикация.
- **iPad:** установить сохранённый build 6 тем же `devicectl device install app`
  (не удалять приложение). Неизвестная оплата блокирует очистку гостя - разбор сотрудником.

## Доказательства и отчёт

Сохранять в приватном каталоге выпуска на VPS (`prepared.json`, `before.json`,
`backup.json`, `result.json`) и обезличенные итоги в этот документ: SHA, CI run,
backup SHA-256, gateway до/после, состояние account/worker, `version` каталога в приложении и киоске,
итог контрольного платежа (поля ответа без значений-токенов), build 7 и XCTest.
Обновить PR и журнал координации; `project-status`/roadmap - если области свободны.
