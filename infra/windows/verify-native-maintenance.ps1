#Requires -Version 5.1
<# Audit existing native service identities/ACLs and set PostgreSQL crash recovery.
No database writes, ACL changes, process termination, service restart or reboot. #>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$')][string]$ReleaseName)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-FailureActions([byte[]]$Bytes, [int]$NonCrashFlag) {
    if ($null -eq $Bytes -or $Bytes.Length -lt 20 -or $NonCrashFlag -ne 1) { throw 'Incomplete SCM recovery configuration.' }
    $count = [BitConverter]::ToUInt32($Bytes, 12)
    $offset = [BitConverter]::ToUInt32($Bytes, 16)
    if ([BitConverter]::ToUInt32($Bytes, 0) -ne 3600 -or $count -ne 3 -or $offset -lt 20 -or [long]$offset + 24 -gt $Bytes.Length) { throw 'SCM recovery header differs.' }
    $delays = @(5000, 15000, 60000)
    for ($index = 0; $index -lt 3; $index++) {
        if ([BitConverter]::ToUInt32($Bytes, $offset + 8 * $index) -ne 1 -or [BitConverter]::ToUInt32($Bytes, $offset + 8 * $index + 4) -ne $delays[$index]) { throw 'SCM recovery actions differ.' }
    }
}

function Assert-ExactService([string]$Name, [string]$Image, [string]$Account) {
    $service = Get-CimInstance Win32_Service -Filter "Name='$Name'"
    if (-not $service -or $service.PathName -ne $Image -or $service.StartName -ne $Account -or $service.StartMode -ne 'Auto' -or $service.State -ne 'Running') { throw "Expected running automatic service identity/path differs: $Name" }
}

function Assert-ServiceTree([string]$Root, [string]$ServiceSid, [string]$Rights) {
    $full = [IO.Path]::GetFullPath($Root)
    if ($full -notmatch '^[A-Za-z]:\\' -or $full.Substring(2).Contains(':')) { throw 'Only local NTFS paths are allowed.' }
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($full))
    if (-not $drive.IsReady -or $drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') { throw 'Fixed NTFS storage is required.' }
    $cursor = $full
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse ancestors are not accepted.' }
        $parent = [IO.Directory]::GetParent($cursor); $cursor = if ($parent) { $parent.FullName } else { $null }
    }
    $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($full)
    $required = [long][Security.AccessControl.FileSystemRights]$Rights
    $trusted = @($script:operatorSid, 'S-1-5-18', 'S-1-5-32-544', $ServiceSid)
    [long]$checked = 0
    while ($pending.Count) {
        $path = $pending.Pop(); $item = Get-Item -LiteralPath $path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse descendants are not accepted.' }
        $acl = Get-Acl -LiteralPath $path
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Unexpected owner in PostgreSQL tree.' }
        [long]$effective = 0
        foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($ace.AccessControlType -ne 'Allow' -or $ace.IdentityReference.Value -notin $trusted) { throw 'Unexpected access rule in PostgreSQL tree.' }
            if ($ace.IdentityReference.Value -eq $ServiceSid -and ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) { $effective = $effective -bor [long]$ace.FileSystemRights }
        }
        if (($effective -band $required) -ne $required) { throw "PostgreSQL service lacks required $Rights rights: $path" }
        $checked++
        if ($item.PSIsContainer) { foreach ($child in Get-ChildItem -LiteralPath $path -Force) { $pending.Push($child.FullName) } }
        if (($checked % 500) -eq 0) { Write-Progress -Activity 'Auditing PostgreSQL service permissions' -Status "$checked paths checked" }
    }
    Write-Progress -Activity 'Auditing PostgreSQL service permissions' -Completed
    return $checked
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use elevated x64 Windows PowerShell 5.1.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$script:operatorSid = $identity.User.Value
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'An elevated administrator shell is required.' }
$program = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PickChick'
$data = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PickChick'
$pgRoot = Join-Path $program 'Postgres\18.6-3'
$pgData = Join-Path $data 'Postgres\18\data'
$pgCtl = Join-Path $pgRoot 'bin\pg_ctl.exe'
$edgeWrapper = Join-Path $program "Edge\$ReleaseName\PickChickEdge.exe"
$pgImage = '"' + $pgCtl + '" runservice -N "PickChickPostgres" -D "' + $pgData + '" -w -t 30'
$edgeImage = '"' + $edgeWrapper + '"'
Assert-ExactService 'PickChickPostgres' $pgImage 'NT SERVICE\PickChickPostgres'
Assert-ExactService 'PickChickEdge' $edgeImage 'NT AUTHORITY\LocalService'
$serviceSid = ([Security.Principal.NTAccount]::new('NT SERVICE\PickChickPostgres')).Translate([Security.Principal.SecurityIdentifier]).Value
$dataCount = Assert-ServiceTree $pgData $serviceSid 'Modify'
$binaryCount = Assert-ServiceTree $pgRoot $serviceSid 'ReadAndExecute'
$sc = Join-Path $env:SystemRoot 'System32\sc.exe'
# Bounded restart delays. Windows repeats the final 60-second action for further
# failures until the one-hour successful reset interval clears the failure count.
$null = & $sc failure PickChickPostgres reset= 3600 actions= restart/5000/restart/15000/restart/60000
if ($LASTEXITCODE -ne 0) { throw 'Setting PostgreSQL failure actions failed.' }
$null = & $sc failureflag PickChickPostgres 1
if ($LASTEXITCODE -ne 0) { throw 'Setting PostgreSQL non-crash failure recovery failed.' }
$registry = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\PickChickPostgres'
Assert-FailureActions $registry.FailureActions $registry.FailureActionsOnNonCrashFailures
Assert-ExactService 'PickChickPostgres' $pgImage 'NT SERVICE\PickChickPostgres'
Assert-ExactService 'PickChickEdge' $edgeImage 'NT AUTHORITY\LocalService'
[pscustomobject][ordered]@{
    stage = 'native_maintenance_verified'; recordedAt = [DateTime]::UtcNow.ToString('o'); releaseName = $ReleaseName
    postgresDataPathsChecked = $dataCount; postgresBinaryPathsChecked = $binaryCount
    postgresRecoveryDelaysMs = @(5000, 15000, 60000); resetSeconds = 3600; nonCrashFailureRecovery = $true
    aclChanged = $false; databaseChanged = $false; serviceRestarted = $false; crashTested = $false; rebootTested = $false
} | ConvertTo-Json -Depth 3
