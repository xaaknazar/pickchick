# Публичный HTTPS для первого мобильного стенда

Назначение: получение **синтетического меню** в тестовой сборке PickChick.
Это не приём заказов ресторана и не production. API остаётся развёрнутым
в Казахстане на предоставленном VPS; публичный DNS `nip.io` — временный адрес
для стенда без собственного домена.

Адрес: `https://pickchick.185.129.51.103.nip.io`.
Имя `cloud-002.h-159695.kz` из письма провайдера на 06.09.2026 возвращает
NXDOMAIN; использовать его как действующий API-домен нельзя.

## Контракт мобильной сборки

Разрешены только перечисленные GET-запросы:

| Путь                                                     | Ответ                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/capabilities`                                       | `environment=staging`, `data_mode=synthetic`, `ordering_enabled=false`; phone_auth/checkout/payments/fiscal/loyalty выключены; RU/KZ пояснение |
| `/v1/branches`                                           | `{branches:[{id,code,name,timezone,ordering_enabled:false}]}`                                                                                  |
| `/v1/branches/10000000-0000-4000-8000-000000000003/menu` | Существующий menu snapshot v1 из PostgreSQL через cloud API                                                                                    |
| `/health/live`                                           | Только состояние процесса gateway; не раскрывает БД/Redis                                                                                      |

Ответы помечены `X-PickChick-Environment: staging`,
`X-PickChick-Data: synthetic`, `X-PickChick-Ordering: disabled` и `Cache-Control: no-store`.
Другие методы, внутренние device/enrollment/staff маршруты, readiness и любые
мутации возвращают 404. Gateway удаляет Authorization, Cookie и X-Device-Id
перед запросом upstream. Клиент не содержит общего API-секрета или SSH-ключа.
Только разрешённые публичные GET возвращают `Access-Control-Allow-Origin: *`
для Expo web-проверок; credentials не разрешены, отказы не получают этот заголовок.
Это CORS для открытого синтетического каталога, а не механизм авторизации.
OPTIONS/мутации не публикуются; клиент использует простой GET без лишних
request headers и не отправляет cookies.

Меню содержит `schema_version`, `release_id`, `branch_id`, `version`, `published_at`,
`items`. У SKU: `product_id`, `variant_id`, `category_id`, `name:{ru,kk}`,
`price_minor` как десятичная строка целых минимальных единиц, `currency=KZT`.
Например, `349000` означает 3 490 ₸. На первом стенде один тестовый SKU;
каталог с модификаторами/комбо и настоящими фотографиями ещё предстоит сделать.

Мобильное приложение проверяет capabilities до показа действий заказа и
сохраняет оформление выключенным при ошибке/неизвестной версии. Никакое
нажатие в дизайне не подтверждает оплату, чек или начисление. Kaspi/ККМ/SMS
пока не предоставлены. OTP, заказы и лояльность не объявляются работающими
по факту доступности меню. Не включать исключения ATS для HTTP либо отключение
проверки сертификата ради подключения.

## Изоляция

`infra/public-staging/compose.yaml` создаёт только `pickchick-public-gateway`.
Образ Caddy 2.11.4 закреплён digest; лимиты 128 MiB / 0,5 CPU, readonly root,
без Docker socket, секретов и host ports. Все capabilities убраны, кроме
NET_BIND_SERVICE: бинарник upstream-образа имеет соответствующий file capability,
поэтому этот бит нужен для его исполнения с no-new-privileges даже на 8080.
Gateway подключён к `deploy_default` для существующего входного Caddy и
к `pickchick-staging_ingress` для API. К сети `pickchick-staging_private`,
PostgreSQL и Redis он не подключён. API по-прежнему опубликован на host только
в `127.0.0.1:13100`. БД/Redis наружу не публикуются.

Порты 80/443 уже принадлежат idrink Caddy. В его конфигурацию добавляется
**отдельный hostname** из `infra/public-staging/front-site.Caddyfile`.
Существующий блок `185.129.51.103.nip.io → server:3000` сохраняется байт в байт.
Это изменение общего reverse proxy, хотя код, БД, контейнеры и исходный
маршрут idrink не меняются. Reload выполняется без перезапуска Caddy.

## Выпуск и проверки

1. Проверить runtime readiness, ресурсы, действующий HTTPS idrink, даты запуска
   трёх контейнеров idrink и отсутствие ранее добавленного PickChick hostname.
   Сохранить конфигурацию Caddy локально в защищённый `.local` без печати,
   её SHA256 и отдельную backup-копию на VPS. Не включать конфигурацию idrink в Git.
2. Проверить новый gateway config командой `caddy validate` на закреплённом
   образе; `docker compose config --quiet`. Копировать только каталог
   `infra/public-staging` из конкретного проверенного коммита в отдельный
   `/opt/pickchick-staging/public-https/releases/<SHA>`.
3. Запустить compose **этого** каталога: `docker compose up -d --wait gateway`.
   Проверить allowlist через Docker сеть до публикации hostname.
4. Сформировать candidate как точные исходные байты Caddyfile + разделитель
   - новый site. Проверить candidate в disposable Caddy validator с readonly
     mount существующих `/data` и `/config`; передать прежнее значение переменной
     `DOMAIN` (только публичный hostname), используемой исходной Caddyfile.
     Не запускать второй listener 80/443.
5. Перед записью повторно сверить текущий SHA256 оригинала. Сохранить timestamp
   backup рядом с `/opt/idrink/deploy/Caddyfile`; записать candidate **в существующий
   inode** host-файла. После записи проверить,
   что backup совпадает с исходником, а candidate начинается с исходных байтов.
   На проверенном VPS существующий bind mount уже видит иной inode
   (823410), чем host-файл (823434), хотя исходные байты совпадали. Поэтому
   чтение `/etc/caddy/Caddyfile` внутри живого контейнера не подтверждает запись.
6. До записи и после подготовки candidate использовать
   `docker exec -i deploy-caddy-1 caddy validate --config - --adapter caddyfile`,
   передавая candidate через stdin. После проверки host-файла выполнить
   `caddy reload --config - --adapter caddyfile` тем же способом. Значение DOMAIN
   берётся из прежнего окружения Caddy. Так runtime получает точные проверенные
   байты без remount/restart; на следующем запуске контейнер смонтирует актуальный
   host-файл. При ошибке восстановить backup в host inode и передать исходные
   байты через stdin в reload; API/БД не трогать.
7. Дождаться trusted TLS для нового hostname. Выполнить
   `python3 infra/public-staging/smoke.py`: 4 разрешённых GET и 10 отказов,
   ordering=false, синтетическая точка, minor-unit меню. Проверить сертификат
   и доверие системным TLS-клиентом без `-k`.
8. Повторно проверить idrink HTTP status, fingerprint тела публичной стартовой
   страницы, даты запуска контейнеров и PickChick readiness. Не читать клиентские
   записи idrink. Не выполнять общий restart, prune, OS upgrade или firewall changes.
9. Записать фактический SHA, image digest, timestamp backup, проверки и URL
   в deployment record. Перед новым релизом снова проверить все ограничения.

Проверка smoke получает только синтетические данные и делает заведомо
недоступные POST без payload. Она не регистрирует устройство и не вызывает
финансовые API. Ручной запуск не является постоянным внешним мониторингом.

## Откат

Если нарушилась работа idrink, открылся внутренний маршрут, появились не-test
данные либо TLS не работает: восстановить зафиксированную backup-копию Caddyfile
в существующий host inode, validate + reload **её байтами через stdin**, учитывая
разные inode bind mount, как описано выше. Затем остановить только
`docker compose stop gateway` в релизе `pickchick-public`.
Не удалять тома, не останавливать PostgreSQL/Redis/API/idrinк и не делать общий
`docker compose down` в чужом проекте. После отката проверить idrink и закрытие
PickChick hostname. Существующие сертификаты не удалять.

Если общая Caddyfile менялась после этого релиза, не перезаписывать её старым
backup вслепую: убрать только добавленный PickChick block из актуальной версии,
повторно validate + reload. Сравнение SHA обязательно.

Независимые копии в Казахстане, алерты, нагрузочная проверка, собственный домен
и production readiness остаются отдельными этапами. TLS через `nip.io` и
доступное меню не закрывают эти работы.

Подтверждённые свойства TLS: Caddy выполняет автоматическую выдачу для public
DNS names; ACME HTTP/TLS challenges требуют внешние 80/443, перенос внутреннего
порта сам по себе не меняет challenge port.
[Документация Caddy](https://caddyserver.com/docs/caddyfile/directives/tls).
