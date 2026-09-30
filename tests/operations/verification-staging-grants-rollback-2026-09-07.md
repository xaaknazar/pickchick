# Откат выдачи runtime-прав при ошибке — 2026-09-07

**PASS** на замороженном исходном коде
`ee26a3c7fd307a69fe55d811121798d483ad5b11`. Это узкая дополнительная проверка
транзакции выдачи прав в `infra/staging/provision.mjs`, после полной
[репетиции 733edaf](verification-staging-catalog-2026-09-07.md).
Полный HTTP/gateway workflow для нового SHA здесь повторно не запускался.

## Фактическое окружение и результаты

- Новый изолированный Compose project `pickchick-grants-f82fe31c1d`, новый том,
  PostgreSQL 18.3 и Redis из закреплённых staging-образов. Секреты случайные,
  локальные; нет данных, токенов или сетей действующего staging/VPS.
- Штатный Dockerfile реально собран с `RELEASE_SHA=ee26a3c…`: **PASS**.
  Image ID `sha256:f18ebfc91c6793f503c0f09803b2ddd0355c6eb22281d5a3b60e04f4452fdb64`;
  OCI revision label равен полному SHA выше.
- Первое provision с TEST=true применило 001–013. Фаза `grants-on`
  подтвердила все девять ожидаемых column UPDATE-grants.
- Целевая конфигурация повторного provision: TEST=false, CATALOG_ADMIN=true,
  CUSTOMER_AUTH=false. У runtime сначала были права прежнего TEST-режима.
- Тест временно переименовал `catalog_managers.lock_anchor` в собственной БД,
  вызвав настоящую ошибку optional catalog GRANT/REVOKE после начала пересчёта
  TEST-прав. Запущен **штатный provision отдельным Node-процессом из образа**.
- Provision завершился exit 1 с `staging_provision_failed`. Полный snapshot
  TEST table/sequence ACL и column ACL совпал с исходным. Существующая
  `pickchick_app` connection по-прежнему прочитала `test_orders`. Значит
  частичный REVOKE не зафиксировался.
- Колонка восстановлена в `finally`. Повтор штатного provision: exit 0,
  `applied: []`. Теперь runtime SELECT `test_orders` возвращает 42501,
  sequence USAGE=false. Фаза `grants` дополнительно подтвердила снятие всех
  девяти column UPDATE-grants.
- ESLint, Prettier и staged diff checks: PASS. Runtime-файлы не менялись.

Фаза `grants-rollback` вернула:

```json
{
  "event": "staging_catalog_smoke",
  "phase": "grants-rollback",
  "checks": [
    "failed_optional_catalog_grant_rolls_back_all_test_acls",
    "restored_schema_retry_applies_test_disable"
  ],
  "status": "passed"
}
```

## Повтор проверки

Использовать изолированные env/Compose overrides и способ вызова фаз из
предыдущего протокола, но собрать образ из SHA `ee26a3c…`. Gateway, web bundle,
API server и seed организаций для этой узкой SQL-проверки не нужны. Тест по
прежнему требует четыре синтетических UUID и explicit isolated opt-in.

1. Поднять только собственные `cloud-db`, `redis-cache` с `--wait`.
2. Выполнить `staging run --rm --no-deps -T -e TEST_ORDER_FLOW_ENABLED=true provision`.
3. Запустить фазу `grants-on` с обычной конфигурацией TEST=false.
4. Запустить фазу `grants-rollback` с той же конфигурацией. Она сама вызывает
   provision, проверяет отказ/сохранность ACL, восстанавливает колонку и делает retry.
5. Запустить фазу `grants`, затем удалить только собственный project/volume.

Ни одна фаза не печатает пароли, токены или SQL error payload. Собственное
окружение после проверки удалено; три существовавших local-контейнера сохранили
IDs и healthy-состояние. Образ сохранён локально. Этот результат не означает
production-развёртывание или проверку реального SMS/checkout/фискализации.
