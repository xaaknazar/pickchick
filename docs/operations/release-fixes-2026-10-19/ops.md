# Release fixes 19.10.2026: направление «Эксплуатация» (ops)

Ветка `codex/fix-ops-1019` от общего среза `76902fa4`. Мониторинг, резервные копии, ёмкость
API, правдивость документации и закрытие месяца в финансах. Ничего не выполнялось на VPS,
в банке, Telegram или у провайдера хранилища: всё проверено локально, новое по умолчанию
выключено.

## Итог по находкам

| Находка                                 | Статус                                          | Что сделано                                                                                                         |
| --------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| «Нет алертинга» (аудит)                 | исправлено в коде, не установлено               | Watchdog из `codex/ops-alerts` перенесён и расширен (ниже)                                                          |
| Ёмкость long-poll (аудит)               | исправлено                                      | `codex/api-capacity` перенесён; конфликт с бюджетом меню mobile разрешён в пользу установленных клиентов            |
| 5.2 / 7.4 Резервные копии               | частично (код готов, нужно хранилище владельца) | Внешняя зашифрованная копия, PITR, учения, статус и `OnFailure=`                                                    |
| 7.5 Документы и API занижают production | частично                                        | `notice` в `/v1/capabilities`, ADR-0012, docs; факты для status/roadmap - ниже (их меняет integration)              |
| 7.6 Факты только в неслитых ветках      | частично                                        | Документы relogin и App Store audit влиты, runbook и дефект EROFS описаны; сам дефект моста не исправлен (владелец) |
| 4.4 Закрытие месяца не кумулятивно      | исправлено, **требует приёмки финансового Mac** | Закрытие месяца блокирует все более ранние даты; открытие - в обратном порядке                                      |

## Мониторинг и оповещения (watchdog)

Перенесён коммит `62e2e5e2` из `codex/ops-alerts` (watchdog на VPS: systemd timer раз в 5
мин, read-only роль `pickchick_watchdog`, Telegram; без Telegram - shadow mode в journal).
Конфликтовали только `docs/project-status.md` и `docs/roadmap/project.json` - их изменения
не перенесены (зарезервированы за integration). Подробности: [ops-watchdog.md](../ops-watchdog.md).

Добавлено в этом выпуске:

- **Сессия Kaspi** по интерфейсу pay -> ops: читаются `sessionProblem`, `reason`
  (`session_inactive`, `session_missing`, `session_rejected`, `bridge_unreachable`,
  `unknown_overdue`, `invoice_not_sent`, `worker_errors`), `pendingUnsent`,
  `oldestUnsentSeconds`, строка `recovered: true`. Действует последнее явное состояние:
  восстановление или тик с `sessionProblem:false` закрывает тревогу сразу. Для
  `bridge_unreachable` текст советует проверить контейнер моста.
- **Оплаты, не отправленные в банк**, старше 5 мин - теперь critical (было warning, 3 мин).
- **Передача на кухню**: SQL по `commerce_outbox` - `edge.kitchen_admission_requested`
  (оплачено, касса не взяла; critical) и `edge.admission_requested` (резерв; warning) без ACK
  дольше 5 мин (окно 6 ч, без отмен и attention). Worker передачи работает службой
  `PickChickFulfillmentWorker` на Windows-кассе, его лог на VPS не виден, поэтому основной
  сигнал - БД. События `fulfillment_transport_attention` (интерфейс ful -> ops) читаются,
  если worker работает в контейнере на хосте (`WATCHDOG_FULFILLMENT_CONTAINER`).
