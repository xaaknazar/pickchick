# Единое меню: выпуск, откат и контроль

Цель: меню редактируется только в бэк-офисе. Одна публикация меняет цену, фото и состав
на кассе (Windows edge), в iPad-киоске и в мобильном приложении. Стоп, поставленный на
кассе или в бэк-офисе, действует везде. Касса остаётся единственным источником стопов:
бэк-офис только ставит команду в очередь, касса применяет её и подтверждает.

Всё новое выключено по умолчанию. Каждый шаг включается отдельно и отдельно же
выключается. Порядок важен: следующий шаг скрипт не даст включить, пока не включён
предыдущий.

## Флаги

| Флаг                                              | Где                         | Что включает                                                                                      | Выключение                                                             |
| ------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `CATALOG_ACCESS_ROLES_ENABLED`                    | API (VPS)                   | правку/публикацию каталога только с ролью `manager` в `bo_access_grants`; `analyst` только читает | `release-unified-menu.py disable --flag access-roles`                  |
| `CATALOG_EDGE_PUBLICATION_ENABLED` + `_BRANCH_ID` | API                         | публикация из бэк-офиса доставляется на кассу                                                     | `disable --flag edge-publication`                                      |
| `BACKOFFICE_REMOTE_STOPS_ENABLED`                 | API                         | кнопки «Стоп» / «Вернуть в продажу» в бэк-офисе                                                   | `disable --flag remote-stops` (снимает и INSERT-право)                 |
| `CATALOG_MEDIA_UPLOAD_ENABLED`                    | API                         | загрузка фото и раздача `/v1/media/catalog/*`                                                     | `disable --flag media-upload` (клиенты возвращаются к встроенным фото) |
| `EDGE_MENU_SYNC_MODE` (`off`/`report`/`apply`)    | `menu-sync.env` на кассе    | служба `PickChickMenuSyncWorker`                                                                  | `off` и перезапуск службы                                              |
| `FULFILLMENT_TRANSPORT_PROTOCOL=4`                | fulfillment worker на кассе | обмен стопами (протокол 4)                                                                        | `2` и перезапуск                                                       |
| `EDGE_REMOTE_STOPS_ENABLED`                       | edge-сервис на кассе        | применение стопов из бэк-офиса                                                                    | `false` и перезапуск                                                   |
| `CATALOG_MOBILE_STOREFRONT_ENABLED`               | API                         | приложение читает опубликованный каталог                                                          | отдельный выпуск (`release-catalog-storefront.py`)                     |

## Скрипт выпуска облака

`infra/staging/release-unified-menu.py` — отдельный охраняемый выпуск. Он не трогает
`release-kiosk-checkout.py`, оплату, квоты, заказы и Kaspi. Без `--apply` любая фаза
только проверяет и печатает план. Доказательства фаз хранятся в
`.local/unified-menu-release/<sha>/` (0600, вне Git).

Фазы (по порядку):

1. `deploy` — образ API с миграциями cloud047-049, все новые флаги выключены.
   - Проверки до изменений: exact-SHA зелёная CI (все 11 заданий из `ci.yml`),
     запущенный API/compose/gateway совпадают с живой базой (раздел ниже), миграции
     047-049 ожидают или уже применены с теми же checksum, у каждой активной привязки
     менеджера каталога к точке есть строка в `bo_access_grants`. QR worker киоска,
     банковский мост, мобильный worker и БД (все контейнеры, кроме API и gateway)
     после выпуска должны остаться ровно такими же, иначе откат API и gateway.
   - Затем: зашифрованный backup и проверка восстановления в изолированную БД.
   - Шаг владельца БД (`infra/staging/unified-menu-owner.mjs deploy`) применяет
     миграции и только нужные им права в одной транзакции repeatable read. В той же
     транзакции он доказывает, что каждая прежняя таблица сохранила все строки.
     Поэтому heartbeat кассы в `cloud_branch_availability` во время выпуска не
     считается изменением данных (откат 4 октября был именно из-за этого).
   - Прежний API продолжает работать на новой схеме: это проверка совместимости.
     Потом запускается новый API и проверяется, что в окружении изменились только
     пять новых ключей (значения сравниваются как SHA-256 на сервере).
   - Gateway получает маршруты, которые ничего не делают, пока флаги выключены:
     фото, карта медиа витрин, `/stops` бэк-офиса. Ожидание long-poll киоска
     поднимается до 30 с.
   - При ошибке после смены API возвращаются прежние API и gateway. Схема 047-049
     остаётся: она только добавляет таблицы. Если результат команды неизвестен,
     блокировка выпуска остаётся до ручной проверки.
