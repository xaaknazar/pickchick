# Кухня 0.4.12 - каталог обновлений 28.11.2026

## Статус

DEPLOYED: `kitchen-0.4.12-pos-0.6.3` (кухня `idle`, касса 0.6.3 перенесена побайтно).
Владелец 27.11 перечислил восемь улучшений кухни и написал «сделай их». Выпуск выполнил Claude
через Remote Control на MacBook владельца (gh, SSH `pickchick-ops` с проверкой host key).
Пакет оператора тот же, что для 0.4.8-0.4.11:
`/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package` (`source_sha` 4df05b79).
API, шлюз, compose-файлы и базы не менялись; моноблоки по SSH не трогались.

## Что в кухне 0.4.12

Коммит `a2191963c16e8afe14ccca4c2ae20d1ef15d2d61` (ветка `codex/kitchen-0412-1127`, PR 439):
цвет таймера (зелёный, жёлтый после нормы, красный после двух норм; без нормы 5 и 10 минут),
звук и мигание нового и просроченного заказа, красные пометки повару и «Аллергия», отмена нажатия
5 секунд и «Отправить сейчас», значок связи с кассой, цветные метки источника и доставка сверху,
табло «Готовится / Готов к выдаче». Норма станции из бэк-офиса приходит после обновления сервера
кассы (PR 441, `docs/operations/kitchen-norms-speed-1127.md`).

## Доказательство

- [Foundation CI 46055840573](https://github.com/xaaknazar/pickchick/actions/runs/46055840573) и
  [Windows Kitchen 46055928198](https://github.com/xaaknazar/pickchick/actions/runs/46055928198)
  на `a2191963`: success.
- Артефакт каталога `15226921384` (`pickchick-kitchen-update-feed-a2191963…`): 120926327 байт,
  SHA-256 `24ea6427bbef50943811910a2b81f36d610bfbe12bd015a42a899e8992ab6d28`, совпадает с digest
  GitHub. Сервер скачал его сам по одноразовой ссылке GitHub (токен на сервер не передавался).
  Внутри ровно `kitchen/latest.json` (219 байт, SHA-256 `537bb700…be86e`, версия 0.4.12,
  `apply=idle`) и `PickChick-Kitchen-Setup-0.4.12-x64.exe` 120914563 байт, SHA-256
  `5f9a83aba0828031dc0b05b58550dade6a1252f5f3d0087d82ab75e56c165b20` (тот же хеш в журнале сборки).
  Распакован в `/opt/pickchick-staging/incoming/desktop-kitchen-0412-1128/feed/kitchen`.
- Пакет оператора: SHA-256 четырёх файлов совпали с манифестом (`source_sha` 4df05b79).
- До: лента `kitchen-0.4.11-pos-0.6.3`, блокировки и остатков нет. Publish без `--apply`:
  `validated=true`, план `kitchen=new` (0.4.12), `pos=carried` (0.6.3, `69ed4593…f53f`).
- Apply в tmux `desktop-kitchen-0412-1128` 28.11 14:23:18-14:23:23 UTC, exit 0, stderr пуст:
  `deployed`, этап `verify`, журнал
  `/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.12-pos-0.6.3-bd8f77cbfbb54d9ea7c46805b75ed391.json`.
- После: SHA-256 файлов на сервере совпадают с артефактом, шлюз тот же (`59bbd574…6d5c`).
- Снаружи (с MacBook): `kitchen/latest.json` 200 `no-store`, версия 0.4.12, тот же SHA-256 файла;
  установщик HEAD 200, 120914563 байт; `pos/latest.json` не изменился (0.6.3, `69ed4593…f53f`);
  корень `/desktop-updates/` 404.

## Отзыв

`withdraw --package <пакет> --expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.11-pos-0.6.3 --expected-current kitchen-0.4.12-pos-0.6.3`,
сначала без изменений, затем с `--apply` в tmux; запись каталога вернуть к прежнему выпуску
(установленные версии не откатываются).

## Что дальше

Кухня скачивает 0.4.12 сама и ставит её при запуске, в первые 10 минут или 03:00-05:59.
Подтверждение - заголовок окна кухонного моноблока; установка на моноблоке пока не подтверждена.
