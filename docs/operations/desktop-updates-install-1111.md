# Каталог обновлений: установка 11 ноября 2026

**DEPLOYED.** Установка с доверенного Mac завершена 11.11.2026 около
20:10 UTC+5. Итоговая проверка сервера и нового SSH-подключения выполнена
в 20:14:55 UTC+5. Первый каталог: **POS 0.5.0, Kitchen 0.4.0**.
Предыдущий облачный запуск ниже сохранён как история; его блокер снят доступом
с доверенного Mac. Повторно запускать `install` не требуется.

## Статус и границы выполненного шага

- Установлен точный коммит `46453717a01ece038c5653db202f9f059536cd64`
  из PR #352, исходники не менялись и ветки не сливались.
- Созданы контейнер каталога, маршрут в `pickchick-public-gateway` и публичный
  выпуск с прежним `public-web`. Шлюз пересоздан один раз штатным установщиком.
- Порты 80/443 держит `deploy-caddy-1`, Compose из `/opt/idrink/deploy`.
  Его конфигурация и контейнер не менялись. Маршрут к шлюзу подтверждён
  `feed_host_reaches_gateway=true` до и после установки.
- API остался на `6630eb0f676350341806b735b6877a36f017c673`.
  БД, данные приложения, касса и кухня на устройствах не изменялись.
- Ключ `pickchick-claude-mac-20261110` удалён из `/root/.ssh/authorized_keys`.
  Новый SSH-вход доверенным ключом от `pickchick-ops` проверен, UID1000.
- После установки `.market-release.lock` отсутствует. Откат не понадобился.

## Подготовка и доказательства

Работа выполнена по прямому разрешению владельца на 11.11 в любое время.
Задача `desktop-updates-install-1111` принята на этом Mac с резервами
`@vps/desktop-updates`, `@vps/public-https/gateway`, `@vps/ssh-access` и этого
протокола. Перед применением проверены свежие refs, отсутствие других операций,
свободная блокировка и отсутствие конфликтующих immutable-каталогов.
`pnpm project:check` ограничен локальным несовпадением версии pnpm
(11.25.0 вместо требуемой 11.19.0); его штатный скрипт запущен непосредственно
через `node scripts/project-sync.mjs check`, настройки проекта не менялись.

Пакет заново собран штатным `package.py` из чистого detached checkout точного
коммита. Архив `/tmp/desktop-updates-46453717.tar.gz`, SHA-256:

```text
a2866724b9fbcc4c040423fa37489231c5b9a86bc19e3648fcb151d3b2f97108
```

Он отличается от архива прежней облачной подготовки; использован и передан
именно новый архив с этим хешем, повторно сверенным на сервере. Проверка
содержимого пакета по manifest и исходному коммиту прошла.

Серверный staging-каталог:
`/opt/pickchick-staging/incoming/desktop-updates-46453717-1111-mac/`.
В нём архив, `package/` и `feed/{pos,kitchen}/`. Установщики из указанных
владельцем артефактов повторно скачаны; SHA-256 обоих ZIP, размеры и SHA-256
EXE совпали с исходными значениями из таблицы исторической подготовки ниже.
EXE на Mac не запускались. Оба manifest используют `apply=idle`.

### Inspect до установки и параметры install

До применения получены `gateway_route_installed=false`,
`feed_container=false`, `feed_host_reaches_gateway=true`,
`deployment_lock_present=false`, `next_step=install`.
Значения переданы в dry-run и apply без подстановки старых предположений:

```json
{
  "expected_public_release": "/opt/pickchick-staging/public-https/releases/c3a0fbeea69e3c94b4a0994f5cdee74ba98c77da",
  "expected_api_release": "/opt/pickchick-staging/releases/6630eb0f676350341806b735b6877a36f017c673",
  "expected_gateway_sha256": "c603c640458f791ad0c19430ab3fd1e344dcc9f1448fbf99357524368e5fa520",
  "expected_source_sha": "46453717a01ece038c5653db202f9f059536cd64",
  "expected_pos_sha256": "1edcee5f760dd8c29ed5e3e37e5ca1fb95723227b11a96a5c74fc2cbc080f65c",
  "expected_kitchen_sha256": "554341cc062d30cdb3e5a457ac54f0fe7f25870273269197a03b6f3159b59679"
}
```

