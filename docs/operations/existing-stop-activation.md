# Включение удалённых стопов на действующей кассе

Дата: 12 октября 2026. Задача `stop-activation`.

## Область и фактическая база

Касса `192.168.3.33` доступна с финансового Mac собственным SSH-ключом;
проверенный fingerprint `SHA256:LyXj9xzIn/z9OubsMrmqEtVhwSpjayGahVyeCaMLf0M`.
Приватные ключи, env и credentials не входят в Git. IP перепроверять перед работой.

Установлены API `f01cb45f441de1b664806c42aa93deb5cbb568b6` / cloud052 и
Windows edge `23fb39e152fccaa97a32e9bf179c2d89a50dc1d5` / edge019. Шесть служб
работают, menu v7 applied, SQL-права edge проверены. Новые операторы включают
существующий online STOP/UNSTOP; они не устанавливают Devices, cloud-kitchen,
новый runtime, миграции, платежи или фискализацию.

Исторические `release-unified-menu.py`, `continue-unified-menu.py` и
`enable-native-remote-stops.ps1` сохраняют прежние guards. Их профили cloud049
или cloud051/edge020 не подходят этой установленной паре.

## Порядок выпуска

1. Зарезервировать `@vps/api`, `@vps/db`, `@windows/cashier`. Получить свежие refs.
   Записать реальные API image, compose SHA-256, public pointer и gateway hash.
   Работать только из чистого опубликованного operator SHA с полной Foundation CI.
   Отдельно сохранить канонические полные CI proofs установленного API и edge.
2. Проверить SSH host key. В защищённый отдельный каталог Windows положить
   `enable-existing-remote-stops.ps1`, `existing-stops-readiness.mjs` и четыре
   неизменённых pinned helper из `infra/windows`: `install-native-menu-sync.ps1`,
   `update-native-unified-menu.ps1`, `update-native-service.ps1`, `reviewed-env-bytes.ps1`.
   Проверить хеши файлов по operator commit. Запустить
   `tests/operations/windows-existing-stops.test.ps1`: это temp-file и mocked SCM,
   тест не обращается к реальным службам или рабочей БД.
3. Положить owner helper из operator commit в защищённый VPS-каталог
   `/opt/pickchick-staging/existing-stops-incoming/<operator-sha>/existing-stops-owner.mjs`.
   Оператор монтирует только этот файл read-only в существующий provision image,
   проверяет его хеш и байты установленных зависимостей. Образ API не меняется.
4. Запустить `python3 infra/staging/release-existing-stops.py menu-head <api-sha>`.
   Обязательные аргументы: `--operator-sha`, `--branch`, `--branch-id`,
   `--ci-proof`, `--api-ci-proof`, `--expected-api-image`, `--expected-public-sha`,
   `--expected-compose-sha256`, `--expected-gateway-sha256`, `--ssh-key`.
   JSON proofs хранить с правами 600. Получить свежий `menu-head.json`.
5. На Windows сначала `-Mode Enable` без `-Apply`. Передать `-SourceCommit` edge,
   `-ApiSourceCommit`, `-OperatorCommit`, `-CiProof`, `-OperatorCiProof`,
   `-OperatorScriptSha256`, `-ReadinessSha256`, `-BranchId`, `-DeviceId`,
   `-MenuHeadProof`, `-MenuHeadProofSha256`, `-ExpectedEdgeEnvSha256`.
   Сохранить план в защищённый JSON, сверить хеш. Только затем повторить с
   `-ReviewedPlan`, `-ReviewedPlanSha256`, `-Apply`.
6. Windows проверяет все файлы runtime, schema019, роли, фактический menu hash,
   ACK, protocol4 и пустые очереди. Меняет только `EDGE_REMOTE_STOPS_ENABLED`
   через byte CAS под существующим maintenance lock. Перед этим сохраняет
   приватные before/after env и проверяет восстановление копии. БД не меняется.
   Перезапускаются только Edge и зависимый KitchenLink; прочие PID и конфигурация
   сверяются. При известном сбое восстанавливаются исходные байты и службы.
7. Сохранить Windows result на Mac с правами 600. Запустить VPS `remote-stops`
   без `--apply`, добавив `--windows-proof`. Сверить план. Повторить с
   `--plan`, `--plan-sha256`, `--backup-identity`, `--apply`.
   До изменения выполняются encrypted backup и изолированный restore.
   Owner-транзакция проверяет точный ledger052, роли, все ACL и сохранность данных;
   добавляет только необходимые права стоп-команд. Compose CAS включает только
   `BACKOFFICE_REMOTE_STOPS_ENABLED`, перезапускается только существующий API.
   Gateway, банк, portal, Redis, PostgreSQL и чужие контейнеры не перезапускаются.
