# Публикация центра проекта

Roadmap работает отдельным Node 24 контейнером с SQLite для заметок и приёмки.
Финансовых операций и подключения к бизнес-БД у него нет. Данные проекта входят
в проверенный пакет из Git; совместные заметки лежат вне release, в `/data`.
Обновление исходников не удаляет заметки и ключ команды.

Публичный адрес: `https://pickchick.185.129.51.103.nip.io/roadmap/`.
Сам факт наличия инструкции не означает, что выпуск уже установлен.

## Состав

- `package.py` собирает архив из чистого committed checkout после сборки приложения.
  Пакет содержит только server/model/dist, инструменты выпуска и SHA-256 manifest.
- `remote-deploy.py` запускается на VPS от `pickchick-ops` (UID 1000).
  Без `--apply` выполняет только проверки. С `--apply` изменяет только roadmap
  и `pickchick-public-gateway`; бизнес-API, PostgreSQL, Redis и соседние контейнеры
  проверяет по ID, образу и времени запуска.
- `compose.yaml` использует закреплённый образ Node, read-only приложение,
  ограниченный UID и внутреннюю сеть `pickchick-roadmap_ingress`. К ней подключены
  только roadmap и наш gateway. Внутренний HTTP-порт - `4192`: `4190` блокируется
  стандартным `fetch` как запрещённый порт. Порты хоста и Docker socket не публикуются.

Не заменять действующий gateway конфигурацией из более новой ветки целиком:
в ней могут быть ещё не выпущенные бизнес-маршруты. Инструмент читает фактический
текущий release и добавляет только именованный блок `/roadmap`.
Все прежние публичные файлы и их manifest копируются побайтно. Manifest сохраняет
прежний `source_sha`, поскольку происхождение старых web-компонентов не меняется.
Источник roadmap указан в отдельном package manifest и `/roadmap/health`.

## Подготовка на Mac

Сначала выполнить проверки приложения, собрать `apps/roadmap/dist` из того же
commit и убедиться, что `/roadmap/health` будет возвращать его полный `sourceSha`.
Сборка должна включать необходимые CSS, JS, шрифты и изображения локально.

```sh
roadmap_sha=$(git rev-parse HEAD)
python3 infra/roadmap/package.py \
  --source-sha "$roadmap_sha" \
  --output "/tmp/pickchick-roadmap-$roadmap_sha.tar.gz"
```

Передать архив через существующий SSH-ключ владельца. Сверить напечатанный
SHA-256 на VPS и распаковать в новый приватный входной каталог, например
`/opt/pickchick-staging/roadmap-incoming/<SHA>`. Не распаковывать поверх текущего
release. Выполнять `tar` только для собственного проверенного архива.
Приватные ключи, локальные `.env`, `.local` и `.git` в пакет не входят.

Проверенный SSH host fingerprint на 16 сентября 2026:
`SHA256:Bt3HkaktjLmWe4tB1pOK9b8gOnHuxp+tvp1hhEDtxp8`.
Подключение: `pickchick-ops@185.129.51.103`, ключ
`~/.ssh/pickchick_staging_ed25519`, `IdentitiesOnly=yes`,
`StrictHostKeyChecking=yes`. Ключ не передаётся на VPS.

## Проверка и применение на VPS

Получить фактические targets `public-https/current`, `current` и SHA-256
смонтированного `gateway.Caddyfile`. Передавать проверенные значения явно.
Исходный baseline 16 сентября приведён ниже; для следующего выпуска он изменится.

```sh
python3 /opt/pickchick-staging/roadmap-incoming/FULL_SHA/infra/roadmap/remote-deploy.py \
  --package /opt/pickchick-staging/roadmap-incoming/FULL_SHA \
  --expected-source-sha FULL_SHA \
  --expected-public-release /opt/pickchick-staging/public-https/releases/bc1d1d55594fff40f64cdd0c6065631133be5370 \
  --expected-api-release /opt/pickchick-staging/releases/93b14e7f8491645dcf8ed2aabdd501afc6481a90 \
  --expected-gateway-sha256 11467087c584b7900b0d8484ffaddb816561be62500504fe74d34ffd86562f26
```

Повторить ту же команду с `--apply` после успешной проверки. Применение:

1. Занимает общий `.market-release.lock` с уникальным владельцем и повторяет guards.
2. Создаёт immutable app/public releases; проверяет Caddy в закреплённом образе.
3. При обновлении останавливает только предыдущий roadmap, проверяет остановку
   и копирует **весь** SQLite-каталог вместе с возможными WAL/journal файлами
   в приватный `roadmap/backups`. Бизнес-БД не останавливает и не копирует.
4. Поднимает sidecar и проверяет фактический source SHA, затем переключает gateway.
5. Проверяет SHA-256 каждого старого публичного HTTP-файла, приватные маршруты,
   запрет чтения roadmap без входа, HttpOnly/Secure/SameSite cookie и чтение
   после входа. Проверка входа не создаёт заметок, заказов или приёмочных отметок.
6. Только после успеха меняет public/roadmap pointers атомарными rename.

Командный ключ создаётся на VPS в
`/opt/pickchick-staging/roadmap/secrets/team-key`, mode `0600`, и не выводится
в stdout/логи. Получать его владельцу отдельным защищённым переносом в локальный
файл `0600`, не через URL, Git, публичный документ или открытый журнал команд.
На следующих выпусках существующий ключ сохраняется.

## Возврат и повторный выпуск

При подтверждённой ошибке приложение возвращает прежний gateway и прежний
roadmap, проверяет исходные pointers и неизменность остальных контейнеров.
Заметки автоматически не восстанавливаются из backup: это могло бы затереть
записи пользователей. Обновления должны сохранять совместимость SQLite схемы.
При неудачной первой установке остановленный контейнер удаляется только после
сверки `/app` mount с новым release. Принудительное удаление и удаление volumes
не используются; заметки, ключ и файлы failed release сохраняются.
При timeout Docker или неудачном rollback lock остаётся на месте. Оператор
проверяет фактический процесс, mounts и владельца lock; удалять чужой lock
или считать его протухшим по времени нельзя.

Приватный журнал выпуска: `roadmap/deployments/<SHA>-<id>.json`.
Failed release остаётся неизменным для диагностики; повтор с тем же SHA
не перезаписывает его. После исправления создаётся новый commit/package.
Копии на том же VPS не заменяют независимое хранилище; долговременная политика
резервирования заметок остаётся отдельной операционной задачей.

Следующее обновление проходит тот же package/inspect/apply цикл с новым SHA
и актуальными baseline targets/hash. Никакой GitHub-токен на VPS не требуется:
исходники и evidence обновляются проверенным выпуском из репозитория.

Локальная проверка deployment guards:

```sh
python3 -m unittest discover -s infra/roadmap -p 'test_*.py'
```
