# Касса 0.5.6 - каталог обновлений 20.11.2026

## Статус

DEPLOYED: `kitchen-0.4.7-pos-0.5.6` (касса `idle`, кухня 0.4.7 перенесена побайтно).
Владелец 20.11 в 14:38 UTC написал «да, поставь кассу 0.5.6 и включи оплату наличными на
тестовой кассе», в 20:57 UTC выбрал на карточке «Выложить в обновления» (Mac не был в сети
кассы). Выпуск выполнил Claude через Remote Control на MacBook Air владельца
(gh, SSH `pickchick-ops` с проверкой host key). Пакет оператора тот же, что для 0.4.7:
`/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package`
(`source_sha` 4df05b79, SHA-256 четырёх файлов сверены).

## Что в кассе 0.5.6

Линия Kaspi (тестовая касса работает на ней, 0.5.4): 0.5.5 - экран «Заказы» всегда на
сегодняшнем дне; 0.5.6 - настоящий канал заказа (Яндекс Еда / Glovo вместо «КАССА»),
фильтры Все / Касса / Яндекс Еда / Glovo, шапка называет открытую вкладку, «1 заказ».
Коммит `092480a022a3e21472a26de9a1268b7ac2ff9543` (ветка `claude/project-thread-hbvt30`).

## Доказательство

- [Windows POS 44754957973](https://github.com/xaaknazar/pickchick/actions/runs/44754957973):
  3/3 PASS, включая самообновление установленной кассы из каталога.
- Артефакт каталога `14637276801`: ровно `pos/latest.json` (SHA-256 на сервере
  `78122993…a34b`, `apply=idle`) и `PickChick-POS-Setup-0.5.6-x64.exe` 172282918 байт,
  SHA-256 `b1e82d75c1c3017e2625435fa43cd668aa974ad3bc5dddbe1bfe33b72943675b` (тот же хеш
  в журнале сборки). Загружен в `/opt/pickchick-staging/incoming/desktop-pos-056-1120/feed/pos`.
- Inspect до: `kitchen-0.4.7-pos-0.5.3`, блокировки и остатков нет, план `pos=new`,
  `kitchen=carried`. Publish без `--apply`: `inspected`, `validated=true`.
- Apply в tmux `desktop-pos-056-1120` 21:01:10-21:01:17 UTC, exit 0, `deployed`, журнал
  `/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.7-pos-0.5.6-40a573389cae4d34b313f88547ab248c.json`.
- Снаружи: `pos/latest.json` HTTP/2 200 `no-store`, версия 0.5.6, тот же SHA-256; установщик
  HEAD 200, 172282918 байт; `kitchen/latest.json` не изменился (0.4.7, `6a334acb…7701`).
- Одновременно (не этим выпуском) на сервере выкатили API `b48fcd38` (merge PR #403 в
  `codex/cutover-1119`): `current` переключён в 21:01:16, шлюз пересоздан (SHA-256
  `a723f568…`). Через минуту `feed_host_reaches_gateway=true`, каталог отвечает 200.
- Ветка этой записи: от `709936e3` (запись 0.4.7) с влитыми исходниками `092480a0`, потому что
  `tests/unit/desktop-updates-published.test.mjs` требует версию выпуска не выше исходников.

## Отзыв

`withdraw --package <пакет> --expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.7-pos-0.5.3 --expected-current kitchen-0.4.7-pos-0.5.6`
(установленные версии не откатываются).

## Что дальше

Касса ставит 0.5.6 сама при запуске, в первые 10 минут или 03:00-05:59, если никто не вошёл.
Подтверждение - заголовок окна кассы.
