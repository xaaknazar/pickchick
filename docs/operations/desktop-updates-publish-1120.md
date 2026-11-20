# Кухня 0.4.7 - каталог обновлений 20.11.2026

## Статус

DEPLOYED: `kitchen-0.4.7-pos-0.5.3`, режим `idle` у обеих программ.
Владелец разрешил выпуск кухни 0.4.7 19.11 в 06:52 UTC (карточка решения в потоке
моноблоков), 20.11 в 14:35 UTC попросил сделать его без Codex и в 14:43 UTC написал
«да, выложи кухню 0.4.7 в обновления». Выпуск выполнил Claude через Remote Control на
MacBook Air владельца (gh и SSH от `pickchick-ops` с обязательной проверкой host key).
Касса 0.5.3 перенесена побайтно. Код, настройки устройств, API, шлюз и базы не менялись.

## Что исправляет 0.4.7

После «Готово» на станции, «Заказ собран» и «Подтвердить выдачу» в сборке на долю секунды
появлялась панель «Незавершённая команда»: панель рисовалась, пока в журнале команд есть
запись, а журнал пишется перед каждым запросом. Кухня 0.4.7 показывает панель только после
потерянного ответа или перезапуска. Журнал по-прежнему пишется до запроса, повтор отправляет
тот же запрос с тем же ключом. API, сервер точки и шлюз KitchenLAN не менялись.

## Доказательство

