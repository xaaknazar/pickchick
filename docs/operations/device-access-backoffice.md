# Устройства в кабинете pickchick.kz

Канонический `https://pickchick.kz/backoffice/` обслуживает отдельный контейнер
`pickchick-staff-login`. Его UI и HTTP allowlist находятся внутри образа.
Замена `public-web/backoffice` при Devices cloud-выпуске обновляет nip.io,
но не этот кабинет. Поэтому после cloud/Windows/portal этапов требуется отдельное
обновление staff-login тем же проверенным исходником. Это ещё не протокол установки.

Использовать существующие `infra/backoffice-login/prepare.py` и `update.py`.
Prepare требует чистый опубликованный HEAD, Node и pnpm из репозитория, собирает
бэкофис и immutable manifest. Он использует `corepack pnpm`; обычный глобальный
pnpm другой версии не подменяет закреплённый менеджер.

```sh
python3.12 infra/backoffice-login/prepare.py --sha "$SOURCE_SHA" --output "$ARCHIVE"
```

Передать архив через доверенный SSH, проверить SHA-256, распаковать в новый
приватный incoming-каталог. Передать полное успешное GitHub run/jobs доказательство
11/11 для того же исходника. Получить свежие API/public pointers, смонтированные
gateway/front hashes и действующие staff-login source/image ID. На VPS:

```sh
python3 "$INCOMING/infra/backoffice-login/update.py" \
  --source-sha "$SOURCE_SHA" --ci-proof "$CI_PROOF" \
  --expected-portal-sha "$OLD_STAFF_SHA" --expected-portal-image "$OLD_STAFF_IMAGE" \
  --expected-api-sha "$LIVE_API_SHA" --expected-public-sha "$LIVE_PUBLIC_SHA" \
  --expected-front-hash "$FRONT_SHA256" --expected-gateway-hash "$GATEWAY_SHA256"
```

Сначала только проверка, затем та же команда с `--apply`. Оператор занимает общую
release lock, сохраняет приватную конфигурацию и проверяет восстановление её
байтов в отдельный файл. Останавливает и сохраняет старый контейнер для отката,
запускает только новый staff-login. Существующие аккаунты, токены и роли сохраняются;
перезапуск завершит браузерные сессии, потребуется обычный повторный вход.

Проверяются exact OCI image, HTTPS login/session guards и хеши реальных app/API/
Devices JS-модулей на **pickchick.kz**, а также CSS и logo. Все остальные работающие
контейнеры, включая три Kaspi, сверяются по ID, image и started time. API/DB,
gateway, домены, цены и платежи этим этапом не меняются. При неопределённом исходе
lock сохраняется; повтор без обследования запрещён. Штатный известный отказ
возвращает прежний сохранённый контейнер и проверяет его здоровье.

Отдельная ротация CEO-пароля не совмещается с обновлением UI: владелец должен
сам задать новый пароль через подготовленный приватный ввод. Этот выпуск
не генерирует и не сбрасывает пароли.
