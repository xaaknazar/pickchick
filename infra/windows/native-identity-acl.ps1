#Requires -Version 5.1
# Applies the protected device-identity ACL to one temporary file written by
# native-identity-rotation.mjs (SYSTEM) before it is renamed over device-identity.json:
# owner Administrators, SYSTEM/Administrators full control, LocalService read only,
# no inheritance. Verifies the exact rule set native-pos-sync-permissions.ps1 enforces.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Path)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $Path -notmatch '^[a-zA-Z]:\\' -or $Path.Substring(2).Contains(':')) { throw 'Invalid identity path.' }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -cne $Path) { throw 'Normalized identity path required.' }
    if ([IO.Path]::GetFileName($full) -cnotmatch '^device-identity\.json(\.(next|previous|rotation))?\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$') { throw 'Unexpected temporary identity file.' }
    $cursor = $full
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse paths are forbidden.' }
        $parent = [IO.Directory]::GetParent($cursor)
        $cursor = if ($null -eq $parent) { $null } else { $parent.FullName }
    }
    $file = Get-Item -LiteralPath $full -Force
    if ($file.PSIsContainer -or $file.Length -gt 4096) { throw 'Unexpected identity file.' }
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($grant in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-19', 'ReadAndExecute'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($grant[0]), [Security.AccessControl.FileSystemRights]$grant[1], 'None', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $full -AclObject $acl
    $check = Get-Acl -LiteralPath $full
    if (-not $check.AreAccessRulesProtected) { throw 'Protected identity ACL required.' }
    if ($check.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'Unexpected identity owner.' }
    $limit = [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize
    foreach ($ace in $check.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($ace.AccessControlType -ne 'Allow' -or $ace.IsInherited) { throw 'Unexpected identity ACL.' }
        if ($ace.IdentityReference.Value -in @('S-1-5-18', 'S-1-5-32-544')) { continue }
        if ($ace.IdentityReference.Value -ne 'S-1-5-19' -or ($ace.FileSystemRights -band (-bnot $limit)) -ne 0) { throw 'Identity access is too broad.' }
    }
    Write-Output 'identity_acl_applied'
} catch { Write-Error 'Protected identity ACL could not be applied.'; exit 1 }
