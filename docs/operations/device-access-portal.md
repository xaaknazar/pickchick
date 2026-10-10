# Включение доступа устройств на портале кухни

Это продолжение [Devices runbook](device-access.md). Наличие исходников, успешные
тесты и сохранённые планы не означают, что функция установлена. На момент добавления
профиля новые Devices-флаги на живом портале не включались.

`infra/kitchen-portal/activate-device-access.py` запускается **на VPS** от текущего
оператора `pickchick-ops` (UID1000). Без `--apply` он только проверяет состояние.
Он не выпускает новую версию, не создаёт устройства, коды, сессии сотрудников или
платежи. Использует общий `.market-release.lock`. При неуспехе оставляет его и
приватные доказательства; повторное включение той же операции запрещено.

## Последовательность

1. Выпустить единый кандидат через cloud050→051 профиль. Полная Foundation CI
   должна относиться к этому же SHA. API/бэкофис и мобильные изменения входят в один
   проверенный кандидат; банковские контейнеры сохраняются.
2. Выполнить Windows019→020, Switch/Verify, обновить KitchenLink и установить
   отдельный worker в состоянии Manual/Stopped. Получить actual prepared-v1.
3. Включить облачный Devices-флаг штатным cloud-профилем. Передать фактический
   `enabled.json` Windows-оператору, выполнить Activate/Ready, сохранить actual
   `pickchick-device-access-ready-v1`. Prepared-v1 для портала недостаточно.
4. Собрать kitchen bundle и `infra/kitchen-portal/package.mjs` из **чистого того же
   SHA**, передать пакет защищённо и обновить существующий портал штатным
   `update-deploy.py`: сначала проверка, затем `--apply`. Сохранить его deployment
   result, SHA256 `kitchen-package.json`, фактический hash private config и актуальные
   API/public/gateway pins. Этот шаг сохраняет конфигурацию и старый режим входа;
   first-install `remote-deploy.py` здесь не использовать.
5. Выполнить ниже Plan→Enable. Скрипт повторно проверит установленный пакет целиком,
   runtime source/API image/flag, CI11/11, cloud+Windows proof (не старше6часов),
   source hashes миграции020/worker/четырёх файлов KitchenLink, живое соединение
   портала с edge, gateway и соседние контейнеры.
6. После успеха проверить вход **владельцем на реальных экранах**: выдать код в
   бэкофисе, привязать кухню/сборку/табло, проверить роль и режим. Сброс kitchen
   выполняется отдельным одноразовым кодом; новый пароль вводится владельцем только
   на защищённой странице устройства. Эта проверка не имитируется оператором.

## Plan и Enable

Все переменные заполняются из фактических доказательств предыдущих шагов.
Оператору нужны миграция020 и worker для сверки Ready proof: стандартный kitchen
пакет и API-архив не являются его исполнимым комплектом. Собрать **отдельный**
operator bundle на Mac из точного опубликованного commit:

```bash
umask 077
python3 infra/kitchen-portal/package-device-activation.py --sha "$SHA" \
  --output "$PRIVATE_DIR/portal-operator.tar.gz" \
  > "$PRIVATE_DIR/portal-operator-proof.json"
```

Builder берёт `git show <full SHA>:<path>`, а не рабочие файлы. В архиве ровно7
файлов: activation,3 закреплённых stock helpers, миграция020, mailbox worker и
`device-access-operator.json` с source SHA и всеми6 контрольными суммами. Повторно
существующий выходной архив не перезаписывается. Передать через уже доверенный
SSH/SCP с `BatchMode=yes`, `StrictHostKeyChecking=yes`: архив, его proof,
CI/cloud-enabled/Windows-ready proofs; приватные файлы должны иметь0600 и владельца
`pickchick-ops`. Ключи и конфигурацию портала с VPS не копировать.

На VPS сверить SHA256 архива с `sha256` из локально просмотренного
`portal-operator-proof.json`, затем распаковать в **новый** защищённый каталог:

```bash
umask 077
printf '%s  %s\n' "$ARCHIVE_SHA256" "$REMOTE_ARCHIVE" | sha256sum --check -
SOURCE_TREE="/opt/pickchick-staging/kitchen-portal/operator-bundles/$SHA"
mkdir -p -m 700 /opt/pickchick-staging/kitchen-portal/operator-bundles
mkdir -m 700 "$SOURCE_TREE"
tar --extract --gzip --file "$REMOTE_ARCHIVE" --directory "$SOURCE_TREE" --no-same-owner
```

Дальнейшие команды выполняются в bash **на VPS** из этого комплекта. Перед
обращением к Docker activation проверит manifest/source/все файлы, включая собственный
код и pinned imports. Публичный kitchen-пакет и operator bundle не содержат секретов;
операционные proofs и резервные config остаются приватными.

