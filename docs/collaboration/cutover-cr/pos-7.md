# CR pos-7 → integration (копия client): номер кассы - миграция edge 028, команда `desk`, `desk_number` в `GET pos/config`

Полоса: pos (ветка `codex/cutover-pos`, доработка по решению lead 07.11 п. 1).
Адресаты: integration (`codex/cutover-1119`) - §2-§4; client (`codex/cutover-client`) - §5.
Основание: решение lead 07.11 п. 1 (источник номера кассы - pos, новая аддитивная миграция edge
028 до заморозки DDL 10.11 18:00, 026 и 027 не меняются; запасной ключ `deskNumber` в
`config.json` pos-desktop не используется), [CR client-5](client-5.md) §3.2, контракт §00, §3, §4.1,
§5.1, §11.
Коммиты: `9c1abe80` (028, команда `desk`, `GET pos/config`, тесты), этот CR и документация -
следующий коммит, `chore: regenerate openapi` - последний.

## 1. Что сделано (полоса pos)

### 1.1 `db/edge/migrations/028_edge_pos_desk_number.sql`

SHA-256 `684ffa9c5265d32fd3c33e6190ca3126c83c5cb47974aa274cf198fc905d0abf`, 4959 байт. Окончательный
после заморозки DDL 10.11 18:00; при изменении файла полоса pos пришлёт новый CR и новый хеш.

- Колонка `local_terminals.desk_number` (`smallint`, NULL) с CHECK
  `local_terminals_desk_number_check` (1..99). У всех существующих терминалов - `NULL` (экран без
  номера, как сейчас).
- Уникальный частичный индекс `local_terminals_active_desk_number` по `(branch_id, desk_number)`
  с условием «номер есть и терминал активен»: два активных терминала точки никогда не делят номер,
  выключенный терминал номер освобождает (`branch_config` - singleton, точка одна; `branch_id` в
  индексе - как в остальных таблицах).
- Аудит - тот же `pos_sales_setting_changes` (026): новый `subject = 'desk_number'`, `before` и
  `after` - ровно `{terminal_id, desk_number}` (uuid в нижнем регистре, номер 1..99 или `null`,
  терминал один и тот же, номер меняется). Оба CHECK, где упоминается `subject`, пересоздаются
  DO-блоком по `pg_get_constraintdef` (образец `022:16-21`, контракт §3.2 п. 3) **с прежними
  именами** `pos_sales_setting_changes_subject_check` и `pos_sales_setting_changes_check1`;
  правило старых subject (`pos_service_mode`, восемь способов) байт-в-байт прежнее, старые строки
  проходят новую проверку (CHECK проверяется при `ADD CONSTRAINT`).
- Функция `guard_local_terminal_desk_number()` и триггер `local_terminal_desk_number_guard`
  (до `INSERT` и до `UPDATE OF desk_number`): терминал создаётся без номера; номер меняется только
  вместе с последней строкой аудита `desk_number` этой точки, чьи `before`/`after` совпадают с
  изменением (как `guard_pos_payment_method` 026). Триггер срабатывает, только когда
  `desk_number` записывается: блокировки строк (`FOR SHARE`), `UPDATE(active)` рантайма и воркера
  доступа устройств и все прежние запросы до него не доходят.
- Новых таблиц и последовательностей нет; новый объект - индекс, функция и триггер.
- 028 опирается на 026 (`pos_sales_setting_changes`) и ставится только после 027 (номер). На
  наборе без 026 `migrate()` падает на 028 и откатывает всю транзакцию (§6.2: тест «027 is never
  applied before 026» до правки п. 2.3 падал именно так).

### 1.2 Совместимость в обе стороны (контракт §3.2 п. 4)

