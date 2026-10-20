# Автоматическое продление ключа кассы (edge identity)

Статус: код и тесты готовы, оба флага по умолчанию выключены. VPS и касса не менялись.
Перенесено 19.10.2026 из ветки `codex/cashier-key-renewal` на общий срез `76902fa4`
(аудит 4.1/6.0): миграция облака перенумерована 051 -> 066. Предупреждение в кабинете за
7 дней до истечения работает при любых флагах.

## Зачем

`DeviceIdentity` кассы (edge) выдаётся на 30 дней (`provisionDevice`, cloud003) и до сих
пор продлевалась только вручную (`pnpm device:setup <uuid> --rotate`). Этим же ключом
аутентифицируются доставка заказов на кухню и heartbeat стоп-листа (FulfillmentWorker),
синхронизация меню (MenuSync) и POS order sync. После истечения все онлайн-продажи и
доставка на кухню останавливаются без явной ошибки на кассе.

## Как устроено

**Облако** (флаг `CLOUD_EDGE_IDENTITY_ROTATION_ENABLED`, только API, по умолчанию `false`,
выключенный эндпоинт отвечает 404):

- `POST /internal/v1/edge/identity/rotate` с телом `{"rotation_id":"<uuid>"}` и обычными
  заголовками устройства (`Authorization: Bearer`, `X-Device-Id`). Только через приватный
  туннель `/internal/`; публичный Caddy его не пропускает.
- Ротация выполняется, только если устройство `active`, `kind=edge`, текущий ключ не
  истёк и до истечения осталось меньше 10 дней. Истёкший, отозванный, pending или уже
  заменённый ключ никогда не продлевается (401/409).
- Новый секрет: HMAC старого секрета и случайной соли, новый срок 30 дней. Старый ключ
  (`device_credentials.previous_*`) действует до подтверждения нового, но не дольше своего
  срока: потерянный ответ всегда можно повторить, и ротация не делает кассе хуже, чем без
  неё. После подтверждения старый ключ живёт ещё не более 24 часов, чтобы все процессы
  кассы успели перечитать файл.
- Каждая ротация - строка `device_identity_rotations` (append-only, `actor=device`, только
  хэши). Один ключ можно заменить ровно один раз (`UNIQUE from_token_hash`).
- Повтор с тем же `rotation_id` и старым ключом (потерянный ответ) возвращает тот же новый
  ключ, пока он не подтверждён. `POST /internal/v1/edge/identity/confirm` новым ключом
  подтверждает получение (повторное подтверждение не продлевает 24 часа); после этого
  повтор старым ключом получает 409.
- Ручной `device:setup --rotate` и `device:revoke` работают как раньше; ручная ротация
  сразу закрывает перекрытие, отзыв закрывает оба ключа.
- Права API-роли: `infra/staging/edge-identity-rotation-grants.mjs` (вызывается из
  `provision.mjs`). Включено: `SELECT, INSERT` на журнал,
  `UPDATE(confirmed_at, replay_count)` журнала и `UPDATE` только колонок секрета и срока
  в `device_credentials`. Статус, филиал и тип устройства, удаление журнала и
  `device_audit` недоступны. Выключено - все эти права отзываются.

**Касса Windows.** Рабочие службы (FulfillmentWorker, MenuSync, PosSync) работают под
LocalService и могут только читать `device-identity.json`: `native-pos-sync-permissions.ps1`
при каждом старте отклоняет более широкий ACL. Поэтому файл меняет отдельная задача
планировщика `\PickChick\PickChickIdentityRotation` под SYSTEM (каждый час и через 5 минут
после загрузки), из того же релиза, что FulfillmentWorker. Флаг `EDGE_IDENTITY_AUTO_ROTATE`
(по умолчанию `false`) в `C:\ProgramData\PickChick\IdentityRotation\rotation.env`.

Протокол файла (`native-identity-rotation.mjs` -> `renewIdentityFile`), всё в каталоге файла:

1. Пока до истечения больше ~10 дней - ничего не делает и не ходит в облако.
2. `device-identity.json.rotation` - намерение с `rotation_id` (до первого запроса).
3. Ответ облака записывается в `device-identity.json.next` (temp + fsync + rename, ACL
   применяется `native-identity-acl.ps1` до rename).
4. Новый ключ подтверждается облаком (`confirm`). Неподтверждённый ключ не ставится никогда.
5. Текущий файл сохраняется как `.previous`, `.next` атомарно заменяет `device-identity.json`
   (затем копия PosSync, если она передана через `--mirror` и содержит старый ключ).
6. После проверки удаляются `.previous`, `.next`, `.rotation`. Любой сбой (сеть, туннель,
   диск, перезагрузка) продолжается в следующем запуске с тем же `rotation_id`.
   `device-identity.json.lock` исключает параллельные запуски.

