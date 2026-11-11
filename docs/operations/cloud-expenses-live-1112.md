# Расходы: предварительная проверка 12 ноября 2026

**STOP / NOT DEPLOYED.** Владелец разрешил сейчас, в любое время, выполнить
072 -> 073/074 -> 075 -> 076 -> 077, выпустить API и кабинет, затем включить
только `BACKOFFICE_EXPENSES_ENABLED`. Дополнительного согласования времени
или самого выпуска не требуется. Условие владельца: стоп при отказе guard,
несовпадении ledger или байтов.

На этой попытке сервер проверен только чтением. Свежая копия ещё не запущена,
восстановление, репетиция и живые миграции не выполнялись, образы не собирались,
API, шлюз, флаги и права не менялись. JSON ответов миграций нет, поскольку
эти команды не запускались. Серверная блокировка не бралась.

## Причина остановки и требуемый вход

Исходный файл `install-kit-1110/api-src-27ef0c05d56b2323ba62e9ffc915f9681003f9bf.tar.gz`
не найден при поиске по имени в Documents, Desktop, Downloads и кеше PickChick
на этом Mac. Путь или ссылка запрошены у владельца; приватные данные не нужны.

Для подготовки воспроизведена команда `git archive ... | gzip -n` из
`cloud-1-handover-1110.md` на точном `27ef0c05`. Получен следующий результат:

```json
{
  "archive": "/private/tmp/pickchick-cloud-expenses-evidence-1112/api-src-27ef0c05d56b2323ba62e9ffc915f9681003f9bf.tar.gz",
  "sha256": "9d7d3a91fc1b4a4117aa0e36a09098e67609fa11d4b4ea032b2feed99f4b74ac",
  "expected_sha256": "6a428b586a7d4ea72874dc50c5849e4cd331dd03a046ed33379b53232c20db22",
  "bytes": 1971955,
  "matches": false
}
```

Это **пересобранный архив**, а не доказательство повреждения файла владельца:
оригинал здесь отсутствует. Причина различия с исходным архивом не установлена.
Пересобранный пакет не передавался на сервер и не применялся. Нельзя считать
его архивом с разрешённым SHA-256 `6a428b58...` или молча заменить ожидаемый хеш.

Независимо проверено: между `27ef0c05d56b2323ba62e9ffc915f9681003f9bf` и
`24d35e2856a9ac2c119dee10549821dc7ff8a261` изменён только файл
`docs/operations/cloud-expenses-now-1111.md`. Исходники API этих коммитов
совпадают. Это не подтверждает SHA-256 отсутствующего исходного архива.

## Кандидат и CI

Свежие refs получены. Голова `origin/codex/cutover-1119`:
`24d35e2856a9ac2c119dee10549821dc7ff8a261`. В отдельную ветку протокола
`codex/cloud-expenses-live-1112` явно включены два новых общих коммита
`8f2abe2d`/`f944a53a` об архиве iiko; кандидат сервера от этого не изменён.
Текущее грязное дерево основной рабочей копии сохранено.

`pnpm project:check` и `project:tasks` ограничены несовпадением pnpm
11.25.0 / требуемой 11.19.0. Вызван непосредственно штатный ProjectSync через
Node; refs и реестр прочитаны, затем общий срез явно интегрирован в ветку
протокола. Сброса, stash, clean и force-push не было.

Foundation CI на точной голове ещё выполнялась в 02:13:30 UTC+5 12.11.
Зелёная полная CI пока не заявляется; отказов браузерных тестов на момент
среза не было. Проверка исключения для красной CI не применялась.

