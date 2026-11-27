# Выпуск кандидата аудита 0889ca56 в облако (27.11.2026)

Коммит выпуска `0889ca56290811370d572a1c0e917f18c641ed4c`: слияние PR #437 в `codex/cutover-1119`.
Прежний релиз `b91278178a86f9c45d18c8cd1980045593d4dfd1`, порядок как 23.11
([2026-11-23-tiptoppay-live-enable.md](2026-11-23-tiptoppay-live-enable.md)). Время UTC.

Владелец 27.11 ответил на карточки в треде проекта:

- 18:47: «Да, после зелёного CI».
- 18:52: «Выпускай, ленту потом» — про одну упавшую проверку ленты обновлений.

Позже из выпуска убрали миграцию 083 (см. ниже). Других шагов не добавлялось. Секреты в чат,
журналы и репозиторий не выводились. Материалы на сервере:
`/opt/pickchick-staging/rehearsal/audit-candidate-1127`.

## CI на 0889ca56

- Foundation CI, все 11 задач, зелёный. В том числе «Foundation static checks and transaction
  invariants» и «Build, contracts and PostgreSQL integration». Остальные проверки зелёные, всего
  24 из 25.
- Desktop update feed check (run 46036432764) красный, к облаку не относится:
  - первый запуск снят по `timeout-minutes: 20`;
  - перезапуск 18:48 упал: «kitchen: latest.json is not the recorded version and installer».
  - Причина: лента с 27.11 16:16 отдаёт кухню 0.4.11, а запись в репозитории
    (`docs/operations/desktop-updates-published.json` в 0889ca56) — 0.4.10. Установщик 0.4.10
    из ленты уже убран (404).
  - Запись 0.4.11 есть в ветке `codex/desktop-kitchen-0411-1127-record` (e19c4b0a), в
    `codex/cutover-1119` её нет.

## Что сделано

| Время | Шаг                                                                                                             | Результат                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 18:52 | Незавершённых попыток оплаты нет                                                                                | 0                                                                                                      |
| 18:52 | Копия базы `backups/cloud-20261127T185239Z.dump.age` (`current/infra/staging/backup.sh`)                        | SHA-256 `ace1e83d1cd5ce3009719f02c4acd96f2706071a7ee3d4b23ff863f060487501`, 11 241 860 байт, схема 082 |
| 18:53 | `git archive` 0889ca56 → `releases/0889ca56…`                                                                   | SHA-256 архива `2fd94ddd93f2ca148c1945d21649e7e9df8dd26c9c01181f365f6b7c9ce723f6`                      |
| 18:55 | Образ `pickchick-api:0889ca56…` собран на сервере (`infra/staging/Dockerfile`)                                  | id `sha256:e12252cb4b22…`, метка revision совпадает                                                    |
| 18:56 | Миграция 083 через `migrate()`                                                                                  | отказ «Out-of-order migration», ничего не применено (см. ниже)                                         |
| 18:58 | API: `docker compose -p pickchick-staging -f releases/0889ca56…/infra/staging/compose.yaml up -d --no-deps api` | здоров за 12 с, 0 перезапусков                                                                         |
| 18:58 | Воркер: `docker compose -f releases/0889ca56…/tiptoppay-worker.json up -d`                                      | работает, 0 перезапусков, сети `private` и `ingress`                                                   |

Ссылку `current` не переключали: на неё смотрит таймер копий
(`current/infra/staging/backup.sh`), а `backup.sh` в 0889ca56 не менялся.

## Окружение то же

- `releases/0889ca56…/infra/staging/compose.yaml` — копия отрисованного compose релиза b9127817.
  В нём явные значения (это отступление от репозитория, C-09), изменены только две строки
  `image`. Шаблон из git сохранён рядом как `compose.repo.yaml`.
- `tiptoppay-worker.json`: копия, изменена только строка `image`.
- Хеш отсортированного окружения контейнера до и после переключения:
  - API: `9a5b8fdf…f689` = `9a5b8fdf…f689`;
  - воркер: `33d1f4e8…6957` = `33d1f4e8…6957`.
- Не добавлены: `CUSTOMER_FISCAL_ACCOUNT_ID`, `KIOSK_CHECKOUT_FISCAL_ACCOUNT_ID`, `WEBKASSA_*`.
  Воркер Webkassa облака не запускался, роль для него не создавалась.
- Шлюз и входной Caddy не менялись. В diff b9127817→0889ca56 по `infra/domains/pickchick.Caddyfile`
  добавлен только блок `@tiptoppay_live`, который стоит на сервере с 23.11.

## Миграции

- 083 (`commerce_webkassa_receipts`, checksum файла `05049ffbd4fdb3b74b534766fb9cbb2956082d38918ca65c3e6023e0b50cfd98`)
  не применена. `migrate()` её отклонил: в журнале базы 74 записи, и нет
  `078_cloud_app_splash.sql`, а `migrate()` не ставит миграцию ниже последней (082).
- Значит, 082 23.11 ставили в обход `migrate()`.
- API 0889ca56 таблицу 083 не использует: она есть только в `webkassa-cloud.ts`, то есть в воркере
  Webkassa.
- 083 ставится отдельным шагом вместе с запуском воркера Webkassa (после второй боевой кассы).
  Тогда же решить, что делать с 078.
- Журнал после выпуска: последняя 082, 74 записи. База не менялась.

## Проверки

- API: `healthy`, 0 перезапусков, образ 0889ca56. Воркер: работает, 0 перезапусков.
- Снаружи (`https://api.pickchick.kz/v1/integrations/tiptoppay/…`):
  - `GET 3ds` 200;
  - `POST check`, `pay`, `fail` без подписи 401 (form-запрос; без Content-Type 415);
  - `test-pay`, `test-check`, `test-fail` 503, прочие пути 503;
  - `orders/<uuid>/tiptoppay` с неверным токеном 401.
- Бэк-офис `https://pickchick.kz/backoffice/` 200, каталог `/v1/customer-checkout/catalog` 200,
  idrink 200.
- Воркер `--once` в своём контейнере: `checked 0, settled 0, errors 0`, возвраты `sent 0, errors 0`.
- Журнал API с 18:58 по 19:04 без ошибок. Журнал воркера без ошибок.

## Не проверено

- Боевая оплата и возврат по новой версии: новых оплат не было.
- Чеки облака: выключены, заказы по-прежнему `deferred_pilot`.

## Откат

Базу не откатывать.

1. API: `docker compose -p pickchick-staging -f releases/b91278178a86…/infra/staging/compose.yaml up -d --no-deps api`.
2. Воркер: `docker compose -f releases/b91278178a86…/tiptoppay-worker.json up -d`, если нет
   открытых попыток.
