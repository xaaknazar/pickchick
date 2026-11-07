# Google Play: Data safety (PickChick, kz.pickchick.app)

Ответы для формы Play Console > App content > Data safety. Выведены из кода ветки
`codex/mobile-android-1105` (файлы указаны в каждой строке); если код изменится, форму нужно
обновить вместе с ним. Аналитики, рекламы, crash-reporting SDK и рекламного идентификатора в
приложении нет: в `apps/mobile/package.json` таких зависимостей нет, `AD_ID` заблокирован в
`apps/mobile/app.json` (`android.blockedPermissions`), а `scripts/mobile/android_release.py inspect`
падает, если разрешение появится в собранном AAB.

## Общие вопросы

| Вопрос Play Console                                                   | Ответ                                        | Основание                                                                                                                                                                                                      |
| --------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does your app collect or share any of the required user data types?   | Yes                                          | номер телефона, профиль, заказы (ниже)                                                                                                                                                                         |
| Is all of the user data collected by your app encrypted in transit?   | Yes                                          | API только `https://` (`apps/mobile/src/build-config.ts`, `apiOrigin`), `usesCleartextTraffic` не включён (проверка `inspect`)                                                                                 |
| Do you provide a way for users to request that their data is deleted? | Yes                                          | в приложении: Профиль > «Удалить аккаунт» (`apps/mobile/src/screens/ProfileScreens.tsx`, `DELETE /v1/customers/me` в `apps/mobile/src/customer-session.ts`); веб: https://pickchick.kz/support/#delete-account |
| Account creation                                                      | Yes, по номеру телефона и коду               | `apps/mobile/src/screens/AuthScreens.tsx`                                                                                                                                                                      |
| Delete account URL                                                    | https://pickchick.kz/support/#delete-account | `infra/public-staging/support/render.py`, текст в `account-deletion-web.md`                                                                                                                                    |

## Какие данные собираются

«Collected» = данные уходят с телефона на наш сервер. Всё, что остаётся только на телефоне
(рекорды игр, язык, корзина, черновик оплаты в AsyncStorage), по правилам Google не считается
собранным.

| Категория Play > тип                        | Собирается                                                                                                                 | Обязательно                | Цели (Purposes)                       | Где в коде                                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Personal info > Phone number                | Да                                                                                                                         | Да (для входа и заказа)    | Account management, App functionality | `apps/mobile/src/screens/AuthScreens.tsx` (ввод), `apps/mobile/src/customer-session.ts` (`/v1/auth/otp/request`, `/v1/auth/otp/verify`) |
| Personal info > Name                        | Да: ник                                                                                                                    | Нет (может быть пустым)    | App functionality, Account management | `apps/mobile/src/screens/RegistrationScreen.tsx`, `apps/mobile/src/customer-session.ts` (`PATCH /v1/customers/me`, `nickname`)          |
| Personal info > Other info                  | Да: дата рождения, пол                                                                                                     | Нет                        | App functionality, Account management | `apps/mobile/src/screens/RegistrationScreen.tsx`, `apps/mobile/src/customer-session.ts` (`birth_date`, `gender`)                        |
| Financial info > Purchase history           | Да: заказы, суммы, статусы                                                                                                 | Да, если клиент заказывает | App functionality                     | `apps/mobile/src/commerce-checkout.ts`, `apps/mobile/src/screens/KaspiCheckoutScreen.tsx` (`/v1/customer-checkout/orders`)              |
| App activity > Other user-generated content | Да: комментарий к заказу, оценка заказа                                                                                    | Нет                        | App functionality                     | `apps/mobile/src/commerce-checkout.ts` (`orderComment`), `apps/mobile/src/order-feedback.ts`                                            |
| Device or other IDs                         | Да, только если клиент включил уведомления о заказах и сервер их поддерживает: push-токен FCM и случайный `installationId` | Нет                        | App functionality                     | `apps/mobile/src/notifications/provider.tsx` (`/v1/customers/me/push-devices`)                                                          |

Не собираются (ответ «No» / не отмечать): Location (адрес ресторана статичный, 2ГИС открывается
внешним приложением, `apps/mobile/src/components/Restaurants.tsx`), Financial info > Payment info
(оплата и данные карты только в приложении Kaspi.kz, счёт выставляет сервер), Email, User IDs
кроме номера, Messages, Photos and videos, Audio, Files and docs, Calendar, Contacts, Health and
fitness, Web browsing, App interactions, In-app search history, Installed apps, Crash logs,
Diagnostics, Other app performance data. Разрешения микрофона, камеры, геолокации, хранилища и
`AD_ID` в релизе удалены (`apps/mobile/app.json`, список разрешений проверяет `inspect`).

## Передача третьим лицам (Data sharing)

Рекомендованный ответ: **данные не передаются** («No» для каждого типа), потому что обе передачи
попадают в исключения Google:

- **Kaspi.kz** получает номер телефона и сумму заказа, чтобы выставить счёт. Это действие
  клиента (он сам нажимает «Оплатить» и подтверждает счёт в Kaspi.kz) и обработка платёжным
  сервисом по нашему поручению: исключения «user-initiated action» и «service provider».
- **Telegram** доставляет код входа на номер клиента: сервис доставки по нашему поручению
  (исключение «service provider»). Резерв WhatsApp выключен (шлюз `scripts/mobile/check_domain_links.py`
  падает, если сервер его включит).

Консервативный вариант, если владелец предпочитает раскрыть всё: отметить «Phone number - Shared -
App functionality» и «Purchase history - Shared - App functionality» с пояснением «Kaspi.kz для
выставления счёта; Telegram для доставки кода». Решает владелец; в карточке это не запрещено.

## Хранение на телефоне

- Токены сессии - `expo-secure-store` (ключи Android Keystore), корзина, язык, рекорды игр и
  сохранённый черновик оплаты - AsyncStorage.
- Резервная копия и перенос на новое устройство отключены: `android.allowBackup: false` и
  `pickchick_data_extraction_rules` исключают все разделы из облачной копии и из переноса
  (`apps/mobile/plugins/android-release.js`). На новом телефоне клиент входит заново.

## Что делает удаление аккаунта

Сервер удаляет профиль и доступ на всех устройствах (`DELETE /v1/customers/me`; приложение
считает удаление выполненным только при ответе `ok: true`): номер телефона, профиль, сессии и
согласия стираются (`packages/customer-identity/src/index.ts`, `deleteMe`). По решению владельца 07.11.2026 заказы
и платежи сохраняются без телефона и профиля для учёта, отчётов и сверки оплат;
срок хранения не ограничен. Удаление аккаунта не возвращает оплату.

Ответы для раздела удаления Data safety:

- Пользователь может запросить удаление телефона и профиля: да.
- URL запроса: https://pickchick.kz/support/#delete-account (публикация П6 отдельно).
- Сохраняемые данные: заказы и платежи без телефона и профиля, для учёта,
  отчётов и сверки оплат, без ограничения срока хранения.
- Контакт: действующий телефон ресторана на странице поддержки.

Проверка Console 07.11: в сохранённом черновике шага 2 уже указан этот URL
удаления. Google требует разместить сведения об удаляемых/сохраняемых данных
и сроке на странице по ссылке. Адрес и другие ответы в Console не менялись;
анкета целиком не завершалась и не отправлялась.
Остальные ответы анкеты этой правкой не изменяются. Поправка политики
[подготовлена отдельно](legal-retention-proposal-1107.md) и не опубликована.
