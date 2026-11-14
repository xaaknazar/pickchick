# Кухня через локальную сеть

Кассовый edge и PostgreSQL продолжают слушать только loopback. Отдельная служба
`PickChickKitchenLAN` принимает HTTPS на конкретном частном IPv4 кассы, порт 3443.
Firewall разрешает только IPv4 назначенного кухонного моноблока; сам gateway
повторно проверяет адрес, Host и список маршрутов. Через него доступны только
вход/выход сотрудника, его сессия, станции, очередь и действия кухни.
Кассовые, платёжные, owner и внутренние cloud transport команды недоступны.

`apps/kitchen-desktop` хранит назначенный оператором адрес, сертификат и terminalId.
Пароль вводится сотрудником в приложении. HTTPS клиент проверяет сертификат и
его IP SAN; откат на HTTP или отключение проверки TLS не допускаются. В renderer
адрес сервера и сертификат не передаются. Локальный HTTP между renderer и его
native gateway остаётся на 127.0.0.1:4178.

## Подготовка на кассе

`install-kitchen-lan.ps1` запускается один раз из повышенного Windows PowerShell 5.1.
Требуются установленная проверенная foundation `edge-0186902`, работающий edge,
назначенный кухонный terminal UUID и текущие частные IP двух устройств. Пример
параметров ниже использует переменные оператора, а не реальные секреты:

```powershell
.\install-kitchen-lan.ps1 -CashierAddress $CashierIp -KitchenAddress $KitchenIp -KitchenTerminalId $KitchenTerminal -BranchLabel $BranchName -GatewaySha256 $ReviewedGatewayHash -CheckSha256 $ReviewedCheckHash -ProfilesSha256 $ReviewedProfilesHash
```

Рядом должны находиться исходные `kitchen-lan-gateway.mjs`, `lan-route-profiles.mjs`
(профили маршрутов, шлюз импортирует его из своей папки), `kitchen-lan-check.mjs`
и точная проверенная версия `install-native-foundation.ps1`. SHA256 трёх JS-файлов
берутся из manifest поставки. Helper сверяет foundation, копирует уже проверенный
WinSW 2.12 и использует установленный Node 24.21.0.

Сертификат RSA 3072/SHA256 с IP SAN создаётся **на Windows**. Закрытый ключ
экспортируется в AES256/SHA256 PFX с отдельным случайным паролем. PFX и конфигурация
доступны только SYSTEM, администраторам, оператору и LocalService на чтение;
журналам LocalService предоставляется Modify. Пароль PFX не выводится. Служба
зависит от PickChickEdge, запускается автоматически с задержкой и восстанавливается
после сбоя. Проверки включают реальный TLS, отказ без закреплённого сертификата,
401 без сессии, запрет внутреннего маршрута и принадлежность сетевого listener.

