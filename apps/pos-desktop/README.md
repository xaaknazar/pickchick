# PickChick POS для Windows

Устанавливаемая предпусковая касса с локальным интерфейсом из `apps/pos`.
Установщик содержит Electron и статические файлы интерфейса. Интернет и VPS
для открытия интерфейса не нужны.

**Edge и PostgreSQL в установщик не входят.** До настройки локального узла,
меню, терминала и сессии сотрудника касса не принимает заказы. Текущий POS
создаёт только неоплаченные заказы: банк, ККМ, кухня и облачная синхронизация
этой кассы ещё не подключены. Состояние остальных приложений сети этого не меняет.

## Сборка из monorepo

Из корня репозитория:

```sh
cd apps/pos-desktop
npm ci
npm run typecheck
npm run dist:win
```

Нужен Node.js 24.16+ ветки 24 и npm 11.13.0. Пакет изолирован от корневого
pnpm workspace; зависимости закреплены собственным `package-lock.json`.
Electron 44.2.0, electron-builder 26.16.1 и используемые NSIS/Wine/WinCodeSign
toolsets закреплены явно. Builder 26.16.1 опубликован в стабильной ветке `v26`;
это не prerelease v27. Установка зависимостей и первая упаковка требуют сети.

`scripts/build.mjs` проверяет TypeScript существующего POS и формирует семь
локальных assets с SHA-256 manifest, Git SHA, признаком dirty и хешами входных
исходников/конфигурации/lockfile. Упаковка EXE требует чистого закоммиченного
checkout; обычный dev build допускает правки и отмечает их в manifest.
Иконка и пример конфигурации генерируются в `build/` из отслеживаемых файлов,
поэтому чистому clone не требуются локальные заготовки. Это тот же исходный UI, без отдельной
копии бизнеслогики. В ASAR попадает только явный список файлов; dev-зависимости,
конфиги операторов и сессии сотрудников не упаковываются. Закреплённая цепочка
позволяет повторить сборку; побитовая идентичность NSIS между разными ОС и
моментами сборки не заявляется.

Результат в `release/`:

- `PickChick-POS-Setup-0.1.0-x64.exe` - установка для текущего Windows-пользователя.
- `PickChick-POS-Portable-0.1.0-x64.exe` - запуск без установки.

Оба файла содержат приложение x64. NSIS bootstrap может быть PE32 - это
архитектура распаковщика; вложенный `PickChickPOS.exe` должен быть PE32+ x64.
Подписи Authenticode сейчас нет. Проверка Windows Defender/SmartScreen,
установка, обновление и драйверы на физическом BX S6 остаются частью приёмки.
Сборка EXE на macOS не заменяет эту приёмку. Toolsets 1.x для cross-build
помечены beta в типах builder v26; они используются только упаковщиком,
не становятся сервисами на кассе. При запуске Wine на Apple Silicon нужна Rosetta.

## Настройка рабочего места

1. Настроить отдельный локальный edge с PostgreSQL по
   [инструкции POS](../../docs/operations/local-orders.md), терминал, меню и права.
2. Запустить PickChick POS. Профиль находится в `%APPDATA%\PickChickPOS`.
3. При нестандартном порте создать там `config.json` по `resources/config.example.json`
   в исходниках или `resources/config.example.json` установленного приложения.
   Допустимы только `edgePort` (по умолчанию 3101), `branchLabel`, `categories`.
   Узел всегда `127.0.0.1`: произвольный URL или адрес VPS не допускаются.
4. Перезапустить приложение и выбрать приватный JSON-файл сессии сотрудника,
   выданный оператором. В `config.json` не хранить токены и пароли.

Журнал находится в постоянном профиле и привязан к origin `pickchick-pos://app/`,
точке, сотруднику и терминалу. Установка и portable используют один профиль и
одновременно не запускаются. При штатном закрытии вызывается сброс web storage.
Обновление и удаление приложения не удаляют профиль. Не очищать его вручную,
особенно если результат запроса ещё не подтверждён.

Сессия сотрудника остаётся в существующем `sessionStorage`: после полного
перезапуска может потребоваться повторно выбрать её файл. Это не Windows
Credential Vault; бессрочное хранение ключа и PIN-вход не реализованы. Журнал
не является единственной копией заказа - подтверждённый заказ хранится в
локальной PostgreSQL. Защита от потери питания/диска требует отдельного испытания.

## Границы оболочки

- `sandbox` и `contextIsolation` включены, Node в renderer выключен.
- Preload и IPC API отсутствуют. Внешняя навигация, новые окна, webview,
  загрузки и разрешения устройств запрещены.
- Стандартная secure custom scheme сохраняет browser storage и Web Locks;
  CSP не обходится. Только packaged UI и allowlist существующего edge API.
- Main не повторяет POST, не меняет Idempotency-Key и не подтверждает оплату.
- Loopback proxy имеет лимит запроса 64 KB, ответа 4 MB и таймаут 10 секунд;
  redirect запрещён, произвольные upstream headers не передаются.
- В packaged binary выключены RunAsNode, NodeOptions, Node CLI inspect и
  расширенные привилегии `file:`; включены OnlyLoadAppFromAsar и ASAR integrity.
- Нет auto-updater, удалённого кода, облачного URL для кассы и очистки данных
  при uninstall (`deleteAppDataOnUninstall: false`).

Для автоматизированного теста unpackaged Electron можно задать абсолютный
`PICKCHICK_POS_TEST_USER_DATA` и положить тестовый `config.json` туда. В
установленном приложении эта переменная игнорируется. `npm start` открывает
локальный исходный клиент; `npm run pack:mac-test` создаёт вспомогательную
Mac-сборку для проверки упаковки, а не распространяемый продукт.

Основание настроек: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[secure standard schemes и storage](https://www.electronjs.org/docs/latest/api/protocol),
[Electron 44.2.0](https://releases.electronjs.org/release/v44.2.0),
[NSIS](https://www.electron.build/v26/docs/targets/nsis/),
[cross-platform build](https://www.electron.build/v26/docs/multi-platform-build/).
