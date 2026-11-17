# Кухня 0.4.6 - каталог обновлений 17.11.2026

## Статус

DEPLOYED: `kitchen-0.4.6-pos-0.5.3`, режим `idle` у обеих программ.
Владелец разрешил именно кухню 0.4.6 во время заморозки 17.11; касса 0.5.3
перенесена побайтно. Код, настройки устройств и ключи KitchenLAN не менялись.
Физическое обновление кухни и включение ключа на точке выполняет Claude отдельно.

## Доказательство

- Пакет оператора собран на чистом checkout текущего cutover
  `4df05b795226408ad1c81d5801425f3c2b9814d4`, слияние PR398.
  Дерево совпадает с проверенным исходником сборки
  `233ac7641e943a1b1288dfec294103b8953dbfd0`: `c652e0aaeecb8aeab741a5dc54a1ced0f32a84a8`.
- [Foundation 44062935874](https://github.com/xaaknazar/pickchick/actions/runs/44062935874):
  11/11 PASS на `233ac764` до публикации.
- [Windows Kitchen 44062935653](https://github.com/xaaknazar/pickchick/actions/runs/44062935653):
  3/3 PASS, пакет/запуск, самообновление и место установки POS.
- [Windows KitchenLAN guards 44063414860](https://github.com/xaaknazar/pickchick/actions/runs/44063414860)
  и [Foundation основы 44062445263](https://github.com/xaaknazar/pickchick/actions/runs/44062445263) PASS.
- Артефакт `14318528140`: 120914183 байт, SHA-256
  `6ae6417682cb9952c3598a995c9b44ad0976cc1472d2206743f819e614385541`, совпадает с digest GitHub.
- Установщик `PickChick-Kitchen-Setup-0.4.6-x64.exe`: 120902430 байт, SHA-256
  `2cf3fe86fe337d0d85f2d64d7a50c7115d821ea8eb63edd94a1306fe35a18bbd`.
  Совпали журнал `verify:win`, раскладка feed, скачанный артефакт и проверка оператора.
  `latest.json` из артефакта сохранён, `apply=idle`.
- Пакет `desktop-updates-4df05b79-1117.tar.gz`: четыре файла, SHA-256
  `7a96fcc9c2e71d09a56579aa1ff9d56267b95e43a1b5685793ab67bce23873b4`.
  Подготовительный путь `/opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117`.
  SSH от `pickchick-ops` с обязательной проверкой host key.
- Inspect до: `kitchen-0.4.5-pos-0.5.3`, блокировка отсутствует, каталог и маршрут
  установлены, хост приводит к шлюзу. План `kitchen=new`, `pos=carried`.
- Предварительный publish: `status=inspected`, `validated=true`, `applied=false`.
- Apply выполнен в tmux `desktop-kitchen-046-1117`, exit 0, stderr пуст.
  Оператор прочитал оба установщика через публичный HTTPS частями, сверил SHA-256,
  проверил запрещённые адреса и неизменность контейнеров. Итог `deployed`.
- Inspect после: новый выпуск, блокировка свободна, неудачных остатков нет.
  API и public release остались на `bf325a47fea53519906fe9bc86816698249796de`;
  SHA-256 шлюза остался `61c284ca999b2f8d8826f214c83cd1d5fd6120b003363183bc6323bfd3f70d61`.
- Оба файла кассы совпадают с 0.4.5-каталогом: установщик 172279898 байт,
  SHA-256 `56ebe751915275e744b25ca2daf9ef4a1ead0ffa770c24c937c19d78682f0aa1`;
  `latest.json` 209 байт, SHA-256
  `2b1795289e86a2d0aadb27797aaedaf9a101e10fb0d309cf6f1d117735de734b`.
- Локальная проверка клиента каталога: 3/3 PASS.
  [CI и артефакты](desktop-kitchen-046-1117/build-proof.json),
  [inspect до](desktop-kitchen-046-1117/inspect-before.json),
  [inspect после](desktop-kitchen-046-1117/inspect-after.json),
  [сохранённая касса](desktop-kitchen-046-1117/carried-pos-proof.json).

## Ответ publish

Полная строка оператора сохранена в
[publish-result.json](desktop-kitchen-046-1117/publish-result.json):
`status=deployed`, `feed_release=kitchen-0.4.6-pos-0.5.3`,
`previous_feed_release=kitchen-0.4.5-pos-0.5.3`, `phase=verify`.
Журнал сервера:
`/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.6-pos-0.5.3-a62bf2e885554af3bb533ad6430733e7.json`.

## Откат

Откат не понадобился. Прежний выпуск `kitchen-0.4.5-pos-0.5.3` сохранён.
При решении об отзыве выполнить штатный `withdraw` из того же пакета:
`--package /opt/pickchick-staging/incoming/desktop-updates-4df05b79-1117/package
--expected-source-sha 4df05b795226408ad1c81d5801425f3c2b9814d4
--to kitchen-0.4.5-pos-0.5.3 --expected-current kitchen-0.4.6-pos-0.5.3`,
сначала без изменений, затем с `--apply` в tmux. Запись каталога вернуть к
прежнему выпуску и проверить снаружи. Установленную версию отзыв не понижает.

## Дальше

- Desktop update feed check запускается отправкой записи выпуска; результат будет добавлен сюда.
- После обычного обновления проверить 0.4.6 в заголовке кухни. Ключ KitchenLAN и
  пять файлов на кассовом моноблоке устанавливает Claude; это не часть публикации каталога.
- Подтверждения установки 0.4.6 на физическом моноблоке пока нет.
  Онлайн-пульт не публиковался: серверное разрешение ограничено каталогом обновлений.
