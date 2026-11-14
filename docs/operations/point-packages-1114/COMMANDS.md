# Команды для Claude на Windows

Это справочник, не скрипт последовательного запуска. Выполнять отдельные блоки в
Windows PowerShell 5.1 x64 от администратора, внутри согласованного окна и после
проверок предыдущей ступени. Здесь нет команд применения миграций или установки рантайма.
Блок копии создаёт только копию и изолированную временную БД для её проверки.

## Пути и проверки перед работой

```powershell
$ErrorActionPreference = 'Stop'
$Root = 'C:\PickChickSetup\point-window-1114'
$Tools = 'C:\ProgramData\PickChick\EdgeTools\edge-0186902'
$Node = 'C:\Program Files\PickChick\Edge\edge-0186902\node\node.exe'
$PgBin = 'C:\Program Files\PickChick\Postgres\18.6-3\bin'
$OwnerEnv = Join-Path $Tools 'private\edge-owner.env'
$Branch = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'
$Historical = Join-Path $Root 'operators-023\infra\windows'
$Operator = Join-Path $Root 'operators-release\infra\windows'
$Foundation = Get-Content (Join-Path $Tools 'private\foundation-state.json') -Raw | ConvertFrom-Json
if (!$Foundation.complete -or $Foundation.branchId -cne $Branch -or $Foundation.computerName -ine $env:COMPUTERNAME) { throw 'Foundation mismatch' }
foreach ($p in @($Node, $OwnerEnv, (Join-Path $PgBin 'pg_dump.exe'), (Join-Path $PgBin 'pg_restore.exe'))) {
  if (!(Test-Path -LiteralPath $p -PathType Leaf)) { throw 'Required local tool or protected file absent' }
}
& $Node --version
& (Join-Path $PgBin 'pg_dump.exe') --version
& (Join-Path $PgBin 'pg_restore.exe') --version

# Все файлы в поставке должны совпасть с SHA256SUMS.txt.
Get-Content (Join-Path $Root 'SHA256SUMS.txt') | ForEach-Object {
  if ($_ -notmatch '^([a-f0-9]{64})  (.+)$') { throw 'Invalid checksum line' }
  $expected = $Matches[1]; $file = Join-Path $Root $Matches[2]
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) { throw 'Delivery file mismatch' }
}

# operators-release будет предоставлен ТОЛЬКО после итогового слияния и проверки.
if (!(Test-Path -LiteralPath $Operator -PathType Container)) { throw 'Final merged operators not delivered - STOP' }
```

Перед использованием обеспечить защищённые ACL у поставки и CI proof: запись только
SYSTEM, Administrators и текущему оператору. Не менять ACL существующих служебных
секретов, не печатать owner env. Штатные Assert-UpdateAcl остаются обязательными.

## Путь копий и новый инструмент резервирования

Владелец подтвердил путь E:\PickChickBackups. Claude сверяет, что E действительно отдельный
раздел, и проверяет его наличие. Если инструмент уже установлен с другим destination,
останавливаемся. C и путь через reparse point запрещены установщиком.

```powershell
$BackupDestination = 'E:\PickChickBackups'
$BackupConfigPath = 'C:\ProgramData\PickChick\EdgeBackup\private\edge-backup.json'
if (Test-Path -LiteralPath $BackupConfigPath) {
  $savedDestination = (Get-Content $BackupConfigPath -Raw | ConvertFrom-Json).destination
  if ($savedDestination -cne $BackupDestination) { throw 'Existing backup destination differs - STOP' }
}
& (Join-Path $Operator 'install-edge-backup.ps1') -Mode Install -BranchId $Branch -Destination $BackupDestination -AllowSameDisk -DryRun
```

Фактическая установка копий выполняется Claude отдельным согласованным действием.
Здесь только проверка. В частности, dry-run не создаёт задачу резервирования.

## Свежая копия с восстановлением на этом PostgreSQL

Использовать инструменты финальной поставки: backup-native-service.mjs,
native-foundation-db.mjs и native-edge-backup-ledger.json должны оставаться рядом.
Старый backup-native-edge.ps1 из установки foundation для этой задачи не подходит.