- **Заказы на разборе** (`orders.review`, critical; добавлено на ревью техлида): новые
  `commerce_reconciliation_issues` за `WATCHDOG_REVIEW_WINDOW_HOURS` (6 ч) по кодам -
  отказ или просрочка передачи оплаченного заказа на кухню (ful: `KITCHEN_ADMISSION_REFUSED`,
  `KITCHEN_ADMISSION_OVERDUE` через 15 мин), оплата после отмены (pay), расхождения
  capture/refund. Такие заказы помечены attention и уходят из проверок выше, поэтому без этой
  проверки переход оплаченного заказа в разбор выглядел бы как «НОРМА». Роль получила только
  `SELECT(code, created_at)` на `commerce_reconciliation_issues` (без `details`). Новый
  сигнал при уже открытой тревоге сообщается сразу («НОВЫЙ СЛУЧАЙ»), а не через 2 часа с
  напоминанием: каждый сигнал - отдельный заказ для разбора (ревью техлида, тест
  `a new review case while the review alert is open is announced at once`).
- **Коды входа клиентов** (`identity.otp_budget`; добавлено на ревью техлида, блокер аудита
  «OTP budget >80%»): `identity_sms_daily_budget.reservations` за текущие сутки UTC против
  `WATCHDOG_OTP_DAILY_BUDGET` (оператор ставит равным `CUSTOMER_AUTH_DAILY_SMS_BUDGET` API;
  0 - выключено). Warning с `WATCHDOG_OTP_BUDGET_WARN_PERCENT` (80%), critical при исчерпании
  (новые входы отклоняются до 00:00 UTC; время сброса - в часовом поясе оператора). Роль
  получила только `SELECT(budget_day, reservations)`. События `customer_otp_budget_attention`
  линии sec из логов API не читаются: БД даёт тот же процент без окна логов.
- **Резервные копии**: `backup.run` (последний запуск упал - этап), `backup.offsite` (возраст
  внешней копии), `backup.wal` (отставание отправки WAL), `backup.archiver`
  (`pg_stat_archiver`, без новых grants).
- Без изменений: ключ устройства (`device_credentials.expires_at`, < 7 дней warning, истёк
  critical), пульс кассы, контейнеры Kaspi, диск, возраст локальной копии.

## Ёмкость API (long-poll, edge)

Перенесены `81408362` и `8e7f260c` из `codex/api-capacity`
([http-admission-pools.md](../http-admission-pools.md)). Конфликт: в общем срезе уже был
отдельный бюджет 256 для `GET /v1/customer-checkout/availability` (меню mobile). Он сохранён
без изменений, чтобы установленные mobile-сборки вели себя как раньше; меню mobile не
переведено в long-poll бюджет и per-IP лимит. В long-poll бюджет (`HTTP_MAX_LONG_POLL`, 64) переведены `GET /v1/kiosk-checkout/availability?after=` и
`GET /v1/customer-checkout/orders/:id/watch`, которые раньше занимали обычные слоты
(`HTTP_MAX_IN_FLIGHT`, 32): при переполнении они после паузы отвечают текущим состоянием
(тот же ответ, что истёкшее ожидание), а не 503. Резерв `HTTP_MAX_EDGE_IN_FLIGHT` (16) для
`/internal/v1/edge/*`, дополнительно к ветке помечен `DeviceAccessTransportController`
(`/internal/v1/edge/devices/exchange`). Per-IP лимит - только при
`HTTP_LONG_POLL_PER_IP_ENABLED=true` и `TRUSTED_PROXY_IPS`. Новая метрика
`pickchick_catalog_watches_in_flight`.

## Резервные копии (5.2, 7.4)

Подробно: [backup-offsite.md](../backup-offsite.md). Кратко:

- `backup.sh`: зашифрованный манифест числа строк каждой таблицы до/после дампа,
  `backups/backup-status.json` (время, этап сбоя), вызов `backup-offsite.py`.
- `backup-offsite.py` (stdlib Python, SigV4): выгрузка уже зашифрованного age дампа,
  манифеста и `.sha256` в S3-совместимое хранилище; ключ VPS - только запись; хранение и
  неизменяемость - lifecycle/object lock бакета. Статус `offsite-status.json`.
