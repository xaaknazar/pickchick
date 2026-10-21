# Мониторинг staging VPS: watchdog с оповещениями в Telegram

Закрывает находку аудита «нет мониторинга и оповещений». Watchdog только читает
состояние и пишет в Telegram; он не перезапускает контейнеры, не меняет БД, не
создаёт счета и по умолчанию не обращается к банку. Код готов и проверен локально;
**на VPS не установлен**, бот и чат не созданы. Включение - решение оператора.

## Как устроено

```text
pickchick-watchdog.timer (каждые 5 мин, пользователь pickchick-ops)
 └─ run-watchdog.py (host python3, без Node)
     ├─ docker inspect / docker logs трёх Kaspi-контейнеров (только чтение),
     │  statvfs дисков, список зашифрованных копий -> host-facts.json (0600)
     └─ docker compose run --rm watchdog (образ pickchick-api:<sha>)
         ├─ GET http://api:3100/health/ready
         ├─ SELECT от роли pickchick_watchdog (только нужные столбцы)
         ├─ оценка, de-dup, state.json (0600)
         └─ Telegram sendMessage (или печать в journal в shadow/dry-run)
```

- Код: `infra/staging/watchdog/` (`checks.mjs` - пороги, `dedup.mjs` - повторы и
  восстановление, `queries.mjs` - SQL, `run-watchdog.py` - хост, `compose.yaml`).
- Роль БД: `infra/staging/watchdog-grants.mjs`, шаблон секретов:
  `infra/staging/watchdog.env.example`, systemd: `infra/staging/pickchick-watchdog.{service,timer}`.
- Релиз закреплён symlink `/opt/pickchick-staging/watchdog/current -> releases/<sha>`;
  переключение `current` API его не меняет. Runner проверяет `release.env` и label образа.
- Контейнер: read-only root, `cap_drop: ALL`, `no-new-privileges`, 192 MB, 0.25 CPU,
  без портов и **без docker.sock**. Сети: существующая `pickchick-staging_private`
  (cloud-db, api) и отдельная `pickchick-watchdog_egress` для Telegram.
- Docker-команды выполняет только host runner: `version`, `inspect`, `logs`;
  `exec` - только опциональный `session-check.mjs` (ниже). Из логов worker берутся
  лишь собственные JSON-события worker и только счётчики/флаги из белого списка.

## Проверки и пороги

Каждая проверка имеет ключ; одна проблема = одно сообщение, затем напоминание
не чаще `WATCHDOG_RENOTIFY_MINUTES` (120), при ухудшении warning -> critical сразу
«УХУДШЕНИЕ», после исправления одно «НОРМА» с длительностью. Новый сигнал сверки при уже
открытой тревоге «Заказы на разборе» сообщается сразу («НОВЫЙ СЛУЧАЙ»): каждый такой сигнал -
отдельный заказ, который надо разобрать, а не продолжение прежней проблемы. Сбой, исчезнувший
до подтверждения, не отправляется. Если источник недоступен (нет БД, нет Docker),
открытые по нему тревоги не закрываются ложным «НОРМА».

