# CR pos-6 → lead/integration, cloud (копия kds): fence восстановления в 026 (CR cloud-5 п. 1), новый SHA-256 026

Полоса: pos (ветка `codex/cutover-pos`, шаг доработки по решению lead 06.11).
Адресаты: lead и integration (`codex/cutover-1119`), cloud (`codex/cutover-cloud`), копия kds.
Основание: CR cloud-5 п. 1 (`docs/collaboration/cutover-cr/cloud-5.md` на ветке cloud, одобрен
lead 06.11), контракт §3.2 п. 4 и п. 6, §5.6, §5.9; [CR pos-1 §1](pos-1.md),
[CR pos-5 §2](pos-5.md).
Коммиты: `0a77a7b8` (026), `8f5730f4` (тесты), этот CR - следующий коммит документации.
Сделано до заморозки DDL 10.11 18:00: на точке 026 ещё не применялась.

## 1. Что изменено в 026

- В конец `db/edge/migrations/026_edge_pos_sales.sql` добавлен раздел 10 - блок CR cloud-5 п. 1
  дословно: `CREATE OR REPLACE FUNCTION edge_restore_fence(p_force boolean DEFAULT false)`, тело
  023 байт-в-байт, кроме списка очередей
  `ARRAY['cashier_report_outbox', 'fulfillment_outbox', 'pos_sale_outbox']`, и повторённый
  DO-блок 023 с `ALTER FUNCTION ... SET search_path = pg_catalog, <схема>, pg_temp`
  (`CREATE OR REPLACE` сбрасывает `SET`).
- Права не меняются: `CREATE OR REPLACE` сохраняет владельца и ACL. У PUBLIC нет `EXECUTE`
  (023), `EXECUTE` рантайма edge (`edge-runtime-grants.mjs`, флаг `restoreFence`) и
  FulfillmentWorker (`fulfillment-worker-grants.mjs`, `restoreFence: true`) остаётся. Рантайму
  не нужен `UPDATE` на `pos_sale_outbox_sequence_seq`: номер сдвигает функция владельца
  (`SECURITY DEFINER`), у рантайма по-прежнему только `USAGE`.
- 026 функцию не вызывает: паспорт базы записан в 023, вызов вернул бы `current`.
- Остальное в 026 не изменилось: файл до раздела 10 совпадает с `b25674d5` байт-в-байт.
  Новых отношений и прав нет, `infra/windows/pos-sales-grants.mjs` не меняется.
- Совместимость (§3.2 п. 4): прежний рантайм на 026 вызывает ту же функцию при старте, для
  старых очередей поведение прежнее; новый рантайм на 025 вызывает функцию 023 (таблицы
  `pos_sale_outbox` на 025 нет). Облако допускает пропуски номеров, проверяет только
  уникальность пары устройство/номер.

## 2. integration: новый SHA-256 026 (заменяет CR pos-5 §2)

`db/edge/migrations/026_edge_pos_sales.sql`, SHA-256 на `0a77a7b8`:
`921c526320f6b878f592949d7ca2ebc71e28a1ceb14881c74909314ed46d057c`.
Прежние `4ff8da34…` (CR pos-5 §2) и `9e3ab95a…` (CR pos-1 §1) недействительны. Хеш
окончательный после заморозки DDL 10.11 18:00; при изменении файла полоса pos пришлёт новый.

Что это значит для файлов integration (остальное из CR pos-1 §1, CR pos-4 §4 и CR pos-5 §2 в
силе):

1. `infra/windows/native-edge-backup-ledger.json` - строка 026 с этим хешем;
   `edge-backup-lib.mjs` (`EDGE_BACKUP_SCHEMAS`, ревизия 026, CR-CLOUD-R9) - схема 026 с
   изменённым определением `edge_restore_fence`. Пока строки нет, 4 теста
   `tests/integration/windows-edge-backup.test.mjs` на ветке pos падают с `UNREVIEWED_SCHEMA`
   (так же и до этого CR, на `b25674d5`: инструмент копий намеренно не принимает 026 без
   ledger).
2. `infra/windows/pos-sales-upgrade-db.mjs` - снимок прав до и после `apply`: у
   `edge_restore_fence(boolean)` прежние владелец, `proacl`, `proconfig` (`search_path`),
   `prosecdef`; `pg_get_functiondef` отличается от 023 только списком очередей (так проверяет
   тест, п. 4).
3. `edge-runtime-grants.mjs`, `fulfillment-worker-grants.mjs`, `pos-sync-worker-grants.mjs` -
   без изменений.
4. `docs/operations/edge-restore.md` (строка 36): «сдвигает все три счётчика касса -> облако» -
   теперь четыре: с 026 и `pos_sale_outbox` (поток `posSales`); шаг 4 - см. п. 3.
5. CR pos-1 §1, «Изменения существующих объектов»: к функциям 026 добавлена
   `edge_restore_fence(boolean)` (`CREATE OR REPLACE`, этот CR).
6. Слияние: на ветке cloud лежит своя копия 026 (cherry-pick `513985f6`, SHA `9e3ab95a…`).
   Конфликт add/add в `026_edge_pos_sales.sql` решается версией pos (владелец, §4.1) - файл с
   SHA из этого пункта. `packages/pos-order-sync/tests/unit.test.mjs` (владелец pos) - тоже
   версия pos (в ней оба импорта, `sales-model` и `pos-sale-streams`).

## 3. Ручной шаг владельца после восстановления на этой 026 не нужен (CR cloud-5 п. 3)

