# Проверка бессрочных TEST-доступов

7 сентября 2026. Проверяемый API source: `7e6627778d535d2bda3ce45a0d86c342a4054f9e`.

| Проверка                      | Результат                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm check`                  | Build, types, lint, format, 13 unit, generated contracts, 130 design screens — PASS                 |
| `pnpm test:integration`       | 78 PostgreSQL/HTTP tests — PASS                                                                     |
| `pnpm test:mobile`            | 42 JS unit + 17 Python — PASS                                                                       |
| Migration 006                 | Прежние активные/истёкшие ключи и история сохранены; revoked не восстановлены; повтор безопасен     |
| Infinity / legacy strict JSON | Staff и mobile/kiosk получают ISO-маркер; restart и отзыв проверены                                 |
| Metadata refresh              | Awaiting / preparing / ready / unknown сохраняют заказ, identity, команды, суммы и квоты            |
| Квоты                         | Rolling 24h, выдача за 2h / UTC day, 20 active на customer и global cap сохранены                   |
| История                       | Старый unknown виден перед 25 новыми завершёнными; до 20 visible, вся история в БД                  |
| HTTP / roles                  | Staff enrollment закрыт, customer/role isolation, finite expiry, revoke и production gate проверены |
| VPS runtime role              | Полный заказ через обе кухни, табло, выдачу; replay, revoke 401 и SQL permission denied — PASS      |
| Публичный HTTPS               | 38 ingress checks — PASS                                                                            |
| Браузер с прежними ключами    | Prep / assembly / display / manager + kiosk / B02 — PASS; 0 JS errors                               |
| Backup restore                | Свежая encrypted backup восстановлена и сверена до rollout — PASS                                   |

Отдельный read-only аудит сопоставил схемы опубликованных mobile `41d206e` и
web `00ca828`: дополнительное поле, null и JSON Infinity несовместимы, ISO-маркер
принимается. Проверка mobile core на фикстуре подтвердила: старая локальная дата →
однократное продолжение с прежним token/ID → восстановление с часами 2100 года.

Во время review исправлены два следствия постоянного доступа: пожизненные квоты
заменены окнами, история ограничена с приоритетом всех активных, чтобы не выйти
за прежний проверенный размер mobile-ответа. Миграция выполнялась при остановленном
старом API из-за несовместимости его сериализации с PostgreSQL infinity.

Клиентские исходники и TestFlight build этим этапом не менялись. Новый полный
нативный UI-прогон не выполнялся; сохраняется предыдущая приёмка mobile 4.
Срок OTP challenge, quote TTL, реальные staff-сессии и финансовые интеграции
не изменены. Постраничный просмотр старой customer-истории ещё не реализован.

[Deployment и точные артефакты](../../docs/operations/deployments/2026-09-07-permanent-test-access.md).

[CI опубликованного API — все три jobs прошли](https://github.com/xaaknazar/pickchick/actions/runs/34086984601).
