# Синтетический путь заказа на staging

API и web: `https://pickchick.185.129.51.103.nip.io`. Этот контур хранит только
синтетические заказы `T-…` в cloud-таблицах `test_*`. Он нужен для проверки
связи мобильного приложения, киоска, кухни, табло и управляющего. Смена статуса
TEST-оплаты не обращается к Kaspi и не означает платёж, чек или ресторанный заказ.
Данные не отправляются в рабочий edge, iiko или ресторанную кухню.

## Gate и API

`TEST_ORDER_FLOW_ENABLED` по умолчанию `false`; допускаются только строки
`true`/`false`. Включение разрешено только для API в `local`, `test`, `staging`.
При выключении controller `/v1/test` не регистрируется. `/v1/capabilities`
получает `features.test_order_flow` из действующего API config. Прежние
`ordering_enabled`, `phone_auth`, `checkout`, `payments`, `fiscal`, `loyalty`
остаются `false` независимо от TEST gate.

Публичный gateway пропускает только следующие сочетания метода и пути:

| Метод | `/v1/test/…`                                                                                           | Доступ                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| GET   | `catalog`                                                                                              | Публичный синтетический каталог                                                                    |
| POST  | `sessions`                                                                                             | Ограниченная по сроку гостевая TEST-сессия mobile/kiosk                                            |
| POST  | `sessions/continue`                                                                                    | Прежний customer Bearer, пустое тело `{}`, только завершённые заказы; сохраняются identity и квоты |
| GET   | `orders`, `orders/:orderId`                                                                            | Bearer, изоляция клиента/роли проверяется API                                                      |
| POST  | `quotes`, `orders`                                                                                     | Customer Bearer, UUID `Idempotency-Key`                                                            |
| POST  | `orders/:orderId/simulated-payment`, `orders/:orderId/cancel`                                          | Bearer + idempotency + version                                                                     |
| GET   | `kitchen`, `display`, `manager/orders`                                                                 | Выделенные роли TEST-персонала                                                                     |
| POST  | `orders/:orderId/tasks/:taskId/complete`, `orders/:orderId/handoff`, `orders/:orderId/resolve-payment` | Роль станции/управляющего, idempotency + version                                                   |

UUID проверяются в gateway и API. Остальные методы/маршруты — 404. Bearer
передаётся upstream только внутри этого allowlist; Cookie и X-Device-Id
удаляются. На прежних публичных GET Authorization также удаляется. OPTIONS
разрешён только для конкретной пары путь/GET или путь/POST, с заголовками
Authorization, Content-Type, Idempotency-Key. CORS допускает `*`, включая
локальные проверки web; cookies/credentials не разрешаются. CORS не заменяет
Bearer и проверку ролей сервером. HTTP выдачи staff credentials нет.

## Runtime и полномочия

Readiness при включённом gate требует migration `004_cloud_test_order_flow.sql`
и доступ ко всем семи TEST-таблицам. Runtime получает только необходимые
SELECT/INSERT и UPDATE изменяемых полей заказа/задачи, блокировку singleton,
USAGE единственной TEST sequence. DELETE test_actors нужен ограниченной очистке
давно истёкших TEST-сессий; все её каскады остаются в TEST-таблицах. Runtime
получает UPDATE только expires_at у test_actors для явного продолжения;
не получает UPDATE test_quotes/test_outbox, изменение staff revoked_at, DDL
или изменение migration ledger. Обычные меню и branch ordering flag не меняются.

`infra/staging/provision.mjs` применяет миграции от owner, затем назначает
явные grants; TEST grants выдаются только при включённом gate. Поэтому включение
gate требует provisioning до старта нового API. Это отдельный синтетический
контур, а не production схема заказа из ТЗ.

`infra/staging/smoke.mjs` сохраняет прежние проверки при выключенном gate.
При включённом он дополнительно проходит по HTTP session → quote → order →
simulated approval → prep → assembly → display → handoff с runtime DB role;
проверяет idempotent replay и SQL permission denied на смену staff role/revoke,
quote/outbox и реальный ordering flag. Четыре временные роли выдаются owner и
отзываются в finally, токены не печатаются. CI использует gate=true в своём
одноразовом release.env, чтобы эти grants постоянно проверялись.

## Выдача доступа к кухням, табло, управляющему

Trusted CLI: `node scripts/test-flow-staff-setup.mjs prep`, аналогично
`assembly`, `display`, `manager`. На staging требуется DB connection роли
`pickchick_owner`. Скрипт создаёт `.local/test-flow-staff` с mode 700, файл
`<role>-<actor UUID>.json` с mode 600 и печатает только путь. При ошибке записи
выданный actor отзывается. Срок credentials — восемь часов; перевыпуск выполняет
оператор. Секреты не включать в URL, dist, конфигурацию gateway или Git.

На VPS, из проверенного release с `TEST_ORDER_FLOW_ENABLED=true` в release.env:

```sh
mkdir -m 700 /opt/pickchick-staging/secrets/test-flow-staff
dc run --rm --user "$(id -u):$(id -g)" \
  --volume /opt/pickchick-staging/secrets/test-flow-staff:/app/.local/test-flow-staff \
  provision node scripts/test-flow-staff-setup.mjs prep
```

