# План выпуска после отдельного разрешения владельца

Подготовлено 21.10.2026. Это план, команды ниже не выполнялись на VPS и кассе.
PR: [262](https://github.com/xaaknazar/pickchick/pull/262).
Порядок соответствует [README, шаги 1-11](README.md#выпуск-безопасный-порядок).
Каждый шаг, merge, миграция, переключение сервиса и загрузка в Apple требуют
отдельного «да». Авто-merge выключен, squash не использовать.

## Подтверждённое исходное состояние

- Read-only SELECT в транзакции `BEGIN READ ONLY`, 21.10 10:55 Алматы:
  VPS заканчивается `058_cloud_device_center.sql`. Cloud 060 не применена;
  таблиц `device_identity_rotations` и `identity_otp_failures` нет.
- Рабочий edge с активной транспортной привязкой `2fd08ecf…`: ключ истекает
  **30.10.2026 19:06:41 Алматы**, осталось **9,34 дня**. Старое edge-устройство
  без активной привязки имеет истёкший ключ; его не продлевать автоматически.
- Исходная общая ветка `4dde5b34`; исходный release-кандидат `8d4edb74`.
  Перед выпуском нужен новый точный SHA после разрешённого merge и зелёная CI
  именно этого SHA. Старые CI, SHA и контрольные суммы не переиспользовать.
- Ветка переводов/push `094afaf6` опубликована отдельно. Её merge и PR, как и
  cart-lines, ждут разрешённого merge PR #262. Открытые резервы сохранены.

## Обязательные остановки до выпуска

1. Cloud 064/066/068 owner-скрипт требует полный точный журнал до 060, включая
   контрольные суммы. Сейчас он обязан отказать. **Готового отдельного
   охраняемого выпуска 058 -> 060 в этой ветке нет.** Его нужно подготовить,
   проверить на копии, получить отдельное разрешение. Общий мигратор production
   вместо него не запускать.
2. Для объединённого API/worker нет отдельного проверенного release-profile,
   который закрепляет фактическую live-базу и все изменения этого аудита.
   `release-kiosk-cart-lines.py` допускает только свой узкий diff и schema058;
   он не является установщиком этой ветки. Не расширять allowlist вслепую и
   не обходить guard ручным `docker compose up`.
3. `backup-native-service.mjs` принимает схемы только до 020. Для фактической
   схемы кассы 021 и последующих 022/023 нужен совместимый проверенный backup/
   restore-оператор. Новые SQL-инструменты 022/023 не заменяют установщик runtime,
   его блокировки, проверку CI/архива, остановку служб и проверку восстановления.
4. Сначала определить судьбу 059 из l10n: применить её до 060 в общем проверенном
   пакете либо согласованно перенумеровать будущую миграцию. Не выпускать 068,
   предполагая, что 059 потом можно незаметно добавить задним числом. Owner-скрипт
   вычисляет точную базу по файлам кандидата; порядок должен совпасть с журналом.
5. `204d318b` (закрытие месяца) требует явной приёмки финансового Mac. До неё
   API с этим коммитом не выпускать. `CUSTOMER_COMBO_REWARDS_ENABLED` остаётся
   выключенным до нового FulfillmentWorker и отдельного разрешения на акцию.

Таким образом, ниже приведены точные интерфейсы существующих команд. Шаги с
отсутствующим охраняемым оператором отмечены как заблокированные; выдуманной
команды `apply` для них нет. План не означает готовность всего выпуска.

## Подготовка каждого шага

В чистой отдельной рабочей копии с уже разрешённым объединением:

```sh
node scripts/project-sync.mjs check
node scripts/project-sync.mjs status
git status --porcelain
git rev-parse HEAD
git ls-remote origin refs/heads/codex/shared-development
corepack pnpm install --frozen-lockfile
```

Зафиксировать `SOURCE_SHA`, успешный Foundation run и полный список его jobs,
хеши пакетов, текущие образы/pointers, ledger с checksums, ACL, состав сервисов.
Получить требуемый резерв через claim после согласования с текущим владельцем,
затем штатный deployment lock. Обязательны зашифрованная копия и изолированный
restore с проверкой состава/данных. Не менять локальные env и секреты других задач.

Имена `CANDIDATE`, `CI_PROOF`, `API_SHA`, `PUBLIC_SHA`, `GATEWAY_SHA256` и остальные
переменные ниже обозначают проверенные значения будущего release manifest.
Это не значения по умолчанию. Их отсутствие останавливает подготовку.
Приватные env передаются файлами с ограниченными правами, содержимое не печатать.

## 1. Облачные миграции и права

До: отдельно разрешённый охраняемый выпуск 059/060 по согласованному порядку,
точное совпадение ledger с файлами кандидата, блокировка и backup/restore.
Флаг акции выключен. На изолированной копии сначала проверить owner-тесты.

В подготовленном контейнере кандидата с приватным owner env:

```sh
node --env-file=/run/pickchick/release-owner.env infra/staging/release-fixes-1019-owner.mjs inspect
# Отдельное разрешение на миграции, затем та же конфигурация и тот же SHA:
node --env-file=/run/pickchick/release-owner.env infra/staging/release-fixes-1019-owner.mjs deploy
```

Это точный CLI инструмента, не команда создания контейнера. Его запуск на VPS
должен входить в новый охраняемый release-profile из раздела остановок.
После: добавлены ровно 064/066/068; прежние checksums/данные не изменены;
права `identity_otp_failures` только для уже включённого customer auth;
права ротации 066 остаются отозванными до отдельного флага/provision.
Откат: транзакционная ошибка откатывает весь шаг; успешные аддитивные миграции
не удалять. Возврат runtime не равен восстановлению старого дампа поверх продаж.

## 2. API и provision

**Заблокирован до нового release-profile и приёмки 204d318b финансовым Mac.**
Команды старых release-скриптов с фиктивными пинами не использовать.
Новый оператор должен иметь `prepare/apply/rollback`, фиксировать source/image,
базу 058 ->060/068, compose/ACL, backup receipt и полный CI, менять только API.
Provision выполняется из того же образа и сохраняет согласованные флаги.

После: `/health/ready`200, приватные `pickchick_edge_identity_*`, long-poll/edge
метрики, анонимный отказ на защищённых маршрутах, прежние учётные записи,
снимки соседних контейнеров и права без неожиданных изменений. Счета не создавать.
Откат: guarded возврат точного прежнего образа/compose/ACL; новые колонки
сохраняются. Если появились данные, несовместимые со старым reader, остановить
автооткат и выпустить совместимое исправление.

## 3. Workers Kaspi

**Заблокирован до того же проверенного release-profile.** Отдельно разрешить
переключение worker счетов и QR worker на образ API из шага 2. Сохранить банковскую
сессию, account bindings, env и ключи. Не перезапускать мост входа ради выпуска.
После: heartbeat/состояние служб, отсутствие повторной отправки существующих
команд и сохранность очередей/журналов. Только чтение существующего состояния.
Откат: прежний совместимый образ конкретного worker под той же блокировкой;
не удалять pending/unknown попытки и не генерировать новые счета для проверки.

## 4. Портал кабинета

На VPS, от штатного оператора, после подготовки кандидата и точных текущих пинов:

```sh
python3 "$CANDIDATE/infra/backoffice-login/update.py" \
  --source-sha "$SOURCE_SHA" --expected-portal-sha "$PORTAL_SHA" \
  --expected-portal-image "$PORTAL_IMAGE" --expected-api-sha "$API_SHA" \
  --expected-public-sha "$PUBLIC_SHA" --expected-front-hash "$FRONT_SHA256" \
  --expected-gateway-hash "$GATEWAY_SHA256" --ci-proof "$CI_PROOF"
# После успешного inspect и отдельного разрешения повторить эту команду с --apply.
```

До: сохранить приватные учётные записи/настройки, согласовать ручные возвраты и
код сотрудника киоска; флаги сами не включать. После: авторизованное чтение,
видимость отказов/ключа/действий, анонимный отказ, без фиктивных записей/возвратов.
Откат: сохранённые прежний image и portal pointer через guard этого оператора.

## 5. Kitchen portal

```sh
python3 "$CANDIDATE/infra/kitchen-portal/update-deploy.py" \
  --package "$KITCHEN_PACKAGE" --expected-source-sha "$SOURCE_SHA" \
  --expected-public-release "$PUBLIC_SHA" --expected-api-release "$API_SHA" \
  --expected-gateway-sha256 "$GATEWAY_SHA256" \
  --expected-kitchen-release "$KITCHEN_SHA" --expected-config-sha256 "$KITCHEN_CONFIG_SHA256"
# После inspect и отдельного разрешения повторить с --apply.
```

До: пакет с manifest, текущий config/ключи и роли сохранены. После: health/source,
маршруты приготовления/сборки/выдачи, действующий вход, закрытые служебные пути;
реальные заказы не менять. Откат: прежний release/config через штатный guard.

## 6. Gateway

Два оператора выполняются последовательно; второй получает хеш после первого:

```sh
python3 "$CANDIDATE/infra/public-staging/client-ip-gateway.py" --check
python3 "$CANDIDATE/infra/public-staging/client-ip-gateway.py" \
  --source-sha "$SOURCE_SHA" --expected-api-sha "$API_SHA" \
  --expected-public-sha "$PUBLIC_SHA" --expected-gateway-sha256 "$GATEWAY_SHA256" \
  --ci-proof "$CI_PROOF"
# Отдельное разрешение: та же команда с --apply; затем снова --check.

python3 "$CANDIDATE/infra/public-staging/kiosk-staff-gateway.py" \
  --source-sha "$SOURCE_SHA" --source-config-sha256 "$KIOSK_STAFF_CONFIG_SHA256" \
  --expected-api-sha "$API_SHA" --expected-public-sha "$PUBLIC_SHA" \
  --expected-gateway-sha256 "$GATEWAY_AFTER_IP_SHA256" --ci-proof "$CI_PROOF"
# Отдельное разрешение: та же команда с --apply.
```

До: inspect проверяет существующие пути, сеть/proxy и точные пины. После:
client-IP invariant, закрытый `/internal/`, маршрут проверки кода сотрудника,
прежние backoffice/kitchen/mobile URLs. Не передавать настоящий код в тест.
Автооткат выполняется самим оператором; при неизвестном исходе сначала прочитать
receipt и текущие pointers, не запускать второй apply/rollback вслепую.

## 7. Watchdog

Сначала отдельное согласие на роль/установку. Env создаёт оператор в защищённом
файле; `WATCHDOG_TELEGRAM_ENABLED=false`. Из закреплённого образа:

```sh
set -o pipefail
docker run --rm -i --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true "pickchick-api:$SOURCE_SHA" \
  node infra/staging/watchdog-grants.mjs apply-sql \
  < /opt/pickchick-staging/secrets/watchdog.env \
  | docker exec -i pickchick-staging-cloud-db-1 psql -X -q -v ON_ERROR_STOP=1 -U postgres -d pickchick_cloud
python3 "$CANDIDATE/infra/staging/watchdog/run-watchdog.py" --collect-only
python3 "$CANDIDATE/infra/staging/watchdog/run-watchdog.py" --dry-run
```

Далее закрепить `watchdog/current` на кандидат и установить service/timer строго
по [ops-watchdog](../ops-watchdog.md#включение-оператор-по-шагам).
После: сутки shadow mode, роль с минимальными правами, отсутствие секретов в
выводе, корректные пороги. Telegram включается отдельным решением; сообщения
не отправлять автоматически в рамках подготовки. Откат:

```sh
sudo systemctl disable --now pickchick-watchdog.timer
# Снять права через watchdog-grants.mjs disable-sql, как в runbook.
```

## 8. Внешняя копия и PITR

Зависимости: владелец выбирает независимое хранилище, сроки хранения и права;
секреты задаёт приватно. Сначала копия, отдельно - PITR/перезапуск БД.

```sh
bash /opt/pickchick-staging/current/infra/staging/backup.sh
# Проверить backup-status/offsite-status и провести изолированный restore.
# Только после отдельного согласия на PITR:
python3 /opt/pickchick-staging/current/infra/staging/backup-offsite.py pitr-sql enable \
  | docker exec -i pickchick-staging-cloud-db-1 psql -X -q -v ON_ERROR_STOP=1 -U postgres -d pickchick_cloud
```

Для pipeline включить `set -o pipefail`. Перезапуск cloud-db, base-backup и WAL
timer выполнять отдельным согласованным этапом из [backup-offsite](../backup-offsite.md).
После: проверяемый объект во внешнем хранилище, контрольные суммы, restore/RPO/RTO,
проверка WAL при PITR. Откат: `BACKUP_OFFSITE_ENABLED=false`; `pitr-sql disable`
по runbook, без удаления уже сохранённых копий.

## 9. Касса Windows

**Блокер:** сначала совместимые backup/restore и установщик для фактической
схемы кассы. Старые schema020/узкие worker-only инструменты не обходить.
Отдельное разрешение на ночное окно, остановку служб и миграции.

На Mac после публикации чистого SHA и полного CI можно подготовить пакет:

```sh
python3 scripts/build-windows-edge-runtime.py --output "$PRIVATE_OUTPUT/pickchick-edge"
python3 -m unittest discover -s tests/operations -p 'test_windows_edge_runtime.py'
```

В elevated Windows PowerShell, после проверенного backup/restore, остановки
писателей и установки reviewed tools; `$Node`, `$ToolsRoot`, `$AppRoot`,
`$BranchId`, `$OwnerEnv` берутся из защищённого release manifest:

```powershell
& $Node "--env-file=$OwnerEnv" "$Candidate\infra\windows\display-numbers-upgrade-db.mjs" inspect $ToolsRoot $AppRoot $BranchId
# Разрешение на021 ->022:
& $Node "--env-file=$OwnerEnv" "$Candidate\infra\windows\display-numbers-upgrade-db.mjs" apply $ToolsRoot $AppRoot $BranchId
& $Node "--env-file=$OwnerEnv" "$Candidate\infra\windows\restore-fence-upgrade-db.mjs" inspect $ToolsRoot $AppRoot $BranchId
# Отдельное разрешение на022 ->023:
& $Node "--env-file=$OwnerEnv" "$Candidate\infra\windows\restore-fence-upgrade-db.mjs" apply $ToolsRoot $AppRoot $BranchId
```

Затем guarded-переключение edge runtime, FulfillmentWorker и POS (новый оператор
ещё требуется). После: ledger022/023, epoch только `initial`, права fence,
running/readiness, heartbeat/menu/доставка; нулевые и большие заказы проверять
на изолированном стенде, реальные счета не создавать. Акцию ещё не включать.
Откат: совместимый старый runtime на аддитивной схеме; сначала проверить формат
данных/нулевых заказов. POS перед возвратом старой версии требует 4-значный PIN
и удаления нового config-ключа `pinLength` штатным оператором. Базу поверх
новых заказов не восстанавливать.

## 10. Киоск

До: TLS `api.pickchick.kz`, API/маршрут staff PIN, адрес фотопринтера и флаги
проверены; выбрать свободный build в Apple, сохранить Bundle ID/version,
отдельный commit и CI. Секретный PIN вводит владелец вне переписки.

```sh
python3 scripts/mobile/ios_release.py doctor --app kiosk --release "$KIOSK_RELEASE"
python3 scripts/mobile/ios_release.py archive --app kiosk --feature-profile kiosk-production \
  --kiosk-photo-url "$KIOSK_PHOTO_HTTPS" --release "$KIOSK_RELEASE"
python3 scripts/mobile/ios_release.py export --app kiosk --release "$KIOSK_RELEASE"
# Загрузка только по отдельному разрешению:
python3 scripts/mobile/ios_release.py upload --app kiosk --release "$KIOSK_RELEASE" --asc-app-id 6809407135
```

Параметры существующей подписи передаются приватными путями по kiosk-testflight
runbook. После: codesign, Bundle ID/build, встроенный JS/API/profile, фактическая
обработка Apple и существующая внутренняя группа; физический iPad, AppLock,
демо/PIN/меню/выход без настоящего QR. Откат: доступная прежняя сборка через
штатный канал; данные не удалять. Внешние группы/публичные ссылки не создавать.

## 11. Мобильное приложение

После разрешённой интеграции l10n/cart-lines и их CI. Сначала storefront staging;
production - отдельное решение после домена, юридических ссылок и поддержки.

```sh
python3 scripts/mobile/ios_release.py doctor --app mobile --release "$MOBILE_RELEASE"
python3 scripts/mobile/ios_release.py archive --app mobile --feature-profile storefront --release "$MOBILE_RELEASE"
python3 scripts/mobile/ios_release.py export --app mobile --release "$MOBILE_RELEASE"
# Отдельное разрешение на загрузку:
python3 scripts/mobile/ios_release.py upload --app mobile --release "$MOBILE_RELEASE" --asc-app-id 6809208492
```

После: подпись/JS/флаги, подтверждённая доступность PickChick Internal, физический
iPhone: выход из ожидания оплаты, восстановление, отказ -> корзина,
KITCHEN_OFFLINE, необязательный пол, игры, kk/ru/en. APNs отдельно проверяется
после настройки и согласия на push. Реальная оплата только по отдельному «да».
Откат: прежняя доступная TestFlight-сборка; App Store-релиз требует отдельного
решения, простой возврат старого App Store бинарника автоматически не обещается.

## Ручное продление ключа: подготовлено, не запущено

Осталось меньше 10 дней; облачная ротация 066 пока недоступна. Подходит вариант B
из [edge-identity-rotation](../edge-identity-rotation.md). Нельзя просто поменять
`expires_at`: это обходит штатный выпуск ключа и аудит.

1. Получить отдельное разрешение на ручную ротацию и короткую остановку только
   транспортных служб; занять `@windows/cashier` и согласованный подраздел VPS.
2. Сверить UUID с активной привязкой на чтение. Проверить ожидаемый SSH host key,
   текущие пути identity и закрытый ACL. Пароли/ключи не печатать.
3. Остановить `PickChickFulfillmentWorker`, `PickChickMenuSyncWorker`,
   `PickChickDeviceAccessWorker`, существующий `PickChickPosSync`. Не удалять
   данные/приложение кассы. Старый ключ действует до самой команды ротации.
4. На доверенной отдельной рабочей копии через приватный туннель/owner env:

```sh
umask 077
node --env-file="$PRIVATE_ROTATION_ENV" scripts/device-setup.mjs "$CASHIER_DEVICE_UUID" --rotate
```

Файл `.local/edge-identity.json` остаётся приватным (0600). Скрипт выводит только
метаданные, не ключ. Старый ключ после команды недействителен, поэтому до её
выполнения доставка файла и окно обслуживания должны быть готовы.

5. Передать файл по проверенному SSH в приватный временный файл на кассе,
   применить `native-identity-acl.ps1 -Path <tmp>`, заменить identity
   FulfillmentWorker и существующую копию PosSync по runbook. Затем запустить
   службы. Реальные токены не передавать аргументами команд.
6. Проверить новый срок около 30 дней в БД, heartbeat/«касса на связи», ACL и
   доступ служб. Удалить временные приватные копии только после подтверждения.
7. При сбое сохранения/переноса после ротации старый ключ не восстанавливать:
   безопасно завершить перенос нового либо повторить штатный `--rotate` под
   контролем оператора. Это ручное восстановление связи, не откат старого секрета.

Ни одна команда этого раздела не выполнялась. Ожидается отдельное решение владельца.
