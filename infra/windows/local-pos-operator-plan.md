# План подключения кассы и кухни

`scripts/local-pos-operator-plan.mjs` формирует приватные входные файлы штатных
operator CLI. Он не подключается к PostgreSQL, не создаёт сотрудников/сессии,
не меняет меню, environment, службы, приём заказов или режим работы. Паролей,
токенов и ключей в его входе и выводе нет. В stdout выводятся только результат,
признак повторного запуска и количество маршрутов.

До применения плана нужны установленная schema014 и завершённый переход каталога
v1 → v2. Для подключения cloud обязательна проверенная привязка организации/устройства.
Для разрешённого владельцем локального теста без cloud допустимы однажды назначенные
идентификаторы из защищённой записи пилота. Запись явно указывает `local_test_only`,
отсутствие cloud-регистрации и запрет транспорта. Эти идентификаторы не означают
регистрацию production-точки; перед подключением облака нужно отдельно согласовать
регистрацию/перенос тестовых данных и привязки. Генератор проверяет
записи каталога; фактическое состояние базы проверяют последующие owner-команды.
Запись `plan_only_no_database_changes` не является подтверждением установки.

## Вход и сохранение идентификаторов

В защищённом NTFS-каталоге оператора создать JSON с точными полями:

```json
{
  "format": "pickchick-local-pos-operator-input-v1",
  "confirmation": "generate_private_unpaid_service_plan",
  "branch_id": "<UUID установленной точки>",
  "cashier_staff_id": "<UUID существующего кассира>",
  "cashier_terminal_id": "<UUID существующей кассы>",
  "organization_id": "<проверенная cloud organization UUID>",
  "device_id": "<проверенная cloud edge device UUID>",
  "cloud_producer_id": "<cloud fulfillment producer UUID>",
  "expected_ordering_version": 1
}
```

Версия приёма берётся из текущей закрытой точки. UUID не берутся из примера и
не создаются заново при повторной настройке. Имя роли manager здесь означает
локального `shift_manager`; оно не выдаёт доступ управляющего в cloud бэк-офисе.

Запуск из нового operator runtime; `$Node`, `$OwnerEnv`, `$PlanDir` - локальные
пути оператора, последний каталог уже должен иметь приватный защищённый ACL:

```powershell
& $Node scripts/local-pos-operator-plan.mjs $InputJson $OriginalDraftRecord $CompletedUpgradeRecord $PlanDir
```

Первый record - неизменённые байты `local-pos-draft-record.json` из исходной
установки. Второй - завершённый `local-pos-catalog-upgrade-v2-record.json`.
Проверяются хеши обоих source-каталогов, SHA оригинальной записи, оба menu checksum,
время/UUID выпусков, 24 товара, 23 фото, 31 группа допов и сохранённый cashier.
Snapshot восстанавливается штатным алгоритмом каталога v2; ручной ввод UUID блюд
не требуется. Метка `content_reviewed=false` сохраняется как историческое свойство
каталога, а не превращается в утверждение о проверке меню.

В `$PlanDir` остаются:

- `local-pos-operator-plan.json` - постоянные новые UUID, исходные хеши и карта блюд;
- `staff-cashier.json` - прежние staff/terminal UUID и роль кассира;
- `staff-manager.json` - новый staff UUID управляющего на существующем терминале кассы;
- `staff-kitchen.json` - новые staff/terminal UUID кухонного моноблока;
- `local-pos-service.json` - вход подготовки станций и отдельного включения режима;
- `edge-pos-sync.json` - organization/branch/device для локальной привязки POS sync.

Повтор с теми же входными байтами сохраняет все UUID. Пропавший производный файл
восстанавливается из записи; отличающиеся существующие файлы не перезаписываются.
Неполный/изменённый record требует проверки оператором; не удалять его для повтора.
На Unix требуются приватные права; на Windows используются существующие проверки
NTFS, владельца и ACL. Новая проверка не ослабляет правила хранения staff credentials.

## Последовательность применения

