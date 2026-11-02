# Availability long-poll на старом адресе приложения

Дата: 2026-11-02. Задача: `front-longpoll-1101`.
PR: https://github.com/xaaknazar/pickchick/pull/301

## Решение и границы

Владелец разрешил срочное изменение Caddy и отдельно временную передачу
`@vps/public-https` от `mobile-appstore-1022`. Остальные резервы сохранены.
Изменён только блок `pickchick.185.129.51.103.nip.io`:
GET `/v1/customer-checkout/availability` получает `response_header_timeout 32s`.
Остальные маршруты сохраняют 8s. Применён `reload`, без перезапуска контейнера.
API, образы служб, БД, флаги, каталог, касса, платежи и сборки приложения не менялись.
Онлайн-пульт не публиковался. Общие статус и roadmap заняты другой задачей;
этот протокол и журнал координации фиксируют результат независимо.

## Исходный код и воспроизведение

- База: `e4eb91b52ed912254e388513853e72b430d12c88`.
- Применённый код Caddy: `f9e1234e397daf8807364379c41218e4807d13a6`.
- Бандл SHA-256: `01896d587865a3af19e8f6878f40148eedecb60abb23b70f965b83e7a9a39fda`.
- До изменения с Mac: snapshot на обоих адресах 200; long-poll на nip.io
  504 за 8,59 с; на api.pickchick.kz 200 за 20,62 с.
- Живой блок PickChick до записи совпал с базой. Вне заменяемого блока
  полное побайтовое совпадение подтверждено до записи.

## Установка и доказательства

Окно началось 2026-11-02 14:48:05 UTC. Использован штатный общий замок
`/opt/pickchick-staging/.market-release.lock`; после успешных проверок он освобождён.
SSH использовал действующий известный ключ сервера и `StrictHostKeyChecking=yes`.

Закрытая папка протокола на VPS:
`/opt/pickchick-staging/maintenance/front-longpoll-20261102T144805Z-217d0f22/`.
В ней `Caddyfile.before`, `Caddyfile.candidate`, `result.json`, права файлов 0600.
Конфигурация соседнего сайта не выгружалась в Git и не печаталась.

- Исходный SHA-256: `8dcdd996788507aca74f26b787eed1b507624bd3928bf864930a46b12c16fc62`.
- Установленный SHA-256: `5993997a230ae099d9cb9b93c3a6cdf22f691ff1e1df35ac97a16d00ac6e0e52`.
- `caddy validate --config - --adapter caddyfile`: успешно.
- Запись с проверкой исходного хеша выполнена от владельца файла через
  изолированный контейнер существующего локального образа, как в
  `infra/staging/release-order-events.py`. Сеть, capabilities и запись в корень
  контейнера отключены. Новые образы не скачивались.
- Inode 823434, владелец 501:50 и права 0644 сохранены.
- `caddy reload --config - --adapter caddyfile`: успешно.
- ID, image ID и время старта существующих контейнеров до/после совпали.

| Проверка после reload                                                 | Результат                           |
| --------------------------------------------------------------------- | ----------------------------------- |
| Long-poll nip.io, два последовательных запроса с актуальной signature | 200, 20,06 с каждый                 |
| Snapshot nip.io                                                       | 200                                 |
| api.pickchick.kz/health/live                                          | 200                                 |
| Соседний сайт idrink                                                  | 200, SHA-256 тела совпал с исходным |
| /backoffice/                                                          | 200, SHA-256 тела совпал            |
| /kitchen/prep                                                         | 200, SHA-256 тела совпал            |
| /display                                                              | 200, SHA-256 тела совпал            |

Проверка страниц означает доступность HTTP и неизменность оболочек; действия
оператора и кухня с реальным заказом не запускались. Корзину на физическом
iPhone владелец проверяет самостоятельно; эта приёмка пока не подтверждена.

## Проверки кода и CI

Три проверки `tests/operations/test_front_site_longpoll.py` прошли.
Первый полный запуск Foundation CI:
https://github.com/xaaknazar/pickchick/actions/runs/41462596529
обнаружил отдельную календарную ошибку `tests/backoffice/finance-browser.py`:
после reload период сбрасывался на текущий ноябрь, а запись теста датирована
октябрём. Коммит `27d7b8e2` явно выбирает период фикстуры после восстановления.
Рабочий финансовый код не менялся. Полный сценарий этого теста прошёл локально
на отдельных синтетических PostgreSQL: сохранение, потерянный ответ, повтор,
периоды признания, CSV, закрытый месяц, редактирование, аудит, удаление,
три ширины окна. Новые CI и итог обычного merge фиксируются в PR и журнале
координации; до зелёной полной CI слияние не разрешено процедурой задачи.

IPA `PickChick 0.2.0 (32)`, Bundle ID `kz.pickchick.app`, проверен отдельно:
число ZIP-записей с `.appex/` равно 0. Это подтверждает отсутствие app extensions
в проверенном IPA, а не статус решения Apple.

## Дополнительная проверка 02.11