Проверка без `--apply`:

```json
{
  "action": "install",
  "source_sha": "46453717a01ece038c5653db202f9f059536cd64",
  "feed_release": "kitchen-0.4.0-pos-0.5.0",
  "published": {
    "kitchen": "0.4.0",
    "pos": "0.5.0"
  },
  "status": "inspected",
  "validated": true,
  "applied": false
}
```

### Полная строка ответа install --apply

```json
{
  "action": "install",
  "source_sha": "46453717a01ece038c5653db202f9f059536cd64",
  "feed_release": "kitchen-0.4.0-pos-0.5.0",
  "published": { "kitchen": "0.4.0", "pos": "0.5.0" },
  "status": "deployed",
  "phase": "publish_pointers",
  "public_release": "/opt/pickchick-staging/public-https/releases/46453717a01ece038c5653db202f9f059536cd64",
  "previous_public_release": "/opt/pickchick-staging/public-https/releases/c3a0fbeea69e3c94b4a0994f5cdee74ba98c77da",
  "gateway_sha256": "717a9d216fe782a69c7c6ee77a0cdd15b4522c2158e8650fc0885f880b283ba8",
  "unchanged_services": [
    "pickchick-staging-api-1",
    "pickchick-roadmap",
    "pickchick-kitchen-portal",
    "pickchick-kaspi-worker",
    "pickchick-kiosk-kaspi-qr-worker",
    "pickchick-staff-login",
    "pickchick-staff-login-backup-59f0c0d98a6d",
    "pickchick-staff-login-backup-4caca195a4a5",
    "pickchick-staff-login-backup-ab73aae4d5ab",
    "pickchick-staff-login-backup-661f84c20b47",
    "pickchick-staff-login-backup-d379075bf678",
    "pickchick-staff-login-backup-f01cb45f441d",
    "pickchick-staff-login-backup-8468e3aed72c",
    "pickchick-kaspi-bridge",
    "pickchick-staff-login-backup-23fb39e152fc",
    "pickchick-staff-login-backup-3f55929a0f17",
    "pickchick-staging-cloud-db-1",
    "pickchick-staging-redis-cache-1",
    "deploy-server-1",
    "deploy-caddy-1",
    "deploy-db-1"
  ]
}
```

### Проверки снаружи и итоговый inspect

`curl -sI` с Mac, 11.11.2026 15:10:29 UTC (20:10:29 UTC+5):

```text
https://api.pickchick.kz/desktop-updates/pos/latest.json
HTTP/2 200
cache-control: no-store

https://api.pickchick.kz/desktop-updates/kitchen/latest.json
HTTP/2 200
cache-control: no-store

https://api.pickchick.kz/desktop-updates/
HTTP/2 404
cache-control: no-store
```

Штатный install дополнительно прочитал оба полных установщика через публичный
HTTPS частями по 4 МБ и сверил размер/SHA-256; проверил прежние публичные файлы,
запреты маршрута, API pointer и неизменность остальных контейнеров.
Повторный inspect после применения:

```json
{
  "status": "inspected",
  "expected_public_release": "/opt/pickchick-staging/public-https/releases/46453717a01ece038c5653db202f9f059536cd64",
  "expected_api_release": "/opt/pickchick-staging/releases/6630eb0f676350341806b735b6877a36f017c673",
  "expected_gateway_sha256": "717a9d216fe782a69c7c6ee77a0cdd15b4522c2158e8650fc0885f880b283ba8",
  "gateway_route_installed": true,
  "feed_container": true,
  "published_release": "kitchen-0.4.0-pos-0.5.0",
  "published": {
    "kitchen": "0.4.0",
    "pos": "0.5.0"
  },
  "releases_on_disk": ["kitchen-0.4.0-pos-0.5.0"],
  "feed_host_reaches_gateway": true,
  "free_disk_mb": 130566,
  "deployment_lock_present": false
}
```