| Проверка                                                                          | Источник                                                                                                                                                                                                                                                                                                                                                   | Порог                                           | Уровень                                  |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| API `/health/ready` не 200/ready                                                  | HTTP из контейнера                                                                                                                                                                                                                                                                                                                                         | 2 прогона подряд (~10 мин)                      | critical                                 |
| Kaspi-контейнеры (мост, worker счетов, QR worker) не найдены/не running/unhealthy | `docker inspect`                                                                                                                                                                                                                                                                                                                                           | 2 прогона                                       | critical                                 |
| Сессия кассира Kaspi                                                              | последнее событие worker за 10 мин: `sessionProblem`/`sessionRejected` + `reason`, `no_cashier_session`; строка восстановления `recovered` или тик с `sessionProblem:false` закрывает тревогу; опционально `session-check.mjs`                                                                                                                             | сразу                                           | critical                                 |
| Ошибки worker                                                                     | `*_attention` с `errors>0`, `*_failed`, `state=disabled`                                                                                                                                                                                                                                                                                                   | 2 прогона                                       | warning                                  |
| Счета без ответа банка (unknownOverdue)                                           | тот же SQL, что у worker (issuing/unknown > 5 мин) + логи; QR киоска с принятым в кабинете инцидентом (`commerce_kiosk_payment_incidents`, менеджер уже проверил Kaspi Pay) считаются отдельно и тревогу не держат                                                                                                                                         | сразу                                           | critical                                 |
| Оплаты ждут отправки в банк                                                       | outbox `payment.submit_requested` без ACK 5-60 мин, попытка pending, без отмены                                                                                                                                                                                                                                                                            | сразу                                           | critical                                 |
| Передача заказов на кухню                                                         | outbox `edge.kitchen_admission_requested` / `edge.admission_requested` без ACK кассы 5 мин - 6 ч, без отмены и attention                                                                                                                                                                                                                                   | сразу                                           | critical (оплаченные) / warning (резерв) |
| Заказы на разборе (сигналы сверки)                                                | новые `commerce_reconciliation_issues` за `WATCHDOG_REVIEW_WINDOW_HOURS` (6 ч): отказ или просрочка передачи оплаченного заказа на кухню, оплата после отмены, расхождения capture/refund; только коды и время, без details. Такие заказы помечены attention и уходят из проверок выше, поэтому без этой проверки переход в разбор выглядел бы как «НОРМА» | сразу, держится окно; новый случай - сразу      | critical                                 |
| Коды входа клиентов: дневной бюджет                                               | `identity_sms_daily_budget.reservations` за текущие сутки UTC против `WATCHDOG_OTP_DAILY_BUDGET` (задать равным `CUSTOMER_AUTH_DAILY_SMS_BUDGET` API; 0 - не проверяется). При исчерпании новые входы в приложение отклоняются до 00:00 UTC                                                                                                                | `WATCHDOG_OTP_BUDGET_WARN_PERCENT` (80%) / 100% | warning / critical                       |
| Коды входа: доставка (лог API)                                                    | `customer_otp_delivery_attention` контейнера `WATCHDOG_API_CONTAINER` за окно логов: провайдер отказал не из-за получателя (баланс/токен Telegram Gateway), вход не работает ни у кого. API пишет строку не чаще раза в 5 мин, пока попытки входа идут                                                                                                     | сразу                                           | critical                                 |
| Коды входа: сигналы бюджета (лог API)                                             | `customer_otp_budget_attention` (pool `new_phones` всегда, pool `all` только при `WATCHDOG_OTP_DAILY_BUDGET=0`); самый высокий порог текущих суток UTC хранится в `state/identity-budget.json` и сбрасывается в 00:00 UTC вместе с бюджетом                                                                                                                | 80% / 100%                                      | warning / critical                       |
| Gateway: адрес клиента                                                            | штатный `client-ip-gateway.py --check` (только чтение) из закреплённого релиза, при `WATCHDOG_GATEWAY_CHECK=true` (включать после релиза gateway направления sec); хранятся только `ok` и коды проблем, без адресов                                                                                                                                        | сразу                                           | critical, warning если проверка упала    |
| Kitchen admission (лог)                                                           | `fulfillment_transport_attention` контейнера `WATCHDOG_FULFILLMENT_CONTAINER` (по умолчанию не задан: worker на Windows-кассе)                                                                                                                                                                                                                             | сразу                                           | warning, critical при parked             |
| Пульс кассы (edge)                                                                | `cloud_branch_availability.observed_at` активной привязки                                                                                                                                                                                                                                                                                                  | > 10 мин или ни разу                            | critical                                 |
| Ключ устройства                                                                   | `device_credentials.expires_at` активных устройств                                                                                                                                                                                                                                                                                                         | < 7 дн warning, истёк critical                  |                                          |
| Резервная копия                                                                   | последний `cloud-*.dump.age` с `.sha256` и размером > 0                                                                                                                                                                                                                                                                                                    | старше 26 ч или нет                             | critical                                 |
| Последний запуск копии                                                            | `backups/backup-status.json` (пишет `backup.sh`; при сбое `OnFailure=` сразу запускает watchdog)                                                                                                                                                                                                                                                           | ошибка на любом этапе                           | critical                                 |
| Внешняя копия                                                                     | `backups/offsite-status.json` (`backup-offsite.py`), если включена или `WATCHDOG_EXPECT_BACKUP_OFFSITE=true`                                                                                                                                                                                                                                               | старше 26 ч, ошибка, нет                        | critical                                 |
| PITR: отправка WAL                                                                | `backups/wal-status.json`, если есть или `WATCHDOG_EXPECT_BACKUP_PITR=true`                                                                                                                                                                                                                                                                                | не запускалась/очередь > 15 мин                 | critical                                 |
| PITR: archive_command                                                             | `pg_stat_archiver` (без grants), только при `WATCHDOG_EXPECT_BACKUP_PITR=true`                                                                                                                                                                                                                                                                             | ошибка после последнего успеха                  | critical                                 |
| Диск                                                                              | statvfs `/`, `/var/lib/docker`, каталога копий                                                                                                                                                                                                                                                                                                             | > 85% warning, > 95% critical                   |                                          |
| Сам мониторинг                                                                    | файл фактов, ошибки сборщика, вход роли БД                                                                                                                                                                                                                                                                                                                 | сразу                                           | warning                                  |