- **Прежний рантайм на 028** (D0, RC-edge без этого коммита): колонку не называет нигде.
  `provisionStaff` читает `SELECT * FROM local_terminals` и берёт только `branch_id`/`active`
  (`packages/local-orders/src/staff.ts:52-59`), вход и сессии - явные колонки (`:120-131`).
  Новые терминалы (`staff-setup.mjs`, воркер доступа устройств
  `packages/local-orders/src/terminal-access.ts:164`) вставляются без номера - guard пропускает.
  Тест §6.1: смена кассы открывается и закрывается на 028 ролью рантайма с правами точки.
- **Новый рантайм на 026/027 без 028**: `GET pos/config` читает номер одним запросом
  `to_jsonb(t)->'desk_number'` (`packages/local-orders/src/payment-methods.ts`); без 028 ключа в
  строке нет, ответ - `desk_number: null`, ничего не падает; `status` - `null` у всех касс; `desk` - отказ
  `DESK_NOT_INSTALLED`, ничего не записано. Тест §6.1 «new code on the schema without 028».
- Всё выключено: номер ни на что, кроме экрана кассы, не влияет (продажи, смены, X/Z, облако,
  потоки его не читают).

### 1.3 Права: ничего нового

- Рантайм edge читает `local_terminals` целиком: `infra/windows/edge-runtime-grants.mjs:10`
  (`posRead`) и `:98` (`GRANT SELECT` на таблицу) - табличное право покрывает и новые колонки.
  Писать номер рантайм не может: у него только `UPDATE(lock_anchor)` (`:104`) и `UPDATE(active)`
  (`infra/windows/terminal-access-grants.mjs:24`).
- Воркер доступа устройств имеет `INSERT` на таблицу (`terminal-access-grants.mjs:36-41`), но
  guard 028 отклоняет вставку с номером. Он же включает свои терминалы обратно
  (`packages/local-orders/src/terminal-access.ts:231`, `UPDATE ... SET active=true`): guard на это
  не срабатывает, а уникальный индекс касается только терминалов с номером - номер ставится
  только кассе, не терминалу доступа устройств (`TERMINAL_NOT_DESK`).
- Проверено тестом: роль рантайма после `applyEdgeRuntimeGrants` + `posSalesRuntimeGrants` -
  `has_column_privilege(..., 'desk_number', 'SELECT') = true`, `INSERT` и `UPDATE` - `false`,
  `UPDATE local_terminals SET desk_number=...` - `42501`; `GET pos/config` этой ролью отдаёт
  номер.
- Строк для `infra/windows/{edge-runtime-grants,fulfillment-worker-grants,pos-sync-worker-grants}.mjs`
  и `pos-sales-grants.mjs` не нужно.

### 1.4 Команда оператора `scripts/pos-sales-setup.mjs desk`

```text
desk --terminal <uuid> --number <1..99> --reason "<3..300 символов>"
desk --terminal <uuid> --clear --reason "<3..300 символов>"
```

Только владелец базы edge (owner-окружение, как остальные команды; плюс проверка
владельца `local_terminals`), под той же блокировкой строки точки. Строка аудита пишется до
изменения. Тот же номер ещё раз - `"changes": []` и `"message": "Ничего не изменено: у кассы уже
этот номер"`. Отказы (ничего не записано): `INVALID_ARGUMENTS` (нет терминала или причины, номер
вне 1..99 или с ведущим нулём, `--number` и `--clear` вместе или ни одного), `DESK_NOT_INSTALLED`,
`TERMINAL_UNKNOWN`, `TERMINAL_INACTIVE`, `TERMINAL_NOT_DESK` (кухонный экран или табло: доступ
устройств 020), `DESK_NUMBER_TAKEN` (номер у другой активной кассы, её `terminal_id` в ответе),
`NOT_INSTALLED`, `NOT_OWNER`, `BRANCH_MISSING`. `status` показывает `desk_number` у каждой кассы
`cash_desks` (сразу после `terminal_id`). Описание для оператора - `docs/operations/pos-sales.md`
§2 `desk`.

### 1.5 `GET pos/config`

