# CR cloud-5: fence восстановления базы кассы для `pos_sale_outbox` и Z смены, открытой во время восстановления

Полоса: cloud (ревью CR-CLOUD-R1, поток `posSales`, CC-4). Кому: pos (п. 1, файл
`db/edge/migrations/026_edge_pos_sales.sql`), lead/integration (п. 2-4).
Срочность: п. 1 - **до заморозки DDL 10.11 18:00** (§1.1, §3.2 п. 6): после установки 026 на
точке файл не меняется никогда, и тогда исправление возможно только новой миграцией edge 028+.
Интерфейсы §5 не меняются.

## Проблема

`edge_restore_fence()` (023, `docs/operations/edge-restore.md`) после восстановления базы кассы
из копии сдвигает на 1 000 000 000 счётчики `local_order_streams`, `cashier_report_outbox` и
`fulfillment_outbox`. Счётчик `pos_sale_outbox.sequence` (026) он не сдвигает: список таблиц в
функции жёсткий, а 026 его не расширяет (проверено по веткам всех полос).

Сценарий: копия базы кассы взята в 12:00, сбой в 12:40, восстановление из копии. Облако уже
приняло события `posSales` потерянного отрезка 12:00-12:40 и хранит их в `cloud_pos_sale_inbox`
с `UNIQUE(device_id, sequence)`. Восстановленная касса продолжает `bigserial` с номера копии,
поэтому первая же новая продажа получает номер, который облако уже отдало событию потерянного
отрезка. Ответ - `rejected: CONFLICT`, событие паркуется, `retryPosSalesDelivery` не помогает
(облако право: номер занят), и все следующие продажи, возвраты, чеки и Z ждут за ним. Отчёт
продаж (CC-7) замирает на моменте сбоя.

Воспроизведено тестом `packages/pos-order-sync/tests/sales-worker-integration.test.mjs`,
«restored edge database, fence of today (023): ... stays parked as CONFLICT».

## 1. 026: `edge_restore_fence` сдвигает и `pos_sale_outbox` (pos)

Интерфейс - одна строка функции 023:

```diff
-  FOREACH source IN ARRAY ARRAY['cashier_report_outbox', 'fulfillment_outbox'] LOOP
+  FOREACH source IN ARRAY ARRAY['cashier_report_outbox', 'fulfillment_outbox', 'pos_sale_outbox'] LOOP
```

Точный блок в конец 026 (после `CREATE TABLE pos_sale_outbox`). Тело - байт-в-байт тело 023,
кроме `CREATE OR REPLACE` и списка таблиц:

```sql
-- Restore fence (023, docs/operations/edge-restore.md) also moves the posSales producer sequence:
-- the cloud keeps UNIQUE(device_id, sequence) of cloud_pos_sale_inbox and refuses a reused
-- sequence as CONFLICT for good. The body is 023's byte for byte except the outbox list.
CREATE OR REPLACE FUNCTION edge_restore_fence(p_force boolean DEFAULT false)
RETURNS TABLE(state text, epoch integer, sequence_gap bigint)
LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE
  gap constant bigint := 1000000000;
  live_system bigint;
  live_oid bigint;
  last_epoch edge_database_epochs%ROWTYPE;
  source text;
  sequence_name text;
BEGIN
  -- Serializes concurrent fences (edge service and FulfillmentWorker); readers are not blocked.
  LOCK TABLE edge_database_epochs IN EXCLUSIVE MODE;
  SELECT c.system_identifier INTO live_system FROM pg_control_system() c;
  SELECT d.oid::bigint INTO live_oid FROM pg_database d WHERE d.datname = current_database();
  SELECT * INTO last_epoch FROM edge_database_epochs e ORDER BY e.epoch DESC LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO edge_database_epochs(epoch, system_identifier, database_oid, reason, sequence_gap)
      VALUES (1, live_system, live_oid, 'initial', 0);
    RETURN QUERY SELECT 'initial'::text, 1, 0::bigint;
    RETURN;
  END IF;
  IF NOT p_force AND last_epoch.system_identifier = live_system
    AND last_epoch.database_oid = live_oid THEN
    RETURN QUERY SELECT 'current'::text, last_epoch.epoch, 0::bigint;
    RETURN;
  END IF;
  UPDATE local_order_streams SET last_sequence = last_sequence + gap;
  FOREACH source IN ARRAY ARRAY['cashier_report_outbox', 'fulfillment_outbox', 'pos_sale_outbox'] LOOP
    IF to_regclass(source) IS NOT NULL THEN
      sequence_name := pg_get_serial_sequence(source, 'sequence');
      IF sequence_name IS NOT NULL THEN
        PERFORM setval(sequence_name::regclass,
          coalesce(pg_sequence_last_value(sequence_name::regclass), 0) + gap, true);
      END IF;
    END IF;
  END LOOP;
  -- The stop-list heartbeat revision is this counter; the cloud ignores any revision not above
  -- the last one it stored, so a restored counter would leave branch availability stale (every
  -- app and kiosk checkout AVAILABILITY_STALE) until it caught up with the lost timeline.
  UPDATE fulfillment_transport_state SET attempts = attempts + gap;
  UPDATE menu_sync_state SET restore_resync_from = last_sequence;
  INSERT INTO edge_database_epochs(epoch, system_identifier, database_oid, reason, sequence_gap)
    VALUES (last_epoch.epoch + 1, live_system, live_oid,
      CASE WHEN p_force THEN 'operator' ELSE 'restore' END, gap);
  RETURN QUERY SELECT CASE WHEN p_force THEN 'operator' ELSE 'restore' END, last_epoch.epoch + 1, gap;
END; $$;
-- CREATE OR REPLACE resets the SET clause: pin the owner-controlled search_path again (023).
-- Ownership and EXECUTE rights (REVOKE FROM PUBLIC, the Edge and FulfillmentWorker grants) stay.
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.edge_restore_fence(boolean) SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
END $$;
```

