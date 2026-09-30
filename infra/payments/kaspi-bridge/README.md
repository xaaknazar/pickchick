# Kaspi bridge (kaspi-remote)

Файлы установки локального моста кассира Kaspi Pay и worker счётов.
Порядок, риски и проверки: [docs/operations/kaspi-remote.md](../../../docs/operations/kaspi-remote.md).

- `pickchick-hardening.patch` - патч к `tapter-dev/kaspi-pos-automation@28c9167`:
  только 127.0.0.1, без демо-UI и возвратов, без логов секретов и телефонов,
  без записи сессии на диск (`BRIDGE_POLLING=off`).
- `kaspi-bridge.env.example`, `kaspi-remote.env.example` - шаблоны приватных env (0600).
- `pickchick-entrance.patch`, `entrance-flow.mjs` - парольный шаг и SMS с проверкой
  состояния процесса. Kaspi ID распознаётся как отдельное неподдержанное требование;
  фиктивное подтверждение не отправляется.
- `bank-time.mjs` - правильное время подписанных запросов в часовом поясе Алматы.
- `install-overlays.mjs UPSTREAM_DIRECTORY` - применяет оба патча и копирует модули
  только к закреплённому SHA. Повторное применение проверяет уже наложенные патчи.
- `verify-overlays.mjs UPSTREAM_DIRECTORY` - изолированная HTTP-проверка на копии
  checkout с установленными npm-зависимостями, только против подставного банка.
- `kaspi-login.mjs` - вход кассира по паролю/SMS, скрывает ввод, пишет сессию в 0600.
  Перед заменой файла требует завершённый вход, роль кассира и read-only проверку
  сессии банком; отказ сохраняет прежний файл. Это не реализует нативный Kaspi ID.
  Опциональные `--phone-file` (JSON с `cashier_phone`) и `--password-file` читаются
  только из приватных обычных файлов владельца, символьные ссылки запрещены.
- `kaspi-check.mjs` - только проверка сессии, без создания счетов.
- `pickchick-kaspi-*.service` - шаблоны systemd.

29 сентября вход нового кассира завершён через SMS: банк подтвердил роль,
ИП PICK CHICK ALA AP и активную сессию до/после перезапуска. Единственную
точку Abay Plaza подтвердил владелец. Подробности и источники:
[аудит](../../../docs/operations/kaspi-bridge-audit-2026-09-29.md).
[Мост установлен на VPS](vps-installation-2026-09-29.md), сессия подтверждена банком
до/после перезапуска. Обновление не включает выставление счетов или оплату в корзине.

## Контейнер для VPS без установленного Node.js

`prepare-container.mjs UPSTREAM_CHECKOUT NEW_DIRECTORY` собирает контекст из
закреплённого Git commit upstream и двух проверенных патчей. Незаписанные в Git
файлы исходного checkout (в том числе секреты устройства) не копируются.
`manifest.json` содержит хеши файлов. `Dockerfile` использует Node 24.16.0 по
digest; npm lifecycle scripts выключены. Build context не содержит сессию.

`container.compose.yaml` запускает только мост: без worker, доступа к БД,
публичных портов, UI, автоматического входа и запросов счетов. Четыре файла
`bridge.env`, `session.env`, `keypair.json`, `device.json` передаются защищённым
каналом в отдельный каталог 0700, сами файлы 0600, владелец 1000:1000. Сохранять
именно комплект успешного входа, не генерировать ключи заново. Данные монтируются
read-only, отсутствующие файлы не создаются Docker как каталоги. `BRIDGE_POLLING=off`.

Перед установкой: свежие refs, claim `@vps`, чистый опубликованный SHA,
успешные все шесть Foundation CI jobs для этого SHA, штатный
`/opt/pickchick-staging/.market-release.lock` с owner.json. При неопределённом
результате SSH lock сохраняется. Не менять API, БД, gateway или другие контейнеры.
После сборки: сверить label SHA, mounts, loopback и отсутствие published ports;
проверить `/health`, затем один read-only запрос `session-check.mjs`, перезапуск
и повторную проверку. Проверка запускается так:

```sh
docker exec pickchick-kaspi-bridge node --env-file=/run/kaspi/session.env session-check.mjs
```

В stdout только active/reason/invoiceAttempted, ответ банка не выводится.
Healthcheck проверяет процесс локально, не опрашивает банк каждые 30 секунд.
Для остановки использовать compose stop только этого release. Файлы ключей
и сессии сохраняются. Запуск будущего worker возможен в network namespace
моста (`network_mode: service:bridge`), после отдельной миграции/проверки ledger;
нельзя подменять loopback публичным адресом.
