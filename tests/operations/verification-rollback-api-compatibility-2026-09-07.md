# Старый API на новой схеме PostgreSQL — 2026-09-07

**PASS:** реально перезапущен API
`5d3eead08c392bdbb60eae64a0bee4e883bb0af3` на PostgreSQL со схемой cloud
001–013 и восстановленными runtime-правами старой версии.
[Машиночитаемое доказательство](evidence/rollback-api-compatibility-2026-09-07.json)
содержит SHA образа, исходников, ACL и каталогов без секретов.

## Выполненная последовательность

1. Из `git archive` старого SHA собран настоящий образ штатным старым Dockerfile.
   OCI revision label проверен; image ID:
   `sha256:c6ae814696ed7737b41fa1b476f73cca249d41c0d3bc6b753816a309f94e3ad6`.
   Новые исходники API или исправление DB helper в старый образ не подмешивались.
2. Создан отдельный Compose project `pickchick-rollback-2c3dfbf020`, новые сети,
   том PostgreSQL 18.3, Redis и случайные локальные секреты.
3. Старый provision запущен **только на пустой БД**, применил 001–006.
   Сохранены фактические 48 ACL-записей `pickchick_app`, включая table,
   sequence и column privileges. TEST=true, real auth=false.
4. Старый API запущен; readiness, capabilities и каталоги mockup-v0.2/v0.3
   проверены как baseline. Роль API — `pickchick_app`, пользователь контейнера
   `node`, rootfs read-only; порт опубликован только на loopback.
5. Новый migrator `ee26a3c7fd307a69fe55d811121798d483ad5b11` применил 007–013
   с CATALOG_ADMIN=true, CUSTOMER_AUTH=false, TEST=true. Миграции этого образа
   побайтно совпадают с проверенным root `e45a92a03a3cf338b8c678d26f27f54a18150c58`.
   Runtime ACL увеличился до 64 записей.
6. Штатной `acl_restore_sql(before, current)` из
   `infra/staging/release-market.py` сформирован и выполнен транзакционный SQL
   восстановления. Повторный ACL snapshot точно равен исходным 48 записям.
   Старый provision поверх схемы 013 **не запускался**; схема не откатывалась.
7. Именно старый API перезапущен. Compose дождался healthy; проверена идентичность
   image ID/OCI label. `/health/ready`: ready=true, degraded=false,
   database/schema/redis=up. `/v1/capabilities` полностью равен baseline:
   только TEST включён, реальные ordering/auth/checkout/payments/fiscal/loyalty выключены.
8. Оба TEST-каталога успешно прочитаны и совпали с baseline. SHA-256 ниже
   рассчитан от `JSON.stringify` разобранного JSON ответа, не от сетевого framing.

| Каталог     | Размер JSON, bytes | SHA-256                                                            |
| ----------- | -----------------: | ------------------------------------------------------------------ |
| mockup-v0.2 |               3147 | `4eccaf8d5da1e4a4eb479d119eca7cf0f1c75648e7d8d1def19b3076c3e5e3b4` |
| mockup-v0.3 |              52955 | `6a19a70ae782948d69a74c6a082f8eca279f59ce5e3fe761a49c6578505a49d8` |

После проверки `test_actors` и `test_orders` содержали 0 записей. Собственные
контейнеры, сети и том удалены; исходные три local-контейнера не изменялись.
Собранный старый образ сохранён локально. Приватные env, ACL snapshots и журналы
находятся только в игнорируемой `.local/rollback` изолированной рабочей копии.

## Границы и повторение

Это локальная проверка совместимости старого API/пулов/чтений с новой схемой
и восстановленными разрешениями. Она не выполняет VPS rollout, TLS/gateway
переключение, checkout, выдачу сотрудников, SMS, платежи или восстановление
backup поверх действующей БД.

Для повторения использовать изоляцию из
[протокола staging](verification-staging-catalog-2026-09-07.md): уникальный
Compose project, новые env/том, случайный loopback-порт, штатные образы.
Сначала old image/provision 001–006 и ACL/read baseline; затем только новый
provision 001–013; `acl_restore_sql` над двумя metadata snapshots; restart old
API и те же read probes. Новые доменные функции не включать. Удалять только
собственное временное окружение.
