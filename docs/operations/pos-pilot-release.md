# VPS: подготовка пилота кассы и бэк-офиса

15 сентября 2026 read-only SSH подтвердил фактическую исходную конфигурацию:
API `93b14e7f8491645dcf8ed2aabdd501afc6481a90`, публичный web
`bc1d1d55594fff40f64cdd0c6065631133be5370`, cloud migrations001-014.
API контейнера3100 опубликован только на `127.0.0.1:13100`. Старый cleanup cron
по-прежнему закреплён за `7cd53b6300ad9147ddafb51cf84ed77027fb30d0`.
Исторический `release-transport.py apply` рассчитан на другой baseline и для
этого выпуска неприменим.

`infra/staging/release-pos-pilot.py inspect --output <fresh-private-json>` только
читает API/web pointers, manifest, ledger/checksums, loopback port и атрибуты
роли. SSH использует прежний доверенный host key с StrictHostKeyChecking=yes.
`plan --observed <json> --sha <40hex> --output <fresh-private-json>` сохраняет
локальный план. Выходной файл600; повторная запись запрещена. Команды apply нет:
план явно содержит deployable=false и не является подтверждением миграции или
восстановления резервной копии. Нужен отдельно завершённый maintenance apply,
репетиция отказов/неизвестного ответа и CI точного публикуемого SHA.

Профиль включает полный BO017 и приватный POS receiver018 на существующей роли
API. Compose передаёт BACKOFFICE_ENABLED и CLOUD_POS_ORDER_SYNC_ENABLED в API и
provision; по умолчанию оба false. Reviewed grants receiver добавляются перед BO
read permissions. Создание устройства, выдача его credential, назначение BO role
и изменение POS producer binding остаются только operator operations.
Windows transport использует отдельную ограниченную PostgreSQL LOGIN.

Customer auth/checkout/банк/фискальный адаптер, loyalty settlement и прежний
cloud-owned fulfillment transport остаются выключены. TEST каталог и редактор
сохраняются. BO может хранить свои операционные документы и запросы отмены/возврата;
это не подтверждение банковского возврата или чека. Наблюдаемый unpaid POS не
попадает в денежные/фискальные эффекты.

## Проверка сохранности перед открытием доступа

Сначала закрыть только наш public gateway, занять существующий cleanup flock,
остановить и дождаться завершения API; исключить активный tunnel writer. Не
завершать чужие транзакции принудительно. Снять полный baseline rows/columns,
ledger включая applied_at, sequences, ACL и соседние service fingerprints.
Сделать новый encrypted pg_dump и восстановить в уникальную временную базу,
сравнить каждый hash/sequence и удалить только эту временную базу. При неизвестном
результате сохранять lock/maintenance и проверять процесс, не запускать конкурирующий rollback.

015-018 добавляют ровно18 пустых таблиц и не создают/используют новые sequences.
У старых devices/device_credentials добавляется только pos_sync_lock_anchor=false.
Сравнение row_to_json целиком даст ложное отличие после ADD COLUMN: проверять
прежние колонки точно и отдельно инертное значение новой колонки. Нельзя просто
исключать эти таблицы. Старый commercial projection появляется только016, его
execution_mode из018 остаётся null для исторического случая.

Повторить provision, проверить identical итоговые ACL. Проверить API93b на
сохранённой018 схеме и прежний webbc1d как rollback baseline до открытия. После
открытия новые законные manager writes допустимы; утверждать нулевой DML после
открытия нельзя. Ни rollback кода, ни смена ACL не должны восстанавливать dump
поверх действующей базы.

Локальная репетиция `tests/operations/rehearse_pos_pilot_release.py` использует
отдельные случайные Docker containers/network, реальные PG/age backup/restore,
исходный API93b, новый API и отдельные synthetic данные. Изображения задаются
явно, проверяются OCI revisions. Она не использует SSH или существующие базы.
Нормальный gateway репетиции - локальный proxy fixture; public routing, SSH,
release pointer CAS и фактический VPS backup требуют отдельных доказательств.

## Подтверждённая локальная репетиция