2. `access-roles` — повторная проверка покрытия `bo_access_grants`, затем флаг.
3. `verify-edge` — только чтение:
   - ровно одно активное edge-устройство точки;
   - `edge_menu_state` от него не старше 2 минут, версия не ниже 2;
   - нет неподтверждённых `menu.published`;
   - отчёт паритета (`scripts/catalog-edge-parity.mjs`) чистый и сделан для текущей
     head-публикации и текущего меню кассы, вместе со станциями кухни.
4. `edge-publication` — не позже 2 часов после `verify-edge`, если меню кассы и
   head-публикация с тех пор не изменились.
5. `remote-stops` — только если касса шлёт heartbeat протокола 4 (не старше 30 с).
6. `media-upload`.
7. `disable --flag <фаза>` — откат одного флага, разрешён в любой момент после
   `deploy`. Сначала выключается окружение, потом снимаются права. Пока ранний флаг
   выключен, более поздние фазы снова включить нельзя.

### Живая база (выпуск 6ac409f, 8 октября)

`deploy` принимает только базу, записанную инженером оплаты после установки киоска
([kiosk-v3-launch.md](kiosk-v3-launch.md), раздел «Установлено 8 октября: `6ac409f`»,
[kiosk-v3-installation-2026-10-08.json](kiosk-v3-installation-2026-10-08.json),
[payment-blockers-2026-10-09.md](payment-blockers-2026-10-09.md)). Значения зашиты в
скрипт (`LIVE_*`) и сверяются с переданными `--expected-*`:

| Что                                          | Значение                                                                  | Источник                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| API (`current`) и QR worker                  | `6ac409f710f96e5247e8423963e2ef511a9e4d4a`                                | installation JSON `releaseSource`                                      |
| Публичный указатель (`public-https/current`) | тот же `6ac409f…`                                                         | `release-kiosk-qr-recovery.py` переключает оба указателя               |
| Образ API и QR worker                        | `sha256:6ef62d34b54cf1f6788358a8e972d72c3c4fc2f7ad5325734812d45f8131185c` | installation JSON `vps.image`                                          |
| Gateway (смонтированный Caddyfile)           | `a659c2428163b2e51c2f1affd62fda18ab339c6e55cf576cdcf0865b2d1d7d9f`        | installation JSON `vps.gatewaySha256` (маршруты checkout от `85f23d5`) |
| Схема облака                                 | 001-040, 042-046 (45 строк), 045/046 — QR киоска                          | installation JSON `lastMigration`/`migrationFiles`                     |
| Compose API                                  | **не записан** для `6ac409f`                                              | передаётся только `--expected-compose-sha256`                          |

Хеш compose берётся read-only в день выпуска:
`sha256sum /opt/pickchick-staging/releases/6ac409f710f96e5247e8423963e2ef511a9e4d4a/infra/staging/compose.yaml`.
Выпуск QR (`unchanged_compose`) переносил compose без изменений, поэтому ожидается
`4422715c…` из предыдущих профилей, но скрипт проверяет только фактический файл против
переданного значения. Если инженер оплаты выпустит новую версию (например, исправление
`06924c3` для QR worker или профиль ошибок checkout), база меняется: обновить `LIVE_*`,
fixture gateway и тесты по его записи и пройти ревью, а не передавать другие значения.
Этот выпуск не трогает QR worker, мост и мобильный worker: они остаются на `6ac409f`.

Пример:

```sh
python3 infra/staging/release-unified-menu.py deploy "$SHA" --branch codex/unified-menu \
  --branch-id "$BRANCH_ID" --expected-api-sha 6ac409f710f96e5247e8423963e2ef511a9e4d4a \
  --expected-public-sha 6ac409f710f96e5247e8423963e2ef511a9e4d4a \
  --expected-compose-sha256 "$COMPOSE_HASH" \
  --expected-gateway-sha256 a659c2428163b2e51c2f1affd62fda18ab339c6e55cf576cdcf0865b2d1d7d9f \
  --ci-run "$RUN_ID"            # план; затем то же с --apply
python3 infra/staging/release-unified-menu.py access-roles "$SHA" --branch codex/unified-menu \
  --branch-id "$BRANCH_ID" --apply
```

Скрипт проверяет живой gateway по точным фрагментам текста. Маршруты checkout киоска
(`@kiosk_checkout_*`) остаются байт в байт. Если выпуск киоска или оплаты изменил эти
фрагменты, `deploy` остановится («Gateway anchor not found»). Тогда нужно сверить новый
gateway и обновить скрипт, а не обходить проверку.

## Порядок выпуска

1. **VPS, облако.** Сначала персональные входы и роли (раздел ниже). Затем
   `deploy` и `access-roles`. Выпуск согласуется с инженером оплаты: оба меняют
   API и gateway, общая блокировка выпуска одна. База — его последний выпуск
   (раздел «Живая база»); незавершённая QR-попытка контрольного заказа этот выпуск
   не блокирует, но её строки и QR worker не меняются.
2. **Цены.** В бэк-офисе сверить и заново опубликовать утверждённые цены
   (публикация пока доходит только до киоска и приложения).
3. **Windows-касса** (по [native-menu-sync.md](../../infra/windows/native-menu-sync.md)
   и [remote-stops-upgrade.md](../../infra/windows/remote-stops-upgrade.md)). Касса
   должна быть на edge schema017 (работы по киоску; установлено 8 октября из `6ac409f`,
   `update-native-kiosk-qr.ps1`); иначе стоп.
   - backup с проверкой восстановления:
     `backup-native-service.mjs <toolsRoot> <pgBin> <runRoot> <branchId> schema017`.
     Скрипт принимает только явно названную схему из списка 014-019 с точными
     именами и SHA-256 миграций (`native-edge-backup-ledger.json`), иначе отказ;
   - миграция 018 и роль `pickchick_menu_sync`: `install-native-menu-sync.ps1`
     `-Mode Inspect`, затем `-Mode Prepare` (`menu-sync-upgrade-db.mjs`) с этим backup;
   - новый backup `... schema018`;
   - миграция 019 и права стопов: `remote-stops-upgrade-db.mjs inspect`, остановить
     Edge и worker'ы, `apply` (одна транзакция; ровно согласованные права для
     `pickchick_edge_runtime` и `pickchick_fulfillment_sync`), запустить службы;
     затем backup `... schema019` и повторный `inspect` (`grantsVerified:true`);
   - edge-сервис;
   - fulfillment worker с `FULFILLMENT_TRANSPORT_PROTOCOL=4`;
   - `PickChickMenuSyncWorker` в режиме `report`;
   - установщик POS (живая перезагрузка меню и фото по хешу).
4. **Паритет.** Выгрузить:
   - состояние каталога (`GET /v1/admin/catalog/branches/<id>`);
   - меню кассы (`GET http://127.0.0.1:<EDGE_PORT>/edge/v1/menu` на ПК);
   - активную маршрутизацию со станциями.

   Затем:
   `node scripts/catalog-edge-parity.mjs --catalog cat.json --edge edge.json --routing routing.json > parity.json`
   и `release-unified-menu.py verify-edge ... --parity-report parity.json`. Код 1 у
   паритета (цена, удалённая позиция или опция, маршрут) — стоп, сначала исправить каталог.

5. **Публикация на кассу.**
   - `edge-publication --apply`;
   - на ПК `EDGE_MENU_SYNC_MODE=apply`, перезапуск службы;
   - опубликовать меню в бэк-офисе и дождаться «Касса: применено (версия N)».
6. **Стопы из бэк-офиса.**
   - На ПК `EDGE_REMOTE_STOPS_ENABLED=true`, затем `remote-stops --apply`.
   - Проверка по чек-листу ниже, только на тестовой позиции.
7. **Фото.** `media-upload --apply`, загрузить фото тестовой позиции и проверить его
   на кассе, в киоске и в приложении.