- PITR (опция): `pitr-sql enable` (ALTER SYSTEM: `archive_mode=on`, `archive_timeout=60s`,
  `archive_command` с fsync и проверкой дубликатов; переживает пересоздание контейнера) +
  одна перезагрузка cloud-db; `ship-wal` каждую минуту (gzip + age, удаление только после
  выгрузки); ежедневный `base-backup` (`pg_basebackup -X fetch`). Ожидаемый RPO около 2 мин.
- `restore-drill.py`: `dump` - изолированный контейнер `--network none`, `pg_restore
--exit-on-error`, сверка числа строк с манифестом и миграции; `pitr` - базовая копия +
  WAL до `--target-time`, promote. Ключ age только через stdin, в памяти.
- `pickchick-backup.service`: `OnFailure=pickchick-watchdog.service`, `TimeoutStartSec=2h`.
  Новые units: `pickchick-wal-ship.{service,timer}`.

## Документы (7.5, 7.6)

- `/v1/capabilities`: булевы поля v1 **оставлены `false`** - установленный mobile build 20
  (`parseCapabilities`) и киоск отказываются загружать меню при любом другом значении
  (проверено тестом с настоящим парсером mobile). Исправлен только `notice`: при включённом
  mobile Kaspi (`CUSTOMER_KASPI_PILOT_ENABLED=true`, `CUSTOMER_KASPI_SALES_ENABLED` не
  `false`) он говорит об оплате через Kaspi, при выключателе продаж владельца
  (`CUSTOMER_KASPI_SALES_ENABLED=false`) - что оплата в приложении временно приостановлена
  (прежний текст «доступны без оплаты» там был бы неправдой). Описание шлюза:
  [api-capabilities.md](../../architecture/api-capabilities.md). Release-скрипты,
  сравнивающие capabilities до/после, увидят изменение `notice` - ожидаемо.
- ADR-0012: статус «работает с реальными деньгами с 30.09», без возвратов и чеков.
- `kaspi-remote.md`: устаревшая запись «checkout закрыт» помечена; новый раздел про
  повторный вход кассира, дефект EROFS и runbook.
- Влиты без изменений: `docs/operations/kaspi-relogin-2026-10-13.md`
  (`mac/codex/kaspi-relogin-1013`) и `docs/audits/mobile-appstore-readiness-2026-10-14.md`
  (`mac/codex/mobile-appstore-audit-1014`).

### Факты для integration (status/roadmap/handoff не менялись этим направлением)

По `docs/roadmap/project.json` (updatedAt 2026-10-14) и `docs/project-status.md`:

| Задача roadmap                                                | Сейчас                                                         | Предлагается                                                                           | Доказательство                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `mobile-live-checkout`                                        | deployed=false                                                 | deployed=true (все подтверждённые клиенты)                                             | `kaspi-live-activation.md`, раздел «Все подтверждённые клиенты: установленный выпуск» |
| `platform-domain-https`                                       | deployed=false, «на VPS не применено»                          | deployed=true                                                                          | `cabinet-entry.md`, «Установлено и проверено»                                         |
| `pick-farm-prototype`, `pick-farm-progression`                | active                                                         | закрыть/архивировать (Pick Farm убрана из новых сборок 10.10)                          | коммит `056ddb64`                                                                     |
| `platform-backup`                                             | done, deployed=true                                            | active: на VPS только локальный дамп; внешняя копия/PITR/учения в коде, не установлены | этот документ, `backup-offsite.md`                                                    |
| `platform-monitoring`                                         | planned                                                        | implemented=true, verified=true (локально), deployed=false                             | `ops-watchdog.md`, тесты ниже                                                         |
| `identity-telegram-login`, `identity-telegram-vps-activation` | done, но summary «0 клиентов/сессий, причина не установлена»   | перепроверить summary                                                                  | аудит 7.5                                                                             |
| `daily-order-numbers`, `restaurant-customer-copy`             | ссылки на «VPS ещё 020», «Actions не запускаются из-за оплаты» | обновить формулировки                                                                  | аудит 7.5                                                                             |
| Фотокабина киоска                                             | нет в status/roadmap                                           | добавить: установлена на iPad build 22, 15.10                                          | `kiosk-photo-ipad.md`                                                                 |
| Повторный вход Kaspi 13.10                                    | нет                                                            | добавить; дефект EROFS открыт                                                          | `kaspi-relogin-2026-10-13.md`                                                         |
| App Store audit 14.10                                         | только в ветке Mac                                             | теперь `docs/audits/mobile-appstore-readiness-2026-10-14.md`                           | этот выпуск                                                                           |

