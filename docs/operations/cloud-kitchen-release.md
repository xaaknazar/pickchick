# Выпуск облачного кухонного канала (ADR-0014) на VPS

Профиль: `infra/staging/release-cloud-kitchen.py`, владелец БД: `infra/staging/cloud-kitchen-release-owner.mjs`.
Тесты: `tests/operations/test_cloud_kitchen_release.py` (guards), `tests/integration/cloud-kitchen-release.test.mjs`
(PostgreSQL: 052 -> 056, гранты, режим `edge`/`cloud` с журналом).

Статус: профиль написан и проверен в read-only `prepare`; **на VPS ничего не применялось**. Все изменяющие
действия выполняет только владелец, каждое отдельно и с `--apply`.

## Что делает каждое действие

Без `--apply` любое действие только проверяет и печатает план. С `--apply` берётся общий lock
`/opt/pickchick-staging/.market-release.lock`; при ошибке lock **сохраняется** (восстановление - тем же
действием с `--owner-id <id из .local/cloud-kitchen-release/<sha>/lock-owner-*.json>`).

| Действие      | Изменения                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare`     | Неизменяемый образ `pickchick-api:<sha>`, `releases/<sha>` с compose = установленный compose 8468 + две строки флагов в выключенном виде (`CLOUD_KITCHEN_API_ENABLED: "0"`, `BACKOFFICE_CLOUD_KITCHEN_ENABLED: "false"`), `release.env` отличается только `RELEASE_SHA`. Если кандидат меняет `infra/kitchen-portal` или `apps/kitchen` относительно установленного портала - пакет портала (собранный `apps/kitchen/dist` + отслеживаемые файлы) в `kitchen-portal/releases/<sha>`. Read-only `inspect` владельца по живой БД.                                                                                                                                                                                                                                                                                                              |
| `apply`       | Зашифрованный бэкап (ключ этого Mac) + восстановление в изолированную БД; одна транзакция владельца: 053-056 + гранты (`channel-number-grants`, `cloud-kitchen-grants`, `cloud-channel-stop-grants` (availability, затем stop), `cloud-kitchen-screen-grants` (screen, затем order)) с точной сверкой ACL таблиц/колонок и EXECUTE функций; пересоздание только API (+ портал, если меняется, без облачного оверлея). Флаги выключены, все точки в режиме `edge`. При ошибке после переключения - автоматический возврат API/указателя (и портала); БД не восстанавливается, схема аддитивна.                                                                                                                                                                                                                                                |
| `stations`    | Доверенная загрузка станций и маршрутизации облака (`--kitchen-setup <json>`), сначала read-only `stations-preview` владельца (версия маршрутизации, число маршрутов). Две формы: полная `{branchId, stations, routing}` или минимальная `{branchId, stations, routeAllProductsTo}` - ровно две известные станции production (сборка `2cbc8ef3-359b-4cf0-bda8-28b82b727c93`, цех `9ba8dc69-260c-482b-bed9-cab791b64595`, id наблюдались в `cloud_fulfillment_projection`/`observed_tasks`), имена берутся только из JSON, все товары головной публикации каталога точки идут на указанный цех (`prep`; комбо/сет без раскрытых компонентов - целиком). Версия маршрутизации растёт только при изменении маршрутов. После новой публикации каталога с новыми товарами повторить `stations`. Без станций `enable` и `screen-code` не начнутся. |
| `enable`      | Внутренняя сеть `pickchick-kitchen_cloud`; compose API: флаги включены + API в этой сети с алиасом `pickchick-api`; в защищённый `config.json` портала добавляется только блок `cloudKitchen` `{enabled: true, apiOrigin: "http://pickchick-api:3100", branchId}` **без ключей** (исходные байты - в `config.pre-cloud.json` 0600). Новый SHA-256 config вычисляется read-only в `prepare`/`enable` без `--apply` и передаётся как `--expected-enabled-config-sha256`; при расхождении запись не выполняется. Портал пересоздаётся с `-f compose.yaml -f compose.cloud.yaml`; режим точки `edge -> cloud` через `cloud_kitchen_set_mode` (оператор + причина, журнал). **Экраны не создаются.** Проверка: env-дельта ровно два флага, `cloudConnected: true`, SHA config = ожидаемый, режим `cloud`.                                         |
| `screen-code` | Один экран за вызов: `--role prep\|assembly\|display` создаёт экран (prep/assembly - все станции своего вида, имя по станциям из JSON; табло - `Табло` или `--screen-name`), `--screen <id>` выдаёт новый код существующему активному экрану этой роли (ротация). Только с `--operator`, `--reason`, `--apply` и интерактивным терминалом: одноразовый код (10 минут) печатается один раз в терминал владельца и **не пишется** в evidence, логи или Git (в evidence - роль, id экрана, срок, оператор, причина). Альтернатива - бэк-офис или `cloud-kitchen-screen-owner.mjs create` на VPS.                                                                                                                                                                                                                                                |
| `mode-edge`   | Быстрый откат режима точки в `edge` (журнал). Кухня продолжает доводить уже оплаченные облачные заказы.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `disable`     | Режим `edge`; требует 0 активных облачных заказов (иначе стоп - довести заказы и повторить); отзыв экранов; исходный config портала (проверка SHA) и портал без оверлея; compose API обратно к выключенным флагам без сети.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `rollback`    | API (+ портал) обратно к 8468/23fb; схема 056 и гранты остаются; разрешён только в выключенном состоянии.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

`edgeConnected` портала **не проверяется** (в отличие от device-access): касса может быть выключена, канал для
этого и нужен. Остальные проверки сохранены: `/health/ready`, публичные проверки, gateway, указатель public,
runtime ACL прежних функций, банки и QR worker running и байт-в-байт, capabilities без изменений.

## Guards (проверяются тестами)

- точный SHA = checked HEAD, ветка запушена с тем же SHA, чистое дерево; полная зелёная CI ровно этого SHA и
  точного набора jobs из `ci.yml` кандидата;
- кандидат - потомок 8468e3ae; набор миграций = 001-040, 042-052 (включая спящую 051) + ровно 053-056;
  установленные миграции не изменены; в кандидате есть owner-скрипт и четыре файла грантов;
- живой baseline совпадает со всеми пинами; release lock отсутствует (иначе стоп);
- compose: только две строки флагов (выключены), иначе отказ; `enable` - только флаги + сеть, обратимо точно;
- ACL: после = до + ровно ожидаемые привилегии, без DELETE/TRUNCATE и без grant option; EXECUTE ровно 4 функций;
- владелец в транзакции: данные существующих таблиц не меняются, новые таблицы пусты (кроме двух строк
  диапазонов 053), единственная новая колонка существующей таблицы - `cloud_stop_commands.delivery_policy`
  (`DEFAULT 'ttl'`, 055), новая последовательность только identity `cloud_kitchen_outbox_sequence_seq`, роли и
  ACL других ролей не меняются, ни одной строки `branch_channel_modes`.

## Live baseline (read-only проверка 2026-10-11)

| Пин                                   | Значение                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| API                                   | `8468e3aed72c5355cf8b8d998df1de14ca55b03f`                                              |
| API image                             | `sha256:d7fa5d28932feb63d03fc68d7e15555057aeb9c71ea35df758023da53e2f3a75`               |
| compose 8468                          | `2620c8451cace0a8d6aae95e655726de78a0e8729aba83db520ae081e454c13b`                      |
| public                                | `bd60ab6b539d1b9a4432e271fd5d5a17bfe50cc2`                                              |
| gateway Caddyfile                     | `971bbd6ee3a951d6ab8a8b99e3f42eef013aa85c4640b9820fc93fde0637ac4a`                      |
| QR worker image                       | `sha256:ec2fd4c544652710c0a6f38955f1671e1491c8e31f9014e0f9dec23cede875ec`               |
| портал (source, release)              | `23fb39e152fccaa97a32e9bf179c2d89a50dc1d5`                                              |
| config портала                        | `398268265152decee767ab194c1c547339f38a14c0130d1dcecc993ff5123a41` (без `cloudKitchen`) |
| точка                                 | `7a6f6d98-395d-4462-b5e4-b0364a4a8ec1` (ТЦ Abay Plaza, `KIOSK_CHECKOUT_BRANCH_ID`)      |
| схема                                 | 052 (ledger 001-040, 042-052)                                                           |
| lock / сеть `pickchick-kitchen_cloud` | отсутствуют                                                                             |

Перед любым `--apply` пины пересчитать read-only: они устаревают при любом другом релизе.

## Ограничения и открытые зависимости

- Кандидат для выпуска - коммит общей ветки, содержащий S0-S4 (`5d808286`), `codex/cloud-kitchen-ipad`,
  `codex/cloud-kitchen-portal` (портал с `cloud.mjs` и `compose.cloud.yaml`) и этот профиль. `enable` отказывает,
  если в релизе портала нет `cloud.mjs`/`compose.cloud.yaml`. Формат блока `cloudKitchen` - финальный формат
  портала с привязкой экранов по cookie (`enabled`, `apiOrigin`, `branchId`; ключей в config нет, портал
  отвергает лишние поля).
- `--source-checkout` разрешён только без `--apply`: позволяет проверить частичного кандидата этим профилем;
  отсутствующие файлы показываются в `blockers`.
- QR worker (`dab3657b`) и Kaspi worker не обновляются: оплаченный облачный заказ, захваченный worker'ом,
  допускается на кухню при следующем опросе ленты (идемпотентно, `cloud-kitchen-s4.md`).
- Сеть подключается к API через compose (переживает пересоздание контейнера); после `disable` сеть остаётся
  пустой и внутренней.
- Фискальный чек облачных заказов не выбивается (ADR-0014, `deferred_no_receipt`); build 13 iPad - отдельная
  установка.

## Команды владельца

Выполнять из чистой рабочей копии ровно кандидата `<SHA>` (ветка `<BRANCH>`), `<RUN>` - зелёный запуск
`ci.yml` этого SHA. Общие пины:

```sh
PINS="--sha <SHA> --branch <BRANCH> --ci-run <RUN> \
  --expected-api-sha 8468e3aed72c5355cf8b8d998df1de14ca55b03f \
  --expected-public-sha bd60ab6b539d1b9a4432e271fd5d5a17bfe50cc2 \
  --expected-api-image sha256:d7fa5d28932feb63d03fc68d7e15555057aeb9c71ea35df758023da53e2f3a75 \
  --expected-compose-sha256 2620c8451cace0a8d6aae95e655726de78a0e8729aba83db520ae081e454c13b \
  --expected-gateway-sha256 971bbd6ee3a951d6ab8a8b99e3f42eef013aa85c4640b9820fc93fde0637ac4a \
  --expected-qr-worker-image sha256:ec2fd4c544652710c0a6f38955f1671e1491c8e31f9014e0f9dec23cede875ec \
  --expected-portal-sha 23fb39e152fccaa97a32e9bf179c2d89a50dc1d5 \
  --expected-portal-config-sha256 398268265152decee767ab194c1c547339f38a14c0130d1dcecc993ff5123a41 \
  --branch-id 7a6f6d98-395d-4462-b5e4-b0364a4a8ec1 \
  --ssh-key ~/.ssh/pickchick_staging_ed25519 \
  --backup-identity /Users/xaknazar/Documents/ChatGPT/PickChick/.local/vps/backup-identity.agekey"