`dc` — функция из [runbook VPS](staging-vps.md). Повторить для трёх остальных
ролей. Если каталог уже существует, проверить его владельца/mode, не менять
существующие файлы. Перенести JSON по SSH в защищённый локальный каталог
`.local/test-flow-staff`, сохранить mode 600. Web вводит credential явным
действием оператора; собранное приложение его не содержит.

## Публикация web

После commit всех build inputs выполнить из того же source SHA:

```sh
python3 infra/public-staging/prepare-web.py \
  --source-sha <VERIFIED_40_CHAR_SHA> \
  --output .local/releases/<VERIFIED_40_CHAR_SHA>/public-web
```

Скрипт проверяет SHA/чистоту inputs, собирает `@pickchick/operations`, копирует
только dist, необходимые JS/CSS/screens/assets прототипа и два design-tokens
файла. Source maps, provenance.json с локальными путями, repo root, `.local`
и docs не публикуются. Manifest содержит source SHA и hashes, без путей машины.
Перенести каталог как `infra/public-staging/public-web` в конкретный gateway
release на VPS. Mount `/srv/public` только read-only.

Web пути: `/kiosk`, `/kitchen/prep`, `/kitchen/assembly`, `/display`, `/manager`.
Они обслуживают SPA index через GET/HEAD; `/assets/*` — только собранные assets.
Макеты открываются по `/design/prototype/index.html#B05` и другим screen IDs.
Корень `/`, docs, provenance и repository config не публикуются.

## Порядок deployment и проверки

1. Проверенный общий source commit, успешные backend integration tests и build.
   Остановить rollout при провале schema/auth/unknown-payment/idempotency tests.
2. Проверить idrink public response/hash и start times, RAM/disk, текущие
   API/gateway SHA. До миграции выполнить существующий encrypted backup, сверить
   SHA256 и восстановить в новую отдельную drill-БД. Сравнить ledger/синтетическое
   меню и закрытый режим; затем удалить только drill-БД. Рабочую БД не заменять.
3. Доставить git archive исходного commit в новый `releases/<SHA>`, собрать
   `pickchick-api:<SHA>` с revision label и pinned base digest. В release.env
   записать RELEASE_SHA и TEST_ORDER_FLOW_ENABLED=true; секреты переиспользовать
   из защищённого staging.env, не переносить в архив.
4. `dc run --rm provision`, повторная проверка применения. Проверить grants
   runtime, прежний closed branch, отсутствие реальных финансовых effects.
   Поднять только API: `dc up -d --no-deps --wait api`. PostgreSQL/Redis/idrink
   не пересоздавать для этого rollout.
5. Доставить public-web и новую gateway config. Проверить compose/config и
   pinned `caddy validate`; пересоздать только `pickchick-public-gateway`.
   Общий входной Caddy/idrink site не требует изменения.
6. `python3 infra/public-staging/smoke.py` проверяет TLS, allowlist, CORS,
   невозможность staff enrollment, закрытые реальные endpoints и отсутствие
   анонимного доступа к TEST-заказам/станциям. В браузере проверить пять web
   путей и макет, отсутствие ошибок assets/шрифтов; web HTML должен иметь
   Content-Type text/html, API — application/json.
   `python3 infra/public-staging/static-smoke.py --manifest <PUBLIC_WEB_DIR>/.release.json`
   дополнительно сверяет по HTTPS хеш каждого опубликованного runtime-файла,
   пять SPA путей и запрет публикации внутренних файлов.
7. Выпустить роли trusted CLI и выполнить реальный HTTPS-сценарий:
   `python3 infra/public-staging/test-flow-smoke.py --staff-dir .local/test-flow-staff`.
   Он создаёт два TEST-заказа mobile/kiosk, проверяет replay/изоляцию,
   simulated_unknown → resolve, очереди обеих станций, запрет ранней сборки,
   ready на табло и handoff. Все деньги и fiscal остаются синтетическими.
8. Перезапустить только API, проверить readiness и выполнить
   `python3 infra/public-staging/test-flow-smoke.py --verify-state <PRIVATE_STATE_FILE>`.
   Убедиться, что сохранённые TEST-заказы читаются после restart. Это не заменяет
   аппаратный WAN-тест/production restore.
9. Повторить idrink response/hash/start times, закрытые host-порты БД/Redis,
   readiness; сохранить точные SHA/image ID, backup и результаты в deployment
   record. Переключить current symlinks только после успешных проверок.

## Откат

При readiness 503, ошибке grants/ролей, публичном private route, включённом
реальном ordering/payment, пропаже данных или ухудшении idrink остановить rollout.
Вернуть предыдущий gateway release и API image/compose по прошлому release.env,
проверить старый smoke с соответствующей версией. Новая миграция добавляет
только TEST-таблицы и совместима со старым API; не понижать её и не удалять тома.
У старого gateway был статичный capabilities JSON без TEST feature — его
конфигурация восстанавливается вместе с API. Для прекращения только тестовых
операций выключить gate и пересоздать API; capabilities сразу отразит false.
