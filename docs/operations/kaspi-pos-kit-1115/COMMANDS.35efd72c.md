# Команды установки edge029 и POS 0.5.4

- Source: 35efd72ce470789466dd265814d0bcdf49182431
- Predecessor: <sha рантайма 028>
- Branch: 7a6f6d98-395d-4462-b5e4-b0364a4a8ec1

Набор подготовлен после полного success Foundation43761973367 (11/11) и Windows43761995773 (3/3) точного source. Оба подтверждения включены в ci/. Перед установкой сверить внешний архив и весь SHA256SUMS.txt. Установку на кассе выполняет Claude по поручению владельца; подготовка набора сама ничего не устанавливает. Ниже нет публикации cloud/feed, автоматического DB restore или регистрации терминала вместе с runtime apply.

Перед первым блоком Claude читает sourceCommit из C:\ProgramData\PickChick\EdgeTools\runtime-head-028-*\completed.json и подставляет полный SHA вместо <sha рантайма 028> только в исполняемый блок PowerShell или его рабочую копию вне каталога набора. Доставленные COMMANDS.md, packages.json и SHA256SUMS.txt не редактировать: они защищены контрольными суммами. Поле predecessorCommit этого файла не подходит: оно относится к более старому рантайму. Не выбирать первый файл автоматически при нескольких каталогах.

Работать в одной elevated x64 Windows PowerShell5.1 сессии, по одному блоку. При любой ошибке STOP: не выполнять следующий блок, не повторять apply, не удалять attempt-каталоги. Сохранять receipts локально, без вывода env/ключей/credential в чат.

## 1. Набор и предварительные проверки

Проверить SHA внешнего kit-архива по доверенному сообщению выпускающего оператора; затем суммы всех файлов по SHA256SUMS.txt. Распакованный kit хранить в приватном NTFS-каталоге EdgeTools (Administrators/SYSTEM/оператор). Перейти в корень kit.

```text
runtime-35efd72c.zip
ci/foundation.json
ci/windows-pos.json
pos/PickChick-POS-Setup-0.5.4-x64.exe
operators/infra/windows/
reference/docs/operations/stage2-windows-1030/head-runtime-029.md
packages.json
SHA256SUMS.txt
```

В operators/infra/windows должны лежать рядом 10 обязательных exact-source файлов:
update-runtime-head-029.ps1, install-native-foundation.ps1, update-native-service.ps1,
update-native-unified-menu.ps1, install-edge-backup.ps1, native-edge-backup-ledger.json,
edge-backup-lib.mjs, edge-backup-restore.mjs, edge-backup-setup.mjs, edge-backup-task.mjs.

Дополнительные backup-native-service.mjs и native-foundation-db.mjs допустимы для отдельного isolated restore drill. Этот runbook их не вызывает и не требует нового restore proof вместо штатной scheduled-backup health.

