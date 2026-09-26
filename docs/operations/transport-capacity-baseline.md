# Локальная проверка ёмкости cloud ↔ edge транспорта

`tests/load/fulfillment-transport.mjs` проверяет **1 000 одновременно активных
заказов в десяти изолированных точках**, используя один настоящий cloud API,
десять локальных LAN API и десять HTTP workers. Это следующий диагностический
срез после [SQL/domain baseline](capacity-baseline.md), а не приёмка промышленной
ёмкости или 1 000 оформлений в секунду.

## Сценарий и границы измерения

1. Создаются одна временная cloud schema с общей organization и десять edge
   schemas, по одной branch/device binding, маршруту приготовления и станции
   сборки. Все реальные миграции применяются в этих схемах. Сессии повара и
   сборщика выдаёт действующий `provisionStaff`; ключи живут только в памяти.
2. `CommerceRepository` создаёт 100 immutable quotes/orders на точку. Каждая
   строка — два синтетических бургера. Цены и налоговая метка задаются доверенной
   fixture, публичный checkout и published catalog pricing в этом срезе не
   измеряются. Миллион identity-строк повторно не создаётся.
3. Workers через loopback HTTP забирают admission commands, сохраняют локальный
   inbox/резерв, доставляют обратные факты и подтверждают исходные outbox.
   Переход к оплате разрешён после получения всех 1 000 `held` в cloud.
4. В доверенный коммерческий порт поступают **синтетические** capture и issued
   fiscal observations. Никакой банковский/ККМ API не вызывается. Затем HTTP
   workers доставляют 1 000 kitchen admission commands и обратные accepted facts.
5. Настоящие staff LAN POST начинают одну задачу у половины заказов каждой
   точки. Все заказы остаются активными: 500 `accepted`, 500 `in_production`.
   HTTP worker доставляет также эти 500 task facts.
6. После остановки изменений полностью читаются prep, assembly и LED страницы
   каждой точки. Лимит страницы — 37: 100 заказов требуют три страницы каждой
   очереди. Проверяются точное множество order IDs, номера без PII, принадлежность
   branch/station, версии каждого заказа и задачи против локальной БД.
7. Для всех 1 000 заказов сравниваются cloud/edge identity, reservation/quote/owner
   hashes, state/version, номер и routing/assembly IDs. Проекция должна содержать
   максимальную наблюдённую aggregate version. Сравниваются также 500 полученных
   task versions. Это не объявляет наблюдённые task deltas полной копией кухни.
   В outbox обоих направлений нет неподтверждённых transport-событий, pending
   пуст, admission inbox содержит ровно две команды на заказ.

Все 1 000 заказов существуют одновременно в финальном барьере проверки. Заказы
не выдаются и не удаляются по одному для освобождения места. После сохранения
результатов supervisor удаляет **все собственные временные схемы**.

## Запуск

Нужны Node 24, зависимости monorepo и уже запущенные development PostgreSQL из
`infra/local/compose.yaml`: `pickchick-local/cloud-db` на `127.0.0.1:55432`,
`edge-db` на `127.0.0.1:55433`. Harness не поднимает/останавливает контейнеры,
не меняет параметры PostgreSQL и не читает приватный `.env`.

```sh
pnpm --filter @pickchick/api... --filter @pickchick/edge... --filter @pickchick/test-fixtures build
node tests/load/fulfillment-transport.mjs --self-test
node tests/load/fulfillment-transport.mjs --quick --output .local/capacity/transport-quick.json
node tests/load/fulfillment-transport.mjs --output .local/capacity/transport-full.json
```

`--self-test` выполняет четыре проверки защит и планировщика без БД/сети.
`--quick` использует две точки по три заказа и не подтверждает пагинацию 100
заказов. Не запускайте основной сценарий параллельно с другими тяжёлыми
локальными PostgreSQL тестами: иначе времена характеризуют смешанную нагрузку.

При отличающемся **локальном** пароле доступны только
`TRANSPORT_CAPACITY_CLOUD_DATABASE_URL` и `TRANSPORT_CAPACITY_EDGE_DATABASE_URL`.
Host, ports, user и development database names остаются строго закреплены.
Адреса, tokens, staff identities и полные заказные снимки в отчёт не попадают.
Файл JSON создаётся с правами `0600`; его очищенное содержимое можно сохранить
в `tests/load/results/` после проверки. Не передавайте секреты в аргументах CLI.

## Ограничения ресурсов и удаление данных

До CREATE harness проверяет локальный Docker socket, Compose labels, точные
loopback port bindings и равенство `pg_control_system().system_identifier`
между container exec и подключением по TCP. Remote Docker, hostname вместо
literal `127.0.0.1`, другой port/database/user, query и fragment отвергаются.

В cloud максимум 13 соединений: supervisor 1, workload pool 4, API pool 8.
В edge PostgreSQL максимум 41: supervisor 1 и десять пар worker/LAN pools по 2.
Перед запуском проверяется `max_connections`, reserved slots, текущие clients
и ещё восемь свободных мест сверх плана. В этом срезе API/LAN/workers работают
в одном дочернем Node-процессе; это не десять физических серверов.

Supervisor создаёт уникальные `ftcap_<random UUID>_cloud/edge_0…9`, предварительно
проверив их отсутствие. Только эти точные имена допускаются к DROP; default
schemas, контейнеры и volumes не удаляются. Supervisor имеет собственные admin
connections и сохраняет ответственность за очистку даже после crash дочернего
workload. Через восемь минут общего запуска он отправляет SIGTERM, через три
секунды — SIGKILL при необходимости. После выхода child его соединения закрыты;
DROP идёт отдельно на каждом PostgreSQL с 5-секундными statement timeouts.
Общий бюджет — менее десяти минут. Если БД недоступна и очистка не подтверждена,
отчёт имеет статус failed и перечисляет только собственные неубранные схемы;
отсутствие данных не утверждается. SIGKILL самого supervisor не может запускать
его finally, поэтому не используйте его для обычной остановки.

Отчёт содержит SHA исходников и compiled JS, параметры окружения, длительности
фаз, число HTTP попыток/статусов/ошибок, counts каждой branch и подтверждение
очистки. HTTP latency samples заканчиваются на заголовках ответа; полное чтение
тела и работа PostgreSQL включены во время фазы. RSS sampled каждые 100 мс
только у общего дочернего Node-процесса; память PostgreSQL/Docker не измеряется.

## Что этот срез не принимает

Не проверяются 20 точек с перекосом из целевого плана, часовая нагрузка 10/30
оформлений/с, миллион реальных регистраций, WAN outage, восстановление диска,
длительный soak, Redis, UI rendering, реальное оборудование, банковские и
фискальные провайдеры, склад, возвраты и остановка исполнения. Эти проверки
остаются отдельными воротами [ТЗ](../01-technical-spec.md)
и [roadmap](../04-roadmap.md). Единичное локальное измерение не заменяет их.
