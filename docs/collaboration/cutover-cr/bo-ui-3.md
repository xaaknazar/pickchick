# CR bo-ui-3: исправления аудита кабинета - за каким флагом они выходят

Полоса: bo-ui (шаг 3). Кому: integration (решение §1), владелец (вопрос `design-bo-ui.md` §8 в.1).
Дизайн: `design-bo-ui.md` §6, runbook: `docs/operations/backoffice-p1-cutover.md`, «Исправления аудита
кабинета». Аудит: находки F01-F20 полного аудита бэк-офиса 05.11.

Что сделано в `codex/cutover-bo-ui` (коммиты `10309b5b`, `57c86353`): F01-F17, F19, F20 в
`apps/backoffice/**` и имена в журнале аудита (`actor_name`) в `packages/backoffice-core/src/index.ts`.
Новых флагов, маршрутов, команд, таблиц и прав нет; `openapi.json` не меняется.

## 1. Решение, которое нужно подтвердить

Дополнение контракта требует: при всех выключенных флагах кабинет и ответы API байт-в-байт как у
облачной полосы. Отдельного флага для исправлений аудита в списке полосы нет, поэтому полоса привязала
их к флагам, которые уже есть:

| Исправления                                                                          | Включаются при                                                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| склад: F01, F02, F17 (окна документов)                                               | `BACKOFFICE_STOCK_V2_ENABLED` или `BACKOFFICE_POS_DAY_ENABLED` |
| роли: «Вы: ...» в шапке и объяснение недоступных кнопок (F03, F09)                   | `BACKOFFICE_ROLES_ENABLED` или `BACKOFFICE_POS_DAY_ENABLED`    |
| остальные (F01 прочих окон, F05-F08, F11, F13-F16, F19, F20; имена в журнале аудита) | `BACKOFFICE_POS_DAY_ENABLED`                                   |

Решает одна функция `auditFixes(data)` в `apps/backoffice/src/operations-model.ts`
(`capabilities.pos_day === true`); на сервере - одно условие `this.options.posDayEnabled` у запроса
журнала аудита. Варианты для интеграции:

1. **Оставить так (умолчание).** Исправления приходят 19.11 вместе с кабинетом перехода и уходят при
   его откате. Ничего делать не нужно.
2. **Без флага.** `auditFixes` возвращает `true`, запрос журнала всегда с именами. Тогда тест «every
   flag off» в `tests/backoffice/audit-fixes-browser.test.mjs` и тест «audit log (F08)» в
   `packages/backoffice-core/tests/pos-day.test.mjs` (ключи строк журнала без флага) меняются вместе
   с этим.
3. **Свой флаг.** Новый флаг в `packages/platform/src/config.ts` и ключ `capabilities`, `auditFixes`
   читает его. Нужна строка в compose и `.env.example` (как CR `bo-ui-1` §2).

## 2. Файлы, которые выкладываются вместе с кабинетом

Сборка `apps/backoffice` теперь даёт `ui-fixes.js`, `dialog-guard.js`, `audit-model.js` и
`audit-fixes.css`. Они уже в списке `assets` `apps/backoffice/server.mjs` и в `build.mjs`; шлюз
(`infra/public-staging/gateway.Caddyfile`, `root * /srv/public/backoffice`) отдаёт весь каталог
сборки, правка не нужна. Если облачная полоса после `43806cf4` меняла список `assets` в
`server.mjs`, при слиянии оставить обе части.

## 3. Тестовый помощник

`tests/backoffice/helpers.mjs` (`withCatalog`) получил опцию `workforce`: монтирует
`WorkforceController` с `Workforce` (как `WORKFORCE_ENABLED`). Прежние вызовы не меняются.

## 4. Что не сделано

- F18 (экран входа): до входа флаги сервера неизвестны; без флага - только по ответу §8 в.1.
- Сортировка по клику на заголовок (часть F19): нет; в реестре заказов есть «Порядок».