```powershell
function New-PrivateRun([string]$Path) {
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse path refused' }
    $parent = [IO.Directory]::GetParent($cursor)
    $cursor = if ($null -eq $parent) { $null } else { $parent.FullName }
  }
  if (Test-Path -LiteralPath $Path) { throw 'Existing run directory - no replay' }
  $null = New-Item -ItemType Directory -Path $Path
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach ($sid in @('S-1-5-18','S-1-5-32-544',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function New-RestoredBackup([int]$Schema) {
  if ($Schema -notin @(20,23,24,25,26,27,28)) { throw 'Unsupported step' }
  $run = Join-Path $BackupDestination ('rehearsal-{0:D3}-{1}' -f $Schema,[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
  New-PrivateRun $run
  & $Node (Join-Path $Operator 'backup-native-service.mjs') $Tools $PgBin $run $Branch ('schema{0:D3}' -f $Schema) | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Backup/restore failed; preserve private evidence' }
  $manifestPath = Join-Path $run 'backup-manifest.json'
  $m = Get-Content $manifestPath -Raw | ConvertFrom-Json
  if (!$m.completed -or !$m.backupVerified -or !$m.restoreVerified -or !$m.rehearsalDropped -or [int]$m.tableCounts.schema_migrations -ne $Schema -or $m.branchId -cne $Branch -or $m.systemIdentifier -cne $Foundation.systemIdentifier) { throw 'Backup manifest mismatch' }
  return $manifestPath
}

# Перед 020 -> 023, только когда фактическая схема 020:
$Backup020 = New-RestoredBackup 20

# После успешной 023 и до 024, отдельным действием:
# $Backup023 = New-RestoredBackup 23

# После успешной 024 и до 025, отдельным действием:
# $Backup024 = New-RestoredBackup 24
```

Manifest и dump сохраняются рядом в закрытой папке. Не присылать dump/конфигурацию в чат
или Git. Функция сверяет снимок, но не заменяет проверки остановки писателей и активных
заказов оператора. Для зашифрованных копий использовать установленную EdgeBackup.

## 020 -> 023, только проверка

```powershell
& (Join-Path $Historical 'update-runtime-1021.ps1') -SourceCommit '0fb95c9f09031d93e38e3af2a0c4a1bcc81f591c' -RuntimeArchive (Join-Path $Root 'runtime-0fb95c9f.zip') -RuntimeSha256 '5249e860899563957a1e00ffab97e4e8eab1310c234b063f6e9de148b7bafdd8' -BackupManifest $Backup020 -CiProof (Join-Path $Root 'ci\ci-0fb95c9f.json') -BranchId $Branch
```

Ожидается VERIFIED без постоянных изменений. Далее применение и приёмку выполняет
Claude по штатному порядку. Не переходить дальше после одного dry-run.

## Baseline после реальной 023 или 024

Этот блок создаёт квитанцию из свежей проверенной копии, завершённой предыдущей установки
и текущих XML. Рабочую схему повторно проверяет сам следующий оператор. Квитанция из
снимка до предыдущей ступени непригодна.

```powershell
$PrivateRun = Join-Path $Tools ('point-window-1114-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
New-PrivateRun $PrivateRun
function New-Baseline([int]$Schema,[string]$ManifestPath) {
  if ($Schema -eq 23) {
    $source = '0fb95c9f09031d93e38e3af2a0c4a1bcc81f591c'
    $format = 'pickchick-stage2-baseline-v1'
    $completed = 'C:\ProgramData\PickChick\EdgeTools\runtime-1021-0fb95c9\completed.json'
  } elseif ($Schema -eq 24) {
    $source = 'ffb2fd231e08db43843816afb9cccb1e532375e0'
    $format = 'pickchick-queue-recovery-baseline-v1'
    $completed = 'C:\ProgramData\PickChick\EdgeTools\runtime-stage2-1024-ffb2fd2\completed.json'
  } else { throw 'Expected schema023 or schema024' }
  $m = Get-Content $ManifestPath -Raw | ConvertFrom-Json
  $done = Get-Content $completed -Raw | ConvertFrom-Json
  if (!$m.completed -or !$m.restoreVerified -or [int]$m.tableCounts.schema_migrations -ne $Schema -or $m.systemIdentifier -cne $Foundation.systemIdentifier -or $m.branchId -cne $Branch -or $done.sourceCommit -cne $source -or $done.schema -ne $Schema) { throw 'Predecessor/backup mismatch' }
  $app = 'C:\Program Files\PickChick\Edge\edge-'+$source.Substring(0,7)+'\app'
  $runtime = Get-Content (Join-Path $app 'runtime-manifest.json') -Raw | ConvertFrom-Json
  if ($runtime.sourceCommit -cne $source) { throw 'Installed source mismatch' }
  $xmls = @(
    'C:\Program Files\PickChick\Edge\edge-0186902\PickChickEdge.xml',
    'C:\Program Files\PickChick\FulfillmentWorker\PickChickFulfillmentWorker.xml',
    'C:\Program Files\PickChick\MenuSyncWorker\PickChickMenuSyncWorker.xml',
    'C:\Program Files\PickChick\DeviceAccess\PickChickDeviceAccessWorker.xml'
  )
  $hashes = @($xmls | ForEach-Object {
    $text = [IO.File]::ReadAllText($_)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($text))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
  })
  $record = [ordered]@{format=$format;schema=$Schema;branchId=$Branch;computerName=$env:COMPUTERNAME;systemIdentifier=$Foundation.systemIdentifier;sourceCommit=$source;xmlHashes=$hashes}
  $path = Join-Path $PrivateRun ('baseline-{0:D3}.json' -f $Schema)
  if (Test-Path $path) { throw 'Baseline already exists' }
  [IO.File]::WriteAllText($path,($record|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
  return $path
}

# После реальной установки 023:
$Backup023 = New-RestoredBackup 23
$Baseline023 = New-Baseline 23 $Backup023
$Baseline023Sha = (Get-FileHash $Baseline023 -Algorithm SHA256).Hash.ToLowerInvariant()
```

