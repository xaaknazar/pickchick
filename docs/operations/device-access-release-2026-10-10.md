# Devices cloud: состояние выпуска после workforce (2026-10-10)

Задача `devices-release` (Claude по решению владельца 2026-10-10, продолжение
`devices-access`). Live-изменений Claude не выполнял: сервер и касса не менялись,
`--apply` не запускался. Все проверки сервера - read-only SSH/HTTP.

## Что изменилось за день

План был выпустить cloud050 -> 051 через `infra/staging/release-device-access.py`.
Пока готовился кандидат, задача `workforce` (другой Mac) выпустила свой профиль
`release-workforce.py` поверх того же `f277`/schema050: применены `051` (Devices
таблицы dormant, без runtime grants, флаг не задан) и `052_cloud_workforce.sql`.

Read-only снимок VPS после workforce:

| Пин                                | Значение                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| API SHA / pointer                  | `8468e3aed72c5355cf8b8d998df1de14ca55b03f`                                                         |
| API image                          | `sha256:d7fa5d28932feb63d03fc68d7e15555057aeb9c71ea35df758023da53e2f3a75`                          |
| public pointer                     | `bd60ab6b539d1b9a4432e271fd5d5a17bfe50cc2`                                                         |
| gateway sha256                     | `971bbd6ee3a951d6ab8a8b99e3f42eef013aa85c4640b9820fc93fde0637ac4a` (прежний, без Devices matchers) |
| schema                             | 052 (51 строка ledger)                                                                             |
| `BACKOFFICE_DEVICE_ACCESS_ENABLED` | не задан (выключен)                                                                                |
| `WORKFORCE_ENABLED`                | `"true"`                                                                                           |
| release lock                       | отсутствует                                                                                        |
| `/kitchen-live/health`             | `edgeConnected: false` (касса офлайн)                                                              |

Следствие: `release-device-access.py` (ожидает ровно schema050 и сам применяет 051)
больше неприменим. Повторно его не запускать. Подготовленный для него кандидат
`bf41bf28` (ветка `codex/devices-051-candidate`, Foundation CI 38057863347 зелёная)
остаётся историческим и для выпуска не используется.

## Что нужно для Devices в облаке теперь

Новый guarded профиль поверх `8468e3ae`/schema052/public `bd60ab6b`, без миграции:

1. Проверить точный ledger 052 и что 051 таблицы пусты, прав runtime на них нет.
2. В одной REPEATABLE READ транзакции выдать только `deviceRegistryGrants`
   (`infra/staging/device-registry-grants.mjs`), сравнив ACL delta, как
   `device-access-owner.mjs`, но без применения 051.
3. Добавить в compose `BACKOFFICE_DEVICE_ACCESS_ENABLED: "false"`, заменить два
   matcher-а `backoffice_get`/`backoffice_post` в gateway на версию с `/devices`.
   API-код и BO Devices уже в `8468e3ae`/`bd60ab6b` (потомки `3c399b48`); новый
   образ нужен только если профиль требует новый SHA.
4. Backup + изолированный restore до изменения ACL; rollback без восстановления БД.
5. `enable` - отдельно, только с приватным Windows proof
   `pickchick-device-access-prepared-v1` и свежим heartbeat edge.

Профиль, как и прежний, должен требовать `edgeConnected === true`: пока касса
офлайн, его preflight остановится на `Kitchen portal disconnected`. Guard не ослаблять.

## Guard-тесты с миграциями 052+

Ограничение набора миграций до `<= 051` во временном каталоге уже сделано задачей
`workforce` (`tests/integration/device-access-release.test.mjs`,
`tests/integration/unified-menu-continuation.test.mjs`) и включено в общий срез.

## Ждёт кассу

Свежий read-only baseline Windows; staging runtime/helper/KitchenLink; backup019 и
изолированный restore; Stage/Prepare020, backup020/restore, Switch/Verify, mailbox
worker, KitchenLink; затем cloud grants/gateway (новый профиль), `enable`,
Windows Activate, портал и приёмка. См. `docs/operations/device-access.md`.