## Финансы: закрытие месяца (4.4) - требует приёмки финансового Mac

`packages/backoffice-core/src/finance.ts`: запись, отмена, исправление или новый счёт с датой
(денежной, признания, открытия счёта) в закрытом месяце **или раньше последнего закрытого
месяца** отклоняются `CONFLICT`. Повторное открытие месяца отклоняется, пока закрыт более
поздний месяц. Данные, схема и интерфейс не менялись; таблица периодов в кабинете
по-прежнему показывает только явно закрытые/открытые месяцы (рекомендация финансовому
Mac: пояснить в UI, что закрытие кумулятивно). Требование закрывать месяцы строго по
порядку не вводилось. Коммит помечен «требует приёмки финансового Mac»
([finance-ownership.md](../../collaboration/finance-ownership.md)).

## Решения PM, которые учтены

- Интерфейсы pay -> ops (`kaspi_remote_attention` с `sessionProblem`/`reason`, раз в 5 мин,
  строка восстановления) и ful -> ops (`fulfillment_transport_attention`) приняты в watchdog.
- Решение 4 (флаг продаж Kaspi mobile): `notice` учитывает `CUSTOMER_KASPI_SALES_ENABLED`.
- Edge key: источник истины - `device_credentials.expires_at` (без изменений).

## Флаги и переменные

| Имя                                     | По умолчанию | Смысл                                                                    |
| --------------------------------------- | ------------ | ------------------------------------------------------------------------ |
| `HTTP_MAX_LONG_POLL`                    | 64           | ожидающие long-poll (kiosk availability `?after=`, mobile order watch)   |
| `HTTP_LONG_POLL_PER_IP_ENABLED`         | false        | per-IP лимит long-poll (новый путь 429), только с `TRUSTED_PROXY_IPS`    |
| `HTTP_MAX_LONG_POLL_PER_IP`             | 16           | лимит на адрес при включённом флаге                                      |
| `HTTP_MAX_EDGE_IN_FLIGHT`               | 16           | резерв для `/internal/v1/edge/*`                                         |
| `HTTP_LONG_POLL_OVERFLOW_DELAY_MS`      | 5000         | пауза ответа при переполнении (1000-20000)                               |
| `WATCHDOG_TELEGRAM_ENABLED`             | false        | отправка в Telegram (иначе shadow mode)                                  |
| `WATCHDOG_PAYMENT_BACKLOG_MINUTES`      | 5            | порог «оплаты ждут отправки в банк» (critical)                           |
| `WATCHDOG_KITCHEN_BACKLOG_MINUTES`      | 5            | порог «заказы не переданы на кухню»                                      |
| `WATCHDOG_REVIEW_WINDOW_HOURS`          | 6            | сколько часов держится тревога о новых сигналах сверки (1-72)            |
| `WATCHDOG_OTP_DAILY_BUDGET`             | 0            | дневной бюджет кодов входа (= `CUSTOMER_AUTH_DAILY_SMS_BUDGET`; 0 - нет) |
| `WATCHDOG_OTP_BUDGET_WARN_PERCENT`      | 80           | порог warning для бюджета кодов входа (10-99)                            |
| `WATCHDOG_EXPECT_BACKUP_OFFSITE`        | false        | требовать внешнюю копию (иначе проверка только при наличии статуса)      |
| `WATCHDOG_BACKUP_OFFSITE_MAX_AGE_HOURS` | 26           | возраст внешней копии                                                    |
| `WATCHDOG_EXPECT_BACKUP_PITR`           | false        | требовать PITR (`backup.wal`, `backup.archiver`)                         |
| `WATCHDOG_WAL_MAX_DELAY_MINUTES`        | 15           | отставание отправки WAL                                                  |
| `WATCHDOG_FULFILLMENT_CONTAINER`        | пусто        | контейнер с `fulfillment_transport_attention`                            |
| `BACKUP_OFFSITE_ENABLED`                | false        | внешняя копия (`secrets/backup-offsite.env`, 0600)                       |
| `BACKUP_S3_*`                           | пусто        | endpoint (https), регион, bucket, префикс, ключ, адресация               |
| `BACKUP_PITR_ENABLED`                   | false        | WAL shipping и базовая копия (нужен off-site)                            |