После проверки upgrade014 и каталога выполнить создание двух новых сотрудников
штатным CLI с приватной owner-конфигурацией:

```powershell
& $Node --env-file=$OwnerEnv scripts/staff-setup.mjs (Join-Path $PlanDir 'staff-manager.json')
& $Node --env-file=$OwnerEnv scripts/staff-setup.mjs (Join-Path $PlanDir 'staff-kitchen.json')
```

CLI сохраняет bootstrap-сессии в `.local/staff-<staffUUID>.json` своего operator
runtime. Уже существующие сессии не перевыпускаются без явного `--renew`; при
восстановлении после сбоя применять его только к тому же staff/terminal/role.
Новая генерация плана сама не является поводом для перевыпуска сессий.
Кассир сохраняется; если его bootstrap истёк, использовать `staff-cashier.json`
с явным `--renew`. Затем отдельно задать личные пароли скрытым двойным вводом через
[штатную password-команду](native-staff-login.md). Сессии и access window штатно
ограничены 8 часами; готовить станции в действующем окне либо обновить доступ.

Проверить в сервисной конфигурации тот же `EDGE_DEVICE_ID`, установить нужные
runtime grants с `--fulfillment` и отдельно включить `EDGE_FULFILLMENT_ENABLED=true`
для серверного процесса. Это operator-операции доставки, генератор их не выполняет.
Платёжные/фискальные адаптеры, cloud-origin fulfillment transport и меню sync этим
планом не включаются.

```powershell
& $Node --env-file=$OwnerEnv scripts/local-pos-service.mjs prepare (Join-Path $PlanDir 'local-pos-service.json')
& $Node --env-file=$OwnerEnv scripts/pos-order-sync-setup.mjs edge (Join-Path $PlanDir 'edge-pos-sync.json')
```

`prepare` атомарно создаёт «Кухня», «Сборка», маршруты и оба grants кухонному
сотруднику, сохраняя закрытый приём и `payment_required`. Все 6 напитков, оба соуса
и порция коулслоу идут на сборку; остальные 15 товаров - на приготовление.
Комбо готовится как исходная строка с её допами и затем собирается; этот этап не
разбивает комбо на рецептурные компоненты и не делает складского списания.
Перед физической приёмкой оператор сверяет эту конкретную карту с работой точки.

`pos-order-sync-setup edge` сохраняет существующий local POS producer из
`local_order_streams` (создаёт его только если ещё отсутствует). Возвращённый
`producerId` привязывается на cloud к тому же organization/branch/device и
используется обоими наблюдательными потоками POS/кухни. Это **другой** UUID, чем
`cloud_producer_id` во входе fulfillment. Генератор не придумывает local producer
и не формирует cloud JSON до подтверждённого результата edge setup. SQL binding
сам по себе не запускает worker и не меняет его environment/доступ к cloud.

В публичный config кухонного клиента оператор переносит
`ids.kitchen_terminal_id` из plan record как `terminalId`; TLS-сертификат и адрес
даёт отдельная установка LAN. Кухня входит своим паролем и выбирает обе станции.

Только отдельным согласованным шагом после подготовки и проверки сервисного
флага выполнить существующую команду:

```powershell
& $Node --env-file=$OwnerEnv scripts/local-pos-service.mjs enable (Join-Path $PlanDir 'local-pos-service.json')
```

Она требует тот же неизменённый setup и версию приёма. Генератор эту команду не
запускает. После включения проверяются открытие кассовой смены и один реальный
операционный заказ: касса → кухня → сборка → выдача. Оплата/чек остаются
`not_started`/`not_requested`; приёмка не утверждает работу банка или ККМ.

Проверены pure reconstruction/binding guards и реальный файловый CLI: сохранение
UUID, повтор, восстановление отсутствующего артефакта, отказ при изменении
источника/кассира/файла/ACL, отсутствие подключения к БД и вывода секретных значений.
Генерация и применение на физическом Windows этим тестом не подтверждены.
