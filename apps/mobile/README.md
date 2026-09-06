# PickChick Mobile

Нативный Expo-клиент iOS/Android по [дизайну v0.2](../../docs/design/README.md).
Первая версия предназначена для внутреннего тестирования: меню читается с VPS,
корзина сохраняется на устройстве, все 35 мобильных страниц доступны в галерее.
При действующем `features.test_order_flow` клиент создаёт синтетические заказы
в PostgreSQL и читает их статусы после действий двух тестовых кухонных станций.
Тестовая оплата обозначена отдельно и не обращается к банку. OTP, настоящие
платежи, фискальные чеки и Чики пока недоступны.

```sh
pnpm install --frozen-lockfile
pnpm --filter @pickchick/contracts build
pnpm --filter @pickchick/test-order-flow build
pnpm --filter @pickchick/mobile start
pnpm --filter @pickchick/mobile ios
pnpm --filter @pickchick/mobile android
```

`ios` / `android` создают development build и требуют соответствующий SDK.
Для TestFlight нужен встроенный Release bundle:
[локальный выпуск](../../docs/operations/mobile-testflight.md).

```sh
pnpm --filter @pickchick/mobile exec expo install --check
pnpm --filter @pickchick/mobile typecheck
pnpm test:mobile
pnpm --filter @pickchick/mobile export
```

На первой вкладке — синтетическое меню сервера. Каталог 35 экранов открывается
через «Профиль → Все экраны дизайна». Пример корзины в галерее изолирован от серверной
корзины. Смена источника каталога очищает выбранный локальный состав, чтобы цены
примеров не смешивались с серверными. В сборке нет API/SSH-секретов.

Слои: `app/` — Router, `screens/` и `components/` — представление,
`store.tsx` — состояние, `api.ts` — проверенное чтение GET, `domain.ts` — деньги
и восстановление корзины; `test-client.ts` / `useTestOrders.ts` — TEST-сеанс,
серверный quote, идемпотентные команды и обновление истории/статусов.
`app.json` — идентификатор и конфигурация сборки.
Сгенерированные `ios/`, `android/`, `.expo/`, `dist/`, архивы и ключи исключены
из Git. Канонический код, контракты, дизайн и инструкции хранятся вместе в GitHub.
