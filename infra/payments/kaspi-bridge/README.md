# Kaspi bridge (kaspi-remote)

Файлы установки локального моста кассира Kaspi Pay и worker счётов.
Порядок, риски и проверки: [docs/operations/kaspi-remote.md](../../../docs/operations/kaspi-remote.md).

- `pickchick-hardening.patch` - патч к `tapter-dev/kaspi-pos-automation@28c9167`:
  только 127.0.0.1, без демо-UI и возвратов, без логов секретов и телефонов,
  без записи сессии на диск (`BRIDGE_POLLING=off`).
- `kaspi-bridge.env.example`, `kaspi-remote.env.example` - шаблоны приватных env (0600).
- `kaspi-login.mjs` - вход кассира по SMS, пишет сессию в приватный файл.
- `kaspi-check.mjs` - только проверка сессии, без создания счетов.
- `pickchick-kaspi-*.service` - шаблоны systemd.
