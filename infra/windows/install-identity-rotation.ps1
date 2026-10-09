#Requires -Version 5.1
#Requires -RunAsAdministrator
<# Hourly SYSTEM scheduled task that renews the cashier device identity before it expires
   (docs/operations/edge-identity-rotation.md). It reuses the release, node.exe and identity file
   of the installed PickChickFulfillmentWorker; the LocalService workers stay read-only.
   Inspect (default) changes nothing. Install writes a protected env file and (re)registers the
   task; EDGE_IDENTITY_AUTO_ROTATE stays false unless -AutoRotate is given. Re-run Install after
   every fulfillment worker release update. Uninstall removes the task and keeps logs. #>
[CmdletBinding()]
param(
    [ValidateSet('Inspect','Install','Uninstall')][string]$Mode = 'Inspect',
    [guid]$BranchId,
    [guid]$DeviceId,
    [switch]$AutoRotate,
    [switch]$IncludePosSync
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$taskPath = '\PickChick\'
$taskName = 'PickChickIdentityRotation'
$program = Join-Path $env:ProgramFiles 'PickChick'
$data = Join-Path $env:ProgramData 'PickChick'
$workerXmlPath = Join-Path $program 'FulfillmentWorker\PickChickFulfillmentWorker.xml'
$identityPath = Join-Path $data 'FulfillmentWorker\device-identity.json'
$posSyncIdentity = Join-Path $data 'PosSync\service\device-identity.json'
$root = Join-Path $data 'IdentityRotation'
$logRoot = Join-Path $root 'logs'
$envPath = Join-Path $root 'rotation.env'
$logPath = Join-Path $logRoot 'rotation.log'

function Hash-File([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Quote([string]$Value) {
    if ($Value -match '["\r\n]') { throw 'Unsupported argument.' }
    '"' + $Value + '"'
}
function New-AdminOnlyAcl([switch]$Directory) {
    $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    $inherit = if ($Directory) { 'ContainerInherit,ObjectInherit' } else { 'None' }
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', $inherit, 'None', 'Allow'))
    }
    $acl
}
function Assert-AdminOnly([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'Rotation storage must be protected and administrator-owned.' }
    foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($ace.AccessControlType -ne 'Allow' -or $ace.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'Rotation storage is readable by non-administrators.' }
    }
}
function Read-WorkerBinding {
    [xml]$document = [IO.File]::ReadAllText($workerXmlPath)
    $node = [string]$document.service.executable
    $app = [string]$document.service.workingdirectory
    $arguments = [string]$document.service.arguments
    if ($node -notmatch '^[a-zA-Z]:\\.+\\node\.exe$' -or $app -notmatch '^[a-zA-Z]:\\.+\\Edge\\edge-[a-f0-9]{7}\\app$') { throw 'Unexpected fulfillment worker binding.' }
    $match = [regex]::Match($arguments, '"' + [regex]::Escape($identityPath) + '" ([0-9a-f-]{36}) ([0-9a-f-]{36})$')
    if (-not $match.Success) { throw 'Fulfillment worker does not use the protected identity file.' }
    [pscustomobject]@{ node = $node; app = $app; branchId = $match.Groups[1].Value; deviceId = $match.Groups[2].Value }
}
function Assert-RuntimeFiles($Binding) {
    $manifestPath = Join-Path $Binding.app 'runtime-manifest.json'
    $manifest = if (Test-Path -LiteralPath $manifestPath) { [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json } else { $null }
    foreach ($relative in @('infra/windows/native-identity-rotation.mjs', 'infra/windows/native-identity-acl.ps1', 'infra/windows/native-pos-sync-permissions.ps1')) {
        $path = Join-Path $Binding.app ($relative.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'The worker release does not contain identity rotation; update the worker release first.' }
        if ($manifest) {
            $entry = @($manifest.files | Where-Object { $_.path -ceq $relative })
            if ($entry.Count -ne 1 -or $entry[0].sha256 -cne (Hash-File $path)) { throw 'Runtime file differs from the release manifest.' }
        }
    }
}
function Read-IdentityStatus([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $value = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
    $expires = [DateTimeOffset]::Parse($value.expires_at).UtcDateTime
    [pscustomobject]@{ expiresAt = $expires.ToString('o'); daysRemaining = [math]::Floor(($expires - [DateTime]::UtcNow).TotalDays * 100) / 100 }
}

$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
if ($Mode -eq 'Uninstall') {
    if ($task) { Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false }
    [pscustomobject]@{ mode = 'uninstall'; removed = [bool]$task; logsKept = $logRoot } | ConvertTo-Json
    return
}
$binding = Read-WorkerBinding
if ($Mode -eq 'Inspect') {
    $lastLog = if (Test-Path -LiteralPath $logPath) { @(Get-Content -LiteralPath $logPath -Tail 1) } else { @() }
    [pscustomobject]@{
        mode = 'inspect'; changed = $false
        workerApp = $binding.app; taskInstalled = [bool]$task
        taskAction = if ($task) { [string]$task.Actions[0].Arguments } else { '' }
        autoRotate = if (Test-Path -LiteralPath $envPath) { [bool](Select-String -LiteralPath $envPath -Pattern '^EDGE_IDENTITY_AUTO_ROTATE=true$' -Quiet) } else { $false }
        identity = Read-IdentityStatus $identityPath
        posSyncIdentity = Read-IdentityStatus $posSyncIdentity
        lastLog = if ($lastLog.Count) { $lastLog[0] } else { '' }
    } | ConvertTo-Json -Depth 4
    return
}
if ($BranchId -eq [guid]::Empty -or $DeviceId -eq [guid]::Empty) { throw 'Install requires -BranchId and -DeviceId.' }
if ($binding.branchId -cne $BranchId.ToString() -or $binding.deviceId -cne $DeviceId.ToString()) { throw 'Fulfillment worker scope differs from the explicit device.' }
Assert-RuntimeFiles $binding
foreach ($path in @($root, $logRoot)) {
    if (Test-Path -LiteralPath $path) { Assert-AdminOnly $path }
    else { [IO.Directory]::CreateDirectory($path, (New-AdminOnlyAcl -Directory)) | Out-Null; Assert-AdminOnly $path }
}
$flag = if ($AutoRotate) { 'true' } else { 'false' }
$envText = "EDGE_IDENTITY_AUTO_ROTATE=$flag`nEDGE_IDENTITY_ROTATION_ORIGIN=http://127.0.0.1:43100`n"
$temporary = Join-Path $root ('rotation.env.' + [guid]::NewGuid().ToString() + '.tmp')
[IO.File]::WriteAllText($temporary, $envText, [Text.UTF8Encoding]::new($false))
Set-Acl -LiteralPath $temporary -AclObject (New-AdminOnlyAcl)
Move-Item -LiteralPath $temporary -Destination $envPath -Force
Assert-AdminOnly $envPath
$arguments = @(
    ('--env-file=' + (Quote $envPath)),
    (Quote (Join-Path $binding.app 'infra\windows\native-identity-rotation.mjs')),
    (Quote $identityPath), $BranchId.ToString(), $DeviceId.ToString()
)
if ($IncludePosSync) {
    if (-not (Test-Path -LiteralPath $posSyncIdentity -PathType Leaf)) { throw 'PosSync identity copy is not installed.' }
    $arguments += @('--mirror', (Quote $posSyncIdentity))
}
$arguments += @('--log', (Quote $logPath))
$action = New-ScheduledTaskAction -Execute $binding.node -Argument ($arguments -join ' ') -WorkingDirectory $binding.app
$hourly = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.Date.AddMinutes(17)) -RepetitionInterval (New-TimeSpan -Hours 1)
$startup = New-ScheduledTaskTrigger -AtStartup
$startup.Delay = 'PT5M'
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Trigger @($hourly, $startup) -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName
$deadline = [DateTime]::UtcNow.AddSeconds(90)
do { Start-Sleep -Seconds 2; $info = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName } while ((Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName).State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
$lastLog = if (Test-Path -LiteralPath $logPath) { @(Get-Content -LiteralPath $logPath -Tail 1) } else { @() }
[pscustomobject]@{
    mode = 'install'; autoRotate = [bool]$AutoRotate; workerApp = $binding.app
    lastTaskResult = $info.LastTaskResult; lastLog = if ($lastLog.Count) { $lastLog[0] } else { '' }
    identity = Read-IdentityStatus $identityPath
} | ConvertTo-Json -Depth 4
