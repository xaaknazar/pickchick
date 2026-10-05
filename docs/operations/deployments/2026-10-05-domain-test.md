# Подготовка HTTPS домена и изолированных TEST маршрутов

Подготовка от source 86fa1cd; изменения локальные, VPS не изменён. DNS/TLS состояние
нужно заново проверить перед выпуском. Это следующий отдельный этап после
приёмки текущей карточной TEST оплаты. Apple Pay в кабинете выключен; файл
верификации пока не получен. HTTPS сам по себе не подтверждает Apple Pay.

`infra/domains/release-alias.py` теперь требует точные 11 jobs текущего Foundation
CI. Старый `pickchick.Caddyfile` сохраняет запрет всех TipTop маршрутов. Новый
`pickchick-test.Caddyfile` разрешает только GET `test-checkout` и POST
`test-checkout-session`, `test-checkout-status`, `test-check`, `test-pay`,
`test-fail` под `/v1/integrations/tiptoppay/`. Все остальные пути и неверные методы
остаются 503. Запросы передаются установленному public gateway, который сохраняет
ограничения размера, методов, auth и HMAC. TEST handlers и общий запрет
находятся в явном `route`, чтобы Caddy не сортировал общий path matcher раньше
комбинированных method/path TEST matchers. Порядок закреплён тестом;
[официальная документация route](https://caddyserver.com/docs/caddyfile/directives/route)
подтверждает отсутствие внутренней пересортировки. Оба файла имеют фиксированный reviewed
SHA-256 в helper; TEST блок требует `--allow-tiptoppay-test`.

В TEST режиме capabilities старого и нового адреса сравниваются байт в байт:
смешанный Kaspi LIVE/TipTop TEST не подменяется предположением, что все payments
выключены. Default режим дополнительно сохраняет старую проверку payments=false.
Проверки LIVE 503, TEST page 200, unsigned webhook 401, wrong-method 503 не проводят
платежи и не создают заказы. Front byte backup, inode/owner writer, shared lock,
CAS API/public pointers, mounted gateway hash и отсутствие перезапуска соседних
контейнеров остаются обязательными.

## Следующий практический шаг

1. Дождаться успешного Foundation CI exact нового source SHA и опубликовать branch.
   Получить приватный proof `{run,jobs}` из GitHub API без передачи Authorization
   на signed redirect. Не использовать CI предыдущего source 86fa1cd для нового helper.
2. Согласованно claim `@vps/domains` и shared front config; не работать одновременно
   с владельцем `@vps/api`/gateway release. Read-only снять фактические API/public
   pointers, SHA-256 `/opt/idrink/deploy/Caddyfile`, mounted public Caddyfile,
   контейнеры и текущий TLS/DNS. Значения из сентябрьского runbook устарели.
3. Передать helper, выбранный блок и CI proof pinned SSH в отдельный приватный
   incoming каталог. Ни API/schema, ни secrets/env файлы не менять.
4. Выполнить inspect на VPS без `--apply` с точными baseline параметрами:

```sh
python3 release-alias.py \
  --source-sha SOURCE_SHA \
  --expected-api-sha INSTALLED_API_SHA \
  --expected-public-sha INSTALLED_PUBLIC_SHA \
  --expected-front-hash FRONT_SHA256 \
  --expected-gateway-hash MOUNTED_GATEWAY_SHA256 \
  --block pickchick-test.Caddyfile --block-sha256 REVIEWED_BLOCK_SHA256 \
  --ci-proof ci-proof.json --allow-tiptoppay-test
```

Для default blanket503 режима использовать `pickchick.Caddyfile` и убрать TEST
флаг. Apply - отдельный разрешённый выпуск с теми же параметрами и `--apply`.
При уже существующем alias helper остановится: нельзя повторно дописывать блок
или удалять существующий блок без отдельной проверки его происхождения.
После reload требуются trusted TLS apex/api/www, HSTS, неизменные staff redirects,
старый nip.io и соседний idrink, точные TEST/LIVE HTTP ответы. При timeout или
неподтверждённом rollback lock остаётся для ручного обследования.

## Apple Pay и смена origin остаются отдельно

Текущая mobile 13 сборка обращается к nip.io и разрешает hosted URL того же origin.
Не менять `TIPTOPPAY_CHECKOUT_ORIGIN`, мобильную конфигурацию или адреса callback
в кабинете этим этапом. Для будущего Apple Pay нужно получить официальный файл
провайдера и его точный путь/содержимое, подтвердить merchant domain, согласовать
hosted origin и разрешённый mobile origin; потребуется отдельная приёмка и,
вероятно, следующая native сборка. Маршрут `.well-known` здесь не добавлен:
произвольный или неподтверждённый verification file не публикуется.

## Локальные доказательства

7 domain guard tests: точные 11 CI jobs, rejected failed/skipped/partial/wrongSHA,
сохранение original bytes, default запрет TEST блока, reviewed block hash/method
защита, LIVE/unsigned/wrong-method probes, isolated writer ownership. Caddy runtime
validate и реальный TLS не выполнены в этой подготовке; helper выполняет validate
на существующем Caddy до любого изменения. VPS и merchant settings не менялись.
