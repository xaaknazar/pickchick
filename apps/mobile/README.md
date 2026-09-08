# PickChick Mobile

Нативный Expo-клиент iOS/Android по [дизайну v0.2](../../docs/design/README.md).
Для просмотра изменений на собственном iPhone без каждой новой загрузки в
TestFlight используется [PickChick Dev и Fast Refresh](../../docs/operations/mobile-live-review.md).
Первая версия предназначена для внутреннего тестирования: меню читается с VPS,
корзина сохраняется на устройстве, все 35 мобильных страниц доступны в галерее.
При действующем `features.test_order_flow` клиент создаёт синтетические заказы
в PostgreSQL и читает их статусы после действий двух тестовых кухонных станций.
Тестовая оплата обозначена отдельно и не обращается к банку. Локальный вход по
номеру использует код `123456`, без отправки SMS и проверки владения номером.
Настоящие OTP, платежи, фискальные чеки и Чики пока недоступны.

Каталог v0.3 содержит 24 блюда исходного мокапа: описания, порции, КБЖУ и группы
модификаторов. Сервер проверяет выбранные варианты и сохраняет их в снимке
заказа для кухни. [Состав и ограничения](../../docs/design/mobile-complete-catalog.md).

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
корзины. Разные источники корзины изолированы; единовременное обновление v0.2 →
v0.3 сохраняет известные блюда/количество и применяет свежие цены с включёнными
опциями. Уже созданные заказы сохраняют прежние снимки. В сборке нет API/SSH-секретов.

Слои: `app/` — Router, `screens/` и `components/` — представление,
`store.tsx` — состояние, `api.ts` — проверенное чтение GET, `domain.ts` — деньги
и восстановление корзины; `test-client.ts` / `useTestOrders.ts` — TEST-сеанс,
серверный quote, идемпотентные команды и обновление истории/статусов.
`app.json` — идентификатор и конфигурация сборки.
Сгенерированные `ios/`, `android/`, `.expo/`, `dist/`, архивы и ключи исключены
из Git. Канонический код, контракты, дизайн и инструкции хранятся вместе в GitHub.
