# Устройства: подключение кухни, сборки и табло

Исходники реализуют новую процедуру. Этот документ не является подтверждением её
установки на VPS или Windows: установка, exact SHA/CI, backup/restore и приёмка
фиксируются отдельным протоколом после согласованного выпуска.

Завершающее включение портала выполняется по
[отдельному guarded Plan/Enable/Disable/Restore профилю](device-access-portal.md),
после реальных cloud-enabled и Windows ready доказательств того же SHA.

## Для управляющего

1. Откройте свою точку в бэкофисе, раздел «Устройства».
2. Нажмите «Подключить экран», выберите приготовление, сборку либо табло/LED,
   укажите название и причину. Код действует 10 минут и показывается только сейчас.
3. Дождитесь состояния «Введите код на экране»: касса должна получить команду.
4. На соответствующем экране введите полный код. Для табло вход сотрудника не нужен.
   На приготовлении и сборке войдите под кухонным сотрудником; назначенные станции
   и допустимые действия остаются обязательными.
5. «Новый код» требует точного названия и отключает прежнюю привязку после получения
   команды кассой. «Отключить» также ждёт кассу; история хранит реальные подтверждения.

При забытом общем пароле нажмите «Восстановить пароль кухни», подтвердите `kitchen`
и причину. Дождитесь готовности кода на кассе. На уже подключённой кухне или сборке
нажмите «Забыли пароль?», введите код и новый пароль от 12 до 128 символов дважды.
Все прежние входы этого сотрудника завершатся. Пароль не показывается в бэкофисе,
личные PIN кассы не меняются. Действующий reset-код нельзя выпускать повторно до
использования/истечения: при потере ответа сначала проверьте журнал. Если ответ
на сохранение пароля потерян, сначала попробуйте войти с новым паролем.

Табло/LED не имеет этой формы и не получает полномочий сотрудника. Существующие
киоски iPad показаны в списке, их привязка и платёжные ключи сохраняются. Перенос
основной кассы не выполняется кнопкой «Отключить».

## Архитектура и конфигурация

См. [ADR 0013](../architecture/adr/0013-device-access.md).

- Cloud: `BACKOFFICE_DEVICE_ACCESS_ENABLED=true` вместе с существующим
  `BACKOFFICE_ENABLED=true`, миграция051 и `deviceRegistryGrants`. Обычная baseline
  авторизация edge (SELECT device_credentials и row-lock privileges) сохраняется.
- Edge: миграция020 **до нового runtime**. `terminalAccessGrants` различает runtime и
  новый worker. `EDGE_DEVICE_ACCESS_ENABLED=true` включает новые HTTP маршруты.
- Worker: отдельный `native-device-access-worker.mjs`, отдельная PostgreSQL роль
  `pickchick_device_access_sync`, `DEVICE_ACCESS_WORKER_ENABLED=true`, существующие
  защищённые device-identity.json и loopback tunnel `http://127.0.0.1:43100`.
  Нельзя запускать его под owner или ролью платежей. Публичный порт не добавляется.
- Cloud портал: защищённая конфигурация `terminalAccess: true` после обновления
  gateway и Windows KitchenLink; существующий private portal key остаётся прежним.
  HTML/JS ответы не содержат terminal key. Cookie каждого prep/assembly/display
  ограничена своим path. Вход через портал при отсутствии WAN недоступен.
- Native Kitchen Desktop: в config.json `terminalMode: "prep" | "assembly" | "display"`.
  Используется существующий pinned LAN TLS либо loopback edge. Renderer origin/порт
  не меняются, журнал операций не удаляется. Ключ cookie автоматически создаётся
  только для opt-in режима через OS safeStorage, не хранится открытым в config.json.
  Отсутствие OS encryption останавливает запуск; insecure fallback нет.
- Клиент без нового opt-in сохраняет прежнюю схему доступа. Это не повод добавлять
  новые managed терминалы в legacy-конфигурацию.

## Порядок безопасного выпуска