В обоих CI JSON нужны полный GitHub run и полный jobs response: {run: ..., jobs: {total_count: ..., jobs: [...]}}. Проверить exact source, workflow/repository, completed/success и все jobs; Windows artifact и POS0.5.4 должны относиться к этому SHA. Успех только guards job не заменяет Windows3/3.

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$SourceCommit = '35efd72ce470789466dd265814d0bcdf49182431'
$PredecessorCommit = '<sha рантайма 028>'
if ($PredecessorCommit -cnotmatch '^[a-f0-9]{40}$') { throw 'predecessor.fill_from_completed_json' }
$BranchId = [guid]'7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'
$Kit = (Get-Location).Path
$seen=@{}
foreach ($line in (Get-Content -LiteralPath (Join-Path $Kit 'SHA256SUMS.txt'))) {
    if ($line -cnotmatch '^([a-f0-9]{64})  (.+)$') { throw 'kit.checksum_line' }
    $expected=$Matches[1]; $relative=$Matches[2]
    if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[/\\])\.\.([/\\]|$)' -or $seen.ContainsKey($relative)) { throw 'kit.path' }
    $seen[$relative]=$true
    $path=Join-Path $Kit $relative
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) { throw 'kit.file_hash' }
}
$Ops = Join-Path $Kit 'operators\infra\windows'
$RuntimeArchive = Join-Path $Kit 'runtime-35efd72c.zip'
$RuntimeSha256 = '6c407a9deb6ff9480d2b7bd94480f5708d51cfb6907019767e628673533719a3'
$CiProof = Join-Path $Kit 'ci\foundation.json'
$WindowsProof = Join-Path $Kit 'ci\windows-pos.json'
$NodeExe = 'C:\Program Files\PickChick\Edge\edge-0186902\node\node.exe'
$EdgeTools = 'C:\ProgramData\PickChick\EdgeTools'
$ToolsRoot = Join-Path $EdgeTools 'edge-0186902'
$OwnerEnv = Join-Path $ToolsRoot 'private\edge-owner.env'
$Stage = Join-Path $EdgeTools 'k029-35efd72'
$FinalRoot = 'C:\Program Files\PickChick\Edge\edge-35efd72'
$Attempt = Join-Path $EdgeTools 'runtime-head-029-35efd72'
$PreviousProof = Join-Path $EdgeTools ('runtime-head-028-'+$PredecessorCommit.Substring(0,7))
$LeasePath = Join-Path $EdgeTools 'unified-menu-maintenance.lock'
$BackupConfig = 'C:\ProgramData\PickChick\EdgeBackup\private\edge-backup.json'
$BackupInstaller = Join-Path $Ops 'install-edge-backup.ps1'
$RuntimeOperator = Join-Path $Ops 'update-runtime-head-029.ps1'
$TaskPath = '\PickChick\'
$TaskName = 'PickChickEdgeBackup'
if ($RuntimeSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'runtime.hash_not_filled' }
if ((Get-FileHash -LiteralPath $RuntimeArchive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $RuntimeSha256) {
    throw 'runtime.archive_hash'
}
if ((Test-Path $Stage) -or (Test-Path $FinalRoot) -or (Test-Path $Attempt)) {
    throw 'runtime.existing_stage_or_attempt'
}
```

## 2. Загрузить только проверенные функции, проверить CI и proof028

Функции импортируются через AST, основной код трёх старых установщиков НЕ запускается. Их SHA взяты из operator029, не из локального пересчёта непроверенных файлов.

```powershell
$script:OperatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function Read-CheckedFunctions([string]$Path,[string]$Hash,[string[]]$Names) {
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash) {
        throw 'helper.pin'
    }
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw 'helper.parse' }
    foreach ($name in $Names) {
        $found=@($ast.FindAll({param($n)
            $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name
        },$false))
        if ($found.Count -ne 1) { throw 'helper.function' }
        $found[0].Extent.Text
    }
}
foreach ($definition in (Read-CheckedFunctions (Join-Path $Ops 'install-native-foundation.ps1') '6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5' @('Assert-LocalNtfsPath','Assert-ArchiveName','New-ProtectedDirectory','Assert-ProtectedDirectory'))) {
    . ([scriptblock]::Create($definition))
}
foreach ($definition in (Read-CheckedFunctions (Join-Path $Ops 'update-native-service.ps1') '96c2b48c103d8ae74b055468c791ae048c0edb13f2093e0b26c8df2d94acdcea' @('Assert-UpdateAcl'))) {
    . ([scriptblock]::Create($definition))
}
foreach ($definition in (Read-CheckedFunctions (Join-Path $Ops 'update-native-unified-menu.ps1') 'b764a8733224f951ad1543d9d1b18bf7ac269b1e034a1fbadbefbba488f903ef' @('Assert-UnifiedCi','Enter-UnifiedMaintenanceLock'))) {
    . ([scriptblock]::Create($definition))
}
Assert-UpdateAcl $Kit
Assert-UpdateAcl $EdgeTools '' -Protected
foreach ($path in @($CiProof,$WindowsProof,$OwnerEnv,$BackupConfig)) { Assert-UpdateAcl $path }
$ci=Get-Content -LiteralPath $CiProof -Raw | ConvertFrom-Json
Assert-UnifiedCi $ci $SourceCommit
if ([string]$ci.run.id -cne '43761973367') { throw 'ci.foundation_run' }
$win=Get-Content -LiteralPath $WindowsProof -Raw | ConvertFrom-Json
$names=@('Native release guards on Windows PowerShell 5.1',
    'Package installed Windows x64 POS','Installed POS updates itself from a feed')
