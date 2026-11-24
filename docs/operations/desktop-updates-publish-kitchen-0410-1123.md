# Кухня 0.4.10 - каталог обновлений 24.11.2026

## Статус

DEPLOYED: `kitchen-0.4.10-pos-0.5.8` (кухня `idle`, касса 0.5.8 перенесена побайтно).
Владелец 23.11 в 13:28 UTC про подвисания экрана кухни: «давай это устраним, чтобы кухня у нас
всегда стабильно работала»; 24.11 в 05:17 UTC: «продолжай мак включен». Выпуск выполнил Claude
через Remote Control на MacBook владельца (gh, SSH `pickchick-ops` с проверкой host key).
Пакет оператора тот же, что для 0.4.8 и 0.4.9:
`/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package` (`source_sha` 4df05b79).
API, шлюз, compose-файлы и базы не менялись; моноблоки по SSH не трогались.

## Что в кухне 0.4.10

Коммит `0ed0d0f70989b68de5d282f5a4d898d67b7b2596` (ветка `codex/kitchen-0410-1123`), стабильный
экран по Wi-Fi (`3f76ec5c`): фоновый опрос кассы раз в 5 с больше не блокирует кнопки до 12 с;
«Нет ответа локального узла» показывается только после трёх потерянных опросов подряд и
снимается следующим ответом; нажатие, ответ на которое потерялся, доводится само.

## Доказательство

- [Foundation CI 45185195301](https://github.com/xaaknazar/pickchick/actions/runs/45185195301) и
  [Windows Kitchen 45185235580](https://github.com/xaaknazar/pickchick/actions/runs/45185235580)
  на `0ed0d0f7`: success.
- Артефакт каталога `14822319122` (`pickchick-kitchen-update-feed-0ed0d0f7…`): 120921309 байт,
  SHA-256 `d900771b1e63923d77161184a7a77e2f7bbe51a96b54ad2e6d63b6c8613297b7`, совпадает с digest
  GitHub. Связь MacBook была медленной, поэтому сервер скачал артефакт сам по одноразовой ссылке
  GitHub, полученной через `gh` (токен на сервер не передавался). Внутри ровно
  `kitchen/latest.json` (219 байт, SHA-256 `adaa13a5…20c8`, версия 0.4.10, `apply=idle`) и
  `PickChick-Kitchen-Setup-0.4.10-x64.exe` 120909548 байт, SHA-256
  `4ebce48ec88fa4b0288f8786fccd7af9e9b8672f5ac42455b02edbd999ca1437` (тот же хеш в журнале сборки).
  Распакован в `/opt/pickchick-staging/incoming/desktop-kitchen-0410-1123/feed/kitchen`.
- Пакет оператора: SHA-256 четырёх файлов совпали с манифестом (`source_sha` 4df05b79).
- Inspect до: `kitchen-0.4.9-pos-0.5.8`, блокировки и остатков нет, хост приводит к шлюзу.
  Публичный выпуск и API с 23.11 сменились на `b9127817…`, шлюз `59bbd574…6d5c` (другой выпуск,
  не этот шаг). Publish без `--apply`: `inspected`, `validated=true`, план `kitchen=new` (0.4.10),
  `pos=carried` (0.5.8, `b49e6645…4a58`).
- Apply в tmux `desktop-kitchen-0410-1123` 24.11 05:18:41-05:18:48 UTC, exit 0, stderr пуст:
  `deployed`, этап `verify`, `previous_feed_release=kitchen-0.4.9-pos-0.5.8`, журнал
  `/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.10-pos-0.5.8-c5f93ebef5f7470687b2d1dda1bdf5ef.json`.
- Inspect после: `kitchen-0.4.10-pos-0.5.8`, блокировка свободна, остатков нет; публичный выпуск,
  API и шлюз те же, что до. SHA-256 файлов `feed/current/kitchen` на сервере совпадают.
- Снаружи (с MacBook): `kitchen/latest.json` HTTP/2 200 `no-store`, версия 0.4.10, тот же SHA-256
  файла; установщик HEAD 200, 120909548 байт (полное скачивание снаружи не делалось из-за медленной
  связи); `pos/latest.json` не изменился (SHA-256 файла `1f304ed7…021a`, 0.5.8); корень
  `/desktop-updates/` 404.
- Ветка записи `codex/desktop-kitchen-0410-1123-record` от `47697d19` (запись 0.4.9) с влитым
  `0ed0d0f7` (вместе с `3f76ec5c`), слияние без конфликтов.

## Отзыв

`withdraw --package <пакет> --expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.9-pos-0.5.8 --expected-current kitchen-0.4.10-pos-0.5.8`,
сначала без изменений, затем с `--apply` в tmux; запись каталога вернуть к прежнему выпуску
(установленные версии не откатываются).

## Что дальше

Кухня скачивает 0.4.10 сама и ставит её при запуске, в первые 10 минут или 03:00-05:59.
Подтверждение - заголовок окна кухонного моноблока; установка на моноблоке пока не подтверждена.
