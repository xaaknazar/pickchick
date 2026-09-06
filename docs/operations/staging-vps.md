# Частный staging PickChick

Назначение: инженерный стенд с синтетическими данными. Сервер
`185.129.51.103` (`cloud-002.h-159695.kz`), каталог `/opt/pickchick-staging`.
Фактические ресурсы: Ubuntu 24.04, 4 vCPU, 3914 MiB RAM, `/` 193 GiB.
Адрес ЦОД, оплаченный тариф, SLA и расположение будущих копий нужно подтвердить
в кабинете провайдера; ресурсы не совпадают с прежним предложением PS Basic-4.

## Доступ и границы

Отдельный пользователь `pickchick-ops`; локальный ключ владельца
`~/.ssh/pickchick_staging_ed25519`, mode 600, вне Git. Проверка host key опирается
на уже существовавший known_hosts; сверка через консоль провайдера не выполнена.
Docker group даёт административные возможности на всём хосте. У существующего
idrink собственные контейнеры, PostgreSQL 16 и Caddy; их конфигурация не меняется.
Root-доступ владельца сохранён. Передача root-пароля в чат требует его замены
владельцем после проверки доступа через ключ/консоль; не хранить его в GitHub.

```sh
ssh -i ~/.ssh/pickchick_staging_ed25519 -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes \
  -N -L 127.0.0.1:13100:127.0.0.1:13100 pickchick-ops@185.129.51.103
# В другом терминале:
curl --fail http://127.0.0.1:13100/health/ready
curl --fail http://127.0.0.1:13100/v1/branches
```

Туннель шифрует транспорт и требует SSH-ключ. Публичного сайта/бэк-офиса пока
нет. На host опубликован только loopback 13100; PostgreSQL/Redis — без ports.
У API также есть отдельный ingress bridge для публикации host-порта; БД и Redis
к нему не подключены. Это соответствует [правилам Docker о публикации портов](https://docs.docker.com/engine/network/port-publishing/).
На проверенном сервере Docker 29.7.2, а не версии до 28 с известной оговоркой
про loopback в общем L2. Проверять внешнее подключение после изменений сети.

## Релиз

`releases/<40-char SHA>` — исходники из `git archive` проверенного коммита,
без `.git`, `.env`, локальных ключей и node_modules. Образ собирается с
`--build-arg RELEASE_SHA=<SHA> -t pickchick-api:<SHA>` и закреплёнными базовыми
image digests. `release.env` содержит только RELEASE_SHA. Секреты генерируются
один раз `infra/staging/generate-secrets.py /opt/pickchick-staging/secrets`
до добавления backup recipient; скрипт не перезаписывает существующий каталог.
`staging.env` mode 600, каталог 700. Redis config 644 внутри 700-каталога
нужен UID Redis для bind mount. Docker administrators могут читать эти секреты.

Команды ниже выполняются на VPS в конкретном `releases/<SHA>`:

```sh
dc() {
  docker compose --env-file /opt/pickchick-staging/secrets/staging.env \
    --env-file ./release.env -f infra/staging/compose.yaml "$@"
}
dc up -d --wait cloud-db redis-cache
dc run --rm provision                 # owner migrations + runtime grants
dc run --rm provision                 # проверка повторяемости
# Только первый запуск синтетического стенда:
dc run --rm provision node scripts/seed.mjs --cloud-only
dc up -d --wait api
dc run --rm provision node infra/staging/smoke.mjs
```

Smoke ротирует ключ исключительно синтетического устройства seed; он не
предназначен для окружения с зарегистрированным реальным edge. Проверяет
readiness, закрытый приём заказов, 401 без авторизации, авторизованный pull,
запрет DDL, выдачи статуса устройства и изменения migration ledger для runtime.
Ключ smoke не печатается и не сохраняется. Применение меню на физическом edge,
отказ WAN и полноценный remote enrollment в этот smoke не входят.

Переключать `current` на этот release только после успешных проверок. Не
использовать `docker system prune`, `down --volumes` и рестарт общего Docker
на этом VPS. Compose автоматически поднимает свои сервисы после restart хоста;
сам reboot из-за действующего idrink требует согласованного окна обслуживания.

## Копии и восстановление

`infra/staging/backup.sh`: pg_dump custom без owner/ACL → age public-key encryption
→ atomic rename + SHA256; хранение 7 дней. Timer: 02:15 UTC ежедневно с jitter
до 5 минут. `systemctl status pickchick-backup.timer` и
`journalctl -u pickchick-backup.service` проверяют расписание и результат.
Не путать статус timer с успешным выполнением последней копии.

Приватный age-ключ хранится на компьютере владельца в
`.local/vps/backup-identity.agekey`, mode 600. На VPS только публичный recipient
`secrets/backup-recipient.txt`. Владельцу нужно отдельно сохранить приватный
ключ в собственном защищённом хранилище; без него копии не расшифровать.

Для drill: проверить SHA256, расшифровать поток с приватным ключом, направить
его в `pg_restore --exit-on-error --no-owner --no-acl` в **новую отдельную БД**
`pickchick_restore_<timestamp>`. Сравнить migration ledger, количество и содержимое
меню/точек, закрытый режим, затем удалить только эту drill БД. Не восстанавливать
поверх рабочей БД. Private key подавать через SSH stdin в `age --identity /dev/stdin`,
не записывая его на VPS. Точные результаты первого drill записываются в deployment record.

Копии на том же VPS не переживут потерю VPS. Независимое хранилище в Казахстане
ещё не предоставлено; remote backup, внешние алерты, WAL/PITR, HA и production
RPO/RTO не настроены. Этот стенд нельзя использовать для реальных клиентов.

## Откат и обслуживание

До нового deploy: зелёный CI конкретного SHA, backup, проверка изменений миграций,
совместимости старого образа с новой схемой и свободной памяти/диска. Для отката
совместимого приложения выбрать прошлый `release.env` и выполнить `dc up -d --wait api`,
проверить smoke и переключить `current`. Не понижать миграции автоматически.
Первый релиз не имеет предыдущего backend: остановка только `dc stop api`
закрывает стенд, сохраняя БД. При повреждении схемы — отдельная restore БД и
проверенное переключение, а не удаление тома.

Остановить rollout при readiness 503, сбое прав/401 smoke, нарушении доступа
только через SSH, ухудшении работы idrink или ошибке backup. Учесть 188 ожидавших
обновлений пакетов и reboot-required на момент первичного осмотра; обновление
общего хоста планируется вместе с обслуживанием idrink.

Первый запуск: [проверенный deployment record](deployments/2026-09-06-staging.md).
