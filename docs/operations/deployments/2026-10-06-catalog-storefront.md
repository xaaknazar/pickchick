# Опубликованный mobile-каталог - подготовка установки

6 октября 2026 read-only проверка установленных компонентов подтвердила:

- API `f39863718f074e923ae24ffecf37d8bf36987cdf`, cloud schema038.
- Public pointer `239148bf3329f6ec8e467b9425bcdff6189dd414`.
- Gateway SHA-256 `1df3d12b60e829081bc90b77256cfc5a84b30064cabe8039cae519a41465ed51`.
- API compose SHA-256 `c62c24cb90418e791b9740352ffcafe4c664a1669887914d79dfea96dbbc5db2`.
- Manifest base source `e236824b80ee315eae48c371d722f4f6459aac8c`.
- `pickchick_app` уже имеет SELECT для branches, catalog_branch_heads,
  catalog_publications. Дополнительные grants не нужны и не выполняются.

Публичный `/v1/customer-checkout/catalog` сейчас возвращает 404: storefront
выключен, gateway не допускает этот GET. Клиентский TEST-каталог является
отдельным историческим снимком; его цены не подтверждают коммерческую цену.

`infra/staging/release-catalog-storefront.py` готовит новую API image из точного
опубликованного SHA с полностью зелёными 11 CI jobs. Образ сохраняет установленные
seller/customer/payment/auth policies. Меняется только API-флаг
`CATALOG_MOBILE_STOREFRONT_ENABLED=false -> true`; provision остаётся выключенным.
Gateway допускает один дополнительный GET через существующий CORS customer
matcher. Публичные bundles и manifest копируются побайтно без пересборки.

Apply требует прежний reviewed baseline, owned deployment/maintenance locks,
закрытый ingress, отсутствие конкурирующих writers и незавершённой банковской
работы, зашифрованную backup и восстановление в отдельную временную БД.
Проверяет неизменность всех 38 миграций, ACL, commerce/identity/farm данных,
runtime environment кроме storefront/revision, worker, соседних контейнеров,
кухни и всех public assets. Перед открытием ingress сравнивает внутренний
mobile-каталог с read-only public projection из PostgreSQL. После переключения
двух указателей через CAS проверяет публичный ответ и реальные gateway mounts.
При неопределённом завершении не выполняет автоматический rollback. Явный
rollback требует исходный owner UUID и private evidence; сохраняет schema/ACL
и исходные bundles, production dump не восстанавливает.

Применение: Python 3.12, `prepare`, затем `apply` с одинаковыми `--sha`,
`--branch`, `--expected-api-sha`, `--expected-public-sha`,
`--expected-gateway-sha256`, `--ssh-key`, `--ci-run`/`--ci-proof`;
для apply также `--backup-identity`. Private evidence находится в
`.local/catalog-storefront-release/<SHA>`. Значения ключей и backup identity
не переносить в Git или отчёт.

## Старые мобильные клиенты

Включение storefront требует `catalog_version` при создании новой котировки.
Без него backend возвращает `CATALOG_UPGRADE_REQUIRED` до финансовых операций.
Это необходимо: старый клиент не передаёт отображённую сумму и сервер не может
доказать её совпадение с опубликованным каталогом. Разрешать отсутствие версии
даже без mobile override небезопасно: базовая цена также может различаться.

Старые TEST-каталоги, чтение и восстановление существующих заказов и пути
действующих платежей сохраняются. Новый commercial checkout на старых сборках
будет заблокирован до обновления. Новый клиент должен показать понятное
требование обновления; старый может показать прежнюю общую ошибку.
Обновление всех iPhone и визуальная приёмка проверяются отдельно. Эта установка
не меняет цены/меню в PostgreSQL и не подтверждает банковский вызов.

## Проверки подготовки

`python3 -m unittest discover -s tests/operations -p
 'test_catalog_storefront_release.py'`: 14 тестов прошли. Проверены exact baseline,
все 11 CI jobs, отсутствие migrations/grant/provision, единственный flag и
точный GET, отклонение дрейфа, ACL read-only проверка, image pinning, data/ACL,
owned rollback, backup до запуска нового API, проверка каталога до открытия,
public/API CAS и сохранение maintenance при ошибке.

Read-only smoke использовал действующие compose/gateway: преобразования
прошли и добавили ровно один API flag и один GET. Runtime не менялся.
Prepare/apply, новое TestFlight и реальная оплата на этом этапе не выполнялись.
