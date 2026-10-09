#Requires -Version 5.1
<# Windows menu-sync worker (unified menu, WP-D). Runbook: native-menu-sync.md.
Inspect  read-only database checks (backup proof, ledger, branch, fulfillment device binding).
Prepare  guarded database phase: edge migration 018 when pending, dedicated login role
         pickchick_menu_sync with a generated password in a protected env file, exact grants.
Install  registers PickChickMenuSyncWorker (LocalService, depends on PostgreSQL and the
         fulfillment tunnel) with EDGE_MENU_SYNC_MODE=off. Mode changes are an operator edit.
Verify   re-checks files, ACLs, the env file and the service registration. Database grants
         are re-proved by Inspect (it needs a fresh backup proof like every database step).
No existing service, ordering flag, firewall rule or credential is changed. Nothing is
deleted or overwritten; partial state is retained for inspection. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Inspect','Prepare','Install','Verify')][string]$Mode,
    [Parameter(Mandatory=$true)][ValidatePattern('^edge-[a-f0-9]{7}$')][string]$ReleaseName,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit,
    [Parameter(Mandatory=$true)][guid]$BranchId,
    [Parameter(Mandatory=$true)][guid]$DeviceId,
    [string]$BackupManifest,
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$')][string]$FoundationReleaseName='edge-0186902'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Assert-NtfsPath([string]$Path) {
    if ($Path -notmatch '^[a-zA-Z]:\\' -or $Path.Substring(2).Contains(':')) { throw 'Absolute local NTFS path required.' }
    $full=[IO.Path]::GetFullPath($Path)
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($full))
    if (-not $drive.IsReady -or $drive.DriveFormat -ne 'NTFS' -or $drive.DriveType -ne 'Fixed') { throw 'Fixed NTFS storage required.' }
    $cursor=$full
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Reparse paths are forbidden.' }
        $parent=[IO.Directory]::GetParent($cursor)
        $cursor=if ($null -eq $parent) {$null} else {$parent.FullName}
    }
}
function Assert-Acl([string]$Path,[switch]$ServiceRead,[switch]$ServiceModify,[switch]$Foundation,[switch]$InheritedAllowed) {
    Assert-NtfsPath $Path
    $acl=Get-Acl -LiteralPath $Path
    if (-not $InheritedAllowed -and -not $acl.AreAccessRulesProtected) { throw 'Protected ACL required.' }
    $trusted=@('S-1-5-18','S-1-5-32-544')
    if ($Foundation) { $trusted+= $script:operatorSid.Value }
    $owners=$trusted
    if ($ServiceRead -or $ServiceModify) { $owners+= 'S-1-5-19' }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $owners) { throw 'Unexpected filesystem owner.' }
    [long]$effective=0
    foreach ($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($ace.AccessControlType -ne 'Allow') { throw 'Unexpected ACL entry.' }
        if ($ace.IdentityReference.Value -in $trusted) { continue }
        $rights=if ($ServiceModify) {[Security.AccessControl.FileSystemRights]::Modify} else {[Security.AccessControl.FileSystemRights]::ReadAndExecute}
        $limit=$rights -bor [Security.AccessControl.FileSystemRights]::Synchronize
        if (($ServiceRead -or $ServiceModify) -and $ace.IdentityReference.Value -eq 'S-1-5-19' -and ($ace.FileSystemRights -band (-bnot $limit)) -eq 0) {
            if (($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) {$effective=$effective -bor [long]$ace.FileSystemRights}
            continue
        }
        throw 'Filesystem permissions exceed reviewed principals.'
    }
    if ($ServiceRead -or $ServiceModify) {
        $required=if ($ServiceModify) {[long][Security.AccessControl.FileSystemRights]::Modify} else {[long][Security.AccessControl.FileSystemRights]::ReadAndExecute}
        if (($effective -band $required) -ne $required) {throw 'Required LocalService access is missing.'}
    }
}
function Set-ProtectedAcl([string]$Path,[switch]$Directory,[switch]$ServiceRead,[switch]$ServiceModify) {
    Assert-NtfsPath $Path
    $acl=if ($Directory) {[Security.AccessControl.DirectorySecurity]::new()} else {[Security.AccessControl.FileSecurity]::new()}
    $acl.SetAccessRuleProtection($true,$false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    $grants=@{'S-1-5-18'='FullControl';'S-1-5-32-544'='FullControl'}
    if ($ServiceRead) {$grants['S-1-5-19']='ReadAndExecute'}
    if ($ServiceModify) {$grants['S-1-5-19']='Modify'}
    foreach ($sid in $grants.Keys) {
        $inherit=if ($Directory) {'ContainerInherit,ObjectInherit'} else {'None'}
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),$grants[$sid],$inherit,'None','Allow'))
    }
    if ($Directory -and -not (Test-Path -LiteralPath $Path)) { [IO.Directory]::CreateDirectory($Path,$acl) | Out-Null }
    else { Set-Acl -LiteralPath $Path -AclObject $acl }
    Assert-Acl $Path -ServiceRead:$ServiceRead -ServiceModify:$ServiceModify
}
function Write-NewText([string]$Path,[string]$Text,[switch]$ServiceRead) {
    Assert-NtfsPath $Path
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Text)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
    Set-ProtectedAcl $Path -ServiceRead:$ServiceRead
}
function Ensure-Text([string]$Path,[string]$Text,[switch]$ServiceRead) {
    if (Test-Path -LiteralPath $Path) {
        Assert-Acl $Path -ServiceRead:$ServiceRead
        if ([IO.File]::ReadAllText($Path) -cne $Text) {throw 'Existing setup file differs; it was not overwritten.'}
    } else {Write-NewText $Path $Text -ServiceRead:$ServiceRead}
}
function Quote-WindowsArgument([string]$Value) {
    if ($Value.Contains([char]0) -or $Value.Contains("`n") -or $Value.Contains("`r")) {throw 'Unsafe process argument.'}
    $escaped=[regex]::Replace($Value,'(\\*)"','$1$1\"')
    $escaped=[regex]::Replace($escaped,'(\\+)$','$1$1')
    return '"'+$escaped+'"'
}
function Run-Tool([string]$Exe,[string[]]$Arguments,[int]$TimeoutSeconds=180) {
    $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$Exe
    $start.Arguments=($Arguments | ForEach-Object {Quote-WindowsArgument $_}) -join ' '
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $start.WorkingDirectory=$script:runtimeRoot
    $start.EnvironmentVariables.Clear()
    foreach ($key in @('SystemRoot','WINDIR','ComSpec','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','ProgramData','SystemDrive')) {
        $value=[Environment]::GetEnvironmentVariable($key);if ($value) {$start.EnvironmentVariables[$key]=$value}
    }
    $start.EnvironmentVariables['PATH']=([IO.Path]::GetDirectoryName($script:nodeExe),(Join-Path $env:SystemRoot 'System32')) -join ';'
    $process=[Diagnostics.Process]::new();$process.StartInfo=$start
    try {
        if (-not $process.Start()) {throw 'Operator subprocess could not start.'}
        $output=$process.StandardOutput.ReadToEndAsync();$errors=$process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds*1000)) {$process.Kill();throw 'Operator subprocess timed out; state retained.'}
        $result=$output.GetAwaiter().GetResult();$null=$errors.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {throw ('Operator subprocess failed: '+[IO.Path]::GetFileName($Exe)+'. State retained; no secret diagnostic was printed.')}
        return $result.Trim()
    } finally {$process.Dispose()}
}
function Read-Json([string]$Path,[int]$Limit=16384) {
    Assert-NtfsPath $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-Item -LiteralPath $Path).Length -gt $Limit) {throw 'Missing or oversized operator file.'}
    try {return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)} catch {throw 'Operator JSON could not be decoded; no private content was printed.'}
}
function Hash-File([string]$Path) {Assert-NtfsPath $Path;return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Build-ServiceXml([string]$Id,[string]$Executable,[string[]]$Arguments,[string[]]$Depends) {
    $xmlEscape={param($value) [Security.SecurityElement]::Escape($value)}
    $argsText=($Arguments | ForEach-Object {Quote-WindowsArgument $_}) -join ' '
    $dependencies=($Depends | ForEach-Object {'<depend>'+(& $xmlEscape $_)+'</depend>'}) -join ''
    return @"
<service><id>$Id</id><name>$Id</name><description>PickChick menu publication worker (back-office menu to cashier)</description>
<executable>$(& $xmlEscape $Executable)</executable><arguments>$(& $xmlEscape $argsText)</arguments>
<workingdirectory>$(& $xmlEscape $script:runtimeRoot)</workingdirectory>
<serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
<startmode>Automatic</startmode><delayedAutoStart>true</delayedAutoStart>$dependencies
<env name="NODE_OPTIONS" value=""/><env name="NODE_PATH" value=""/>
<stoptimeout>30 sec</stoptimeout><onfailure action="restart" delay="5 sec"/><onfailure action="restart" delay="15 sec"/><onfailure action="restart" delay="60 sec"/>
<resetfailure>1 hour</resetfailure><logpath>$(& $xmlEscape $script:logRoot)</logpath>
<log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log></service>
"@
}
function Assert-WorkerService([string]$Name,[string]$Image,[string[]]$Depends) {
    $service=Get-CimInstance Win32_Service -Filter "Name='$Name'"
    if ($null -eq $service -or $service.PathName -cne (Quote-WindowsArgument $Image) -or $service.StartName -ine 'NT AUTHORITY\LocalService' -or $service.StartMode -ne 'Auto') {throw 'Existing menu sync service differs.'}
    $registry=Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\'+$Name)
    if ($registry.DelayedAutoStart -ne 1) {throw 'Menu sync service must use delayed automatic startup.'}
    $actualDepends=@((Get-Service $Name).ServicesDependedOn | ForEach-Object {$_.Name} | Sort-Object)
    if (($actualDepends -join ',') -cne (($Depends | Sort-Object) -join ',')) {throw 'Menu sync SCM dependencies differ.'}
    return $service
}
function Assert-Identity([string]$Path,[string]$Branch,[string]$Device) {
    Assert-Acl $Path -ServiceRead
    $value=Read-Json $Path 4096
    if (($value.PSObject.Properties.Name | Sort-Object) -join ',' -cne 'branch_id,device_id,expires_at,token' -or $value.branch_id -cne $Branch -or $value.device_id -cne $Device -or $value.token -cnotmatch '^[a-f0-9]{64}$' -or [DateTimeOffset]::Parse($value.expires_at).UtcDateTime -le [DateTime]::UtcNow) {throw 'Fulfillment device identity is expired or differs from the explicit scope.'}
}
function Assert-Backup([string]$Path,$Foundation,[string]$Branch) {
    if (-not $Path) {throw 'A fresh backup-manifest.json from backup-native-service.mjs is required.'}
    Assert-Acl $Path -Foundation -InheritedAllowed
    $record=Read-Json $Path 1048576
    if ($record.format -cne 'pickchick-native-service-backup-v1' -or $record.branchId -cne $Branch -or $record.systemIdentifier -cne $Foundation.systemIdentifier -or $record.backupVerified -ne $true -or $record.restoreVerified -ne $true -or $record.rehearsalDropped -ne $true -or $record.completed -ne $true -or $record.sha256 -cnotmatch '^[a-f0-9]{64}$') {throw 'Matching completed backup and restore proof required.'}
    $dump=Join-Path ([IO.Path]::GetDirectoryName($Path)) 'pickchick_edge.dump'
    if ((Hash-File $dump) -cne $record.sha256) {throw 'Backup archive differs from its manifest.'}
}
function Database-Step([string]$Operation) {
    $arguments=@((Join-Path $script:runtimeRoot 'infra\windows\menu-sync-upgrade-db.mjs'),$Operation,$script:foundationRoot,$script:runtimeRoot,$script:branch,$script:device,$BackupManifest,$script:envPath)
    return (Run-Tool $script:nodeExe $arguments | ConvertFrom-Json)
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -ne 'Desktop') {throw 'Use elevated x64 Windows PowerShell 5.1.'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$script:operatorSid=$identity.User
if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'Administrator session required.'}
$script:branch=$BranchId.ToString();$script:device=$DeviceId.ToString()
$serviceId='PickChickMenuSyncWorker'
$depends=@('PickChickPostgres','PickChickFulfillmentTunnel')
$root=Join-Path $env:ProgramData 'PickChick\MenuSync'
$serviceRoot=Join-Path $root 'service';$script:logRoot=Join-Path $root 'logs'
$script:envPath=Join-Path $serviceRoot 'menu-sync.env'
$binRoot=Join-Path $env:ProgramFiles 'PickChick\MenuSyncWorker'
$script:runtimeRoot=Join-Path $env:ProgramFiles ('PickChick\Edge\'+$ReleaseName+'\app')
$script:foundationRoot=Join-Path $env:ProgramData ('PickChick\EdgeTools\'+$FoundationReleaseName)
$foundationPrivate=Join-Path $foundationRoot 'private'
$script:nodeExe=Join-Path $env:ProgramFiles ('PickChick\Edge\'+$FoundationReleaseName+'\node\node.exe')
$wrapperSource=Join-Path $env:ProgramFiles ('PickChick\Edge\'+$FoundationReleaseName+'\PickChickEdge.exe')
# The menu worker authenticates as the same device as the fulfillment worker.
$identityPath=Join-Path $env:ProgramData 'PickChick\FulfillmentWorker\device-identity.json'
$fulfillmentXml=Join-Path $env:ProgramFiles 'PickChick\FulfillmentWorker\PickChickFulfillmentWorker.xml'
foreach ($path in @($root,$serviceRoot,$logRoot,$binRoot,$runtimeRoot,$foundationPrivate,$nodeExe,$wrapperSource,$identityPath,$fulfillmentXml)) {Assert-NtfsPath $path}
Assert-Acl (Join-Path $env:ProgramData 'PickChick') -Foundation
Assert-Acl (Join-Path $env:ProgramFiles 'PickChick') -Foundation
Assert-Acl ([IO.Path]::GetDirectoryName($nodeExe)) -Foundation -ServiceRead
Assert-Acl $nodeExe -Foundation -ServiceRead -InheritedAllowed
Assert-Acl $wrapperSource -Foundation -ServiceRead -InheritedAllowed
Assert-Acl $foundationPrivate -Foundation
Assert-Acl $runtimeRoot -Foundation -ServiceRead
$foundation=Read-Json (Join-Path $foundationPrivate 'foundation-state.json')
$stage=Read-Json (Join-Path $foundationRoot 'foundation-stage1.json')
if ($foundation.format -cne 'pickchick-native-state-v1' -or -not $foundation.complete -or $foundation.branchId -cne $branch -or $foundation.releaseName -cne $FoundationReleaseName -or $foundation.computerName -ine $env:COMPUTERNAME -or $stage.branchId -cne $branch -or $foundation.systemIdentifier -cnotmatch '^\d{10,20}$') {throw 'Completed native foundation binding required.'}
if ((Hash-File $wrapperSource) -cne $stage.winSwSha256) {throw 'Pinned WinSW differs.'}
$manifest=Read-Json (Join-Path $runtimeRoot 'runtime-manifest.json') 8388608
if ($manifest.format -cne 'pickchick-edge-runtime-v1' -or $manifest.sourceCommit -cne $SourceCommit) {throw 'Immutable runtime source differs.'}
foreach ($relative in @('infra/windows/native-menu-sync-worker.mjs','infra/windows/menu-sync-worker-grants.mjs','infra/windows/menu-sync-upgrade-db.mjs','infra/windows/native-pos-sync-worker.mjs','infra/windows/native-pos-sync-permissions.ps1','db/edge/migrations/018_edge_menu_publication.sql')) {
    if (@($manifest.files | Where-Object {$_.path -ceq $relative}).Count -ne 1) {throw 'Required menu sync file is not pinned in the runtime manifest.'}
}
if (@($manifest.dependencies | Where-Object {$_.name -ceq '@pickchick/menu-sync'}).Count -ne 1) {throw 'Runtime must include the menu-sync package and its dependency closure.'}
# Verify every shipped file before any privileged helper is executed.
foreach ($file in $manifest.files) {
    if ($file.path -match '(^|/)\.\.?(/|$)|[:\\]' -or [IO.Path]::IsPathRooted($file.path)) {throw 'Unsafe manifest path.'}
    $path=Join-Path $runtimeRoot $file.path
    Assert-Acl $path -Foundation -ServiceRead -InheritedAllowed
    if ((Hash-File $path) -cne $file.sha256) {throw 'Runtime artifact hash differs.'}
}
# Same device as the running fulfillment worker: identity file and service arguments.
Assert-Identity $identityPath $branch $device
Assert-Acl $fulfillmentXml -Foundation -ServiceRead -InheritedAllowed
[xml]$fulfillmentDocument=[IO.File]::ReadAllText($fulfillmentXml)
if (-not ([string]$fulfillmentDocument.service.arguments).EndsWith('"'+$identityPath+'" '+$branch+' '+$device,[StringComparison]::Ordinal)) {throw 'Fulfillment worker binding differs from the explicit device.'}
foreach ($name in $depends) {if ((Get-Service $name -ErrorAction SilentlyContinue).Status -ne 'Running') {throw 'Required PostgreSQL or fulfillment tunnel service is not running.'}}

if ($Mode -in @('Inspect','Prepare')) {
    Assert-Backup $BackupManifest $foundation $branch
    if ($Mode -eq 'Inspect') {Database-Step 'inspect' | ConvertTo-Json -Compress;return}
    $existing=Get-Service $serviceId -ErrorAction SilentlyContinue
    if ($existing -and $existing.Status -ne 'Stopped') {throw 'Stop PickChickMenuSyncWorker before the database phase.'}
    foreach ($entry in @(@($root,'read'),@($serviceRoot,'read'),@($logRoot,'modify'))) {
        if (Test-Path -LiteralPath $entry[0]) {Assert-Acl $entry[0] -ServiceRead:($entry[1] -eq 'read') -ServiceModify:($entry[1] -eq 'modify')}
        else {Set-ProtectedAcl $entry[0] -Directory -ServiceRead:($entry[1] -eq 'read') -ServiceModify:($entry[1] -eq 'modify')}
    }
    # The helper writes menu-sync.env once (never overwrites) inside the protected directory.
    $result=Database-Step 'apply'
    Set-ProtectedAcl $envPath -ServiceRead
    if (-not $result.grantsVerified -or -not $result.loginVerified -or -not $result.existingDataPreserved) {throw 'Database phase did not verify; inspect protected state.'}
    [pscustomobject]@{phase='prepared';migrations=$result.migrations;migrationApplied=$result.migrationApplied;roleCreated=$result.roleCreated;envFile=$result.envFile;serviceInstalled=$false} | ConvertTo-Json
    return
}

foreach ($path in @($root,$serviceRoot,$envPath)) {Assert-Acl $path -ServiceRead}
Assert-Acl $logRoot -ServiceModify
$envText=[IO.File]::ReadAllText($envPath)
$expectedEnv="(?m)\AAPP_ENV=local`nEDGE_BRANCH_ID=$branch`nEDGE_DEVICE_ID=$device`nEDGE_MENU_SYNC_CLOUD_ORIGIN=http://127\.0\.0\.1:43100`nEDGE_MENU_SYNC_MODE=(off|report|apply)`nEDGE_DATABASE_URL=postgresql://pickchick_menu_sync:[a-f0-9]{64}@127\.0\.0\.1:55433/pickchick_edge`n\z"
if ($envText -cnotmatch $expectedEnv) {throw 'Menu sync environment differs from the generated file.'}
$arguments=@(('--env-file='+$envPath),(Join-Path $runtimeRoot 'infra\windows\native-menu-sync-worker.mjs'),$identityPath,$branch,$device)
$xml=Build-ServiceXml $serviceId $nodeExe $arguments $depends
$image=Join-Path $binRoot ($serviceId+'.exe');$xmlPath=Join-Path $binRoot ($serviceId+'.xml')
if ($Mode -eq 'Install') {
    if (Test-Path -LiteralPath $binRoot) {Assert-Acl $binRoot -ServiceRead} else {Set-ProtectedAcl $binRoot -Directory -ServiceRead}
    if (-not (Test-Path -LiteralPath $image)) {[IO.File]::Copy($wrapperSource,$image,$false);Set-ProtectedAcl $image -ServiceRead}
    Ensure-Text $xmlPath $xml -ServiceRead
}
Assert-Acl $binRoot -ServiceRead;Assert-Acl $image -ServiceRead;Assert-Acl $xmlPath -ServiceRead
if ((Hash-File $image) -cne $stage.winSwSha256 -or [IO.File]::ReadAllText($xmlPath) -cne $xml) {throw 'Menu sync wrapper or service XML differs.'}
if (-not (Get-Service $serviceId -ErrorAction SilentlyContinue)) {
    if ($Mode -ne 'Install') {throw 'Menu sync service is missing.'}
    $null=Run-Tool $image @('install')
}
$installed=Assert-WorkerService $serviceId $image $depends
if ($Mode -eq 'Install' -and $installed.State -ne 'Running') {Start-Service $serviceId}
(Get-Service $serviceId).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
$null=Assert-WorkerService $serviceId $image $depends
$workerMode=([regex]::Match($envText,'(?m)^EDGE_MENU_SYNC_MODE=(off|report|apply)$')).Groups[1].Value
[pscustomobject]@{phase='running';service=$serviceId;mode=$workerMode;databaseRole='pickchick_menu_sync';cloudDeliveryVerified=$false;note='Service checks do not prove cloud delivery. Follow native-menu-sync.md: report mode, edge_menu_state on the VPS, parity, then apply.'} | ConvertTo-Json