8. **Клиенты.**
   - Киоск: на iPad стоит 0.1.0 (8) от `37dbc1a` без фото и long-poll единого меню.
     Они придут со следующей сборкой поверх 8 с сохранением intent (отдельный выпуск
     iPad, согласовать с инженером оплаты). Сборке 8 новый API отдаёт каталог в прежнем
     строгом формате (`stripStorefrontPayload`).
   - Приложение: сборка с опубликованным каталогом (TestFlight, затем App Store) и
     `CATALOG_MOBILE_STOREFRONT_ENABLED=true` отдельным выпуском.

### Профиль установленной Windows-кассы 6ac409f

Для текущей кассы используйте `infra/windows/update-native-unified-menu.ps1`.
Прежние профили обновления рассчитаны на другие схемы и не заменяют этот переход.
Профиль принимает только исходные Edge и fulfillment worker `6ac409f`, проверяет
все 11 заданий CI для полного SHA кандидата, архив runtime и точные миграции
017 → 018 → 019. Окружение, пароли и identity сохраняются; новые флаги он не включает.

После зелёной CI соберите runtime через `scripts/build-windows-edge-runtime.py`
из того же чистого опубликованного SHA. В отдельный защищённый каталог оператора
на кассе доставьте из этого SHA (без изменения байтов):

- `update-native-unified-menu.ps1`, `install-native-foundation.ps1`,
  `update-native-service.ps1`, `install-native-menu-sync.ps1`;
- `backup-native-service.mjs`, его зависимость `native-foundation-db.mjs`
  и `native-edge-backup-ledger.json`;
- runtime ZIP, его SHA-256 и полный JSON доказательства CI `{run, jobs}`.

Не используйте старую копию backup-helper из foundation: она может не знать схемы
017-019. Новую запускайте из каталога оператора, передавая существующий `toolsRoot`
(`C:\ProgramData\PickChick\EdgeTools\edge-0186902`), PostgreSQL bin, новый приватный
`runRoot`, идентификатор точки и явный `schema017`, `schema018` или `schema019`.
Резервная копия должна пройти восстановление, совпасть с текущей точкой/кластером,
содержать точные миграции и быть не старше шести часов.

Общие параметры профиля:

```powershell
$p = @{
  SourceCommit = '<полный SHA зелёного кандидата>'
  RuntimeArchive = '<runtime.zip>'
  RuntimeSha256 = '<SHA256 архива>'
  CiProof = '<ci-proof.json>'
  BranchId = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'
  DeviceId = '<существующий fulfillment device>'
}
$script = '<каталог оператора>\update-native-unified-menu.ps1'
& $script -Mode Inspect @p -BackupManifest '<017>\backup-manifest.json'
& $script -Mode Stage @p -BackupManifest '<017>\backup-manifest.json' -Apply
& $script -Mode PrepareMenu @p -BackupManifest '<017>\backup-manifest.json'
& $script -Mode PrepareMenu @p -BackupManifest '<017>\backup-manifest.json' -Apply
# Сделать НОВУЮ резервную копию schema018 с восстановлением.
& $script -Mode PrepareStops @p -BackupManifest '<018>\backup-manifest.json'
& $script -Mode PrepareStops @p -BackupManifest '<018>\backup-manifest.json' -Apply
# Сделать НОВУЮ резервную копию schema019 с восстановлением.
& $script -Mode Switch @p -BackupManifest '<019>\backup-manifest.json'
& $script -Mode Switch @p -BackupManifest '<019>\backup-manifest.json' -Apply
& $script -Mode Verify @p -BackupManifest '<019>\backup-manifest.json'
```

Далее установить menu-sync через его штатные `Install`/`Verify` в режиме `report`,
переключить fulfillment на protocol 4 и установить POS из того же SHA. Изменять
env-флаги только после `Switch`/`Verify`: до этого профиль сверяет окружение со
снимком `Stage`. Затем продолжить с паритета, публикации и флагов по одному.

