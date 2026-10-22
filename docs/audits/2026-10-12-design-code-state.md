# Состояние кода дизайна на Mac - 12 октября 2026

Проверка по просьбе владельца: сохранены ли локально последние изменения киоска
и мобильного приложения и совпадают ли они с GitHub. Это аудит исходников,
истории, файлов сборок и тестов, а не повторная визуальная приёмка экранов.

## Вывод

Реализация последних обсуждённых изменений сохранена на Mac и в рабочих ветках
GitHub. Единого актуального checkout со всеми этими изменениями пока нет.
Основная папка отстаёт от общей ветки, а киоск 14 и мобильные Luma-превью
остались в отдельных ветках. Временные HTML-страницы вариантов не найдены по
прежним путям; их нельзя считать локально сохранёнными исходниками.

## Проверенные версии

После `corepack pnpm project:check` и независимого `git ls-remote`:

| Что                                            | SHA                                        | Состояние                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Основная папка `~/Documents/ChatGPT/PickChick` | `3c399b484b93b211da599116c2f42cb1e0cb95db` | Ветка shared-development отстаёт на 67 коммитов; своих опережающих коммитов нет. Tracked-файлы чистые, есть untracked `.claude/`.        |
| GitHub `codex/shared-development`              | `3e35293d115fb1ddd2d2875334653942687a9cd8` | Содержит киоск 13 и плавающее мобильное меню; номера сборок kiosk 13, mobile 17.                                                         |
| `codex/kiosk-design-demo`                      | `114d55552e8e68656498f5042d6f7f55e283f564` | Локальный HEAD совпадает с GitHub; чистая рабочая копия; kiosk 14 ещё не в shared.                                                       |
| `codex/mobile-luma-patterns`                   | `fe2688b19e720d92e9df74cd53229304afacb66c` | Локальный HEAD совпадает с GitHub; чистая рабочая копия; изменения превью ещё не в shared.                                               |
| `codex/mobile-luma-tabbar`                     | `8891b329afed06b385675a0d7fce2f24580afa81` | Локальный HEAD совпадает с GitHub; плавающее меню уже включено в shared.                                                                 |
| `codex/mobile-testflight18`                    | `ee0249f24e2c3cad84d92d0e04c457ba983ed6ce` | Локальный HEAD совпадает с GitHub; исходник бинарника `fb4dc2cd03ec921a3aa169b52fc4a3d67490bdc1`; номер 18 и отчёт не включены в shared. |

Основная папка по `app.json` всё ещё содержит kiosk 11 и mobile 16. Сборка
из неё не воспроизведёт последние изменения этого чата.

## Где продолжать работу

Рабочие копии находятся в `~/Library/Caches/PickChick/worktrees/`:

- `kiosk-design-demo`: актуальный код киоска 14.
- `mobile-testflight18`: выпущенный мобильный исходник с одобренным нижним меню.
- `mobile-luma-patterns`: отдельное превью шторок, тостов, статуса заказа и свайпа.
- `mobile-luma-tabbar`: исходник одобренной нижней панели.

В киоске 14 проверены `components/ctaLanguage.ts`, `components/WelcomeContent.tsx`,
`guestError.ts`, `demo.ts` и `useKioskController.ts`:

- Надпись начинается с КЗ, затем РУ, EN; интервал 2400 мс, перелист 280 мс.
- Язык заказа определяется переключателем. Ручной выбор фиксирует надпись;
  Reduce Motion и фон останавливают смену. Алекс не добавлен.
- `NOT_ACCEPTING` скрыт во всех языках. Другие ошибки, включая отсутствие
  связи с кухней, не объявлены удалёнными.
- Демо включается удержанием логотипа 5 секунд; путь до QR и номера работает
  через транспорт в памяти. Реальный платёжный контроль сохранён.

В мобильном Luma-превью есть `ConfirmSheet.tsx`, `Toast.tsx`,
`OrderStatusLine.tsx`, `SlideToConfirm.tsx` и `order-cancellation.ts`.
Запрет отмены после `simulated_approved` проверяется в UI и
`packages/test-order-flow/src/index.ts`. Это проверка тестового контура;
она не доказывает выпуск нового ограничения в коммерческом backend.
Luma-превью намеренно не входит в мобильную сборку 18 по решению владельца
«только одобренное».

## Сборки и устройства

- Подписанная копия kiosk 14 существует:
  `~/Library/Caches/PickChick/worktrees/kiosk-design-demo/.local/kiosk-build14/build14-114d5555/PickChickKiosk.app`.
  `Info.plist`: build 14, `kz.pickchick.kiosk`; `codesign --verify --deep --strict`
  прошёл. Копия в `kiosk-build14-dd/Build/Products/Release-iphoneos/` также прошла.
