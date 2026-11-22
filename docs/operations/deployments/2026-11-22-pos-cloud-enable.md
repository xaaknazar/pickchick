# Облачный приём POS sync тестовой кассы - 22.11.2026

## Статус

По поручению владельца облачная привязка POS sync создана, два флага включены.
Касса, её Install/Verify, её папка владельца и устройство не изменялись.
Аккаунта туннеля `pickchick-pos-link` нет: нужна команда от root. У
`pickchick-ops` нет sudo; обход через Docker не выполнялся. Без этого шага
работа туннеля с кассы и доставка очереди ещё не подтверждены.

Окно завершено в 17:10:26 Алматы (`2026-11-22T12:10:26Z`). Собственная
блокировка снята после проверок, `/opt/pickchick-staging/.market-release.lock`
отсутствует. Приватные исходные настройки и JSON-результаты находятся в
`/opt/pickchick-staging/pos-cloud-enable-20261122/` (каталог 0700).

API сохранён на `b48fcd38f1158b9564766c8d594f385598976634`, образ
`sha256:0e57913de7d8d4eb23c9428d77e03afe8eedd871b42da51c74c8fa0fda4e69b6`.
[Foundation CI 44804971188](https://github.com/xaaknazar/pickchick/actions/runs/44804971188)
этого SHA - success. Новый образ и миграции не устанавливались.

## Туннель

- `getent passwd pickchick-pos-link` не вернул запись.
- `/etc/ssh/sshd_config.d/60-pickchick-pos-link.conf` отсутствует.
- `sudo -n -l` не предоставил root-доступ.
- Эффективная конфигурация `sshd -T` и ключ отсутствующего аккаунта не
  подтверждены. Нельзя выдавать требуемые значения за результат проверки.
- Владелец запускает подготовленную Claude команду от root на базе
  `infra/staging/install-edge-tunnel-account.sh`, с именем `pickchick-pos-link`
  и ровно публичным ключом из задания. Затем проверить `permitopen
127.0.0.1:13100`, `allowtcpforwarding local`, `maxsessions 0`, `permittty no`
  и единственный разрешённый ключ. Другие SSH-аккаунты не менять.

## Резервная копия

До записи привязки и прав выполнена та же команда, что у
`pickchick-backup.service`: `/bin/bash /opt/pickchick-staging/current/infra/staging/backup.sh`.

- Дамп: `/opt/pickchick-staging/backups/cloud-20261122T115942Z.dump.age`.
- SHA-256: `97003ce485d6a31db1d0898eed2ace6e5de04f96b4745237f19db722e2d94361`.
- Манифест: `/opt/pickchick-staging/backups/cloud-20261122T115942Z.manifest.json.age`.
- Штатный статус: `ok=true`, `lastSuccessAt=2026-11-22T11:59:42Z`.
- `restore-drill.py dump` - `ok=true`, `checksum=verified`, `problems=[]`,
  7679 строк, последняя миграция `081_cloud_kiosk_branch_settings.sql`.
  Восстановление выполнено в отдельном контейнере без сети; рабочая база
  не восстанавливалась. Приватный age-ключ передан только через stdin,
  на VPS не сохранялся.

## Привязка

Активное edge-устройство и точка проверены до записи. Его credential действует
до `2026-12-20T14:47:06.296565Z`. Существующая привязка Fulfillment имеет
отдельный producer `a01235d0-da5c-4cf8-9ecc-a7039c1fd5df`; она не изменялась.
Конфликтующей POS-привязки до установки не было.

Из установленного API выполнен `scripts/pos-order-sync-setup.mjs cloud`
под владельцем базы. Вход содержал только четыре ID, mode 0600. Временные
файлы на сервере и в контейнере удалены после вызова. Вывод:

```json
{
  "event": "pos_order_sync_binding_saved",
  "side": "cloud",
  "organizationId": "caa63701-a8be-41b0-a03a-e9a08c9d1834",
  "branchId": "7a6f6d98-395d-4462-b5e4-b0364a4a8ec1",
  "deviceId": "2fd08ecf-5e62-4e58-8439-e2353b79ef9b",
  "producerId": "8ab9525c-bd8c-4b19-8e24-fd65963369d5"
}
```

Последующее чтение базы подтвердило те же ID и `active=true`.

## Права приёмника

До включения у API не было прав записи на POS sync и 073. Одних флагов
недостаточно. Применены точные helpers из установленного релиза в транзакции:

- `posSyncReceiverGrants('pickchick_app', 'public', {restoreReview: true})`:
  чтение идентичности/привязки/проекций; запись inbox и проекций; обновление
  только разрешённых столбцов проекций и столбцов блокировки;
  SELECT/INSERT на `pos_kitchen_restore_conflicts` для установленной 072.
- `cloudPosSalesGrants('pickchick_app', {receiver: true, backoffice: true})`:
  права приёмника семи таблиц 073. `assertCloudPosSalesPrivileges` подтвердил
  точный набор. Старые права чтения кабинета сохранены.

Снимок ACL до изменения сохранён приватно. Изменились только 15 ожидаемых
таблиц, остальные 204 отношения имеют прежние ACL; состав отношений прежний.
Полный `provision.mjs`, который перенастраивает другие функции, не запускался.

## Флаги и пересоздание API

Фактический источник флагов - JSON Compose-файл:
`/opt/pickchick-staging/releases/b48fcd38f1158b9564766c8d594f385598976634/infra/staging/compose.yaml`,
`services.api.environment`. В `release.env` и `secrets/staging.env` этих
переменных не было; эти файлы не изменены.

| Переменная                     | Было    | Стало  |
| ------------------------------ | ------- | ------ |
| `CLOUD_POS_ORDER_SYNC_ENABLED` | `false` | `true` |
| `CLOUD_POS_SALES_SYNC_ENABLED` | `false` | `true` |

До замены сравнили разрешённую Compose-конфигурацию: отличались ровно два
значения. После пересоздания сравнили окружение контейнера: ровно те же
два изменения, образ прежний.

- Начало пересоздания: `2026-11-22T12:03:26.863068Z`.
- API запущен: `2026-11-22T12:03:37.367054834Z`, 17:03:37 Алматы.
- Пересоздан только API: `up -d --no-deps --force-recreate --pull never api`.
- 13 остальных контейнеров сохранили ID и время старта.
- SHA-256 Compose до:
  `eca71b9eeb24fb5dab9a6eeccfe15169582ac96f6324b01a4214cdf83e961377`.
- SHA-256 Compose после:
  `70d0522fe1d21e78acf9ce520abcd3ebccb4c147e00a538ae107aa4c0725d90f`.

## Проверки

- Наблюдение после включения: 21 проба за 300,8 секунды, все 200/ready,
  тот же контейнер, `RestartCount=0`, Docker health `healthy`.
- `http://127.0.0.1:13100/health/ready` - 200, `ready=true`, `degraded=false`,
  database/schema/redis `up`.
- Пустая проба `POST /internal/v1/edge/pos-orders/sales` без identity - 401.
  Авторизованную пробу с настоящим ключом выполнит служба кассы.
- `https://api.pickchick.kz/health/live` - 200, шлюз отвечает.
- `https://api.pickchick.kz/desktop-updates/pos/latest.json` - 200,
  `Cache-Control: no-store`, версия `0.5.6`, установщик 172282918 байт,
  SHA-256 `b1e82d75c1c3017e2625435fa43cd668aa974ad3bc5dddbe1bfe33b72943675b`.
- Публичные `/health/ready` и `/internal/v1/edge/pos-orders/sales` - 404,
  как предусмотрено закрытым ingress; private readiness доступен через loopback.
- После включения у точки в inbox 0 POS-событий и 0 кухонных событий.
  Ожидаемые 7 + 55 не объявляются доставленными до Install/Verify на кассе.

## Откат

На VPS сохранён `/opt/pickchick-staging/pos-cloud-enable-20261122/rollback.py`.
SHA-256: `38c664538a7e02b307bf2991d5c1b79fd4c5c7f7368d8201066a53c5180ef95f`.
Предварительная проверка без изменения флагов прошла: `status=ready`.
Он проверяет текущий релиз, образ и точный хеш Compose, получает отдельную
блокировку, возвращает оба флага в `false`, пересоздаёт только API и проверяет
readiness. При расхождении или ошибке останавливается; чужую блокировку не снимает.

В согласованном окне от `pickchick-ops`:

```sh
python3 /opt/pickchick-staging/pos-cloud-enable-20261122/rollback.py
python3 /opt/pickchick-staging/pos-cloud-enable-20261122/rollback.py --apply
```

Привязка, inbox, проекции и права остаются. Очередь кассы не удалять.
Исходный Compose: `/opt/pickchick-staging/pos-cloud-enable-20261122/compose.before.json`.
Восстановление всей рабочей базы из дампа для отключения флагов не требуется.

## Дальше

1. Владелец выполняет подготовленную команду создания туннельного аккаунта
   от root, затем проверяются эффективная SSH-политика и ключ.
2. Claude выполняет Install и Verify службы на кассе.
3. Проверить authenticated probe `posSales`, доставку всех 62 событий,
   отсутствие повторов/ошибок и опустошение исходной очереди. Это ещё
   не подтверждено текущим облачным шагом.

Общие status/roadmap закреплены за `desktop-kitchen-046-1117`; они и онлайн-пульт
этим точечным окном не перезаписывались. Факты установки сохранены здесь для
последующего согласованного включения в общий статус.
