#Requires -Version 5.1
<# Read-only prerequisite report. Installs no Windows capability, creates no key,
service or firewall rule, and never reads foundation passwords. #>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) { throw 'Use x64 Windows PowerShell.' }
$sshRoot = Join-Path $env:SystemRoot 'System32\OpenSSH'
$capability = 'unavailable'
try { $capability = [string](Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0').State } catch { }
$files = @()
foreach ($name in @('ssh.exe', 'ssh-keygen.exe')) {
    $path = Join-Path $sshRoot $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $files += [pscustomobject]@{ name=$name; present=$false; signature='absent'; sha256=$null; version=$null }
        continue
    }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'OpenSSH executable is a reparse path.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    $files += [pscustomobject]@{ name=$name; present=$true; signature=[string]$signature.Status; sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant(); version=$item.VersionInfo.FileVersion }
}
$occupied = @(Get-NetTCPConnection -LocalPort 43100 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ address=$_.LocalAddress; processId=$_.OwningProcess } })
$services = @()
foreach ($name in @('PickChickPostgres','PickChickEdge','PickChickSyncTunnel','PickChickPosSync')) {
    $value = Get-CimInstance Win32_Service -Filter "Name='$name'"
    $services += [pscustomobject]@{ name=$name; exists=($null -ne $value); state=$(if ($value) {$value.State} else {'absent'}); account=$(if ($value) {$value.StartName} else {$null}) }
}
[pscustomobject]@{
    format='pickchick-native-ssh-inspection-v1'; windowsVersion=[Environment]::OSVersion.Version.ToString(); powershell=$PSVersionTable.PSVersion.ToString();
    capability=$capability; files=$files; localForwardPort=43100; listeners=$occupied; services=$services;
    modifiedWindows=$false; keysGenerated=$false; connectionAttempted=$false
} | ConvertTo-Json -Depth 5
