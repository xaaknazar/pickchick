#Requires -Version 5.1
<# Scheduled, encrypted backup of the cashier database to a second location (audit 6.4, owner
   action 16). Runbook: infra/windows/edge-backup.md; restore: docs/operations/edge-restore.md.
   Keep this script and its five pinned tool files together in one delivery folder.

   Inspect (default)  read-only: task state, last result and the backup health record (age).
   Install -DryRun    validates paths, pins, foundation, schema and role state; prints the plan.
                      Runs the pinned helper from a private temporary copy; nothing persists.
   Install            protected folders, pinned tool copy below Program Files, archive key, role
                      pickchick_edge_backup and its password file, configuration, the SYSTEM task
                      \PickChick\PickChickEdgeBackup (hourly and 10 minutes after start-up), one run.
   Uninstall [-DryRun] [-RemoveDatabaseRole -BranchId]  removes the task (and the role); the key,
                      configuration, logs and every copy are kept.
   No password or key is passed as an argument or printed. The task runs without a signed-in
   user. Re-running Install changes destination/retention; the key and password are never replaced. #>
[CmdletBinding()]
param(
    [ValidateSet('Inspect', 'Install', 'Uninstall')][string]$Mode = 'Inspect',
    [guid]$BranchId,
    [string]$Destination,
    [ValidateRange(1, 168)][int]$HourlyCopies = 48,
    [ValidateRange(1, 90)][int]$DailyCopies = 14,
    [ValidateRange(60, 4320)][int]$MaxAgeMinutes = 120,
    [switch]$ReportInHeartbeat,
    [switch]$DryRun,
    [switch]$RemoveDatabaseRole,
    [ValidatePattern('^edge-[a-f0-9]{7}$')][string]$FoundationReleaseName = 'edge-0186902',
    [ValidatePattern('^[0-9][0-9.]{0,10}-[0-9]{1,3}$')][string]$PostgresRelease = '18.6-3'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Reviewed tool bytes (tests/operations/test_windows_edge_backup.py keeps these equal to the repo).
$script:toolPins = [ordered]@{
    'edge-backup-lib.mjs'            = '51cfd1e10cffd93e88ae92a6826f4bbdd7133d3897b1daea12048554bb2a9165'
    'edge-backup-restore.mjs'        = 'dfc0c798c4190253f0fdf3d0b23347237c30efbb138e543e4c94ec5d5bafc08d'
    'edge-backup-setup.mjs'          = 'bd61834cf87cd5462d4b7f3ae9c7eff8d333fe324bccef7812301e48472bdabe'
    'edge-backup-task.mjs'           = 'c1ec995611196dc0aec8aed8f608e7e3c92caa680487c36c42ad70fb7e9c5ead'
    'native-edge-backup-ledger.json' = '6fff20890da53a34e78375bede6d9ae582becfe9824b00a8d5614c5fd5bdde6c'
}
$script:trusted = @('S-1-5-18', 'S-1-5-32-544')
$taskPath = '\PickChick\'
$taskName = 'PickChickEdgeBackup'

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-ToolId {
    $text = (@($script:toolPins.Keys) | Sort-Object | ForEach-Object { $_ + ':' + $script:toolPins[$_] }) -join "`n"
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)) } finally { $sha.Dispose() }
    [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant().Substring(0, 12)
}
function Assert-NoReparsePoint([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Reparse points are not allowed in backup paths.' }
        $parent = [IO.Directory]::GetParent($cursor)
        $cursor = if ($null -eq $parent) { $null } else { $parent.FullName }
    }
}
function New-ProtectedAcl([switch]$Directory, [switch]$ServiceRead) {
    $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    $inherit = if ($Directory) { 'ContainerInherit,ObjectInherit' } else { 'None' }
    foreach ($sid in $script:trusted) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', $inherit, 'None', 'Allow')) }
    if ($ServiceRead) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'), 'ReadAndExecute', $inherit, 'None', 'Allow')) }
    $acl
}
function Assert-ProtectedAcl([string]$Path, [switch]$ServiceRead) {
    Assert-NoReparsePoint $Path
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $script:trusted) { throw 'Backup storage must be protected and administrator-owned.' }
    $limit = [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize
    foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($ace.AccessControlType -ne 'Allow') { throw 'Unexpected deny entry on backup storage.' }
        if ($ace.IdentityReference.Value -in $script:trusted) { continue }
        if ($ServiceRead -and $ace.IdentityReference.Value -eq 'S-1-5-19' -and ($ace.FileSystemRights -band (-bnot $limit)) -eq 0) { continue }
        throw 'Backup storage is accessible to other accounts.'
    }
}
function Initialize-ProtectedDirectory([string]$Path, [switch]$ServiceRead) {
    if (Test-Path -LiteralPath $Path) { Assert-ProtectedAcl $Path -ServiceRead:$ServiceRead; return }
    [IO.Directory]::CreateDirectory($Path, (New-ProtectedAcl -Directory -ServiceRead:$ServiceRead)) | Out-Null
    Assert-ProtectedAcl $Path -ServiceRead:$ServiceRead
}
<# A local destination gets the protected ACL. An existing folder is accepted when it already
   has it, or when it is still empty (for example created by the owner); never otherwise. #>