Шаблоны: `.env.example`, `infra/staging/watchdog.env.example`,
`infra/staging/backup-offsite.env.example`.

## Миграции и контракты

Миграций нет (номера 069-070 не использованы). `packages/contracts` не менялся
(`pnpm contracts:check` - согласовано). Роль watchdog создаётся скриптом
`infra/staging/watchdog-grants.mjs` (оператором, не миграцией).

## Развёртывание

1. Обычный выпуск API-образа с этим коммитом (admission, capabilities `notice`, finance).
   Перед выпуском - согласие финансового Mac на 4.4. Проверить метрики:
   `curl -fsS http://127.0.0.1:13100/health/metrics | grep -E 'long_poll|edge_|catalog_watches'`.
2. Watchdog: по [ops-watchdog.md](../ops-watchdog.md) (бот, `watchdog.env`, роль, shadow
   mode сутки, затем Telegram).
3. Копии: после выбора хранилища - по [backup-offsite.md](../backup-offsite.md); root
   переустанавливает `pickchick-backup.service` (OnFailure). PITR - отдельным решением.

## Откат

- API: предыдущий образ (данные и схема не менялись). Прежнее поведение admission
  возвращается только прежним образом; бюджеты можно поднять переменными, per-IP выключен
  по умолчанию.
- Finance: прежний образ возвращает старое (некумулятивное) поведение; данные не менялись.
- Watchdog: `systemctl disable --now pickchick-watchdog.timer`, `watchdog-grants.mjs
disable-sql`.
- Копии: `BACKUP_OFFSITE_ENABLED=false`; PITR - `pitr-sql disable` + перезапуск cloud-db.

## Владельцу (не делается кодом)

1. Telegram-бот и закрытый чат для оповещений; установка watchdog на VPS; в `watchdog.env`
   задать `WATCHDOG_OTP_DAILY_BUDGET` равным `CUSTOMER_AUTH_DAILY_SMS_BUDGET` API. Баланс
   Telegram Gateway (коды входа) watchdog не проверяет: это запрос к внешнему API с ключом,
   владелец смотрит баланс в кабинете Gateway.
2. Независимое S3-совместимое хранилище в РК (другой провайдер/регион): bucket с
   versioning/object lock, lifecycle, два ключа (запись для VPS, чтение для учений).
3. Решение о PITR (одна перезагрузка cloud-db в тихое окно).
4. Первое учение по восстановлению на реальной копии; записать `restoreSeconds` (RTO).
5. Исправление дефекта EROFS моста Kaspi (ECDH в памяти в патче или tmpfs на путь ключа)
   с проверкой на реальном входе; закоммитить изолированный оператор входа, который сейчас
   есть только на Mac.
6. Внешний dead-man switch (watchdog живёт на том же VPS: признак проблемы - нет ежедневной
   сводки).
7. Приёмка финансовым Mac изменения закрытия месяца (4.4).

## Проверки (локально, свежая БД `reset-db.sh ops`)

20.10.2026, после `reset-db.sh ops`:

- `pnpm build`, `pnpm -r typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm contracts:check` - успешно.
- `pnpm test` (все unit) - 292/292; в том числе `ops-watchdog`, `watchdog-grants`,
  `admission`, `capabilities`.
