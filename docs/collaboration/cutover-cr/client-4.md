# CR client-4 → cloud, integration (копия pos, kds): коды ошибок POS, `client_version`, выход без тела, журнал pos-desktop, файлы пакета LAN

Полоса: client (ветка `codex/cutover-client`). Адресаты: cloud (`codex/cutover-cloud`) - §1; integration (`codex/cutover-1119`) - §2-5; копия pos и kds.
Основание: ревью лида по полосе client (CL-R1, CL-R2, CL-R5, CL-R7, CL-R8), контракт §4.4, §5.1, §5.5, §5.8, §7.3, §10 риск 3.
Состояние полосы: `6af1e197` (выход без тела, `client_version`), `4aaf3a51` (порт 9100), `cd2599a3` (журнал pos-desktop), `fadfd142`, `6a8ddefd`, `b77b4d4c`, `f9e56070` (касса). Чужие файлы не менялись.

## 1. cloud: 13 кодов POS в `ErrorSchema` (CL-R1, major, нужно до RC)

Что: то же, что CR pos-1 §2 и CR pos-3 §2.1, - в регионе cloud `packages/contracts/src/index.ts`, перечень `ErrorSchema.code`, после `'ORDER_IN_PRODUCTION',`:

```ts
    // Cashier edge pos_sale routes only (contracts 5.1); cloud routes never send them.
    'METHOD_DISABLED',
    'TENDER_SUM_MISMATCH',
    'CASH_TENDERED_TOO_LOW',
    'TERMINAL_AMOUNT_NOT_WHOLE',
    'CHANNEL_PRICE_UNAVAILABLE',
    'EXTERNAL_REF_REQUIRED',
    'EXTERNAL_REF_DUPLICATE',
    'APPROVAL_REQUIRED',
    'APPROVAL_INVALID',
    'REFUND_LIMIT',
    'REFUND_NOT_SUPPORTED',
    'DRAWER_INSUFFICIENT',
    'FISCAL_PENDING',
```

затем `pnpm contracts:generate` последним отдельным коммитом. На `codex/cutover-cloud` `d6827d77` этих кодов ещё нет.

Зачем: фильтр ошибок edge пропускает только коды из `ErrorSchema`; остальные полоса pos отдаёт как 409, и фильтр превращает их в голый `CONFLICT`. Касса различает все 13 кодов и показывает тексты §5.1 (тест «every section 5.1 error code has the Russian cashier text»), но без этой правки кассир видит общий текст «Состояние изменилось…»: дважды введённый номер агрегатора, возврат сверх лимита, наличный возврат больше ящика выглядят одинаково, кассир пересчитывает и снова получает отказ.

Сейчас поведение кассы при голом `CONFLICT` безопасное и закреплено тестом `b77b4d4c`: команда заканчивается, корзина остаётся, квота пересчитывается, повторной отправки с тем же ключом нет, новый запрос - новая команда; возврат с отказом ничего не возвращает и просит PIN заново. Правка кассы после слияния cloud не нужна.

## 2. integration: `client_version` в `GET pos/config` (CL-R8) - внести в §5.1 и §5.5

Полоса pos приняла необязательный query-ключ (CR pos-2 §1.1, `services/edge/src/pos-sales-controller.ts`, `@Query('client_version')`, формат `^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$`, неверный формат или повтор - 400) и пишет его в `pos_config_fetches`; `pos-sales-setup.mjs status` показывает его у каждой кассы. В тексте контракта ключа нет, а §5.5 требует, чтобы шлюз пропускал ровно ключи клиентов. Полоса client реализовала (`6af1e197`):

- pos-desktop сам добавляет `?client_version=pos-desktop-<версия приложения>` к `GET pos/config` и только к нему; renderer выбрать значение не может (свой query на этом пути - 403). Формат - подмножество формата pos без `+` (`CLIENT_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/`), кодировать ничего не нужно (шлюз отказывает на `%`).
- Профиль `pos` шлюза принимает на этом пути ровно один этот ключ в формате кассы (`POS_CLIENT_VERSION`, тест паритета с pos-desktop); любой другой ключ, повтор, пустое значение, `+`, `%` - 404 шлюза.
- Браузерная касса (`apps/pos/server.mjs`) ключ не отправляет. Старый edge отвечает 404 с ключом и без него - касса остаётся в прежнем режиме.

Просьба (diff текста контракта):

