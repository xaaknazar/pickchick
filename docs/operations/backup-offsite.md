# Резервные копии: внешнее хранилище, PITR и учения по восстановлению

Закрывает находки аудита 19.10.2026 5.2 и 7.4: единственная копия была ежедневным дампом на
том же VPS, без внешней копии, без PITR и без сигнала о сбое. Код готов и проверен локально;
**на VPS ничего не установлено**, хранилище не выбрано. Всё новое выключено по умолчанию:
пока владелец не заполнит `backup-offsite.env`, `backup.sh` делает то же, что раньше, плюс
файл статуса и зашифрованный манифест количества строк.

## Что делает код

| Часть                                                                                                                                  | Файл                                                                                    | По умолчанию             |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------ |
| Ежедневная копия (02:15 UTC): `pg_dump` -> age -> `cloud-<stamp>.dump.age` + `.sha256`                                                 | `infra/staging/backup.sh`                                                               | как раньше               |
| Манифест: число строк каждой таблицы и последняя миграция до и после дампа, зашифрован тем же age-ключом                               | `backup.sh` -> `cloud-<stamp>.manifest.json.age`                                        | включено                 |
| Статус для watchdog: время попытки, успеха, этап сбоя                                                                                  | `backups/backup-status.json`                                                            | включено                 |
| Сигнал о сбое: `OnFailure=pickchick-watchdog.service` сразу запускает проверку                                                         | `pickchick-backup.service`                                                              | после переустановки unit |
| Внешняя копия: тот же зашифрованный дамп, манифест и `.sha256` (последним) в S3-совместимое хранилище                                  | `infra/staging/backup-offsite.py upload`                                                | выключено                |
| PITR: непрерывная архивация WAL (`archive_timeout=60s`), отправка каждую минуту (gzip + age), ежедневная базовая копия `pg_basebackup` | `backup-offsite.py pitr-sql/ship-wal/base-backup`, `pickchick-wal-ship.{service,timer}` | выключено                |
| Учения: восстановление в изолированный контейнер (`--network none`), сверка числа строк с манифестом; PITR до заданного времени        | `infra/staging/restore-drill.py`                                                        | запуск вручную           |

Всё, что уходит наружу, уже зашифровано публичным age-ключом `secrets/backup-recipient.txt`.
Приватный ключ остаётся только у владельца (на VPS его нет). S3-клиент написан на стандартной
библиотеке Python (подпись AWS SigV4, `Content-MD5`), новых пакетов на VPS не нужно.

## RPO и RTO

- Без PITR: RPO до 24 ч (дамп раз в сутки), но копия переживает потерю VPS, если включено
  внешнее хранилище.
- С PITR: `archive_timeout=60s` + отправка раз в минуту = RPO около 2 мин при работающем
  хранилище (цель ТЗ RPO <= 5 мин). Если отправка отстаёт больше 15 мин, watchdog шлёт
  тревогу `backup.wal`.
- RTO измеряется учением: `restore-drill.py` печатает `restoreSeconds`. Локально синтетическая
  БД восстанавливалась за десятки секунд; реальное время нужно замерить на VPS (цель <= 60 мин).

## Хранилище и права (решает владелец)

1. Независимое S3-совместимое хранилище у другого провайдера или в другом регионе РК.
   Bucket с **versioning** и, если провайдер поддерживает, **object lock** (режим compliance,
   14 дней) - тогда даже украденный ключ VPS не удалит копии.
2. Lifecycle-правило хранения (предложение): `dumps/` - 35 дней, `base/` - 14 дней,
   `wal/` - 14 дней (окно PITR), старые версии - 7 дней. Локально на VPS по-прежнему 7 дней.
3. Два ключа доступа:
   - ключ VPS: только `PutObject` на префикс `pickchick-staging/` (без чтения, списка, удаления);
   - ключ учений: только `GetObject` + `ListBucket`; хранится у владельца, на VPS не кладётся.

## Включение внешней копии (оператор, после решения владельца)

Предусловия: релиз с этим кодом уже в `/opt/pickchick-staging/current` (обычный выпуск API),
claim `@vps`, не во время чужого выпуска.

```sh
# pickchick-ops на VPS
umask 077
install -m 600 /opt/pickchick-staging/current/infra/staging/backup-offsite.env.example \
  /opt/pickchick-staging/secrets/backup-offsite.env
# Вписать редактором endpoint, bucket, ключ VPS; BACKUP_OFFSITE_ENABLED=true.
# Проверка без ожидания ночи (полный цикл: дамп, манифест, выгрузка):
bash /opt/pickchick-staging/current/infra/staging/backup.sh
cat /opt/pickchick-staging/backups/backup-status.json /opt/pickchick-staging/backups/offsite-status.json
```

Root переустанавливает unit с `OnFailure=` и перечитывает systemd:

```sh
install -m 644 /opt/pickchick-staging/current/infra/staging/pickchick-backup.service /etc/systemd/system/
systemctl daemon-reload
```

В `watchdog.env` поставить `WATCHDOG_EXPECT_BACKUP_OFFSITE=true` - тогда отсутствие или
устаревание внешней копии (> 26 ч) станет критической тревогой.

## Включение PITR (отдельное решение, нужна одна перезагрузка cloud-db)

Настройки архивации пишутся через `ALTER SYSTEM` в `postgresql.auto.conf` внутри тома БД,
поэтому следующие выпуски (пересоздание контейнера compose) их не теряют. Архив WAL лежит в
том же томе (`/var/lib/postgresql/wal-archive`); `ship-wal` читает и удаляет файлы только через
`docker exec` и только после успешной выгрузки.