R=infra/staging/release-cloud-kitchen.py
python3 $R prepare $PINS            # проверка
python3 $R prepare $PINS --apply    # образ, releases/<sha>, пакет портала
python3 $R apply $PINS              # проверка подготовленного
python3 $R apply $PINS --apply      # бэкап+restore, 053-056+гранты, API(+портал), флаги OFF
python3 $R stations $PINS --kitchen-setup infra/staging/cloud-kitchen-setup-abay-plaza.json   # проверка + stations-preview
python3 $R stations $PINS --kitchen-setup infra/staging/cloud-kitchen-setup-abay-plaza.json --apply
python3 $R enable $PINS             # проверка; печатает enabled_portal_config_sha256
python3 $R enable $PINS --expected-enabled-config-sha256 <sha из проверки> \
  --operator <имя> --reason "<причина>" --apply
python3 $R screen-code $PINS --role prep        # проверка (станции, имя)
python3 $R screen-code $PINS --role prep --operator <имя> --reason "<причина>" --apply
python3 $R screen-code $PINS --role assembly --operator <имя> --reason "<причина>" --apply
python3 $R screen-code $PINS --role display --operator <имя> --reason "<причина>" --apply
python3 $R mode-edge $PINS --operator <имя> --reason "<причина>" --apply   # быстрый возврат режима
python3 $R disable $PINS --operator <имя> --reason "<причина>" --apply
python3 $R rollback $PINS --apply   # только в выключенном состоянии
```

Маршрутизация облака по решению владельца 2026-10-11: одна станция цеха + сборка. Все товары облачных
заказов идут на цех `9ba8dc69-260c-482b-bed9-cab791b64595`, затем на сборку
`2cbc8ef3-359b-4cf0-bda8-28b82b727c93`. Когда касса снова будет доступна, точную маршрутизацию можно
скопировать с неё (полная форма `{branchId, stations, routing}`, те же id и те же имена станций).

Готовый файл: `infra/staging/cloud-kitchen-setup-abay-plaza.json`:

```json
{
  "branchId": "7a6f6d98-395d-4462-b5e4-b0364a4a8ec1",
  "stations": [
    { "id": "2cbc8ef3-359b-4cf0-bda8-28b82b727c93", "kind": "assembly", "name": "Сборка" },
    { "id": "9ba8dc69-260c-482b-bed9-cab791b64595", "kind": "prep", "name": "Кухня" }
  ],
  "routeAllProductsTo": "9ba8dc69-260c-482b-bed9-cab791b64595"
}
```

Имена `Кухня` и `Сборка` - отображаемые имена, выбранные по решению владельца (формат требует имя, а
имена станций кассы с VPS не подтверждены); они совпадают с именами из плана первой станции кассы
`scripts/local-pos-operator-plan.mjs`, но это не проверенный факт live-кассы. Команда владельца:

```sh
python3 $R stations $PINS --kitchen-setup infra/staging/cloud-kitchen-setup-abay-plaza.json          # проверка
python3 $R stations $PINS --kitchen-setup infra/staging/cloud-kitchen-setup-abay-plaza.json --apply
```

Имя станции после первой загрузки не меняется (повтор с другим именем - `CONFLICT`). Коды экранов
`screen-code` выдавать после `enable` (код живёт 10 минут) и сразу вводить на
`pickchick.kz/kitchen/prep`, `/kitchen/assembly`, `/display` -> «Код экрана».

Восстановление после ошибки с сохранённым lock: то же `disable`/`mode-edge`/`rollback` с `--owner-id <id>`.
После `enable` проверить вручную: тестовый заказ киоска в режиме `cloud` виден на prep/assembly/табло портала.
