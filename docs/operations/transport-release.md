# Проверяемый staging-выпуск транспорта с выключенными функциями

`infra/staging/release-transport.py` подготавливает и применяет только переход
с API **и web** `7cd53b6300ad9147ddafb51cf84ed77027fb30d0`, cloud schema
`001`–`013`, на проверенный новый SHA с одной additive migration
`014_cloud_fulfillment_transport.sql`. Это следующий отдельный профиль;
исторический `release-market.py apply` его явно отклоняет. Подготовка сценария
и локальная репетиция **не означают, что VPS обновлён**.

Этот переход фактически завершён выпуском `93b14e7`:
[протокол VPS](deployments/2026-09-08-transport-foundations.md).
Текущий сервер уже не соответствует исходному baseline `7cd`/013. Команды
ниже документируют выполненный переход; для следующей версии нужен отдельный
проверенный профиль от нового baseline. Повторять этот профиль на текущем VPS
или обходить его guards нельзя.

Новый `release.env` сохраняет прочие прежние настройки, включает существующие
`TEST_ORDER_FLOW_ENABLED=true`, `CATALOG_ADMIN_ENABLED=true` и явно задаёт
`CUSTOMER_AUTH_ENABLED`, `EDGE_FULFILLMENT_ENABLED`,
`CLOUD_FULFILLMENT_TRANSPORT_ENABLED`, `EDGE_FULFILLMENT_TRANSPORT_ENABLED=false`.
Секретный общий environment не переписывается. Новые cloud-таблицы остаются
пустыми; edge migrations этим VPS-выпуском не выполняются. Выдача credential,
публикация каталога, заказы, реальные SMS/платежи/чеки и включение транспорта
не входят в этот сценарий.

## Точные предусловия

Чистый checkout нового полного SHA и такой же SHA опубликованной ветки
канонического GitHub; все прежние 13 migrations побайтно совпадают с `7cd`.
В новом cloud migration directory ровно `001`–`014`, а `014` добавляет ровно:

- `fulfillment_transport_bindings`;
- `cloud_fulfillment_inbox`;
- `cloud_fulfillment_versions`;
- `cloud_fulfillment_projection`;
- `cloud_fulfillment_observed_tasks`;
- `cloud_fulfillment_task_versions`.

Новых sequences нет. Изменение состава DDL, появление `015` или другой live
baseline требует следующего проверенного профиля, а не обхода guard.

Foundation CI должен закончиться успешно именно для этого SHA и содержать
ровно шесть jobs без skipped/duplicate/лишних записей:

1. Build, contracts and PostgreSQL integration.
2. iPad kiosk state, bundles and browser recovery.
3. Private staging image and restricted database role.
4. Local kitchen UI and recovery.
5. Cloud-edge fulfillment transport and recovery.
6. Design screens and interaction smoke.

`--ci-run` читает canonical GitHub API через штатную авторизацию `gh`.
Альтернативный `--ci-proof` — предоставленный оператором снимок `{run,jobs}`,
а не криптографическая подпись GitHub; его происхождение проверяет оператор.

Проверяются оба действующих `current`, реальный manifest gateway, OCI revision
и **image ID** старого работающего API и rollback tag. `prepare` создаёт новые
immutable API/web artifacts; image ID, исходные и новые env/compose/config,
manifest и каждый web-файл фиксируются хешами и снова сверяются перед apply.
Старые каталоги, Docker tags и live pointers не перезаписываются подготовкой.

Прежний cron обязан оставаться ровно `*/15` с runner и аргументом SHA `7cd`,
в существующем `PICKCHICK IDENTITY CLEANUP` block. Проверяются хеш всей crontab
и совпадение runner с `git show 7cd:.../identity-cleanup-cron.sh`. Сценарий не
редактирует crontab, не заменяет pin и не устанавливает таймер. Другие владельцы
с правами прямой записи БД и ручного deploy должны соблюдать окно обслуживания;
такие сессии не завершаются принудительно. При их обнаружении или изменении
данных выпуск останавливается без восстановления дампа поверх live-БД.