Переход Windows схемы019 на020 реализован отдельным профилем
`infra/windows/update-native-device-access.ps1`; его установка ещё не выполнена. Существующий `update-native-unified-menu.ps1` закреплён на другом
переходе; нельзя подменять его доказательства или отключать проверки для этой задачи.
Новый профиль до живой установки обязан сохранить следующие шаги:

1. Чистый опубликованный общий SHA, полная зелёная CI; отдельные резервы VPS/Windows,
   штатная release lock, фактический baseline runtime/schema/config/identity hashes.
2. Cloud encrypted backup и restore drill. Применение051 владельцем БД, необходимые
   ACL, новый API с зарегистрированными DeviceRegistryController и
   DeviceAccessTransportController. Feature flag пока выключен. Публичный gateway
   разрешает только новые BO routes, internal exchange остаётся приватным.
3. Windows свежий backup019 + восстановление **в отдельную тестовую БД**. Согласованная
   остановка edge/зависимых служб, применение020, grant profiles и readiness, запуск
   candidate runtime. Postgres/tunnel и существующие order/payment данные сохраняются.
4. Новый worker устанавливается отдельной службой LocalService из exact runtime.
   Его private env/ACL, image/script hashes, device/branch identity и mailbox scope
   проверяются до запуска. Нельзя переиспользовать финансовую роль или пароль БД.
5. Обновить KitchenLink/портал и при необходимости native desktop пакет. В пакеты
   включены canonical terminal-cookie.mjs и новые компоненты/CSS. Локальная история
   заказов, POS PIN, iPad credentials и пароль `kitchen` на этом шаге не изменяются.
6. Включать cloud flag, edge flag, worker и portal opt-in по одному с записью фактов
   health/ACK. Проверить синтетический экран, display read-only, неверный/истёкший код,
   scoped revoke и режим без WAN на native клиенте. Не создавать заказы/оплаты.
7. Только после готовности экрана управляющий явно выпускает реальный reset ticket,
   сам вводит новый пароль на кухне, проверяет вход приготовления и сборки. Секреты
   не сохраняются в чате, снимках или release evidence.

При ошибке код не выпускается автоматически повторно. Cloud command остаётся
наблюдаемым. Отключение флагов в новом runtime сохраняет проверку managed identity.
Rollback к старым бинарным файлам до020 допустим только после отдельного guarded
деактивирования registry-owned local_terminals и отзыва их staff sessions. Legacy
терминалы не трогать. Down-migration и восстановление production БД поверх живых
заказов не являются штатным rollback.

## Проверки разработки

- `pnpm --filter @pickchick/backoffice-core... build` и `pnpm --filter @pickchick/api... build`.
- `node --env-file=.env.example --test --test-concurrency=1 tests/integration/device-access.test.mjs`:
  реальные одноразовые PostgreSQL схемы, включая restricted role и HTTP+proxy.
- `tests/integration/terminal-access.test.mjs`, существующие kitchen HTTP и staff-password
  сценарии: scope/mode/generation/replay/rate limits, atomic password reset и PIN preservation.
- `node --test tests/unit/device-access.test.mjs tests/backoffice/devices-model.test.mjs
tests/kitchen/terminal-cookie.test.mjs`.
- `node --test apps/kitchen/tests/gateway.test.mjs apps/kitchen/tests/tls-password-gateway.test.mjs`.
- `node apps/kitchen-desktop/scripts/build.mjs` и desktop security tests; release build
  требует clean commit. Нативная установленная Windows сборка этим не подтверждается.
- `pnpm --filter @pickchick/operations-storybook build:storybook`; локально
  `pnpm --filter @pickchick/operations-storybook storybook` (6011).
- `tests/backoffice/devices-browser.py URL OUTPUT`: 24 story viewport проверки и
  форма password reset. Только синтетические данные. Контент Storybook не вызывает банк.