function Initialize-Destination([string]$Path) {
    if ((Test-Path -LiteralPath $Path -PathType Container) -and -not @(Get-ChildItem -LiteralPath $Path -Force).Count) {
        Assert-NoReparsePoint $Path
        Set-Acl -LiteralPath $Path -AclObject (New-ProtectedAcl -Directory)
    }
    Initialize-ProtectedDirectory $Path
}
function Protect-File([string]$Path) {
    Set-Acl -LiteralPath $Path -AclObject (New-ProtectedAcl)
    Assert-ProtectedAcl $Path
}
function Format-ProcessArgument([string]$Value) {
    if ($Value.Contains([char]0) -or $Value.Contains("`n") -or $Value.Contains("`r")) { throw 'Unsafe process argument.' }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    '"' + $escaped + '"'
}
function Invoke-BackupNode([string]$Tools, [string[]]$Arguments, [int]$TimeoutSeconds = 300) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $script:nodeExe
    $start.Arguments = (@((Join-Path $Tools 'edge-backup-setup.mjs')) + $Arguments | ForEach-Object { Format-ProcessArgument $_ }) -join ' '
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.WorkingDirectory = $Tools
    $start.EnvironmentVariables.Clear()
    foreach ($key in @('SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'ProgramData', 'SystemDrive')) {
        $value = [Environment]::GetEnvironmentVariable($key); if ($value) { $start.EnvironmentVariables[$key] = $value }
    }
    $start.EnvironmentVariables['PATH'] = Join-Path $env:SystemRoot 'System32'
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Backup helper could not start.' }
        $output = $process.StandardOutput.ReadToEndAsync(); $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { $process.Kill(); throw 'Backup helper timed out; state retained for inspection.' }
        $text = $output.GetAwaiter().GetResult(); $null = $errors.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Backup helper refused; no secret diagnostic was printed. See infra/windows/edge-backup.md.' }
        return ($text.Trim() | ConvertFrom-Json)
    } finally { $process.Dispose() }
}
<# Copies the reviewed tool files from the delivery folder into a protected folder and checks
   every hash there, so nothing is executed from a user-writable location. #>
function Copy-VerifiedTools([string]$Target) {
    Initialize-ProtectedDirectory $Target
    foreach ($name in $script:toolPins.Keys) {
        $path = Join-Path $Target $name
        if (-not (Test-Path -LiteralPath $path)) { [IO.File]::Copy((Join-Path $PSScriptRoot $name), $path, $false); Protect-File $path }
        Assert-ProtectedAcl $path
        if ((Get-Sha256 $path) -cne $script:toolPins[$name]) { throw 'Backup tool file differs from the reviewed bytes.' }
    }
}
<# Destination: a folder on another physical disk (NTFS, fixed or removable) or a \\server\share
   folder. A share is only checked for reachability here; the SYSTEM task proves its own access. #>