Ответ §5.1 получает последний ключ `desk_number: number | null` - номер терминала сессии
(`PosConfigSchema` в `packages/contracts/src/pos-sales.ts`, `PosDeskNumberSchema` 1..99). Все
прежние ключи и их порядок прежние: тест сверяет сырой ответ HTTP с ответом 026, собранным ключ за
ключом, - отличие только в `,"desk_number":null}` (или номере) в конце, при `payment_required` и
`unpaid_service`, все способы выключены. `openapi.json` перегенерирован отдельным коммитом.

## 2. integration: куда 028 должна попасть (проверено на временном слиянии, §6.2)

Все правки ниже применены на временном дереве `codex/cutover-1119` `274a363f` + `9c1abe80`
(ничего не закоммичено, дерево удалено); с ними зелёные все наборы §6.2. Точный diff - приложение
А (хеши `.ps1` пересчитать, если правки отличаются хоть байтом).

1. **Инструмент применения на точке** - `infra/windows/pos-sales-upgrade-db.mjs` (список
   закреплённых хешей) или отдельный режим/инструмент integration. Требования (по образцу 026/027):
   - предусловия: службы остановлены, свежая копия schema027 (шаг 3 действие 7 уже даёт),
     `<appRoot>` - 001-028 сплошь, 026 `921c5263…d057c`, 027 `41e55b45…a2a97`, 028
     `684ffa9c…d0abf`; ledger базы - ровно 001-027 этих байтов, иначе отказ;
   - `apply`: точные байты 028 и строка ledger в одной транзакции (как `migrate()`);
   - проверки внутри транзакции: одна новая колонка `local_terminals.desk_number smallint` NULL у
     всех строк, остальные столбцы и строки `local_terminals` и `pos_sales_setting_changes`
     прежние (хеш строк без `desk_number`); constraint `local_terminals_desk_number_check` и
     индекс `local_terminals_active_desk_number` (уникальный, частичный: номер есть и терминал
     активен); у `pos_sales_setting_changes` тот же набор имён CHECK, `subject_check` содержит
     `desk_number`; ровно одна новая функция `guard_local_terminal_desk_number()` и один триггер
     `local_terminal_desk_number_guard`, остальные функции (определение, владелец, ACL) прежние;
     ни одной новой таблицы или последовательности; `relacl` всех таблиц прежний; если роль
     рантайма установлена - у неё есть `SELECT` колонки `desk_number` и нет `UPDATE` и `INSERT`
     (`has_column_privilege`); выключено: ни у одного терминала нет номера;
   - вывод - одна строка JSON (`"applied":true`, `"migrations":28`, `"deskNumbers":0`), повторный
     `apply` отказывает, `inspect` после `apply` проверяет установленное; откат схемы не нужен.
2. **Копии кассы**: `infra/windows/native-edge-backup-ledger.json` - строка 028 с хешем §1.1;
   `edge-backup-lib.mjs` `EDGE_BACKUP_SCHEMAS` += `schema028: 28`; `backup-native-service.mjs`
   `SERVICE_BACKUP_SCHEMAS` += `schema028: 28` и `PINNED_LEDGER_LENGTH = 28`; закрепления байтов
   `install-edge-backup.ps1:35,39` и `update-runtime-stage2-1024.ps1:122-123` (цепочкой: ledger →
   `install-edge-backup.ps1` → stage2); `tests/unit/edge-backup.test.mjs:37-46` (`schema028`) и
   `tests/unit/native-service-backup.test.mjs:52-59,109-124` (001-028). **Без этого после 028 копия
   по расписанию отказывает `UNREVIEWED_SCHEMA`** (на слиянии без правки - 4 теста
   `tests/integration/windows-edge-backup.test.mjs`), поэтому правка идёт в тот же RC-edge, что и 028.