### Cloud-1 после изменения публичного указателя

Повторён `infra/staging/cloud1-preflight.py --check-github` из точного
checkout, exit0:

```json
{
  "status": "CANDIDATE_GATE_ONLY",
  "candidate": "b922fc1ec248d08f4cdae3e915c33c57bf9f771a",
  "foundationRun": 43028287464,
  "jobs": 11,
  "deployed": false,
  "rehearsalVerified": false,
  "liveWindowVerified": false
}
```

Это успешная предварительная проверка кандидата и 11 заданий Foundation,
не квитанция развёртывания Cloud-1 и не проверка его live-window/репетиции.
Режим `--check-github` не читает серверные указатели; фактический новый public
release и неизменный API release отдельно подтверждены inspect выше и повторным
SSH-чтением в 20:14:55 UTC+5. Перед будущим окном Cloud-1 нужно брать новый
публичный baseline, а не `c3a0fbee...`.

### Отзыв SSH-ключа

Удалена ровно одна запись с меткой `pickchick-claude-mac-20261110`.
Отпечаток удалённого публичного ключа:

```text
SHA256:dHSUTi28zyVh/g2LJSiAoF4uwOAXcizqxNhP7feUVnU
```

Файл `/root/.ssh/authorized_keys` заменён атомарно с проверкой исходного хеша
перед записью. Остальные байты, владелец root:root и режим0600 сохранены;
метка и ключ после записи отсутствуют. В `pickchick-ops/authorized_keys`
этого ключа также нет. Для доступа к root-файлу использован уже доступный
оператору Docker: существующий образ шлюза, без сети и загрузки образов,
read-only корневая ФС, без capabilities, единственная запись в `/root/.ssh`.
Приватные ключи не читались, не копировались и не выводились.
Отдельное новое SSH-соединение без переиспользования старой сессии успешно.

## Результат тестов, откат и продолжение

- `TMPDIR=/private/tmp/pickchick-desktop-updates-tests-1111 python3 -m unittest
tests/operations/test_desktop_updates_release.py`: **21/21 PASS**, 0.310s.
  Первый запуск со стандартным Mac TMPDIR встретил защиту от symlink в
  `/var` -> `/private/var`; повтор в физическом каталоге прошёл без правок кода.
- `verify_package`, `verify_feed`, server inspect, install dry-run, apply и
  встроенные проверки после установки прошли. Внешние HEAD и повторный
  Cloud-1 preflight прошли. Другие приложения/контейнеры не перезапускались.
- Полная новая CI для исходников здесь не заявляется. Известный сетевой сбой
  apt у исполнителей GitHub, задержавший PR #352, разрешён владельцем как
  исключение именно для установки этого точного коммита.
- Откат не выполнялся. Установщик имеет автоматический откат при провале
  своих проверок; штатного удаления уже установленного маршрута/контейнера
  у него нет. Не запускать `install` повторно. Отзыв будущих версий делается
  через `withdraw` на существующий предыдущий feed release; сейчас это первый
  каталог. Удалённый чужой SSH-ключ не восстанавливать.
- Следующий отдельный этап по runbook: включение адресов каталога в сборках,
  ручная установка на устройства и проверка перехода на следующую версию.
  Автообновление на моноблоках ресторана этой установкой не принято.
- Общие `docs/project-status.md`, `docs/roadmap/project.json` и онлайн-пульт
  этим шагом не менялись: они закреплены за другой задачей. Протокол сохранён
  в ветке `codex/desktop-updates-install-1111`; его перенос в общий срез и
  синхронизация статуса остаются отдельным шагом. Дополнительный публичный
  релиз для пульта в рамках этой установки не выполнялся.

Локальные квитанции этой сессии сохранены в
`~/Library/Caches/PickChick/desktop-updates-1111-mac/`; общая память двух Mac -
этот протокол в GitHub, с фактическими значениями и результатами выше.

## История: облачная подготовка до доступа с Mac

Следующий блок сохранён как запись предыдущей попытки, до успешной установки.
Все статусы BLOCKED и «не выполнено» в нём относятся только к той попытке.

## Каталог обновлений: подготовка 11 ноября 2026