function Test-BackupDestination([string]$Path, [string]$DataPath) {
    if ($Path -match '^\\\\[A-Za-z0-9][A-Za-z0-9.-]*\\[^\\]+') {
        if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw 'Destination share folder is not reachable; create it first.' }
        return 'network'
    }
    if ($Path -notmatch '^[A-Za-z]:\\[^\\]') { throw 'Destination must be a folder on a second disk or a \\server\share folder.' }
    $letter = $Path.Substring(0, 1).ToUpperInvariant(); $dataLetter = $DataPath.Substring(0, 1).ToUpperInvariant()
    if ($letter -eq $dataLetter) { throw 'Destination must be on another disk than the cashier database.' }
    $drive = [IO.DriveInfo]::new($letter + ':\')
    if (-not $drive.IsReady -or $drive.DriveFormat -ne 'NTFS' -or [string]$drive.DriveType -notin @('Fixed', 'Removable')) { throw 'Destination disk must be a ready NTFS fixed or removable disk.' }
    $disks = @(@($letter, $dataLetter) | ForEach-Object { (Get-Partition -DriveLetter $_ -ErrorAction Stop).DiskNumber })
    if ($disks[0] -eq $disks[1]) { throw 'Destination is a partition of the same physical disk as the database; use a second disk or a NAS.' }
    return 'disk'
}
function Get-BackupHealth([string]$Path, [DateTime]$NowUtc) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]@{ state = 'missing'; error = $null; lastAttemptAt = $null; lastSuccessAt = $null; ageMinutes = $null; stale = $true; schema = $null; copies = $null; keyId = $null } }
    $status = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
    $parse = { param($value) if ($null -eq $value) { $null } elseif ($value -is [DateTime]) { $value.ToUniversalTime() } else { [DateTimeOffset]::Parse([string]$value, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime } }
    $success = & $parse $status.lastSuccessAt
    $age = if ($null -eq $success) { $null } else { [math]::Floor(($NowUtc - $success).TotalMinutes) }
    [pscustomobject]@{
        state = [string]$status.state; error = $status.error
        lastAttemptAt = & $parse $status.lastAttemptAt; lastSuccessAt = $success
        ageMinutes = $age; stale = ($null -eq $age -or $age -gt [int]$status.maxAgeMinutes)
        schema = $status.schema; copies = $status.copies; keyId = $status.keyId
    }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use elevated x64 Windows PowerShell 5.1.' }
if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Elevated administrator shell required.' }
$dataRoot = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PickChick'
$programRoot = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PickChick'
$stateRoot = Join-Path $dataRoot 'EdgeBackup'
$privateRoot = Join-Path $stateRoot 'private'
$configPath = Join-Path $privateRoot 'edge-backup.json'
$statusPath = Join-Path $stateRoot 'health\status.json'
$toolsRoot = Join-Path $dataRoot ('EdgeTools\' + $FoundationReleaseName)
$script:nodeExe = Join-Path $programRoot ('Edge\' + $FoundationReleaseName + '\node\node.exe')
$pgBin = Join-Path $programRoot ('Postgres\' + $PostgresRelease + '\bin')
$toolRoot = Join-Path $programRoot ('EdgeBackup\tool-' + (Get-ToolId))
$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue

if ($Mode -eq 'Inspect') {
    $info = if ($task) { Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName } else { $null }
    $config = if (Test-Path -LiteralPath $configPath) { [IO.File]::ReadAllText($configPath) | ConvertFrom-Json } else { $null }
    [pscustomobject]@{
        mode = 'inspect'; changed = $false; taskInstalled = [bool]$task
        taskState = if ($task) { [string]$task.State } else { '' }
        taskAction = if ($task) { [string]$task.Actions[0].Arguments } else { '' }
        lastRunTime = if ($info) { $info.LastRunTime } else { $null }
        lastTaskResult = if ($info) { $info.LastTaskResult } else { $null }
        nextRunTime = if ($info) { $info.NextRunTime } else { $null }
        destination = if ($config) { $config.destination } else { $null }
        retention = if ($config) { $config.retention } else { $null }
        health = Get-BackupHealth $statusPath ([DateTime]::UtcNow)
    } | ConvertTo-Json -Depth 4
    return
}

# Removing only the task needs nothing else; Install and role removal run the pinned helper.
if ($Mode -eq 'Install' -or $RemoveDatabaseRole) {
    foreach ($path in @($script:nodeExe, (Join-Path $pgBin 'pg_dump.exe'), (Join-Path $pgBin 'pg_restore.exe'), (Join-Path $toolsRoot 'private\foundation-state.json'), (Join-Path $toolsRoot 'private\foundation-credentials.json'), (Join-Path $toolsRoot 'package.json'))) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Native foundation, Node or PostgreSQL tools are missing.' }
    }
    foreach ($name in $script:toolPins.Keys) {
        if ((Get-Sha256 (Join-Path $PSScriptRoot $name)) -cne $script:toolPins[$name]) { throw 'Delivered backup tool differs from the reviewed bytes.' }
    }
}

if ($Mode -eq 'Uninstall') {
    if ($RemoveDatabaseRole -and $BranchId -eq [guid]::Empty) { throw 'Removing the database role requires -BranchId.' }
    $kept = @('archive key and configuration (' + $privateRoot + ')', 'logs, with the health record moved into them', 'every copy at the destination')
    $running = $task -and [string]$task.State -eq 'Running'
    if ($DryRun) {
        $role = $null
        if ($RemoveDatabaseRole) {
            $temporary = Join-Path ([IO.Path]::GetTempPath()) ('pickchick-edge-backup-' + [guid]::NewGuid().ToString('N'))
            try { Copy-VerifiedTools $temporary; $role = Invoke-BackupNode $temporary @('plan-remove', $toolsRoot, $BranchId.ToString()) }
            finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force } }
        }
        [pscustomobject]@{ mode = 'uninstall'; dryRun = $true; changed = $false; removeTask = [bool]$task; taskRunning = [bool]$running; removeDatabaseRole = [bool]$RemoveDatabaseRole; roleExists = if ($role) { $role.existed } else { $null }; kept = $kept } | ConvertTo-Json -Depth 4
        return
    }
    # A copy in progress finishes and cleans its staging first; nothing is changed here until then.
    if ($running) { throw 'The backup task is running now; repeat Uninstall when Inspect shows it finished. Nothing was changed.' }
    if ($task) { Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false }
    # Without the task the record would only age: it moves into logs, so the optional heartbeat
    # stops reporting a stale copy after a deliberate removal.
    if (Test-Path -LiteralPath $statusPath -PathType Leaf) { Move-Item -LiteralPath $statusPath -Destination (Join-Path $stateRoot ('logs\status-uninstalled-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.json')) -Force }
    $role = $null
    if ($RemoveDatabaseRole) {
        Initialize-ProtectedDirectory (Join-Path $programRoot 'EdgeBackup')
        Copy-VerifiedTools $toolRoot
        $role = Invoke-BackupNode $toolRoot @('remove-role', $toolsRoot, $BranchId.ToString())
        # The password of a dropped role is useless; the key stays because copies need it.
        $credential = Join-Path $privateRoot 'backup-db.json'
        if (Test-Path -LiteralPath $credential) { Remove-Item -LiteralPath $credential -Force }
    }
    [pscustomobject]@{ mode = 'uninstall'; dryRun = $false; taskRemoved = [bool]$task; roleRemoved = if ($role) { $role.removed } else { $false }; kept = $kept } | ConvertTo-Json -Depth 4
    return
}

# Install
if ($BranchId -eq [guid]::Empty -or -not $Destination) { throw 'Install requires -BranchId and -Destination.' }
$kind = Test-BackupDestination $Destination $dataRoot
$setupArguments = @($stateRoot, $toolsRoot, $pgBin, $BranchId.ToString(), $Destination, [string]$HourlyCopies, [string]$DailyCopies, [string]$MaxAgeMinutes, ([string][bool]$ReportInHeartbeat).ToLowerInvariant())
$taskArguments = (Format-ProcessArgument (Join-Path $toolRoot 'edge-backup-task.mjs')) + ' ' + (Format-ProcessArgument $configPath)
if ($DryRun) {
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ('pickchick-edge-backup-' + [guid]::NewGuid().ToString('N'))
    try { Copy-VerifiedTools $temporary; $plan = Invoke-BackupNode $temporary (@('plan') + $setupArguments) }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force } }
    [pscustomobject]@{
        mode = 'install'; dryRun = $true; changed = $false; destinationKind = $kind; plan = $plan
        task = [pscustomobject]@{ path = $taskPath + $taskName; account = 'SYSTEM'; schedule = 'hourly at :37 and 10 minutes after start-up'; executable = $script:nodeExe; arguments = $taskArguments; replacesExisting = [bool]$task }
        folders = @($stateRoot, $toolRoot)
    } | ConvertTo-Json -Depth 5
    return
}

