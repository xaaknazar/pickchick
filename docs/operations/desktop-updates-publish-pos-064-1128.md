# Касса 0.6.4 — каталог обновлений 28.11.2026

## Статус

DEPLOYED: `kitchen-0.4.12-pos-0.6.4` (касса `idle`, кухня 0.4.12 перенесена побайтно).

Владелец 28.11 в 14:33 UTC: «Разрешаю опубликовать кассу 0.6.4». Выпуск выполнил Claude через
Remote Control на MacBook владельца (gh, SSH `pickchick-ops` с проверкой host key). Пакет
оператора тот же, что для 0.6.0–0.6.3: `/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package`
(`source_sha` 4df05b79, SHA-256 четырёх файлов совпали с манифестом).

Не менялись и не перезапускались: API, шлюз, compose-файлы, env и базы. Тестовая касса и
моноблоки по SSH не трогались.

## Что в кассе 0.6.4

Касса 0.6.3 плюс восстановление оплаты на терминале Kaspi после перезапуска кассы и строка
«Webkassa: тестовая касса» в шапке (PR #437; версия поднята в PR #449, `7655945f`). Слито в
`codex/cutover-1119` как `f52744aad713b66787f210788219088df9bdbc8e`. Сервер точки тестовой кассы
уже на `5b09632b` с маршрутом `terminal-payments/open` (`edge-webkassa-5b09632-1128.md`).

## Доказательство

- [Windows POS package 46157302463](https://github.com/xaaknazar/pickchick/actions/runs/46157302463):
  push на `codex/cutover-1119`, `head_sha` `f52744aa`. Success всех трёх задач: установка,
  самообновление с каталога, проверки PowerShell 5.1.
  [Foundation CI 46152332793](https://github.com/xaaknazar/pickchick/actions/runs/46152332793)
  на `7655945f`: 11/11. Дерево `7655945f` то же, что у сборки PR.
- `apps/pos-desktop/package.json` на `f52744aa`: `0.6.4`.
- Журнал сборки, шаг «Lay out the update feed of this build»: версия 0.6.4, `apply idle`,
  172306146 байт, SHA-256 `1689f0619cc86e1a0ee4ab5a8bdf8242f5f1b22909ca6d521821edb07e979d03`.
- Артефакт `15268326191` (`pickchick-pos-update-feed-f52744aa…`):
  - 172331356 байт, SHA-256 `fd50bca84437e01766e414aae072ec09baecdadcaac73375d67a044aaddf3748`,
    совпадает с digest GitHub;
  - сервер скачал его сам по одноразовой ссылке GitHub (токен на сервер не передавался);
  - внутри `pos/latest.json` (209 байт, SHA-256 `f718f5e6…7f0f`) и
    `PickChick-POS-Setup-0.6.4-x64.exe` (тот же SHA-256, что в журнале сборки);
  - распакован в `/opt/pickchick-staging/incoming/desktop-pos-064-1128/feed/pos`.
- Копия прежнего выпуска:
  - `/opt/pickchick-staging/backups/desktop-feed-kitchen-0.4.12-pos-0.6.3-before-pos-064-1128.tar.gz`;
  - 293205625 байт, SHA-256 `9b2f1e8c…f639`;
  - каталог `feed/releases/kitchen-0.4.12-pos-0.6.3` тоже остаётся на сервере.
- До выпуска:
  - inspect: `kitchen-0.4.12-pos-0.6.3`, блокировки и остатков нет;
  - публичный выпуск и API `b9127817…`, шлюз `59bbd574…6d5c`;
  - снаружи: кухня 0.4.12 (`5f9a83ab…5b20`), касса 0.6.3.
- Publish без `--apply`: `inspected`, `validated=true`, выпуск `kitchen-0.4.12-pos-0.6.4`.
- Apply в tmux `desktop-pos-064-1128` 28.11 15:04:08–15:04:13 UTC, exit 0, stderr пуст:
  - `deployed`, этап `verify`, `previous_feed_release=kitchen-0.4.12-pos-0.6.3`;
  - журнал `/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.12-pos-0.6.4-1008932000ec44c5bb96b0768da59d79.json`.
- Снаружи (с MacBook, 15:04 UTC):
  - `pos/latest.json`: HTTP/2 200 `no-store`, версия 0.6.4, тот же SHA-256;
  - установщик: HEAD 200, 172306146 байт, скачан целиком, SHA-256 совпал;
  - `kitchen/latest.json` не изменился: 0.4.12, `5f9a83ab…5b20`;
  - корень `/desktop-updates/`, `pos/latest.yml` и установщик 0.6.3 отвечают 404.

## Отзыв

`withdraw --package <пакет> --expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.12-pos-0.6.3 --expected-current kitchen-0.4.12-pos-0.6.4`.

Сначала без изменений, затем с `--apply` в tmux. Запись каталога вернуть к прежнему выпуску.
Установленные версии не откатываются.

## Что дальше

Тестовая касса ставит 0.6.4 сама:

- при запуске;
- в первые 10 минут;
- или в 03:00–05:59, если никто не вошёл.

Подтверждение — заголовок окна кассы и жёлтая строка «Webkassa: тестовая касса».