Не удалять `.rotation`/`.next` вручную во время незавершённой ротации: без них касса не
сможет повторить потерянный ответ (останется ручной `device:setup --rotate`).

Ответ 404 (флаг облака выключен или API старше этой версии) касса трактует как "ротация
недоступна": `.rotation` и `.next` сохраняются, задача пишет `refused` /
`CLOUD_ROTATION_DISABLED`, и после включения флага ротация завершается с тем же
`rotation_id`. Облако отвечает 404 только в этом случае; неизвестная ротация в `confirm` - 409. Удаление намерения при 404 означало бы потерю уже выданного ключа: новый
`rotation_id` со старым ключом получает 409, и касса блокируется по истечении старого ключа.

**Локальный/Linux edge.** `scripts/fulfillment-worker.mjs` с `EDGE_IDENTITY_AUTO_ROTATE=true`
сам продлевает `.local/edge-identity.json` (проверка раз в 15 минут).

## Мониторинг

- Облако, приватный `GET /health/metrics` (значения обновляет readiness-проба, не чаще
  раза в минуту; сам `/metrics` в БД не ходит):
  `pickchick_edge_identity_min_days_remaining` (минимум по активным edge),
  `pickchick_edge_identity_active_devices`, `pickchick_edge_identity_observed_age_seconds`.
- Предлагаемые алерты: `min_days_remaining < 7` - автоматическое продление не сработало
  (оно начинается с 10 дней); `< 3` - критично, продлить вручную;
  `observed_age_seconds > 600` - значение устарело.
- Касса: FulfillmentWorker пишет в свой лог событие `edge_identity` с полями `state` и
  `days_remaining` при старте и при смене состояния или целого числа дней
  (`ok`, `renewal_due` < 10 дней, `critical` < 3 дней). Задача ротации пишет
  `C:\ProgramData\PickChick\IdentityRotation\logs\rotation.log` (без токенов, ограничен 1 МБ)
  и ненулевой код в "Last Run Result" при `retry`, `refused`, `unauthorized`, `blocked`.

## Включение (оператор)

Порядок зависимостей: миграция `066_cloud_edge_identity_rotation.sql` идёт после 060 и
после миграций 061-065 других полос этого спринта, если они выходят в том же выпуске.
Мигратор отклоняет миграции не по порядку: нельзя выпустить 066 раньше 061-065 и потом
догонять их.

1. **Облако, флаг выключен.** Выпустить API с этим коммитом обычным охраняемым release:
   provision применяет 066 (только `ADD COLUMN`/`CREATE TABLE`) и отзывает права ротации.
   Проверить `/health/ready` = 200 (readiness теперь требует колонок 066) и наличие
   `pickchick_edge_identity_*` в приватных метриках. Существующая касса продолжает работать:
   без ротаций `previous_*` пусты, проверка ключа прежняя.
2. **Облако, флаг включён.** В установленном compose выставить
   `CLOUD_EDGE_IDENTITY_ROTATION_ENABLED: "true"` для `api` и `provision` (через reviewed
   release-скрипт, как остальные флаги), выполнить provision (выдаёт права) и пересоздать
   только API. Проверка через туннель: `POST /internal/v1/edge/identity/rotate` без ключа -
   401 (не 404); readiness проверяет миграцию 066 и права.
3. **Касса, релиз.** Установить edge-релиз с этим коммитом штатной процедурой обновления
   FulfillmentWorker (релиз содержит `native-identity-rotation.mjs` и `native-identity-acl.ps1`).
4. **Касса, задача без продления.** В elevated PowerShell 5.1 из каталога `infra\windows`:
   ```powershell
   .\install-identity-rotation.ps1 -Mode Inspect
   .\install-identity-rotation.ps1 -Mode Install -BranchId <branch> -DeviceId <device> -IncludePosSync
   ```
   `-IncludePosSync` - только если установлен PosSync (`PosSync\service\device-identity.json`).
   В логе должна появиться строка `state: "disabled"` с `days_remaining`.
5. **Касса, продление включено.** Повторить Install с `-AutoRotate`. Ожидается `not_due`
   (или `rotated`, если до истечения меньше 10 дней). Проверить, что службы читают новый
   файл (их лог `edge_identity` покажет ~30 дней) и что журнал облака содержит
   подтверждённую строку.
6. После каждого обновления релиза FulfillmentWorker повторять шаг 5 (задача запускает
   скрипт из каталога релиза; `-Mode Inspect` показывает `workerApp` и аргументы задачи).

## Предупреждение до истечения (без флагов)

- Кабинет, «Устройства»: за 7 дней до `device_credentials.expires_at` касса получает
  статус «Ключ истекает через N дн.» (в последние сутки «Ключ истекает сегодня»,
  после истечения «Истёк ключ») и попадает в фильтр «Требуют внимания».
- Облако: `pickchick_edge_identity_min_days_remaining` в приватных метриках.
- Источник истины для полосы эксплуатации - `device_credentials.expires_at`.

