# Каталог обновлений: подготовка 11 ноября 2026

**PREPARED_ONLY / BLOCKED: серверная установка не выполнена.** Проверено
11.11 около 19:50 UTC+5. Владелец разрешил установку сегодня в любое время,
без БД, с однократным пересозданием `pickchick-public-gateway`. Повторного
разрешения на это действие не требуется. Условие остановки сохраняется:
если feed host не приводит к gateway либо нужен чужой Caddy, спросить владельца.

## Подготовленные исходники и файлы

- Чистый detached checkout `46453717a01ece038c5653db202f9f059536cd64`,
  `/workspace/pickchick-desktop-updates-46453717`. Код не изменялся.
- Пакет собран штатным `infra/desktop-updates/package.py`:
  `/tmp/desktop-updates-46453717.tar.gz`, четыре файла исходников и manifest.
- SHA-256 архива:
  `bb2213a0a10b7215895eac31eee1c87c9ce956552ba699b3938f78c05e5283ae`.
- Распакованный пакет и feed находятся локально в
  `/workspace/pickchick-evidence/1111/desktop-updates/{package,feed}`;
  квитанция `prepared.json` там же. Эти файлы ещё не переданы на VPS.
- `verify_package` и `verify_feed` из распакованного точного пакета прошли.
  `next_release=kitchen-0.4.0-pos-0.5.0`; оба manifest используют `apply=idle`.

| Программа | Run / artifact            | Версия | Размер EXE | SHA-256 EXE                                                        |
| --------- | ------------------------- | ------ | ---------: | ------------------------------------------------------------------ |
| POS       | 43028287215 / 13859277085 | 0.5.0  |  172279820 | `1edcee5f760dd8c29ed5e3e37e5ca1fb95723227b11a96a5c74fc2cbc080f65c` |
| Kitchen   | 43028287205 / 13858842282 | 0.4.0  |  120891835 | `554341cc062d30cdb3e5a457ac54f0fe7f25870273269197a03b6f3159b59679` |

Оба артефакта относятся к `b922fc1ec248d08f4cdae3e915c33c57bf9f771a`, не
просрочены. Размеры и SHA-256 ZIP совпали с GitHub metadata:

```text
pos.zip 172305550 e8cd074497ecece406a41b51d6b6c6db8431ad18da3658ee1531c9397d78053b
kitchen.zip 120903563 acf81d8edb68b2e009274875f32ee5654a6b2b64186893ec3901ef29193febe5
```

Скачивание через `gh api .../zip` получило отказ на временном URL; штатный
GitHub connector скачал оба артефакта. После получения полные ZIP и EXE
сверены локально; подписанные временные ссылки в протокол не включены.
Архивы распакованы с проверкой путей/ссылок, EXE не исполнялись.

## Проверки до установки

`python3 -m unittest tests/operations/test_desktop_updates_release.py`:
**21/21 PASS** без пропусков. Дополнительно независимо просмотрены guards
установщика и условия отката. Новая Docker-репетиция здесь не запускалась.

Внешняя проверка около 14:50 UTC, это **baseline до установки**:

```text
GET  https://api.pickchick.kz/health/live
     {"service":"pickchick-public-gateway","alive":true,"environment":"staging"}
HEAD https://api.pickchick.kz/desktop-updates/pos/latest.json      404, cache-control: no-store
HEAD https://api.pickchick.kz/desktop-updates/kitchen/latest.json  404, cache-control: no-store
HEAD https://api.pickchick.kz/desktop-updates/                     404, cache-control: no-store
```

Это подтверждает публичный health-маршрут, но не владельца портов 80/443,
server-side `inspect`, состояние lock и возможность нового маршрута через
внешний Caddy. Значения `expected_public_release`, `expected_api_release`,
`expected_gateway_sha256` **не получены**, прошлые значения не подставлялись.

Cloud-1 GitHub preflight выполнен до установки из точного checkout:

```json
{
  "status": "CANDIDATE_GATE_ONLY",
  "candidate": "b922fc1ec248d08f4cdae3e915c33c57bf9f771a",
  "foundationRun": 43028287464,
  "jobs": 11,
  "deployed": false,
  "rehearsalVerified": false,
  "liveWindowVerified": false
}
```

