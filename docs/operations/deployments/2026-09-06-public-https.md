# Публичный HTTPS staging — 06.09.2026

Подтверждённый адрес: **https://pickchick.185.129.51.103.nip.io**.
Контракт и откат: [runbook публичного стенда](../public-staging-https.md).
Публикация авторизована заказчиком для подключения тестовой мобильной сборки.
Домена, Kaspi, ККМ и SMS пока нет; стенд отдаёт только синтетический каталог.

## Артефакты

- API остался на исходном `dade4fd87ddd43c86f77e8c9b18e27ef1f4d01f1`.
  Ни код API, ни PostgreSQL/Redis, ни migration ledger в этом этапе не менялись.
- Gateway: `d0f190ad26575b2e80fc473a1f17223e159833d0`.
  `/opt/pickchick-staging/public-https/current` указывает на
  `releases/d0f190ad26575b2e80fc473a1f17223e159833d0`.
- Образ: `caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648`;
  observed image ID имеет тот же SHA256.
- Начальный выпуск gateway до CORS: `0ba7baffea91217eb4d9aed0bda3b88b45359a7e`.
  Последующее обновление CORS пересоздало только новый gateway.
- Новый hostname добавлен к общему входному Caddy в 13:01 UTC через graceful reload.
  Его frontend site одинаков в обоих перечисленных исходных SHA.

## Проверки

- SSH по существующему отдельному ключу с StrictHostKeyChecking; секреты не
  копировались в приложение/репозиторий. `cloud-002.h-159695.kz` — NXDOMAIN
  в локальном resolver, 1.1.1.1 и 8.8.8.8. Новый `pickchick.…nip.io` разрешается
  в предоставленный VPS 185.129.51.103.
- До публикации: gateway config и candidate входного Caddy прошли `caddy validate`;
  compose прошёл `config --quiet`. В приватной сети пройдены 14 HTTP-проверок.
- После публикации: системные curl и Python TLS-клиент без отключения проверки
  сертификата успешно получили ответы. Сертификат Let's Encrypt YE1:
  SAN `pickchick.185.129.51.103.nip.io`, действителен с 06.09.2026 12:02:37 UTC
  до 05.12.2026 12:02:36 UTC. Обновлением управляет существующий Caddy.
- Внешний `infra/public-staging/smoke.py` прошёл: capabilities, branches, меню
  единственной синтетической точки и минимальный health — 200; ещё десять
  внутренних/неразрешённых маршрутов и методов — 404. `ordering_enabled=false`;
  все capabilities интеграций выключены; minor-unit цены проверены.
- После CORS-обновления те же 14 проверок прошли повторно. Только четыре
  разрешённых GET содержат `Access-Control-Allow-Origin: *`, credentials не
  разрешены. Отказы не содержат разрешающего CORS. Дополнительно HEAD к
  `/v1/capabilities` вернул 404 без CORS.
- Gateway healthy, host port bindings пусты. Сети только `deploy_default` и
  `pickchick-staging_ingress`; доступа через Docker network к private БД нет.
  API по-прежнему слушается на host лишь `127.0.0.1:13100`, readiness ready=true,
  degraded=false. БД и Redis не публикуют host ports.
- idrink до и после вернул HTTP 200. SHA256 публичной стартовой страницы
  совпал: `480842acfa5336174e0594e6fc6e9a1feab8ddd4f11e74dd6031a45913bbdcb1`.
  Клиентские записи idrink не читались. Даты запуска остались прежними:
  Caddy 19.08 18:01:44 UTC, server 20.08 11:23:54 UTC, DB 19.08 17:53:10 UTC.
- До развёртывания: available RAM 2624 MiB, диск 184 GiB свободно,
  load average 0.00/0.07/0.08. Это снимок, не нагрузочное испытание.

## Общая Caddyfile и восстановление

Исходные **260 байт** сохранены как точный префикс нового host-файла.
SHA256 исходника: `50dc55f46943c5c3122fa84f97542c5e1a72052113ef514367845d756d9f664c`.
SHA256 итогового host-файла: `ce3da35fcb20731bbec4ae9fa886be14d127c35e5782312aef02ecc9fe77501c`.
Backup с mode 600:
`/opt/idrink/deploy/Caddyfile.pickchick-backup-20260906T130101Z`.

В исходной конфигурации обнаружена `{$DOMAIN}`; проверка candidate использовала
прежнее значение `185.129.51.103.nip.io`. Кроме того, уже существовавший bind mount
в Caddy указывал на inode 823410, а host-файл — на 823434. Первая попытка записи
не прошла контроль видимости в контейнере и была откачена до публикации.
Окончательный candidate сохранён в host-файле для последующего запуска, а runtime
получил те же проверенные байты через stdin в validate/reload. Контейнеры не
перезапускались для исправления bind mount. Для отката также применять stdin,
как указано в runbook, и сохранять возможные последующие изменения Caddyfile.

Предварительная приватная проверка также обнаружила file capability бинарника
Caddy: с полностью пустым bounding set exec возвращал EPERM. В итоговой
конфигурации оставлен только NET_BIND_SERVICE; остальные capabilities убраны.
Неисправный предварительный gateway был остановлен, общие сервисы не затронуты.

Не выполнялись общий restart Docker/хоста, OS upgrades, firewall/DNS changes,
production миграции или финансовые операции. Приём заказов, авторизация, SMS,
Kaspi, ККМ, лояльность, независимые backup, постоянные внешние алерты и
публикация TestFlight этим инфраструктурным этапом не реализованы.
Общий CI репозитория фиксируется отдельно при объединении этого изменения;
данный протокол описывает выполненные конфигурационные и сетевые проверки.
