# Локальная репетиция развёртывания каталога — 2026-09-07

Результат: **PASS** для замороженного исходного кода
`733edaf9b2d6ac3ebf1de0862caa6f8c02912bab`. Это реальный локальный Docker build,
PostgreSQL, Redis, API и Caddy; VPS и внешние провайдеры не использовались.
Последующие изменения инфраструктуры требуют отдельной проверки.

## Проверенная конфигурация

- Docker Compose v5.3.0, локальный context `desktop-linux`.
- Образ собран штатным `infra/staging/Dockerfile` с `RELEASE_SHA` выше.
  Image ID: `sha256:9a1fe58870988f2e4ef7e382ae11dc1035184fbe225eed87ca4362b3497e1814`;
  OCI revision label совпал с исходным SHA.
- Использованы закреплённые в Compose PostgreSQL 18.3, Redis 8.2.1,
  Caddy 2.11.4. Runtime API: пользователь `node`, read-only rootfs, `cap_drop: ALL`.
- `CATALOG_ADMIN_ENABLED=true`, `CUSTOMER_AUTH_ENABLED=false`,
  `TEST_ORDER_FLOW_ENABLED=false`; runtime БД — `pickchick_app`,
  миграции/служебная очистка — `pickchick_owner`.
- Уникальные проекты `pickchick-deploy-9334b5dcc0` и
  `pickchick-deploy-9334b5dcc0-public`, собственные сети/том/случайные секреты.
  HTTP опубликован только на случайных loopback-портах. Подменён только адрес
  сети/имя контейнера; Caddyfile и код API не изменялись.

## Результаты

| Проверка                                | Фактический результат                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker build                            | PASS; установка по frozen lockfile и сборка workspace внутри образа                                                                                |
| Provision / migrate дважды              | Первый запуск применил 001–012; повтор вернул `applied: []`                                                                                        |
| Готовность при запуске и после рестарта | API/БД/Redis healthy, `/health/ready` 200, `degraded=false`                                                                                        |
| TEST grants включить → выключить        | При provision с TEST=true все 9 UPDATE-grants присутствуют; после false все сняты, проверено `has_column_privilege`                                |
| Ограниченная runtime-роль               | Отказ DDL, правке migrations, чтению identity/TEST/commerce/loyalty, изменению manager token/membership, удалению publication и включению ordering |
| Авторизация менеджера                   | Без токена 401; назначенная точка доступна, чужая 403; после owner-revoke 401                                                                      |
| Реальный catalog controller через Caddy | Seed 24 SKU; непроверенный draft нельзя публиковать (409); edit → publish v1 → точный replay успешны                                               |
| Неизменность публикации                 | После новой правки draft=501000, public и published snapshot остаются 500000 minor units, v1                                                       |
| Доставка редактора                      | `/backoffice` 308; `/backoffice/`, `app.js`, `styles.css` 200; ожидаемый `X-PickChick-Data: catalog`                                               |
| Закрытые функции                        | Capabilities: ordering/auth/checkout/payments/fiscal/loyalty/TEST=false; public issuance и реальный checkout 404; OTP через gateway 404            |
| Owner cleanup дважды                    | Старый синтетический OTP удалён с tombstone; более свежий сохранён с очищенными cipher/hash/receipt полями; повтор безопасен                       |
| Сохранность после рестарта              | PostgreSQL, Redis и API перезапущены; draft/publication, права, очистка и feature gates повторно PASS                                              |
| Побочные эффекты                        | TEST actors/orders, commerce orders/captures и loyalty ledger — по 0 записей                                                                       |

Проверка TEST-column grants охватывает `test_flow_lock.id`,
`test_actors.expires_at`, шесть изменяемых столбцов `test_orders` и
`test_kitchen_tasks.state`. Во время положительной проверки изменялись только
права через tools-контейнер: работающий API оставался с TEST=false. Остаточных
прав после отключения на PostgreSQL 18.3 не обнаружено.

## Воспроизведение

Тест `tests/operations/staging-catalog-smoke.mjs` запускается **внутри** tools
контейнера Compose, с синтетическими UUID и собственным новым томом. Он не читает
секреты из файлов хоста и не выводит bearer tokens или SQL error payloads.
Требуются Docker Compose с поддержкой `!override`, Python 3, Node/pnpm из проекта.

Подготовить отдельную рабочую копию указанного SHA. Создать защищённую `.local`
директорию (0700), приватный env-файл (0600) с новыми случайными
`DB_ADMIN_PASSWORD`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `REDIS_PASSWORD`,
а также `RELEASE_SHA`, `SECRETS_DIR`, тремя feature flags выше. Redis читает
`redis.conf` из этого каталога: `bind 0.0.0.0`, `protected-mode yes`,
`requirepass <сгенерированный REDIS_PASSWORD>`. Секреты нельзя помещать в Git.