На 2026-10-09 локально: совместный PostgreSQL/HTTP прогон cloud Devices, edge
terminal/reset и существующих staff-password сценариев прошёл 28/28; отдельный
прогон прежних kitchen HTTP/runtime сценариев и 6 packaging проверок тоже прошёл.
Все unit-тесты 224/224, сборки API/edge/бэкофиса/кухни, contracts check и frozen install
прошли. Storybook собран, 24 viewport + password form и axe WCAG 2.1 AA прошли;
detector Impeccable новых компонентов не обнаружил механических нарушений.
Независимое замечание о managed терминале без registry-строки закрыто с regression:
такой терминал не получает legacy-доступ даже при выключенном feature flag.
Live deployment и пользовательская приёмка пока не заявлены. CI будет привязана
к итоговому опубликованному коммиту.

## Cloud оператор schema050 -> 051

`infra/staging/release-device-access.py` принимает точные SHA API/public, image ID,
хеши compose/gateway из просмотренного preflight. API baseline должен происходить
от `cf25cb9` и иметь ровно schema050; это позволяет сначала выпустить мобильное
исправление, затем единый candidate с обоими изменениями. Все прежние API флаги,
включая `CUSTOMER_CHECKOUT_HEAD_GUARD`, сохраняются. Включение нового флага отдельно.

```sh
# PINS - одни и те же просмотренные --expected-api-sha, --expected-public-sha,
# --expected-api-image, --expected-compose-sha256 и --expected-gateway-sha256.
# SOURCE - чистый опубликованный общий --sha, --branch и --branch-id.
python3 infra/staging/release-device-access.py prepare $SOURCE $PINS --ssh-key "$SSH_KEY" --ci-proof "$CI_PROOF"
python3 infra/staging/release-device-access.py prepare $SOURCE $PINS --ssh-key "$SSH_KEY" --ci-proof "$CI_PROOF" --apply
python3 infra/staging/release-device-access.py apply $SOURCE $PINS --ssh-key "$SSH_KEY" --ci-proof "$CI_PROOF" --backup-identity "$BACKUP_KEY"
python3 infra/staging/release-device-access.py apply $SOURCE $PINS --ssh-key "$SSH_KEY" --ci-proof "$CI_PROOF" --backup-identity "$BACKUP_KEY" --apply
```

Шаг prepare строит immutable API и заменяет только BO subtree в копии прежнего
public bundle. Остальные файлы проверяются полным хешированием. Миграция и ACL
в `device-access-owner.mjs` выполняются в одной REPEATABLE READ транзакции: прежние
таблицы/строки/ledger/роли сохраняются, допускается ровно051 и reviewed ACL delta.
Живые heartbeat между транзакциями не сравниваются как статичные данные.

После Windows staging/Verify нужен приватный результат
`pickchick-device-access-prepared-v1` с тем же source SHA, branch/device, schema020,
её checksum, runtime/grants proofs, установленным worker и обновлённым KitchenLink.
Worker может быть Manual+Stopped при `enabled=false`: это подготовка, не ACK.
`enable` сначала проверяет этот результат, точный script hash и свежий heartbeat
существующего edge; затем включает только cloud-флаг. Его `enabled.json` имеет
формат `pickchick-device-access-cloud-enabled-v1` и нужен Windows Activate.

```sh
python3 infra/staging/release-device-access.py enable $SOURCE $PINS --ssh-key "$SSH_KEY" --ci-proof "$CI_PROOF" --windows-proof "$WINDOWS_PROOF"
python3 infra/staging/release-device-access.py enable $SOURCE $PINS --ssh-key "$SSH_KEY" --ci-proof "$CI_PROOF" --windows-proof "$WINDOWS_PROOF" --apply
```

Затем отдельными guarded шагами включаются edge/worker и портал. Итоговая проверка
подключения/ACK выполняется после этих шагов. Наличие файла подготовки не является
доказательством работающего входа пользователя.

Ошибка сохраняет общую release lock. При неизвестном исходе `apply` не повторяется:
сохраняется marker до отправки owner-команды. `rollback` под своим `--owner-id`
возвращает API/gateway без восстановления live БД. Сначала должен завершиться
`disable` с перезапуском API: активный флаг блокирует rollback. Затем SHARE locks
ждут ранее отправленные записи перед проверкой пустоты всех новых Devices таблиц.
После реальных кодов/привязок требуется отдельный план восстановления, чтобы
не потерять принятые команды и ограничения managed-терминалов.

