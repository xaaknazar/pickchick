# PickChick 0.2.0 (28) - storefront и тактильный отклик

## Подготовка 29 октября 2026

Единое поручение владельца: бандл c333144f от c36287e7. Shared 6660ce98
(включает TestFlight 27, PR289) влит обычным merge без конфликтов.
Только согласованные пересечения переданы из mobile-launch-1028,
mobile-appstore-1022 и kiosk-apple-demo. Прочие резервы сохранены.

Поведение: [очистка](mobile-redesign-2026-10-27/fix-store.md) и
[вибрация](mobile-redesign-2026-10-27/fix-haptics.md).
Версия 0.2.0, build 28, storefront, прежние backend и подпись.
EXPO_PUBLIC_UPCOMING_PAYMENTS не задаётся; expo-haptics требует новых prebuild/pods.

## Проверки

На выпускающем Mac 557 Node + 59 Python PASS. Установка frozen-lockfile PASS.
Workspace build/typecheck, ESLint, Prettier и переводы PASS.
Полная Foundation CI, архив, TestFlight и физическая приёмка пока не подтверждены.
Первый workspace typecheck потребовал сборки зависимостей; повтор после build.

CI run40873334637: account suite превысила лимит 25 минут после добавления
двух обходов магазина. Проверки перенесены в foundation_mobile (до переноса
254 секунды), покрытие сохранено. Попытка создать шестую foundation suite
выявила жёстко закреплённый набор jobs в выпускных guards других приложений;
он сохранён без изменения. Новые сценарии - отдельный шаг существующего
обязательного mobile job. Новый полный прогон обязателен.

## Прод: только чтение

- GET availability: enabled=true, orderingOpen=true, часы 10:00-00:00 Asia/Almaty.
  Это 05:00-19:00 UTC; 28/29 октября 22:00-12:00 PDT. После 1 ноября 21:00-11:00 PST.
- GET notifications/config и customer-checkout/combo-rewards вернули HTTP404,
  поэтому ожидаемые JSON и enabled:false не подтверждены. Настройки не менялись.
- API c3a0fbeea69e3c94b4a0994f5cdee74ba98c77da healthy.
  CUSTOMER_REVIEW_ACCOUNT_ENABLED=true, номер и digest настроены (не публикуются).
- Штатный app-review-access.py source23860557, без --apply:
  validated=true, applied=false, customer_collision=true. Это существующий
  настроенный review-профиль; preflight не выполняет вход и не доказывает UI-вход.
- В установленном packages/commerce-core/dist/customer-checkout.js подтверждено
  fiscalPolicy: deferred_pilot для мобильного заказа.

## App Store: только чтение

Заявка 99775be3-3644-4d17-8e4f-ab4dfe3e53ca: Waiting for Review.
Версия 1.0 со сборкой 23 ожидает проверки; выпуск ручной.
Username содержит код страны +7, тогда как новый черновик предполагает 10 цифр.
Поля контакта и пароля заполнены, значения не публикуются.
Сохранённые заметки описывают прежний путь Sign in; они не обновлялись.
Проверка конкретной заявки, скриншотов и остальных материалов продолжается.

## Ограничения

Не выполнять App Review submission, замену сборки23, ответы Apple, VPS/кассу/iPad,
реальные оплаты и публикацию онлайн-пульта. Для них нужен отдельный запрос владельца.
Подключённый iPhone обнаружен; ощущения вибрации не подтверждены.
