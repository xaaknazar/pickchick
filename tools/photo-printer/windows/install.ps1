#Requires -Version 5.1
<# Dedicated photo service. Does not stop, reconfigure or replace the POS/edge services.
Package contains source, dependencies, node.exe and a pinned WinSW.exe; no private state.
The operator supplies the existing photo metadata backup and a certificate for this host.
Default is validation only. Apply requires exact-source green CI and an empty destination. #>
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$Package,
 [Parameter(Mandatory=$true)][string]$PrivateInput,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit,
 [Parameter(Mandatory=$true)][string]$CiProof,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
 [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) {throw 'Windows x64 required'}
if(-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'Administrator required for service setup'}
$serviceName='PickChickPhotoPrinter'
$program='C:\Program Files\PickChick\PhotoPrinter'
$state='C:\ProgramData\PickChick\PhotoPrinter'
function Assert-LocalPath([string]$Path) {
 $full=[IO.Path]::GetFullPath($Path)
 if($full -notmatch '^C:\\' -or $full.Substring(3).Contains(':')) {throw 'Local C drive path required'}
 for($p=$full;$p;$p=[IO.Path]::GetDirectoryName($p)) {
  if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'Reparse paths are not allowed'}
 }
 return $full
}
function New-PrivateDirectory([string]$Path,[string]$ServiceRights='') {
 $null=Assert-LocalPath $Path
 $null=New-Item -ItemType Directory -Path $Path
 $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @('S-1-5-18','S-1-5-32-544')) {$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
 if($ServiceRights) {$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'),$ServiceRights,'ContainerInherit,ObjectInherit','None','Allow'))}
 Set-Acl -LiteralPath $Path -AclObject $acl
}
function Hash([string]$Path) {return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Write-Private([string]$Path,[string]$Value) {
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Value)
 $file=[IO.File]::Open($Path,'CreateNew','Write','None')
 try {$file.Write($bytes,0,$bytes.Length);$file.Flush($true)} finally {$file.Dispose()}
}
$Package=Assert-LocalPath $Package;$PrivateInput=Assert-LocalPath $PrivateInput
$manifestPath=Join-Path $Package 'manifest.json'
if((Hash $manifestPath) -cne $ManifestSha256) {throw 'Package manifest differs'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$ci=Get-Content -LiteralPath (Assert-LocalPath $CiProof) -Raw -Encoding UTF8 | ConvertFrom-Json
if($manifest.sourceCommit -cne $SourceCommit -or $ci.headRevision -cne $SourceCommit -or @($ci.checks).Count -lt 10 -or
 @($ci.checks | Where-Object {$_.head_sha -cne $SourceCommit -or $_.status -ne 'completed' -or $_.conclusion -ne 'success'}).Count -or
 -not @($ci.checks | Where-Object {$_.name -eq 'Build, contracts and PostgreSQL integration'}).Count) {throw 'Exact-source full green CI proof required'}
$listed=@($manifest.files.PSObject.Properties)
foreach($entry in $listed) {
 if($entry.Name -match '(^[/\\]|(^|[/\\])\.\.([/\\]|$)|:)' -or $entry.Value -notmatch '^[a-f0-9]{64}$') {throw 'Invalid package entry'}
 $p=Assert-LocalPath (Join-Path $Package $entry.Name)
 if((Hash $p) -cne $entry.Value) {throw 'Package file differs'}
}
$actual=@(Get-ChildItem -LiteralPath $Package -File -Recurse)
if($actual.Count -ne $listed.Count+1) {throw 'Unlisted package files'}
foreach($required in @('node.exe','WinSW.exe','tools/photo-printer/server.mjs','tools/photo-printer/windows/UsbPrinter.cs','tools/photo-printer/windows/install.ps1','apps/kiosk/assets/v3/logo.webp')) {
 if(-not ($listed | Where-Object {$_.Name -ceq $required})) {throw 'Required package file missing'}
}
if((Hash $PSCommandPath) -cne $manifest.files.'tools/photo-printer/windows/install.ps1') {throw 'Installer does not match package'}
foreach($name in @('config.json','certificate.pem','private-key.pem','jobs.sqlite')) {$null=Assert-LocalPath (Join-Path $PrivateInput $name);if(-not (Test-Path -LiteralPath (Join-Path $PrivateInput $name) -PathType Leaf)) {throw 'Prepared private input missing'}}
$config=Get-Content (Join-Path $PrivateInput 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($config.transport -cne 'windows-usb' -or $config.port -ne 13440 -or $config.protocolConfirmed -ne $false -or $config.windowsInterfaceMac -notmatch '^(?:[a-fA-F0-9]{2}:){5}[a-fA-F0-9]{2}$') {throw 'Disabled, assigned photo configuration required for first install'}
if((Get-Service $serviceName -ErrorAction SilentlyContinue) -or (Test-Path $program) -or (Test-Path $state) -or (Get-NetFirewallRule -Name $serviceName -ErrorAction SilentlyContinue)) {throw 'Photo installation already exists; inspect it instead of overwriting'}
if(@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object {$_.Port -eq 13440}).Count) {throw 'Photo HTTPS port occupied'}
if(-not $Apply) {Write-Output 'PHOTO_INSTALL_VALIDATED_NO_CHANGES';return}
$lease=[IO.File]::Open('C:\ProgramData\PickChick\EdgeTools\unified-menu-maintenance.lock','OpenOrCreate','ReadWrite','None')
try {
 New-PrivateDirectory $program 'ReadAndExecute'
 New-PrivateDirectory $state
 New-PrivateDirectory (Join-Path $state 'private') 'ReadAndExecute'
 New-PrivateDirectory (Join-Path $state 'data') 'Modify'
 New-PrivateDirectory (Join-Path $state 'logs') 'Modify'
 foreach($entry in $listed) {
  $target=Join-Path $program $entry.Name;$parent=[IO.Path]::GetDirectoryName($target)
  if(-not (Test-Path -LiteralPath $parent)) {$null=New-Item -ItemType Directory -Path $parent -Force}
  [IO.File]::Copy((Join-Path $Package $entry.Name),$target,$false)
  if((Hash $target) -cne $entry.Value) {throw 'Installed package differs'}
 }
 [IO.File]::Copy((Join-Path $program 'WinSW.exe'),(Join-Path $program ($serviceName+'.exe')),$false)
 & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /platform:x64 ('/out:'+$program+'\PickChickPhotoUsb.exe') ($program+'\tools\photo-printer\windows\UsbPrinter.cs')
 if($LASTEXITCODE -ne 0) {throw 'USB helper build failed'}
 foreach($name in @('certificate.pem','private-key.pem')) {[IO.File]::Copy((Join-Path $PrivateInput $name),(Join-Path ($state+'\private') $name),$false)}
 [IO.File]::Copy((Join-Path $PrivateInput 'jobs.sqlite'),($state+'\data\jobs.sqlite'),$false)
 $config | Add-Member -Force NoteProperty windowsUsbHelper ($program+'\PickChickPhotoUsb.exe')
 $config | Add-Member -Force NoteProperty database ($state+'\data\jobs.sqlite')
 $config | Add-Member -Force NoteProperty tlsCert ($state+'\private\certificate.pem')
 $config | Add-Member -Force NoteProperty tlsKey ($state+'\private\private-key.pem')
 Write-Private ($state+'\private\config.json') ($config | ConvertTo-Json -Depth 5)
 $xml=@"
<service>
 <id>$serviceName</id><name>PickChick Photo Printer</name>
 <description>Local authenticated photo printing for the paired kiosk.</description>
 <executable>$program\node.exe</executable>
 <arguments>&quot;$program\tools\photo-printer\server.mjs&quot; &quot;$state\private\config.json&quot;</arguments>
 <workingdirectory>$program</workingdirectory>
 <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
 <startmode>Automatic</startmode><delayedAutoStart>true</delayedAutoStart>
 <stoptimeout>40 sec</stoptimeout>
 <onfailure action="restart" delay="5 sec"/><onfailure action="restart" delay="15 sec"/><onfailure action="restart" delay="30 sec"/>
 <resetfailure>1 hour</resetfailure><logpath>$state\logs</logpath>
 <log mode="roll-by-size"><sizeThreshold>1024</sizeThreshold><keepFiles>3</keepFiles></log>
</service>
"@
 Write-Private ($program+'\'+$serviceName+'.xml') $xml
 & ($program+'\'+$serviceName+'.exe') install
 if($LASTEXITCODE -ne 0) {throw 'Photo service installation failed'}
 $null=New-NetFirewallRule -Name $serviceName -DisplayName 'PickChick photo HTTPS local network' -Direction Inbound -Action Allow -Profile Private,Domain -Protocol TCP -LocalPort 13440 -RemoteAddress LocalSubnet -Program ($program+'\node.exe')
 Start-Service $serviceName
 (Get-Service $serviceName).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
 Write-Private ($state+'\installation.json') ([ordered]@{sourceCommit=$SourceCommit;manifestSha256=$ManifestSha256;installedAt=[DateTime]::UtcNow.ToString('o');printingEnabled=$false;physicalAcceptance=$false} | ConvertTo-Json)
 Write-Output 'PHOTO_SERVICE_INSTALLED_DISABLED: verify TLS, USB identity and a small physical print before enabling.'
} finally {$lease.Dispose()}
