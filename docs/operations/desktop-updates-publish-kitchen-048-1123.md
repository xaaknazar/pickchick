# Кухня 0.4.8 - каталог обновлений 23.11.2026

## Статус

DEPLOYED: `kitchen-0.4.8-pos-0.5.7` (кухня `idle`, касса 0.5.7 перенесена побайтно).
Владелец 23.11 в 09:02 UTC разрешил поставить новую кухню на кухонный моноблок
(«…я тебе разрешаю это все поставить на паноблоке кухни… смело делай»). Выпуск выполнил Claude
через Remote Control на MacBook Air владельца (gh, SSH `pickchick-ops` с проверкой host key).
Пакет оператора тот же, что для 0.4.7 и 0.5.7:
`/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package` (`source_sha` 4df05b79).
API, шлюз, compose-файлы и базы не менялись; моноблоки по SSH не трогались.

## Что в кухне 0.4.8

Коммит `04f4204e8caeb442f7fe8d3456e34f75a4ec6521` (ветка `codex/kitchen-tickets-1123`):
новые талоны повара и сборки, состав сетов, полоса «всего на день», звук нового заказа.

## Доказательство

- [Foundation CI 45143586668](https://github.com/xaaknazar/pickchick/actions/runs/45143586668) и
  [Windows Kitchen 45143586666](https://github.com/xaaknazar/pickchick/actions/runs/45143586666)
  на `04f4204e`: success.
- Артефакт каталога `14803122351` (`pickchick-kitchen-update-feed-04f4204e…`): 120919251 байт,
  SHA-256 `8ba00a6040a2cc21600e3f07520cd51a5b20b59fce8eab5c758d0ac79b512c8f`, совпадает с digest
  GitHub. Внутри ровно `kitchen/latest.json` (217 байт, SHA-256 `fcc46c3f…0d1f`, версия 0.4.8,
  `apply=idle`) и `PickChick-Kitchen-Setup-0.4.8-x64.exe` 120907570 байт, SHA-256
  `c263a98145578780a5a0a1b2ae7db18daf4d0dce8990d5a38782a0a8b6131810` (тот же хеш в журнале сборки).
  Загружен в `/opt/pickchick-staging/incoming/desktop-kitchen-048-1123/feed/kitchen`; на сервере
  SHA-256 обоих файлов совпали.
- Пакет оператора: манифест `source_sha` 4df05b79, SHA-256 четырёх файлов совпали с манифестом.
- Inspect до: `kitchen-0.4.7-pos-0.5.7`, блокировки и остатков нет, хост приводит к шлюзу.
  Publish без `--apply`: `inspected`, `validated=true`, план `kitchen=new` (0.4.8), `pos=carried`
  (0.5.7, `d59b1ce8…3e89`).
- Apply в tmux `desktop-kitchen-048-1123` 23.11 09:57:30-09:57:37 UTC, exit 0, stderr пуст:
  `deployed`, этап `verify`, `previous_feed_release=kitchen-0.4.7-pos-0.5.7`, журнал
  `/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.8-pos-0.5.7-0e9870b48e7b41bba482352bdf5edfb9.json`.
- Inspect после: `kitchen-0.4.8-pos-0.5.7`, блокировка свободна, остатков нет; публичный выпуск
  `b5f81015…`, API `b48fcd38…` и SHA-256 шлюза `82b6a2cd…f829` те же, что до.
- Снаружи (с MacBook Air): `kitchen/latest.json` HTTP/2 200 `no-store`, версия 0.4.8, тот же
  SHA-256 файла; установщик HEAD 200, 120907570 байт, полное скачивание даёт `c263a981…1810`;
  `pos/latest.json` не изменился (SHA-256 файла `5d5fbf0b…8e29`, 0.5.7); корень
  `/desktop-updates/` 404.
- Ветка записи `codex/desktop-kitchen-048-1123-record` от `f9c359dd` (запись 0.5.7) с влитым
  `codex/kitchen-tickets-1123` (`04f4204e`): проверка записи требует версию выпуска не выше
  исходников. Конфликт слияния был только в `docs/project-status.md` (два независимых раздела,
  оставлены оба).

## Отзыв

`withdraw --package <пакет> --expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.7-pos-0.5.7 --expected-current kitchen-0.4.8-pos-0.5.7`,
сначала без изменений, затем с `--apply` в tmux; запись каталога вернуть к прежнему выпуску
(установленные версии не откатываются).

## Что дальше

Кухня 0.4.7 скачивает 0.4.8 сама и ставит её при запуске, в первые 10 минут или 03:00-05:59.
Подтверждение - заголовок окна кухонного моноблока; установка на моноблоке пока не подтверждена.
