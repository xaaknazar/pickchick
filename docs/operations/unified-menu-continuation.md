# Завершение единого меню после Devices051

Этот профиль продолжает исходный [порядок публикации](unified-menu-publication.md),
когда access-roles и edge-publication уже включены, мобильная защита текущего меню
работает, а Devices установлены. Он не подменяет доказательства старого выпуска:
`release-unified-menu.py` и `unified-menu-owner.mjs` по-прежнему ограничены schema049.
Новый `continue-unified-menu.py` допускает только точную установленную cloud051 и
две отдельные фазы: `remote-stops`, затем `media-upload`.

## Предварительные условия

- Чистый опубликованный integrated HEAD, полный зелёный Foundation CI именно этого
  SHA; API уже установлен из того же SHA. Перед работой `project:check`/`project:tasks`,
  исключительное владение `@vps/api`, `@vps/db`, а для Windows - `@windows/cashier`.
- Завершён [Devices rollout](device-access.md): cloud051, Windows020, отдельный worker,
  cloud enable, Windows Activate. Existing iPad/edge credentials и платёжные контейнеры
  сохраняются. Эти действия не входят в продолжатель.
- В API уже включены `CATALOG_ACCESS_ROLES_ENABLED`, `CATALOG_EDGE_PUBLICATION_ENABLED`
  для нужной точки, `CUSTOMER_CHECKOUT_HEAD_GUARD`, `BACKOFFICE_DEVICE_ACCESS_ENABLED`,
  каталог и бэкофис. Целевой флаг ещё выключен и его ACL соответствует выключенному
  состоянию. Частичные права или неизвестный предыдущий результат блокируют запуск.
- Получены фактические полные SHA API/public, image ID API, SHA-256 установленного
  API compose и смонтированного Caddyfile. Все четыре pin передаются явно. API
  image tag, container revision и current symlink должны совпасть. Скрипт не строит
  и не заменяет образы, gateway, portal или canonical BO.
- Приватные JSON и ключ расшифрования резервной копии - обычные файлы `0600`.
  Полный backup шифруется `age`, восстанавливается в отдельную временную БД, сверяются
  таблицы и ledger; рабочая БД никогда не восстанавливается автоматически.

## Порядок

Ниже shell variables содержат только проверенные идентификаторы/хеши и пути.
`SHA` - будущий окончательный integrated SHA, а не SHA исторического API23/049.
Изменение SHA требует нового полного CI, установки API и Windows, новых доказательств.

```sh
# Заполнить из фактических read-only данных выпуска.
SHA=<full-integrated-sha>
BRANCH=codex/restaurant-completion
BRANCH_ID=<branch-uuid>
API_IMAGE=sha256:<actual-image-id>
PUBLIC_SHA=<actual-public-release-sha>
COMPOSE_SHA=<actual-api-compose-sha256>
GATEWAY_SHA=<actual-mounted-gateway-sha256>
CI=<private-exact-source-ci-json>
WINDOWS=<private-windows-remote-stops-ready-json>

common=("$SHA" --branch "$BRANCH" --branch-id "$BRANCH_ID"
  --expected-api-image "$API_IMAGE" --expected-public-sha "$PUBLIC_SHA"
  --expected-compose-sha256 "$COMPOSE_SHA" --expected-gateway-sha256 "$GATEWAY_SHA"
  --ci-proof "$CI")

python3 infra/staging/continue-unified-menu.py menu-head "${common[@]}"
```

`menu-head` только читает сервер. Доказательство
`.local/unified-menu-continuation/$SHA/menu-head.json` имеет формат
`pickchick-unified-menu-head-v1`. В нём есть actual current catalog version,
release ID, menu version/hash и edge device. Версии каталога и edge могут различаться;
проверяется реальная связь delivery, applied verdict и activation. Дополнительно
требуются свежий edge menu state, ноль неподтверждённых menu.published и protocol4
heartbeat не старше 30 секунд. Прочитанный head не является новой публикацией.

Передать этот JSON штатному `infra/windows/enable-native-remote-stops.ps1`.
Windows должен завершить локальный CAS `EDGE_REMOTE_STOPS_ENABLED=false→true`
после actual schema020/runtime/Ready/protocol4/MenuSync apply/меню-проверок.
Не включать облачный флаг до его результата
`pickchick-remote-stops-windows-ready-v1`. Он связан с тем же source, branch,
edge device, menu release/version/hash и catalog version, содержит env hashes,
protocol4, schema20, runtime_verified и remote_stops_enabled=true.
Cloud принимает proof не старше 6 часов и повторно сверяет свежий head и heartbeat.