```json
{
  "checked_at_utc": "2026-11-11T21:13:30Z",
  "run": {
    "id": 43098970527,
    "status": "in_progress",
    "conclusion": null,
    "head_sha": "24d35e2856a9ac2c119dee10549821dc7ff8a261",
    "run_attempt": 1,
    "created_at": "2026-11-11T20:56:51Z",
    "updated_at": "2026-11-11T21:04:18Z",
    "html_url": "https://github.com/xaaknazar/pickchick/actions/runs/43098970527"
  },
  "jobs": [
    {
      "id": 130785097324,
      "name": "Foundation server account and Kaspi fixtures",
      "status": "in_progress",
      "conclusion": null,
      "failed_steps": []
    },
    {
      "id": 130785097437,
      "name": "Cloud-edge fulfillment transport and recovery",
      "status": "completed",
      "conclusion": "success",
      "failed_steps": []
    },
    {
      "id": 130785097481,
      "name": "Foundation static checks and transaction invariants",
      "status": "in_progress",
      "conclusion": null,
      "failed_steps": []
    },
    {
      "id": 130785097599,
      "name": "Foundation mobile bundles and checkout recovery",
      "status": "completed",
      "conclusion": "success",
      "failed_steps": []
    },
    {
      "id": 130785097783,
      "name": "Foundation simulator browser regressions",
      "status": "completed",
      "conclusion": "success",
      "failed_steps": []
    },
    {
      "id": 130785099442,
      "name": "iPad kiosk state, bundles and browser recovery",
      "status": "completed",
      "conclusion": "success",
      "failed_steps": []
    },
    {
      "id": 130785101554,
      "name": "Design screens and interaction smoke",
      "status": "completed",
      "conclusion": "success",
      "failed_steps": []
    },
    {
      "id": 130785112115,
      "name": "Foundation POS and backoffice integration",
      "status": "in_progress",
      "conclusion": null,
      "failed_steps": []
    },
    {
      "id": 130785115305,
      "name": "Private staging image and restricted database role",
      "status": "completed",
      "conclusion": "success",
      "failed_steps": []
    },
    {
      "id": 130785141043,
      "name": "Local kitchen UI and recovery",
      "status": "completed",
      "conclusion": "success",
      "failed_steps": []
    }
  ]
}
```