## Windows: schema019 -> 020, KitchenLink и отдельный mailbox

Операторы рассчитаны на фактически установленный `edge-23fb39e/app` (полный SHA
`23fb39e152fccaa97a32e9bf179c2d89a50dc1d5`) и ровно19 миграций. Другой baseline
требует нового просмотра, а не замены константы во время установки. Использовать
один итоговый опубликованный SHA с полной зелёной Foundation CI для cloud, runtime
и KitchenLink. Сейчас эти операторы проверены локально, Windows установка pending.

Пакеты собираются из чистого итогового checkout:

```sh
python3 scripts/build-windows-edge-runtime.py --output .local/device-access-runtime.zip
pnpm --filter @pickchick/kitchen build
node infra/kitchen-portal/package.mjs
```

На Windows операторский каталог содержит exact bytes новых трёх PS файлов и
закреплённых зависимостей `install-native-foundation.ps1`, `update-native-service.ps1`,
`update-native-unified-menu.ps1`, `install-native-menu-sync.ps1`,
`reviewed-env-bytes.ps1`. Последний включён из коммита86584357, его SHA проверяется
при Activate. Исторические helpers не изменены. Установщик отдельно сверяет свой
SHA с записью внутри runtime archive. `inputs.json` связывает staged manifest с
проверенным ZIP/CI/branch/device. Node/WinSW/Postgres берутся из прежнего foundation.
Запускать elevated x64 Windows PowerShell5.1; файлы операторов ASCII, конфигурация
смешанных CRLF/LF сохраняется побайтово. Перед каждой мутацией брать свежий Inspect,
сохранять только приватные JSON proofs и штатную общую maintenance lease.

В следующих командах `$R` - просмотренная hashtable с SourceCommit, RuntimeArchive,
RuntimeSha256, BackupManifest, CiProof, BranchId, DeviceId; `$W` - ReleaseName
`edge-<sha7>`, SourceCommit, BranchId, DeviceId, CiProof, BackupManifest. Нельзя
передавать секреты в аргументах. Каждый mutating режим без `-Apply` выполняет план.

```powershell
# Backup019: новый уникальный protected каталог, backup + полное восстановление
# во временную БД. Helper и ledger брать вместе из итогового source.
& $Node $BackupHelper $FoundationTools $PgBin $FreshBackupDir $BranchId schema019
# $R.BackupManifest указывает на фактический backup-manifest.json этого запуска.
.\update-native-device-access.ps1 -Mode Inspect @R
.\update-native-device-access.ps1 -Mode Stage @R -Apply
.\update-native-device-access.ps1 -Mode Prepare @R
.\update-native-device-access.ps1 -Mode Prepare @R -Apply
# После020 нужен НОВЫЙ backup/restore с schema020, затем обновить обе hashtable.
& $Node $BackupHelper $FoundationTools $PgBin $FreshBackup020Dir $BranchId schema020
.\update-native-device-access.ps1 -Mode Switch @R
.\update-native-device-access.ps1 -Mode Switch @R -Apply
.\update-native-device-access.ps1 -Mode Verify @R
.\install-native-device-access.ps1 -Mode Install @W
.\install-native-device-access.ps1 -Mode Install @W -Apply
```

Prepare останавливает только Edge и прежних его writers/dependents, применяет020
через owner transaction, затем восстанавливает службы. Проверяются прежние строки,
последовательности, immutable ledger, права других ролей, пустота новых таблиц.
Новая роль получает только CONNECT к своей БД и canonical mailbox ACL. Отдельный
реальный вход доказывается до migration COMMIT; CREATE/TEMP и права чтения заказов
или password verifier запрещены. Пароли существующих ролей не меняются. Switch
меняет только Edge XML; POS, fulfillment/menu worker binaries и identity сохраняются.
Новый mailbox устанавливается LocalService Manual+Stopped, флаги выключены.
Postgres и tunnel не перезапускаются. Полные живые проверки могут занять минуты;
согласованное окно остановки необходимо перед Prepare/Switch/Activate.