`WATCHDOG_HEARTBEAT_QUIET_HOURS` (например `23:30-08:30`, по `WATCHDOG_TIMEZONE`)
не тревожит о пульсе, когда касса может быть выключена; открытая тревога при этом
не закрывается. Ежедневная сводка (`WATCHDOG_DAILY_SUMMARY=true`, час
`WATCHDOG_DAILY_SUMMARY_HOUR`) приходит раз в сутки и заодно подтверждает, что
мониторинг жив.

### Kaspi-сессия: что видно и что нет

Банк дополнительно не опрашивается. Worker уже проверяет сессию перед каждым счётом
и пишет `kaspi_remote_attention`/`kiosk_kaspi_qr_attention` (раз в 5 мин, пока проблема
есть); watchdog читает эти строки. Ограничение: worker счетов общего среза `76902fa4`
при отказе предварительной проверки **молча откладывает** отправку (с исправлением
направления pay, `codex/fix-pay-1019`, он сообщает `sessionProblem` и `reason`), поэтому
дополнительно включена проверка очереди «оплаты ждут отправки» из БД. Без платежей
проблема сессии не видна. Если владелец согласует, `WATCHDOG_KASPI_SESSION_PROBE_HOURS=6..168`
раз в N часов запускает штатный read-only `session-check.mjs` моста (один запрос
к банку); по умолчанию `0` - выключено. Для немедленной повторной проверки после
нового входа удалить `/opt/pickchick-staging/watchdog/state/kaspi-session-probe.json`.

Интерфейсы других направлений (PM, 19.10): worker счетов Kaspi пишет
`kaspi_remote_attention` с `sessionProblem`, `reason` (`session_inactive`,
`session_missing`, `session_rejected`, `bridge_unreachable`, `unknown_overdue`,
`invoice_not_sent`, `worker_errors`) не чаще раза в 5 мин и одну строку `recovered: true`.
Сборщик оставляет только эти коды и счётчики. Worker передачи на кухню пишет
`fulfillment_transport_attention`, но работает службой `PickChickFulfillmentWorker` на
Windows-кассе, а не в Docker на VPS, поэтому основной сигнал - SQL-проверка «Передача
заказов на кухню»; чтение лога включается только для контейнера на этом хосте.

Интеграция 20.10 (sec -> ops): API пишет `customer_otp_budget_attention` (`pool`, `percent`,
`budget`) и `customer_otp_delivery_attention` (`channel`, `reason`) в stderr контейнера
`pickchick-staging-api-1`; сборщик оставляет только эти поля (без номеров, кодов и ответа
провайдера). `WATCHDOG_API_CONTAINER=-` выключает чтение. Отказ доставки без попыток входа
замолкает, и тревога закрывается через окно логов: это не доказательство, что баланс
пополнен. Проверку бюджета из БД (`identity.otp_budget`) это не заменяет: при заданном
`WATCHDOG_OTP_DAILY_BUDGET` общий бюджет считается по БД, из событий берётся доля новых
номеров. `client-ip-gateway.py --check` запускается от `pickchick-ops` (Docker и файлы
релизов gateway уже доступны этой роли) с таймаутом 60 с; до релиза gateway он честно
сообщит о проблеме, поэтому по умолчанию выключен.

## Секреты и права

- `/opt/pickchick-staging/secrets/watchdog.env`: владелец `pickchick-ops`, `0600`;
  runner отказывается работать с другими правами. Токен бота, chat id и пароль роли
  не выводятся: ошибки содержат только имя переменной или короткий код.
- Роль `pickchick_watchdog`: `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3`, `default_transaction_read_only=on`,
  `statement_timeout=5s`. Только column-level SELECT:
  `devices(id,kind,name,status)`, `device_credentials(device_id,expires_at)`,
  `fulfillment_transport_bindings(branch_id,device_id,active)`,
  `cloud_branch_availability(branch_id,device_id,observed_at)`,
  `commerce_kaspi_invoices(state,issue_started_at)`,
  `commerce_kiosk_kaspi_qr(attempt_id,state,issue_started_at)`,
  `commerce_kiosk_payment_incidents(attempt_id)`,
  `commerce_outbox(order_id,event_type,created_at,acknowledged_at)`,
  `commerce_orders(id,attention_required)`, `commerce_payment_attempts(order_id,account_id,state)`,
  `commerce_provider_accounts(id,provider,kind,enabled)`, `commerce_cancellation_intents(order_id)`,
  `commerce_reconciliation_issues(code,created_at)`,
  `identity_sms_daily_budget(budget_day,reservations)`.
  Нет `token_hash`, телефонов, payload, details, сумм, snapshot. SQL применения в одной
  транзакции снимает все прежние права роли, выдаёт список и проверяет его точное
  совпадение (лишнее/недостающее право - ROLLBACK). В SQL попадает только SCRAM verifier.
- `pickchick-ops` входит в группу docker (как для backup); это административный
  доступ к хосту, watchdog его не расширяет и в контейнер сокет не передаёт.