После успеха в `C:\ProgramData\PickChick\KitchenLAN\` остаются:

- `public-kitchen-config.json` - публичный сертификат, адрес, название и terminal UUID;
- `installation.json` - хеш сертификата, срок действия и результаты установки;
- `private\` - PFX и конфигурация службы; их нельзя отправлять через портал загрузки.

На кухню передаётся только публичный config с проверкой SHA256 сертификата по
доверенному каналу монтажа. Его устанавливают в `%APPDATA%\PickChickKitchen\config.json`.
Профиль и журнал команд кухни сохраняются при обновлении приложения.
Сначала проверяется вход и выбор назначенных станций, затем реальный заказ с кассы
и прохождение кухни/сборки/выдачи. Запуск службы сам по себе не доказывает этот сценарий.

## Эксплуатация

IP обоих моноблоков нужно закрепить в DHCP роутера. При смене IP сертификат,
firewall и config должны обновляться согласованно. Срок сертификата - один год;
дата окончания записана в installation.json. Автоматическая ротация пока не настроена.
Если установка остановилась, защищённые файлы сохраняются. Повторная команда
отказывается перезаписывать существующую службу; сначала проверяется фактическое
состояние. Исходный edge и его база этим helper не изменяются.

## Сертификат и переустановка шлюза

Сертификат шлюза должен разрешать keyCertSign (`-KeyUsage
DigitalSignature,KeyEncipherment,CertSign`). Кухня и касса - программы на Electron (BoringSSL):
закреплённый самоподписанный сертификат без этого права они не считают своим издателем и
отклоняют соединение. 14.11 на тестовой кассе так было: каждый запрос кухни заканчивался 504
`EDGE_TIMEOUT`, привязка - «Код не принят», хотя `kitchen-lan-check.mjs` (Node с OpenSSL 3 на
сервере) проходил. Установщик до этой правки (SHA-256 `4df0d495…`) создавал сертификат без
keyCertSign; такой шлюз переустанавливают (повышенный Windows PowerShell 5.1 на сервере):

1. Записать `certificateSha256` из `C:\ProgramData\PickChick\KitchenLAN\installation.json`
   (прежний хеш, для сверки).
2. `Stop-Service PickChickKitchenLAN`, затем `sc.exe delete PickChickKitchenLAN`.
3. `Remove-NetFirewallRule -Name PickChickKitchenLAN`.
4. Найти сертификат: `Get-ChildItem Cert:\LocalMachine\My | Where-Object Subject -eq 'CN=PickChick Kitchen LAN'`
   и удалить его по отпечатку: `Remove-Item Cert:\LocalMachine\My\<Thumbprint>`.
5. Переименовать в сторону (не удалять) обе папки: `C:\Program Files\PickChick\KitchenLAN` и
   `C:\ProgramData\PickChick\KitchenLAN`, например с суффиксом `-old-<дата>`.
6. Запустить новый `install-kitchen-lan.ps1` с теми же параметрами (хеш файла - по manifest).
   Если список клиентов уже менялся `update-kitchen-lan-clients.ps1`, повторить его с тем же
   `clients.json`.
7. На каждом кухонном экране (и на кассе, уже переведённой на шлюз) снова запустить
   `install-kitchen-client.ps1` (`install-pos-client.ps1`) с новым публичным файлом и новым
   `certificateSha256` из нового `installation.json`, с тем же режимом и терминалом (без
   `-Replace`). Существующие привязки экранов сохраняются, привязывать заново не нужно.

## Несколько клиентов и профили (переход 19.11)

Установщик ставит шлюз с одним кухонным адресом (прежний формат `clientAddresses`).
Список устройств меняет `update-kitchen-lan-clients.ps1` без переустановки: прежний
формат для одних кухонных экранов (`-Legacy`, К7) или `clients[]` с профилем на адрес
(`kitchen`, `display`, `pos`; до 32 клиентов, `maxConnections` 64). Маршруты профилей -
`lan-route-profiles.mjs`; прежний `clientAddresses` на новом коде остаётся профилем
`kitchen` с прежними лимитами (20 адресов, 40 соединений). Конфиг проверяется
командой `node kitchen-lan-gateway.mjs --check <config>` без запуска listener.
Кассы и кухонные моноблоки подключают `install-pos-client.ps1` и
`install-kitchen-client.ps1`. Порядок, проверки и откат:
[LAN-клиенты точки](../../docs/operations/lan-clients.md).

Проверены на локальном стенде настоящий HTTPS/AES PFX, проверка сертификата,
границы Host/Origin, сохранение команды и авторизации, login 2 KiB, logout 204,
Retry-After, запрет перенаправлений/owner маршрутов и таймаут. PowerShell проверен
парсером и тестами частных адресов. Физические SCM, NTFS, firewall и кухонный
моноблок требуют отдельной проверки установки; этот документ не заявляет её успех.

Использованы штатные возможности Microsoft:
[IP SAN в New-SelfSignedCertificate](https://learn.microsoft.com/en-us/powershell/module/pki/new-selfsignedcertificate),
[экспорт AES256/SHA256](https://learn.microsoft.com/en-us/powershell/module/pki/export-pfxcertificate).
