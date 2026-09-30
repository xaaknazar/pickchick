# Kaspi: подтверждённая установка на VPS, 29 сентября 2026

## Установлено и проверено

- Source SHA: `5dd66c58b6f29ccdfe3cbde6359d278f55bd4961`, upstream `28c9167`.
- [Foundation CI 36604951618](https://github.com/xaaknazar/pickchick/actions/runs/36604951618): все 6 jobs successful.
- Локально: 21 unit/HTTP тест, HTTP overlay проверки с подставным банком,
  сборка Docker, запуск non-root/read-only, health, отсутствие UI/refunds,
  запрет Origin, отсутствие секретов в контексте.
- VPS: контейнер `pickchick-kaspi-bridge`, Node 24.16.0 по digest, процесс
  слушает только 127.0.0.1:3931 **внутри контейнера**. Published ports отсутствуют.
- Сохранён комплект успешного входа: device, keypair, encryption key, session.
  Банк подтвердил `active=true`; после рестарта контейнера повторно `active=true`.
  Новый SMS/пароль не запрашивался. Перезагрузка всего VPS не проверялась.
- Существующие контейнеры сохранили идентификаторы; API, БД и gateway не менялись.
  Установка заняла штатный `.market-release.lock`; после успеха owner lock освобождён.

Приватный immutable release:
`/opt/pickchick-staging/kaspi-bridge/releases/5dd66c58b6f29ccdfe3cbde6359d278f55bd4961`.
Секреты: `/opt/pickchick-staging/secrets/kaspi-bridge` (0700), четыре файла
0600 с владельцем 1000:1000, read-only mounts. В image/репозитории секретов нет.
`deployment-result.json` в release содержит обезличенный результат проверки.
Локальная копия proof и журнала:
`.local/market-release/5dd66c58b6f29ccdfe3cbde6359d278f55bd4961/`.

Процесс восстанавливается Docker `restart: unless-stopped`. Это не гарантирует
бессрочную банковскую сессию: её отзыв требует повторного входа владельцем.
Для проверки использовать `session-check.mjs` из README; не читать env в терминал.

## Что пока не включено

Worker не запущен. Счета, списания, возвраты и фискальные документы не создавались.
Владелец согласовал первый реальный счёт 100 ₸ на свой номер; намерение сохранено
приватно, оно не является записью оплаты или созданным банковским счётом.
Webkassa отложена по прямому решению владельца.

Read-only аудит VPS: API `4ee0b801a8ceefa5aad339bdeecc1d4974f40538`, schema020,
единственная точка ТЦ Abay Plaza с `ordering_enabled=false`. Commercial provider
accounts=0, orders=0, identity customers=0, catalog publications=0, transport
bindings=0. Это существующий тестовый контур. Включение одного флага Kaspi
не превращает его в коммерческий checkout.

Следующий выпуск должен отдельно подготовить миграции, customer identity,
серверный каталог/цену, provider account продавца, admission и связь с заказом.
Пилот без Webkassa должен иметь явный отложенный fiscal status; текущий допуск
на кухню после чека нельзя удовлетворять искусственным `issued`.
Первый счёт 100 ₸ отправлять через durable ledger после этой подготовки,
а не напрямую через endpoint моста. Оплата подтверждается только ответом банка.

Upstream npm audit: 2 moderate (body-parser/qs), 0 high/critical. JSON limit
фиксирован 8kb; мост недоступен публичным клиентам. Обновление зависимостей
требует отдельного проверенного патча, закреплённый lockfile не менялся.