## Ручное продление (владелец/оператор)

Пока автоматическое продление не включено, ключ продлевается вручную не реже раза в
30 дней, лучше за 7-10 дней до срока (кабинет начинает предупреждать за 7 дней).

**Вариант A, ключ ещё действует (рекомендуется).** Выполнить шаги 1-4 раздела «Включение» выше,
затем один раз переустановить задачу с `-AutoRotate` (шаг 5) в окне 10 дней до
истечения: задача продлит ключ при ближайшем запуске (не позже чем через час). После
`rotated` в `rotation.log` можно оставить `-AutoRotate` включённым или вернуть Install без
него.

**Вариант B, ключ истёк, или ротация в облаке недоступна.** Нужен разработчик с доступом
к БД облака:

1. Остановить на кассе `PickChickFulfillmentWorker`, `PickChickMenuSyncWorker`,
   `PickChickDeviceAccessWorker` и `PickChickPosSync` (если есть). Касса и кухня по LAN
   продолжают работать локально.
2. На доверенной машине с туннелем к БД облака выполнить
   `pnpm device:setup <device_id> --rotate` (внутри `provisionDevice(..., true)`). Скрипту
   нужна конфигурация `api` (`CLOUD_DATABASE_URL` облака через туннель) и `edge`
   (`EDGE_BRANCH_ID` этой кассы), как в `.env.example`; файл пишется в
   `.local/edge-identity.json` с правами 600. Старый ключ сразу перестаёт действовать.
3. Передать файл на кассу защищённым каналом (не мессенджером), положить рядом с
   `C:\ProgramData\PickChick\FulfillmentWorker\device-identity.json` под именем
   `device-identity.json.<uuid>.tmp`, применить ACL
   `infra\windows\native-identity-acl.ps1 -Path <tmp>` и заменить файл
   `Move-Item -Force <tmp> device-identity.json`. Так же для копии PosSync
   (`C:\ProgramData\PickChick\PosSync\service\device-identity.json`), если она есть.
4. Удалить исходный файл на машине оператора, запустить службы и проверить в логе
   FulfillmentWorker событие `edge_identity` с `days_remaining` около 30, а в кабинете -
   «Касса на связи».

## Отключение и откат

- Касса: `install-identity-rotation.ps1 -Mode Install ...` без `-AutoRotate` (флаг `false`)
  или `-Mode Uninstall` (логи сохраняются). Уже выданный ключ действует до своего срока.
- Облако: флаг `false` + provision отзывает права; эндпоинт снова 404. Колонки и журнал
  остаются (аддитивно). Незавершённая ротация на кассе при этом не теряется (см. выше) и
  завершается после повторного включения; до этого касса работает старым ключом до его срока.
- Откат образа API на версию без 066-логики: старый API принимает только текущий
  (`token_hash`) ключ. Перед откатом проверить, что неподтверждённых ротаций нет:
  `SELECT count(*) FROM device_identity_rotations WHERE confirmed_at IS NULL` = 0 (и на кассе
  нет `device-identity.json.rotation`). Иначе касса со старым ключом в файле получит 401 сразу
  после отката: восстановление - вернуть новый образ или ручной `device:setup --rotate`.
- Скрипты `update-native-order-number.ps1`, `update-native-kiosk-qr.ps1`,
  `update-native-unified-menu.ps1` фиксируют хэш файла ключа и прерываются ("Transport
  credentials changed"), если он изменился во время обновления. На время такого обновления
  выполнить `Disable-ScheduledTask -TaskPath '\PickChick\' -TaskName PickChickIdentityRotation`
  (затем `Enable-ScheduledTask`) или проводить обновление, когда до истечения больше 10 дней.
- Ручной путь остаётся: `pnpm device:setup <device> --rotate` и перенос файла по
  процедуре установки.

## Проверки

- `tests/integration/edge-identity-rotation.test.mjs` (PostgreSQL + API): окно продления,
  отказ для истёкшего/отозванного/pending, перекрытие и его граница, append-only журнал,
  повтор потерянного ответа, подтверждение, конфликты id/устройств, 8 параллельных ротаций,
  гонка с отзывом, HTTP 404 при выключенном флаге, метрики, роль с минимальными правами;
  файл: idle без запросов, атомарная замена, потерянный ответ, неподтверждённый кандидат,
  частичная замена копии, блокировка, чужая копия, отказ облака, ручная перевыдача.
- `tests/unit/edge-identity-rotation.test.mjs`: пороги, флаги, гранты, аргументы задачи
  Windows, белый список полей лога, состав runtime.
- Не проверено на реальной Windows: ACL `native-identity-acl.ps1`, регистрация задачи
  планировщика и rename при открытом файле. Перед включением на кассе прогнать шаги 4-5
  на стенде или в окне обслуживания.
