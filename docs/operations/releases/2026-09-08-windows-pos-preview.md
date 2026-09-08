# Поставка PickChick POS 0.1.0 для Windows

8 сентября 2026 опубликован первый
[prerelease](https://github.com/xaaknazar/pickchick/releases/tag/pos-v0.1.0-preview.1).
Это установщик клиента для проверки, не разрешение заменить действующую iiko.
Изменения: [PR #44](https://github.com/xaaknazar/pickchick/pull/44), stacked поверх #43.

## Источник и артефакты

Чистый исходный commit сборки: `fbd83e1e2fa8d2923a6ad2980d5f2b628ca8a9a8`.
GitHub tag `pos-v0.1.0-preview.1` проверен на этот commit. Этот документ добавлен
после упаковки и не меняет уже проверенные EXE. Бинарные файлы хранятся в release
assets, не в Git history.

| Артефакт                             | Размер, bytes | SHA-256                                                            |
| ------------------------------------ | ------------: | ------------------------------------------------------------------ |
| PickChick-POS-Setup-0.1.0-x64.exe    |     120339288 | `37e37d87fb18c20ffa56683e7b0b3737c01736cf2617e7d59134b219b29cf6d3` |
| PickChick-POS-Portable-0.1.0-x64.exe |     120175155 | `d3d5ea243c37a4e320ecff5b8c578580bd3cdf563fc56cf0674f1f15e0b479b6` |

Также опубликованы `READ-ME-FIRST.txt`, `SHA256SUMS.txt`, `verification.json` и
`asset-manifest.json`. Размер и серверный SHA-256 каждого из шести GitHub assets
совпали с локальными файлами до публикации. Копии сохранены в пользовательскую
папку `Downloads/PickChick POS 0.1.0 Preview` и проверены по SHA-256.

`npm run dist:win` и `npm run verify:win` прошли на Mac. Проверены 21 входной hash,
семь renderer assets, main/protocol/journal/preload, точный ASAR allowlist,
внешний пример конфигурации, PE32+ AMD64 payload и security fuses. Bootstrap
NSIS имеет PE32; это не архитектура вложенного приложения. Certificate table
в EXE пуста: Authenticode-подписи нет. Побитовая повторяемость между ОС/временем
сборки не заявляется. В пакет не входят операторские настройки, сессии,
PostgreSQL, edge, worker, dev-зависимости и тестовые данные.

## Подтверждённые проверки

- 12 desktop tests: 8 протокола, 3 файлового журнала и настоящий Electron lifecycle.
  Потерянный ответ после committed create, SIGKILL, повторный вход с прежним
  scope и тем же key/body восстановили ровно один заказ в PostgreSQL.
  Обычный restart, отмена, отказ диска до POST, повреждённый журнал, scope/expiry,
  logout, sandbox и запрет внешней навигации также прошли.
- 13 POS sync tests с настоящими PostgreSQL/HTTP: недоступный WAN, durable queue,
  lost ACK, конкуренция worker, перезапуск, hash/quote/version/auth/branch guards.
  Redis не был единственным хранилищем финансовых или заказных данных.
- 7 существующих POS tests, включая browser1280/1920, реальные staff API,
  котировку, неизвестный результат, стоп-лист и версионные команды управляющего.
- API/edge build, desktop TypeScript, contracts, целевой ESLint, Prettier и
  проверка staged diff/credential patterns прошли. Просмотрен настоящий
  Electron screenshot с синтетическим неоплаченным заказом без обрезки кнопок.

При первом запуске QA из чистого npm install host runtime Electron ещё не был
скачан: тест с прямым executablePath остановился до открытия окна. Добавлена
явная команда `runtime:install`, после неё полный набор прошёл. Это особенность
developer QA; распространяемый EXE содержит свой Windows runtime.

Удалённый [Windows package job](https://github.com/xaaknazar/pickchick/actions/runs/34226040804)
завершился с failure до запуска шагов. Аналогично шесть jobs
[Foundation CI](https://github.com/xaaknazar/pickchick/actions/runs/34226040744)
имеют zero steps. API annotations недоступен с текущими правами; причина именно
этих запусков не подтверждена. Ранее проект фиксировал ограничение billing,
но оно не подменяет доказательство причины нового запуска.

## Что не принято и следующий этап

Владелец подтвердил Windows 10 на BX S6 и наличие локальных серверов.
По его последнему поручению настройка серверов отложена до сообщения с точки.
Их ОС/доступ, установленный edge, PostgreSQL, управляемые службы, protected LAN,
меню и staff provisioning в этом этапе не менялись. VPS и iiko не затронуты.
Временный QA PostgreSQL container и его том удалены после проверок; остальные
контейнеры и локальная мобильная Dev-сборка сохранены.

Сам клиент обслуживает только неоплаченные локальные заказы. Он не включает
приём денег, ККМ, смены, печать, комбо/модификаторы локального каталога или
допуск оплаченного POS-заказа на кухню. Sync code выключен по умолчанию и
не развёрнут: нужны согласованные migrations cloud015/016 и edge007/008,
private ingress, runtime grants и supervision.

На физической Windows не проверены установка/обновление/uninstall с сохранением
журнала, сенсорный экран, SmartScreen, перезагрузка, потеря питания и связка
касса-кухня-табло. Испытание Electron на Mac не заменяет эти пункты.
Следующий этап после сведений о серверах - подготовить план размещения служб
на существующем оборудовании, затем связать реальные оплату/чек/кухню и пройти
полную локальную смену с отключением и восстановлением WAN.