- Сборка кухни из `0612f93b1a1b24cf19eea698a99021e06a0dfca8` (ветка
  `claude/project-thread-ntdsta`, PR #399, копия для CI `codex/report-fn-grants-1118`), база
  `codex/cutover-1119` `4df05b79`. PR #399 ещё не слит: слиянию мешает общая проверка
  зависимостей (ниже). Поэтому в ветку этой записи влиты исходники `0612f93b`: проверка записи
  (`tests/unit/desktop-updates-published.test.mjs`) требует, чтобы выложенная версия не была
  выше версии в исходниках. Первая запись без них (`ba8386e3`) получила красную проверку
  [44757511987](https://github.com/xaaknazar/pickchick/actions/runs/44757511987) именно на этом
  (`kitchen: the published 0.4.7 is above the sources (0.4.6)`), до чтения каталога.
- [Windows Kitchen 44326359248](https://github.com/xaaknazar/pickchick/actions/runs/44326359248):
  3/3 PASS: упаковка и запуск кухни на Windows x64 (Electron: вход, станции, табло,
  потерянный ответ, перезапуск), самообновление установленной кухни из каталога, место
  установки кассы.
- [Foundation 44326357859](https://github.com/xaaknazar/pickchick/actions/runs/44326357859)
  на `0612f93b`: 9 заданий PASS; в «Foundation static checks and transaction invariants» все
  шаги PASS, кроме последнего `Check dependency advisories`; сводка «Build, contracts and
  PostgreSQL integration» красная только из-за него. Причина: picomatch GHSA-fc5q-39xc-vjpf,
  шаг красный с 18.11 на всех ветках, исправленной версии на npm нет (на 20.11 последняя
  4.0.7). picomatch есть только в инструментах сборки, в установщик кухни зависимости не
  входят. «Local kitchen UI and recovery» PASS: браузерный сценарий кухни падает, если обычная
  команда хоть на кадр показала панель.
- [Windows POS 44326357871](https://github.com/xaaknazar/pickchick/actions/runs/44326357871)
  на том же коммите PASS.
- Артефакт `14436707688` (`pickchick-kitchen-update-feed-0612f93b…`): 120914507 байт, SHA-256
  `d663e383723d7004f0d977897d8e890c45bb1853d1d384da2f1a5cd48a9af1ba`, совпадает с digest
  GitHub. Внутри ровно `kitchen/latest.json` (217 байт, SHA-256
  `6a334acbd985e717619ebea8827e20aabc89288a99b193fb2ac1d16dc28e7701`, `apply=idle`) и
  `PickChick-Kitchen-Setup-0.4.7-x64.exe`: 120902775 байт, SHA-256
  `39b2785e3906f8f26c24b7b2f720d9c10bad60561680434e3e5c9f72432719ec`. Тот же хеш печатает
  журнал сборки (шаг «Lay out the update feed of this build»).
  [Сверка каталога](desktop-kitchen-047-1120/kitchen-feed-proof.json).
- Пакет оператора не собирался заново: голова `codex/cutover-1119` по-прежнему `4df05b79`,
  поэтому взят пакет выпуска 0.4.6
  `/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package`. Его `source_sha`
  `4df05b795226408ad1c81d5801425f3c2b9814d4`; SHA-256 четырёх файлов совпали и с манифестом
  пакета, и с файлами коммита. [CI, артефакт и пакет](desktop-kitchen-047-1120/build-proof.json).
- Каталог кухни загружен в `/opt/pickchick-staging/incoming/desktop-kitchen-047-1120/feed/kitchen`
  (папки до этого не было); на сервере SHA-256 и размеры обоих файлов совпали.
- Inspect до: `kitchen-0.4.6-pos-0.5.3`, блокировка отсутствует, остатков нет, хост приводит
  к шлюзу. План `kitchen=new`, `pos=carried`.
  [inspect до](desktop-kitchen-047-1120/inspect-before.json).
- Предварительный publish: `status=inspected`, `validated=true`, `applied=false`.
  [publish без --apply](desktop-kitchen-047-1120/publish-dry-run.json).
- Apply в tmux `desktop-kitchen-047-1120` в 14:46:43 UTC, около 60 секунд, exit 0, stderr
  пуст. Скрипт прочитал установщики через публичный HTTPS частями, сверил SHA-256 и проверил
  неизменность контейнеров. Итог `deployed`, этап `verify`.
- Inspect после: новый выпуск, блокировка свободна, неудачных остатков нет. API и публичный
  выпуск остались на `bf325a47fea53519906fe9bc86816698249796de`; SHA-256 шлюза остался
  `61c284ca999b2f8d8826f214c83cd1d5fd6120b003363183bc6323bfd3f70d61`.
  [inspect после](desktop-kitchen-047-1120/inspect-after.json).
- Снаружи (с MacBook Air): `kitchen/latest.json` отвечает HTTP/2 200 с `cache-control: no-store`,
  217 байт, тот же SHA-256; установщик по HEAD 200, 120902775 байт. `pos/latest.json`
  209 байт, SHA-256 `2b1795289e86a2d0aadb27797aaedaf9a101e10fb0d309cf6f1d117735de734b`, как в
  выпуске 0.4.6. [Сохранённая касса](desktop-kitchen-047-1120/carried-pos-proof.json).

## Ответ publish

Полная строка оператора сохранена в
[publish-result.json](desktop-kitchen-047-1120/publish-result.json):
`status=deployed`, `feed_release=kitchen-0.4.7-pos-0.5.3`,
`previous_feed_release=kitchen-0.4.6-pos-0.5.3`, `phase=verify`.
Журнал сервера:
`/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.7-pos-0.5.3-ea0c91e249fc4dbc8c41614fd2f0aeab.json`.

## Откат

Откат не понадобился. Прежний выпуск `kitchen-0.4.6-pos-0.5.3` сохранён.
При решении об отзыве выполнить штатный `withdraw` из того же пакета:
`--package /opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package
--expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.6-pos-0.5.3 --expected-current kitchen-0.4.7-pos-0.5.3`,
сначала без изменений, затем с `--apply` в tmux. Запись каталога вернуть к
прежнему выпуску и проверить снаружи. Установленную версию отзыв не понижает.

## Дальше

- «Desktop update feed check» на коммите этой записи: результат допишется следующим коммитом.
- Кухня 0.4.6 скачивает 0.4.7 сама, пока программа открыта, и ставит её при запуске, в первые
  10 минут после запуска или с 03:00 до 05:59. Затем Claude проверяет версию в заголовке окна
  кухонного моноблока и проходит заказ с кассы через кухню и сборку. Подтверждения установки
  0.4.7 на физическом моноблоке пока нет.
- Онлайн-пульт не публиковался: разрешение владельца относится только к каталогу обновлений.
- PR #399 (исходник этой кухни) сливается в `codex/cutover-1119` после решения по проверке
  зависимостей. Следующую кухню собирать только после этого слияния, иначе она потеряет
  исправление.