if ([string]$win.run.id -cne '43761995773' -or $win.run.head_sha -cne $SourceCommit -or
    $win.run.status -cne 'completed' -or $win.run.conclusion -cne 'success' -or
    $win.run.head_repository.full_name -cne 'xaaknazar/pickchick' -or
    $win.run.path -cne '.github/workflows/windows-pos.yml' -or
    $win.jobs.total_count -ne 3 -or @($win.jobs.jobs).Count -ne 3) { throw 'ci.windows_run' }
foreach ($name in $names) {
    $job=@($win.jobs.jobs | Where-Object {$_.name -ceq $name})
    if ($job.Count -ne 1 -or $job[0].head_sha -cne $SourceCommit -or
        $job[0].status -cne 'completed' -or $job[0].conclusion -cne 'success') { throw 'ci.windows_job' }
}
Assert-ProtectedDirectory $PreviousProof
Assert-UpdateAcl (Join-Path $PreviousProof 'completed.json')
$prior=Get-Content -LiteralPath (Join-Path $PreviousProof 'completed.json') -Raw | ConvertFrom-Json
if ($prior.sourceCommit -cne $PredecessorCommit -or $prior.schema -ne 28 -or
    $prior.databasePreserved -isnot [bool] -or $prior.databasePreserved -ne $true -or
    $prior.environmentChanged -isnot [bool] -or $prior.environmentChanged -ne $false) {
    throw 'predecessor.completed'
}
foreach ($i in 0..3) { Assert-UpdateAcl (Join-Path $PreviousProof ('original-'+$i+'.xml')) }
if (Get-Service PickChickPosSync -ErrorAction SilentlyContinue) { throw 'preflight.pos_sync_installed' }
```

Полная проверка установленного 028 выполняется ниже перед остановкой служб и повторно под блокировкой перед DB apply. Штатный operator029 пока не запускать: он требует уже schema029 и backup029.

## 3. Распаковать только в приватный staging

```powershell
New-ProtectedDirectory $Stage
Expand-Archive -LiteralPath $RuntimeArchive -DestinationPath $Stage
$manifest=Get-Content -LiteralPath (Join-Path $Stage 'runtime-manifest.json') -Raw | ConvertFrom-Json
if ($manifest.sourceCommit -cne $SourceCommit -or $manifest.format -cne 'pickchick-edge-runtime-v1' -or
    $manifest.target -cne 'windows-x64' -or $manifest.symlinks -ne 0 -or $manifest.nativeAddons -ne 0) {
    throw 'staging.provenance'
}
function Check-Stage {
    foreach ($file in $manifest.files) {
        if ((Get-FileHash -LiteralPath (Join-Path $Stage $file.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256) {
            throw 'staging.file_hash'
        }
    }
}
Check-Stage
$MigrationTool=Join-Path $Stage 'infra\windows\kaspi-pos-upgrade-db.mjs'
$TerminalTool=Join-Path $Stage 'scripts\kaspi-terminal-setup.mjs'

$script:node=$NodeExe
foreach ($definition in (Read-CheckedFunctions $RuntimeOperator 'c088562ee3c548d0d9f891932d06aa43087ad8b5657193ecc643f358efd5db08' @('Get-TextSha256','New-RuntimeBinding','Get-HeadBinding'))) {
    . ([scriptblock]::Create($definition))
}
$OldApp=Join-Path 'C:\Program Files\PickChick\Edge' ('edge-'+$PredecessorCommit.Substring(0,7)+'\app')
$NewApp=Join-Path $FinalRoot 'app'
$specs=@(
    @('PickChickEdge','Edge\edge-0186902\PickChickEdge.xml'),
    @('PickChickFulfillmentWorker','FulfillmentWorker\PickChickFulfillmentWorker.xml'),
    @('PickChickMenuSyncWorker','MenuSyncWorker\PickChickMenuSyncWorker.xml'),
    @('PickChickDeviceAccessWorker','DeviceAccess\PickChickDeviceAccessWorker.xml')
)
function Check-Installed028 {
    Assert-UpdateAcl (Join-Path $PreviousProof 'completed.json')
    $receipt=Get-Content -LiteralPath (Join-Path $PreviousProof 'completed.json') -Raw | ConvertFrom-Json
    if ($receipt.sourceCommit -cne $PredecessorCommit -or $receipt.schema -ne 28 -or
        $receipt.databasePreserved -isnot [bool] -or $receipt.databasePreserved -ne $true -or
        $receipt.environmentChanged -isnot [bool] -or $receipt.environmentChanged -ne $false) { throw 'predecessor.receipt_changed' }
    $old=Get-Content -LiteralPath (Join-Path $OldApp 'runtime-manifest.json') -Raw | ConvertFrom-Json
    if ($old.sourceCommit -cne $PredecessorCommit) { throw 'predecessor.runtime_source' }
    $installed=@{}
    foreach ($file in $old.files) {
        $null=Assert-ArchiveName $file.path
        if ($installed.ContainsKey($file.path)) { throw 'predecessor.duplicate_file' }
        if ((Get-FileHash -LiteralPath (Join-Path $OldApp $file.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256) { throw 'predecessor.runtime_drift' }
        $installed[$file.path]=$file.sha256
    }
    $migrations=@($manifest.files | Where-Object {$_.path -like 'db/edge/migrations/*.sql'} | Sort-Object path)
    if ($migrations.Count -ne 29) { throw 'candidate.migration_count' }
    for ($i=0;$i -lt 28;$i++) {
        $f=$migrations[$i]
        if (!$installed.ContainsKey($f.path) -or $installed[$f.path] -cne $f.sha256) { throw 'predecessor.migration_drift' }
    }
    for ($i=0;$i -lt $specs.Count;$i++) {
        $name=$specs[$i][0]
        $current=Join-Path 'C:\Program Files\PickChick' $specs[$i][1]
        $original=Join-Path $PreviousProof ('original-'+$i+'.xml')
        Assert-UpdateAcl $current 'ReadAndExecute'; Assert-UpdateAcl $original
        $null=Get-HeadBinding ([IO.File]::ReadAllText($current)) ([IO.File]::ReadAllText($original)) $name $OldApp $NewApp
        $service=Get-CimInstance Win32_Service -Filter "Name='$name'"
        if ($service.StartName -ine 'NT AUTHORITY\LocalService' -or $service.PathName.Trim('"') -cne [IO.Path]::ChangeExtension($current,'.exe')) { throw 'predecessor.service_identity' }
    }
}
Check-Installed028

```

ZIP уже проверен по доверенному SHA, assembler проверяет безопасные пути, полный manifest и dependency closure. FinalRoot НЕ создавать: его создаст runtime-оператор. При частичной распаковке остановиться, не переиспользовать Stage автоматически. Staging нужен также для owner terminal CLI, с его node_modules и относительными импортами.

## 4. Настройки backup и остановка фоновой копии

```powershell
$saved=Get-Content -LiteralPath $BackupConfig -Raw | ConvertFrom-Json
if ($saved.reportInHeartbeat -isnot [bool] -or $saved.branchId -cne $BranchId.ToString() -or
    $saved.toolsRoot -ine $ToolsRoot -or $saved.maintenanceLock -ine $LeasePath -or
    $saved.destination -ine 'E:\PickChickBackups') { throw 'backup.baseline' }
$backupArgs=@{
    Mode='Install'; BranchId=$BranchId; Destination=$saved.destination
    HourlyCopies=$saved.retention.hourly; DailyCopies=$saved.retention.daily
    MaxAgeMinutes=$saved.maxAgeMinutes; ReportInHeartbeat=$saved.reportInHeartbeat
    AllowSameDisk=$true
}
function Backup-Settings($config) {
    [ordered]@{
        format=$config.format; branchId=$config.branchId; systemIdentifier=$config.systemIdentifier
        stateRoot=$config.stateRoot; toolsRoot=$config.toolsRoot; pgBin=$config.pgBin
        maintenanceLock=$config.maintenanceLock; destination=$config.destination
        hourly=$config.retention.hourly; daily=$config.retention.daily; timeZone=$config.timeZone
        maxAgeMinutes=$config.maxAgeMinutes; reportInHeartbeat=$config.reportInHeartbeat
    } | ConvertTo-Json -Compress
}
$savedSettings=Backup-Settings $saved
$privateHashes=@{}
foreach ($name in @('backup-key.json','backup-db.json')) {
    $path=Join-Path (Split-Path -Parent $BackupConfig) $name
    Assert-UpdateAcl $path
    $privateHashes[$path]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
}
function Check-BackupPreserved {
    $current=Get-Content -LiteralPath $BackupConfig -Raw | ConvertFrom-Json
    if ((Backup-Settings $current) -cne $savedSettings) { throw 'backup.settings_changed' }
    foreach ($path in $privateHashes.Keys) {
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $privateHashes[$path]) {
            throw 'backup.key_or_credential_changed'
        }
    }
}
$TaskWasEnabled=[bool](Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName).Settings.Enabled
function Pause-Backup {
    Disable-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName | Out-Null
    $deadline=[DateTime]::UtcNow.AddMinutes(20)
    do {
        $task=Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
        if ($task.State -notin @('Running','Queued')) { break }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'backup.quiescence_timeout' }
        Start-Sleep -Seconds 2
    } while ($true)
    if ($task.Settings.Enabled) { throw 'backup.schedule_enabled' }
    # Disable не завершает dump. Открытый handle backup также не позволит взять этот lease.
    $probe=Enter-UnifiedMaintenanceLock $LeasePath
    $probe.Dispose()
}
function Check-FreshBackup($proof,[string]$schema,[DateTime]$since) {
    if ($proof.lastTaskResult -ne 0 -or $null -eq $proof.health -or
        $proof.health.state -cne 'ok' -or $proof.health.stale -ne $false -or
        $proof.health.schema -cne $schema -or $null -eq $proof.health.lastSuccessAt) {
        throw 'backup.health'
    }
    $finished=if ($proof.health.lastSuccessAt -is [DateTime]) { $proof.health.lastSuccessAt.ToUniversalTime() } elseif ($proof.health.lastSuccessAt -is [DateTimeOffset]) { $proof.health.lastSuccessAt.UtcDateTime } else { [DateTimeOffset]::Parse([string]$proof.health.lastSuccessAt,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime }
    $now=[DateTime]::UtcNow
    if ($finished -lt $since -or $finished -gt $now -or ($now-$finished).TotalHours -gt 2) {
        throw 'backup.freshness'
    }
}
function Make-FreshBackup([string]$schema) {
    Check-BackupPreserved
    Pause-Backup
    $since=[DateTime]::UtcNow
    # Никакой внешний lease здесь не удерживается: Install запускает backup task.
    try { $result=(& $BackupInstaller @backupArgs) | ConvertFrom-Json }
    finally { Disable-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName | Out-Null }
    Pause-Backup
    Check-BackupPreserved
    Check-FreshBackup $result $schema $since
    $fresh=(& $BackupInstaller -Mode Inspect) | ConvertFrom-Json
    Check-FreshBackup $fresh $schema $since
    return $fresh
}
$backup028=Make-FreshBackup 'schema028'
```

Оба Install используют прежние retention/maxAge/report flag и согласованный AllowSameDisk. Ключ и пароль не меняются. JSON/хеши private credential остаются в памяти, не выводить их. Install может вернуть JSON с failed health без исключения: продолжение разрешено только после Check-FreshBackup. Если задача не завершилась за20мин, STOP без Stop-ScheduledTask и без удаления run.lock. Disable после Install нужен снова, поскольку Install регистрирует/запускает задачу.

## 5. DB029: остановленные writers, общий maintenance lease

```powershell
$writers=@('PickChickFulfillmentWorker','PickChickMenuSyncWorker',
    'PickChickDeviceAccessWorker','PickChickKitchenLink','PickChickEdge')
$kitchen=Get-Service PickChickKitchenLAN -ErrorAction SilentlyContinue
$KitchenLanWasRunning=$null -ne $kitchen -and $kitchen.Status -eq 'Running'
if ($kitchen -and $kitchen.Status -notin @('Running','Stopped')) { throw 'services.kitchen_state' }
foreach ($name in $writers) {
    if ((Get-Service $name).Status -ne 'Running') { throw 'services.unexpected_baseline' }
}
if ($KitchenLanWasRunning) {
    Stop-Service PickChickKitchenLAN
    (Get-Service PickChickKitchenLAN).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(35))
}
foreach ($name in $writers) {
    if (@((Get-Service $name).DependentServices | Where-Object {$_.Status -ne 'Stopped'}).Count) {
        throw 'services.active_dependency'
    }
    Stop-Service $name
    (Get-Service $name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(35))
}
function Check-WritersStopped {
    foreach ($name in $writers) {
        $service=Get-Service $name
        if ($service.Status -ne 'Stopped' -or @($service.DependentServices | Where-Object {$_.Status -ne 'Stopped'}).Count) {
            throw 'services.writer_active'
        }
    }
    if ($kitchen -and (Get-Service PickChickKitchenLAN).Status -ne 'Stopped') { throw 'services.kitchen_active' }
    if (Get-Service PickChickPosSync -ErrorAction SilentlyContinue) { throw 'services.pos_sync_installed' }
    foreach ($name in @('PickChickPostgres','PickChickFulfillmentTunnel')) {
        if ((Get-Service $name).Status -ne 'Running') { throw 'services.infrastructure' }
    }
}
function Invoke-Migration([string]$mode) {
    $raw=& $NodeExe ('--env-file='+$OwnerEnv) $MigrationTool $mode $ToolsRoot $Stage $BranchId.ToString()
    if ($LASTEXITCODE -ne 0) { throw ('db.'+$mode+'.exit') }
    $result=($raw -join [Environment]::NewLine) | ConvertFrom-Json
    if ($result.mode -cne $mode -or $result.migration -cne '029_edge_kaspi_pos.sql' -or
        $result.dataPreserved -ne $true -or $result.runtimeRolePresent -ne $true -or
        $result.linkedTerminals -ne 0 -or $result.alreadyInstalled -ne $false -or
        $result.applied -ne ($mode -ceq 'apply') -or
        $result.migrations -ne $(if ($mode -ceq 'apply') {29} else {28})) { throw ('db.'+$mode+'.proof') }
}
Pause-Backup
$lease=$null
try {
    $lease=Enter-UnifiedMaintenanceLock $LeasePath
    Check-WritersStopped
    Check-Stage
    Check-Installed028
    $health028=(& $BackupInstaller -Mode Inspect) | ConvertFrom-Json
    Check-FreshBackup $health028 'schema028' ([DateTime]::UtcNow.AddHours(-2))
    Invoke-Migration 'inspect'
    Check-WritersStopped
    Invoke-Migration 'apply'
} finally {
    if ($lease) { $lease.Dispose() }
}
```

Используется существующий файл EdgeTools\unified-menu-maintenance.lock и штатная функция с FileShare.None, совместимая с runtime и backup read-handle. Не заменять lease marker-файлом, не удалять его. DB inspect выполняет DDL/grants с ROLLBACK и ACCESS EXCLUSIVE locks; это не проверка работающей кассы. DB-helper сам не проверяет CI/backup-age/файловый lease - эти условия обеспечены порядком выше. finally освобождает только handle, не запускает службы и не восстанавливает DB.

## 6. Backup029 -> runtime verify/apply -> завершение окна

```powershell
Check-WritersStopped
$backup029=Make-FreshBackup 'schema029'
Check-WritersStopped
$runtimeArgs=@{
    SourceCommit=$SourceCommit; RuntimeArchive=$RuntimeArchive; RuntimeSha256=$RuntimeSha256
    CiProof=$CiProof; BranchId=$BranchId; PredecessorCommit=$PredecessorCommit
    AllowSameDiskBackup=$true
}
# DB lease освобождён: runtime-оператор сам берёт его при Apply.
& $RuntimeOperator @runtimeArgs
# Только после VERIFIED без исключений:
& $RuntimeOperator @runtimeArgs -Apply
# Только после READY без исключений:
$completed=Get-Content -LiteralPath (Join-Path $Attempt 'completed.json') -Raw | ConvertFrom-Json
if ($completed.sourceCommit -cne $SourceCommit -or $completed.predecessorCommit -cne $PredecessorCommit -or
    $completed.schema -ne 29 -or $completed.databasePreserved -ne $true -or
    $completed.environmentChanged -ne $false) { throw 'runtime.completed' }
Check-BackupPreserved
if ($KitchenLanWasRunning) {
    Start-Service PickChickKitchenLAN
    (Get-Service PickChickKitchenLAN).WaitForStatus('Running',[TimeSpan]::FromSeconds(35))
}
# По шагу 6 runbook после успешного окна включить расписание копий.
Enable-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName | Out-Null
```

Edge, KitchenLink и три workers запускает сам оператор. PostgreSQL/tunnel не останавливаются. Полный оператор повторно проверяет старые bytes, точные XML028, CI, 29 migrations, cluster/branch, backup029<=2h, ACL, соседние службы и итоговые процессы.

При отказе не выполнять нижние строки вручную. До первого старта возможен возврат своих XML с оставленными stopped writers; после первого старта старые binaries автоматически не возвращаются. Живой DB restore - отдельное решение по restore-runbook, не catch/finally этой процедуры.

## 7. POS0.5.4 и отдельная привязка терминала

POS Setup находится в pos\PickChick-POS-Setup-0.5.4-x64.exe. Его штатная установка под пользователем кассы с сохранением config.json - отдельное действие после READY; не запускать install-pos-client.ps1 ради обновления уже настроенной кассы (это LAN-конфигуратор). Никаких изменений feed в этой инструкции.

Следующие команды - отдельная физическая приёмка по ADR0017 на согласованной владельцем кассе. «Только интеграция» не включать. Терминал и сервер в одной LAN; у терминала постоянный/reserved IP. TerminalId - UUID кассы из её config.json, не branchId/serial Kaspi. Не добавлять register в основной apply-блок.

```powershell
Check-Stage
& $NodeExe ('--env-file='+$OwnerEnv) $TerminalTool status
if ($LASTEXITCODE -ne 0) { throw 'terminal.status' }
$TerminalId=Read-Host 'UUID кассы из config.json'
$TerminalIp=Read-Host 'Постоянный private IPv4 терминала'
& $NodeExe ('--env-file='+$OwnerEnv) $TerminalTool probe --host $TerminalIp
if ($LASTEXITCODE -ne 0) { throw 'terminal.probe' }
```

Сверить выведенный SHA256 сертификата на терминале/с доверенной локальной карточкой, не автоматически доверять результату probe. На терминале открыть «Защита интеграции -> Настроить доступ». При уже существующей привязке остановиться, не unlink/re-register автоматически.

```powershell
$CertificateSha256=Read-Host 'Сверенный SHA256 сертификата терминала'
# После запуска register физически нажать «Разрешить» на терминале в течение окна регистрации.
& $NodeExe ('--env-file='+$OwnerEnv) $TerminalTool register --terminal $TerminalId --host $TerminalIp --certificate-sha256 $CertificateSha256
if ($LASTEXITCODE -ne 0) { throw 'terminal.register' }
& $NodeExe ('--env-file='+$OwnerEnv) $TerminalTool status
if ($LASTEXITCODE -ne 0) { throw 'terminal.status_after_register' }
```

Токены helper хранит в DB и не печатает. При неизвестном исходе регистрации сначала status/осмотр терминала, без слепого повтора. POS подхватывает link примерно за30с. Оплата100₸, отмена и обрыв связи выполняются владельцем как отдельные реальные проверки; не считать их пройденными по CI.

## Пределы проверки

Runbook и помощники взяты из точного 35efd72. Foundation43761973367 завершился success (11/11), Windows43761995773 - success (3/3). В Windows CI прошли семь тестов test_windows_head_029_runtime_release.py, включая KaspiHeadRuntimeGuards.test_ledger_pins_match_the_kaspi_tool. PowerShell-блоки этого документа прошли локальный Parser.ParseInput без исполнения установочных команд; функция проверки свежести копии проверена на синтетических данных. Это проверка синтаксиса документа, не приёмка этих блоков на Windows5.1. Исходный оператор проверен CI с подменой SCM и SQL. Фактическая установка на кассе и физический терминал в эту проверку не входят.

Новых требований isolated restore к runbook029 этот документ не добавляет. Зашифрованная копия с проверенным health не является свидетельством полного тестового восстановления.