## Команды владельца

```sh
python3 infra/staging/release-transport.py prepare FULL_COMMIT_SHA \
  --branch codex/fulfillment-network --ci-run SUCCESSFUL_CI_RUN_ID

python3 infra/staging/release-transport.py apply FULL_COMMIT_SHA \
  --branch codex/fulfillment-network
```

Заглушки заменяются фактическими значениями. SSH использует прежний
`pickchick-ops`, проверенный `known_hosts` и ключ
`~/.ssh/pickchick_staging_ed25519`. Защищённый age identity по умолчанию
`.local/vps/backup-identity.agekey`; файл без symlink, права `0600`.
Он передаётся `age` через stdin, не аргументы, и не копируется на сервер.
Все private evidence находятся в `.local/transport-release/FULL_SHA/`, каталог
`0700`, JSON/логи `0600`. Не публиковать логи, env, backup или реальные CMS данные.

## Окно применения

Общий exclusive deployment lock остаётся
`/opt/pickchick-staging/.market-release.lock`. UUID владельца, SHA и action
записываются в private evidence. Другой запуск не может присвоить lock;
автоматического resume/steal/очистки по возрасту нет.

1. Создаются отдельные owner/config/compose artifacts в private maintenance
   directory (`0700`). Только статический `maintenance.json` без секретов
   получает `0644`: root внутри Caddy не имеет `DAC_OVERRIDE` и не может читать
   файл `0600` владельца SSH UID 1000. `owner.json` и `compose.json` остаются
   `0600`; permissions секретов не меняются. Предварительный `caddy validate`
   использует те же `cap_drop ALL`, `NET_BIND_SERVICE`, `read_only` и
   `no-new-privileges`, поэтому ошибка чтения выявляется до изменения gateway.
   Хеши проверяются до запуска. **Только наш** gateway временно
   запускается с Caddy JSON: все публичные пути и методы получают `503`,
   `Retry-After: 60`, `Cache-Control: no-store`. Нет header bypass, прокси к API
   или публичного исключения для health. Container health доступен только на
   его `127.0.0.1:8099`; Caddy admin API отключён. Основной Caddyfile не меняется.
2. Перед закрытием gateway detached owned Python process берёт тот же kernel
   `flock`, что и существующий cron: `maintenance/identity-cleanup.lock`.
   Активный cleanup не прерывается: если он уже держит lock, выпуск останавливается
   до изменения API/gateway. Следующие cron ticks пропускают работу штатным
   `flock -n`, а не запускают конкурирующую очистку.
3. После подтверждённого `503` выполняется `stop --timeout 30 api`; остановка
   проверяется. Перед снимком не должно оставаться runtime DB sessions или
   чужих открытых транзакций. Только после drain создаётся baseline. Поэтому
   успешно сохранённый непосредственно перед maintenance CMS draft включён
   в проверяемые данные.
4. Свежий `pg_dump --no-owner --no-acl` шифруется `age`, проверяется SHA-256,
   восстанавливается в отдельную случайно названную БД. Сравниваются все прежние
   строки — включая CMS draft/publication/receipts, TEST-заказы, identity — и
   все параметры/значения sequences. Сравнение hashes обнаруживает изменение
   строки даже при прежнем количестве. Удаляется только временная restore-БД.
5. Новый provision запускается дважды. Старые ledger entries и все данные
   должны совпасть; разрешена лишь запись `014`, ровно шесть пустых таблиц,
   ни одной новой sequence. **Весь** прежний table/column/sequence ACL runtime
   обязан остаться тем же; disabled transport не получает дополнительных прав.
6. Новый API запускается за закрытым gateway. Проверки идут по существующему
   SSH loopback `http://127.0.0.1:13100`, не через публичный bypass. Readiness,
   старые capabilities и оба TEST-каталога совпадают; customer auth false,
   CMS требует credential, транспортные pull/ack/events возвращают `404`.
