# VPS — фиксированные действия и защита ёмкости

6 сентября 2026 UTC. Среда: только synthetic TEST.

API и web/gateway опубликованы из `d644822c3085348b66ea63d75bb753869d2d3829`.
Образ API: `sha256:922abf65edeed3a01982e4c67c6da58cb21aa7e5766231814d323192ec3e6cfa`.
[GitHub CI](https://github.com/xaaknazar/pickchick/actions/runs/34052635880)
завершён успешно по этому SHA. [PR #9](https://github.com/xaaknazar/pickchick/pull/9).

До переключения создан encrypted backup `cloud-20260906T185001Z.dump.age`,
SHA-256 `12d0344d1ce7680d13fe2108c693608bebd835f44724f8c7173affafd1cb7ffb`. Восстановлен в отдельную временную БД;
совпали ledger миграций, branches, menu, orders/version/state/payment, число
кухонных задач и outbox. База восстановления затем удалена. Ключ не хранится в Git.
Provision дважды не нашёл новых миграций. Runtime smoke проверил роли, запреты
DDL/мутации устройств и ledger, TEST journey и повтор команд.

Проверены private readiness и `/health/metrics`: лимит admission 32, пул PG 5.
Публичный `/health/metrics` возвращает 404. Всего прошли 38 ingress-проверок,
сверка 103 runtime-файлов, пяти SPA-путей и шести запретов внутренних static-файлов.
Указатели `current` API и public-https переключены на этот release.
Контейнеры соседнего сервиса, PostgreSQL и Redis не перезапускались; конфигурация
общего Caddy и контрольный hash страницы соседнего сервиса совпали с исходными.

После выпуска полный browser journey `RUN_MODE=all` прошёл:

- T-000018: киоск → приготовление → сборка → табло → выдача.
- T-000019: unknown сохраняется, нет нового гостя/повторного платежа;
  управляющий разрешил тот же результат, затем выполнена отмена.
- T-000020: mobile → обе станции → табло и собственный статус → выдача.
- Потерянный ответ после commit и повтор сохранённого ключа/тела не создали
  дубликат; следующий гость не удалил заказ первого на кухне.

JavaScript errors и failed resources: 0. Все номера TEST; реальный ресторан
не принимал эти заказы, банк и ККМ не вызывались. Нагрузочный тест на общем VPS
не выполнялся. Сохраняются ограничения ADR 0007: это staging, не HA production.

## Откат

Миграции БД не менялись. При регрессии вернуть API-образ/Compose release
`de92c6fd353e6d692c38a7106f7c8f2d6a14f1df`, web/gateway release
`a9df5100f8a7879fb2f71e727462c5c16ae44fae`, пересоздав только соответствующие
API/gateway-контейнеры через их сохранённый Compose и release.env. Проверить
private readiness, публичные capabilities, ingress и persisted TEST orders,
затем вернуть указатели `current`. Восстановление backup поверх действующей БД
для обычного отката приложения не требуется. Общий Caddy и соседний проект
не перезапускать. Сохранять новый backup перед любым аварийным восстановлением.