3. **Порядок миграций**: `tests/integration/edge-migration-order.test.mjs` - `CUTOVER_EDGE` +=
   `'028_edge_pos_desk_number.sql': '684ffa9c…d0abf'` (иначе «cutover edge migrations upgrade a
   025 edge in order» красный) и в «027 is never applied before 026» набор без 026 ограничить
   файлами до 028 (`name !== '026_edge_pos_sales.sql' && name < '028'`): 028 без 026 не
   применяется вовсе.
4. **`tests/integration/staff-passwords.test.mjs:394,426`** (не файл pos, адресовано integration):
   снимок `local_terminals` до/после 011 вычитает колонки поздних миграций
   (`-'device_access_managed'`), к нему - `-'desk_number'`. Без этого «010 to 011 preserves
   existing sessions/menu/shift rows» красный на любой ветке с 028.
5. **tests/operations**: питоновские закрепления п. 2 (`test_windows_edge_backup.py`,
   `test_windows_stage2_release.py`) зелёные после пересчёта хешей; других списков миграций там
   нет. **Пакет RC-edge**: файлы менять не нужно - `scripts/build-windows-edge-runtime.py:207-210`
   копирует `db/edge/migrations` целиком, `scripts/pos-sales-setup.mjs` уже в `ADMIN_FILES` (`:58`).
6. **Контракт** `docs/architecture/cutover-2026-11-contracts.md`: §3.1 - строка 028 (pos,
   применяет инструмент п. 1, хеш §1.1); резерв P1 «edge 028+» → **«edge 029+»** (например,
   `pos_discount_presets` из CR bo-ui-7 - 029+); §3.2 п. 1 - 028 только после 027 (ledger ровно
   001-027); §3.3 - содержание 028 (§1.1); §5.1 - в ответ `GET pos/config` последним ключом
   `desk_number: number | null`; §11 - строка поправки (решение lead 07.11 п. 1, этот CR). §4.1
   строки pos `db/edge/migrations/026_*` - добавить `028_*`.
7. **Мастер-runbook** `docs/operations/cutover-2026-11-19.md`: §0 п. 10 - закрыт этим CR (касса с
   оплатой показывает номер после шага оператора §3; client - §5); §2.2 - строка 028 (хеш, чем
   применяется, окно С4, где закреплён); шаг 3 - действие сразу после 027: `inspect`/`apply` 028,
   затем повторный `Install` копий (`health.schema = schema028`, задача снова включена), проверка -
   строка JSON инструмента и `pos-sales-setup.mjs status` (`desk_number: null` у всех касс),
   таблица отказов - строки инструмента; шаг оператора §3 этого CR - в шаг 4 (после установки
   касс) или не позже шага 6 до `enable`.

## 3. Шаг оператора для runbook (номера касс)

Когда: после окна С4 (028 применена) и установки касс `install-pos-client.ps1` (шаг 4), когда на
каждой кассе хотя бы раз вошли по PIN; не позже шага 6 (Т7), до `enable`. Номер не влияет на
продажи и можно ставить при открытых сменах.

1. `terminalId` каждой кассы: строка установщика
   `POS_CLIENT_CONFIGURED profile=… app=… terminalId=<uuid> …`
   (`infra/windows/install-pos-client.ps1:281`) или `%APPDATA%\PickChickPOS\config.json` на
   моноблоке (ключ `terminalId`). Записать, какая касса - 1 (у входа) и какая - 2.
2. На сервере точки, owner-окружение (как остальные команды `pos-sales-setup.mjs`, папка поставки
   RC-edge):

   ```powershell
   & '<existing node.exe>' --env-file='<private owner.env>' scripts/pos-sales-setup.mjs status
   ```

   Ждать: в `cash_desks` обе кассы (`terminal_id` из п. 1) с `"desk_number": null`.