При ошибке переключения профиль возвращает прежние XML и запускает службы,
работавшие до операции. Схема и данные не откатываются. Для ручного возврата
бинарников сначала вернуть env-флаги к исходным значениям, затем выполнить
`-Mode Rollback` с новой копией schema019, проверить план и повторить с `-Apply`.
После неопределённого исхода миграции сначала читать фактическую схему и записи
в `C:\ProgramData\PickChick\EdgeTools\unified-menu-<7hex>`; автоматического повтора нет.
Проверки функций на macOS/Linux не заменяют приёмку на Windows.

Не сделано в коде и остаётся ручным:

- лимит тела 300KB для `/backoffice/*` на общем фронте `pickchick.kz`
  (`infra/backoffice-login/pickchick.Caddyfile`). Браузер сам пережимает каждое фото
  больше 280KB в JPEG не больше 1280px (размер hero) и снижает качество, пока файл не
  уложится в 280KB. Если фото всё равно не помещается, кабинет покажет ошибку размера;
  поднять лимит для одного пути загрузки — отдельное изменение общего фронта.

## Персональные входы в бэк-офис

Раньше вход был один (`ceo`), и все изменения записывались на одного человека. Теперь
файл `BACKOFFICE_STAFF_FILE` (version 2) хранит по записи на человека:

- логин;
- scrypt-хеш пароля;
- его собственный токен менеджера каталога (`catalog_manager`), а значит и
  собственный `actor_id`.

Сессия несёт токен именно этого человека, поэтому `catalog_audit` и `bo_audit`
различают людей. Проверки Host, Origin и cookie прежние. Сервис не стартует, если:

- файл доступен группе или всем;
- файл принадлежит другому пользователю;
- файл является ссылкой.

На Windows действуют те же правила NTFS ACL, что и для других секретов.

Старый файл `ceo` (version 1) читается как первая запись.
`infra/backoffice-login/accounts.mjs` создаёт новые файлы только исключительно (0600)
и ничего не печатает:

```sh
node infra/backoffice-login/accounts.mjs migrate ceo.json staff-v2.json
node infra/backoffice-login/accounts.mjs add staff-v2.json manager-credential.json aigerim staff-v3.json aigerim-delivery.txt
node infra/backoffice-login/accounts.mjs remove staff-v3.json aigerim staff-v4.json
```

Каждому человеку заранее выдаётся свой `catalog_manager` и строка `bo_access_grants`
с ролью `manager` или `analyst`. Один токен на двоих скрипт не примет.

Порядок, сохраняющий откат:

1. Обновить портал (`infra/backoffice-login/update.py`) со старым файлом. Новый код
   читает version 1.
2. Положить файл version 2 по тому же пути и пересоздать контейнер портала (все
   сессии завершатся).

Прежний образ портала не читает version 2. Для его возврата нужен прежний файл
(`credentials.before.json` в каталоге выпуска портала).

**Решение владельца 8 октября 2026:** персональные роли выдаются позже. До этого
единственный действующий вход (`ceo`, тот же `actor_id`, что у директора) получает
роль `manager` для Abay Plaza, чтобы правка цен, фото и стопов работала сразу после
включения `CATALOG_ACCESS_ROLES_ENABLED`. Других `manager` не создавать без решения владельца.

**Дополнение владельца 9 октября 2026:** старой активной записи «Владелец PickChick»
для тестовой точки назначить только `analyst`. Это устраняет единственную привязку
без роли; права действующего `ceo` в Abay Plaza остаются `manager`. Перед записью
нужны резервная копия с проверкой восстановления и сверка точных actor/branch;
остальные привязки и роли не изменять.

Покрытие ролей перед `deploy`/`access-roles` (владелец решает, кому `manager`):

```sql
SELECT m.name, s.branch_id FROM catalog_manager_branches s
JOIN catalog_managers m ON m.id=s.actor_id AND m.organization_id=s.organization_id
LEFT JOIN bo_access_grants g ON g.actor_id=s.actor_id AND g.branch_id=s.branch_id
WHERE m.revoked_at IS NULL AND g.actor_id IS NULL;
-- по решению владельца, по одной строке на человека и точку:
INSERT INTO bo_access_grants(actor_id,branch_id,role) VALUES ('<actor>','<branch>','manager');
```

## Откат

- **Флаг.** `release-unified-menu.py disable --flag <фаза> ... --apply`. Права,
  которые давал флаг, снимаются после перезапуска API.
