#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$WrapperSource,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$WrapperSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$KnownHostsSha256,
  [Parameter(Mandatory=$true)][string]$PublicKeyBody
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root='C:\ProgramData\PickChick\FulfillmentSync'
$bin='C:\Program Files\PickChick\FulfillmentTunnel'
$logs=Join-Path $root 'logs'
$key=Join-Path $root 'cloud-tunnel_ed25519'
$hosts=Join-Path $root 'known_hosts'
$ssh=Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$config=Join-Path $root 'ssh_config'
$service='PickChickFulfillmentTunnel'
function Assert-Ordinary([string]$Path) {
  $cursor=[IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Reparse path rejected.'}
    }
    $parent=[IO.Directory]::GetParent($cursor)
    $cursor=if ($null -eq $parent) {$null} else {$parent.FullName}
  }
}
function Protect([string]$Path,[bool]$Directory,[string]$Access='ReadAndExecute') {
  $acl=if ($Directory) {New-Object Security.AccessControl.DirectorySecurity} else {New-Object Security.AccessControl.FileSecurity}
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
  $inherit=if ($Directory) {[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'} else {[Security.AccessControl.InheritanceFlags]::None}
  foreach ($pair in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@('S-1-5-19',$Access))) {
    $sid=New-Object Security.Principal.SecurityIdentifier($pair[0])
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]$pair[1],$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function New-Text([string]$Path,[string]$Text) {
  $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$bytes=(New-Object Text.UTF8Encoding($false)).GetBytes($Text);$stream.Write($bytes,0,$bytes.Length)} finally {$stream.Dispose()}
  Protect $Path $false
}
# Never overwrite an existing installation or attach to someone else's listener.
foreach ($path in @($root,$bin,$WrapperSource,$ssh,$key,$hosts)) {Assert-Ordinary $path}
if ((Get-Service $service -ErrorAction SilentlyContinue) -or (Test-Path $bin) -or (Test-Path $config) -or (Test-Path $logs)) {throw 'Existing or partial installation requires inspection; nothing overwritten.'}
if (@(Get-NetTCPConnection -LocalPort 43100 -State Listen -ErrorAction SilentlyContinue).Count) {throw 'Forward port occupied.'}
if ((Get-FileHash $WrapperSource -Algorithm SHA256).Hash.ToLowerInvariant() -cne $WrapperSha256) {throw 'Wrapper hash differs.'}
if ((Get-FileHash $hosts -Algorithm SHA256).Hash.ToLowerInvariant() -cne $KnownHostsSha256) {throw 'Pinned host key differs.'}
if ([IO.File]::ReadAllText($hosts).Trim() -cnotmatch '^185\.129\.51\.103 ssh-ed25519 [A-Za-z0-9+/=]+$') {throw 'Unexpected pinned host.'}
$public=[IO.File]::ReadAllText($key+'.pub').Trim().Split(' ')
if ($public.Length -lt 2 -or $public[0] -cne 'ssh-ed25519' -or $public[1] -cne $PublicKeyBody) {throw 'Device public key differs.'}
# Directory contains only the reviewed device key pair and pinned host key.
if (@(Get-ChildItem -LiteralPath $root -Force | Where-Object {$_.Name -notin @('cloud-tunnel_ed25519','cloud-tunnel_ed25519.pub','known_hosts')}).Count) {throw 'Unexpected files in tunnel directory.'}
Protect $root $true
foreach ($path in @($key,($key+'.pub'),$hosts)) {Protect $path $false}
$acl=Get-Acl $key
$acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-19')))
Set-Acl -LiteralPath $key -AclObject $acl
$null=New-Item -ItemType Directory -Path $bin
Protect $bin $true
$null=New-Item -ItemType Directory -Path $logs
Protect $logs $true 'Modify'
New-Text $config @"
Host pickchick-fulfillment-private
  HostName 185.129.51.103
  User pickchick-edge-link
  Port 22
  IdentityFile C:/ProgramData/PickChick/FulfillmentSync/cloud-tunnel_ed25519
  UserKnownHostsFile C:/ProgramData/PickChick/FulfillmentSync/known_hosts
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking yes
  HostKeyAlgorithms ssh-ed25519
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  ForwardAgent no
  RequestTTY no
  ExitOnForwardFailure yes
  ConnectTimeout 10
  ServerAliveInterval 15
  ServerAliveCountMax 3
  LocalForward 127.0.0.1:43100 127.0.0.1:13100
"@
$image=Join-Path $bin ($service+'.exe')
[IO.File]::Copy($WrapperSource,$image,$false)
Protect $image $false
New-Text (Join-Path $bin ($service+'.xml')) @"
<service>
  <id>$service</id><name>PickChick Fulfillment Tunnel</name>
  <description>Private mobile order transport to the cloud API.</description>
  <executable>$ssh</executable>
  <arguments>-F &quot;$config&quot; -N -T pickchick-fulfillment-private</arguments>
  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
  <startmode>Automatic</startmode><delayedAutoStart/>
  <stoptimeout>15 sec</stoptimeout>
  <onfailure action="restart" delay="5 sec"/><onfailure action="restart" delay="15 sec"/><onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>$logs</logpath><log mode="roll-by-size"><sizeThreshold>1024</sizeThreshold><keepFiles>3</keepFiles></log>
</service>
"@
& $image install
if ($LASTEXITCODE -ne 0) {throw 'Service installation failed; inspect partial installation.'}
Start-Service $service
(Get-Service $service).WaitForStatus('Running',[TimeSpan]::FromSeconds(20))
$deadline=[DateTime]::UtcNow.AddSeconds(20)
do {
  $listeners=@(Get-NetTCPConnection -LocalPort 43100 -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count) {break}
  Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)
if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') {throw 'Private listener missing.'}
$process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listeners[0].OwningProcess)
$installed=Get-CimInstance Win32_Service -Filter "Name='$service'"
if ($process.ExecutablePath -ine $ssh -or $process.ParentProcessId -ne $installed.ProcessId -or $installed.StartName -ine 'NT AUTHORITY\LocalService') {throw 'Unexpected listener or service identity.'}
Write-Output 'READY: automatic private tunnel on 127.0.0.1:43100. Payment and order delivery are not enabled by this step.'