```bash
umask 077
OPERATOR="$SOURCE_TREE/infra/kitchen-portal/activate-device-access.py"
PINS=(
  --expected-source-sha "$SHA"
  --expected-public-release "$PUBLIC_RELEASE"
  --expected-api-release "$API_RELEASE"
  --expected-api-image "$API_IMAGE"
  --expected-gateway-sha256 "$GATEWAY_SHA256"
  --expected-kitchen-release "$KITCHEN_RELEASE"
  --expected-config-sha256 "$CONFIG_SHA256"
  --expected-manifest-sha256 "$KITCHEN_MANIFEST_SHA256"
  --branch-id "$BRANCH_ID"
  --edge-device-id "$EDGE_DEVICE_ID"
  --ci-proof "$CI_PROOF"
)
OPERATION_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')
python3 "$OPERATOR" enable "${PINS[@]}" --operation-id "$OPERATION_ID" \
  --cloud-proof "$CLOUD_ENABLED_PROOF" --windows-proof "$WINDOWS_READY_PROOF" \
  > "$PRIVATE_DIR/portal-enable-plan.json"
```

Просмотреть план: в нём только SHA, идентификаторы контейнеров/ветки/edge и пути,
без ключа, пароля или кодов. После проверки выполнить **один раз**:

```bash
python3 "$OPERATOR" enable "${PINS[@]}" --operation-id "$OPERATION_ID" \
  --cloud-proof "$CLOUD_ENABLED_PROOF" --windows-proof "$WINDOWS_READY_PROOF" \
  --plan "$PRIVATE_DIR/portal-enable-plan.json" --apply \
  > "$PRIVATE_DIR/portal-enabled.json"
```

Оператор создаёт protected backup config, кандидат config и отдельную копию для
проверки восстановления. Все байты сверяются до остановки портала. Затем останавливает
**только существующий container ID портала**, меняет только `terminalAccess` с false
(либо отсутствующего поля) на true, сохраняя inode bind-mounted файла, и запускает
тот же контейнер. Проверяет hash внутри контейнера, source/режим трёх публичных
конфигураций и неизменность всех остальных контейнеров/указателей. Ключ, legacy
terminal IDs, метка точки и прочие поля сохраняются. Портал кратковременно недоступен
во время stop/start; локальный edge и кассовые службы оператор не останавливает.

Результат `pickchick-device-access-portal-v1` содержит
`pairing_or_password_test_performed=false`: это факт переключения и проверок,
а не выдача/использование кода и не приёмка входа персоналом.

## Отдельное отключение

Отключение не удаляет registry, роли, пароль, PIN или ключи устройств и не выключает
API/worker. Оно возвращает портал к сохранённым legacy terminal IDs и прежнему
входу сотрудников. Выданные коды/доступы отзываются штатными отдельными действиями.

Взять **новый** operation UUID и свежие pins, в том числе текущий config SHA256 из
успешного результата. Повторить Plan→Apply с mode `disable`. Cloud/Windows proofs
для отключения не нужны; full CI, exact source/пакет, baseline и config CAS обязательны:

```bash
python3 "$OPERATOR" disable "${PINS[@]}" --operation-id "$DISABLE_ID" \
  > "$PRIVATE_DIR/portal-disable-plan.json"
python3 "$OPERATOR" disable "${PINS[@]}" --operation-id "$DISABLE_ID" \
  --plan "$PRIVATE_DIR/portal-disable-plan.json" --apply \
  > "$PRIVATE_DIR/portal-disabled.json"
```

## Неопределённый результат и восстановление

Не повторять `enable --apply`, не удалять lock и не менять config наугад. Состояние
операции сохранено под
`/opt/pickchick-staging/kitchen-portal/device-access/<operation UUID>/`: backup,
candidate, restore-drill и exclusive attempt. Эти файлы содержат приватный ключ,
имеют0600 и **не публикуются** в GitHub/чат. В GitHub сохраняются только результаты,
SHA и факты без содержимого приватных файлов.

После чтения фактического состояния взять текущий config SHA256, исходный UUID и
точный owner ID из retained lock. `restore` допускает только прежние либо полные
кандидатные байты, исходный inode, тот же контейнер/image, source и неизменных
соседей. Это отдельная проверяемая операция возврата исходного config:

```bash
python3 "$OPERATOR" restore "${PINS[@]}" --operation-id "$OPERATION_ID" \
  --owner-id "$RETAINED_OWNER_ID"
python3 "$OPERATOR" restore "${PINS[@]}" --operation-id "$OPERATION_ID" \
  --owner-id "$RETAINED_OWNER_ID" --apply \
  > "$PRIVATE_DIR/portal-restored.json"
```

При неизвестных/частично записанных байтах или чужой смене контейнера/соседей
restore откажется. Нужен отдельный разбор retained evidence, а не обход CAS.
Никакой live DB restore, повтор migration, вход в банк или ротация ключа для этого
профиля не выполняются.

## Проверки исходников

`python3 -m unittest discover -s tests/kitchen-portal -p test_device_access_activation.py -v`
проверяет exact CI/readiness, сохранность JSON, реальные0600 файлы и inode CAS,
backup/restore до stop, read-only default, retained lock/no replay, явное восстановление,
отдельное отключение и ограничение команд одним контейнером портала. Отдельный
packaging fixture создаёт настоящий Git commit, собирает архив, распаковывает его
без репозитория и исполняет imports/Ready verification; отсутствие worker
отклоняется. Docker/Windows и пользовательский вход этим unit-прогоном не подтверждаются.