3. Номера:

   ```powershell
   & '<existing node.exe>' --env-file='<private owner.env>' scripts/pos-sales-setup.mjs desk --terminal <terminalId кассы 1> --number 1 --reason "Касса 1 у входа"
   & '<existing node.exe>' --env-file='<private owner.env>' scripts/pos-sales-setup.mjs desk --terminal <terminalId кассы 2> --number 2 --reason "Касса 2 у окна"
   ```

   Ждать на каждую (JSON, кроме полей `status`):

   ```json
   {
     "event": "pos_sales_desk",
     "desk": { "terminal_id": "<uuid кассы 1>", "desk_number": 1 },
     "changes": [
       {
         "subject": "desk_number",
         "before": { "terminal_id": "<uuid кассы 1>", "desk_number": null },
         "after": { "terminal_id": "<uuid кассы 1>", "desk_number": 1 }
       }
     ],
     "message": "Номер кассы записан"
   }
   ```

   Повтор той же строки - `"changes": []` и `"message": "Ничего не изменено: у кассы уже этот
номер"` (это не ошибка).

4. Проверка: `status` - у кассы 1 `"desk_number": 1`, у кассы 2 `"desk_number": 2`,
   `recent_changes[0].subject = "desk_number"`; на каждой кассе `GET pos/config` отдаёт свой номер
   (касса показывает его после следующего чтения настроек - до 30 с, или после входа). Резервная
   касса на сервере - по решению владельца `--number 3` или без номера.
5. Отказы: `DESK_NOT_INSTALLED` - 028 не применена (окно С4); `TERMINAL_UNKNOWN` - не тот
   `terminalId`; `TERMINAL_NOT_DESK` - это кухонный экран или табло; `DESK_NUMBER_TAKEN` - номер
   уже у другой кассы (`terminal_id` в ответе): снять номер там (`desk ... --clear`) или выбрать
   другой. Откат шага - `desk --clear` (номер только на экране; схема не
   откатывается).

## 4. Что не меняется

- 026 и 027 - ни байта (хеши 026 `921c5263…d057c`, 027 `41e55b45…a2a97` прежние).
- Интерфейсы §5, кроме ключа `desk_number` в `GET pos/config` (§1.5).
- `apps/pos/**`, `apps/pos-desktop/**`, шлюз и профили (`pos/config` уже в маршрутах), облако.

## 5. client: как читать номер

- `GET pos/config` → `desk_number` (целое 1..99 или `null`). Edge 026 без этого коммита ключа не
  отдаёт - считать `null` (CR client-5 §3.2 п. 4: «без поля или `null` - как сейчас»).
- Нынешний парсер кассы ключ не замечает: `apps/pos/src/types.ts:897-930` (`posConfig`, ветка
  integration `274a363f`) строит новый объект только из известных ключей; собранный `dist` этой
  ветки (`apps/pos/dist/types.js`) на ответах без ключа, с `null` и с `2` возвращает один и тот
  же объект (запущено 07.11). `pnpm test:pos` на временном слиянии с настоящим edge и 028 -
  127/127.
- Отображение («Касса N» на входе, открытии, в шапке; подсказка экрана входа) - полоса client по
  CR client-5 §3.2 п. 4.

## 6. Тесты

### 6.1 На ветке pos (`9c1abe80`, private PostgreSQL 55485)

- Новый `tests/integration/pos-sales-desk-number.test.mjs` - 5/5: аргументы `desk` (все отказы);
  028 на заполненной базе со всеми миграциями до неё (на ветке pos - 001-026, на слиянии - 001-027):
  строки `local_terminals` прежние + `desk_number: null`, аудит и имена CHECK прежние, новый код
  на базе без 028 (`null`, `DESK_NOT_INSTALLED`), CHECK 0/100/-1, один номер на активную кассу,
  выключенная касса и её возврат в работу, guard (вставка с номером, изменение без аудита и с
  чужим аудитом), правило аудита (20 вариантов), права рантайма и смена ролью рантайма; команда
  `desk` (аудит первым, повтор, `TAKEN`, `UNKNOWN`, `BRANCH_MISSING`, `INACTIVE`, `NOT_DESK`
  обоих видов, перенумерация, `--clear`, `NOT_OWNER`); `GET pos/config` по HTTP - побайтно;
  командная строка.
