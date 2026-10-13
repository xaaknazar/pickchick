# Центр устройств: выпуск 13 октября 2026

## Установлено и проверено

- API `5b6f846b80785f915e9f8dd7d45fa72fd4bc13ee`, cloud058; image
  `sha256:e1b4a09a3c8f2cb32ed6f7b40f8ef1a864737506868ce95329a1feb2fa3173ca`.
  [PR243](https://github.com/xaaknazar/pickchick/pull/243),
  [Foundation CI38409708107](https://github.com/xaaknazar/pickchick/actions/runs/38409708107),
  attempt2, 11/11. Первый запуск: browser demo logout/reload timeout; локальная
  проверка и повтор только упавшей группы успешны. Остальные группы не скрыты.
- Canonical [кабинет](https://pickchick.kz/backoffice/#devices) из
  `4caca195a4a52f15ae5f7d441b88155533146f4b`, image
  `sha256:ad96dae0df6a15a7216c62e282bf3e3d94ef1c63564c4b4d5aa6b553c8b33826`.
  [CI38404175860](https://github.com/xaaknazar/pickchick/actions/runs/38404175860)
  11/11. Файлы HTTPS совпали со сборкой, контейнер healthy, авторизация сохранена.
- Gateway того же исходника: только POST `/v1/kiosk-checkout/device-presence`,
  ограничение 4KB, удаление Cookie/Authorization перед forwarding. Анонимный
  запрос отклонён 401. SHA256 конфигурации:
  `f9e758ce74a4fe3b9fab6ca939920c8f5856fc2376d7c38565e92068884b2eee`.
- Шифрованная копия и изолированное восстановление перед API, private restore
  перед порталом успешны. Старые данные и права сохранены; соседние контейнеры,
  idrink и платёжные настройки не менялись. Реальная авторизованная проверка
  подтвердила inventory enabled и pairing disabled.

Public pointer позже законно продвинут другим Mac на `06652d6f` при публикации
пульта; gateway hash сохранён. Это не основание возвращать старый pointer.
Данный протокол ещё не опубликован в онлайн-пульте, область занята другим Mac.

## Windows: частично завершённая подготовка

Касса доступна по SSH на `192.168.3.33` с проверенным host fingerprint.
Runtime `5b6f846b` (exact020) staged; ZIP SHA256
`c8ea7a0e5c6140289d07e3db6a333d17db1db7d387281cab39d049e191c037f3`.
Stage receipt и 8004 файла проверены. Прежний runtime `23fb39e1` продолжает
работать; schema020 committed, службы восстановлены. Во время продолжительной
подготовки перезапустился FulfillmentTunnel; PostgreSQL сохранил PID/start time.
`Assert-UnifiedPreserved` остановил оператор после COMMIT, до записи Prepare.json.
Повтор Prepare запрещён. Вывод первоначального результата не восстановлен.

Сохранены проверенные backup019 и свежая backup020; обе восстановлены в отдельную
БД, сверены и тестовые БД удалены. SHA256 архивов:

- 019: `7c9aec3c7f69b1fad663dde02093aa5fcf2dc3dc94842da9f2acd5eae1ad31e1`;
- 020: `468e61063d48fd61f38262ea94c23c986af7c263693c2e221ad95193cee37904`.

## Продолжение после потерянной отметки

`infra/windows/recover-native-device-access.ps1` проверяет полный исходник/CI
оператора и runtime, архив/ACL/stage, свежую backup020, прежние XML, отключённый
флаг и восстановленные службы. `device-access-recovery.mjs` вызывает только
исходную read-only инспекцию, проверяет фактический вход сохранённым служебным
credential в READ ONLY транзакции, пустой mailbox и отсутствие enrolled экранов.
Повторная инспекция должна дать тот же fingerprint данных; изменения блокируют
продолжение. Только `-Apply` записывает новый CreateNew Prepare.json с форматом
`pickchick-device-preparation-recovered-v1`, mode=inspect, migrationApplied=false
и originalPreparationReceiptAvailable=false. Это новая проверка текущей готовности,
не поддельный результат старой миграции. БД, env и службы не меняются.

На момент этого checkpoint recovery ещё не выполнен на рабочей кассе.
Далее: Switch exact020, ManualStopped worker, KitchenLink update/Verify, актуальные
proofs; после освобождения API - guarded cloud/Windows/portal activation.
Проверить наличие исходного kitchen-package.json в installed release до активации:
старый update-deploy копирует payload, но не manifest; не обходить проверку.

## Границы результата

- Карточки/история устройств доступны. Не зарегистрированные физические устройства
  не добавлены искусственно, тестовые команды в рабочую очередь не посылались.
- Pairing и восстановление пароля пока выключены; PIN/пароль кухни не менялись.
- Runtime020 не включает отдельную телеметрию021. Нативная сборка киоска с heartbeat
  и физическая приёмка iPad/экранов не выполнены этим выпуском.
- USB-телевизоры поддерживают только учёт; удалённое питание/изображение неизвестны.