- Подключённый iPad Air 13 M3 опрошен через `devicectl`: установлен **0.1.0 (13)**.
  Следовательно, наличие готового 14 на Mac ещё не означает его установку.
- `releases/mobile-storefront-20261011-18-fb4dc2cd/release.json` подтверждает
  build 18, storefront, `dirty=false`, archive/export complete и delivery submitted.
  Доступность в группе TestFlight и установка на iPhone заново не проверялись.

## Макеты и доказательства

В Git и локально сохранены первичные материалы:
`design/reference-source/mobile-v2.html.txt`, `kiosk.html.txt`, эталоны остальных
интерфейсов, `design/prototype`, встроенные изображения и Storybook-компоненты.
В `mobile-luma-patterns/.local/luma-patterns` осталось 39 PNG до/после.
Собранная библиотека Storybook есть в `.local/ipad-design/storybook` рабочих
копий `kiosk-design-demo` и `mobile-testflight18`.

Не найдены прежние HTML-файлы в каталоге
`/private/tmp/claude-501/-Users-xaknazar-Documents-ChatGPT-PickChick/2f1d578e-92d2-4fe5-95d9-dedb79fb9f87/scratchpad/`:
`order-button`, `lang-switch`, `kiosk-attract-button`, `kiosk-attract-lang`,
`kiosk-alex-lang`, `kiosk-gallery`. Дополнительный поиск в проектных кешах,
`.local` и Codex visualizations не нашёл эти страницы по названиям.
Причина отсутствия не установлена; не утверждаем, что страницы удалены из облака.

Ссылки публикаций сохранены в истории чата, их текущая доступность не проверялась:

- [Кнопка заставки](https://claude.ai/artifact/BfXoxNR9nKNRmpVuDnnNdQ).
- [Язык на заставке](https://claude.ai/artifact/YM9xoaPqQQjCht3jYfMp69).
- [Галерея экранов](https://claude.ai/artifact/8cYEYuX6Yeb4ridjiCWuee).
- [Варианты с Алексом, впоследствии отклонены](https://claude.ai/artifact/L3VM4wsWWaNSFJ2AWZu7jx).
- [Кнопка приложения](https://claude.ai/artifact/VXgJEVYQt1a9hkcMhfbJS8).
- [Переключатели языка](https://claude.ai/artifact/J5VEvog1GyThQ4rDfsPMvR).

## Проверки 12 октября

- Свежие refs, журнал областей, открытые PR; четыре рабочие копии выше чистые
  и совпадают с опубликованными ветками.
- Киоск `114d5555`: повторно `node --test tests/kiosk/*.test.mjs`, **165/165**.
- Luma `fe2688b1`: повторно `order-cancellation`, `luma-patterns`, `tab-bar`,
  **13/13**. Это целевые проверки, не весь набор mobile.
- GitHub API подтверждает успешные [Foundation CI 38149677298](https://github.com/xaaknazar/pickchick/actions/runs/38149677298)
  и [Kiosk UI library 38149677297](https://github.com/xaaknazar/pickchick/actions/runs/38149677297)
  для `114d5555`.
- Успешны также [Luma CI 38127425164](https://github.com/xaaknazar/pickchick/actions/runs/38127425164)
  для `fe2688b1` и [mobile 18 CI 38127621186](https://github.com/xaaknazar/pickchick/actions/runs/38127621186)
  для `fb4dc2cd`.
- Новые native/browser прогоны, серверная установка и реальные оплаты не
  выполнялись в рамках аудита.

## Продолжение

1. Обновить основную папку штатной синхронизацией с сохранением `.claude/`.
   Это само по себе ещё не включит kiosk 14 и мобильные превью.
2. Отдельно интегрировать одобренные kiosk 14 и mobile 18 в актуальный shared,
   сверить изменения второго Mac и проверки итогового коммита. Не включать
   неутверждённые Luma-паттерны автоматически вместе с запретом отмены.
3. Завершить уже согласованную установку kiosk 14 и отдельно зафиксировать
   физическую приёмку анимации и демо.
4. Восстановить нужные HTML-превью из облачных публикаций либо собрать заново;
   сохранить их в постоянном каталоге проекта вместе с источниками.
5. Перенести эти факты в общие status/roadmap после согласования с владельцем
   области. На момент аудита `docs/project-status.md`, `docs/collaboration/handoff.md`
   и `docs/roadmap/project.json` заняты задачей `cabinet-entry` другого Mac;
   этот отчёт их не меняет. Онлайн-пульт данным аудитом не обновлён.

Этот этап публикует только отчёт. Код приложений, общая ветка, основная папка,
установленные приложения и сервер этим аудитом не меняются.
