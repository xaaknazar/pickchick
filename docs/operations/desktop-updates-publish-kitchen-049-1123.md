# Кухня 0.4.9 - каталог обновлений 23.11.2026

## Статус

DEPLOYED: `kitchen-0.4.9-pos-0.5.8` (кухня `idle`, касса 0.5.8 перенесена побайтно).
Владелец 23.11 в 09:16 UTC написал «делай … Передавать этот состав вместе с заказом на кухню …
нужно обновить сервер на кассовом моноблоке (сделаю бэкап) и программу кухни». Выпуск выполнил
Claude через Remote Control на MacBook владельца (gh, SSH `pickchick-ops` с проверкой host key).
Пакет оператора тот же, что для 0.4.8 и 0.5.8:
`/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package` (`source_sha` 4df05b79).
API, шлюз, compose-файлы и базы не менялись; моноблоки по SSH не трогались.

## Что в кухне 0.4.9

Коммит `7b1cd862abc377ac1aa0bf2e70a5292ce619987d` (ветка `codex/kitchen-049-1123`):
состав комбо из бэк-офиса («Компоненты») под строкой комбо, с граммами (`3ea32df6`); блюдо со
связанными добавками остаётся одной строкой, добавки считаются один раз на строку заказа
(`22bd2800`).

## Доказательство

- [Foundation CI 45163493722](https://github.com/xaaknazar/pickchick/actions/runs/45163493722) и
  [Windows Kitchen 45170680183](https://github.com/xaaknazar/pickchick/actions/runs/45170680183)
  на `7b1cd862`: success.
- Артефакт каталога `14817370635` (`pickchick-kitchen-update-feed-7b1cd862…`): 120920256 байт,
  SHA-256 `72800115e4298f52454c42c7dbf423a4a3fe9f731fe747999946e0af61b416fb`, совпадает с digest
  GitHub. Внутри ровно `kitchen/latest.json` (217 байт, SHA-256 `6ebb044e…972c`, версия 0.4.9,
  `apply=idle`) и `PickChick-Kitchen-Setup-0.4.9-x64.exe` 120908536 байт, SHA-256
  `407f3bf73c19b659889dd8f411db7187054b30cf30797caf485f773eed1b6949` (тот же хеш в журнале сборки).
  Загружен в `/opt/pickchick-staging/incoming/desktop-kitchen-049-1123/feed/kitchen`; на сервере
  SHA-256 обоих файлов совпали.
- Пакет оператора: манифест `source_sha` 4df05b79, SHA-256 четырёх файлов совпали с манифестом.
- Inspect до: `kitchen-0.4.8-pos-0.5.8`, блокировки и остатков нет, хост приводит к шлюзу.
  Publish без `--apply`: `inspected`, `validated=true`, план `kitchen=new` (0.4.9), `pos=carried`
  (0.5.8, `b49e6645…4a58`).
- Apply в tmux `desktop-kitchen-049-1123` 23.11 12:25:45-12:25:51 UTC, exit 0, stderr пуст:
  `deployed`, этап `verify`, `previous_feed_release=kitchen-0.4.8-pos-0.5.8`, журнал
  `/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.9-pos-0.5.8-64e267e162ae4ff39e6b9c0bcbe19a2e.json`.
- Inspect после: `kitchen-0.4.9-pos-0.5.8`, блокировка свободна, остатков нет; публичный выпуск
  `b5f81015…`, API `b48fcd38…` и SHA-256 шлюза `82b6a2cd…f829` те же, что до.
- Снаружи (с MacBook): `kitchen/latest.json` HTTP/2 200 `no-store`, версия 0.4.9, тот же
  SHA-256 файла; установщик HEAD 200, 120908536 байт, полное скачивание даёт `407f3bf7…6949`;
  `pos/latest.json` не изменился (SHA-256 файла `1f304ed7…021a`, 0.5.8); корень
  `/desktop-updates/` 404.
- Ветка записи `codex/desktop-kitchen-049-1123-record` от `f438475a` (запись 0.5.8) с влитым
  `codex/kitchen-049-1123` (`7b1cd862`), слияние без конфликтов.

## Отзыв

`withdraw --package <пакет> --expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.8-pos-0.5.8 --expected-current kitchen-0.4.9-pos-0.5.8`,
сначала без изменений, затем с `--apply` в tmux; запись каталога вернуть к прежнему выпуску
(установленные версии не откатываются).

## Что дальше

Кухня 0.4.8 скачивает 0.4.9 сама и ставит её при запуске, в первые 10 минут или 03:00-05:59.
Подтверждение - заголовок окна кухонного моноблока; установка на моноблоке пока не подтверждена.
Обновление сервера точки на кассовом моноблоке, о котором писал владелец, - отдельный шаг,
этим выпуском не выполнялся.
