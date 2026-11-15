# Видео на главном экране приложения из бэк-офиса

Запрос владельца 15.11.2026: видео над меню приложения (заставка) должно меняться из
бэк-офиса, без выпуска приложения. До этого видео было встроено в сборку
(`design/prototype/assets/mockup/hero.mp4`, 9,7 МБ).

## Как работает

- Бэк-офис, «Промо и баннеры», панель «Видео на главном экране приложения» (видна только при
  `capabilities.app_splash`). Управляющий выбирает MP4 до 25 МБ; браузер считает SHA-256 и
  отправляет файл частями по 256 КиБ (портал pickchick.kz принимает не больше 300 КБ за запрос).
  После всех частей сервер собирает видео, сверяет хеш и сигнатуру MP4 (`ftyp`).
- «Показывать» выбирает видео для всей организации, «Вернуть встроенное видео» возвращает
  встроенное. История выбора - `app_splash_settings` (только добавление, с причиной).
- `GET /v1/content/branches/:id` отдаёт `splash: {video, sha256, bytes}` или `null`.
- Приложение (версии после сборки 37) играет `API_URL + video` с кешированием на устройстве;
  пока видео не скачалось, без сети или при ошибке - встроенное видео.
- `GET /v1/media/app/<sha256>.mp4` - публичная выдача с HTTP Range (iOS иначе не играет MP4
  по сети), кеш на год, ETag = хеш.

## Компоненты

| Где                                            | Что                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `db/cloud/migrations/078_cloud_app_splash.sql` | `app_splash_videos`, `app_splash_uploads`, `app_splash_upload_parts`, `app_splash_settings` |
| `infra/staging/app-splash-grants.mjs`          | права API-роли на 078 при `BACKOFFICE_ENABLED` и `BACKOFFICE_APP_SPLASH_ENABLED`            |
| `packages/backoffice-core/src/splash.ts`       | загрузка частями, сборка, выбор, выдача с Range                                             |
| `services/api/src/app-splash-controller.ts`    | маршруты бэк-офиса и `/v1/media/app/*`                                                      |
| `apps/backoffice/server.mjs`                   | портал пропускает части (octet-stream, до 256 КиБ) и JSON-маршруты                          |
| `apps/backoffice/src/operations.ts`            | панель в «Промо и баннерах»                                                                 |
| `apps/mobile/src/components/Brand.tsx`         | видео из `splash` с откатом на встроенное                                                   |

## Установка (исполнитель: Codex, после запуска 19.11)

1. Миграция cloud `078_cloud_app_splash.sql` отдельным шагом (только новые таблицы).
2. Права: `appSplashGrants(<api role>, {backoffice: true, splash: false})` сразу после
   миграции (только REVOKE), затем с `splash: true` вместе с флагом.
3. Выпуск API и веба бэк-офиса с этим коммитом, затем `BACKOFFICE_APP_SPLASH_ENABLED=true`
   в сервисе api.
4. Шлюз `api.pickchick.kz` (`infra/public-staging/gateway.Caddyfile` и установленный файл):
   разрешить `GET/HEAD ^/v1/media/app/[a-f0-9]{64}\.mp4$` так же, как `@catalog_media`
   (без Authorization/Cookie, кеш на год только для 200/206/304, `no_store` исключение,
   заголовок `Range` проходит как есть), и добавить путь в список `@synthetic_surfaces`.
   Шлюз в этом коммите не менялся: он меняется установочными скриптами на сервере.
5. Проверка: загрузить ролик в бэк-офисе, «Показывать»,
   `curl -H 'Range: bytes=0-15' https://<api>/v1/media/app/<sha>.mp4` -> 206 и `ftyp`.

Откат: «Вернуть встроенное видео» в бэк-офисе или флаг `false`; таблицы остаются.

## Проверки

- `packages/backoffice-core/tests/splash.test.mjs`: части, повтор части, конфликт, сборка,
  неверный хеш, не MP4, права аналитика, выбор, content, Range (`0-1`, `-10`, `100-`, 416),
  флаг выключен, `app_splash_settings` только добавление.
- `tests/unit/app-splash-grants.test.mjs`, `tests/mobile/backoffice-content.test.mjs`.
- Ручной прогон через портал (`createBackofficeServer`) в Chromium: загрузка `hero.mp4`
  (9,7 МБ, 38 частей), «Показывать», content и `Range: bytes=0-15` -> 206 `video/mp4`.
