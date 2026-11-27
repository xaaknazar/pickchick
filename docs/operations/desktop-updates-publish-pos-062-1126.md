# Касса 0.6.2 - каталог обновлений 26.11.2026

## Статус

DEPLOYED: `kitchen-0.4.10-pos-0.6.2` (касса `idle`, кухня 0.4.10 перенесена побайтно).
Владелец 26.11 в 08:53 UTC: «Разрешаю опубликовать кассу 0.6.2». Выпуск выполнил Claude через
Remote Control на MacBook владельца (gh, SSH `pickchick-ops`). Пакет оператора тот же, что для
0.6.0 и 0.6.1: `/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package`
(`source_sha` 4df05b79). Сервер точки, база, облачный API, настройки и Webkassa не менялись и
не вызывались.

## Что в кассе 0.6.2

Касса 0.6.1 плюс (`a0b1a6af`, `72dcb900`, `apps/pos-desktop/printer.mjs`, тесты):

- фирменный фискальный чек больше не отбрасывается из-за строки Webkassa
  «Тапсырыс нөмірі/Номер заказа» (она печатается с тех пор, как точка передаёт
  `ExternalOrderNumber`; причина видна на формах чеков 132431784 и 132490612);
- кнопка «Печать чека» на экране завершения повторяет фирменный фискальный чек;
- нарезка формы по содержимому, а не по точному числу разделителей.

Сборка с `72dcb9006cd6b72cb8bb0ce2d9c31064bf1c3d81` (ветка `codex/webkassa-1125`).

## Доказательство

- [Windows POS package 45786988201](https://github.com/xaaknazar/pickchick/actions/runs/45786988201):
  success на `72dcb900` (установка, самообновление с каталога, проверки PowerShell 5.1).
- `apps/pos-desktop/package.json` на `72dcb900`: `0.6.2`.
- `tests/pos-desktop/fiscal-branded.test.mjs` с `72dcb900`: 8/8. Сохранённые реальные формы
  `Ticket/PrintFormat` чеков 132490612 и 132431784 (QR как строка типа 2): `brandedFiscalRows`
  не `null`, 35 строк у каждой.
- Артефакт `pickchick-pos-update-feed-72dcb900…`: `pos/latest.json` (SHA-256 `cb97aef1…0b10`,
  `apply=idle`) и `PickChick-POS-Setup-0.6.2-x64.exe` 172300215 байт, SHA-256
  `7b723e1dda8dfbacbddc8e6f6f7784848c5a387c43cda8e6f449d86b50510b15` (совпадает с `latest.json` и
  с шагом «Lay out the update feed of this build» журнала сборки). Загружен в
  `/opt/pickchick-staging/incoming/desktop-pos-062-1126/feed/pos`, на сервере тот же SHA-256.
- Inspect до: `kitchen-0.4.10-pos-0.6.1`, блокировки и остатков нет, план `pos new`,
  `kitchen carried`. Publish без `--apply`: `inspected`, `validated=true`, имя
  `kitchen-0.4.10-pos-0.6.2`.
- Apply 26.11 ~09:03 UTC (tmux): `deployed`, `phase=verify`, журнал
  `/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.10-pos-0.6.2-686f6306a102468b91c2a7ad05085c62.json`.
- Снаружи 09:03:30 UTC: `pos/latest.json` HTTP/2 200 `no-store`, версия 0.6.2, тот же SHA-256;
  установщик HEAD 200, 172300215 байт; `kitchen/latest.json` не изменился (тело SHA-256
  `adaa13a5…20c8`); корень `/desktop-updates/` 404.

## Отзыв

`withdraw --package <пакет> --expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.10-pos-0.6.1 --expected-current kitchen-0.4.10-pos-0.6.2`
(установленные версии не откатываются).

## Что дальше

Тестовая касса ставит 0.6.2 сама при запуске, в первые 10 минут или 03:00-05:59, если никто не
вошёл. Подтверждение - заголовок окна кассы и фирменный вид следующего фискального чека
(с номером заказа в форме Webkassa).