7. Старый **точный image ID `7cd`** временно запускается с его прежним
   compose/env на schema `014`, всё ещё за `503`. Проверяются readiness,
   capabilities/catalog/CMS и сохранность данных. Старые migrate/provision не
   выполняются. Затем возвращается новый image ID и повторяются private probes.
8. Проверяются соседние контейнеры и хеш iDrink Caddyfile. CAS переключает
   только два наших pointers с ожидаемых прежних targets. Последнее сравнение
   всех данных/ACL/пустых новых таблиц выполняется **до** открытия gateway.
9. Новый штатный gateway открывает доступ. После этого проверяются только
   доступность, public route boundaries, manifest/config/CMS asset — не
   равенство live-данных старому snapshot. Управляющий и TEST-клиенты уже могут
   законно писать. Только затем точный владелец освобождает cleanup flock.

Автоматическая работа проверяет предел окна 15 минут между операциями; это не
TTL locks. При превышении или ошибке закрытое состояние сохраняется для
разбора. Обслуживание имеет ограничения по длительности каждой команды, но
потеря клиента не доказывает завершение действий Docker daemon.

## Определённая ошибка и неизвестный исход

До начала reopening определённая ошибка после доказанного baseline запускает
проверяемый rollback **за maintenance**: сначала проверка данных без стирания,
точное восстановление ACL одной транзакцией, старый image/compose/env без
migrate/provision, возврат только собственных pointers, повторная проверка всех
данных. Additive `014` сохраняется. Лишь после проверки открывается прежний
штатный gateway и освобождается cleanup flock. Deployment lock после ошибочного
apply всё равно остаётся для проверки владельцем.

Ошибка до доказанного baseline не открывает частично закрытый gateway
автоматически. При потере SSH/timeout (`124/125/137/255`), прерывании процесса
или неизвестном результате restore/provision/switch не запускается конкурирующий
rollback: phase journal, deployment lock, cleanup holder и maintenance остаются
для инспекции. Не удаляется temporary restore-БД, если её операция могла ещё
продолжаться. Detached holder не имеет автоматического TTL; проверяются UUID,
PID/starttime, inode и фактический kernel flock.

Если неопределённость возникла **во время самого reopening**, состояние ingress
честно отмечается как `unknown_or_opening`: считать его закрытым уже нельзя.
Новая SSH-команда для принудительного close могла бы конкурировать с ещё
исполняющимся Docker up. Аналогично после ошибки public probe уже допустимы
новые CMS записи: автоматический rollback/возврат старого snapshot не выполняется.
Оператор сопоставляет owner UUID, процессы, container config/image, оба pointers,
ledger/ACL и приватный журнал; только после этого определяет продолжение.
Дамп поверх live-БД не восстанавливается ни в одной ветке.

## Локальные проверки

```sh
python3 -m unittest tests/operations/test_market_release.py \
  tests/operations/test_transport_release.py
python3 -m py_compile infra/staging/release-market.py \
  infra/staging/release-transport.py infra/staging/release-maintenance-lock.py
```

Отдельная opt-in репетиция `tests/operations/rehearse_transport_release.py`
принимает только локальный Unix Docker context, создаёт свои случайно названные
контейнеры/network и синтетические секреты. Она не использует существующие БД,
дампы или VPS и удаляет только собственные контейнеры/network в `finally`.
Передать old image, собранный из `git archive 7cd...`, и new image из чистого
архива полного candidate SHA, обоим указать `--build-arg RELEASE_SHA=...`;
скрипт проверяет OCI revisions. Pinned `infra/staging/Dockerfile` используется
без изменений. Не подставлять прежний image `5d3` вместо `7cd`.

Для локального tool image (не production runtime) используется:

```dockerfile
FROM postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7
RUN apk add --no-cache age python3 util-linux
```

Фактический tool image ID и version `age` фиксируются в evidence: apk repository
не является immutable lockfile этого вспомогательного инструмента.