Initialize-ProtectedDirectory $stateRoot
foreach ($name in @('private', 'staging', 'logs')) { Initialize-ProtectedDirectory (Join-Path $stateRoot $name) }
# The fulfillment worker (LocalService) may read only the health record, for the optional heartbeat.
Initialize-ProtectedDirectory (Join-Path $stateRoot 'health') -ServiceRead
Initialize-ProtectedDirectory (Join-Path $programRoot 'EdgeBackup')
if ($kind -eq 'disk') { Initialize-Destination $Destination }
Copy-VerifiedTools $toolRoot
$result = Invoke-BackupNode $toolRoot (@('install') + $setupArguments)
foreach ($name in @('backup-key.json', 'backup-db.json', 'edge-backup.json')) { Protect-File (Join-Path $privateRoot $name) }
$action = New-ScheduledTaskAction -Execute $script:nodeExe -Argument $taskArguments -WorkingDirectory $toolRoot
$hourly = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.Date.AddMinutes(37)) -RepetitionInterval (New-TimeSpan -Hours 1)
$startup = New-ScheduledTaskTrigger -AtStartup
$startup.Delay = 'PT10M'
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 50) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Priority 7
Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Trigger @($hourly, $startup) -Principal $principal -Settings $settings -Description 'PickChick encrypted cashier database backup (infra/windows/edge-backup.md)' -Force | Out-Null
$started = [DateTime]::UtcNow
Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName
$deadline = $started.AddMinutes(20)
do {
    Start-Sleep -Seconds 3
    $health = Get-BackupHealth $statusPath ([DateTime]::UtcNow)
    $running = (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName).State -eq 'Running'
    $ran = (Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName).LastRunTime -ge $started.ToLocalTime().AddSeconds(-5)
    $recorded = $null -ne $health.lastAttemptAt -and $health.lastAttemptAt -ge $started.AddSeconds(-5)
} while (($running -or -not ($recorded -or $ran)) -and [DateTime]::UtcNow -lt $deadline)
[pscustomobject]@{
    mode = 'install'; dryRun = $false; destinationKind = $kind; setup = $result
    task = $taskPath + $taskName; lastTaskResult = (Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName).LastTaskResult
    health = $health
    next = 'Copy the archive key to the owner''s safe storage now (edge-backup.md, "Key"); without it no copy can be restored.'
} | ConvertTo-Json -Depth 5