Важно:

- `CREATE OR REPLACE FUNCTION` сбрасывает `SET search_path` функции, поэтому блок `DO` с
  `ALTER FUNCTION ... SET search_path` (как в 023) обязателен; без него функция владельца
  искала бы имена по пути вызывающего (в том числе во временных таблицах).
- Права не меняются: `CREATE OR REPLACE` сохраняет владельца и ACL (из 023 у PUBLIC нет
  `EXECUTE`; `EXECUTE` ролей Edge и FulfillmentWorker остаётся). Новых прав не нужно: функция
  владельца сама вызывает `setval` на последовательности, владелец которой - тот же владелец
  миграций.
- `SELECT edge_restore_fence()` в 026 не вызывать: паспорт базы уже записан в 023, вызов вернул
  бы `current` и ничего не изменил.
- Совместимость (§3.2 п. 4): прежний рантайм на 026 вызывает ту же функцию при старте; для
  старых очередей поведение байт-в-байт прежнее, `pos_sale_outbox` он не читает. Новый рантайм
  на 025 работает с функцией 023 (таблицы `pos_sale_outbox` нет). Облако допускает пропуски
  номеров (принимает префикс по порядку, проверяет только уникальность пары устройство/номер),
  разрыв в 10^9 ему не мешает.
- Проверка в полосе cloud: тест «restored edge database with the posSales fence (CR cloud-5)»
  в `sales-worker-integration.test.mjs` применяет ровно этот блок (берёт тело из 023 и меняет
  только список) как заглушку до правки 026: функция сдвигает очереди cashier reports, кухни и
  `pos_sale_outbox` ровно на 10^9, повторный вызов - `current`, `search_path` закреплён,
  `EXECUTE` у PUBLIC нет; копия отдаёт продажу 2 повтором, новая продажа принимается после
  событий потерянного отрезка. После правки 026 полоса pos может проверить то же в своём тесте
  апгрейда (`pg_get_functiondef` до и после отличается только списком). Пока правки нет,
  runbook даёт ручной шаг владельца (п. 3); его проверяет тест «interim runbook step until CR
  cloud-5».

Integration: `docs/operations/edge-restore.md` - «все три счётчика» станет «все четыре»; ревизия
026 в `native-edge-backup-ledger.json`/`edge-backup-lib.mjs` (CR-CLOUD-R9) и снимок прав
`pos-sales-upgrade-db.mjs` должны видеть изменённое определение функции с прежним ACL.

## 2. Z смены, открытой во время восстановления (решение lead/integration)

Fence не решает второй случай. Смена, открытая в копии, после восстановления снова открыта на
кассе, но без продаж и возвратов потерянного отрезка; облако их хранит. Z этой смены не сходится
с проекцией облака (`shift_cash` или `shift_methods`), облако отвечает `INVALID_EVENT`, Z
паркуется, и все следующие события ждут за ним. То же с отменой или возвратом продажи, которую
потерянный отрезок уже отменил: облако отказывает (`sale_voided`, `refund_limit`), и это верно -
на кассе это был бы второй возврат тех же денег. Тест: «... a Z of a shift open across the
restore stays parked».

Нужна процедура. Варианты:

- **A (предлагается для P0).** Команда владельца облака (с URL владельца базы, как назначения
  `scripts/backoffice-setup.mjs --designation`; HTTP-маршрута нет):
  `acceptRestoredShiftReport(pool, {branchId, deviceId, event, reason})` в
  `packages/pos-order-sync/src/sales-cloud.ts`. Принимает ровно припаркованное событие Z (тот
  же `event_id`, `sequence`, хеш), сохраняет Z кассы как есть, пишет строку inbox, печатает
  расхождение с проекцией по каждому методу для бухгалтера. Следующая попытка кассы получает
  повтор и поток идёт дальше. Только для `shift_report`: отмены и возвраты не принимаются в
  обход лимитов. Аудит: без новой таблицы - JSON-строка в журнале оператора; если нужна
  таблица - облачная миграция 075 (P1, номер у интеграции). Полоса cloud сделает после
  одобрения, DDL не нужен.
- **B.** Команда владельца кассы (полоса pos, `pos-sales-setup.mjs`): отметить припаркованный Z
  доставленным без облака. Проще, но в облаке у смены не будет Z.
- **C.** Без инструмента: событие ждёт, бухгалтер работает по бумажному Z, инженер решает
  каждый случай отдельно. Это и есть поведение сейчас (runbook, раздел «Восстановление базы
  кассы»).

## 3. Мастер-runbook восстановления (integration)

В `docs/operations/edge-restore.md`, шаг 4 процедуры: пока 026 без п. 1 установлена на точке,
после строки `restore` и до открытия кассы выполнить от владельца базы кассы ручной сдвиг из
`docs/operations/backoffice-cutover.md`, раздел «Восстановление базы кассы». После п. 1 шаг не
нужен (повторный сдвиг безвреден: облако допускает пропуски номеров).
