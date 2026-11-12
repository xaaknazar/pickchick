# Облако, окно Cloud-1: порядок для исполнителя (Codex или Claude через SSH)

Составлено 10.11 по осмотру сервера (только чтение) и ветке перехода. На сервере ничего не
менялось, кроме добавленного ключа входа `pickchick-claude-mac-20261110`.

## 1. Что стоит на сервере сейчас (10.11, 19:35 по Алматы)

- Сервер `cloud-002`, 185.129.51.103. Docker 29.7.2, Compose v5.5.0. Диск 193 ГБ, занято 34%.
  Память 3,9 ГБ, свободно около 2,3 ГБ.
- API: `pickchick-staging-api-1`, коммит `6630eb0f676350341806b735b6877a36f017c673`, собран 06.11,
  слушает `127.0.0.1:13100`, `/health/ready` отвечает 200.
- Проект compose `pickchick-staging`: сервисы `api`, `cloud-db`, `redis-cache`. Файл
  `/opt/pickchick-staging/releases/6630eb0f…/infra/staging/compose.yaml`, SHA-256
  `3b6d2f55be5e8dae202de15dfca292b9f33e278c4435befee7ee6623dadd4d4c`. Указатель `current`
  смотрит на этот релиз. Окружение: `secrets/staging.env` и `release.env` релиза.
- База: `pickchick-staging-cloud-db-1`, PostgreSQL 18.3, `pickchick_cloud`, 28 МБ.
  `schema_migrations`: 64 строки, последняя `071_cloud_daily_reconciliation` (06.11).
- Ни один из флагов перехода в окружении API не задан (то есть все выключены):
  `CLOUD_POS_SALES_SYNC_ENABLED`, `CATALOG_AGGREGATOR_PRICES_ENABLED`, `BACKOFFICE_ROLES_ENABLED`,
  `BACKOFFICE_STOCK_V2_ENABLED`, `BACKOFFICE_SALES_REPORT_ENABLED`, пять флагов P1,
  `BACKOFFICE_MANUAL_REFUNDS_ENABLED`.
- Копии: `pickchick-backup.timer`, каждую ночь около 02:19 UTC, последняя 10.11 успешна.
  Лежат в `/opt/pickchick-staging/backups` (`cloud-*.dump.age` с манифестом). Копий вне сервера
  нет (`offsite enabled=false`).
- Отдельные воркеры со своими старыми сборками: `kaspi-worker` (e0aed52d),
  `kiosk-kaspi-qr-worker` (2b73f059), `kaspi-bridge` (85f23d58). Этим окном не меняются.
- На сервере есть посторонний проект `/opt/idrink` (держит порты 80/443 своим caddy) и ключ
  `idrink-deploy` в `authorized_keys`. Не трогать.
- Git на сервере нет, релизы приходят архивом в `releases/<sha>`.
- Изменение 11.11 15:10Z: Codex поставил каталог обновлений кассы и кухни. Публичный выпуск шлюза
  теперь `public-https/releases/46453717…` (был `c3a0fbee…`), API-выпуск прежний `6630eb0f`.
  Имя `46453717` на сервере занято: выпуск шлюза или онлайн-пульта из коммита `46453717` делать
  нельзя, нужен более поздний коммит. Планы и квитанции шагов шлюза, подготовленные до этого
  времени, готовятся заново. Ключ `pickchick-claude-mac-20261110` с сервера удалён. Протокол:
  `docs/operations/desktop-updates-install-1111.md` в ветке `codex/desktop-updates-install-1111`.

## 2. Кандидат

- Ветка перехода `codex/cutover-1119`, коммит `273aed2a4e98b88b8a396eaf57445753ab9db9af` (12.11): в него
  вошли PR #339 (внешнее меню), PR #343 (вторая волна бэк-офиса, 076), PR #346 и PR #354 (CI),
  PR #347-#349 (охраняемые шаги 076 и окружение второй волны), PR #350-#352 (автообновление кассы
  и кухни, каталог обновлений), PR #353 и PR #355 («Расходы», 077) и PR #356 (тесты). Полная
  Foundation CI на этом точном коммите зелёная (запуск 43118891863). Коммит, который внёс эту
  запись, меняет только этот документ и в архив не входит. Если в ветку попал другой код,
  кандидатом становится её новая зелёная голова, архив пересобирается.
- Архив исходников для образа API (те же пути, что у прежних релизов, плюс
  `infra/windows/pos-sales-grants.mjs`, который разрешён в `.dockerignore`):
  архив в файлах проекта владельца (`install-kit-1110/api-src-273aed2a4e98b88b8a396eaf57445753ab9db9af.tar.gz`),
  SHA-256 `f85d6b8f516d85363a3808523665f0335028e2353f8cf9d75003ee27636f79b5`. Собран командой
  `git archive --format=tar <sha> .dockerignore package.json pnpm-lock.yaml pnpm-workspace.yaml patches tsconfig.base.json packages services db scripts infra/staging infra/windows/pos-sync-worker-grants.mjs infra/windows/pos-sales-grants.mjs | gzip -n`.
  Прежний архив `api-src-e7c9924a…` устарел, не использовать.
- В архиве есть файлы миграций по 077. Охраняемые шаги ставят только свои файлы; 075-077 идут
  по `cloud-expenses-now-1111.md`, если владелец проводит одно окно, иначе в свои окна.