PR352 на момент проверки открыт, head46453717; cutover остаётся b922fc1e.
Слияние не выполнялось. Пакет соответствует прямо указанному владельцем
коммиту, а не незаконченной/предполагаемой merge-голове.

## Блокер и точное продолжение

В выбранной облачной среде нет secret bindings, SSH-агента или настроенного
SSH-каталога; `vpn_configured=false`, TCP grants отсутствуют. Доступ другого
Mac из протокола Cloud-1 не перенесён в эту среду. У владельца запрошено
подключение через приватные настройки либо продолжение на доверенном Mac.
Пароли и приватные ключи в чат не запрашивались.

Дополнительная проверка после ответа владельца: TCP `185.129.51.103:22`
отклонён с `ConnectionRefusedError`, errno111 и в штатной песочнице, и в
одобренной проверке вне неё. Проверялось только соединение/SSH banner,
аутентификация не начиналась. Это не проверка правильности пароля и не
доказательство причины отказа на стороне VPS. Приватные данные не записаны
в этот протокол, исходники или Git. Сохраняется необходимость рабочего
SSH-маршрута с доверенного компьютера либо через настроенную сеть среды.

Не выполнены: SSH-проверка портов и lock, передача файлов, `inspect`, dry-run,
`install --apply`, проверки после установки и удаление SSH-ключа
`pickchick-claude-mac-20261110`. **Ключ нельзя считать отозванным.**

После появления доступа, без нового согласования уже разрешённой установки:

1. Получить свежие refs и ProjectSync; занять соответствующие серверные ресурсы.
   Сейчас зарезервирован только этот документ, рабочие серверные области не заняты
   данной задачей. Сохранить чужие резервы; разрешение владельца распространяется
   на конкретный gateway/feed шаг, не на изменение API/БД/чужого Caddy.
2. От `pickchick-ops` UID1000 только чтением проверить отсутствие других работ
   и `.market-release.lock`, владельца 80/443 и Compose labels обнаруженного Caddy.
3. Передать архив/feed, распаковать и проверить SHA архива на сервере. Выполнить
   `inspect` по runbook и проверить `feed_host_reaches_gateway=true`,
   `gateway_route_installed=false`, `next_step=install`, lock отсутствует.
4. Получить свежие `expected_*`. До `--apply` отдельно проверить отсутствие
   immutable targets: `public-https/releases/46453717…`,
   `desktop-updates/sidecar/46453717…` и
   `desktop-updates/feed/releases/kitchen-0.4.0-pos-0.5.0`.
   Dry-run не проверяет эти конфликты до получения lock в apply; при конфликте
   ничего не удалять, разбирать причину.
5. Install без `--apply`, затем та же команда с `--apply`, все ожидаемые SHA
   по исходному поручению. При `rolled_back` сохранить ответ и разобрать причину.
   При `uncertain`/`rollback_needs_review` не повторять и не снимать lock.
   Внешний `status=failed` может быть менее подробен, чем deployment journal:
   проверить соответствующий `desktop-updates/deployments/install-*.json`.
6. Проверить оба latest снаружи:200/no-store; каталог404. Повторить server inspect
   и Cloud-1 preflight. GitHub-режим Cloud-1 сам не читает публичный pointer,
   поэтому новый public release/gateway SHA фиксируются отдельно, API прежний.
7. Удалить именно ключ с меткой `pickchick-claude-mac-20261110` из соответствующего
   `authorized_keys`, сохранив остальные записи и права. Проверить отсутствие
   целевого ключа и работу доверенного доступа. Записать факт только после проверки.
8. Опубликовать строку ответа install, фактические expected_*, curl и отзыв ключа.

Инструкция: [desktop-updates.md точного46453717](https://github.com/xaaknazar/pickchick/blob/46453717a01ece038c5653db202f9f059536cd64/docs/operations/desktop-updates.md).
Окно из runbook заменено прямым решением владельца: **11.11, любое время**.
Этот checkpoint не является квитанцией `deployed`; сервер не менялся.
