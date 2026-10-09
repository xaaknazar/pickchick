# Киоск v3 motion: установка build 9 на iPad

Установка выполнена 9 октября 2026, 02:06 по Алматы (8 октября, 21:06 UTC).
На физическом iPad Air 13-inch (M3) установлена **0.1.0 (9)** поверх **0.1.0 (8)**.
Приложение не удалялось, регистрация и данные приложения не очищались.

## Источник и проверки до установки

- Ветка: `codex/kiosk-v3-motion`.
- Точный исходный коммит: `01ec5dbbdc33c7d9ffcf0a94f330ca4df735ae61`.
- [Foundation CI 37841253672](https://github.com/xaaknazar/pickchick/actions/runs/37841253672):
  **11/11 success**, включая итоговую задачу. Сборка началась только после
  завершения этого прогона, из чистого дерева того же SHA.
- [Kiosk UI library 37841294913](https://github.com/xaaknazar/pickchick/actions/runs/37841294913):
  Storybook, accessibility and iPad motion - **success**.
- Зависимости установлены через `corepack pnpm install --frozen-lockfile`,
  pnpm **11.19.0**. Зависимости workspace собраны из того же коммита.
- `EXPO_PUBLIC_KIOSK_COMMERCIAL=1` передан отдельно в Expo prebuild и в
  `xcodebuild` для Release JS-бандла. `pod install` завершился успешно.
- Нативная Release-сборка Xcode **26.6 (17F113)** завершилась `BUILD SUCCEEDED`.

## Подпись и результат установки

Проверены `codesign --verify --deep --strict`, версия `0.1.0`, build `9`,
`UIDeviceFamily=[2]`, непустой Hermes JS-бандл и профиль целевого iPad.
Профиль действителен до **2027-10-07T05:35:23Z**.

Bundle ID **`kz.pickchick.kiosk`**, Team **`DAJTP6MC3Q`**.
`application-identifier`, `keychain-access-groups` и
`com.apple.developer.team-identifier` побайтно совпали с сохранённой сборкой 8.

| Артефакт         | SHA-256                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `main.jsbundle`  | `18390d61849c7ad03e9cf17c1f77c5077da07d8481a179347a50656334fe472d` |
| Исполняемый файл | `985ac514f9baa2adfa6a72cc846c0466448c3839edf22ef9fae492cb0ebad0fa` |

`devicectl device install app` завершился успешно. Последующее
`devicectl device info apps --bundle-id kz.pickchick.kiosk` подтвердило
**0.1.0 (9)**. Запуск установленного приложения через `devicectl` также успешен.
Удаление приложения и повторная регистрация не выполнялись.

## Нативная проверка: ограничение

Дважды запускался только
`InstalledUITests.testObserveSavedOrderWithoutNewSubmit`. Из отдельного
операторского тестового проекта удалены все остальные тесты, включая тесты
создания заказа. Этот observer не нажимает кнопки, не повторяет оплату и
не очищает гостя.

Оба запуска **не дошли до выполнения теста**: UI runner завершился ошибкой
`Timed out while enabling automation mode` после ожидания 60 секунд.
При этом iPad был подключён и разблокирован (`passcodeRequired=false`).
Установка и запуск сборки подтверждены, но успешный `InstalledUITests`,
скриншот нового интерфейса и визуальная приёмка анимаций на устройстве
**пока не подтверждены**. После проверки приложение вновь запущено,
установленный build 9 повторно подтверждён через `devicectl`.

Новые заказы, платежи или диагностические QR оператором не создавались.
Старая неопределённая попытка QR не отменялась, её локальные данные и
банковский результат не подменялись. Установка motion-сборки не решает
[известный блокер неизвестной оплаты](kiosk-v3-launch.md).

**Ручное наблюдение владельца, 9 октября 2026:** после установки build 9
на iPad отображается **«Уточняем результат оплаты»**. Это подтверждение
владельца о видимом экране, а не результат `InstalledUITests`.
Экран неопределённой оплаты после обновления сохранился; банковский результат,
идентичность заказа и полная визуальная приёмка анимаций этим наблюдением
не проверены. Устройство по-прежнему ожидает разрешения платёжного блокера.

## Локальные доказательства и откат

В рабочей копии
`/Users/xaknazar/.codex/worktrees/kiosk-build9-release/PickChick`:

- `.local/kiosk-build9/ci-37841253672.json` и `ci-37841294913.json`;
- `.local/kiosk-build9/{prebuild,pods,workspace-build,build}.log`;
- `.local/kiosk-build9/build-command.json`, `build9-proof.json`, `candidate-proof.json`;
- `.local/kiosk-build9/install.json`, `installed-after.json`, `installed-final.json`;
- `.local/kiosk-build9/saved-order.xcresult` и `saved-order-retry.xcresult`;
- `.local/kiosk-build9/build9-01ec5dbb/PickChickKiosk.app` - подписанная сборка 9.

Подписанная предыдущая сборка сохранена без изменений:
`/Users/xaknazar/.codex/worktrees/kiosk-kaspi-qr/.local/kiosk-v3-launch/native-build8/build8-37dbc1a/PickChickKiosk.app`.
Для отката устанавливать этот `.app` через `devicectl device install app`
поверх, без удаления приложения и без сброса гостя/регистрации.

Следующий шаг: устранить сбой инициализации UI Automation и повторить только
observer; после разрешения неопределённой оплаты проверить остальные экраны
и анимации. Платёжная приёмка и серверная публикация единого меню учитываются
отдельно.