- `pnpm test:integration` (60 файлов) - 356 тестов: 311 прошли, 3 пропущены, 42 упали
  только с `ECONNREFUSED 127.0.0.1:55432/55433` (порты фикстур по умолчанию из
  `infra/local`, на этой машине их нет). Эти 6 файлов (`terminal-access`,
  `edge-fulfillment-http`, `cloud-channel-stops`, `edge-migration-order`,
  `edge-runtime-grants`, `local-pos-draft`) повторены с
  `EDGE_FULFILLMENT_TEST_DATABASE_URL`, `EDGE_FULFILLMENT_CLOUD_TEST_DATABASE_URL`,
  `COMMERCE_TEST_DATABASE_URL`, `LOCAL_POS_DRAFT_TEST_DATABASE_URL` на БД направления -
  44/44. В том числе `ops-watchdog`, `admission-pools`, `admission`.
- `pnpm --filter @pickchick/backoffice-core test` 5/5, `test:integration` 22/22 (с теми же
  URL фикстур); `pnpm test:backoffice` 106/106.
- `tests/backoffice/finance-postgres.test.mjs` - новый тест сначала падал (августовская
  запись принималась при закрытом сентябре), после исправления проходит.
- `python3 -m unittest discover -s tests/operations -p 'test_*.py'` - 475 тестов, OK
  (9 пропущены: нет caddy/PowerShell/внешней PostgreSQL); в том числе
  `test_backup_offsite.py` (SigV4 по примерам AWS, двойник S3, `backup.sh` с поддельным
  docker и настоящим age) и `test_restore_drill_docker.py` (настоящий Docker: восстановление
  дампа и PITR на закреплённом `postgres:18.3-alpine`).

### Ревью техлида (20.10.2026)

Ревью `76902fa4..HEAD`; исправления отдельными коммитами:

- `1319ec7f` - тревога `orders.review` (заказы, ушедшие на разбор, иначе выпадали из проверок
  кухни и оплаты как «НОРМА»); `b5c54925` - `notice` при выключателе продаж не говорит «без
  оплаты»; `0080a244` - точные комментарии PITR и ограничение сверки в учении.
- `871d89e9` - новый сигнал сверки при открытой тревоге сообщается сразу («НОВЫЙ СЛУЧАЙ»);
  тест сначала падал на прежней логике (событий не было), теперь проходит.
- `42d86f3e` - тревога о дневном бюджете кодов входа (`identity.otp_budget`, выключена по
  умолчанию); очистка временной схемы теста watchdog без лимита 5 с.
- `cb6e9307` - общий помощник `tests/helpers/sync.mjs` удаляет временные схемы без
  `statement_timeout` 5 с: под нагрузкой общей машины `DROP SCHEMA` не успевал и подменял
  результат прошедших тестов (41 из 47 сбоев полного прогона).

Доказательства «падает на прежней логике, проходит сейчас»: 4.4 - тест `month close is
cumulative` с `finance.ts` из `76902fa4` падает (`Missing expected rejection: entry`), с
исправлением проходит; «НОВЫЙ СЛУЧАЙ» - тест падает без коммита `871d89e9`; long-poll -
`admission-pools` проверяет `admission.active === 0` при 40 открытых long-poll (в `76902fa4`
kiosk `?after=` занимал обычный слот); 7.5 - `capabilities.test.mjs` (прежний текст «без
оплаты» не проходит).

Прогоны на свежей БД (`reset-db.sh ops`, env фикстур направлены на БД направления, включая
`FULFILLMENT_TRANSPORT_CLOUD_TEST_DATABASE_URL`):

- `pnpm build`, `pnpm -r typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm contracts:check` - успешно; `pnpm test` - 295/295.
- `pnpm test:integration` - 356: 306 прошли, 3 пропущены, 47 упали только с `57014`
  (statement timeout под нагрузкой машины, load average 5-6 на 2 vCPU, в основном очистка
  `DROP SCHEMA`). После `cb6e9307` 20 упавших файлов повторены на свежей БД - 196/197,
  оставшийся `cloud-kitchen.test.mjs` (та же очистка в самом файле) отдельно - 11/11.
  `ops-watchdog`, `admission-pools`, `admission` прошли в полном прогоне.
