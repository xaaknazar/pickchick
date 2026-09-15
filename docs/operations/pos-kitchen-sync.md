# Наблюдение кассы и кухни в облаке

Локальный POS и кухня остаются владельцами своих операций. Облако и бэк-офис
получают наблюдаемую копию состояний. Этот обмен не подтверждает оплату,
фискализацию, списание ингредиентов или право выдать заказ.

Только явно включённый локальный режим `unpaid_service` из edge012 попадает в
новый поток. Обычный commercial event сохраняет `fulfillment_state=blocked` и
получает необязательное `execution_mode=unpaid_service`. У старых событий поле
остаётся отсутствующим; хеши, квитанции, snapshot и суммы не переписываются.
Actual kitchen state идёт отдельным `order_fulfillment` из существующего
`fulfillment_outbox` с `commercialOwner=edge_pos`. События cloud-owned заказов
остаются в прежнем fulfillment transport и этим worker не выбираются.

## Миграции и полномочия

Edge013 добавляет `pos_kitchen_sync_state`, отдельный lease/checkpoint. Cloud018
добавляет `pos_kitchen_sync_inbox` и `pos_kitchen_sync_projection`, а также nullable
execution mode в старой commercial projection. Миграции не включают feature flags,
не назначают устройства и не создают кухонные факты. Existing POS bindings получают
только пустой checkpoint; новые - при штатном `provisionEdgePosSync`.

Нужна существующая явно назначенная POS sync binding с одинаковыми branch/device/
producer UUID на обеих сторонах и действующий приватный device credential. Перед
включением cloud должен получить правильную точку/устройство; локальные UUID
нельзя переназначать для удобства облачной регистрации. Native staff login и
cloud device credential - разные полномочия.

`infra/windows/pos-sync-worker-grants.mjs` задаёт отдельные additive grants:

- `posSyncWorkerGrants(role, schema)` - чтение binding/source и изменение delivery
  checkpoints/attempts/ACK. Не даёт менять кухонные payload, меню, роли или приём.
- `posSyncReceiverGrants(role, schema)` - device authentication через безопасные
  lock columns и запись только sync inbox/projection. Не выдаёт device credentials,
  не меняет device status, bindings или финансовые таблицы.

Применять их к отдельным заранее созданным непривилегированным ролям. Edge HTTP
LocalService сохраняет свой прежний allowlist без права ACK outbox. Owner CLI
сохраняет право на provisioning и явный повтор quarantined события.
`backofficeGrants` дополнен только SELECT двух новых наблюдательных таблиц.

После обеих миграций и применения прав existing `scripts/pos-order-sync-worker.mjs`
доставляет commercial и kitchen streams поочерёдно. `EDGE_POS_ORDER_SYNC_ENABLED`
и `CLOUD_POS_ORDER_SYNC_ENABLED` остаются явными выключателями. Readiness проверяет
018 при включённом cloud POS sync/BO и013 при включённом edge POS sync. Доставка
должна идти через выбранный оператором частный HTTPS ingress либо защищённый
локальный tunnel endpoint. Общий public gateway этот internal route не публикует.
Приватные URLs/keys/credentials не включаются в репозиторий.

## Доставка, повтор и порядок

Оба вида событий используют существующий authenticated endpoint
`POST /internal/v1/edge/pos-orders/events`; сервер различает `aggregate_type`.
Kitchen использует POS producer UUID и собственный исходный outbox sequence;
отдельный inbox исключает коллизию с commercial sequence. Глобальные пропуски
sequence допустимы, каждая версия одного заказа должна идти строго `version+1`.

Облако до kitchen acceptance проверяет наблюдаемый commercial заказ в режиме
unpaid, точку/устройство/producer, quote ID и точный hash server Quote snapshot.
`ownerHash` также сверяется с organisation/device/branch/order/quote binding.
Повтор с прежним ID/sequence/version принимается только при неизменном полном
хеше и после повторной проверки действующего device auth. Commercial cancellation
может прийти прежде своей кухонной истории: accepted и последующий cancelled
сохраняются как настоящие исторические факты. Оплата остаётся `not_started`.

Pending envelope/hash сохраняются до сетевого запроса и не меняются при retry.
Потерянный ACK, restart, HTTP409/5xx, неизвестный ответ или неверная квитанция
не отмечают source доставленным. Действует lease30секунд и backoff до60секунд.
После подтверждённого HTTP400 событие помещается в quarantine без ACK/пропуска.
После исправления принимающей стороны оператор повторяет **тот же** envelope:

```powershell
& '<installed-node.exe>' --env-file=private\edge-owner.env scripts\pos-kitchen-sync-retry.mjs <event-uuid>
```

Команда требует владельца локальной таблицы и совпадающий pending event. Она
снимает quarantine, не меняет payload/hash и не создаёт ACK. Credential в команду
не передаётся. При сетевой неизвестности ручное снятие quarantine не требуется.

## Бэк-офис и проверка

Список POS/кухни показывает actual `accepted`, `in_production`, `ready`,
`handed_over`, `cancelled` из новой projection, время последнего наблюдения и
origin кассы. Детали заказа включают commercial/kitchen timeline и статус кухни.
Приёмы денег, возвраты и фискальные документы для такого POS-заказа остаются
пустыми; новый поток не добавляет их и не увеличивает финансовые показатели.

Проверки выполняются на отдельных тестовых PostgreSQL schemas: настоящий
POS→kitchen→HTTP cloud→BO, точные hashes/roles, ACK loss/restart/concurrent lease,
изменённые повторы, версии, cancellation history, quarantine/retry и отдельные
ограниченные PostgreSQL LOGIN. Миграционный тест сохраняет старый pending
commercial envelope/receipt/snapshot/суммы и оставляет kitchen projection пустой.
Это подготовленный код. Сетевое развёртывание между Windows и VPS и проверка
записи реального пилотного заказа ещё не считаются выполненными.