```sh
f=/opt/pickchick-staging/secrets/backup-offsite.env   # BACKUP_PITR_ENABLED=true
python3 /opt/pickchick-staging/current/infra/staging/backup-offsite.py pitr-sql enable \
  | docker exec -i pickchick-staging-cloud-db-1 psql -X -q -v ON_ERROR_STOP=1 -U postgres -d pickchick_cloud
docker restart pickchick-staging-cloud-db-1     # 5-15 с недоступности API; в тихое окно
docker exec pickchick-staging-cloud-db-1 psql -U postgres -Atc 'SHOW archive_mode'   # on
python3 /opt/pickchick-staging/current/infra/staging/backup-offsite.py base-backup
# root:
install -m 644 /opt/pickchick-staging/current/infra/staging/pickchick-wal-ship.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now pickchick-wal-ship.timer
```

Затем `WATCHDOG_EXPECT_BACKUP_PITR=true` в `watchdog.env`: watchdog проверяет
`pg_stat_archiver` (ошибки `archive_command`) и `wal-status.json` (отставание отправки).
Ежедневный `backup.sh` при включённом PITR сам делает новую базовую копию.

## Учения по восстановлению

Только в изолированный контейнер; рабочая БД не затрагивается. Ключ подаётся через stdin
и не записывается на диск.

```sh
# Копия с VPS или из внешнего хранилища (ключ учений, на компьютере владельца):
python3 infra/staging/backup-offsite.py list pickchick-staging/dumps/      # нужен env с ключом учений
python3 infra/staging/backup-offsite.py fetch pickchick-staging/dumps/cloud-<stamp>.dump.age ./cloud-<stamp>.dump.age
# (то же для .sha256 и .manifest.json.age)

# Восстановление дампа и сверка числа строк (на VPS - приватный ключ через SSH stdin):
ssh pickchick-ops@<vps> 'python3 /opt/pickchick-staging/current/infra/staging/restore-drill.py dump \
  --dump /opt/pickchick-staging/backups/cloud-<stamp>.dump.age --require-manifest --identity -' \
  < ~/.../backup-identity.agekey

# PITR: базовая копия + WAL до нужного момента (UTC):
python3 infra/staging/restore-drill.py pitr --base base-<stamp>.tar.gz.age --wal-dir ./wal \
  --target-time 2026-10-20T08:15:00Z --identity - < backup-identity.agekey
```

На VPS учение занимает до 768 МБ RAM и 1 CPU (лимиты контейнера): запускать в тихое окно
или на компьютере владельца с Docker и тем же образом.

Отчёт - одна JSON-строка без данных строк: `ok`, `restoreSeconds`, `migration`, число таблиц и
строк, `problems` (таблица отсутствует, лишняя, число строк вне диапазона «до/после дампа»,
другая миграция). Код выхода 0 только при успехе. Результат каждого учения записывать в
deployment record с датой и `restoreSeconds` (это и есть измеренный RTO). Рекомендация:
раз в месяц и после каждого изменения схемы/хранилища.

Ограничение сверки: счётчики читаются до и после дампа, а не в его снимке. Таблица, в которой
за время дампа строки и добавлялись, и удалялись (очистка сессий, бюджетов OTP и т.п.), может
дать `row_count` вне диапазона без потери данных. Такую строку отчёта проверить по смыслу
таблицы и повторить учение на следующей копии; расхождение в таблицах денег и заказов
(`commerce_*`, `bo_finance_*`) - повод разбираться сразу.

## Откат

- Внешняя копия: `BACKUP_OFFSITE_ENABLED=false` (или удалить `backup-offsite.env`); локальные
  копии продолжаются. В `watchdog.env` вернуть `WATCHDOG_EXPECT_BACKUP_OFFSITE=false`.
- PITR: `systemctl disable --now pickchick-wal-ship.timer`;
  `backup-offsite.py pitr-sql disable | docker exec -i ... psql ...` (сначала
  `archive_command='/bin/true'`, чтобы WAL не копился), затем `docker restart` cloud-db в тихое
  окно; `BACKUP_PITR_ENABLED=false`; `WATCHDOG_EXPECT_BACKUP_PITR=false`.
- Код: предыдущий релиз. Старый `backup.sh` игнорирует новые файлы; удалять их не нужно.

## Проверено локально (19-20.10.2026)

- `python3 -m unittest tests/operations/test_backup_offsite.py`: подпись SigV4 сверена с
  примерами документации AWS; S3-двойник проверяет подпись и `Content-MD5`; `backup.sh` с
  поддельным `docker` и настоящим `age`: дамп, манифест, выгрузка в порядке дамп -> манифест ->
  `.sha256`, статусы; отказ хранилища (403) и сбой `pg_dump` фиксируют этап, локальная копия
  сохраняется, частичных файлов нет; отправка WAL удаляет файл только после выгрузки.
- `python3 -m unittest tests/operations/test_restore_drill_docker.py` на закреплённом образе
  `postgres:18.3-alpine`: восстановление дампа в изолированный контейнер со сверкой строк,
  отказ при неверном манифесте и повреждённом файле; PITR: `pitr-sql enable` + перезапуск,
  `base-backup`, `ship-wal`, восстановление только из «внешнего» хранилища до момента между
  двумя вставками - строки до момента есть, после - нет.
- Не проверено: реальный провайдер S3 (virtual-host адресация, object lock), systemd на VPS,
  время восстановления реальной БД.