## Включение (оператор, по шагам)

Предусловия: свежие refs и claim `@vps`; коммит с watchdog вошёл в проверенный
релиз `<sha>` (зелёный CI), `/opt/pickchick-staging/releases/<sha>` и образ
`pickchick-api:<sha>` уже есть на VPS (обычная подготовка релиза; API переключать
не нужно). Не выполнять во время чужого выпуска.

1. Владелец создаёт бота через @BotFather, добавляет его в закрытый операционный
   чат и получает числовой chat id. Токен не пересылать в чаты/тикеты.
2. На VPS от `pickchick-ops`:
   ```sh
   set -euo pipefail; umask 077
   install -d -m 700 /opt/pickchick-staging/watchdog /opt/pickchick-staging/watchdog/state
   install -m 600 /opt/pickchick-staging/releases/<sha>/infra/staging/watchdog.env.example \
     /opt/pickchick-staging/secrets/watchdog.env
   f=/opt/pickchick-staging/secrets/watchdog.env
   sed -i '/^WATCHDOG_DB_PASSWORD=$/d' "$f"
   # printf - встроенная команда bash: пароль не попадает в argv/ps.
   printf 'WATCHDOG_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)" >> "$f"
   ```
   Токен и chat id вписать редактором (`WATCHDOG_TELEGRAM_ENABLED=false` пока оставить).
3. Роль БД (единственное изменение БД; повтор безопасен и ротирует пароль):
   ```sh
   set -o pipefail
   docker run --rm -i --network none --read-only --cap-drop ALL \
     --security-opt no-new-privileges:true pickchick-api:<sha> \
     node infra/staging/watchdog-grants.mjs apply-sql < /opt/pickchick-staging/secrets/watchdog.env \
   | docker exec -i pickchick-staging-cloud-db-1 psql -X -q -v ON_ERROR_STOP=1 -U postgres -d pickchick_cloud
   ```
   Ошибка входа (не тот файл/формат) превращается в `RAISE EXCEPTION`, psql завершится с ошибкой.
4. Закрепить релиз и проверить без отправки:
   ```sh
   ln -sfn /opt/pickchick-staging/releases/<sha> /opt/pickchick-staging/watchdog/current
   r=/opt/pickchick-staging/watchdog/current/infra/staging/watchdog/run-watchdog.py
   python3 $r --collect-only   # обезличенные факты хоста: контейнеры, события, диски, копии
   python3 $r --dry-run        # все проверки и тексты будущих сообщений; state не меняется
   ```
   Ожидается `watchdog.database ok`. Если сеть называется иначе, задать
   `WATCHDOG_STAGING_NETWORK` (проверить `docker network ls`).
5. Владелец root устанавливает timer (как backup):
   ```sh
   install -m 644 /opt/pickchick-staging/watchdog/current/infra/staging/pickchick-watchdog.{service,timer} /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now pickchick-watchdog.timer
   journalctl -u pickchick-watchdog.service -n 50
   ```
   Это shadow mode: тревоги только в journal, state ведётся.
6. После суток без ложных тревог: `WATCHDOG_TELEGRAM_ENABLED=true` (по желанию
   `WATCHDOG_DAILY_SUMMARY=true`), затем `python3 $r --summary` - в чат придёт сводка.
   При переходе из shadow mode state начинается заново: открытые проблемы придут один раз.

Обновление кода: подготовить новый проверенный релиз, `--dry-run` из него,
переключить symlink `watchdog/current`. Ротация токена - правка env; пароля роли -
новое значение в env и повтор шага 3.

## Откат

```sh
systemctl disable --now pickchick-watchdog.timer      # root; оповещения прекращаются
docker run --rm -i --network none pickchick-api:<sha> node infra/staging/watchdog-grants.mjs disable-sql \
  < /opt/pickchick-staging/secrets/watchdog.env \
| docker exec -i pickchick-staging-cloud-db-1 psql -X -q -v ON_ERROR_STOP=1 -U postgres -d pickchick_cloud
```

`disable-sql` делает роль NOLOGIN и снимает все её права; другие роли, API, worker,
мост и данные не меняются. Затем можно удалить `watchdog.env` и каталог
`/opt/pickchick-staging/watchdog`. Отозвать бота в @BotFather.

## Остаточные риски

- Watchdog живёт на том же VPS: при падении VPS/Docker сообщений не будет. Признак -
  отсутствие ежедневной сводки; внешний dead-man switch не настроен.
- Сессия Kaspi видна только при платежах (или при согласованной периодической
  проверке). Время сообщения о проблеме сессии зависит от трафика.
- Пороговые значения выбраны для пилота; при ложных тревогах менять env, не код.
- Локально проверено без Docker: compose, systemd и реальный Telegram не запускались.