**PREPARED_ONLY / BLOCKED: серверная установка не выполнена.** Проверено
11.11 около 19:50 UTC+5. Владелец разрешил установку сегодня в любое время,
без БД, с однократным пересозданием `pickchick-public-gateway`. Повторного
разрешения на это действие не требуется. Условие остановки сохраняется:
если feed host не приводит к gateway либо нужен чужой Caddy, спросить владельца.

### Подготовленные исходники и файлы

- Чистый detached checkout `46453717a01ece038c5653db202f9f059536cd64`,
  `/workspace/pickchick-desktop-updates-46453717`. Код не изменялся.
- Пакет собран штатным `infra/desktop-updates/package.py`:
  `/tmp/desktop-updates-46453717.tar.gz`, четыре файла исходников и manifest.
- SHA-256 архива:
  `bb2213a0a10b7215895eac31eee1c87c9ce956552ba699b3938f78c05e5283ae`.
- Распакованный пакет и feed находятся локально в
  `/workspace/pickchick-evidence/1111/desktop-updates/{package,feed}`;
  квитанция `prepared.json` там же. Эти файлы ещё не переданы на VPS.
- `verify_package` и `verify_feed` из распакованного точного пакета прошли.
  `next_release=kitchen-0.4.0-pos-0.5.0`; оба manifest используют `apply=idle`.

| Программа | Run / artifact            | Версия | Размер EXE | SHA-256 EXE                                                        |
| --------- | ------------------------- | ------ | ---------: | ------------------------------------------------------------------ |
| POS       | 43028287215 / 13859277085 | 0.5.0  |  172279820 | `1edcee5f760dd8c29ed5e3e37e5ca1fb95723227b11a96a5c74fc2cbc080f65c` |
| Kitchen   | 43028287205 / 13858842282 | 0.4.0  |  120891835 | `554341cc062d30cdb3e5a457ac54f0fe7f25870273269197a03b6f3159b59679` |

Оба артефакта относятся к `b922fc1ec248d08f4cdae3e915c33c57bf9f771a`, не
просрочены. Размеры и SHA-256 ZIP совпали с GitHub metadata:

```text
pos.zip 172305550 e8cd074497ecece406a41b51d6b6c6db8431ad18da3658ee1531c9397d78053b
kitchen.zip 120903563 acf81d8edb68b2e009274875f32ee5654a6b2b64186893ec3901ef29193febe5
```

Скачивание через `gh api .../zip` получило отказ на временном URL; штатный
GitHub connector скачал оба артефакта. После получения полные ZIP и EXE
сверены локально; подписанные временные ссылки в протокол не включены.
Архивы распакованы с проверкой путей/ссылок, EXE не исполнялись.

### Проверки до установки

`python3 -m unittest tests/operations/test_desktop_updates_release.py`:
**21/21 PASS** без пропусков. Дополнительно независимо просмотрены guards
установщика и условия отката. Новая Docker-репетиция здесь не запускалась.

Внешняя проверка около 14:50 UTC, это **baseline до установки**:

```text
GET  https://api.pickchick.kz/health/live
     {"service":"pickchick-public-gateway","alive":true,"environment":"staging"}
HEAD https://api.pickchick.kz/desktop-updates/pos/latest.json      404, cache-control: no-store
HEAD https://api.pickchick.kz/desktop-updates/kitchen/latest.json  404, cache-control: no-store
HEAD https://api.pickchick.kz/desktop-updates/                     404, cache-control: no-store
```

Это подтверждает публичный health-маршрут, но не владельца портов 80/443,
server-side `inspect`, состояние lock и возможность нового маршрута через
внешний Caddy. Значения `expected_public_release`, `expected_api_release`,
`expected_gateway_sha256` **не получены**, прошлые значения не подставлялись.

Cloud-1 GitHub preflight выполнен до установки из точного checkout:

```json
{
  "status": "CANDIDATE_GATE_ONLY",
  "candidate": "b922fc1ec248d08f4cdae3e915c33c57bf9f771a",
  "foundationRun": 43028287464,
  "jobs": 11,
  "deployed": false,
  "rehearsalVerified": false,
  "liveWindowVerified": false
}
```