[Запуск Foundation CI](https://github.com/xaaknazar/pickchick/actions/runs/43098970527).

## Сервер: результат только чтения

SSH с проверкой host key успешен от `pickchick-ops`, UID1000.
API/current и SHA-256 установленного compose совпали с baseline runbook.
Публичный выпуск уже `46453717` после установки каталога 11.11; будущий
web-выпуск должен сохранить действующий маршрут desktop-updates и его сеть.
Ключ расшифровки резервных копий с этого Mac **совпадает** с публичным
получателем сервера. Ключ не передавался на VPS и не выводился.
Это снимает известный блокер другого Mac от 10.11, но не заменяет успешного
восстановления свежей копии.

```json
{
  "uid": 1000,
  "current": "/opt/pickchick-staging/releases/6630eb0f676350341806b735b6877a36f017c673",
  "compose_sha256": "3b6d2f55be5e8dae202de15dfca292b9f33e278c4435befee7ee6623dadd4d4c",
  "public_release": "/opt/pickchick-staging/public-https/releases/46453717a01ece038c5653db202f9f059536cd64",
  "lock_present": false,
  "api": {
    "name": "pickchick-staging-api-1",
    "id": "ddd87501123f47d9fb11c1a3d334a066feebe34be89effa5c0a8043a01fcc3fa",
    "image": "sha256:6b3e1accc6325bf78e6a0908af29b6ce83dfad92d706e4e8c5f5d389d2110492",
    "started": "2026-11-06T17:20:03.780256721Z",
    "status": "running",
    "mounts": []
  },
  "flags": {
    "CATALOG_EDGE_COMBO_STOPS_ENABLED": "false",
    "PHONE_SMS_FALLBACK_ENABLED": "false",
    "CUSTOMER_KASPI_PILOT_ENABLED": "true",
    "FARM_ENABLED": "1",
    "CATALOG_MEDIA_UPLOAD_ENABLED": "false",
    "CATALOG_EDGE_PUBLICATION_ENABLED": "true",
    "BACKOFFICE_RECONCILIATION_ENABLED": "false",
    "BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED": "false",
    "CUSTOMER_AUTH_ENABLED": "true",
    "BACKOFFICE_REMOTE_STOPS_ENABLED": "true",
    "BACKOFFICE_DEVICE_ACCESS_ENABLED": "true",
    "CATALOG_ACCESS_ROLES_ENABLED": "true",
    "BACKOFFICE_ENABLED": "true",
    "TEST_ORDER_FLOW_ENABLED": "true",
    "CLOUD_FULFILLMENT_TRANSPORT_ENABLED": "true",
    "CLOUD_POS_ORDER_SYNC_ENABLED": "false",
    "KIOSK_CHECKOUT_ENABLED": "true",
    "CUSTOMER_REVIEW_ACCOUNT_ENABLED": "true",
    "CATALOG_ADMIN_ENABLED": "true",
    "WORKFORCE_ENABLED": "true",
    "KIOSK_KASPI_QR_ENABLED": "false",
    "DEVICE_CENTER_ENABLED": "true",
    "CATALOG_MOBILE_STOREFRONT_ENABLED": "true"
  },
  "db": {
    "name": "pickchick-staging-cloud-db-1",
    "id": "bf1890a4355b0d0862f3b5eed8b5fba6e60e9976423b79d0f894a905e44e13cb",
    "image": "sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7",
    "started": "2026-09-06T11:16:25.683151988Z",
    "status": "running",
    "mounts": [
      {
        "Source": "/var/lib/docker/volumes/pickchick-staging_cloud-data/_data",
        "Destination": "/var/lib/postgresql",
        "RW": true
      }
    ]
  },
  "gateway": {
    "name": "pickchick-public-gateway",
    "id": "f08ef3a391d5e2b4be08012cea041f4dc8df7e5c56d73fe1bedb49f67c00c6bb",
    "image": "sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648",
    "started": "2026-11-11T15:09:46.83417661Z",
    "status": "running",
    "mounts": [
      {
        "Source": "/opt/pickchick-staging/public-https/releases/46453717a01ece038c5653db202f9f059536cd64/infra/public-staging/public-web",
        "Destination": "/srv/public",
        "RW": false
      },
      {
        "Source": "/opt/pickchick-staging/public-https/releases/46453717a01ece038c5653db202f9f059536cd64/infra/public-staging/gateway.Caddyfile",
        "Destination": "/etc/caddy/Caddyfile",
        "RW": false
      }
    ]
  },
  "latest_backup": "/opt/pickchick-staging/backups/cloud-20261111T021928Z.dump.age",
  "backup_service": "Result=success\nExecMainExitTimestamp=Wed 2026-11-11 02:19:29 UTC\nExecMainStatus=0\nActiveState=inactive",
  "backup_timer": "NextElapseUSecRealtime=Thu 2026-11-12 02:19:40 UTC\nActiveState=active",
  "localIdentityMatchesBackupRecipient": true
}
```

`CLOUD_POS_ORDER_SYNC_ENABLED=false`, `BACKOFFICE_ENABLED=true` прочитаны
из действующего API. Новые флаги перехода в окружении отсутствуют, фактически
выключены. Предыдущие включённые флаги не подменялись словом «все выключены»:
в плане речь только о новых флагах перехода.

## Резервы, проверки, откат и продолжение

- Занят только этот документ задачей `cloud-expenses-live-1112`.
  API/PostgreSQL ещё закреплены за переданной задачей `stage2-candidate-1105`,
  gateway за `desktop-updates-install-1111`; перед записями на VPS принять
  или согласовать эти резервы. Чужие резервы не сняты.
- Текущий этап только чтение и протокол. Новые тесты приложения не запускались;
  успешные проверки прежних выпусков не выдаются за проверки этого кандидата.
- Откат не понадобился: на сервере ничего не менялось.
- Для продолжения нужен исходный архив с указанным SHA-256 либо отдельное
  решение владельца об использовании нового проверенного пакета. Затем свежие
  refs и итог полной CI точной головы (или документированный допустимый
  браузерный отказ), резервы, свежая копия/manifest/restore, репетиция 072-077
  и прав on/off, только после её успеха живое окно по runbook.
- При веб-выпуске сравнить действующий gateway целиком с кандидатом и сохранить
  маршрут каталога обновлений; нельзя вернуть Caddyfile из состояния до 11.11.
- После включения только «Расходов» требуется приёмка владельцем: вход,
  одна введённая сумма и её запись в журнале. Приёмка не выполнена.
- Общий статус, roadmap и онлайн-пульт не менялись; факт установки отсутствует.

Основа: `docs/operations/cloud-expenses-now-1111.md`,
`docs/operations/cloud-1-handover-1110.md` на `24d35e28`.