8. Проверить health, свежий heartbeat и доступность действий в кабинете управляющего.
   Зафиксировать установленный результат в статусе и roadmap отдельно от приёмки.
   Рабочие блюда не ставить на стоп ради автоматического smoke-теста.

## Отказ, неизвестный результат и отключение

Операторы оставляют attempt/evidence при ошибке; повторять `--apply` вслепую нельзя.
Потерянный ответ не означает, что переключение не произошло. Сначала прочитать
реальные флаги, ACL, PID и результаты из защищённых каталогов. Общий VPS lock
сохраняется при неуспехе; снимать только после выяснения состояния.

Для завершённого VPS-включения предусмотрен `disable --flag remote-stops`:
новые pins и review plan обязательны, Windows доступ не требуется. Он сначала
выключает флаг API, затем снимает INSERT; сохранённая история и transport-права
не удаляются. Для частичного выпуска сначала сопоставить owner evidence и compose
backup: штатный `disable` намеренно не принимает несогласованный начальный статус.
Не восстанавливать всю рабочую БД из backup поверх новых заказов.

## Проверки и границы

Локально 8 PostgreSQL-проверок owner/readiness прошли: точный ledger, чужие права,
сохранность данных, конкурентный heartbeat, pending-команды, действительный ACK.
13 Python-проверок прошли; локальный PowerShell отсутствует, поэтому исполняемые
46 guard checks отдельно пройдены на Windows PowerShell 5.1. Read-only probe на
кассе подтвердил полный runtime, schema019, grants и menu v7/ACK без ожидающих
команд. Это ещё не подтверждение включения флага или приёмки STOP/UNSTOP владельцем.

Действующий протокол требует доступной кассы и свежего heartbeat; команда имеет
срок действия 120 секунд. Ожидание не показывается как уже применённый стоп.
Новые offline-правила cloud-kitchen относятся к отдельному этапу. Автоматические
end-to-end STOP/UNSTOP тесты выполняются в изолированной БД, не на рабочих блюдах.

## Исправление проверки NTFS после первой попытки

Первая попытка operator `afb48570` 12 октября в 12:02 UTC не включила управление
стопами. API не менялся. Windows восстановил исходные байты `edge.env`, но старая
проверка прав ошибочно отклонила и включение, и проверку отката. Запись
`rollback_verified: false` сохранена без переписывания; это результат той проверки,
а не подтверждение неисправности работающего edge. Независимо проверены исходный
SHA-256 env, ready, полный runtime/ledger/grants/menu ACK и шесть работающих
служб; PID четырёх не затрагиваемых служб сохранились.

Причина воспроизведена отдельно на временных NTFS-файлах: `File.Replace` сохраняет
DACL назначения с разрешённым наследованием foundation, тогда как проверка после
замены требовала protected DACL. Исправление сохраняет права, проверяет тот же
список разрешённых субъектов и сравнивает владельца, группу, защиту и все ACE.
Служебный бит `SE_DACL_AUTO_INHERITED` не меняет разрешений и исключён из сравнения.
ACL входит в CAS плана; запрещённый субъект по-прежнему отклоняется до изменения.
Ошибки теперь оставляют этап и номера строк без содержимого секретных конфигураций.

На Windows PowerShell 5.1 прошли 46 проверок, включая настоящий NTFS, точные права
при включении/восстановлении и отказ при постороннем write-доступе. Старый attempt
не удалять и не повторять: следующий выпуск требует нового operator SHA, полной
CI, свежего menu-head и нового плана. Установка исправления ещё не подтверждена.

## Ключ резервной копии финансового Mac

Оператор `22f167d1` успешно включил обработку команд на Windows после полной
Foundation CI 38247970211 (11/11). Серверная фаза остановилась до owner-транзакции
и переключения API: унаследованный backup использовал общий recipient второго Mac,
к которому локальная identity не подходит. Изолированная restore-БД удалена штатным
finally, рабочая БД и API не переключались; блокировка выпуска оставлена до сверки.

Для этой задачи применяется уже используемый кадровыми выпусками порядок:
recipient выводится локально через `age-keygen -y` из защищённой identity этого Mac.
Шифруется отдельная новая копия и проверяется её восстановление в изолированную БД.
Глобальный `backup-recipient.txt` не меняется, чужие копии и ключи сохраняются.
Приватный ключ передаётся для restore только через stdin, не в командной строке
и не в файл на VPS. Наличие копии без успешного restore не разрешает выпуск.