```diff
-| `GET pos/config` | - | `{mode: PosServiceMode, …}`. 404 на старом edge → клиент в unpaid-UI. |
+| `GET pos/config` | `?client_version=` необязателен (`^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$`; pos-desktop шлёт `pos-desktop-<версия>`) | `{mode: PosServiceMode, …}`. 404 на старом edge → клиент в unpaid-UI. |
```

и в §5.5 после «Разрешённые query-ключи - те же, что в клиентах»: «(`pos`: `shift_id` на `orders` и `pos/fiscal-receipts/pending`, `client_version` на `pos/config`)».

## 3. integration: выход сотрудника без тела в профиле `pos` (CL-R2) - для сведения и текста §5.5

Renderer завершает сессию голым `POST staff/logout`. pos-desktop и браузерный сервер раньше отвечали 415 до edge, и сессия на edge жила до истечения; теперь оба передают этот путь без тела и `Content-Type` (`BODYLESS_WRITES`), профиль `pos` шлюза держит тот же список (`bodyless: ['/edge/v1/staff/logout']`, тело на этом пути - 400). «Точное зеркало» §5.5 включает и этот список; тест сравнивает его с pos-desktop.

## 4. integration: пакет оператора LAN - новые хеши (заменяет CR client-3 §1 для двух файлов и §4 п. 1)

После CR client-3 изменились два файла пакета; остальные шесть - побайтно те же, что в CR client-3 §1.

| Файл                     | Что изменилось                                                         | SHA-256 на `f9e56070`                                              |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `lan-route-profiles.mjs` | профиль `pos`: выход без тела, `client_version` на `pos/config` (§2-3) | `e979bcfea083fbfda97aa88f871458d8f11b93b0704a2acab7d6d1ef9e3bafb8` |
| `install-pos-client.ps1` | `-PrinterPort` только 9100, как в §5.8 (CL-R7)                         | `6ad7e9c36f8718e2dde8d9ddd68b9a198c4fcd11d567198a3dd7ebc1b174d86b` |

`install-kitchen-lan.ps1 -ProfilesSha256` получает новый хеш `lan-route-profiles.mjs`. CR client-3 §4 п. 1 («`client_version` касса пока не отправляет») устарел: pos-desktop 0.5.0 отправляет (§2).

## 5. integration: приёмка и межполосный прогон (CR client-3 §3 дополняется)

1. **Журнал pos-desktop в Electron.** При разборе ревью полоса нашла и в `cd2599a3` исправила блокирующую ошибку, которую не видел ни один node-тест: main-процесс pos-desktop (`journal.mjs`) принимал только команды без оплаты, поэтому каждая продажа, отмена, возврат, номер чека и закрытие смены продаж на моноблоке останавливались на записи журнала (`STORAGE_UNAVAILABLE`) до отправки. Теперь каждый тест кассы в режиме оплаты пишет журнал через проверку main. Приёмочный тест `tests/pos-desktop/browser.test.mjs` в контейнерах полос не запускается (нет Electron в `apps/pos-desktop/node_modules`). Для RC нужен прогон собранного pos-desktop 0.5.0 против настоящего edge полосы pos: продажа наличными, продажа с PIN (питание), отмена, возврат, номер Webkassa, закрытие смены продаж - без `STORAGE_UNAVAILABLE`, затем перезапуск приложения с неотправленной командой и «Проверить результат».
2. **Коды 409.** После §1: в `cutover-cross-lane` - `POST pos/sales` дважды с одним `external_order_ref` и возврат больше `tenderRefundable`; касса получает 409 `EXTERNAL_REF_DUPLICATE` / `REFUND_LIMIT` и показывает тексты §5.1.
3. **Выход без тела и `client_version` через шлюз** - на настоящем edge: `POST staff/logout` с кассы через профиль `pos` отзывает сессию (следующий `GET session` - 401), `pos-sales-setup.mjs status` показывает `client_version` каждой кассы.

## 6. pos, kds (для сведения)

- 401 на `staff/approvals` (неверный PIN или конец сессии кассы, CR pos-2 §1.2): касса один раз спрашивает `GET cash-shifts/current`; только 401 там выводит кассу из сессии. `GET session` для этого не используется: pos-desktop отбирает журнал на каждом `GET session` и возвращает только на его 200. Если pos когда-нибудь различит неверный PIN отдельным кодом, проба станет не нужна; сейчас изменений у pos не требуется.
- Питание и маркетинг: перед PIN касса пересчитывает квоту, если ей осталось меньше TTL одобрения плюс 27 с (квоты edge живут 300 с) - на edge ничего не меняется.
- Печать ESC/POS - только порт 9100 (§5.8 без изменений).
