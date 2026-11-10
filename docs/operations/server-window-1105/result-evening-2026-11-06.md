# Вечернее окно С1/С3 - 06.11.2026

## Статус

С1 и С3 PASS в разрешённом вечернем окне 06.11 до 23:30 Алматы.
После отдельного разрешения повторён только С3. Исправление 818524ec дождалось
полной Foundation 11/11 и Offline; выполнены новая копия 068, восстановление,
изолированная репетиция, один живой owner deploy --with-069 и штатный выпуск API.
Сервер: API 6630eb0f, точная schema071 / 64 миграции. 072 не применялась.
Флаги этапа 2 и push выключены. С1 не повторялся, новые юридические ссылки сохранены.
Наблюдение после установки 15.1 мин PASS; собственные блокировки сняты.
Онлайн-пульт, Apple, касса, Caddy, watchdog, каталог, цены и оплаты не менялись.
Это серверная установка с выключенными функциями, не приёмка на кассе владельцем.

## Доказательство С1

Источник оркестратора f1f02585be6c5a3940f838e7b79a1470e5cef967:

- [Foundation 11/11 PASS](https://github.com/xaaknazar/pickchick/actions/runs/42241227139).
- [Полный Offline PASS](https://github.com/xaaknazar/pickchick/actions/runs/42241227389).
- 33 локальных теста, 443 именованные серверные проверки PASS.
- Свежий baseline 20:45 Алматы совпал с утверждённым; активная работа0.
- С1 выполнен около20:46. Новый compose SHA256:
  89cc593e025fb2451974ac87998966295aaa175a29e20c1a640475456507c3df.
- Ровно CUSTOMER_AUTH_TERMS_URL и CUSTOMER_AUTH_PRIVACY_URL переведены на
  https://pickchick.kz/legal/terms и https://pickchick.kz/legal/privacy.
- Domain gate11/11 PASS. Адреса Support/Privacy переданы аргументами;
  аккаунт Apple в этом окне не изменялся и заново не проверялся.
- 7 HTTP-маршрутов до/после200 с HSTS: API health, сайт, кабинет,
  обе страницы кухни, табло и прежний соседний сайт.
- API image/revision, остальные env, все метки/ID/StartedAt соседей,
  указатели, ledger068 и наборы73/18 совпали.
- Повторная проверка20:59: health/readiness PASS, API и соседи прежние,
  pending attempts/invoices/QR/refunds/active kitchen=0.
  Наблюдение после С1 более10мин. Собственный lock снят около21:00.

## Первая попытка С3 и точная причина STOP

Runtime6630eb0f676350341806b735b6877a36f017c673 чистый и опубликован.
[Foundation11/11](https://github.com/xaaknazar/pickchick/actions/runs/42008838570)
и [полный Offline](https://github.com/xaaknazar/pickchick/actions/runs/42008838516)
повторно подтверждены через GitHub.

- Штатный backup.sh совпал с установленным c3a0fbee.
- Свежая копия068 от15:48:32 UTC на VPS и Mac, SHA256
  3e4c0a988fc5b91288bc08afe1b0836c01e7399ecd7b0a71ac8d943a453e3eeb.
  Файлы cloud-20261106T154832Z.dump.age, .sha256 и .manifest.json.age.
- restore-drill --require-manifest PASS, 167 таблиц.
- На отдельной восстановленной БД без внешней сети owner inspect и
  deploy --with-069 PASS, прежние данные сохранены, новые флаги false.
- Кандидат API запущен на копии071: readiness, capabilities, catalog,
  availability, auth/config PASS; startup не изменил количества строк.
- Репетиционный образ:
  sha256:4627ff12a156e83250997f24a1d69f38434ba4d81a8a6c00922b3590e39a59e2.
- При подготовке живого owner inspect локальная последовательность ожидала
  services.provision.environment в разрешённой конфигурации Compose и получила
  KeyError. В установленном JSON реально только api/cloud-db/redis-cache;
  --profile tools ничего не добавляет. Это ошибка предположения запускателя,
  а не отказ миграции и не повреждение сервера.
- До запуска живой owner-команды дело не дошло. Отдельный READ ONLY SELECT:
  61 миграция, head068. deploy не отправлялся. Повтор не выполнялся.
- Существующий DB_OWNER_PASSWORD есть в защищённом staging.env; значение
  не выводилось. Вход pickchick_owner и ledger проверены BEGIN READ ONLY.
  Новый ключ/роль/пароль не создавались, права не менялись.

## Разрешённый повтор С3 - PASS

Владелец разрешил сразу готовить повтор, живые миграции только после зелёной CI
818524ec и до 23:30 Алматы. При проблеме API после миграций оставить071 и старый API.

- Исправление подключения: 818524ec8fdfebe7552864c5942948e22d11a496,
  [Foundation 11/11](https://github.com/xaaknazar/pickchick/actions/runs/42249179575),
  [полный Offline](https://github.com/xaaknazar/pickchick/actions/runs/42249179604).
  Локальные проверки подключения и С1: 37 тестов PASS.
- Новый baseline после С1 совпал, активная работа 0, отпечатки 73/18 прежние.
  Собственная блокировка миграций 7c0e777c-875d-4d60-99dd-a28e55dd8a14.
- Новая копия 068: cloud-20261106T161318Z.dump.age на VPS и Mac,
  SHA256 150332ba8f11e89dab4a68fcd246a807367eead4df589a1827f232ae2fbcdfe5.
  restore-drill с manifest PASS, 167 таблиц.
- Первая передача исходников оборвалась до завершения. Частичные файлы
  сохранены отдельно; передача со сжатием завершена, 589 файлов побайтно сверены.
  Рабочая БД/API при этом не менялись. Изолированная репетиция 069-071
  и запуск API 6630eb0f на network:none PASS, 186 таблиц после миграций.
- В 21:53-21:54 Алматы штатный owner inspect и ровно один deploy --with-069 PASS:
  применены 069_cloud_customer_notifications.sql, 070_cloud_station_plans.sql,
  071_cloud_daily_reconciliation.sql. existingDataPreserved=true.
  Удалённых прав 0; добавлен только SELECT четырёх таблиц планов станций.
  Сверены 64 файла ledger/checksum, runtime ACL, public. Новых активных оплат 0.
- После миграций старый API и настройки С1 подтверждены; снят только свой lock.
  Штатные release-stage2-1024.py prepare, prepare --apply, apply --apply PASS
  из чистого опубликованного runtime 6630eb0f с точными pins и CI proofs.
- Итоговый образ: sha256:6b3e1accc6325bf78e6a0908af29b6ce83dfad92d706e4e8c5f5d389d2110492.
  Compose кандидата SHA256:
  3b6d2f55be5e8dae202de15dfca292b9f33e278c4435befee7ee6623dadd4d4c.
- Перед переключением отдельная свежая зашифрованная копия 071:
  cloud-stage21024-29f072f992914860961c674c439ef1f4.dump.age,
  SHA256 380f348f25e81cb72977bf2407dcd6e49998dbf0f49e3ad2bce677d395043a9b. Все 3 файла на VPS/Mac, хеш сверился.
  Изолированное восстановление 186 таблиц и запуск точного итогового образа PASS.
- В 22:23 Алматы API обновлён до 6630eb0f; current указывает на этот релиз.
  Public pointer остаётся c3a0fbee. Только три новых env-флага добавлены как false:
  CATALOG_EDGE_COMBO_STOPS_ENABLED, BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED,
  BACKOFFICE_RECONCILIATION_ENABLED. Другие env/ACL/соседи и rollback-файлы прежние.
- Domain gate 12/12 PASS, Telegram-only и обе ссылки С1 PASS.
  Support RU/en и Privacy заданы аргументами; аккаунт Apple в этом окне не читался.
  Сайт, кабинет, две кухни, табло, API и прежний соседний сайт: 7/7 HTTP 200/HSTS.
- Наблюдение 15.1 мин PASS. Snapshot/long-poll обоих адресов HTTP 200;
  последний замер: domain: 20.07 с, nip: 20.08 с. Health/readiness, ledger071, образ/revision,
  env, все метки/ID/StartedAt соседей и наборы 73/18 повторно сверены.
  Активные attempts/invoices/QR/refunds/cloud-kitchen=0.
- Последний собственный lock наблюдения снят после успешной проверки.
  Реальные оплаты/QR/счета не создавались, новые заказы и 73/18 не изменялись.

[Обезличенные результаты](result-evening-2026-11-06-evidence.json).
Полные защищённые доказательства и зашифрованные копии остаются вне Git.

## Откат

С1 не потребовал отката и остаётся подтверждённым самостоятельным шагом.
Защищённая копия:
/opt/pickchick-staging/maintenance/C1-3dd68808-f549-42a1-8e8a-4bda84ab5e5c/compose.before.json
SHA256 05d009fa3bc286c403032f2be9eaf6d25c7ff004abdd1b92c0880baff2682805.
При отдельном откате сверить hash/свой lock, вернуть compose и пересоздать
только API, затем повторить проверки C1. Рабочая БД не восстанавливается.

В первой остановленной попытке С3 рабочие миграции и API не менялись.
В разрешённом повторе071 иAPI 6630eb0f установлены; откат не потребовался.
При необходимости использовать штатный rollback API с теми же pins и
доказательствами prepared.json; вернуть только API c3a0fbee, оставив schema071.
Рабочую БД поверх заказов не восстанавливать. Ссылки С1 сохраняются.
Все временные контейнеры репетиции удалены; зашифрованные копии и доказательства
сохранены. Снята только собственная .market-release.lock по UUID.

## Дальше

С1/С3 завершены. Владелец может вводить новый ключ бота через
infra/staging/watchdog/setup-telegram.command в своём Terminal со скрытым вводом.
Ключ в чат не присылать. Установка watchdog/shadow, последующее включение Telegram,
перенос Caddy, касса, магазины и включение флагов - отдельные шаги прежнего плана;
в это окно они не выполнялись. Ночной повтор С3 не требуется.

PR310/311 не сливались в этом окне. Протокол и факты сохранены в PR311,
онлайн-пульт не опубликован. Резервы задачи не снимаются через finish до включения
коммитов в shared; отдельный серверный lock уже освобождён.
