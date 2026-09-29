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
  Опциональные `--phone-file` (JSON с `cashier_phone`) и `--password-file` читаются
  только из приватных обычных файлов владельца, символьные ссылки запрещены.
- `kaspi-check.mjs` - только проверка сессии, без создания счетов.
- `pickchick-kaspi-*.service` - шаблоны systemd.

29 сентября пароль и SMS реально приняты банком. Следующий экран -
`UniversalKaspiIdTakePhoto`: сессия ещё не получена. Подробности и источники:
[аудит](../../../docs/operations/kaspi-bridge-audit-2026-09-29.md).
Обновление не включает оплаты на VPS или в мобильной корзине.