KitchenLink обновляется отдельно. `$L` содержит PackageDirectory, ManifestSha256
для agent-package.json, SourceCommit, CiProof, HelpersDirectory. Inspect JSON
сохраняется в приватный `$LinkPlan` без CLIXML/служебного stdout; его фактический
SHA передаётся далее. План связывает весь текущий binary tree, config/XML и машину.

```powershell
.\update-agent.ps1 -Mode Inspect @L
.\update-agent.ps1 -Mode Update @L -PlanFile $LinkPlan -PlanSha256 $LinkPlanHash
.\update-agent.ps1 -Mode Update @L -PlanFile $LinkPlan -PlanSha256 $LinkPlanHash -Apply
.\update-agent.ps1 -Mode Verify @L -PlanFile $LinkPlan -PlanSha256 $LinkPlanHash
# Сохранить actual Verify JSON как $LinkProof, посчитать $LinkHash.
.\install-native-device-access.ps1 -Mode Verify @W -LinkProof $LinkProof -LinkProofSha256 $LinkHash
```

Обновляются ровно `infra/kitchen-portal/agent.mjs`, `infra/kitchen-portal/link.mjs`,
`apps/kitchen/server.mjs`, `apps/kitchen/terminal-cookie.mjs`. До остановки только
KitchenLink сохраняется полный прежний каталог, private config и выполняется
побайтовое восстановление в отдельный каталог. Config/key/XML не меняются.
Verify проверяет hashes, SCM и фактический Node child; это не подтверждение WAN ACK.
Полученный `pickchick-device-access-prepared-v1` содержит schema020, actual runtime/
grants и `link.files` из этих четырёх файлов. Worker установлен, но ещё остановлен.

После cloud `enable` и получения actual `pickchick-device-access-cloud-enabled-v1`:

```powershell
# $A добавляет LinkProof/LinkProofSha256, CloudProof/CloudProofSha256 и точный
# ExpectedEdgeEnvSha256 к $W. Просмотреть новый план перед Apply.
.\install-native-device-access.ps1 -Mode Activate @A
.\install-native-device-access.ps1 -Mode Activate @A -Apply
.\install-native-device-access.ps1 -Mode Ready @A
```

Activate сохраняет private backup/intent, меняет только EDGE_DEVICE_ACCESS_ENABLED
и флаг отдельного mailbox, перезапускает Edge с прежними зависимыми службами,
запускает новый worker Automatic. Итог `pickchick-device-access-ready-v1` связывает
тот же SHA, branch/device, schema020, worker script SHA и KitchenLink files.
Подтверждение доставки команд и portal opt-in - следующие самостоятельные шаги;
ready proof не создаёт ни pairing/reset-кодов, ни заказов, ни платежей.

При известном отказе файл CAS возвращает только наши точные old/new bytes;
постороннее изменение сохраняется для разбора. KitchenLink `Rollback -Apply`
использует тот же plan/hash и проверенный полный backup до закрытия службы. Его
результат явно сообщает восстановление старых файлов, не готовность новой версии.
При неизвестном COMMIT, потере ответа или отсутствующем Prepare.json не повторять
Prepare: сохранить вывод/lease evidence, читать ledger/grants/готовность и составлять
отдельное восстановление фактического состояния. Production restore/down-migration
не выполнять. Новый runtime нельзя откатить при любом managed local_terminal;
для этого потребуется отдельное guarded завершение привязок и сессий. Отключение
флага само по себе не разрешает старый runtime.

Адресные проверки операторов: PostgreSQL18 upgrade/rollback/unknown-COMMIT,
restricted CONNECT login с PUBLIC revoked, неизменность019 backup guards;
исполняемые PowerShell tests для stage/proof/flag guards, partial CAS rollback,
foreign bytes и смешанных CRLF/LF. Нативная PowerShell5.1 проверка, настоящие службы
и пользовательский вход остаются частью последующей установки.

Завершение единого меню на schema051: [remote-stops и media-upload](unified-menu-continuation.md).
Отдельный canonical BO на `pickchick.kz/backoffice`: [выпуск staff-login](device-access-backoffice.md)
после Devices/portal и флагов, с сохранением CEO credential mount.
