# CR client-3 → integration (копия pos, kds): поставка LAN-шлюза с профилями, CI, межполосный прогон

Полоса: client (ветка `codex/cutover-client`). Адресат: integration (`codex/cutover-1119`), копия pos и kds.
Основание: контракт §1.1 (К7 10-11.11, заморозка клиентов 13.11), §4.1, §5.5, §6.1, §6.2 шаги 1 и 4, §7.3.
Состояние полосы: CL-4 `1ddc8849` (профили, шлюз), CL-4/CL-5 `7e8b9076` (скрипты Windows, pos-desktop 0.5.0), runbook `a4b18580`. Чужие файлы не менялись.

## 1. Пакет оператора для сервера и клиентов (RC-client)

Шлюз теперь импортирует `lan-route-profiles.mjs` из своей папки: без этого файла рядом служба не запустится. Пакет KitchenLAN (по образцу `kitchen-lan-operator-719d1d7.zip`) должен содержать ровно эти файлы, побайтно из RC-коммита, и manifest с их SHA-256:

| Файл                             | Где применяется               | SHA-256 на `7e8b9076`                                              |
| -------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `kitchen-lan-gateway.mjs`        | сервер (служба)               | `fe159635b2c3a860c794537b3a214656f1634ab56d1871e2a21b21b734659b97` |
| `lan-route-profiles.mjs`         | сервер (служба)               | `cdd374fa9a4a2907d215fd20b13e5453dfb1a7330626ee39344c6ea89ef4a2d4` |
| `kitchen-lan-check.mjs`          | сервер (проверка, не менялся) | `03fb0e4f3f9b85d6319038cdd18b99eea649bdc2826e0df08487aeed70bf5cef` |
| `install-native-foundation.ps1`  | сервер (закреплённые helpers) | `6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5` |
| `install-kitchen-lan.ps1`        | сервер, первая установка      | `4df0d495a1151029bd1a505f13dc569a4d64fc56eeca0d5a09bd197f2c86654d` |
| `update-kitchen-lan-clients.ps1` | сервер, список клиентов       | `9751ff54170cadfc7e6b080fd59391370c4f5d76ba7c6a4c68d174098d9432c6` |
| `install-kitchen-client.ps1`     | кухонные моноблоки, табло     | `c70e7f517f79a448491a9697dd8576abb893816c98f578c14402fefc6bd32473` |
| `install-pos-client.ps1`         | кассовые моноблоки            | `992bbc7c1cee542775ba777b984482629efffbc5fa1e4983fdcdd3398b775692` |

Хеши выше - на коммите полосы; в manifest RC идут хеши RC-коммита. `install-kitchen-lan.ps1` получил обязательный `-ProfilesSha256`. Установщики приложений: PickChick POS **0.5.0** (первая сборка, принимающая `edgeHost`; `install-pos-client.ps1` отказывает на более старой) и PickChick Kitchen **0.4.0** полосы kds (`install-kitchen-client.ps1` требует 0.4.0+). Порядок применения - `docs/operations/lan-clients.md`.

## 2. CI

- `tests/operations/kitchen-lan.test.mjs` теперь запускает `tests/operations/kitchen-lan-clients.test.ps1` под PowerShell (`PICKCHICK_TEST_PWSH` или `pwsh`/`powershell` в `PATH`). Без PowerShell тест пропускается, но при `CI=true` падает. В образе GitHub `ubuntu-24.04` PowerShell 7 есть, менять `ci.yml` не нужно, если образ не меняется.
- Два прежних теста (`kitchen-lan.test.mjs` «real pinned TLS…», `kitchen-lan-chain.test.mjs`) по-прежнему требуют частный сетевой интерфейс; в контейнере полос его нет (как и на D0). Новые тесты профилей идут по настоящему TLS на loopback и интерфейса не требуют.

## 3. Межполосный прогон (для `cutover-cross-lane`)

Полоса проверила pos-desktop → шлюз (профиль `pos`) → синтетический edge. Нужен прогон на настоящем edge полосы pos после слияния: продажа, void, возврат, чек Webkassa, X/Z, закрытие смены и фото меню с кассы через шлюз; кухонный экран с раскладкой KDS (профиль `kitchen`) и табло (профиль `display`) на том же шлюзе. Тест полосы `kitchen-lan.test.mjs` («one gateway port, three profiles…») показывает, как подставить IPv4 клиента на loopback.

## 4. pos, kds (для сведения)

- Профиль `pos` - литеральная копия регулярных выражений `apps/pos-desktop/protocol.mjs`; тест сравнивает их и пересылаемые запросы. Новый маршрут кассы - сначала в pos-desktop, затем в профиле, иначе тест красный. `GET pos/config?client_version=` (CR pos-2 §1.1) касса пока не отправляет; предусловие `pos-sales-setup.mjs` требует только факт запроса (`last_fetched_at`), версия остаётся `NULL`.
- Профиль `kitchen` совпадает с `allowed()` в `apps/kitchen/server.mjs` ветки kds (`c12da62e`): проверено по тому же набору путей, расхождений 0. Тест полосы client сравнивает профиль с приложением кухни плюс таблицей CR kds-5, поэтому он зелёный и до, и после слияния kds.
- CR client-2 п. 1 (`staff_id` в `staff/approvals`) закрыт ответом CR pos-3 §1 п. 1: изменений в кассе не нужно.
