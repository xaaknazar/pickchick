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

После сборки `npm run verify:win` сверяет чистый HEAD, все входные исходники,
main/preload/journal и семь renderer assets в ASAR, allowlist содержимого,
native-storage marker, PE32+ AMD64 payload и security fuses. Результат с SHA256
EXE сохраняется в `release/verification.json`. Это структурная проверка пакета,
она не обозначает проверенную подпись или запуск на Windows.

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
   Допустимы только `edgePort` (по умолчанию 3101), `branchLabel`, `categories`
   и `terminalId` (постоянный UUID терминала, нужен для PIN-входа).
   Узел всегда `127.0.0.1`: произвольный URL или адрес VPS не допускаются.
4. Оператор задаёт личные четырёхзначные PIN через `scripts/staff-pin-setup.mjs`
   со скрытым двойным вводом на моноблоке. Перезапустить приложение и войти по PIN.
   В `config.json` не хранить PIN, токены и пароли. Смену открывает управляющий.

Журнал находится в `%APPDATA%\PickChickPOS\journal-v1` и привязан к
точке, сотруднику и терминалу. Main разрешает доступ только после настоящего
успешного `/session` локального edge, в пределах его роли и срока действия.
Установка и portable используют один профиль и одновременно не запускаются.
Перед отправкой изменяющей команды существующий `PosController.save` получает
синхронное подтверждение записи: временный файл в том же каталоге, `fsync`, затем
замена предыдущего файла через `rename`. Ключ становится SHA256-именем файла;
произвольный путь и неизвестные поля JSON не принимаются, лимит - 100 KB.
Ошибка записи или повреждённый журнал блокируют отправку команды. Подмена на
пустой журнал или fallback в `localStorage` в установленном клиенте запрещены.
Обновление и удаление приложения не удаляют профиль. Не очищать его вручную,
особенно если результат запроса ещё не подтверждён.

Сессия сотрудника остаётся в `sessionStorage`: после полного перезапуска
нужно повторно войти по личному PIN. Сам PIN в клиенте не сохраняется.
Это не Windows Credential Vault; бессрочное хранение ключа не включено. Журнал
не является единственной копией заказа - подтверждённый заказ хранится в
локальной PostgreSQL. Защита от потери питания/диска требует отдельного испытания.
Это первый выпуск desktop: миграция журналов экспериментальных ранних сборок
из `localStorage` не включена, старые EXE не распространялись.

На Windows Node/libuv использует `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` для
замены в том же каталоге и `FlushFileBuffers` для `fsync` файла. Предыдущий файл
не удаляется заранее; sharing violation/ошибка замены считается отказом записи.
Каталог через Node на Windows не `fsync`-ится; устойчивость к аппаратной потере
питания и поведение антивируса/диска проверяются отдельно на Windows/NTFS.
Режимы 700/600 применимы к POSIX; на Windows приватность обеспечивается ACL
профиля Windows, приложение не является Windows Credential Vault.

## Границы оболочки

- `sandbox` и `contextIsolation` включены, Node в renderer выключен.
- Изолированный preload экспортирует только `pickchickPosJournal.getItem`,
  `setItem`, `endSession`. Последний отзывает доступ без удаления данных.
  Main проверяет sender, главный frame и точный origin; общего IPC, доступа
  к файлам, shell, URL и credential-хранилищу у renderer нет.
  Внешняя навигация, новые окна, webview, загрузки и разрешения запрещены.
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

Перед тестом с прямым `executablePath` выполнить `npm run runtime:install`:
Electron 44 загружает runtime лениво через CLI, а тест запускает binary напрямую.
Первый download требует сети или готового локального cache. Сам EXE уже содержит
runtime. [Официальный порядок загрузки](https://www.electronjs.org/docs/latest/tutorial/installation).
Node-проверки без GUI:
`node --test ../../tests/pos-desktop/protocol.test.mjs ../../tests/pos-desktop/journal.test.mjs`.
Для `browser.test.mjs` нужны собранные API/edge, отдельный локальный PostgreSQL
с временными схемами, приватный env и установленный Python Playwright;
`POS_TEST_PYTHON` указывает на его interpreter. Тест не использует VPS.

Основание настроек: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[secure standard schemes и storage](https://www.electronjs.org/docs/latest/api/protocol),
[Electron 44.2.0](https://releases.electronjs.org/release/v44.2.0),
[NSIS](https://www.electron.build/v26/docs/targets/nsis/),
[cross-platform build](https://www.electron.build/v26/docs/multi-platform-build/).
Синхронный IPC выбран как ограниченный барьер существующего Store перед POST;
он блокирует renderer на время небольшой записи, а не произвольной операции:
[Electron IPC](https://www.electronjs.org/docs/latest/api/ipc-renderer),
[Node fs](https://nodejs.org/docs/latest-v24.x/api/fs.html),
[libuv Windows fs](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c).