Пример структуры 024 (НЕ готовая квитанция; реальные хеши создаёт функция):

```json
{
  "format": "pickchick-queue-recovery-baseline-v1",
  "schema": 24,
  "branchId": "7a6f6d98-395d-4462-b5e4-b0364a4a8ec1",
  "computerName": "WIN-C583E2V3LH9",
  "systemIdentifier": "FROM_FOUNDATION",
  "sourceCommit": "ffb2fd231e08db43843816afb9cccb1e532375e0",
  "xmlHashes": ["EDGE_SHA256", "FULFILLMENT_SHA256", "MENU_SHA256", "DEVICE_ACCESS_SHA256"]
}
```

## 023 -> 024, только проверка

```powershell
& (Join-Path $Operator 'update-runtime-stage2-1024.ps1') -SourceCommit 'ffb2fd231e08db43843816afb9cccb1e532375e0' -RuntimeArchive (Join-Path $Root 'runtime-ffb2fd23.zip') -RuntimeSha256 '50edc6e1e81b32dd476f3502db0ba85dfd70f2fd708c392fd95532a5f3bf7220' -BackupManifest $Backup023 -CiProof (Join-Path $Root 'ci\ci-ffb2fd23.json') -BranchId $Branch -BaselineReceipt $Baseline023 -BaselineSha256 $Baseline023Sha -BackupDestination $BackupDestination -AllowSameDiskBackup
```

Оператор при реальном применении сам устанавливает/обновляет инструмент копий и ждёт
результат, затем выполняет защищённый переход. После применения проверить его completed,
готовность служб и новую копию 024, затем составить следующий baseline:

```powershell
$Backup024 = New-RestoredBackup 24
$Baseline024 = New-Baseline 24 $Backup024
$Baseline024Sha = (Get-FileHash $Baseline024 -Algorithm SHA256).Hash.ToLowerInvariant()
```

## 024 -> 025, только проверка

После команды владельца «справка сейчас» получить единственный свежий cloud-receipt-*.json
и его .sha256. Нельзя использовать preparation-baseline.json вместо справки.

```powershell
$receipts = @(Get-ChildItem -LiteralPath $Root -Filter 'cloud-receipt-*.json' -File)
if ($receipts.Count -ne 1) { throw 'Select the one newly delivered receipt explicitly' }
$CloudReceipt = $receipts[0].FullName
$CloudSha = (Get-FileHash $CloudReceipt -Algorithm SHA256).Hash.ToLowerInvariant()
$declared = ((Get-Content ($CloudReceipt+'.sha256') -Raw).Trim() -split '\s+')[0]
if ($CloudSha -cne $declared) { throw 'Cloud receipt hash mismatch' }
& (Join-Path $Operator 'update-runtime-queue-recovery-025.ps1') -SourceCommit '25387997ce5ea1d964b6532d765d7d70ccf78da8' -RuntimeArchive (Join-Path $Root 'runtime-25387997.zip') -RuntimeSha256 '77023bee7f67868acc4e56fa0256766be0de136d80163165761b86ce8a2bd41c' -BackupManifest $Backup024 -CiProof (Join-Path $Root 'ci\ci-25387997.json') -BranchId $Branch -BaselineReceipt $Baseline024 -BaselineSha256 $Baseline024Sha -BackupDestination $BackupDestination -PredecessorCommit 'ffb2fd231e08db43843816afb9cccb1e532375e0' -CloudSourceCommit '7e3120438461cbe561b01a587578060ff2cd9d3b' -CloudReleaseReceipt $CloudReceipt -CloudReceiptSha256 $CloudSha -CloudCiProof (Join-Path $Root 'ci\ci-7e312043.json') -AllowSameDiskBackup
```