- `pnpm test:backoffice` - 106/106, `@pickchick/backoffice-core test` - 5/5.
- `python3 -m unittest discover -s tests/operations` - 475, OK (9 пропущены, как раньше);
  `test_restore_drill_docker.py`, `test_backup_offsite.py`, `test_ops_watchdog_runner.py` -
  33/33 без пропусков, контейнеров и томов учений не осталось.

## Не проверено

- Реальный Telegram, systemd, Docker compose watchdog на VPS.
- Реальный провайдер S3 (virtual-host адресация, object lock, lifecycle), время
  восстановления реальной БД, нагрузка на VPS при учении.
- Per-IP лимит на `orders/:id/watch` в integration (нужен вход клиента и заказ): только unit.
- События pay/ful проверены по их веткам на 19.10 (`codex/fix-pay-1019`,
  `codex/fix-ful-1019`), не по слитому коду. На ревью сверено: `KaspiAttention` (pay) пишет
  `sessionProblem`, `sessionRejected`, `reason`, `pendingUnsent`, `oldestUnsentSeconds` и
  строку `recovered: true`; `TransportAttention` (ful) - `deferred`, `parked`, `reasons`,
  `unresolvedFailures` (может быть `null` - отбрасывается) и `recovered: true`. Поля совпадают
  с белыми списками `run-watchdog.py` и `host-facts.mjs`.
- После перезапуска Kaspi worker без строки восстановления (новый процесс её не пишет)
  тревога сессии закрывается, когда старая строка уходит из окна логов (до 10 мин).

## Ожидаемые конфликты

- `services/api/src/index.ts`: ful меняет импорты рядом с `CapabilitiesController`;
  ожидается автоматическое слияние (разные блоки).
- `packages/platform/src/http.ts`: mob меняет `SafeExceptionFilter`, ops - метрики
  (разные блоки).
- `docs/operations/kaspi-remote.md`: pay добавляет абзац в середину, ops - раздел в конец и
  правку раздела «Не сделано».
- `services/api/src/device-registry-controller.ts`: ops добавил `@EdgeDeviceRoute()` на
  `DeviceAccessTransportController`; pos (ключ кассы) может менять этот файл.
- `services/api/src/fulfillment-transport-controller.ts`: ops - импорт `EdgeDeviceRoute` и
  декоратор над классом, ful - импорт `fulfillmentPullOptions` и поле `pullOptions` сразу под
  `export class`; соседние строки, возможен ручной конфликт (оставить оба изменения).
- pos добавляет `@Controller('internal/v1/edge/identity')` (ротация ключа кассы) без
  `@EdgeDeviceRoute()`: после слияния integration стоит добавить декоратор, иначе ротация
  идёт через обычный бюджет (как все edge-маршруты до этого выпуска; не регрессия).
- `services/api/src/customer-checkout-controller.ts` (`watch`): ops - декоратор
  `@LongPollRoute()` и строка `deadline` (`longPollMayWait`), mob (2.8) - тело цикла
  (`watchCheckoutOrder`); оставить оба: при переполнении `deadline` = сейчас, и
  `watchCheckoutOrder` отвечает одним чтением.
- Линия sec: `client-ip-gateway.py --check` (проверка доверенного прокси gateway) появится
  только после слияния sec; подключить его к host runner watchdog - задача integration/владельца
  (в этой ветке файла нет). `customer_otp_budget_attention` не нужен: бюджет читается из БД.
- `docs/audits/mobile-appstore-readiness-2026-10-14.md`: если mob тоже вливает файл -
  содержимое идентично ветке Mac.
- Ветки `mac/*`: `kaspi-relogin-1013` и `mobile-appstore-audit-1014` теперь содержатся
  в этом выпуске по содержимому файлов.