```sh
python3 infra/staging/continue-unified-menu.py remote-stops "${common[@]}" \
  --windows-proof "$WINDOWS"
# Прочитать весь сохранённый plan. Подставить SHA-256 его фактических байтов.
python3 infra/staging/continue-unified-menu.py remote-stops "${common[@]}" \
  --windows-proof "$WINDOWS" --apply \
  --plan ".local/unified-menu-continuation/$SHA/remote-stops-enable-plan.json" \
  --plan-sha256 <reviewed-plan-file-sha256>
```

Применение повторяет preflight под общей `.market-release.lock`, создаёт encrypted
backup и доказывает isolated restore, затем снова сверяет план. Plan действует
15 минут и включает exact pins, environment hashes, ACL, owner metadata, соседние
контейнеры и Windows proof. Данные heartbeat между отдельными чтениями не сравниваются.

Один owner-вызов в `REPEATABLE READ` меняет только права нужного флага. До/после
проверяются строки всех таблиц в одном snapshot, schema051, role attributes,
memberships, database/schema ACL, чужие ACL и grantor сохранённых прав.
Enable выдаёт права до изменения API-флага. Compose CAS сохраняет исходные байты
в `0600` backup и меняет только literal целевого флага у API/provision. Перезапускается
только API, без смены image. Общий `provision.mjs` не запускается.

После успеха взять новый `compose_sha256` из результата; старый pin больше не подходит.
Прочие pins остаются прежними. Пересобрать `common` с новым `COMPOSE_SHA`, затем
отдельно выполнить plan и apply `media-upload` с тем же набором параметров и Windows
proof. Использовать `media-upload-enable-plan.json` и его собственный SHA-256.

План `media-upload` требует уже включённого `remote-stops` и повторяет текущие
Windows/head/heartbeat guards. Он добавляет append-only INSERT и чтение asset audit;
existing asset reads сохраняются. Не загружает и не публикует изображения самостоятельно.

## Отключение и неопределённый результат

`disable --flag media-upload`, затем при необходимости `disable --flag remote-stops`
используют те же actual pins и read-only plan → explicit apply. Windows proof для
отключения не нужен, доступность Devices/кухни не мешает выключить флаг. Перед ACL revoke
новый API с выключенным флагом должен успешно запуститься. Shared transport grants,
пять edge-publication grants, меню, фотографии и истории команд не удаляются.

```sh
python3 infra/staging/continue-unified-menu.py disable "${common[@]}" --flag media-upload
python3 infra/staging/continue-unified-menu.py disable "${common[@]}" --flag media-upload \
  --apply --plan ".local/unified-menu-continuation/$SHA/media-upload-disable-plan.json" \
  --plan-sha256 <reviewed-plan-file-sha256>
```

Любая ошибка под lease оставляет owned lock. Перед первым изменением сохраняется
attempt marker; его нельзя удалить ради повторного запуска. Неизвестный SSH/COMMIT/
restart исход не запускает обратный GRANT, откат compose или повтор команды.
Сначала отдельно установить фактические флаги, ACL, контейнер и owned lock, затем
подготовить проверяемое адресное восстановление. Частично изменённое состояние
профиль отвергнет. Автоматического восстановления рабочей БД нет.

## Приёмка и canonical BO

Успех профиля подтверждает flag/ACL/runtime и сохранность соседей; в результате
честно остаётся `functional_test_performed=false`. Реальный stop/unstop и загрузка
фотографии проверяются на выделенном тестовом товаре вне часов работы по исходному
runbook. Не останавливать продаваемые блюда, не создавать заказы/платежи для этой проверки.

`pickchick.kz/backoffice` обслуживает отдельный baked `staff-login` контейнер.
Обновление публичного BO subtree само по себе его не обновляет. После Devices/portal
и завершения согласованных операций coordinator отдельно выпускает canonical BO
через `infra/backoffice-login/prepare.py` и `update.py` с exact CI/SHA/pins,
сохраняя CEO credential mount. Не менять его параллельно continuation: проверка соседей
справедливо отклонит такой drift. Затем проверить именно canonical URL и доступ
управляющего к Devices, фото и стоп-листам. Пользовательский ввод нового kitchen
пароля и фактическую привязку устройств не имитировать.

## Локальные проверки

```sh
python3 -m unittest tests/operations/test_unified_menu_continuation.py
node --env-file=.env.example --test --test-concurrency=1 tests/integration/unified-menu-continuation.test.mjs
```

PG-тесты используют случайные disposable schema/role на синтетическом локальном
PostgreSQL. Покрывают точный ACL delta, отключение с сохранением transport, partial
ACL/ledger/role отказ, CAS, rollback внедрённого DML и concurrent heartbeat в RR.
Python проверяет реальный формат плана/Windows/head, последовательность фаз,
backup-before-dispatch, отказ повторить неизвестную операцию и сохранение lock.