- `tests/integration/pos-sales*.test.mjs` и `cash-shift*.test.mjs` - 60/60; `@pickchick/local-orders`
  test 4/4 и test:integration 6/6; `pnpm test:pos-order-sync` 11 + 22; `pnpm test:fulfillment-transport`
  12 + 80.
- Остальные `tests/integration` (76 файлов): красные только (а) ожидаемое integration-правкой
  `staff-passwords` «010 to 011» (п. 2.4); (б) было красным до этого CR: 4
  `windows-edge-backup` (`UNREVIEWED_SCHEMA`, как в CR pos-6 §2 п. 1) и `stage2-cross-lane`
  «merged contracts» (на ветке pos старая копия теста, на integration уже с `aggregator_prices`);
  (в) пропуск номера 027 на ветке pos: `menu-sync-worker-role` (2), `remote-stops-upgrade` (2) -
  инструменты требуют сплошную нумерацию, на integration 027 есть (как CR kds-1 про 026). Тесты
  `admission`, `database`, `http` требуют мигрированной схемы `public` - с `PG_MIGRATE=1` зелёные.
- `pnpm test` - 380 пройдено, 1 пропущен, 2 красные по (в): `menu-sync-worker-grants` «reviewed
  migration set contains 018», `remote-stops-upgrade` «candidate migrations must contain the
  reviewed 018 and 019». `tests/operations/*.test.mjs` - красные `windows-cashier-reports-upgrade`
  (2, по (в)) и `kitchen-lan`, `kitchen-lan-chain` (нужен частный сетевой интерфейс, среда).

### 6.2 На временном слиянии `codex/cutover-1119` `274a363f` + `9c1abe80`

Отдельное дерево в scratch, `pnpm install --offline`, `pnpm -r build`, private PostgreSQL
(SCRAM, как у integration); ничего не закоммичено, дерево удалено.

- `pos-sales*` и `cash-shift*` - 60/60, в том числе 028 на заполненной базе **001-027** (027 со
  своими таблицами).
- `tests/integration` (91 файл) + notifications: без правок §2 красные только 2
  `edge-migration-order` (п. 2.3), 1 `staff-passwords` (п. 2.4), 4 `windows-edge-backup` (п. 2.2);
  с приложением А все семь зелёные, `cutover-cross-lane`, `cutover-tools-cli`,
  `cutover-sync-release`, `windows-cutover-upgrade`, `kds-*` - зелёные.
- `pnpm test` - 424 + 1 пропущен (с приложением А; без него тоже зелёный, ledger 001-027).
- `python3 -m unittest discover -s tests/operations` - 574, OK (14 пропущены) с приложением А.
- `tests/operations/*.test.mjs` - 33 + 4 пропущены, красные только `kitchen-lan*` (среда).
- `pnpm test:pos` (client, настоящий edge с 028) - 127/127.

## Приложение А. Проверенный diff integration (временное слияние, не закоммичен)