Владелец после установки сообщил другое сообщение: «Нет свежих данных от
ресторана». Read-only SELECT и публичные GET подтвердили на обоих адресах
`enabled=true`, `orderingOpen=true`, `fresh=false`. Режим филиала - `edge`.
Последнее обновление от кассы: 2026-11-02 09:29:55 UTC / 14:29:55 Алматы,
больше пяти часов до диагностики. Для допуска требуется не старше 30 секунд.
Связка и устройство активны, `ordering_closed=false`; ключ кассы действует
до 2026-11-20 07:34:54 UTC. Касса и БД не менялись. Это отдельная блокировка
приёма заказов из-за отсутствия обновлений, а не возврат ошибки Caddy.
Приёмка корзины на iPhone пока не подтверждена; ожидается проверка питания
и интернета кассы на точке.

Повторная CI также выявила гонку в финансовом тесте: после восстановления
операции отчёт ещё загружается и повторный render сбрасывает введённые даты.
Перед заполнением периода добавлено ожидание доступности «Показать».
Локально ошибка воспроизведена с задержкой GET отчёта на 700 мс: без ожидания
тест упал на той же проверке записи, с ожиданием весь сценарий прошёл.
Искусственная задержка использовалась только для диагностики и не включена
в опубликованный тест. Проверки сохранения, повторного запроса и записей
не ослаблены; рабочая логика финансов не менялась.

Перед вводом периода тест теперь также ждёт готовности общего выбора точки:
он отражает завершение параллельных загрузок кабинета. Затем тест явно ждёт
GET с выбранными датами, требует HTTP 200 и проверяет сохранение дат в полях.
Полный сценарий прошёл без задержек и с разными задержками финансового
и общего отчётов (700/2000 мс). Последний вариант задержек не воспроизвёл
сбой старой версии теста; причиной отдельного раннего падения CI до появления
отчёта его не считаем без дополнительного доказательства. Новые проверки ответа
дают точную диагностику, не скрывая ошибку сервера или сброс периода.

## Откат

Не накладывать откат поверх другого выпуска. Заново получить резерв HTTPS и
штатный общий замок; если замок занят или текущий хеш отличается от
установленного выше, остановиться и согласовать изменения. Использовать
действующую SSH-проверку ключа сервера.

На VPS, от оператора с Docker-доступом, выполнить следующий код Python.
Он не печатает конфигурацию, сохраняет inode и сначала проверяет обе суммы.
Идентификатор образа берётся из протокола именно этой установки, без pull.

```python
import hashlib, json, subprocess
from pathlib import Path

folder = Path('/opt/pickchick-staging/maintenance/front-longpoll-20261102T144805Z-217d0f22')
live = Path('/opt/idrink/deploy/Caddyfile')
proof = json.loads((folder / 'result.json').read_text())
old = (folder / 'Caddyfile.before').read_bytes()
hash_bytes = lambda data: hashlib.sha256(data).hexdigest()
assert hash_bytes(old) == proof['before_sha256']
assert hash_bytes(live.read_bytes()) == proof['after_sha256']
assert live.is_file() and not live.is_symlink()
meta = live.stat()

def run(args, data):
    result = subprocess.run(args, input=data, capture_output=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError('Command failed; private diagnostics suppressed')

caddy = ['docker', 'exec', '-i', 'deploy-caddy-1', 'caddy']
config_args = ['--config', '-', '--adapter', 'caddyfile']
run(caddy + ['validate'] + config_args, old)
writer = """const fs=require('node:fs'),c=require('node:crypto');
const h=b=>c.createHash('sha256').update(b).digest('hex');
if(h(fs.readFileSync('/target'))!==process.argv[1])throw Error('CAS mismatch');
const b=fs.readFileSync(0);if(h(b)!==process.argv[2])throw Error('Backup mismatch');
const f=fs.openSync('/target','w');fs.writeFileSync(f,b);fs.fsyncSync(f);fs.closeSync(f);
if(h(fs.readFileSync('/target'))!==process.argv[2])throw Error('Write mismatch');"""
run(['docker', 'run', '--rm', '-i', '--pull', 'never', '--network', 'none',
     '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
     '--user', f'{meta.st_uid}:{meta.st_gid}', '--mount',
     f'type=bind,source={live},target=/target', '--entrypoint', 'node',
     proof['writer_image_id'], '-e', writer,
     proof['after_sha256'], proof['before_sha256']], old)
run(caddy + ['reload'] + config_args, old)
assert hash_bytes(live.read_bytes()) == proof['before_sha256']
assert live.stat().st_ino == meta.st_ino
print('Rollback validated and reloaded')
```

После отката повторить GET snapshot, health, соседнего сайта и трёх страниц;
проверить неизменность контейнеров. Замок освобождать только после подтверждения
результата, при неопределённости оставить и зафиксировать причину. Откат вернёт
прежний 8-секундный тайм-аут для availability, поэтому исходная ошибка корзины
снова возможна. Фактический откат не требовался и не запускался.