Ручной сдвиг номера `posSales` (`setval` последовательности `pos_sale_outbox` на 10^9 после
строки `restore`, `docs/operations/backoffice-cutover.md`, раздел «Восстановление базы кассы»)
нужен был только для 026 без п. 1. Такая 026 на точке не устанавливалась и не будет: 026
ставится в окне С4 (ночь 14→15.11), после заморозки DDL, уже с разделом 10. На 026 с SHA из
п. 2 fence при старте edge сам сдвигает `pos_sale_outbox` ровно один раз вместе с остальными
очередями, проверка шага (`pg_get_functiondef(...) LIKE '%pos_sale_outbox%'`) отвечает
`covered = true`, и шаг выполнять не нужно. Повторный ручной сдвиг безвреден (ещё один пропуск
номеров), но лишний. Это доказывают тесты п. 4. Текст runbook (файл полосы cloud) остаётся за
cloud: предлагается оставить только проверку - `covered = false` значит, что на точке не та
026, тогда остановиться и звать инженера.

Z смены, открытой во время восстановления, fence не решает (CR cloud-5 п. 2): это команда
владельца облака `--accept-restored-z` (CR cloud-6), 026 для неё не меняется.

## 4. Тесты (запущены на этой ветке, private PostgreSQL)

- `tests/integration/pos-sales-upgrade.test.mjs`, «026 on a populated 025 edge: the restore
  fence moves pos_sale_outbox exactly once and the older counters exactly as 023 did ...»:
  заполненная 025 (поток заказов, кухня, cashier reports, heartbeat); восстановление,
  fence рантаймом с правами сегодняшнего дня сдвигает все счётчики 023 на 10^9; 026 заменяет
  функцию и ничего не сдвигает (нет новой эпохи); определение отличается от 023 только списком,
  владелец, ACL, `SECURITY DEFINER`, `search_path` прежние, у PUBLIC нет `EXECUTE`, у рантайма и
  FulfillmentWorker есть; второе восстановление на 026, fence рантаймом в сессии с временной
  таблицей `pos_sale_outbox`: старые счётчики сдвигаются ровно как на 025, настоящая
  `pos_sale_outbox` - ровно один раз на 10^9 (временная не тронута), рантайм сам `setval`
  выполнить не может, повторный вызов - `current`, следующий номер - 3 + 10^9 + 1.
- `tests/integration/pos-sales-streams.test.mjs`, «restored edge database on the real 026
  (CR cloud-5) ...»: зеркало случаев восстановления полосы cloud
  (`packages/pos-order-sync/tests/sales-worker-integration.test.mjs`) на настоящей 026 и
  таблице `cloud_pos_sale_inbox` 073 с правилом приёмника `new`/`duplicate`/`conflict`
  (`sales-cloud.ts`, `inboxState`): продажа до копии принята; продажа в копии не подтверждена;
  потерянный отрезок отдал облаку её события и ещё одну продажу; без fence следующий номер
  занят (`conflict`); проверка ручного шага - `covered`; после fence события копии уходят
  повтором, новая продажа, чеки и Z той же смены приняты за потерянным отрезком; Z считает три
  продажи кассы (четвёртая - в облаке, это CR cloud-5 п. 2); поток `order_commercial` идёт
  через пропуск номеров.
- Оба теста падают на 026 до этого CR (`b25674d5`) и на 026 без DO-блока `search_path`
  (проверено подменой файла, не закоммичено).
- Зелёные на ветке: `tests/integration/pos-sales*.test.mjs` и `cash-shift*.test.mjs` (55),
  `pnpm test:pos-order-sync` (11 + 22, в том числе D0 `restore.test.mjs`), `restore-upgrade`,
  `windows-restore-fence`, `edge-migration-order`, `tests/kitchen/restore-review`,
  `tests/unit/edge-restore-fence`, `fulfillment-transport` restore, `windows-runtime-1021`.

## 5. cloud: два теста `sales-worker-integration.test.mjs` после слияния pos

Проверено на временном дереве cloud `af6ec478` + pos (`git merge-tree`, конфликты по п. 2.6, в
ветки ничего не записано), private PostgreSQL. 12 из 14 тестов
`sales-worker-integration.test.mjs` зелёные, в том числе «restored edge database with the
posSales fence (CR cloud-5) ...» на настоящей 026; зелёные также `sales-cloud*.test.mjs`
(с `sales-cloud-restored-z`), `sales-worker.test.mjs`, `unit`, `restore`, `integration`,
`kitchen-integration` пакета и оба теста п. 4 (59 из 59). Падают два теста, которые
проверяют поведение 026 без п. 1:

- строка 619, «restored edge database, fence of today (023): pos_sale_outbox is left behind
  ...»: строка 624 ждёт, что fence не сдвинет `pos_sale_outbox` (`actual 1000000002n,
expected 2n`);
- строка 663, «restored edge database, interim runbook step until CR cloud-5 ...»: строка 668
  ждёт `covered: false`.

Исправление (файл полосы cloud): либо удалить оба теста вместе с ручным шагом runbook (такая
026 на точке не появится, п. 3), либо в начале обоих тестов ставить функцию 023 как она есть
(`CREATE OR REPLACE` тела 023 и его DO-блока, как `applyPosSalesFence` строки 572, но без
замены списка), чтобы они моделировали «026 без п. 1». `applyPosSalesFence` в третьем тесте
теперь пересоздаёт ту же функцию; её можно заменить проверкой, что установленная 026 уже
содержит `pos_sale_outbox` в определении.