## Инструменты 026, 027, 028: пути и inspect

После успешной 025, внутри шага 3 runbook перехода: остановлены все писатели, выполнены
копии нужных схем, получены необходимые отдельные решения. Код инструмента берётся из
проверенного RC-архива, а не из установленного старого рантайма 025.

```powershell
$App = Join-Path $Root 'rc-edge'
if (Test-Path -LiteralPath $App) { throw 'Existing extraction - inspect, do not overwrite' }
if ((Get-FileHash (Join-Path $Root 'runtime-dec8b48c.zip')).Hash.ToLowerInvariant() -cne 'b21da475e72aea41d9d2e3fe3e441b75c2fa0c32307c382f942cd681afd7d8cb') { throw 'RC archive mismatch' }
Expand-Archive -LiteralPath (Join-Path $Root 'runtime-dec8b48c.zip') -DestinationPath $App
$rcManifest = Get-Content (Join-Path $App 'runtime-manifest.json') -Raw | ConvertFrom-Json
if ($rcManifest.sourceCommit -cne 'dec8b48cd899fe015baee17a3853affbe7eee774') { throw 'RC source mismatch' }
foreach ($f in $rcManifest.files) {
  if ((Get-FileHash (Join-Path $App $f.path)).Hash.ToLowerInvariant() -cne $f.sha256) { throw 'RC extracted file mismatch' }
}

# Только перед 026, на схеме025:
& $Node ('--env-file='+$OwnerEnv) (Join-Path $App 'infra\windows\pos-sales-upgrade-db.mjs') inspect $Tools $App $Branch
if ($LASTEXITCODE -ne 0) { throw '026 inspection failed' }

# Только после реальной026 и копии026:
& $Node ('--env-file='+$OwnerEnv) (Join-Path $App 'infra\windows\kds-upgrade-db.mjs') inspect $Tools $App $Branch
if ($LASTEXITCODE -ne 0) { throw '027 inspection failed' }

# Только после реальной027 и копии027:
& $Node ('--env-file='+$OwnerEnv) (Join-Path $App 'infra\windows\pos-sales-upgrade-db.mjs') inspect-028 $Tools $App $Branch
if ($LASTEXITCODE -ne 0) { throw '028 inspection failed' }
```

Inspect не применяет SQL миграций, но может брать транзакционные блокировки: выполнять
внутри окна, не на работающей смене для фоновой диагностики. Команды не включают флаги.

## Рантайм после 028, только проверка

Схема уже 028, писатели всё ещё остановлены, новая зашифрованная копия schema028 успешно
прошла штатной задачей менее двух часов назад. POS-sync не установлен. Службы Postgres
и fulfillment-туннеля работают. Сохранены original-0..3.xml и completed.json ступени025.

```powershell
& (Join-Path $Operator 'install-edge-backup.ps1') -Mode Inspect
& (Join-Path $Operator 'update-runtime-head-028.ps1') -SourceCommit 'dec8b48cd899fe015baee17a3853affbe7eee774' -RuntimeArchive (Join-Path $Root 'runtime-dec8b48c.zip') -RuntimeSha256 'b21da475e72aea41d9d2e3fe3e441b75c2fa0c32307c382f942cd681afd7d8cb' -CiProof (Join-Path $Root 'ci\ci-dec8b48c.json') -BranchId $Branch -PredecessorCommit '25387997ce5ea1d964b6532d765d7d70ccf78da8' -AllowSameDiskBackup
```

Этот оператор не применяет 026-028. Любой отказ означает остановку и разбор сохранённых
данных. Не снимать проверки, не менять закрепления и не удалять каталог попытки ради повтора.