PR352 на момент проверки открыт, head46453717; cutover остаётся b922fc1e.
Слияние не выполнялось. Пакет соответствует прямо указанному владельцем
коммиту, а не незаконченной/предполагаемой merge-голове.

### Блокер и точное продолжение

В выбранной облачной среде нет secret bindings, SSH-агента или настроенного
SSH-каталога; `vpn_configured=false`, TCP grants отсутствуют. Доступ другого
Mac из протокола Cloud-1 не перенесён в эту среду. У владельца запрошено
подключение через приватные настройки либо продолжение на доверенном Mac.
Пароли и приватные ключи в чат не запрашивались.

Дополнительная проверка после ответа владельца: TCP `185.129.51.103:22`
отклонён с `ConnectionRefusedError`, errno111 и в штатной песочнице, и в
одобренной проверке вне неё. Проверялось только соединение/SSH banner,
аутентификация не начиналась. Это не проверка правильности пароля и не
доказательство причины отказа на стороне VPS. Приватные данные не записаны
в этот протокол, исходники или Git. Сохраняется необходимость рабочего
SSH-маршрута с доверенного компьютера либо через настроенную сеть среды.

Не выполнены: SSH-проверка портов и lock, передача файлов, `inspect`, dry-run,
`install --apply`, проверки после установки и удаление SSH-ключа
`pickchick-claude-mac-20261110`. **Ключ нельзя считать отозванным.**

После появления доступа, без нового согласования уже разрешённой установки:

1. Получить свежие refs и ProjectSync; занять соответствующие серверные ресурсы.
   Сейчас зарезервирован только этот документ, рабочие серверные области не заняты
   данной задачей. Сохранить чужие резервы; разрешение владельца распространяется
   на конкретный gateway/feed шаг, не на изменение API/БД/чужого Caddy.
2. От `pickchick-ops` UID1000 только чтением проверить отсутствие других работ
   и `.market-release.lock`, владельца 80/443 и Compose labels обнаруженного Caddy.
3. Передать архив/feed, распаковать и проверить SHA архива на сервере. Выполнить
   `inspect` по runbook и проверить `feed_host_reaches_gateway=true`,
   `gateway_route_installed=false`, `next_step=install`, lock отсутствует.
4. Получить свежие `expected_*`. До `--apply` отдельно проверить отсутствие
   immutable targets: `public-https/releases/46453717…`,
   `desktop-updates/sidecar/46453717…` и
   `desktop-updates/feed/releases/kitchen-0.4.0-pos-0.5.0`.
   Dry-run не проверяет эти конфликты до получения lock в apply; при конфликте
   ничего не удалять, разбирать причину.
5. Install без `--apply`, затем та же команда с `--apply`, все ожидаемые SHA
   по исходному поручению. При `rolled_back` сохранить ответ и разобрать причину.
   При `uncertain`/`rollback_needs_review` не повторять и не снимать lock.
   Внешний `status=failed` может быть менее подробен, чем deployment journal:
   проверить соответствующий `desktop-updates/deployments/install-*.json`.
6. Проверить оба latest снаружи:200/no-store; каталог404. Повторить server inspect
   и Cloud-1 preflight. GitHub-режим Cloud-1 сам не читает публичный pointer,
   поэтому новый public release/gateway SHA фиксируются отдельно, API прежний.
7. Удалить именно ключ с меткой `pickchick-claude-mac-20261110` из соответствующего
   `authorized_keys`, сохранив остальные записи и права. Проверить отсутствие
   целевого ключа и работу доверенного доступа. Записать факт только после проверки.
8. Опубликовать строку ответа install, фактические expected_*, curl и отзыв ключа.

Инструкция: [desktop-updates.md точного46453717](https://github.com/xaaknazar/pickchick/blob/46453717a01ece038c5653db202f9f059536cd64/docs/operations/desktop-updates.md).
Окно из runbook заменено прямым решением владельца: **11.11, любое время**.
Этот checkpoint не является квитанцией `deployed`; сервер не менялся.
