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

1. `deploy` — образ API с миграциями cloud045-047, все новые флаги выключены.
   - Проверки до изменений: exact-SHA зелёная CI (все 11 заданий из `ci.yml`),
     запущенный API/compose/gateway совпадают с переданными хешами, миграции 045-047
     ожидают или уже применены с теми же checksum, у каждой активной привязки
     менеджера каталога к точке есть строка в `bo_access_grants`.
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
   - При ошибке после смены API возвращаются прежние API и gateway. Схема 045-047
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

Пример (значения `--expected-*` берутся из read-only проверки VPS в день выпуска):

```sh
python3 infra/staging/release-unified-menu.py deploy "$SHA" --branch codex/unified-menu \
  --branch-id "$BRANCH_ID" --expected-api-sha "$API_SHA" --expected-public-sha "$PUBLIC_SHA" \
  --expected-compose-sha256 "$COMPOSE_HASH" --expected-gateway-sha256 "$GATEWAY_HASH" \
  --ci-run "$RUN_ID"            # план; затем то же с --apply
python3 infra/staging/release-unified-menu.py access-roles "$SHA" --branch codex/unified-menu \
  --branch-id "$BRANCH_ID" --apply
```

Скрипт проверяет живой gateway по точным фрагментам текста. Если выпуск киоска или
оплаты изменил эти фрагменты, `deploy` остановится («Gateway anchor not found»). Тогда
нужно сверить новый gateway и обновить скрипт, а не обходить проверку.

## Порядок выпуска

1. **VPS, облако.** Сначала персональные входы и роли (раздел ниже). Затем
   `deploy` и `access-roles`. Выпуск согласуется с инженером оплаты: оба меняют
   API и gateway, базовые хеши берутся после его последнего выпуска.
2. **Цены.** В бэк-офисе сверить и заново опубликовать утверждённые цены
   (публикация пока доходит только до киоска и приложения).
3. **Windows-касса** (по [native-menu-sync.md](../../infra/windows/native-menu-sync.md)
   и [remote-stops-upgrade.md](../../infra/windows/remote-stops-upgrade.md)). Касса
   должна быть на edge schema017 (работы по киоску); иначе стоп.
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
   - Киоск: сборка 8 (TestFlight/MDM).
   - Приложение: сборка с опубликованным каталогом (TestFlight, затем App Store) и
     `CATALOG_MOBILE_STOREFRONT_ENABLED=true` отдельным выпуском.

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
  `current`. Схема 045-047 остаётся, старый образ с ней совместим.

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
- [ ] `deploy`: результат `migrations 045-047`, `flags all off`, `backup_restore passed`;
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