```sh
python3 tests/operations/rehearse_transport_release.py \
  --old-image LOCAL_7CD_IMAGE --new-image LOCAL_CANDIDATE_IMAGE \
  --new-sha FULL_CANDIDATE_SHA --tool-image LOCAL_TOOL_IMAGE \
  --output .local/transport-release-rehearsal/UNIQUE_RUN
```

Репетиция включает настоящий scoped CMS HTTP write, существующий TEST-заказ,
закрытие реальным Caddy `503`, encrypted pg_dump restore, настоящий Linux flock,
двойной provision `014`, отсутствие расширения прав, new→old7cd→new API на новой
схеме, rollback лишнего column grant и сохранённую CMS правку после открытия.
Её обычный gateway — локальная proxy fixture; боевые public allowlists,
SSH и pointer switching проверяются отдельно. Это не приёмка VPS, нагрузки,
банковского протокола или физической кухни. Фактический результат сохраняется
в private `result.json`; в Git допустим только проверенный обезличенный итог.

## Выполненная репетиция 8 сентября 2026

[Обезличенный результат](../../tests/operations/evidence/transport-release-local-2026-09-08.json)
фиксирует приложение `3b3793dcd155586becc3a727daa260f254608574`, прежний API
`7cd53b6`, точные OCI image ID и хеши файлов сценария. На Docker 29.6.1
Linux/arm64, PostgreSQL 18.3 и age 1.2.1 все перечисленные шаги прошли:
69 прежних таблиц, 4 версии synthetic CMS draft, публикация, TEST-заказ
и отдельный просроченный синтетический marker для реальной cleanup-команды.
24 offline checks (10 исторических и 14 follow-on) также прошли.
Собственные контейнеры/network удалены, cleanup проверен. VPS не вызывался.

Linux flock репетиция использует native filesystem контейнера. Docker Desktop
macOS bind mount в предварительном прогоне не обеспечил конфликт kernel flock:
координатор правильно остановился, не объявив блокировку успешной. Такой
filesystem для production-координации не принимается; проверка фактического
конфликта lock остаётся обязательной частью `status`.

## Регрессия Linux UID и прав Caddy

Предварительный apply `dccc516` выявил отдельный дефект: несекретный Caddy JSON
был создан с `0600` владельца SSH, а container root без `DAC_OVERRIDE` не мог его
прочитать. До снимка/backup/migration сценарий остановился; владелец восстановил
прежний gateway и освободил проверенные owned locks. Ранний Docker data-flow
rehearsal не проверял это сочетание UID и capabilities и не является таким
доказательством.

[Отдельный Linux DAC протокол](../../tests/operations/evidence/maintenance-permissions-2026-09-08.json)
воспроизводит прежний writer непосредственно из `git dccc516`, затем проверяет
исправленный writer. Оба запускают запись из UID/GID 1000 в native Docker volume;
parent directory `0700`, owner/compose `0600`. Применяется actual gateway compose
с `cap_drop ALL`, единственным `NET_BIND_SERVICE`, `read_only` и
`no-new-privileges`; подменяются только изолированные имена/network/mount и
отключается restart loop для наблюдения прежнего отказа. Публичных портов нет.
Прежний `0600` получает `permission denied`, новый `0644` проходит hardened
validate и запускает Caddy с эффективным root UID, но только capability `0x400`:
public route `503`, private `8099` health успешен. Секретные права не ослаблены.

```sh
python3 tests/operations/rehearse_maintenance_permissions.py   --tool-image LOCAL_TOOL_IMAGE   --output .local/maintenance-permissions/UNIQUE_RUN
```

Tool image содержит Python и coreutils; применяется локальный образ из предыдущей
репетиции, без установки пакетов или внешних вызовов. Тест не вызывает VPS,
не перезаписывает старые artifacts и удаляет только собственные контейнеры,
network и volume. После этого изменения проходят **26** offline checks:
10 исторических и 16 follow-on. Предыдущий протокол 24 checks сохраняется как
историческое доказательство своего исходного SHA.