```diff
--- a/infra/windows/backup-native-service.mjs
+++ b/infra/windows/backup-native-service.mjs
@@ -87,8 +87,9 @@ export const SERVICE_BACKUP_SCHEMAS = Object.freeze({
   schema026: 26,
   // Cutover 19.11 (CR kds-1): the guarded 026 -> 027 upgrade follows a schema026 copy.
   schema027: 27,
+  schema028: 28,
 });
-const PINNED_LEDGER_LENGTH = 27;
+const PINNED_LEDGER_LENGTH = 28;
--- a/infra/windows/edge-backup-lib.mjs
+++ b/infra/windows/edge-backup-lib.mjs
@@ -49,6 +49,7 @@ export const EDGE_BACKUP_SCHEMAS = Object.freeze({
   schema026: 26,
   schema027: 27,
+  schema028: 28,
 });
--- a/infra/windows/install-edge-backup.ps1
+++ b/infra/windows/install-edge-backup.ps1
@@ -32,11 +32,11 @@
-    'edge-backup-lib.mjs'            = 'a5be304c1fb3964f605853c78c46f31ca08b2064d3476fd82f4c00627c4aff43'
+    'edge-backup-lib.mjs'            = '16913316cfab6f869faf2ef4e6344f7471365454f134e091b10eb6f783356fa3'
-    'native-edge-backup-ledger.json' = 'dad65fa110b1b975d0e99278a45983984d8852e5b94792ae2d6480e10e62fc62'
+    'native-edge-backup-ledger.json' = '66b798a6fe264dcaf266959fc42a0876998a8b0412a147fd9264273ddbdfc27f'
--- a/infra/windows/native-edge-backup-ledger.json
+++ b/infra/windows/native-edge-backup-ledger.json
@@ -133,5 +133,10 @@
     "version": "027_edge_kds_foundation.sql",
     "checksum": "41e55b450721646e45be599cf58626fd52328113f5a8165bb8fa5edf1e3a2a97",
     "scope": "edge"
+  },
+  {
+    "version": "028_edge_pos_desk_number.sql",
+    "checksum": "684ffa9c5265d32fd3c33e6190ca3126c83c5cb47974aa274cf198fc905d0abf",
+    "scope": "edge"
   }
 ]
--- a/infra/windows/update-runtime-stage2-1024.ps1
+++ b/infra/windows/update-runtime-stage2-1024.ps1
@@ -119,8 +119,8 @@
- 'native-edge-backup-ledger.json'='dad65fa110b1b975d0e99278a45983984d8852e5b94792ae2d6480e10e62fc62'
- 'install-edge-backup.ps1'='b332145f253d157e42f6f6b00de28710c9d2bc3c2f3690d9a8fb81d5215bbc40'
+ 'native-edge-backup-ledger.json'='66b798a6fe264dcaf266959fc42a0876998a8b0412a147fd9264273ddbdfc27f'
+ 'install-edge-backup.ps1'='241618b5fd789cb77c43641a8f479a9bee580c0e291bb70f8b473a7c2d17ab9b'
--- a/tests/integration/edge-migration-order.test.mjs
+++ b/tests/integration/edge-migration-order.test.mjs
@@ -188,6 +188,7 @@
   '027_edge_kds_foundation.sql': '41e55b450721646e45be599cf58626fd52328113f5a8165bb8fa5edf1e3a2a97',
+  '028_edge_pos_desk_number.sql': '684ffa9c5265d32fd3c33e6190ca3126c83c5cb47974aa274cf198fc905d0abf',
 };
@@ -230,7 +231,7 @@
-      (name) => name !== '026_edge_pos_sales.sql',
+      (name) => name !== '026_edge_pos_sales.sql' && name < '028',
--- a/tests/integration/staff-passwords.test.mjs
+++ b/tests/integration/staff-passwords.test.mjs
@@ -391,7 +391,7 @@ (и так же @@ -423,7 +423,7 @@)
-                      ? "-'device_access_managed'"
+                      ? "-'device_access_managed'-'desk_number'"
--- a/tests/unit/edge-backup.test.mjs
+++ b/tests/unit/edge-backup.test.mjs
@@ -44,6 +44,7 @@
     schema027: 27,
+    schema028: 28,
   });
--- a/tests/unit/native-service-backup.test.mjs
+++ b/tests/unit/native-service-backup.test.mjs
@@ -55,8 +55,8 @@
-    .slice(0, 27);
-  assert.equal(names.length, 27);
+    .slice(0, 28);
+  assert.equal(names.length, 28);
@@ -122,6 +122,7 @@
     'schema027',
+    'schema028',
   ]);
```

Названия тестов «020-027», «001-027», «schema014-027» в этих файлах integration обновляет вместе с
числами.