15 сентября прошли49 Python guard/orchestration tests, включая5 новых для этого
profile. Docker-репетиция PostgreSQL18.3/age1.2.1 сохранила75 прежних таблиц,
четыре revisions каталога и TEST заказ. Проверены nonempty device/credential,
точный набор/определения старых колонок,18 пустых новых таблиц, неизменные
sequences/ledger applied_at, восстановление зашифрованной копии, повторный
provision, disable/re-enable receiver, старый API93b на018 и cleanup7cd.
После открытия scoped manager read/write работает; чужой branch и запрос без
token отвергаются. Собственные временные containers/network удалены.
[Машинный протокол](../../tests/operations/evidence/pos-pilot-release-local-2026-09-15.json)
содержит exact image revisions/IDs и hash проверочного скрипта. Candidate API
собран из git archive98a56b7114262d020bdddf28398c41ee18bcff73. Public webbc1d
в этой Docker-репетиции не запускается: сравнение/rollback его реальных assets
и public gateway routing остаётся acceptance будущего maintenance apply.
Эта проверка не меняла VPS и не является доказательством physical Windows→VPS sync.

## Scope физической точки и порядок назначения

На VPS существует только `PickChick synthetic test organization`
`10000000-0000-4000-8000-000000000001` и `Synthetic legal entity`
`10000000-0000-4000-8000-000000000002`. Пилот физической кассы использует отдельную
branch `7a6f6d98-395d-4462-b5e4-b0364a4a8ec1` в этом явно синтетическом staging
scope. В name/private manifest необходимо обозначить «ТЦ Abay Plaza - unpaid
pilot (staging)». Старую TEST branch100…003 не переименовывать/перепривязывать.
Новые реальные юридические данные/БИН не придумывать. Это не production onboarding.

1. Owner создаёт именно физическую branch UUID с ordering_enabled=false и
   согласованный физический edge device UUID. Если любой UUID/code существует
   с другой привязкой - остановиться; не remap local durable IDs.
2. Owner выдаёт отдельный cloud device credential через существующий
   `scripts/device-setup.mjs <device-uuid>` в защищённой operator copy. Token
   сохраняется только в protected identity JSON, не в чате/argv/log/repo.
3. На Windows owner запускает `scripts/pos-order-sync-setup.mjs edge <input.json>`
   с `{organizationId,branchId,deviceId}`. CLI возвращает прежний
   local_order_streams producerId; не назначать вместо него новый.
4. Этот result передать `scripts/pos-order-sync-setup.mjs cloud <result.json>`.
   Касса commercial и kitchen observation используют один POS producer и разные
   inbox sequence пространства. fulfillment cloud producer - отдельный UUID.
5. Для нового branch scope требуется operator grant прежнему manager actor:
   сначала catalog_manager_branches, затем `scripts/backoffice-setup.mjs --actor
   <uuid> --branch <physical-uuid> --role manager|analyst`. Не выдавать общий
   пароль и не считать существующий TEST grant доступом к новой точке.
6. После независимого согласования включить приём unpaid service на Windows,
   проверить один реальный заказ в кассе/кухне/BO и сохранение not_started/
   not_requested платежа/чека. Ни migration, ни этот план ordering не включают.

## Закрытый сетевой путь

Windows создаёт новый Ed25519 SSH key локально; только public key передаётся VPS.
Dedicated SSH user разрешает лишь local forwarding в127.0.0.1:13100:
AllowTcpForwarding local, PermitOpen127.0.0.1:13100, PermitTTY no,
X11Forwarding no, AllowAgentForwarding no, PasswordAuthentication no,
ForceCommand /bin/false. Ключ нельзя использовать для shell/scp или других портов.
Служба Windows запускает ssh -N с проверенным known_hosts, ExitOnForwardFailure,
ServerAliveInterval и отдельной LocalService-readable protected key directory.
Device bearer остаётся обязательным поверх туннеля. Public Caddy internal routes
не расширять; `/internal/v1/edge/pos-orders/events` снаружи обязан остаться404.
Проверенный Mac ED25519 fingerprint:
`SHA256:Bt3HkaktjLmWe4tB1pOK9b8gOnHuxp+tvp1hhEDtxp8`.