## 3. Пробный прогон на копии базы (живую базу не трогает)

Цель: первый раз выполнить шаги 072-076 на настоящих данных и PostgreSQL 18.3.

1. Распаковать архив в `/opt/pickchick-staging/rehearsal/<sha>` (не в `releases/`).
2. Собрать образ кандидата с ограничением ресурсов, чтобы не мешать рабочему API:
   `docker build -q --memory 1500m --cpu-period 100000 --cpu-quota 100000 -f infra/staging/Dockerfile --build-arg RELEASE_SHA=<sha> -t pickchick-rehearsal:<sha> .`
3. Поднять отдельный контейнер `postgres:18.3` (тот же образ, что у `cloud-db`) в своей
   внутренней сети без опубликованных портов, со своим временным паролем.
4. Перенести роли и базу из рабочей базы чтением: `pg_dumpall --globals-only` и
   `pg_dump -Fc pickchick_cloud` из `cloud-db` потоком в пробный контейнер. Пароли ролей в
   пробной базе сразу заменить на временные. Вывод дампа на экран не печатать.
5. В пробной базе от владельца `pickchick_owner` в образе кандидата:
   - `node infra/staging/queue-recovery-cloud-owner.mjs inspect <branch-uuid> <pos-sync> <backoffice>`,
     затем `apply`. Два boolean берутся по факту рабочего окружения: `CLOUD_POS_ORDER_SYNC` и
     `BACKOFFICE_ENABLED` на сервере заданы, значения проверить по окружению API.
   - `node infra/staging/cutover-cloud-owner.mjs inspect`, затем `deploy`.
   - `node infra/staging/cutover-cloud-owner.mjs inspect-075`, затем `deploy-075`.
   - `node infra/staging/cutover-cloud-owner.mjs inspect-076`, затем `deploy-076` (раздел «Вторая
     волна бэк-офиса» мастер-инструкции). Права `supply-grants` в пробе не выдавать.
6. Запустить образ кандидата как API на пробной базе и пробном redis на свободном порту
   `127.0.0.1`, проверить `/health/ready` и 404 на новых маршрутах при выключенных флагах.
7. Записать в протокол все ответы JSON. Убрать пробные контейнеры, сеть и том.

Ожидаемые ответы шагов стоят в `docs/operations/cutover-2026-11-19.md`, шаги 2 и 8, и в
`docs/operations/queue-recovery-cloud-072.md`.

## 4. Живое окно (после закрытия ресторана, не раньше 00:15 по Алматы)

Только после зелёной пробы и зелёной CI.

1. Проверить, что указатель `current` и SHA-256 compose равны разделу 1. Иначе стоп.
2. Свежая копия: `systemctl start pickchick-backup.service`, дождаться успеха, сверить манифест.
   Пробное восстановление этой копии (`infra/staging/restore-drill.py` или прежний порядок).
3. Взять блокировку выпуска (`release-maintenance-lock.py`), остановить писателей по прежнему
   порядку релизов.
4. `queue-recovery-cloud-owner.mjs inspect`, затем `apply` (072).
5. `cutover-cloud-owner.mjs inspect`, затем `deploy` (073 и 074, права, все флаги выключены).
6. `compose-candidate --compose compose.yaml --sha256 3b6d2f55… --out compose.cutover.yaml`,
   записать `composeBefore` и `composeAfter`.
7. Релиз `releases/<sha>` с `release.env`, образ, переключение `current`, запуск API.
8. Проверки: `/health/ready`; заказ приложения; заказ киоска; кухня; POS sync; кабинет; 404 на
   `POST /internal/v1/edge/pos-orders/sales`, `GET …/ops/stock`, `GET …/ops/sales`,
   `GET …/ops/pos-day`.
9. Протокол `pickchick-queue-recovery-cloud-v1` для оператора кассы составляется только по
   фактическим проверкам этого окна.

**Откат:** указатель `current` обратно на `releases/6630eb0f…`, прежний compose, запуск прежнего
API. Схему не откатывать: 072-074 только добавляют, прежний API на них работает (проверено
тестом цепочки и пробой из раздела 3).

**Стоп без продолжения:** любой отказ `guard`, любое несовпадение ledger или байтов, красная
проверка старого потока.

## 5. Чего в окне Cloud-1 нет

075 и 076 по плану идут в ночь 17→18.11 (Cloud-2). Перенос 075 в Cloud-1 - отдельное решение
(мастер-инструкция, §0 п. 1).

## 6. Найденные пробелы

1. В установленном compose сервиса `provision` не видно среди запущенных. В файле репозитория
   он есть под профилем `tools`. Проверить, что в compose релиза `6630eb0f` он тоже есть: команда
   `owner` из мастер-инструкции запускается через него.
2. Закрыто 10.11 (PR #347): для миграции 076 есть охраняемые шаги `inspect-076`, `deploy-076` и
   `supply-grants`. Переменные окружения compose с флагами второй волны
   ставит охраняемый шаг `compose-supply`, включает `compose-flag` (раздел второй волны
   мастер-инструкции).
3. Готового сценария выпуска Cloud-1 (как `release-stage2-1024.py` для 06.11) в репозитории нет.
   Пункты раздела 4 выполняются по шагам вручную или оформляются таким сценарием.
4. Копии базы лежат только на этом же сервере (пункт С6 трекера).
