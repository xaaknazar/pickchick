# Киоск: установка build 10 на iPad (единое меню: фото и long-poll)

Установка выполнена 9 октября 2026 около 11:45 по Алматы (06:45 UTC).
На физическом iPad Air 13-inch (M3) установлена **0.1.0 (10)** поверх **0.1.0 (9)**.
Приложение не удалялось, регистрация устройства и данные приложения не очищались.

Это первая сборка iPad из общего среза с клиентом единого меню: удалённые фото
каталога (`apps/kiosk/src/photo-source.ts`, `PhotoImage.tsx`) и long-poll
доступности на стартовом экране (`apps/kiosk/src/polling.ts`,
`commercial-controller.ts`). Единственное изменение исходников относительно
общего среза `90eb6b6b` - номер сборки 9 -> 10 в `apps/kiosk/app.json`.

## Источник и проверки до установки

- Ветка: `codex/kiosk-build10`, задача `kiosk-build10` (области `apps/kiosk`,
  `@apple/devices/kiosk`, `@release/ios`, этот протокол).
- Точный исходный коммит: `35f3a883627b1f1aecfcf5c8424b250b7a46e89a`.
- [Foundation CI 37891358716](https://github.com/xaaknazar/pickchick/actions/runs/37891358716):
  **11/11 success**. Список заданий снят со страницы run (API GitHub в момент
  сборки отвечал лимитом 403); копия: `.local/kiosk-build10/ci-37891358716-jobs-webfetch.json`.
- [Kiosk UI library 37891358593](https://github.com/xaaknazar/pickchick/actions/runs/37891358593):
  **success**.
- Локально в том же дереве: `pnpm check` (build, typecheck, lint, format, test,
  contracts, design) завершился успешно.
- Зависимости: `corepack pnpm install --frozen-lockfile`, pnpm 11.19.0; workspace
  собран `pnpm --filter '@pickchick/kiosk^...' build`.
- `EXPO_PUBLIC_KIOSK_COMMERCIAL=1` передан в `expo prebuild` и в `xcodebuild`
  (Release). `pod install` завершился успешно.
- Нативная Release-сборка Xcode завершилась `BUILD SUCCEEDED` с третьей попытки:
  первые две упали на `[CP] Embed Pods Frameworks` с ошибкой
  «resource fork, Finder information, or similar detritus not allowed». Причина -
  рабочая копия лежала в `~/Documents`, синхронизируемой iCloud Drive: на
  предсобранные фреймворки CocoaPods добавлялись атрибуты `com.apple.FinderInfo`
  и `com.apple.fileprovider.fpfs#P`, и `xattr -cr` не помогал надолго. Рабочая
  копия перенесена `git worktree move` в
  `/Users/xaknazar/Library/Caches/PickChick/worktrees/claude-kiosk-build10`,
  `pod install` повторён, сборка прошла. Исходники не менялись.

## Подпись и результат установки

Проверены `codesign --verify --deep --strict`, версия `0.1.0`, build `10`,
`UIDeviceFamily=[2]`, Hermes JS-бандл 3 110 746 байт, профиль целевого iPad.
Профиль действителен до **2027-10-07T05:35:23Z**.

Bundle ID **`kz.pickchick.kiosk`**, Team **`DAJTP6MC3Q`**,
`application-identifier` `DAJTP6MC3Q.kz.pickchick.kiosk`; `keychain-access-groups`
отсутствует, как и в сохранённой сборке 9 - identity совпадает.

| Артефакт         | SHA-256                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `main.jsbundle`  | `d64336cf80927e586a030b4fea6903c81a4f289b3df1f1cb1656a1d6e0a3149a` |
| Исполняемый файл | `a8dad1e85543b9298ce1985d3c75dfc9c6ac7ffdcba28c6a71eeded93c67a9ae` |

`devicectl device info apps` до установки: `0.1.0 (9)`.
`devicectl device install app` завершился успешно (databaseSequenceNumber 1580).
После установки `devicectl device info apps` подтвердил **`0.1.0 (10)`**.
Удаление приложения и повторная регистрация не выполнялись.

## Что сборка даёт и чего не даёт

- Стоп-лист с кассы и из бэк-офиса приходит на iPad через long-poll доступности
  уже на стартовом экране (раньше - только при входе в меню или раз в 60 с).
  Для стопов, поставленных на кассе, нужен транспорт протокола 4 на кассе и
  фаза `remote-stops` выпуска единого меню.
- Загруженные в бэк-офисе фото появятся на iPad только после включения
  `CATALOG_MEDIA_UPLOAD_ENABLED` (фаза `media-upload`). До этого показываются
  встроенные фото, как раньше.
- Kaspi QR: сборка не меняет платёжный код. Прежняя неопределённая попытка
  оплаты и «QR-код не распознан» этим протоколом не разрешаются; см.
  [kiosk-v3-launch.md](kiosk-v3-launch.md) и
  [kiosk-kaspi-qr-upstream-audit-2026-10-08.md](kiosk-kaspi-qr-upstream-audit-2026-10-08.md).
- Новые заказы, платежи и диагностические QR при установке не создавались.
- Нативные `InstalledUITests` в этой установке не запускались: на build 9 они
  дважды не дошли до проверок из-за `Timed out while enabling automation mode`,
  причина ещё не устранена. Визуальная приёмка - ручное наблюдение владельца.

## Локальные доказательства и откат

В рабочей копии `/Users/xaknazar/Library/Caches/PickChick/worktrees/claude-kiosk-build10`:

- `.local/kiosk-build10/ci-runs-watcher.json`, `ci-37891358716-jobs-webfetch.json`;
- `.local/kiosk-build10/{workspace-build,prebuild,pods,pods-after-move,build}.log`,
  `build-attempt1-failed.log`;
- `.local/kiosk-build10/build-command.json`, `build10-proof.json`;
- `.local/kiosk-build10/installed-before.json`, `install.json`, `installed-after.json`,
  `launch.json`;
- `.local/kiosk-build10/build10-35f3a883/PickChickKiosk.app` - подписанная сборка 10.

Подписанная сборка 9 сохранена без изменений:
`/Users/xaknazar/.codex/worktrees/kiosk-build9-release/PickChick/.local/kiosk-build9/build9-01ec5dbb/PickChickKiosk.app`.
Для отката устанавливать её через `devicectl device install app` поверх, без
удаления приложения и без сброса гостя/регистрации.
