# CR kds-5 → client: маршруты KDS в профиле `kitchen` шлюза LAN

Полоса: kds (ветка `codex/cutover-kds`). Адресат: client (`codex/cutover-client`), копия - integration.
Основание: контракт §5.4 (KDS HTTP), §5.5 («любой новый маршрут pos/kds - CR в client до 11.11»).
Состояние полосы: KDS-2 `8ededf2c` (layout, breading), KDS-4 `fea2b0ba` (отметки передачи), `ab69248c` (инциденты).

## 1. Что добавить в профиль `kitchen`

Профиль `kitchen` = нынешний список `allowedKitchenRoute` (`infra/windows/kitchen-lan-gateway.mjs:14-53`) плюс ровно эти маршруты. Профили `display` и `pos` их не получают.

| Метод | Путь                                                | Разрешённые query-ключи (каждый не больше одного раза)              | Тело                                     |
| ----- | --------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| GET   | `/edge/v1/fulfillment/layout`                       | нет                                                                 | -                                        |
| GET   | `/edge/v1/fulfillment/kds/breading`                 | `limit` - то же правило, что у `/kitchen` (`^[1-9]\d{0,2}$`, ≤ 100) | -                                        |
| GET   | `/edge/v1/fulfillment/incidents`                    | `scope` - обязателен, ровно `open` или `today`                      | -                                        |
| POST  | `/edge/v1/fulfillment/incidents`                    | нет (query запрещён, как у `actions`)                               | JSON, заголовок `Idempotency-Key` (uuid) |
| POST  | `/edge/v1/fulfillment/orders/{uuid}/restore-review` | нет (уже в §5.5, С4/279)                                            | JSON                                     |

Заголовки - прежний набор шлюза (`authorization`, `x-staff-session-id`, `x-terminal-id`, `idempotency-key`, `content-type`), новых нет. Тело `POST incidents` меньше 2 КиБ, общий предел шлюза для POST не меняется.

`POST /edge/v1/fulfillment/orders/{uuid}/actions` уже разрешён; новое поле тела `handover` шлюз не разбирает, менять ничего не нужно.

Предлагаемая форма проверки (та же структура, что сейчас):

```js
if (method === 'POST')
  return (
    !url.search &&
    (new RegExp(`^${base}/orders/${UUID}/(?:actions|restore-review)$`, 'i').test(url.pathname) ||
      url.pathname === base + '/incidents')
  );
// GET
else if (url.pathname === base + '/layout') keys = [];
else if (url.pathname === base + '/kds/breading') keys = ['limit'];
else if (url.pathname === base + '/incidents') keys = ['scope'];
// ...
if (key === 'scope' && !['open', 'today'].includes(value)) return false;
// и для /incidents: url.searchParams.get('scope') обязателен
```

## 2. Как edge отвечает (для тестов шлюза и цепочки)

- Раскладка KDS выключена (умолчание, `kds_settings.layout_enabled=false`): `GET layout` → `200 {"enabled":false}`; `GET kds/breading`, `GET/POST incidents` → `404 NOT_FOUND`. Старый edge без этих маршрутов тоже отвечает 404 - клиент кухни работает по-старому.
- Табло (`display`) на эти маршруты не ходит; терминал `display` получает 403 и на самом edge.
- `POST incidents` с экрана `prep` → 403 (запись отказа - только экран сборки/выдачи).

## 3. Приложение кухни

`apps/kitchen/server.mjs` (allowlist локального прокси) принадлежит полосе kds и будет расширен теми же правилами вместе с экранами KDS-5. Просьба к client: тест профиля `kitchen` сравнивает список с этим CR; после KDS-5 - с регулярками `apps/kitchen/server.mjs`, как профиль `pos` сравнивается с `apps/pos-desktop/protocol.mjs`.

## 4. Для сведения integration

- 027 в этом шаге не менялся, SHA-256 прежний: `41e55b450721646e45be599cf58626fd52328113f5a8165bb8fa5edf1e3a2a97` (CR kds-1).
- Новых прав нет: запись `delivery_handovers` и `courier_incidents` идёт под `RUNTIME_PRIVILEGES` (`SELECT, INSERT`), проверено ролью с ровно этими правами (`packages/edge-fulfillment/tests/kds-postgres.test.mjs`, «KDS-4 the reviewed runtime grants…»).