- **Меню.** Опубликовать предыдущий payload как новую версию. Перед каждой публикацией
  сохраняйте `published.payload` из `GET /v1/admin/catalog/branches/<id>` (это делает
  и отчёт паритета). Для отката положите его в черновик и опубликуйте. Касса не
  принимает версию ниже текущей (`VERSION_NOT_NEWER`), поэтому номер всегда растёт.
- **Касса.**
  - `EDGE_MENU_SYNC_MODE=off`: касса остаётся на последнем применённом меню.
  - `EDGE_REMOTE_STOPS_ENABLED=false`: стопы ставятся только на кассе.
  - `FULFILLMENT_TRANSPORT_PROTOCOL=2`: прежний heartbeat.
- **API.** Если `deploy` упал после смены API, скрипт сам возвращает прежние API и
  gateway. Ручной возврат — compose прежнего SHA (`up -d api`) и прежний указатель
  `current`. Схема 047-049 остаётся, старый образ с ней совместим.

## Контроль

```sql
-- Публикация ждёт кассу дольше 10 минут
SELECT c.catalog_version, m.version, e.occurred_at FROM catalog_menu_deliveries c
JOIN menu_releases m ON m.id=c.release_id
JOIN outbox_events e ON e.aggregate_id=c.release_id AND e.event_type='menu.published'
WHERE e.acknowledged_at IS NULL AND e.occurred_at < now() - interval '10 minutes';
-- Касса отклонила публикацию (причина: ROUTING_UNRESOLVED, MEDIA_UNAVAILABLE ...)
SELECT release_id, reason, recorded_at FROM catalog_menu_delivery_results
WHERE result='rejected' ORDER BY recorded_at DESC LIMIT 10;
-- Команды стопа, на которые касса не ответила (последний час)
SELECT count(*) FROM cloud_stop_commands WHERE state='expired' AND created_at > now() - interval '1 hour';
-- Касса сообщает своё меню (служба меню жива)
SELECT active_version, now()-observed_at AS age FROM edge_menu_state;
```

Бэк-офис показывает то же самое без SQL:

- в каталоге — «Касса: ожидает» (предупреждение через 10 минут) или
  «Касса: отклонено — <причина>»;
- в стоп-листе — «Касса не ответила за 2 минуты».

## Чек-лист проверки

Проверки на рабочей точке проводятся вне часов работы, только на отдельной тестовой
позиции («ТЕСТ — не продавать»). Реальные позиции во время работы не стопятся,
реальные счета Kaspi не создаются, оплату не трогаем.

- [ ] Касса: backup `schema017`/`schema018`/`schema019` с `restoreVerified:true`;
      `menu-sync-upgrade-db.mjs` и `remote-stops-upgrade-db.mjs` `apply` вернули
      `grantsVerified:true` и `existingDataPreserved:true`, отпечаток совпал с `inspect`.
- [ ] `deploy`: результат `migrations 047-049`, `flags all off`, `backup_restore passed`;
      киоск и приложение продают как раньше; стоп-лист кассы виден в бэк-офисе.
- [ ] Вход по двум персональным логинам; запись в `catalog_audit` у каждого своя.
- [ ] `access-roles`: аналитик видит каталог, но «Опубликовать» отвечает «Нет права».
- [ ] `verify-edge` чистый: v2, 0 неподтверждённых событий, паритет 0 ошибок.
- [ ] Публикация с тестовой позицией → «Касса: применено (версия 3)», на POS тост
      «Меню обновлено», позиция видна на кассе, в киоске и в приложении.
- [ ] Стоп тестовой позиции из бэк-офиса → «Ждём подтверждения кассы…», затем
      «Применено кассой»; в киоске и приложении позиция недоступна сразу после команды.
- [ ] Стоп той же позиции на кассе → бэк-офис показывает источник «Касса».
- [ ] «Вернуть в продажу» → позиция снова доступна везде после подтверждения кассы.
- [ ] Фото тестовой позиции → карточка на кассе, в киоске и приложении после следующей
      публикации; при выключенном `media-upload` клиенты показывают встроенные фото.
- [ ] Следующая публикация убирает тестовую позицию; откат флагов проверен `disable`.
