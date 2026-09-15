#Requires -Version 5.1
# Read-only startup check, invoked as LocalService before the identity is read.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$IdentityPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $IdentityPath -notmatch '^[a-zA-Z]:\\' -or $IdentityPath.Substring(2).Contains(':')) { throw 'Invalid identity path.' }
    $full = [IO.Path]::GetFullPath($IdentityPath)
    if ([IO.Path]::GetFileName($full) -cne 'device-identity.json') { throw 'Unexpected identity filename.' }
    $cursor = $full
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse paths are forbidden.' }
        $parent = [IO.Directory]::GetParent($cursor)
        $cursor = if ($null -eq $parent) { $null } else { $parent.FullName }
    }
    foreach ($path in @($full, [IO.Path]::GetDirectoryName($full))) {
        $acl = Get-Acl -LiteralPath $path
        if (-not $acl.AreAccessRulesProtected) { throw 'Protected identity ACL required.' }
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544','S-1-5-19')) { throw 'Unexpected identity owner.' }
        foreach ($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            if ($ace.AccessControlType -ne 'Allow') { throw 'Unexpected identity ACL.' }
            if ($ace.IdentityReference.Value -in @('S-1-5-18','S-1-5-32-544')) { continue }
            $limit = [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize
            if ($ace.IdentityReference.Value -ne 'S-1-5-19' -or ($ace.FileSystemRights -band (-bnot $limit)) -ne 0) { throw 'Identity access is too broad.' }
        }
    }
    if ((Get-Item -LiteralPath $full).Length -gt 4096) { throw 'Identity file too large.' }
    Write-Output 'identity_acl_verified'
} catch { Write-Error 'Protected Windows identity check failed.'; exit 1 }