Создать два локальных override-файла, подставив уникальный project/image и
абсолютные пути. Staging override:

```yaml
services:
  api:
    image: <unique-image>
    ports: !override ['127.0.0.1:0:3100']
    networks:
      ingress:
        aliases: [pickchick-staging-api-1]
      private: {}
    environment:
      CUSTOMER_AUTH_ENABLED: 'false'
  provision:
    image: <unique-image>
    networks: [private, ingress]
    environment:
      CUSTOMER_AUTH_ENABLED: 'false'
```

Public override:

```yaml
services:
  gateway:
    container_name: <unique-project>-gateway
    ports: ['127.0.0.1:0:8080']
    volumes: !override
      - '<absolute-source>/infra/public-staging/gateway.Caddyfile:/etc/caddy/Caddyfile:ro'
      - '<absolute-public-web>:/srv/public:ro'
networks:
  front:
    external: false
    name: <unique-project>_front
  api_ingress:
    external: true
    name: <unique-project>_ingress
```

`pickchick-staging-api-1` — только DNS alias внутри новой изолированной сети;
существующий staging при этом не используется. Зафиксировать четыре разных
UUID в `PICKCHICK_SMOKE_ORG`, `_LEGAL`, `_BRANCH`, `_OTHER` и передавать одни и
те же значения во все фазы. Они обозначают только синтетические записи.

Ниже `staging` означает `docker compose --env-file <private-env> -p <unique-project>
-f infra/staging/compose.yaml -f <staging-override>`, а `public` —
`docker compose -p <unique-project>-public -f infra/public-staging/compose.yaml
-f <public-override>`. Это сокращения команд, не общие имена проектов.

```sh
docker build --build-arg RELEASE_SHA=<frozen-sha> -f infra/staging/Dockerfile -t <unique-image> .
CI=true pnpm install --frozen-lockfile
pnpm --filter @pickchick/test-order-flow... build
pnpm --filter @pickchick/catalog-admin... build
python3 infra/public-staging/prepare-web.py --source-sha <frozen-sha> --output <absolute-public-web>

staging up -d --wait cloud-db redis-cache
staging run --rm --no-deps -T provision
staging run --rm --no-deps -T provision
```

На проверенном SHA fresh web packaging требует предварительной сборки
`test-order-flow` и `catalog-admin`: без неё Vite не находит package exports.
После показанных команд штатный prepare-web успешно создал 145 файлов.

Для каждой фазы `<phase>` использовать:

```sh
staging run --rm --no-deps -T \
  -v <absolute-source>/tests/operations/staging-catalog-smoke.mjs:/app/staging-catalog-smoke.mjs:ro \
  -e PICKCHICK_ISOLATED_REHEARSAL=true -e PICKCHICK_SMOKE_PHASE=<phase> \
  -e PICKCHICK_SMOKE_ORG -e PICKCHICK_SMOKE_LEGAL \
  -e PICKCHICK_SMOKE_BRANCH -e PICKCHICK_SMOKE_OTHER \
  provision node /app/staging-catalog-smoke.mjs
```

Порядок после миграций:

1. `setup` (один раз на новом томе).
2. `staging run --rm --no-deps -T -e TEST_ORDER_FLOW_ENABLED=true provision`,
   затем фаза `grants-on` с обычной конфигурацией TEST=false.
3. `staging run --rm --no-deps -T -e TEST_ORDER_FLOW_ENABLED=false provision`,
   затем `grants`.
4. `staging up -d --wait api`, `public up -d --wait`, затем `flow` один раз.
5. Дважды `staging run --rm --no-deps -T provision node scripts/customer-identity-maintenance.mjs cleanup`.
6. `staging restart cloud-db redis-cache api`, затем
   `staging up -d --wait cloud-db redis-cache api` и фаза `verify`.
7. После сохранения результата — `public down`, затем `staging down --volumes`,
   адресуя только эти собственные уникальные проекты.

Каждая фаза завершилась exit 0 и JSON с `status: "passed"`. Собственные
контейнеры/сети/том удалены после проверки. Исходные три контейнера
`pickchick-local-cloud-db-1`, `pickchick-local-redis-cache-1`,
`pickchick-local-edge-db-1` сохранили прежние IDs и healthy-состояние.
Локальный собранный образ оставлен для воспроизведения; приватные логи и
синтетические секреты находятся только в игнорируемой `.local/rehearsal`.

## Границы результата

Это проверка развёртывания и HTTP/SQL-инвариантов, а не визуальный browser audit.
Она не подтверждает SMS, банковский эквайринг, чеки, production-заказы или
готовность ресторана. Customer auth и все коммерческие HTTP-функции были
выключены. Проверены миграции до 012 включительно; более поздние изменения
readiness, maintenance, grants и web build в этот frozen результат не входят.
