# CR cloud-7 → integration: тесты восстановления кассы на настоящей 026, runbook без ручного сдвига, тип цены канала

Полоса: cloud (ветка `codex/cutover-cloud`). Адресат: integration (`codex/cutover-1119`), копия - pos.
Основание: ревью интеграции 06.11, замечания R2 (два красных теста `test:pos-order-sync` после слияния 026 с fence CR pos-6) и R13 (CR pos-2 §2.2).

## 1. Что сделано

- `packages/pos-order-sync/tests/sales-worker-integration.test.mjs`:
  - заглушка `applyPosSalesFence` удалена. Тест «restored edge database with the posSales fence of 026…» больше не ставит fence сам, а проверяет установленную функцию: `pg_get_functiondef` содержит `pos_sale_outbox`, `search_path` закреплён, у PUBLIC нет `EXECUTE`; дальше - как раньше;
  - тест «… a 026 without CR cloud-5 item 1 (fence of 023) …» в начале ставит функцию 023 как она написана (`CREATE OR REPLACE` тела 023 и его DO-блок, `installFence023`) - модель «026 без п. 1 CR cloud-5»; ожидания прежние (`PARKED CONFLICT`);
  - тест «interim runbook step until CR cloud-5 …» заменён тестом проверки из runbook: блок SQL раздела «Восстановление базы кассы» читается дословно, в нём только `SELECT … AS covered` (нет `setval` и записи); на настоящей 026 - `true`, после `installFence023` - `false`.
- `docs/operations/backoffice-cutover.md`, «Восстановление базы кассы»: fence 026 (SHA-256 `921c5263…d057c`, CR pos-6) сдвигает и `pos_sale_outbox`; ручной `setval` удалён; осталась одна проверка `covered`: `true` - продолжать, `false` - не та 026, кассу не открывать, остановиться и звать инженера.
- `packages/menu-sync/src/channel-prices.ts`: `aggregator_prices_minor?: { yandex_eda?: string | undefined; glovo?: string | undefined } | undefined` - `MenuItem` подходит под `exactOptionalPropertyTypes` без приведения (проверено отдельным `tsc --strict --exactOptionalPropertyTypes`; со старым типом - TS2379). Поведение то же. Приведение в `packages/local-orders/src/pricing.ts:31` (pos) теперь лишнее, но безвредно; убрать его может полоса pos.

## 2. Ветка cloud отдельно и после слияния

В ветке cloud лежит копия 026 из коммита схемы pos `f8355655` (SHA `9e3ab95a…`, до CR pos-6) - без fence для `pos_sale_outbox`. Поэтому в ветке cloud отдельно два теста раздела 1 (проверка из runbook и тест с fence 026) падают на первой проверке `covered` (06.11: 14 тестов файла, 12 прошли, 2 упали ровно там). Файл 026 принадлежит pos, полоса cloud его не обновляет. После слияния в `codex/cutover-1119` (026 = `921c5263…`, pos) весь файл должен быть зелёным - integration запускает `pnpm test:pos-order-sync` после слияния.

## 3. Что нужно от integration

- Слить cloud после pos и kds; конфликтов в файлах раздела 1 не ожидается (integration их не правила).
- В `docs/operations/edge-restore.md` и мастер-runbook §9 ручного сдвига `posSales` нет и не должно появиться; ссылка на проверку `covered` - раздел «Восстановление базы кассы» этого runbook.
